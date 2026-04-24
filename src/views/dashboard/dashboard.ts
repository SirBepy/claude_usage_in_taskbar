import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import "./dashboard.css";
import { fmtPct, fmtResetTime, valueColor } from "../../shared/formatters";
import { getSettings, setUsageHistory, getUsageHistory } from "../../shared/state";
import {
  buildPinnedCardsHTML,
  setupPaginationButtons,
  setupLegendToggles,
  applyLineVisibility,
  wireChartModeToggles,
  wirePinButtons,
  wireProjectListClicks,
} from "../statistics/statistics";
import type { UsageRecord } from "../statistics/statistics";

interface ElectronAPI {
  getUsageHistory(): Promise<UsageRecord[]>;
  pollNow(): Promise<unknown>;
  onHistoryUpdated(cb: (h: UsageRecord[]) => void): () => void;
}

interface LegacyGlobals {
  electronAPI?: ElectronAPI;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

let refreshBusy = false;
let lastAutoPollMs = 0;

function getHistory(): UsageRecord[] | null {
  return getUsageHistory() as UsageRecord[] | null;
}

async function maybeAutoPoll(reason: "crossover" | "focus"): Promise<void> {
  if (refreshBusy) return;
  const now = Date.now();
  // Throttle: one auto-poll per minute.
  if (now - lastAutoPollMs < 60_000) return;
  const api = g().electronAPI;
  if (!api) return;
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

  const api = g().electronAPI;
  if (api && !getHistory()) {
    try {
      setUsageHistory(await api.getUsageHistory());
      if (content) drawInto(content);
    } catch (e) {
      console.error("[dashboard] initial history fetch failed", e);
    }
  }

  const unlisten = api?.onHistoryUpdated((h) => {
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

  return () => {
    try { unlisten?.(); } catch { /* ignore */ }
    window.removeEventListener("refresh-dashboard-home", onRefreshEvent);
    document.removeEventListener("visibilitychange", onVisibility);
    window.clearInterval(crossoverTimer);
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
    await g().electronAPI?.pollNow();
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
  const sessionReset = fmtResetTime(latest.session_resets_at);
  const weeklyReset = fmtResetTime(latest.weekly_resets_at);

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
        ${sessionReset ? `<div class="stat-sublabel sub">${sessionReset}</div>` : ""}
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
        ${weeklyReset ? `<div class="stat-sublabel sub">${weeklyReset}</div>` : ""}
      </div>
    </div>
    ${buildPinnedCardsHTML(history)}
  `;

  setupPaginationButtons();
  setupLegendToggles();
  applyLineVisibility();
  wireChartModeToggles(container);
  wirePinButtons(container, { onHomeUnpin: true });
  wireProjectListClicks(container, () => drawInto(container));
}
