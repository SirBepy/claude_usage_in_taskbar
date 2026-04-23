"use strict";

// ── View navigation ────────────────────────────────────────────────────────────
// Dashboard + Statistics + Projects are migrated to src/views/. All other
// views still render from the `#view-<name>` divs in index.html.
const VIEWS = [
  "settings", "settings-visuals", "settings-themes",
  "settings-notifications", "settings-sync",
  "project-detail", "graph-detail",
  "project-notif-overrides", "project-automation", "project-folder-mapping",
  "project-sessions", "session-detail",
];

let activeView = "dashboard";
let previousView = "dashboard";

function showView(name) {
  previousView = activeView;
  activeView = name;
  if (name !== "session-detail" && typeof stopLiveSessionPolling === "function") {
    stopLiveSessionPolling();
  }
  if (typeof window.navigateTo === "function") {
    // Router takes over: hides legacy .view divs, shows #app for migrated
    // views, or unhides the matching legacy div for non-migrated ones.
    window.navigateTo(name);
  } else {
    for (const id of VIEWS) {
      const el = document.getElementById(`view-${id}`);
      if (el) el.classList.toggle("hidden", id !== name);
    }
  }
  updateSidemenuActive(name);
}

// Stack of subview origins so Session detail knows where "back" goes.
const projectSubviewStack = [];

function openProjectSubview(subview) {
  // subview: "project-notif-overrides" | "project-automation" | "project-folder-mapping" | "project-sessions"
  projectSubviewStack.push("project-detail");
  showView(subview);
}

function openSessionDetailView(originView) {
  projectSubviewStack.push(originView);
  showView("session-detail");
}

function backFromSubview() {
  const origin = projectSubviewStack.pop() || "project-detail";
  showView(origin);
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

// Home view's refresh button is owned by src/views/dashboard/dashboard.ts.

// Projects-sort dropdown + select-value sync are owned by
// src/views/projects/projects.ts.
async function syncProjectsSortFromSettings() { /* no-op (migrated) */ }

// Nav item click → navigate + close.
document.querySelectorAll(".sidemenu-nav-item").forEach((item) => {
  item.onclick = () => {
    const view = item.dataset.view;
    showView(view);
    closeSidemenu();
    if (view === "projects") renderProjectsList();
  };
});

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
document.getElementById("projectDetailBackBtn").onclick = () => {
  projectSubviewStack.length = 0;
  showView("projects");
};

// Project-detail 3-dot menu
const projectDetailMenuBtn = document.getElementById("projectDetailMenuBtn");
const projectDetailMenu = document.getElementById("projectDetailMenu");
if (projectDetailMenuBtn && projectDetailMenu) {
  projectDetailMenuBtn.onclick = (e) => {
    e.stopPropagation();
    projectDetailMenu.classList.toggle("hidden");
  };
  projectDetailMenu.querySelectorAll(".menu-item").forEach((btn) => {
    btn.onclick = () => {
      projectDetailMenu.classList.add("hidden");
      const kind = btn.dataset.menuItem;
      if (kind === "notif-overrides") {
        if (typeof populateProjectSubviewHeader === "function") populateProjectSubviewHeader("notifOverrides");
        if (typeof renderProjectOverrides === "function") renderProjectOverrides(projectDetailState.cwd);
        openProjectSubview("project-notif-overrides");
      } else if (kind === "automation") {
        if (typeof populateProjectSubviewHeader === "function") populateProjectSubviewHeader("automation");
        if (typeof renderAutomationForm === "function") renderAutomationForm();
        openProjectSubview("project-automation");
      } else if (kind === "folder-mapping") {
        if (typeof populateProjectSubviewHeader === "function") populateProjectSubviewHeader("folderMapping");
        if (typeof wireFolderMappingSubview === "function") wireFolderMappingSubview(projectDetailState.cwd);
        openProjectSubview("project-folder-mapping");
      }
    };
  });
  document.addEventListener("click", (e) => {
    if (projectDetailMenu.classList.contains("hidden")) return;
    if (projectDetailMenu.contains(e.target) || projectDetailMenuBtn.contains(e.target)) return;
    projectDetailMenu.classList.add("hidden");
  });
}

// Back buttons on project subviews
["notifOverridesBackBtn", "automationBackBtn", "folderMappingBackBtn", "allSessionsBackBtn"].forEach((id) => {
  const btn = document.getElementById(id);
  if (btn) btn.onclick = () => backFromSubview();
});
const sessionDetailBackBtn = document.getElementById("sessionDetailBackBtn");
if (sessionDetailBackBtn) sessionDetailBackBtn.onclick = () => backFromSubview();
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
    empty.style.display = "";
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
  let proj;
  try { proj = await window.electronAPI.ensureProject(projectDetailState.cwd); }
  catch (e) { return showToast(`Could not register project: ${e}`); }
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
  if (anyMerged) { if (typeof renderProjectsList === "function") renderProjectsList(); refreshDashboard(); }
  else if (_deadPaths.size) { if (typeof renderProjectsList === "function") renderProjectsList(); }
}

