// Transport for the browser PWA (phone): talks to the daemon's remote-access
// server (REST `/api/rpc` + per-session WebSocket) instead of the Tauri
// runtime. Split out of transport.ts so each transport implementation has its
// own file (ai_todo 93).

import type { Transport, Unlisten } from "./transport";

/** localStorage key holding the per-device bearer token the user pasted/paired. */
export const REMOTE_TOKEN_KEY = "rc_token";

/** sessionStorage flag set when a stored token was rejected (401) so the token
 *  gate can explain "expired / changed" instead of looking like a first pairing. */
export const REMOTE_TOKEN_EXPIRED_KEY = "rc_token_expired";

/** True once we've reacted to a 401 this page-load, so a burst of concurrent
 *  failing requests (e.g. the 3.5s poll plus a view's fetches) triggers exactly
 *  one token-clear + reload rather than a reload storm. */
let authFailureHandled = false;

/**
 * React to a rejected bearer token (HTTP 401 from the daemon): the stored token
 * is stale or was rotated. Clear it, flag the reason, and reload so the boot
 * path renders the token gate with an "expired" message instead of every view
 * silently showing empty data (which is indistinguishable from "no data").
 * One-shot per page-load; a no-op in non-browser (test) environments.
 */
function handleAuthFailure(): void {
  if (authFailureHandled) return;
  authFailureHandled = true;
  if (typeof window === "undefined" || typeof location === "undefined") return;
  try {
    localStorage.removeItem(REMOTE_TOKEN_KEY);
    sessionStorage.setItem(REMOTE_TOKEN_EXPIRED_KEY, "1");
  } catch {
    /* storage unavailable - the reload still drops us at the gate */
  }
  location.reload();
}

