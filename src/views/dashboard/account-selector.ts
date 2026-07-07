// Account-selector cards (multi-account milestone 05). One card per
// registered account, showing 5h + 7d as `usage%/safepace%` per the locked
// number format (docs/multi-account/00-overview.md), safe-pace tick on the
// bar, active card = border+glow (mockup: .for_bepy/multi-account-mockup.html
// section 1). See account-selector-logic.ts for the pure default/reconcile
// rules this wires up.

import { escapeHtml } from "../../shared/escape-html";
import { accountIconBadgeHtml } from "../../shared/account-chip";
import { fmtResetDisplay, valueColor, computeSafePacePct } from "../../shared/formatters";
import type { ValueColorSettings } from "../../shared/formatters";
import type { Account, UsageRecord } from "../../shared/api";

const SESSION_WINDOW_MS = 5 * 3_600_000;
const WEEKLY_WINDOW_MS = 7 * 24 * 3_600_000;

function metricRowHtml(
  label: string,
  pct: number | null,
  safePct: number | null,
  colour: string,
  settings: ValueColorSettings,
): string {
  if (pct == null) {
    return `<div class="dash-mrow"><span class="dash-k">${label}</span><div class="dash-bar"></div><span class="dash-nums"><b class="dash-cur dash-cur-dim">--</b></span></div>`;
  }
  const color = valueColor(pct, safePct, settings, "dashboard");
  const tick = safePct != null ? `<i class="dash-tick" style="left:${safePct}%"></i>` : "";
  const safeNum = safePct != null ? `<span class="dash-safe">/${safePct}%</span>` : "";
  return `<div class="dash-mrow">
    <span class="dash-k">${label}</span>
    <div class="dash-bar" style="--acc:${escapeHtml(colour)}"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span>${tick}</div>
    <span class="dash-nums" title="usage / safe pace. Safe pace is the even-burn line; green = under it, red = over.">
      <b class="dash-cur" style="color:${escapeHtml(color)}">${pct}%</b>${safeNum}
    </span>
  </div>`;
}

function accountCardHtml(account: Account, usage: UsageRecord | undefined, selected: boolean, settings: ValueColorSettings): string {
  const sessionSafe = usage ? computeSafePacePct(usage.session_resets_at, SESSION_WINDOW_MS) : null;
  const weeklySafe = usage
    ? computeSafePacePct(usage.weekly_resets_at || new Date(Date.now() + 3_600_000).toISOString(), WEEKLY_WINDOW_MS)
    : null;
  const sessionReset = usage ? fmtResetDisplay(usage.session_resets_at) : null;

  return `<div class="dash-acard${selected ? " active" : ""}" data-acc-id="${escapeHtml(account.id)}" style="--acc:${escapeHtml(account.colour)}">
    <div class="dash-ah">${accountIconBadgeHtml(account)}<span class="dash-who">${escapeHtml(account.label)}</span></div>
    ${metricRowHtml("5h", usage ? (usage.session_pct as number | null) : null, sessionSafe, account.colour, settings)}
    ${metricRowHtml("7d", usage ? (usage.weekly_pct as number | null) : null, weeklySafe, account.colour, settings)}
    <div class="dash-reset">${sessionReset && sessionReset.diffMs > 0 ? `resets <b>${escapeHtml(sessionReset.absolute)}</b>` : usage ? "" : "No data yet"}</div>
  </div>`;
}

export function buildAccountCardsHTML(
  accounts: Account[],
  usageByAccount: Record<string, UsageRecord>,
  selectedAccountId: string | null,
  settings: ValueColorSettings,
): string {
  if (!accounts.length) return "";
  return `<div class="dash-sel-row">${accounts
    .map((a) => accountCardHtml(a, usageByAccount[a.id], a.id === selectedAccountId, settings))
    .join("")}</div>`;
}

export function wireAccountCardClicks(root: HTMLElement, onSelect: (accountId: string) => void): void {
  root.querySelectorAll<HTMLElement>(".dash-acard").forEach((card) => {
    card.onclick = () => {
      const id = card.dataset["accId"];
      if (id) onSelect(id);
    };
  });
}