// ── Stats rendering ───────────────────────────────────────────────────────────
// Home + Statistics views are migrated to src/views/. Their DOM containers
// (#stats-content / #statistics-content) only exist while the respective view
// is mounted, so we re-query on every call.
function getStatisticsContent() {
  return document.getElementById("statistics-content");
}

/** Re-render the statistics view and nudge the migrated home view. */
function refreshDashboard() {
  if (!lastHistory) return;
  renderHistory(lastHistory);
  const c = getStatisticsContent();
  if (c) wireProjectListClicks(c, refreshDashboard);
  window.dispatchEvent(new CustomEvent("refresh-dashboard-home"));
}


function renderHistory(history) {
  lastHistory = history;
  const c = getStatisticsContent();
  if (!c) return;
  if (!history || history.length === 0) {
    c.innerHTML = `<div class="no-data">No history recorded yet.<br><small style="font-size:0.8rem">Data appears after the first successful refresh.</small></div>`;
    return;
  }
  renderStatistics(history);
}

/** Pin state helpers ─────────────────────────────────────────────────────── */
function getPinnedSet() {
  const arr = (currentSettings && Array.isArray(currentSettings.pinnedCards))
    ? currentSettings.pinnedCards : [];
  return new Set(arr);
}
function isPinned(id) { return getPinnedSet().has(id); }
function setPinned(id, on) {
  const set = getPinnedSet();
  if (on) set.add(id); else set.delete(id);
  currentSettings.pinnedCards = Array.from(set);
  window.electronAPI?.saveSettings(currentSettings);
}
function togglePin(id) { setPinned(id, !isPinned(id)); refreshDashboard(); }

/** Build the pinned cards block for the Home view. */
function buildPinnedCardsHTML(history) {
  const pinned = getPinnedSet();
  if (!pinned.size) return "";

  const latest = history[history.length - 1];
  const SESSION_MS = 5 * 3_600_000;
  const WEEK_MS = 7 * 24 * 3_600_000;

  const sessionEndMs = latest.session_resets_at
    ? new Date(latest.session_resets_at).getTime()
    : Date.now() + 3_600_000;
  const weeklyEndMs = latest.weekly_resets_at
    ? new Date(latest.weekly_resets_at).getTime()
    : Date.now() + 3_600_000;
  const weeklyStartMs = weeklyEndMs - WEEK_MS;

  const shiftedSessionEndMs = sessionEndMs - sessionPageOffset * SESSION_MS;
  const shiftedSessionStartMs = shiftedSessionEndMs - SESSION_MS;
  const hasSessionPrev = history.some((r) => { const t = hourToMs(r.hour); return t >= shiftedSessionStartMs - SESSION_MS && t < shiftedSessionStartMs; });

  const shiftedWeeklyEndMs = weeklyEndMs - weeklyPageOffset * WEEK_MS;
  const shiftedWeeklyStartMs = weeklyStartMs - weeklyPageOffset * WEEK_MS;
  const hasWeeklyPrev = history.some((r) => { const t = hourToMs(r.hour); return t >= shiftedWeeklyStartMs - WEEK_MS && t < shiftedWeeklyStartMs; });

  const legendItem = (elId, color, isDashed, label) => {
    const key = elId.replace(/^legend-/, "");
    const dot = isDashed
      ? `<span style="display:inline-block;width:14px;height:2px;background:${color};vertical-align:middle;margin-right:4px;border-radius:1px;border-top:2px dashed ${color};"></span>`
      : `<span class="legend-dot" style="background:${color}"></span>`;
    return `<span data-legend="${key}" style="cursor:pointer">${dot}${label}</span>`;
  };

  const parts = [];
  if (pinned.has("today")) {
    parts.push(buildTodaySectionHTML(lastTokenHistory, { pinnable: true }));
  }
  if (pinned.has("session")) {
    parts.push(buildGraphCard({
      id: "session", history, startMs: shiftedSessionStartMs, endMs: shiftedSessionEndMs,
      lineKey: "s", pctKey: "s",
      pageOffset: sessionPageOffset, hasPrev: hasSessionPrev,
      prevId: "prev-session", nextId: "next-session",
      pageLabel: sessionPageOffset === 0 ? "This session" : `${sessionPageOffset} session${sessionPageOffset > 1 ? "s" : ""} ago`,
      legends: [legendItem("legend-session", "#9d7dfc", false, "Session"), legendItem("legend-expected", "#6b6990", true, "Expected")],
      maxItems: 5, pinnable: true,
    }));
  }
  if (pinned.has("weekly")) {
    parts.push(buildGraphCard({
      id: "weekly", history, startMs: shiftedWeeklyStartMs, endMs: shiftedWeeklyEndMs,
      lineKey: "w", pctKey: "w",
      pageOffset: weeklyPageOffset, hasPrev: hasWeeklyPrev,
      prevId: "prev-weekly", nextId: "next-weekly",
      pageLabel: weeklyPageOffset === 0 ? "This week" : `${weeklyPageOffset}w ago`,
      legends: [legendItem("legend-weekly", "#6e8fff", false, "Weekly"), legendItem("legend-expected", "#6b6990", true, "Expected")],
      maxItems: 5, pinnable: true,
    }));
  }
  if (!parts.length) return "";
  return `<div class="pinned-cards">${parts.join("")}</div>`;
}

