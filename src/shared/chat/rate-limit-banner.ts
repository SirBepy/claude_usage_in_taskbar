// Global rate-limit banners.
//
// The daemon is the sole source of truth for "is this chat blocked": when
// `claude -p` rejects a turn for a usage limit, it marks every live session
// on that account with `rate_limited_resets_at` / `rate_limited_type`,
// schedules the resume itself, and publishes `instances_changed`. The
// frontend NEVER fires a "continue" turn on its own any more - it only
// reflects the account-blocked state until the resets_at timestamp passes,
// at which point the predicate below expires it with no clear-event needed.
//
// This module renders ONE banner PER EXHAUSTED ACCOUNT at the top of the
// Chats window (mounted independently in both the main window and the
// detached session-chats window - safe to call on every `instances-changed`).

import { escapeHtml } from "../escape-html";
import { api } from "../api";
import { showToast } from "../toast";
import { showView } from "../navigation";
import type { Instance } from "../../types/ipc.generated";
import { setCachedAccounts, listCachedAccounts, getCachedAccount, capitalize } from "../accounts-cache";
export { getCachedAccount, capitalize } from "../accounts-cache";

/** Live predicate for "is this session's account currently blocked by a
 * usage-limit rejection". Purely time-derived (no clear-event): a session
 * born already-exhausted carries the same fields, and the state expires on
 * its own once `now` passes `resets_at`. Shared by every consumer that used
 * to read the old `rateLimitBanner.interruptedSet`. */
export function isBlocked(i: Instance): boolean {
  return i.rate_limited_resets_at != null && Number(i.rate_limited_resets_at) * 1000 > Date.now();
}

