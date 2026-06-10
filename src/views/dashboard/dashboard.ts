import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import "./dashboard.css";
import { fmtPct, fmtResetDisplay, valueColor } from "../../shared/formatters";
import type { ResetDisplay } from "../../shared/formatters";
import { getSettings, setUsageHistory, getUsageHistory } from "../../shared/state";
import { api } from "../../shared/api";
import type { UsageRecord } from "../../shared/api";
import {
  buildPinnedCardsHTML,
  setupPaginationButtons,
  setupLegendToggles,
  applyLineVisibility,
  wireBarsMore,
  wirePinButtons,
  wireProjectListClicks,
} from "../statistics/statistics";

let refreshBusy = false;
let lastAutoPollMs = 0;
let aiPollTimer: number | null = null;

async function tickAiPoll(): Promise<void> {
  try {
    const instances = await api.listInstances();
    if (instances.length === 0) {
      if (aiPollTimer !== null) {
        window.clearInterval(aiPollTimer);
        aiPollTimer = null;
      }
      return;
    }
    await api.pollNow();
  } catch (err) {
    console.error("[dashboard] ai-running poll failed", err);
  }
}

function ensureAiPollRunning(): void {
  if (aiPollTimer !== null) return;
  aiPollTimer = window.setInterval(() => void tickAiPoll(), 60_000);
}

function getHistory(): UsageRecord[] | null {
  return getUsageHistory() as UsageRecord[] | null;
}

async function maybeAutoPoll(reason: "crossover" | "focus"): Promise<void> {
  if (refreshBusy) return;
  const now = Date.now();
  // Throttle: one auto-poll per minute.
  if (now - lastAutoPollMs < 60_000) return;
  const history = getHistory();
  if (!history || history.length === 0) return;
  const latest = history[history.length - 1]!;
  const sessionMs = latest.session_resets_at ? new Date(latest.session_resets_at).getTime() : null;
  const weeklyMs = latest.weekly_resets_at ? new Date(latest.weekly_resets_at).getTime() : null;
  const sessionExpired = sessionMs !== null && now >= sessionMs;
  const weeklyExpired = weeklyMs !== null && now >= weeklyMs;
  if (reason === "crossover" && !sessionExpired && !weeklyExpired) return;
  lastAutoPollMs = now;
  try {
    await api.pollNow();
  } catch (err) {
    console.error("[dashboard] auto pollNow failed", err);
  }
}

export async function renderDashboard(root: HTMLElement): Promise<() => void> {
  render(template(), root);
  const content = root.querySelector<HTMLElement>("#stats-content");
  if (content) drawInto(content);

  if (!getHistory()) {
    try {
      setUsageHistory(await api.getUsageHistory());
      if (content) drawInto(content);
    } catch (e) {
      console.error("[dashboard] initial history fetch failed", e);
    }
  }

  const unlisten = api.onHistoryUpdated((h) => {
    setUsageHistory(h);
    const el = root.querySelector<HTMLElement>("#stats-content");
    if (el) drawInto(el);
  });

  const onRefreshEvent = () => {
    const el = root.querySelector<HTMLElement>("#stats-content");
    if (el) drawInto(el);
  };
  window.addEventListener("refresh-dashboard-home", onRefreshEvent);

  const onVisibility = () => {
    if (document.visibilityState === "visible") void maybeAutoPoll("focus");
  };
  document.addEventListener("visibilitychange", onVisibility);

  void maybeAutoPoll("crossover");
  const crossoverTimer = window.setInterval(() => void maybeAutoPoll("crossover"), 60_000);

  // Start AI-running poll if any instances are live right now.
  void api.listInstances().then((list) => { if (list.length > 0) ensureAiPollRunning(); });

  const unlistenInstances = api.onInstancesChanged((list) => {
    if (Array.isArray(list) && list.length > 0) ensureAiPollRunning();
  });

  return () => {
    try { unlisten(); } catch { /* ignore */ }
    try { unlistenInstances(); } catch { /* ignore */ }
    window.removeEventListener("refresh-dashboard-home", onRefreshEvent);
    document.removeEventListener("visibilitychange", onVisibility);
    window.clearInterval(crossoverTimer);
    if (aiPollTimer !== null) { window.clearInterval(aiPollTimer); aiPollTimer = null; }
  };
}

