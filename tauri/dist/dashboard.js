"use strict";

// ── View navigation ────────────────────────────────────────────────────────────
const VIEWS = ["dashboard", "settings", "settings-visuals", "settings-themes", "settings-notifications", "settings-sync", "stats", "stats-project", "graph-detail"];

let activeView = "dashboard";
let previousView = "dashboard";

function showView(name) {
  previousView = activeView;
  activeView = name;
  for (const id of VIEWS) {
    document.getElementById(`view-${id}`).classList.toggle("hidden", id !== name);
  }
}

document.getElementById("settingsBtn").onclick = () => showView("settings");
document.getElementById("backBtn").onclick = () => showView("dashboard");
document.getElementById("logoutBtn").onclick = () => window.electronAPI?.logout();

// Settings subpage nav
document.getElementById("nav-visuals").onclick = () => showView("settings-visuals");
document.getElementById("nav-themes").onclick = () => showView("settings-themes");
document.getElementById("nav-notifications").onclick = () => showView("settings-notifications");
// TODO: re-enable when Sync feature resumes.
// document.getElementById("nav-sync").onclick = () => showView("settings-sync");

// Back buttons on all subpages
document.querySelectorAll(".back-to-settings").forEach((btn) => {
  btn.onclick = () => showView("settings");
});

// Stats navigation
document.getElementById("statsBtn").onclick = () => {
  renderStats(lastTokenHistory);
  showView("stats");
};
document.getElementById("statsBackBtn").onclick = () => {
  showView("dashboard");
};
document.getElementById("projectDetailBackBtn").onclick = () => showView(previousView === "stats-project" ? "stats" : previousView);
document.getElementById("graphDetailBackBtn").onclick = () => showView("dashboard");

// Stats-project range + scroll buttons
document.querySelectorAll(".range-btn").forEach((btn) => {
  btn.onclick = () => {
    projectDetailState.range = btn.dataset.range;
    projectDetailState.offset = 0;
    renderProjectDetail();
  };
});
document.getElementById("chartPrevBtn").onclick = () => {
  projectDetailState.offset++;
  renderProjectDetail();
};
document.getElementById("chartNextBtn").onclick = () => {
  projectDetailState.offset = Math.max(0, projectDetailState.offset - 1);
  renderProjectDetail();
};

// ── State (shared as window globals with extracted modules) ──────────────────
let lastHistory = null;
let lastTokenHistory = null;
let currentSettings = {};
let projectDetailState = { cwd: null, range: "30d", offset: 0 };

// Dead paths: cwds whose folders no longer exist and couldn't be auto-merged
const _deadPaths = new Set();
function getDeadPaths() { return _deadPaths; }

async function runDeadPathCheck() {
  if (!lastTokenHistory || !lastTokenHistory.length) return;
  const aliases = currentSettings.projectAliases || {};
  // Collect all unique primary cwds (skip ones already merged into something)
  const cwds = [...new Set(lastTokenHistory.map((r) => r.cwd).filter(Boolean))].filter((c) => !aliases[c]?.mergedInto);
  if (!cwds.length) return;
  // Include merged paths in existence check - a project is alive if ANY of its paths exist
  const allPathsToCheck = new Set(cwds);
  for (const c of cwds) {
    const merged = aliases[c]?.mergedPaths || [];
    for (const m of merged) allPathsToCheck.add(m);
  }
  const existsMap = await window.electronAPI?.checkPathsExist([...allPathsToCheck]);
  if (!existsMap) return;
  const isProjectAlive = (c) => {
    if (existsMap[c]) return true;
    const merged = aliases[c]?.mergedPaths || [];
    return merged.some((m) => existsMap[m]);
  };
  const dead = cwds.filter((c) => !isProjectAlive(c));
  if (!dead.length) return;
  const live = cwds.filter(isProjectAlive);
  let anyMerged = false;
  for (const deadCwd of dead) {
    const deadName = deadCwd.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase() || "";
    const matches = live.filter((lc) => (lc.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase() || "") === deadName);
    if (matches.length === 1) {
      // Auto-merge: one live project with same folder name
      doMerge(deadCwd, matches[0]);
      anyMerged = true;
    } else {
      _deadPaths.add(deadCwd);
    }
  }
  if (anyMerged) { renderStats(lastTokenHistory); refreshDashboard(); }
  else if (_deadPaths.size) renderStats(lastTokenHistory);
}