/** Wire pin buttons inside a container. onHomeUnpin=true shows undo toast on unpin. */
function wirePinButtons(container, opts = {}) {
  if (!container) return;
  container.querySelectorAll(".pin-btn").forEach((btn) => {
    if (btn._wired) return;
    btn._wired = true;
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.pinId;
      if (!id) return;
      const wasPinned = isPinned(id);
      setPinned(id, !wasPinned);
      if (opts.onHomeUnpin && wasPinned) {
        showUndoToast(`Unpinned ${pinLabel(id)}`, () => { setPinned(id, true); refreshDashboard(); });
      }
      refreshDashboard();
    };
  });
}

function pinLabel(id) {
  if (id === "session") return "Session graph";
  if (id === "weekly") return "Weekly graph";
  if (id === "today") return "Today";
  return id;
}

/** Toast with undo button. Auto-dismiss after 5s. */
function showUndoToast(message, onUndo) {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<span class="toast-msg"></span><button class="toast-undo btn-secondary">Undo</button>`;
  toast.querySelector(".toast-msg").textContent = message;
  const undoBtn = toast.querySelector(".toast-undo");
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 250);
  };
  undoBtn.onclick = () => { onUndo && onUndo(); finish(); };
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(finish, 5000);
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

  const legendItem = (id, color, isDashed, label) => {
    const key = id.replace(/^legend-/, "");
    const dot = isDashed
      ? `<span style="display:inline-block;width:14px;height:2px;background:${color};vertical-align:middle;margin-right:4px;border-radius:1px;border-top:2px dashed ${color};"></span>`
      : `<span class="legend-dot" style="background:${color}"></span>`;
    return `<span data-legend="${key}" style="cursor:pointer">${dot}${label}</span>`;
  };

  const statisticsContent = getStatisticsContent();
  if (!statisticsContent) return;
  statisticsContent.innerHTML = `
    ${buildTodaySectionHTML(lastTokenHistory, { pinnable: true })}
    ${buildGraphCard({
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
      pinnable: true,
    })}
    ${buildGraphCard({
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
      pinnable: true,
    })}
  `;

  setupLegendToggles();
  applyLineVisibility();
  setupPaginationButtons();
  wireChartModeToggles(statisticsContent);
  wirePinButtons(statisticsContent, { onHomeUnpin: false });
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
    if (!Array.isArray(s.pinnedCards)) s.pinnedCards = [];
    currentSettings = s;
  }
  _initSettings = true;
  tryInitialRender();
  syncProjectsSortFromSettings();
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

  const mkBucket = (key) => ({ cwd: key, tokens_7d: 0, live: 0, anyRemote: false, anyAutomated: false, lastActiveMs: 0 });
  const bump = (bucket, iso) => {
    if (!iso) return;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms) && ms > bucket.lastActiveMs) bucket.lastActiveMs = ms;
  };

  const byPath = new Map();
  for (const rec of tokenHistory) {
    const key = rec.cwd || "(unknown)";
    const bucket = byPath.get(key) || mkBucket(key);
    bucket.tokens_7d += (rec.inputTokens || 0) + (rec.outputTokens || 0);
    bump(bucket, rec.lastActiveAt || rec.startedAt);
    byPath.set(key, bucket);
  }

  for (const p of projects) {
    const existing = byPath.get(p.path) || mkBucket(p.path);
    existing.name = p.name;
    existing.avatar = p.avatar;
    existing.projectId = p.id;
    existing.anyAutomated = existing.anyAutomated || !!p.automation?.enabled;
    bump(existing, p.last_active_at);
    byPath.set(p.path, existing);
  }

  for (const inst of liveInstances) {
    const key = inst.cwd;
    const existing = byPath.get(key) || mkBucket(key);
    existing.live = (existing.live || 0) + 1;
    existing.anyRemote = existing.anyRemote || inst.is_remote;
    existing.anyAutomated = existing.anyAutomated || inst.kind === "automated";
    bump(existing, inst.started_at);
    existing.lastActiveMs = Math.max(existing.lastActiveMs, Date.now());
    byPath.set(key, existing);
  }

  const settingsForSort = (await window.electronAPI?.getSettings?.()) || {};
  const sortBy = settingsForSort.projects_sort_by || "recent";
  const nameOf = (e) => (e.name || basenameProj(e.cwd) || "").toLowerCase();
  const entries = [...byPath.values()].sort((a, b) => {
    switch (sortBy) {
      case "name":
        return nameOf(a).localeCompare(nameOf(b));
      case "live":
        if ((b.live || 0) !== (a.live || 0)) return (b.live || 0) - (a.live || 0);
        return (b.lastActiveMs || 0) - (a.lastActiveMs || 0);
      case "tokens":
        return (b.tokens_7d || 0) - (a.tokens_7d || 0);
      case "recent":
      default:
        return (b.lastActiveMs || 0) - (a.lastActiveMs || 0);
    }
  });

  const container = document.getElementById("projects-list");
  const empty = document.getElementById("projects-empty");
  if (!container || !empty) return;
  if (entries.length === 0) {
    container.innerHTML = "";
    empty.style.display = "block";
    if (typeof setupBackfillBtn === "function") setupBackfillBtn();
    return;
  }
  empty.style.display = "none";

  container.innerHTML = entries.map((e) => projectCardHtml(e)).join("");
  container.querySelectorAll(".project-card").forEach((el) => {
    el.onclick = () => openProjectDetail(el.dataset.cwd);
  });

  if (typeof setupBackfillBtn === "function") setupBackfillBtn();
}

function projectCardHtml(entry) {
  const displayName = entry.name || basenameProj(entry.cwd);
  const avatar = renderAvatar(entry.avatar);
  const tokens = formatCompactTokens(entry.tokens_7d || 0);
  const lastSeen = entry.lastActiveMs
    ? (typeof timeAgo === "function" ? timeAgo(new Date(entry.lastActiveMs).toISOString()) : "")
    : "";
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
        <div class="tokens">${tokens} tokens${lastSeen ? ` · ${lastSeen}` : ""}</div>
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
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
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

  const stats = await Promise.all(
    instances.map((i) => window.electronAPI.instanceTokenStats(i.session_id)),
  );
  listEl.innerHTML = instances.map((i, idx) => instanceRowHtml(i, stats[idx])).join("");
  listEl.querySelectorAll(".instance-row").forEach((row) => {
    const sid = row.dataset.sessionId;
    const inst = instances.find((x) => x.session_id === sid);
    if (!inst) return;
    row.onclick = () => {
      if (typeof openSessionDetail === "function") openSessionDetail(inst, "project-detail");
    };
  });
}

function setRunningInstancesEmpty(count) {
  document.getElementById("runningInstancesCount").textContent = count;
  document.getElementById("runningInstancesList").style.display = "none";
  document.getElementById("runningInstancesEmpty").style.display = "block";
}

function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function instanceRowHtml(i, stats) {
  const uptime = uptimeFrom(i.started_at);
  const tokens = stats?.tokens ?? 0;
  const turns = stats?.turns ?? 0;
  const prompts = stats?.prompts ?? 0;
  const pidPart = i.pid > 0 ? `pid ${i.pid}` : "no pid";

  return `
    <div class="instance-row clickable" data-session-id="${i.session_id}">
      <div class="status-dot"></div>
      <div class="row-line">${pidPart} · up ${uptime} · ${prompts} ${prompts === 1 ? "msg" : "msgs"} · ${fmtTokens(tokens)} tokens · ${turns} ${turns === 1 ? "turn" : "turns"}</div>
      <span class="chev">›</span>
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

// ── Legacy obsidian_claude_remote import banner ───────────────────────────
async function maybeOfferLegacyImport() {
  let preview;
  try { preview = await window.electronAPI.importLegacyObsidianConfig(); }
  catch (e) { return; }
  if (!preview) return; // null = nothing to import or already handled
  const banner = document.getElementById('legacyImportBanner');
  if (!banner) return;
  banner.style.display = 'flex';
  const finish = async (accept) => {
    banner.style.display = 'none';
    try { await window.electronAPI.confirmLegacyObsidianImport(accept); }
    catch (e) { console.error('confirm_legacy_obsidian_import failed', e); }
    if (accept) showToast('Imported. See Projects.');
  };
  document.getElementById('legacyImportAccept').onclick = () => finish(true);
  document.getElementById('legacyImportDismiss').onclick = () => finish(false);
}
maybeOfferLegacyImport();

// Called after settings load.
maybeShowHookModal();