export function remoteToken(): string {
  try {
    return localStorage.getItem(REMOTE_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Thrown when a frontend command has no remote (phone) equivalent. Callers that
 *  already tolerate failure (e.g. event-store's loadInitial catch) degrade
 *  gracefully; surfaced ones show a clear "not available on the phone" message. */
export class RemoteUnavailableError extends Error {
  constructor(command: string) {
    super(`"${command}" is not available on the remote (phone) client`);
    this.name = "RemoteUnavailableError";
  }
}

// ── Global live-state stream (singleton) ────────────────────────────────────
//
// One shared WebSocket to `/api/global/stream`, fanning daemon-wide
// notifier events out to every `listen()` caller instead of each call opening
// its own poll. This is the remote (browser) equivalent of the desktop's
// internal `subscribe_global` pipe link (see `daemon_link.rs`): the daemon's
// notifier emits snake_case JSON-RPC-shaped frames (`{jsonrpc, method,
// params}`); this table is the same snake_case -> kebab-case translation
// `daemon_link.rs` does app-side, restricted to the daemon events that have
// an actual remote frontend consumer today (found by grepping `listen(` /
// `.on(` call sites across src/).
type GlobalCallback = (payload: unknown) => void;

const GLOBAL_EVENT_MAP: Record<string, string> = {
  instances_changed: "instances-changed",
  scheduled_items_changed: "scheduled-items-changed",
  scheduled_item_fired: "scheduled-item-fired",
};
const GLOBAL_KEBAB_EVENTS = new Set(Object.values(GLOBAL_EVENT_MAP));

/** How stale (ms since the last inbound frame, heartbeat or otherwise) the
 *  global stream must be before the watchdog treats it as a zombie socket.
 *  Browsers never surface native WS ping/pong to JS, so `onclose` does not
 *  fire when the connection silently dies (e.g. after the phone's screen was
 *  off long enough for the OS to freeze it) - only a missed app-level
 *  heartbeat can detect that. */
const GLOBAL_STALE_MS = 10_000;
const GLOBAL_WATCHDOG_INTERVAL_MS = 5_000;
/** Degrade-path poll cadence, matching the interval the old per-listener poll
 *  used before this singleton existed. */
const GLOBAL_DEGRADE_POLL_MS = 3_500;

let globalWs: WebSocket | null = null;
let globalWsStopped = true;
let globalRetryDelay = 1000;
let globalLastFrameAt = 0;
const globalListeners = new Map<string, Set<GlobalCallback>>();
let globalWatchdogTimer: ReturnType<typeof setInterval> | undefined;
let globalDegradePollTimer: ReturnType<typeof setInterval> | undefined;
let globalDegradePollInFlight = false;
/** The HttpTransport instance that registered the currently-active global
 *  listeners. Only its `call()` can be used for the degrade-path poll (it
 *  updates `nonStreamable` bookkeeping) - one instance lives for the whole
 *  app lifetime in practice (`getTransport()` caches it), so this is set once
 *  on the first `listen()` call and reused. */
let globalStreamOwner: HttpTransport | null = null;

function fireGlobal(kebabEvent: string, payload: unknown): void {
  const cbs = globalListeners.get(kebabEvent);
  if (!cbs) return;
  for (const cb of cbs) cb(payload);
}

function allGlobalListenersEmpty(): boolean {
  for (const set of globalListeners.values()) {
    if (set.size > 0) return false;
  }
  return true;
}

/** Stops the degrade-path poll; called as soon as a fresh WS frame arrives
 *  (WS is the fast path, poll is only the fallback while it's down/stale). */
function stopGlobalDegradePoll(): void {
  if (globalDegradePollTimer) {
    clearInterval(globalDegradePollTimer);
    globalDegradePollTimer = undefined;
  }
}

/** Degrade path while the global WS is down or stale: re-poll `list_instances`
 *  at the pre-WS cadence and fan it out to the "instances-changed" listeners
 *  only - that is the one event with a documented safe poll substitute
 *  (the others have no equivalent single-RPC resync and simply go stale
 *  until the WS reconnects). */
function startGlobalDegradePoll(): void {
  if (globalDegradePollTimer) return;
  globalDegradePollTimer = setInterval(() => {
    if (globalDegradePollInFlight || !globalStreamOwner) return;
    const cbs = globalListeners.get("instances-changed");
    if (!cbs || cbs.size === 0) return;
    globalDegradePollInFlight = true;
    globalStreamOwner
      .call<unknown>("list_instances")
      .then(() => { fireGlobal("instances-changed", undefined); })
      .catch(() => { /* network blip - skip this tick */ })
      .finally(() => { globalDegradePollInFlight = false; });
  }, GLOBAL_DEGRADE_POLL_MS);
}

function ensureGlobalWatchdog(): void {
  if (globalWatchdogTimer) return;
  globalWatchdogTimer = setInterval(() => {
    if (globalWsStopped) return;
    if (Date.now() - globalLastFrameAt > GLOBAL_STALE_MS) {
      // Stale: assume the socket is a zombie (half-open, no clean close).
      // Start degrading immediately and force-close so the existing
      // reconnect/backoff in onclose kicks in.
      startGlobalDegradePoll();
      if (globalWs) {
        try { globalWs.close(); } catch { /* ignore */ }
      }
    }
  }, GLOBAL_WATCHDOG_INTERVAL_MS);
}

function connectGlobalStream(): void {
  if (globalWsStopped) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url =
    `${proto}://${location.host}/api/global/stream?token=${encodeURIComponent(remoteToken())}`;
  const ws = new WebSocket(url);
  globalWs = ws;
  ws.onmessage = (e: MessageEvent) => {
    globalLastFrameAt = Date.now();
    stopGlobalDegradePoll();
    let frame: { method?: string; params?: unknown };
    try {
      frame = JSON.parse(e.data as string);
    } catch {
      return; // ignore non-JSON frames
    }
    if (!frame.method || frame.method === "heartbeat") return; // heartbeat: freshness signal only
    const kebab = GLOBAL_EVENT_MAP[frame.method];
    if (kebab) fireGlobal(kebab, frame.params);
  };
  ws.onopen = () => {
    globalRetryDelay = 1000;
    globalLastFrameAt = Date.now();
    stopGlobalDegradePoll();
  };
  ws.onclose = () => {
    if (globalWs === ws) globalWs = null;
    if (globalWsStopped) return;
    // No live channel until the reconnect completes - degrade immediately
    // rather than waiting for the watchdog's next tick.
    startGlobalDegradePoll();
    setTimeout(connectGlobalStream, globalRetryDelay);
    globalRetryDelay = Math.min(globalRetryDelay * 2, 30_000);
  };
}

/** Opens the singleton global WS (no-op if already open/connecting) and
 *  starts its watchdog. Safe to call on every `listen()` for a global event. */
function ensureGlobalStream(): void {
  if (typeof WebSocket === "undefined" || typeof location === "undefined") return; // node tests
  if (!globalWsStopped && globalWs) return; // already connecting/open
  globalWsStopped = false;
  globalLastFrameAt = Date.now();
  connectGlobalStream();
  ensureGlobalWatchdog();
}

/** Tears the singleton down when the last global listener unsubscribes,
 *  matching the per-session WS's cleanup semantics (its `unlisten` also
 *  closes the socket). */
function teardownGlobalStream(): void {
  globalWsStopped = true;
  if (globalWatchdogTimer) { clearInterval(globalWatchdogTimer); globalWatchdogTimer = undefined; }
  stopGlobalDegradePoll();
  if (globalWs) {
    try { globalWs.close(); } catch { /* ignore */ }
    globalWs = null;
  }
}

/**
 * Transport for the browser PWA: talks to the daemon's remote-access server
 * (REST `/api/rpc` + per-session WebSocket) instead of the Tauri runtime.
 * Same-origin with the served SPA, so requests use relative paths; the bearer
 * token is read from localStorage on each call (browsers can't set the
 * Authorization header on a WS handshake, so the WS carries it as `?token=`).
 *
 * Frontend command names are NOT 1:1 with daemon RPC methods, and some Tauri
 * commands orchestrate multiple daemon calls + app-process logic (ai_todo 105
 * CRUX). So `call` routes through an explicit mapping table: most commands
 * forward to the allowlisted `/api/rpc` with reshaped params, `send_message`
 * uses its dedicated REST endpoint, and app-process-only commands degrade with
 * RemoteUnavailableError. (start_session / history are pending backend work -
 * tasks #2/#4; until then opening an EXISTING session + sending is the path.)
 */
export class HttpTransport implements Transport {
  // Session ids the daemon will NOT live-stream: external + automated sessions
  // aren't in the daemon's hosted-session registry, so `GET /stream` 404s for
  // them. Opening a WS there just 404-loops forever via the onclose backoff
  // (their content loads via load_history_page instead). Populated from every
  // list_instances result; "known non-streamable" semantics so a live session
  // we haven't polled yet still opens its WS (no live-stream regression).
  private nonStreamable = new Set<string>();

  private noteStreamability(instances: unknown): void {
    if (!Array.isArray(instances)) return;
    for (const inst of instances) {
      const rec = inst as { session_id?: unknown; kind?: unknown };
      if (typeof rec.session_id !== "string") continue;
      if (rec.kind === "external" || rec.kind === "automated") {
        this.nonStreamable.add(rec.session_id);
      } else {
        // interactive (or took-over external -> interactive): it can stream now.
        this.nonStreamable.delete(rec.session_id);
      }
    }
  }

  async call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    switch (command) {
      case "list_instances": {
        const instances = await this.rpc<unknown>("list_instances", null);
        this.noteStreamability(instances);
        return instances as T;
      }
      case "list_pending_prompts":
        return this.rpc<T>("list_pending_prompts", null);
      case "list_characters":
        return this.rpc<T>("list_characters", null);
      case "list_accounts":
        return this.rpc<T>("list_accounts", null);
      case "list_project_groups":
        return this.rpc<T>("list_project_groups", null);
      case "start_session": {
        // Daemon expects snake_case; tolerate camelCase from callers (matches
        // the set_session_effort normalization pattern above). Params forwarded
        // mirror the desktop call site in pending-pane.ts.
        //
        // Two differences from the desktop Tauri IPC path:
        // 1. The daemon RPC returns {session_id: "uuid"}, not the bare string
        //    the desktop IPC handler returns. Extract it so callers get a string.
        // 2. The daemon RPC StartSessionParams has no `prompt` field (dropped at
        //    deserialization). Send the first turn via a follow-up send_message
        //    call, mirroring what run.rs::start_session_daemon does on desktop.
        const spawnResult = await this.rpc<{ session_id: string }>("start_session", {
          cwd: args.cwd,
          model: args.model,
          effort: args.effort,
          remote: args.remote,
          placeholder_id: args.placeholderId ?? args.placeholder_id,
          account_id: args.accountId ?? args.account_id ?? null,
        });
        const sid = spawnResult.session_id;
        const promptText = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (promptText) {
          await this.rpc<unknown>("send_message", { session_id: sid, text: promptText });
        }
        return sid as unknown as T;
      }
      case "set_session_effort":
        return this.rpc<T>("set_session_effort", {
          session_id: args.session_id ?? args.sessionId,
          effort: args.effort,
        });
      case "set_auto_accept":
        return this.rpc<T>("set_auto_accept", {
          session_id: args.session_id ?? args.sessionId,
          value: args.value,
        });
      case "list_auto_accept":
        return this.rpc<T>("list_auto_accept", null);
      case "cancel_turn":
        return this.rpc<T>("cancel_turn", {
          session_id: args.sessionId ?? args.session_id,
        });
      case "respond_permission":
        return this.rpc<T>("respond_permission", {
          request_id: args.id,
          allow: args.behavior === "allow",
          updated_input: args.updatedInput,
          message: args.message,
        });
      case "respond_question":
        return this.rpc<T>("respond_question", {
          request_id: args.id,
          answers: args.answers,
        });
      case "send_message":
        return this.sendMessage<T>(args);
      case "load_history_page":
        return this.rpc<T>("load_history_page", {
          session_id: args.sessionId ?? args.session_id,
          cwd: args.cwd ?? null,
          before_seq: args.beforeSeq ?? args.before_seq ?? null,
          message_limit: args.messageLimit ?? args.message_limit ?? 20,
        });
      case "character_asset_url":
        return this.rpc<T>("character_asset_url", {
          character_id: args.characterId ?? args.character_id,
          file: args.file,
        });
      case "read_attachment":
        // Pasted chat-image attachments. The daemon path-validates against the
        // chat-attachments dir, so a malicious path can't read arbitrary files.
        return this.rpc<T>("read_attachment", { path: args.path });
      case "paste_attachment":
        // Composer paperclip upload from the phone: the daemon writes the bytes
        // into <app-data>/chat-attachments/<session>/ and returns the PC-side
        // path, which the composer turns into a <file:...> mention on send.
        return this.rpc<T>("paste_attachment", {
          session_id: args.sessionId ?? args.session_id,
          base64_data: args.base64Data ?? args.base64_data,
          mime: args.mime,
        });
      case "resolve_whitelist_characters":
        return this.rpc<T>("resolve_whitelist_characters", {
          project_id: args.projectId ?? args.project_id,
        });
      case "list_session_characters":
        // Per-session character map { session_id: character_id }; drives the
        // sidebar + chat-header avatars. Without it every row shows the "?"
        // placeholder on the phone.
        return this.rpc<T>("list_session_characters", null);
      case "ensure_session_character":
        // Assigns a character to a freshly-started session. Without this the
        // Tauri-only command had no remote mirror, so a remote-created chat
        // never got a sidebar avatar (silently swallowed by the caller's
        // `.catch(() => null)`).
        return this.rpc<T>("ensure_session_character", {
          session_id: args.sessionId ?? args.session_id,
        });
      case "list_projects":
        return this.rpc<T>("list_projects", {});
      case "project_last_activity_at":
        return this.rpc<T>("project_last_activity_at", {
          cwd: args.cwd,
        });
      case "get_project_tech":
        return this.rpc<T>("get_project_tech", {
          root: args.root,
        });
      case "get_project_icon":
        return this.rpc<T>("get_project_icon", {
          root: args.root,
        });
      // Usage + token history: served from the daemon's shared companion.db so
      // the phone homescreen + statistics populate (the daemon is the writer).
      case "get_history":
        return this.rpc<T>("get_history", { limit: args.limit ?? null });
      case "get_token_history":
        return this.rpc<T>("get_token_history", null);
      case "get_active_sessions":
        return this.rpc<T>("get_active_sessions", null);
      case "get_settings":
        return this.rpc<T>("get_settings", null);
      case "list_slash_commands":
        // Read-only filesystem scan for the `/` autocomplete popup; the daemon
        // runs on the same PC and can read the same disk as desktop.
        return this.rpc<T>("list_slash_commands", {
          project_dir: args.projectDir ?? args.project_dir,
        });
      // No remote path: poll_now (a CDP scrape needing Chrome), takeover,
      // editor/window/local-FS commands, and file watchers. Degrade clearly.
      default:
        throw new RemoteUnavailableError(command);
    }
  }

  async listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
    // ── Global live-state stream ──────────────────────────────────────────────
    // The desktop fires a Tauri event whenever the session registry (or the
    // schedule, etc.) mutates. On the phone there is no Tauri event bus, so
    // these fan out through the singleton `/api/global/stream` WebSocket
    // above instead, with a poll degrade path while it's down/stale.
    if (GLOBAL_KEBAB_EVENTS.has(event)) {
      const cbs = globalListeners.get(event) ?? new Set<GlobalCallback>();
      cbs.add(cb as GlobalCallback);
      globalListeners.set(event, cbs);
      globalStreamOwner = this;
      ensureGlobalStream();
      if (event === "instances-changed") {
        // Fire once immediately so the session list populates without
        // waiting for the first WS frame / poll tick (pre-WS behavior).
        this.call<unknown>("list_instances")
          .then(() => { cb(undefined as unknown as T); })
          .catch(() => { /* network blip - the WS snapshot frame will catch up */ });
      }
      return () => {
        globalListeners.get(event)?.delete(cb as GlobalCallback);
        if (allGlobalListenersEmpty()) teardownGlobalStream();
      };
    }

    const chat = /^chat:(.+)$/.exec(event);
    const id = chat?.[1];
    if (!id || typeof WebSocket === "undefined" || typeof location === "undefined") {
      // No per-session channel (chat-watch:<id> is redundant on the phone since
      // the WS already carries the turn; global channels have no global WS yet,
      // task #5), or no browser WS/location in this environment (node tests).
      // A real browser always has both; degrade to no-op otherwise.
      return () => {};
    }
    if (this.nonStreamable.has(id)) {
      // A read-only / external session has no daemon broadcast; the WS would
      // 404 and the onclose backoff would retry it forever (console-noisy,
      // battery/network drain). Its transcript already loaded via
      // load_history_page, so there is nothing live to attach to.
      return () => {};
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url =
      `${proto}://${location.host}/api/sessions/${encodeURIComponent(id)}` +
      `/stream?token=${encodeURIComponent(remoteToken())}`;
    let stopped = false;
    let ws: WebSocket;
    let retryDelay = 1000;

    const connect = (): void => {
      if (stopped) return;
      ws = new WebSocket(url);
      ws.onmessage = (e: MessageEvent) => {
        try {
          cb(JSON.parse(e.data as string) as T);
        } catch {
          /* ignore non-JSON frames */
        }
      };
      ws.onopen = () => { retryDelay = 1000; };
      ws.onclose = () => {
        // Mobile connections drop frequently (network handoff, screen sleep).
        // Reconnect with capped exponential backoff unless unlisten() was called.
        if (stopped) return;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
    };
    connect();

    return () => {
      if (stopped) return;
      stopped = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private async sendMessage<T>(args: Record<string, unknown>): Promise<T> {
    const sessionId = String(args.sessionId ?? args.session_id ?? "");
    const blocks =
      (args.blocks as { type: string; text?: string }[] | undefined) ?? [];
    // The daemon send endpoint takes plain text; image blocks have no remote
    // path yet (degrade to text-only, matching the desktop's disk-path flow).
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ text }),
    });
    if (res.status === 401) handleAuthFailure();
    if (!res.ok) throw new Error(`send failed: ${res.status}`);
    return sessionId as unknown as T;
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch("/api/rpc", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ method, params }),
    });
    if (res.status === 401) handleAuthFailure();
    if (!res.ok) throw new Error(`rpc ${method} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${remoteToken()}`,
      "Content-Type": "application/json",
    };
  }
}