/** Local 12h clock, lowercase am/pm, no leading zero ("1:50pm"). */
export function formatClockLabel(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  const time = `${h}:${String(m).padStart(2, "0")}${ampm}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** "in 2h 14m" / "in 14m" / "in under a minute". */
function formatCountdown(remainingMs: number): string {
  const totalMin = Math.floor(Math.max(0, remainingMs) / 60_000);
  if (totalMin <= 0) return "in under a minute";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

/** "five_hour" -> "5-hour", "seven_day"/"weekly" -> "weekly". */
function humanWindow(t: string | null): string {
  switch (t) {
    case "five_hour": return "5-hour";
    case "seven_day":
    case "weekly": return "weekly";
    default: return "usage";
  }
}

// Refreshed on mount(); accounts change rarely enough that a stale label for
// a few seconds is a non-issue. The cache itself lives in accounts-cache.ts
// (shared with session-statusbar.ts's account chip).
async function refreshAccountsCache(): Promise<void> {
  try { setCachedAccounts(await api.listAccounts()); }
  catch { /* keep whatever we had */ }
}

export interface RateLimitBannerDeps {
  now?: () => number;
}

export class RateLimitBanner {
  private host: HTMLElement | null = null;
  private instances: Instance[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private getSelectedSessionId: () => string | null = () => null;
  private onMoved: (newSessionId: string) => void = () => {};

  constructor(deps?: RateLimitBannerDeps) {
    this.now = deps?.now ?? (() => Date.now());
  }

  /** Attach to the host element, load accounts, and paint the current state. */
  mount(host: HTMLElement): void {
    this.host = host;
    void refreshAccountsCache().then(() => this.render());
    this.render();
  }

  /** Wired by the chat pane so "Continue on <Other>" knows which live session
   * to fork (falls back to the account's most-recently-started blocked
   * session when nothing is selected). */
  setSelectedSessionGetter(fn: () => string | null): void {
    this.getSelectedSessionId = fn;
  }

  /** Wired by the chat pane to select the freshly-forked session once a move
   * completes. */
  setOnMoved(fn: (newSessionId: string) => void): void {
    this.onMoved = fn;
  }

  /** Feed the current live instance list and repaint. Safe to call on every
   * `instances-changed` - a no-op render when nothing is blocked. */
  update(instances: Instance[]): void {
    this.instances = instances;
    this.render();
  }

  private blockedGroups(): Map<string, Instance[]> {
    const byAccount = new Map<string, Instance[]>();
    for (const i of this.instances) {
      if (!i.account_id) continue;
      if (!byAccount.has(i.account_id)) byAccount.set(i.account_id, []);
      byAccount.get(i.account_id)!.push(i);
    }
    const blocked = new Map<string, Instance[]>();
    for (const [accountId, list] of byAccount) {
      if (list.some(isBlocked)) blocked.set(accountId, list);
    }
    return blocked;
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.render(), 30_000);
  }

  private render(): void {
    if (!this.host) return;
    const groups = this.blockedGroups();
    if (groups.size === 0) {
      this.host.innerHTML = "";
      this.host.hidden = true;
      this.stopTimer();
      return;
    }
    this.host.hidden = false;
    const nowMs = this.now();

    const cards: string[] = [];
    for (const [accountId, list] of groups) {
      const blockedInGroup = list.filter(isBlocked);
      // All rejections for one account share a resets_at in practice; take
      // the latest so a fresh rejection during an existing window wins.
      const rep = blockedInGroup.reduce((a, b) =>
        Number(b.rate_limited_resets_at) > Number(a.rate_limited_resets_at) ? b : a
      );
      const resetsAtMs = Number(rep.rate_limited_resets_at) * 1000;
      const acc = getCachedAccount(accountId);
      const label = capitalize(acc?.label ?? "Account");
      const icon = acc?.icon || "user";
      const colour = acc?.colour || "#9d7dfc";
      const windowLabel = humanWindow(rep.rate_limited_type);

      const title = `${label} hit its ${windowLabel} limit`;
      const affected = blockedInGroup.length > 1 ? ` · ${blockedInGroup.length} chats affected` : "";
      const timeLine = `Resets ${formatClockLabel(resetsAtMs, nowMs)}${affected}`;
      const countdown = formatCountdown(resetsAtMs - nowMs);

      // "Continue on <other>" only when a DIFFERENT account exists.
      const other = listCachedAccounts().find((a) => a.id !== accountId);
      let moveBtn = "";
      if (other) {
        const otherLabel = capitalize(other.label);
        const otherBlocked = this.instances.filter((i) => i.account_id === other.id && isBlocked(i));
        if (otherBlocked.length > 0) {
          const otherRep = otherBlocked.reduce((a, b) =>
            Number(b.rate_limited_resets_at) > Number(a.rate_limited_resets_at) ? b : a
          );
          const otherResetsAtMs = Number(otherRep.rate_limited_resets_at) * 1000;
          moveBtn = `<button class="rlb-move" data-account="${escapeHtml(other.id)}" disabled title="${escapeHtml(otherLabel)} is also at its limit until ${escapeHtml(formatClockLabel(otherResetsAtMs, nowMs))}."><i class="ph ph-arrow-right"></i> Continue on ${escapeHtml(otherLabel)}</button>`;
        } else {
          moveBtn = `<button class="rlb-move" data-account="${escapeHtml(other.id)}"><i class="ph ph-arrow-right"></i> Continue on ${escapeHtml(otherLabel)}</button>`;
        }
      }

      cards.push(`
        <div class="rate-limit-banner" data-account-id="${escapeHtml(accountId)}" style="--acc:${escapeHtml(colour)}">
          <i class="ph ph-${escapeHtml(icon)} rlb-icon"></i>
          <div class="rlb-text">
            <div class="rlb-title">${escapeHtml(title)}</div>
            <div class="rlb-time">${escapeHtml(timeLine)}</div>
            <div class="rlb-countdown">${escapeHtml(countdown)}</div>
          </div>
          <div class="rlb-actions">
            ${moveBtn}
            <button class="rlb-schedule"><i class="ph ph-calendar-dots"></i> View in Schedule</button>
          </div>
        </div>`);
    }

    this.host.innerHTML = cards.join("");
    this.wireActions();
    this.startTimer();
  }

  private wireActions(): void {
    if (!this.host) return;
    this.host.querySelectorAll<HTMLButtonElement>(".rlb-move").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const accountId = btn.closest<HTMLElement>(".rate-limit-banner")?.dataset.accountId;
        const targetAccountId = btn.dataset.account;
        if (accountId && targetAccountId) void this.moveToAccount(accountId, targetAccountId);
      });
    });
    this.host.querySelectorAll<HTMLButtonElement>(".rlb-schedule").forEach((btn) => {
      btn.addEventListener("click", () => showView("schedule"));
    });
  }

  private async moveToAccount(accountId: string, targetAccountId: string): Promise<void> {
    const blockedInAccount = this.instances.filter((i) => i.account_id === accountId && isBlocked(i));
    if (blockedInAccount.length === 0) return;
    const selectedId = this.getSelectedSessionId();
    const mostRecent = blockedInAccount
      .slice()
      .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0]!;
    const source = blockedInAccount.find((i) => i.session_id === selectedId) ?? mostRecent;
    try {
      const newId = await api.moveSessionToAccount(source.session_id, targetAccountId);
      const targetLabel = capitalize(getCachedAccount(targetAccountId)?.label ?? "the other account");
      showToast(`Moved to ${targetLabel}, continuing there.`);
      this.onMoved(newId);
    } catch (err) {
      console.error("[rate-limit-banner] moveSessionToAccount failed", err);
    }
  }
}

/** App-wide singleton. */
export const rateLimitBanner = new RateLimitBanner();
