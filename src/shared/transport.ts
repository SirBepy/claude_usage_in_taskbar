// Single seam between the frontend and the daemon backend.
//
// Desktop webview -> TauriTransport (Tauri `invoke` + Tauri events).
// Future browser PWA -> HttpTransport (REST + WebSocket to the daemon),
// selected at boot in getTransport().
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

let active: Transport | null = null;

/**
 * The active transport, resolved once at boot. Only TauriTransport exists
 * today; HttpTransport (browser PWA, REST + WS to the daemon over Tailscale) is
 * a parked phase and will branch here on `window.__TAURI__` presence.
 */
export function getTransport(): Transport {
  if (!active) active = new TauriTransport();
  return active;
}
