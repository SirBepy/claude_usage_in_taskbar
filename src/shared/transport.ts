// Single seam between the frontend and the daemon backend.
//
// Desktop webview -> TauriTransport (Tauri `invoke` + Tauri events).
// Browser PWA (phone) -> HttpTransport (REST + WebSocket to the daemon's
// remote-access server), selected at boot in getTransport() by the absence of
// window.__TAURI__.
//
// All request/response goes through `call`; all event streaming through
// `listen`. Keeping both behind this interface lets the same UI run in the
// Tauri webview and in a remote browser without the call sites knowing which.
//
// The `Window.__TAURI__` shape is declared ambiently in ./ipc, so this module
// can reference it without an import.

export type Unlisten = () => void;

export interface Transport {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a backend event channel. The callback receives the payload
   *  directly (the Tauri `{ payload }` envelope is unwrapped at this boundary). */
  listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten>;
}

class TauriTransport implements Transport {
  async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const core = window.__TAURI__?.core;
    if (!core?.invoke) {
      throw new Error(
        "Tauri runtime not available. Are you running via `cargo tauri dev` or a packaged build?",
      );
    }
    return core.invoke<T>(command, args);
  }

  async listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
    const ev = window.__TAURI__?.event;
    if (!ev?.listen) return () => {};
    return ev.listen<T>(event, (e) => cb(e.payload));
  }
}

// ── Remote (browser PWA) transport ───────────────────────────────────────────

/** localStorage key holding the per-device bearer token the user pasted/paired. */
export const REMOTE_TOKEN_KEY = "rc_token";

function remoteToken(): string {
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
  async call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    switch (command) {
      case "list_instances":
        return this.rpc<T>("list_instances", null);
      case "list_pending_prompts":
        return this.rpc<T>("list_pending_prompts", null);
      case "set_session_effort":
        return this.rpc<T>("set_session_effort", {
          session_id: args.session_id ?? args.sessionId,
          effort: args.effort,
        });
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
      // No remote path yet: new-session orchestration (start_session), takeover,
      // editor/window/local-FS, file watchers, get_settings, usage/token history.
      // Degrade clearly.
      default:
        throw new RemoteUnavailableError(command);
    }
  }

  async listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
    const chat = /^chat:(.+)$/.exec(event);
    const id = chat?.[1];
    if (!id || typeof WebSocket === "undefined" || typeof location === "undefined") {
      // No per-session channel (chat-watch:<id> is redundant on the phone since
      // the WS already carries the turn; global channels have no global WS yet,
      // task #5), or no browser WS/location in this environment (node tests).
      // A real browser always has both; degrade to no-op otherwise.
      return () => {};
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url =
      `${proto}://${location.host}/api/sessions/${encodeURIComponent(id)}` +
      `/stream?token=${encodeURIComponent(remoteToken())}`;
    let closed = false;
    const ws = new WebSocket(url);
    ws.onmessage = (e: MessageEvent) => {
      try {
        cb(JSON.parse(e.data as string) as T);
      } catch {
        /* ignore non-JSON frames */
      }
    };
    return () => {
      if (closed) return;
      closed = true;
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
    if (!res.ok) throw new Error(`send failed: ${res.status}`);
    return sessionId as unknown as T;
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch("/api/rpc", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ method, params }),
    });
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

let active: Transport | null = null;

/**
 * The active transport, resolved once at boot: TauriTransport inside the Tauri
 * webview (window.__TAURI__ present), HttpTransport in a plain browser (the
 * served PWA). The choice is cached for the process lifetime.
 */
export function getTransport(): Transport {
  if (!active) {
    // Branch on the presence of the Tauri runtime global (injected by the
    // webview, never present in a plain browser) - ai_todo 105.
    const hasTauri = typeof window !== "undefined" && !!window.__TAURI__;
    active = hasTauri ? new TauriTransport() : new HttpTransport();
  }
  return active;
}

/** Test-only: clear the cached transport so a test can re-resolve it. */
export function resetTransportForTests(): void {
  active = null;
}
