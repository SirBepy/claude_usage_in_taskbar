// Compact usage%/safe% chip in the Chats header (brainstorm: Joe only really
// uses the Chats view day-to-day, so the dashboard's ring numbers get a
// glanceable echo here instead of requiring a trip to Dashboard). Polls
// get_usage_map directly rather than the Tauri-only "usage-updated" push
// event, since this view is the one that actually runs on the phone PWA.

import { api } from "../../shared/api";
import { getSettings } from "../../shared/state";
import { computeSafePacePct, valueColor } from "../../shared/formatters";
import { resolveDefaultDashboardAccountId } from "../dashboard/account-selector-logic";
import { escapeHtml } from "../../shared/escape-html";

const SESSION_WINDOW_MS = 5 * 3_600_000;
const POLL_MS = 60_000;

async function renderUsageChip(host: HTMLElement): Promise<void> {
  let accounts: Awaited<ReturnType<typeof api.listAccounts>>;
  let usageMap: Awaited<ReturnType<typeof api.getUsageMap>>;
  try {
    [accounts, usageMap] = await Promise.all([api.listAccounts(), api.getUsageMap()]);
  } catch {
    host.hidden = true;
    return;
  }

  const accountId = resolveDefaultDashboardAccountId(
    getSettings()["default_account_id"] as string | null | undefined,
    accounts,
  );
  const usage = accountId ? usageMap[accountId] : undefined;
  if (!usage || usage.session_pct == null) {
    host.hidden = true;
    return;
  }

  const pct = usage.session_pct;
  const safe = computeSafePacePct(usage.session_resets_at, SESSION_WINDOW_MS);
  const color = valueColor(pct, safe, getSettings(), "dashboard");
  const safeHtml = safe != null ? `<span class="uc-safe">/${safe}%</span>` : "";

  host.innerHTML = `<i class="ph ph-gauge"></i><span class="uc-cur" style="color:${escapeHtml(color)}">${pct}%</span>${safeHtml}`;
  host.title = `5h usage: ${pct}% used${safe != null ? `, ${safe}% is the even safe-pace line` : ""}.`;
  host.hidden = false;
}

/** Mounts the chip into an already-present header host element; returns a
 * teardown that stops the poll. Safe to call with a host that stays hidden
 * (no accounts yet) - it just re-checks on the next poll tick. */
export function mountUsageChip(host: HTMLElement): () => void {
  void renderUsageChip(host);

  const timer = window.setInterval(() => void renderUsageChip(host), POLL_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") void renderUsageChip(host);
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
