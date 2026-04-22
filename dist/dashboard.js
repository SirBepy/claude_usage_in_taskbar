"use strict";

// ── View navigation ────────────────────────────────────────────────────────────
const VIEWS = ["dashboard", "settings", "settings-visuals", "settings-themes", "settings-notifications", "settings-sync", "statistics", "projects", "project-detail", "graph-detail"];

let activeView = "dashboard";
let previousView = "dashboard";

function showView(name) {
  previousView = activeView;
  activeView = name;
  for (const id of VIEWS) {
    document.getElementById(`view-${id}`).classList.toggle("hidden", id !== name);
  }
  updateSidemenuActive(name);
}

// ── Sidemenu ───────────────────────────────────────────────────────────────
function openSidemenu() {
  document.getElementById("sidemenu").classList.add("open");
  document.getElementById("sidemenuBackdrop").classList.add("open");
}
function closeSidemenu() {
  document.getElementById("sidemenu").classList.remove("open");
  document.getElementById("sidemenuBackdrop").classList.remove("open");
}
function updateSidemenuActive(viewName) {
  document.querySelectorAll(".sidemenu-nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === viewName);
  });
}

// Every burger button in the app opens the sidemenu.
document.querySelectorAll("[data-burger]").forEach((btn) => {
  btn.onclick = () => openSidemenu();
});

document.getElementById("sidemenuBackdrop").onclick = closeSidemenu;