// ── Stats rendering ───────────────────────────────────────────────────────────
const statsContent = document.getElementById("stats-content");

/** Re-render the main dashboard and wire all interactive elements. */
function refreshDashboard() {
  if (!lastHistory) return;
  renderHistory(lastHistory);
  wireProjectListClicks(statsContent, refreshDashboard);
}


function renderHistory(history) {
  lastHistory = history;
  if (!history || history.length === 0) {
    statsContent.innerHTML = `<div class="no-data">No history recorded yet.<br><small style="font-size:0.8rem">Data appears after the first successful refresh.</small></div>`;
    return;
  }

  const latest = history[history.length - 1];
  const sessionReset = fmtResetTime(latest.session_resets_at);
  const weeklyReset = fmtResetTime(latest.weekly_resets_at);

  // Weekly window bounds
  const weeklyEndMs = latest.weekly_resets_at
    ? new Date(latest.weekly_resets_at).getTime()
    : Date.now() + 3_600_000;
  const weeklyStartMs = weeklyEndMs - 7 * 24 * 3_600_000;

  // Session window bounds (5-hour)
  const SESSION_MS = 5 * 3_600_000;
  const sessionEndMs = latest.session_resets_at
    ? new Date(latest.session_resets_at).getTime()
    : Date.now() + 3_600_000;
  const sessionBaseStartMs = sessionEndMs - SESSION_MS;

  // Per-chart pagination offsets
  const WEEK_MS = 7 * 24 * 3_600_000;

  const sessionShiftMs = sessionPageOffset * SESSION_MS;
  const shiftedSessionEndMs = sessionEndMs - sessionShiftMs;
  const shiftedSessionStartMs = sessionBaseStartMs - sessionShiftMs;
  const hasSessionPrev = history.some((r) => { const t = hourToMs(r.hour); return t >= shiftedSessionStartMs - SESSION_MS && t < shiftedSessionStartMs; });

  const weeklyShiftMs = weeklyPageOffset * WEEK_MS;
  const shiftedWeeklyEndMs = weeklyEndMs - weeklyShiftMs;
  const shiftedWeeklyStartMs = weeklyStartMs - weeklyShiftMs;
  const hasWeeklyPrev = history.some((r) => { const t = hourToMs(r.hour); return t >= shiftedWeeklyStartMs - WEEK_MS && t < shiftedWeeklyStartMs; });

  // Safe pace: % of window time elapsed, clamped 0-100
  const sessionResetMs = latest.session_resets_at ? new Date(latest.session_resets_at).getTime() : null;
  const sessionSafePct = sessionResetMs !== null
    ? Math.max(0, Math.min(100, Math.round((5 * 3_600_000 - (sessionResetMs - Date.now())) / (5 * 3_600_000) * 100)))
    : null;
  const weeklySafePct = Math.max(0, Math.min(100, Math.round((7 * 24 * 3_600_000 - (weeklyEndMs - Date.now())) / (7 * 24 * 3_600_000) * 100)));

  const showSafePace = currentSettings.dashboardShowSafePace !== false;
  const showSessionGraph = currentSettings.dashboardShowSession !== false;
  const showWeeklyGraph = currentSettings.dashboardShowWeekly !== false;

  const legendItem = (id, color, isDashed, label) => {
    const dot = isDashed
      ? `<span style="display:inline-block;width:14px;height:2px;background:${color};vertical-align:middle;margin-right:4px;border-radius:1px;border-top:2px dashed ${color};"></span>`
      : `<span class="legend-dot" style="background:${color}"></span>`;
    return `<span id="${id}" style="cursor:pointer">${dot}${label}</span>`;
  };

  statsContent.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <div class="stat-label">Session (5h)</div>
        ${showSafePace ? `
        <div class="stat-values-row">
          <div class="stat-col">
            <div class="stat-value" style="color:${valueColor(latest.session_pct, sessionSafePct)}">${fmtPct(latest.session_pct)}</div>
            <div class="stat-sublabel">current</div>
          </div>
          <div class="stat-col">
            <div class="stat-value stat-value-dim">${fmtPct(sessionSafePct)}</div>
            <div class="stat-sublabel">safe pace</div>
          </div>
        </div>` : `
        <div class="stat-value" style="color:${valueColor(latest.session_pct, sessionSafePct)}">${fmtPct(latest.session_pct)}</div>`}
        ${sessionReset ? `<div class="stat-sublabel">${sessionReset}</div>` : ""}
      </div>
      <div class="stat-card">
        <div class="stat-label">Weekly (7d)</div>
        ${showSafePace ? `
        <div class="stat-values-row">
          <div class="stat-col">
            <div class="stat-value" style="color:${valueColor(latest.weekly_pct, weeklySafePct)}">${fmtPct(latest.weekly_pct)}</div>
            <div class="stat-sublabel">current</div>
          </div>
          <div class="stat-col">
            <div class="stat-value stat-value-dim">${fmtPct(weeklySafePct)}</div>
            <div class="stat-sublabel">safe pace</div>
          </div>
        </div>` : `
        <div class="stat-value" style="color:${valueColor(latest.weekly_pct, weeklySafePct)}">${fmtPct(latest.weekly_pct)}</div>`}
        ${weeklyReset ? `<div class="stat-sublabel">${weeklyReset}</div>` : ""}
      </div>
    </div>
    ${buildTodaySectionHTML(lastTokenHistory)}
    ${showSessionGraph ? buildGraphCard({
      id: "session",
      history,
      startMs: shiftedSessionStartMs,
      endMs: shiftedSessionEndMs,
      lineKey: "s",
      pctKey: "s",
      pageOffset: sessionPageOffset,
      hasPrev: hasSessionPrev,
      prevId: "prev-session",
      nextId: "next-session",
      pageLabel: sessionPageOffset === 0 ? "This session" : `${sessionPageOffset} session${sessionPageOffset > 1 ? "s" : ""} ago`,
      legends: [legendItem("legend-session", "#9d7dfc", false, "Session"), legendItem("legend-expected", "#6b6990", true, "Expected")],
      maxItems: 5,
    }) : ""}
    ${showWeeklyGraph ? buildGraphCard({
      id: "weekly",
      history,
      startMs: shiftedWeeklyStartMs,
      endMs: shiftedWeeklyEndMs,
      lineKey: "w",
      pctKey: "w",
      pageOffset: weeklyPageOffset,
      hasPrev: hasWeeklyPrev,
      prevId: "prev-weekly",
      nextId: "next-weekly",
      pageLabel: weeklyPageOffset === 0 ? "This week" : `${weeklyPageOffset}w ago`,
      legends: [legendItem("legend-weekly", "#6e8fff", false, "Weekly"), legendItem("legend-expected", "#6b6990", true, "Expected")],
      maxItems: 5,
    }) : ""}
  `;

  setupLegendToggles();
  applyLineVisibility();
  setupPaginationButtons();
  wireChartModeToggles(statsContent);
}

// Merge active (live) sessions into token history so project lists show ongoing work.
async function fetchTokenHistoryWithLive() {
  const history = await window.electronAPI?.getTokenHistory() || [];
  try {
    const active = await window.electronAPI?.getActiveSessions() || [];
    if (active.length) return [...history, ...active];
  } catch { /* handler may not be registered yet */ }
  return history;
}

// Gate initial render: only render once usage history, token history, AND settings are loaded.
let _initUsage = null;
let _initTokens = null;
let _initSettings = false;
function tryInitialRender() {
  if (_initUsage && _initTokens && _initSettings) {
    refreshDashboard();
    runDeadPathCheck();
  }
}
window.electronAPI?.getUsageHistory().then((h) => { _initUsage = h; lastHistory = h; tryInitialRender(); });
fetchTokenHistoryWithLive().then((th) => { _initTokens = th; lastTokenHistory = th; tryInitialRender(); });
window.electronAPI?.getSettings().then((s) => { if (s) currentSettings = s; _initSettings = true; tryInitialRender(); });

window.electronAPI?.onHistoryUpdated((h) => {
  lastHistory = h;
  refreshDashboard();
  if (activeView === "stats") renderStats(lastTokenHistory);
});
window.electronAPI?.onTokenHistoryUpdated(async (th) => {
  let active = [];
  try { active = await window.electronAPI?.getActiveSessions() || []; } catch { /* ignore */ }
  lastTokenHistory = active.length ? [...(th || []), ...active] : (th || []);
  refreshDashboard();
  if (activeView === "stats") renderStats(lastTokenHistory);
  if (activeView === "stats-project") renderProjectDetail();
});
