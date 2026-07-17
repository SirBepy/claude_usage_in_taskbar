// Browser view-harness (iterate-it P6, 2026-07-12).
//
// Runs ONE view of the SPA in a plain Playwright/Chromium browser against a
// mocked backend - NO Tauri process, NO daemon, NO cargo build. This never
// touches Joe's live app/daemon, so testing a view can't bounce a chat he's
// actively using (the whole reason this exists).
//
// Mechanism: the frontend funnels every backend request through
// `getTransport()` (src/shared/transport.ts), which picks TauriTransport iff
// `window.__TAURI__` is present. We install a FAKE `window.__TAURI__` via
// `page.addInitScript` (runs pre-navigation, before main.ts's first invoke),
// so:
//   - TauriTransport consumes our fake `core.invoke` / `event.listen` as-is
//     (zero production-code changes), and
//   - `isTauri()` -> true / `isRemote()` -> false, so boot mounts the real
//     DESKTOP view instead of the phone pairing-token gate.
//
// `mockInvoke` is keyed by command name and returns a Promise (call sites chain
// `.catch()` directly on it). An UNMOCKED command REJECTS loudly - a gap shows
// up as a red test, never a false-green pass. That throw is what surfaces a
// missing boot-seed command, so keep it.
//
// Events: `mockListen` registers callbacks so app code can subscribe without
// crashing; nothing currently drives them (no spec pushes a backend event
// mid-run yet).

import type { Page } from "@playwright/test";

export type Entry = "index" | "overlay";

/** Command -> canned response. Values are JSON-serialized into the browser, so
 *  they must be plain data (no functions). Merge a view's own commands on top
 *  of the boot seed via {@link mountView}'s `invoke` option. */
export type InvokeMap = Record<string, unknown>;

const HARNESS_ORIGIN = "http://localhost:4420";

// Minimum command seeds for each entry's boot sequence to COMPLETE without an
// unmocked-command rejection. Verified against src/shared/boot.ts (index) and
// src/overlay-main.ts (overlay) on 2026-07-12. Re-verify when boot changes -
// this list drifts by design; the loud reject is the tripwire.
const BOOT_SEED: Record<Entry, InvokeMap> = {
  index: {
    frontend_ready: null,
    // getUsageHistory() -> get_history; [] keeps runDeadPathCheck an early-return.
    get_history: [],
    get_token_history: [],
    get_active_sessions: [],
    // A settings object (not null) so applyThemeFromSettings runs; coerceSettings
    // fills the rest.
    get_settings: { theme: "void" },
    fetch_available_models: [],
    // registered:true => the hook-consent modal never pops.
    get_hook_registration_state: { registered: true, declined: false, port: 0 },
    // null => the legacy-obsidian import banner is skipped.
    import_legacy_obsidian_config: null,
  },
  overlay: {
    frontend_ready: null,
    get_settings: { theme: "void" },
  },
};

/**
 * Installed into the page BEFORE any app script runs. Standalone (no outer
 * scope) so Playwright can serialize it. `seed` carries the merged InvokeMap.
 */
function installMockTauri(seed: { invokeMap: InvokeMap }): void {
  const invokeMap = seed.invokeMap;
  const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();

  const w = window as unknown as Record<string, unknown>;
  w.__ccInvokeCalls = [];

  (window as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        (w.__ccInvokeCalls as unknown[]).push({ cmd, args });
        if (Object.prototype.hasOwnProperty.call(invokeMap, cmd)) {
          return Promise.resolve(invokeMap[cmd]);
        }
        return Promise.reject(
          new Error(`[view-harness] unmocked command: ${cmd}`),
        );
      },
    },
    event: {
      listen: (event: string, cb: (e: { payload: unknown }) => void) => {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(cb);
        return Promise.resolve(() => set!.delete(cb));
      },
    },
  };

  // Belt-and-suspenders: if a future refactor moves the boot gate off
  // `window.__TAURI__` onto a token check, this keeps the pairing gate away.
  try {
    localStorage.setItem("rc_token", "test-token");
  } catch {
    /* storage disabled - fake __TAURI__ alone still passes the current gate */
  }
}

export interface MountOptions {
  /** Route hash to open (e.g. "dashboard", "schedule"). Omit for the default. */
  view?: string;
  /** Which HTML entry to load. Default "index" (main.ts + full router). */
  entry?: Entry;
  /** View-specific command responses, merged over the boot seed. */
  invoke?: InvokeMap;
}

/**
 * Install the mock backend and navigate to the view. After this resolves the
 * SPA has booted against the mock; assert on the rendered DOM as usual.
 */
export async function mountView(page: Page, opts: MountOptions = {}): Promise<void> {
  const entry: Entry = opts.entry ?? "index";
  const invokeMap: InvokeMap = { ...BOOT_SEED[entry], ...(opts.invoke ?? {}) };

  await page.addInitScript(installMockTauri, { invokeMap });

  const hash = opts.view ? `#${opts.view}` : "";
  await page.goto(`${HARNESS_ORIGIN}/${entry}.html${hash}`);
}

/** Read the commands the page has invoked so far (for call-shape asserts). */
export async function invokeCalls(page: Page): Promise<Array<{ cmd: string; args?: unknown }>> {
  return page.evaluate(
    () => (window as unknown as { __ccInvokeCalls: Array<{ cmd: string; args?: unknown }> }).__ccInvokeCalls,
  );
}