// Projects grid/list toggle
document.querySelectorAll("#projectsViewModeToggle .mode-btn").forEach((btn) => {
  btn.onclick = async () => {
    const mode = btn.dataset.mode;
    document.querySelectorAll("#projectsViewModeToggle .mode-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    await window.electronAPI.setProjectsViewMode(mode);
    if (typeof renderProjectsList === "function") renderProjectsList();
  };
});

async function syncProjectsViewModeFromSettings() {
  const s = await window.electronAPI.getSettings();
  const mode = s.projects_view_mode || "grid";
  document.querySelectorAll("#projectsViewModeToggle .mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
}

// Nav item click → navigate + close.
document.querySelectorAll(".sidemenu-nav-item").forEach((item) => {
  item.onclick = () => {
    const view = item.dataset.view;
    showView(view);
    closeSidemenu();
    if (view === "projects") renderProjectsList();
  };
});

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
document.getElementById("projectDetailBackBtn").onclick = () => showView("projects");
document.getElementById("graphDetailBackBtn").onclick = () => showView("dashboard");

function showToast(msg) {
  let t = document.getElementById("__toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "__toast";
    t.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--surface-alt,#2a2a3a);color:var(--text,#fff);padding:8px 14px;border-radius:6px;font-size:0.8rem;z-index:2000;opacity:0;transition:opacity 160ms;";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t.__timer);
  t.__timer = setTimeout(() => { t.style.opacity = "0"; }, 2200);
}

// ── Automation form ──────────────────────────────────────────────────────────

async function renderAutomationForm() {
  if (!projectDetailState.cwd) return;
  const projects = await window.electronAPI.listProjects();
  const proj = projects.find((p) => p.path === projectDetailState.cwd);
  const empty = document.getElementById("automationEmpty");
  const form = document.getElementById("automationForm");
  if (!empty || !form) return;
  if (!proj || !proj.automation) {
    empty.style.display = "block";
    form.style.display = "none";
    return;
  }
  empty.style.display = "none";
  form.style.display = "block";
  document.getElementById("automationEnabled").checked = !!proj.automation.enabled;
  document.getElementById("automationAutostart").checked = !!proj.automation.autostart_on_boot;
  document.getElementById("automationContinue").checked = !!proj.automation.continue_flag;
  document.getElementById("automationPrefix").value = proj.automation.session_name_prefix || "";
  form.dataset.projectId = proj.id;
}

document.getElementById("automateChannelBtn").onclick = async () => {
  if (!projectDetailState.cwd) return;
  const projects = await window.electronAPI.listProjects();
  const proj = projects.find((p) => p.path === projectDetailState.cwd);
  if (!proj) return showToast("Project not found.");
  await window.electronAPI.updateProject(proj.id, {
    automation: {
      enabled: false,
      autostart_on_boot: true,
      session_name_prefix: null,
      continue_flag: true,
    },
  });
  await renderAutomationForm();
  showToast("Automation added. Flip Enabled to start it.");
};

document.getElementById("automationApplyBtn").onclick = async () => {
  const projectId = document.getElementById("automationForm").dataset.projectId;
  if (!projectId) return;
  const enabled = document.getElementById("automationEnabled").checked;
  const autostart = document.getElementById("automationAutostart").checked;
  const cont = document.getElementById("automationContinue").checked;
  const prefix = document.getElementById("automationPrefix").value.trim() || null;
  await window.electronAPI.updateProject(projectId, {
    automation: {
      enabled, autostart_on_boot: autostart,
      session_name_prefix: prefix, continue_flag: cont,
    },
  });
  if (enabled) {
    try { await window.electronAPI.spawnChannel(projectId); }
    catch (e) { showToast(`Spawn failed: ${e}`); }
  } else {
    try { await window.electronAPI.stopChannel(projectId); } catch (_) {}
  }
  showToast("Automation updated.");
};

document.getElementById("automationRemoveBtn").onclick = async () => {
  const projectId = document.getElementById("automationForm").dataset.projectId;
  if (!projectId) return;
  try { await window.electronAPI.stopChannel(projectId); } catch (_) {}
  await window.electronAPI.updateProject(projectId, { automation: null });
  await renderAutomationForm();
  showToast("Automation removed.");
};

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
const statisticsContent = document.getElementById("statistics-content");

/** Re-render the main dashboard and wire all interactive elements. */
function refreshDashboard() {
  if (!lastHistory) return;
  renderHistory(lastHistory);
  wireProjectListClicks(statisticsContent, refreshDashboard);
}


function renderHistory(history) {
  lastHistory = history;
  if (!history || history.length === 0) {
    const emptyHtml = `<div class="no-data">No history recorded yet.<br><small style="font-size:0.8rem">Data appears after the first successful refresh.</small></div>`;
    statsContent.innerHTML = emptyHtml;
    statisticsContent.innerHTML = emptyHtml;
    return;
  }

  renderHomeCards(history);
  renderStatistics(history);
}

/** Home view: ONLY the two big session + weekly cards. */
function renderHomeCards(history) {
  const latest = history[history.length - 1];
  const sessionReset = fmtResetTime(latest.session_resets_at);
  const weeklyReset = fmtResetTime(latest.weekly_resets_at);

  const weeklyEndMs = latest.weekly_resets_at
    ? new Date(latest.weekly_resets_at).getTime()
    : Date.now() + 3_600_000;
  const sessionResetMs = latest.session_resets_at ? new Date(latest.session_resets_at).getTime() : null;
  const sessionSafePct = sessionResetMs !== null
    ? Math.max(0, Math.min(100, Math.round((5 * 3_600_000 - (sessionResetMs - Date.now())) / (5 * 3_600_000) * 100)))
    : null;
  const weeklySafePct = Math.max(0, Math.min(100, Math.round((7 * 24 * 3_600_000 - (weeklyEndMs - Date.now())) / (7 * 24 * 3_600_000) * 100)));

  const showSafePace = currentSettings.dashboardShowSafePace !== false;

  statsContent.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card home-card">
        <div class="stat-label label">Session (5h)</div>
        <div class="ring-wrap">
          ${showSafePace ? `
          <div class="stat-values-row">
            <div class="stat-col">
              <div class="stat-value pct" style="color:${valueColor(latest.session_pct, sessionSafePct)}">${fmtPct(latest.session_pct)}</div>
              <div class="stat-sublabel">current</div>
            </div>
            <div class="stat-col">
              <div class="stat-value stat-value-dim">${fmtPct(sessionSafePct)}</div>
              <div class="stat-sublabel">safe pace</div>
            </div>
          </div>` : `
          <div class="stat-value pct" style="color:${valueColor(latest.session_pct, sessionSafePct)}">${fmtPct(latest.session_pct)}</div>`}
        </div>
        ${sessionReset ? `<div class="stat-sublabel sub">${sessionReset}</div>` : ""}
      </div>
      <div class="stat-card home-card">
        <div class="stat-label label">Weekly (7d)</div>
        <div class="ring-wrap">
          ${showSafePace ? `
          <div class="stat-values-row">
            <div class="stat-col">
              <div class="stat-value pct" style="color:${valueColor(latest.weekly_pct, weeklySafePct)}">${fmtPct(latest.weekly_pct)}</div>
              <div class="stat-sublabel">current</div>
            </div>
            <div class="stat-col">
              <div class="stat-value stat-value-dim">${fmtPct(weeklySafePct)}</div>
              <div class="stat-sublabel">safe pace</div>
            </div>
          </div>` : `
          <div class="stat-value pct" style="color:${valueColor(latest.weekly_pct, weeklySafePct)}">${fmtPct(latest.weekly_pct)}</div>`}
        </div>
        ${weeklyReset ? `<div class="stat-sublabel sub">${weeklyReset}</div>` : ""}
      </div>
    </div>
  `;
}

/** Statistics view: today section + session graph + weekly graph (everything else). */
function renderStatistics(history) {
  const latest = history[history.length - 1];

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

  const showSessionGraph = currentSettings.dashboardShowSession !== false;
  const showWeeklyGraph = currentSettings.dashboardShowWeekly !== false;

  const legendItem = (id, color, isDashed, label) => {
    const dot = isDashed
      ? `<span style="display:inline-block;width:14px;height:2px;background:${color};vertical-align:middle;margin-right:4px;border-radius:1px;border-top:2px dashed ${color};"></span>`
      : `<span class="legend-dot" style="background:${color}"></span>`;
    return `<span id="${id}" style="cursor:pointer">${dot}${label}</span>`;
  };

  statisticsContent.innerHTML = `
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
  wireChartModeToggles(statisticsContent);
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
window.electronAPI?.getSettings().then((s) => {
  if (s) {
    s.colorApplyTo = {
      icon: s.colorApplyTo?.icon !== false,
      number: s.colorApplyTo?.number !== false,
      dashboard: s.colorApplyTo?.dashboard !== false,
      tooltip: s.colorApplyTo?.tooltip !== false,
    };
    currentSettings = s;
  }
  _initSettings = true;
  tryInitialRender();
  syncProjectsViewModeFromSettings();
});

window.electronAPI?.onHistoryUpdated((h) => {
  lastHistory = h;
  refreshDashboard();
  if (activeView === "projects") renderProjectsList();
});
window.electronAPI?.onTokenHistoryUpdated(async (th) => {
  let active = [];
  try { active = await window.electronAPI?.getActiveSessions() || []; } catch { /* ignore */ }
  lastTokenHistory = active.length ? [...(th || []), ...active] : (th || []);
  refreshDashboard();
  if (activeView === "projects") renderProjectsList();
  if (activeView === "project-detail") renderProjectDetail();
});

// ── Projects view (grid/list cards) ────────────────────────────────────────
async function renderProjectsList() {
  const tokenHistory = lastTokenHistory || (await window.electronAPI?.getTokenHistory?.()) || [];
  let projects = [];
  try { projects = await window.electronAPI?.listProjects?.() || []; } catch { /* ignore */ }
  let liveInstances = [];
  try { liveInstances = ((await window.electronAPI?.listInstances?.()) || []).filter((i) => !i.end_reason); } catch { /* ignore */ }

  const byPath = new Map();
  for (const rec of tokenHistory) {
    const key = rec.cwd || "(unknown)";
    const bucket = byPath.get(key) || { cwd: key, tokens_7d: 0, live: 0, anyRemote: false, anyAutomated: false };
    bucket.tokens_7d += (rec.input_tokens || 0) + (rec.output_tokens || 0);
    byPath.set(key, bucket);
  }

  for (const p of projects) {
    const existing = byPath.get(p.path) || { cwd: p.path, tokens_7d: 0, live: 0, anyRemote: false, anyAutomated: false };
    existing.name = p.name;
    existing.avatar = p.avatar;
    existing.projectId = p.id;
    existing.anyAutomated = existing.anyAutomated || !!p.automation?.enabled;
    byPath.set(p.path, existing);
  }

  for (const inst of liveInstances) {
    const key = inst.cwd;
    const existing = byPath.get(key) || { cwd: key, tokens_7d: 0, live: 0, anyRemote: false, anyAutomated: false };
    existing.live = (existing.live || 0) + 1;
    existing.anyRemote = existing.anyRemote || inst.is_remote;
    existing.anyAutomated = existing.anyAutomated || inst.kind === "automated";
    byPath.set(key, existing);
  }

  const entries = [...byPath.values()].sort((a, b) => {
    if ((b.live || 0) !== (a.live || 0)) return (b.live || 0) - (a.live || 0);
    return (b.tokens_7d || 0) - (a.tokens_7d || 0);
  });

  const container = document.getElementById("projects-list");
  const empty = document.getElementById("projects-empty");
  if (!container || !empty) return;
  if (entries.length === 0) {
    container.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  const s = (await window.electronAPI?.getSettings?.()) || {};
  const mode = s.projects_view_mode || "grid";
  container.classList.toggle("grid-mode", mode === "grid");
  container.classList.toggle("list-mode", mode === "list");

  container.innerHTML = entries.map((e) => projectCardHtml(e)).join("");
  container.querySelectorAll(".project-card").forEach((el) => {
    el.onclick = () => openProjectDetail(el.dataset.cwd);
  });
}

function projectCardHtml(entry) {
  const displayName = entry.name || basenameProj(entry.cwd);
  const avatar = renderAvatar(entry.avatar);
  const tokens = formatCompactTokens(entry.tokens_7d || 0);
  const tags = [
    entry.live ? `<span class="card-tag live">● ${entry.live}</span>` : "",
    entry.anyRemote ? `<span class="card-tag remote">📱</span>` : "",
    entry.anyAutomated ? `<span class="card-tag automated">⚙</span>` : "",
  ].filter(Boolean).join(" ");
  return `
    <div class="project-card" data-cwd="${escapeProjHtml(entry.cwd)}" data-project-id="${entry.projectId || ""}">
      <div class="avatar">${avatar}</div>
      <div class="body">
        <div class="name">${escapeProjHtml(displayName)}${tags ? ` <span class="card-tags">${tags}</span>` : ""}</div>
        <div class="tokens">${tokens} tokens · last 7d</div>
      </div>
    </div>
  `;
}

function renderAvatar(avatar) {
  if (!avatar || avatar.kind === "none") return "?";
  if (avatar.kind === "emoji") return escapeProjHtml(avatar.value);
  if (avatar.kind === "image") {
    const src = `file:///${String(avatar.value).replaceAll("\\", "/")}`;
    return `<img src="${src}" style="width:100%;height:100%;object-fit:cover;border-radius:7px" alt="">`;
  }
  return "?";
}

function basenameProj(p) {
  if (!p) return "(unknown)";
  const parts = String(p).split(/[\\/]/);
  return parts.filter(Boolean).pop() || "(unknown)";
}

function formatCompactTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function escapeProjHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"
  }[c]));
}

// ── Hook-registration consent modal ─────────────────────────────────────────

async function maybeShowHookModal() {
  const state = await window.electronAPI.getHookRegistrationState();
  if (!state || state.registered || state.declined) return;
  showHookModal();
}

function showHookModal() {
  const backdrop = document.getElementById("hookModalBackdrop");
  const modal = document.getElementById("hookModal");
  backdrop.style.display = "block";
  modal.style.display = "block";
  renderHookModalPreview();
}

function hideHookModal() {
  document.getElementById("hookModalBackdrop").style.display = "none";
  document.getElementById("hookModal").style.display = "none";
}

async function renderHookModalPreview() {
  const state = await window.electronAPI.getHookRegistrationState();
  const port = state.port || "?";
  const preview = [
    `"hooks": {`,
    `  "SessionStart": [{`,
    `    "matcher": "aiusage-taskbar",`,
    `    "hooks": [{ "type": "command",`,
    `      "command": "curl -sS -X POST … :${port}/hooks/session-start" }]`,
    `  }],`,
    `  "SessionEnd": [{ ... similarly … }]`,
    `}`,
  ].join("\n");
  document.getElementById("hookModalPreview").textContent = preview;
}

document.getElementById("hookModalAccept").onclick = async () => {
  try {
    await window.electronAPI.registerHooksGlobally();
    hideHookModal();
    showToast("Hooks enabled. Running instances will now show up.");
  } catch (e) {
    showToast(`Hook install failed: ${e}`);
  }
};

document.getElementById("hookModalSkip").onclick = () => {
  hideHookModal();
  // Will re-offer on next launch.
};

document.getElementById("hookModalNever").onclick = async () => {
  await window.electronAPI.skipHookRegistration();
  hideHookModal();
};

// ── Running instances ────────────────────────────────────────────────────────

async function renderRunningInstances() {
  if (!projectDetailState.cwd) return;

  const projects = await window.electronAPI.listProjects();
  const proj = projects.find((p) => p.path === projectDetailState.cwd);
  if (!proj) {
    setRunningInstancesEmpty(0);
    return;
  }
  const instances = (await window.electronAPI.listInstancesForProject(proj.id))
    .filter((i) => !i.end_reason);
  const count = instances.length;

  document.getElementById("runningInstancesCount").textContent = count;
  const listEl = document.getElementById("runningInstancesList");
  const emptyEl = document.getElementById("runningInstancesEmpty");
  if (count === 0) {
    listEl.style.display = "none";
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";
  listEl.style.display = "block";

  listEl.innerHTML = instances.map((i) => instanceRowHtml(i)).join("");
  listEl.querySelectorAll(".phone-link-btn").forEach((btn) => {
    btn.onclick = async () => {
      const url = await window.electronAPI.phoneLink(btn.dataset.sessionId);
      if (!url) return showToast("Phone link not available yet.");
      await navigator.clipboard.writeText(url);
      showToast(`Copied: ${url}`);
    };
  });
  listEl.querySelectorAll(".term-btn").forEach((btn) => {
    btn.onclick = async () => {
      try { await window.electronAPI.showTerminal(btn.dataset.projectId); }
      catch (e) { showToast(`Show terminal failed: ${e}`); }
    };
  });
  listEl.querySelectorAll(".restart-btn").forEach((btn) => {
    btn.onclick = async () => {
      try { await window.electronAPI.restartChannel(btn.dataset.projectId); showToast("Restarting…"); }
      catch (e) { showToast(`Restart failed: ${e}`); }
    };
  });
  listEl.querySelectorAll(".stop-btn").forEach((btn) => {
    btn.onclick = async () => {
      try { await window.electronAPI.stopChannel(btn.dataset.projectId); showToast("Stopped."); }
      catch (e) { showToast(`Stop failed: ${e}`); }
    };
  });
}

function setRunningInstancesEmpty(count) {
  document.getElementById("runningInstancesCount").textContent = count;
  document.getElementById("runningInstancesList").style.display = "none";
  document.getElementById("runningInstancesEmpty").style.display = "block";
}

function instanceRowHtml(i) {
  const uptime = uptimeFrom(i.started_at);
  const kindClass = i.kind === "external" ? "external" : "";
  const kindTag = i.kind === "automated" ? "Automated" : "External";
  const kindTagClass = i.kind === "automated" ? "automated" : "";
  const remoteTag = i.is_remote ? `<span class="tag remote">📱</span>` : "";
  const phoneDisabled = i.bridge_session_id ? "" : "disabled";
  const automatedOnlyDisabled = i.kind === "automated" ? "" : "disabled";
  const pid = i.project_id;
  return `
    <div class="instance-row ${kindClass}">
      <div class="status-dot"></div>
      <div class="meta">
        <div class="top">
          <span class="tag ${kindTagClass}">${kindTag}</span>${remoteTag}
          <span>pid ${i.pid}</span>
        </div>
        <div class="sub">up ${uptime} · session ${i.session_id.slice(0, 8)}…</div>
      </div>
      <div class="actions">
        <button class="act-btn term-btn" title="Show terminal" data-project-id="${pid}" ${automatedOnlyDisabled}>term</button>
        <button class="act-btn phone-link-btn" title="Copy phone link" data-session-id="${i.session_id}" ${phoneDisabled}>phone</button>
        <button class="act-btn restart-btn" title="Restart" data-project-id="${pid}" ${automatedOnlyDisabled}>restart</button>
        <button class="act-btn stop-btn" title="Stop" data-project-id="${pid}" ${automatedOnlyDisabled}>stop</button>
      </div>
    </div>
  `;
}

function uptimeFrom(iso) {
  const start = new Date(iso).getTime();
  const delta = Math.max(0, Date.now() - start);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Subscribe to live updates.
window.electronAPI.onInstancesChanged(() => {
  if (activeView === "project-detail") renderRunningInstances();
  if (activeView === "projects") renderProjectsList();
});

// Called after settings load.
maybeShowHookModal();
