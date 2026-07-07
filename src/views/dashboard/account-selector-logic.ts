// Pure helpers for the dashboard account-selector cards (multi-account
// milestone 05). DOM/api-free (only type-only imports, erased at build time)
// so the default-account resolution is unit-testable - see
// tests/account-selector-logic.test.mjs. Mirrors the sessions/
// account-picker-logic.ts pattern, but the dashboard always needs an active
// card (unlike the new-chat picker, which may legitimately show nothing
// pre-resolved), so it falls back to the first registered account instead of
// returning null when no default is set.

export interface AccountLite {
  id: string;
  label: string;
  icon: string;
  colour: string;
}

/** Which account card is selected by default when the dashboard mounts: the
 * global default account if still registered, else the first account in
 * registry order. `null` only when the registry itself is empty. */
export function resolveDefaultDashboardAccountId(
  defaultAccountId: string | null | undefined,
  accounts: readonly AccountLite[],
): string | null {
  if (accounts.length === 0) return null;
  if (defaultAccountId && accounts.some((a) => a.id === defaultAccountId)) return defaultAccountId;
  return accounts[0]!.id;
}

/** Keeps the current selection if it still points at a real account;
 * otherwise re-resolves a default. Called whenever the account list changes
 * (account added/removed) so a stale selection doesn't point at nothing. */
export function reconcileSelectedAccountId(
  currentSelection: string | null,
  defaultAccountId: string | null | undefined,
  accounts: readonly AccountLite[],
): string | null {
  if (currentSelection && accounts.some((a) => a.id === currentSelection)) return currentSelection;
  return resolveDefaultDashboardAccountId(defaultAccountId, accounts);
}
