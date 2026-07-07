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
      // No remote path: poll_now (a CDP scrape needing Chrome), takeover,
      // editor/window/local-FS commands, and file watchers. Degrade clearly.
      default:
        throw new RemoteUnavailableError(command);
    }
  }

  async listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
    // ── Global session-list poll ──────────────────────────────────────────────
    // The desktop fires a Tauri "instances-changed" event whenever the session
    // registry mutates. On the phone there is no global WebSocket, so we
    // substitute a 3.5-second poll: call list_instances, reshape the result to
    // the same void-payload the consumer expects (callbacks ignore the payload
    // and call refreshSessions() themselves), then invoke cb to trigger the same
    // refresh flow. An in-flight guard prevents overlapping requests.
    if (event === "instances-changed") {
      let timerId: ReturnType<typeof setInterval> | undefined;
      let inFlight = false;
      const poll = (): void => {
        if (inFlight) return;
        inFlight = true;
        this.call<unknown>("list_instances")
          .then(() => { cb(undefined as unknown as T); })
          .catch(() => { /* network blip – skip this tick */ })
          .finally(() => { inFlight = false; });
      };
      // Fire once immediately so the session list populates without waiting 3.5s.
      poll();
      timerId = setInterval(poll, 3500);
      return () => { clearInterval(timerId); };
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
