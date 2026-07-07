// Pure helpers for the add-account wizard (multi-account milestone 01).
// Kept free of DOM/IPC so the state-machine bits are cheaply unit-testable
// (see tests/add-account-wizard-logic.test.mjs). The modal itself
// (add-account-wizard.ts) is the only caller.

import type { LoginCheckOutcome, OauthAccountInfo } from "../../../../types/ipc.generated";

// Bare Phosphor icon names (no "ph-" prefix) - the wizard renders
// `ph ph-${icon}`. Kept local to this feature; nothing else in the app picks
// account icons yet.
export const ICON_POOL = [
  "user",
  "briefcase",
  "palette",
  "rocket",
  "buildings",
  "lightning",
  "crown",
  "flask",
  "terminal-window",
  "cube",
] as const;

export const COLOUR_POOL = [
  "#9d7dfc",
  "#f5a623",
  "#3ecf8e",
  "#38bdf8",
  "#f472b6",
  "#fb7185",
];

export const LOGIN_POLL_INTERVAL_MS = 2000;
// Frontend-enforced ceiling on the "run /login in the spawned terminal" step.
// The backend session has no timeout of its own; the wizard cancels it.
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * First pool entry (starting at `startIndex`, wrapping) not present in
 * `usedIcons`. Icon collisions are cosmetic, never blocking, so if every icon
 * in the pool is already taken this falls back to the entry at `startIndex`
 * rather than throwing.
 */
export function pickAvailableIcon(
  pool: readonly string[],
  usedIcons: Iterable<string>,
  startIndex = 0,
): string {
  if (pool.length === 0) return "";
  const used = new Set(usedIcons);
  for (let i = 0; i < pool.length; i++) {
    const idx = (startIndex + i) % pool.length;
    const candidate = pool[idx]!;
    if (!used.has(candidate)) return candidate;
  }
  return pool[((startIndex % pool.length) + pool.length) % pool.length]!;
}

/**
 * Advances the reroll cursor by one, wrapping. Kept separate from
 * `pickAvailableIcon` so repeated reroll clicks walk forward through the pool
 * instead of always restarting from index 0.
 */
export function nextRerollIndex(pool: readonly string[], currentIndex: number): number {
  if (pool.length === 0) return 0;
  return (currentIndex + 1) % pool.length;
}

/**
 * "Fibo Studio" -> "Fibo Studio"; falls back to the email's local part,
 * title-cased on `.`/`_`/`-`, when there's no org name (personal accounts
 * often have none).
 */
export function prefillLabel(
  identity: Pick<OauthAccountInfo, "organizationName" | "emailAddress">,
): string {
  const org = identity.organizationName?.trim();
  if (org) return org;
  const local = identity.emailAddress.split("@")[0] ?? identity.emailAddress;
  const titled = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
  return titled || identity.emailAddress;
}

const KNOWN_TIERS: Record<string, string> = {
  claude_max: "Max",
  claude_pro: "Pro",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
};

/** Raw `organizationType` (e.g. "claude_max") -> a human label. Unknown
 * values are title-cased and passed through rather than hidden. */
export function tierLabel(tier: string | null | undefined): string {
  if (!tier) return "Unknown plan";
  if (KNOWN_TIERS[tier]) return KNOWN_TIERS[tier];
  const cleaned = tier.replace(/^claude_/, "");
  return cleaned
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ") || tier;
}

/** "83000" ms -> "1:23". */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function isLoginTimedOut(elapsedMs: number): boolean {
  return elapsedMs >= LOGIN_TIMEOUT_MS;
}

export type LoginOutcomeView =
  | { kind: "pending" }
  | { kind: "ready"; identity: OauthAccountInfo }
  | { kind: "mismatch"; message: string }
  | { kind: "duplicate"; message: string };

/** Maps the backend's `LoginCheckOutcome` union to a view-ready shape with a
 * plain-English message for the two failure variants, so the modal never has
 * to synthesize error copy inline. */
export function describeLoginOutcome(outcome: LoginCheckOutcome): LoginOutcomeView {
  switch (outcome.status) {
    case "Pending":
      return { kind: "pending" };
    case "Ready":
      return { kind: "ready", identity: outcome.identity };
    case "Mismatch":
      return {
        kind: "mismatch",
        message:
          `This profile was already logged in as ${outcome.existing_email}, but the ` +
          `terminal just logged into ${outcome.new_email}. Log into ` +
          `${outcome.existing_email} in that terminal, or cancel and pick a different ` +
          `account name.`,
      };
    case "Duplicate":
      return {
        kind: "duplicate",
        message: `Already added as "${outcome.existing_label}".`,
      };
  }
}