function template() {
  return html`
    <div class="view view-dashboard">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Claude Usage</h2>
        <button
          class="icon-btn"
          id="refreshNowBtn"
          title="Refresh now"
          @click=${onRefreshClick}
        >
          <i class="ph ph-arrows-clockwise"></i>
        </button>
      </div>
      <div class="view-body">
        <div id="stats-content">
          <div class="no-data">Loading...</div>
        </div>
      </div>
    </div>
  `;
}

async function onRefreshClick(e: Event) {
  if (refreshBusy) return;
  refreshBusy = true;
  const btn = e.currentTarget as HTMLElement | null;
  btn?.classList.add("spinning");
  try {
    await api.pollNow();
  } catch (err) {
    console.error("pollNow failed", err);
  } finally {
    btn?.classList.remove("spinning");
    refreshBusy = false;
  }
}

function drawInto(container: HTMLElement): void {
  const history = getHistory();
  if (!history || history.length === 0) {
    container.innerHTML = `<div class="no-data">No history recorded yet.<br><small style="font-size:0.8rem">Data appears after the first successful refresh.</small></div>`;
    return;
  }

  const latest = history[history.length - 1]!;
  const settings = getSettings();
  const sessionReset = fmtResetDisplay(latest.session_resets_at);
  const weeklyReset = fmtResetDisplay(latest.weekly_resets_at);
  const SESSION_WINDOW_MS = 5 * 3_600_000;
  const WEEKLY_WINDOW_MS = 7 * 24 * 3_600_000;
  const renderReset = (r: ResetDisplay | null, windowMs: number): string => {
    if (!r) return "";
    if (r.diffMs <= 0) return `<div class="reset-info"><div class="reset-relative">now</div></div>`;
    const frac = Math.max(0, Math.min(1, r.diffMs / windowMs));
    const opacity = (1 - frac * 0.7).toFixed(2);
    return `
      <div class="reset-info" style="opacity:${opacity}">
        <div class="reset-label">resets</div>
        <div class="reset-absolute">${r.absolute}</div>
        <div class="reset-relative">${r.relative}</div>
      </div>`;
  };

  const weeklyEndMs = latest.weekly_resets_at
    ? new Date(latest.weekly_resets_at).getTime()
    : Date.now() + 3_600_000;
  const sessionResetMs = latest.session_resets_at
    ? new Date(latest.session_resets_at).getTime()
    : null;
  const sessionSafePct =
    sessionResetMs !== null
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(
              ((5 * 3_600_000 - (sessionResetMs - Date.now())) /
                (5 * 3_600_000)) *
                100,
            ),
          ),
        )
      : null;
  const weeklySafePct = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        ((7 * 24 * 3_600_000 - (weeklyEndMs - Date.now())) /
          (7 * 24 * 3_600_000)) *
          100,
      ),
    ),
  );

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card home-card">
        <div class="stat-label label">Session (5h)</div>
        <div class="ring-wrap">
          <div class="stat-values-row">
            <div class="stat-col">
              <div class="stat-value pct" style="color:${valueColor(latest.session_pct as number, sessionSafePct, settings)}">${fmtPct(latest.session_pct)}</div>
              <div class="stat-sublabel">current</div>
            </div>
            <div class="stat-col">
              <div class="stat-value stat-value-dim">${fmtPct(sessionSafePct as number)}</div>
              <div class="stat-sublabel">safe pace</div>
            </div>
          </div>
        </div>
        ${renderReset(sessionReset, SESSION_WINDOW_MS)}
      </div>
      <div class="stat-card home-card">
        <div class="stat-label label">Weekly (7d)</div>
        <div class="ring-wrap">
          <div class="stat-values-row">
            <div class="stat-col">
              <div class="stat-value pct" style="color:${valueColor(latest.weekly_pct as number, weeklySafePct, settings)}">${fmtPct(latest.weekly_pct)}</div>
              <div class="stat-sublabel">current</div>
            </div>
            <div class="stat-col">
              <div class="stat-value stat-value-dim">${fmtPct(weeklySafePct)}</div>
              <div class="stat-sublabel">safe pace</div>
            </div>
          </div>
        </div>
        ${renderReset(weeklyReset, WEEKLY_WINDOW_MS)}
      </div>
    </div>
    ${buildPinnedCardsHTML(history)}
  `;

  setupPaginationButtons();
  setupLegendToggles();
  applyLineVisibility();
  wireBarsMore(container);
  wirePinButtons(container, { onHomeUnpin: true });
  wireProjectListClicks(container, () => drawInto(container));
}
