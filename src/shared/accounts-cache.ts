// Module-level accounts cache, shared by rate-limit-banner.ts (which owns the
// refresh) and any other view that needs an account's label/colour without
// threading a fresh async fetch through every render (e.g. the statusline
// account chip). Deliberately has NO runtime imports beyond the type - pulling
// in api.ts/navigation.ts here would drag session-statusbar.ts's tests into
// needing a DOM environment they don't otherwise require (see
// tests/model-context-window.test.mjs, a node-env test that only imports
// session-statusbar.ts).

import type { Account } from "../types/ipc.generated";

let accountsCache: Account[] = [];

export function setCachedAccounts(accounts: Account[]): void {
  accountsCache = accounts;
}

export function listCachedAccounts(): Account[] {
  return accountsCache;
}

/** Synchronous lookup into the shared accounts cache. Null before the first
 * successful refresh or for an unknown id. */
export function getCachedAccount(accountId: string | null): Account | null {
  if (!accountId) return null;
  return accountsCache.find((a) => a.id === accountId) ?? null;
}

/** Title-cases the first letter of an account label ("fibo" -> "Fibo"). */
export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
