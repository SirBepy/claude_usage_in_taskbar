//! The boot-time render gate: hold the first dashboard render until the three
//! initial fetches (usage history, token history, settings) have all SETTLED.
//!
//! Lives in its own module (only type-only imports) so it is unit-testable
//! without dragging in boot.ts's heavy DOM/Tauri-coupled transitive imports.

import type { SettingsShape } from "./state";
import type { TokenRecord } from "./tokens";

/** The three boot fetches whose completion gates the first dashboard render. */
export interface InitialFetchDeps {
  fetchUsage: () => Promise<unknown>;
  fetchTokens: () => Promise<TokenRecord[]>;
  fetchSettings: () => Promise<SettingsShape | null>;
  onUsage: (h: unknown) => void;
  onTokens: (t: TokenRecord[]) => void;
  onSettings: (s: SettingsShape | null) => void;
  onReady: () => void;
}

/**
 * Fire `onReady` once ALL THREE boot fetches have SETTLED - success or failure.
 * Each slot is marked in `.finally`, so a rejected fetch (e.g. a cold-boot RPC
 * failure when the daemon is not up yet) can never wedge the gate shut. That
 * wedge was the white-screen-on-startup bug: a single un-caught fetch (token
 * history) left the gate closed forever, and only tray > Open Dashboard - which
 * navigates directly, bypassing the gate - could recover it. Marking slots in
 * `.finally` instead of in each `.then` makes the whole class structurally
 * impossible. A fetch's `onX` data callback runs only on success.
 */
export function wireInitialFetches(deps: InitialFetchDeps): void {
  let usage = false;
  let tokens = false;
  let settings = false;
  const check = (): void => {
    if (usage && tokens && settings) deps.onReady();
  };
  void deps.fetchUsage()
    .then((h) => deps.onUsage(h))
    .catch(() => {})
    .finally(() => { usage = true; check(); });
  void deps.fetchTokens()
    .then((t) => deps.onTokens(t))
    .catch(() => {})
    .finally(() => { tokens = true; check(); });
  void deps.fetchSettings()
    .then((s) => deps.onSettings(s))
    .catch(() => {})
    .finally(() => { settings = true; check(); });
}
