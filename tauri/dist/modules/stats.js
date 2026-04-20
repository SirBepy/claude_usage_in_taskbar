"use strict";

// ── Token stats helpers ────────────────────────────────────────────────────────
function fmtK(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "K";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function totalTok(r) {
  return (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);
}

function cacheEffPct(r) {
  const denom = (r.inputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);
  if (!denom) return 0;
  return Math.round((r.cacheReadTokens || 0) / denom * 100);
}

function projectLabel(cwd) {
  const alias = currentSettings.projectAliases?.[cwd];
  const fallback = cwd ? cwd.split(/[/\\]/).filter(Boolean).pop() || cwd : "(unknown)";
  if (!alias) return fallback;
  const name = alias.name || fallback;
  // backward compat: old saves stored emoji separately
  const emoji = alias.emoji || "";
  return emoji && !name.startsWith(emoji) ? `${emoji} ${name}` : name;
}

function isSubagentCwd(cwd) {
  return cwd && /[/\\]\.claude[/\\]subagents[/\\]/i.test(cwd);
}

function resolveCwd(cwd) {
  return resolveMergeChain(cwd, currentSettings.projectAliases || {});
}

function isBlacklisted(cwd) {
  const bl = currentSettings.projectBlacklist;
  if (!bl || !bl.length) return false;
  return bl.includes(resolveCwd(cwd));
}

function doHideProject(cwd) {
  if (!currentSettings.projectBlacklist) currentSettings.projectBlacklist = [];
  const resolved = resolveCwd(cwd);
  if (!currentSettings.projectBlacklist.includes(resolved)) {
    currentSettings.projectBlacklist.push(resolved);
  }
  saveSettings();
}

function resolveMergeChain(cwd, aliases) {
  let cur = cwd;
  const seen = new Set();
  while (aliases[cur]?.mergedInto && !seen.has(cur)) {
    seen.add(cur);
    cur = aliases[cur].mergedInto;
  }
  return cur;
}

function aggregateByProject(tokenHistory) {
  // Build merge map with full chain resolution (handles A→B→C and re-merges)
  const aliases = currentSettings.projectAliases || {};
  const mergeMap = new Map();
  for (const c of Object.keys(aliases)) {
    if (aliases[c]?.mergedInto) mergeMap.set(c, resolveMergeChain(c, aliases));
  }

  const map = new Map();
  for (const r of tokenHistory) {
    if (isSubagentCwd(r.cwd)) continue;
    const key = mergeMap.get(r.cwd) || r.cwd || "(unknown)";
    if (isBlacklisted(key)) continue;
    if (!map.has(key)) map.set(key, { cwd: key, sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 0, lastDate: "" });
    const p = map.get(key);
    p.sessions++;
    p.inputTokens += r.inputTokens || 0;
    p.outputTokens += r.outputTokens || 0;
    p.cacheReadTokens += r.cacheReadTokens || 0;
    p.cacheCreationTokens += r.cacheCreationTokens || 0;
    p.turns += r.turns || 0;
    const ts = r.lastActiveAt || r.recordedAt || r.date || "";
    if (ts > p.lastDate) p.lastDate = ts;
  }
  return Array.from(map.values());
}

// ── Reusable project list component ────────────────────────────────────────────

// Per-list sort state, keyed by list id
const listSortState = {};

/**
 * Renders a project list as a stats-table (same look as Token Stats page).
 *
 * @param {object}   opts
 * @param {string}   opts.title       - Section heading
 * @param {object[]} opts.projects    - Array of { cwd, tokens, lastActiveAt, sessionPct? }
 * @param {number}  [opts.maxItems]   - Cap visible rows; shows "Show all" button if exceeded
 * @param {boolean} [opts.showTime]   - Show the "Last active" column (default true)
 * @param {boolean} [opts.showPct]    - Show the "Session %" column (default false)
 * @param {boolean} [opts.sortable]   - Show sortable column headers (default false)
 * @param {string}  [opts.defaultSort] - Default sort column key (default "lastActiveAt")
 * @param {string}  [opts.id]         - Unique id for the list (required if sortable)
 * @param {string}  [opts.style]      - Extra inline style on wrapper div
 * @returns {string} HTML string
 */
function buildProjectListHTML({ title, projects, maxItems, showTime = true, showPct = false, sortable = false, defaultSort = "lastActiveAt", id, style }) {
  if (!projects || !projects.length) return "";

  const containerId = id || `plist-${Math.random().toString(36).slice(2, 8)}`;

  // Init sort state for this list if needed
  if (!listSortState[containerId]) {
    listSortState[containerId] = { col: defaultSort, dir: -1 };
  }
  const ss = listSortState[containerId];

  // Build column definitions based on flags
  const cols = [{ key: "project", label: "Project" }];
  cols.push({ key: "tokens", label: "Total" });
  if (showPct) cols.push({ key: "sessionPct", label: "Session %" });
  if (showTime) cols.push({ key: "lastActiveAt", label: "Last active" });

  // Sort
  function sortVal(p, col) {
    if (col === "project") return projectLabel(p.cwd).toLowerCase();
    if (col === "tokens") return p.tokens || 0;
    if (col === "sessionPct") return p.sessionPct ?? -1;
    if (col === "lastActiveAt") return p.lastActiveAt || "";
    return 0;
  }
  const sorted = [...projects].sort((a, b) => {
    const av = sortVal(a, ss.col);
    const bv = sortVal(b, ss.col);
    return (av < bv ? -1 : av > bv ? 1 : 0) * ss.dir;
  });

  const capped = maxItems && sorted.length > maxItems;
  const visible = capped ? sorted.slice(0, maxItems) : sorted;

  // Headers
  let headerRow = "";
  if (sortable) {
    headerRow = "<thead><tr>" + cols.map((c) => {
      const arrow = ss.col === c.key ? (ss.dir === -1 ? " ↓" : " ↑") : "";
      const cls = ss.col === c.key ? " sort-active" : "";
      return `<th class="${cls}" data-sort="${c.key}" data-list="${containerId}">${c.label}${arrow}</th>`;
    }).join("") + "</tr></thead>";
  }

  const renderRow = (p) => {
    const isDead = typeof getDeadPaths === "function" && getDeadPaths().has(p.cwd);
    const deadIcon = isDead ? `<span class="dead-path-warning" title="Folder no longer exists">⚠</span> ` : "";
    return `<tr class="proj-row" data-cwd="${p.cwd}">
      <td style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${deadIcon}${projectLabel(p.cwd)}</td>
      <td class="mono">${fmtK(p.tokens)}</td>
      ${showPct ? `<td class="mono">${p.sessionPct != null ? p.sessionPct + "%" : "—"}</td>` : ""}
      ${showTime ? `<td class="mono">${timeAgo(p.lastActiveAt)}</td>` : ""}
    </tr>`;
  };

  const visibleRows = visible.map(renderRow).join("");

  const remaining = sorted.length - visible.length;
  const showMoreBtn = capped
    ? `<div style="display:flex;justify-content:center;padding-top:8px">
         <button class="btn-secondary show-more-btn" data-list-id="${containerId}" style="font-size:0.72rem;padding:2px 10px">Show ${remaining} more</button>
       </div>`
    : "";

  return `<div class="today-section" ${style ? `style="${style}"` : ""}>
    ${title ? `<div style="font-size:0.92rem;font-weight:700;margin-bottom:10px">${title}</div>` : ""}
    <table class="stats-table">
      ${headerRow}
      <tbody>${visibleRows}</tbody>
    </table>
    ${showMoreBtn}
  </div>`;
}

/** Wire click handlers for project list rows, show-all buttons, and sort headers. */
function wireProjectListClicks(container, onSort) {
  if (!container) return;
  container.querySelectorAll(".proj-row").forEach((row) => {
    if (row.dataset.cwd && !row._wired) {
      row._wired = true;
      row.onclick = () => openProjectDetail(row.dataset.cwd);
    }
  });
  container.querySelectorAll(".show-more-btn").forEach((btn) => {
    if (btn._wired) return;
    btn._wired = true;
    btn.onclick = () => {
      const listId = btn.dataset.listId;
      if (listId && typeof graphDetailConfigs !== "undefined" && graphDetailConfigs[listId]) {
        openGraphDetail(listId);
      }
    };
  });
  container.querySelectorAll("th[data-sort][data-list]").forEach((th) => {
    if (th._wired) return;
    th._wired = true;
    th.onclick = () => {
      const listId = th.dataset.list;
      const col = th.dataset.sort;
      const ss = listSortState[listId];
      if (!ss) return;
      ss.col === col ? (ss.dir *= -1) : (ss.col = col, ss.dir = -1);
      if (onSort) onSort(listId);
    };
  });
}

// ── Today summary ──────────────────────────────────────────────────────────────
function buildTodaySectionHTML(tokenHistory) {
  if (!tokenHistory || !tokenHistory.length) return "";
  const today = new Date().toISOString().slice(0, 10);
  const todayRecords = tokenHistory.filter((r) => r.date === today);
  if (!todayRecords.length) return "";

  const byProject = new Map();
  for (const r of todayRecords) {
    const key = r.cwd || "(unknown)";
    if (isBlacklisted(key)) continue;
    if (!byProject.has(key)) byProject.set(key, { cwd: key, tokens: 0, lastActiveAt: "" });
    const p = byProject.get(key);
    p.tokens += totalTok(r);
    const ts = r.lastActiveAt || r.recordedAt || r.date || "";
    if (ts > p.lastActiveAt) p.lastActiveAt = ts;
  }

  return buildProjectListHTML({
    title: "Today",
    projects: Array.from(byProject.values()),
    sortable: true,
    defaultSort: "lastActiveAt",
    id: "today-projects",
  });
}

/**
 * Build HTML listing projects active during a given time window.
 * Uses overlap check: session overlaps [startMs, endMs] if it started before the
 * window ends AND was last active after the window starts.
 *
 * @param {number}   startMs        - Window start (epoch ms)
 * @param {number}   endMs          - Window end (epoch ms)
 * @param {object[]} [usageHistory] - Usage history records
 * @param {string}   [pctKey="s"]   - "s" for session_pct, "w" for weekly_pct
 */
function buildWindowProjectsHTML(startMs, endMs, usageHistory, pctKey = "s", maxItems = 5, listId = null) {
  if (!lastTokenHistory || !lastTokenHistory.length) return "";

  const byProject = new Map();
  for (const r of lastTokenHistory) {
    const endTs = r.lastActiveAt || "";
    const startTs = r.startedAt || "";
    if (!endTs) continue;

    const sessionEndMs = new Date(endTs).getTime();
    if (isNaN(sessionEndMs)) continue;

    if (startTs) {
      const sessionStartMs = new Date(startTs).getTime();
      if (isNaN(sessionStartMs)) continue;
      if (sessionStartMs >= endMs || sessionEndMs <= startMs) continue;
    } else {
      if (sessionEndMs < startMs || sessionEndMs > endMs) continue;
    }

    const key = r.cwd || "(unknown)";
    if (isBlacklisted(key)) continue;
    if (!byProject.has(key)) byProject.set(key, { cwd: key, tokens: 0, lastActiveAt: "" });
    const p = byProject.get(key);
    p.tokens += totalTok(r);
    if (endTs > p.lastActiveAt) p.lastActiveAt = endTs;
  }

  // Compute session % attribution from usage history delta
  const projects = Array.from(byProject.values());
  let hasPct = false;
  if (usageHistory && usageHistory.length && projects.length) {
    const pctField = pctKey === "w" ? "weekly_pct" : "session_pct";
    const windowPts = usageHistory
      .filter((r) => r[pctField] != null)
      .map((r) => ({ t: hourToMs(r.hour), pct: r[pctField] }))
      .filter((p) => p.t >= startMs && p.t <= endMs)
      .sort((a, b) => a.t - b.t);

    if (windowPts.length >= 2) {
      const delta = windowPts[windowPts.length - 1].pct - windowPts[0].pct;
      if (delta > 0) {
        const totalTokens = projects.reduce((s, p) => s + p.tokens, 0);
        if (totalTokens > 0) {
          hasPct = true;
          for (const p of projects) {
            p.sessionPct = Math.round((p.tokens / totalTokens) * delta);
          }
        }
      }
    }
  }

  return buildProjectListHTML({
    title: "Worked on",
    projects,
    maxItems: maxItems,
    showTime: false,
    showPct: hasPct,
    sortable: true,
    defaultSort: hasPct ? "sessionPct" : "tokens",
    id: listId || `window-${startMs}`,
    style: "margin-top:2px;margin-bottom:8px",
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const now = Date.now();
  // Support "YYYY-MM-DDTHH" or "YYYY-MM-DDTHH:MM" by converting to local time
  let then;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}(:\d{2})?$/.test(dateStr)) {
    then = hourToMs(dateStr);
  } else {
    then = new Date(dateStr).getTime();
  }
  if (isNaN(then)) return "—";
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// ── Stats view ─────────────────────────────────────────────────────────────────
function renderStats(tokenHistory) {
  const container = document.getElementById("stats-table-container");
  if (!container) return;

  if (!tokenHistory || !tokenHistory.length) {
    container.innerHTML = `<div class="no-data">No sessions recorded yet.<br><small style="font-size:0.8rem">Use ↺ Rebuild History to import past sessions.</small></div>`;
    setupBackfillBtn();
    return;
  }

  const projects = aggregateByProject(tokenHistory).map((p) => ({
    cwd: p.cwd,
    tokens: totalTok(p),
    lastActiveAt: p.lastDate,
  }));

  const blacklist = currentSettings.projectBlacklist || [];
  const hiddenSection = blacklist.length
    ? `<div class="today-section" style="margin-top:12px">
        <div style="font-size:0.78rem;color:var(--text-dim);margin-bottom:6px">Hidden projects (${blacklist.length})</div>
        ${blacklist.map((bl) => `<div class="hidden-proj-row">
          <span style="font-size:0.78rem;color:var(--text-dim);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${projectLabel(bl)}</span>
          <button class="btn-secondary unhide-btn" data-cwd="${bl}" style="padding:2px 8px;font-size:0.7rem;flex-shrink:0">Unhide</button>
        </div>`).join("")}
      </div>`
    : "";

  container.innerHTML = buildProjectListHTML({
    title: "",
    projects,
    sortable: true,
    defaultSort: "lastActiveAt",
    id: "stats-main",
  }) + hiddenSection;

  container.querySelectorAll(".unhide-btn").forEach((btn) => {
    btn.onclick = () => {
      const bl = currentSettings.projectBlacklist;
      if (bl) currentSettings.projectBlacklist = bl.filter((c) => c !== btn.dataset.cwd);
      saveSettings();
      renderStats(lastTokenHistory);
    };
  });
  wireProjectListClicks(container, () => renderStats(lastTokenHistory));
  setupBackfillBtn();
}

function setupBackfillBtn() {
  const btn = document.getElementById("backfillBtn");
  const status = document.getElementById("backfill-status");
  if (!btn || btn._hooked) return;
  btn._hooked = true;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Scanning...";
    if (status) { status.style.display = "block"; status.textContent = "This may take a while…"; }
    try {
      const result = await window.electronAPI?.backfillTranscripts();
      const msg = result ? `Done — ${result.processed} new, ${result.skipped} skipped` : "Done";
      if (status) status.textContent = msg;
      lastTokenHistory = await window.electronAPI?.getTokenHistory();
      renderStats(lastTokenHistory);
    } catch (e) {
      if (status) status.textContent = "Error: " + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "↺ Rebuild History";
    }
  };
}

// ── Merge helpers ──────────────────────────────────────────────────────────────
function doMerge(fromCwd, intoCwd) {
  if (!currentSettings.projectAliases) currentSettings.projectAliases = {};
  const aliases = currentSettings.projectAliases;
  // Transfer any pre-existing mergedPaths on fromCwd to intoCwd and repoint their mergedInto
  const inheritedPaths = aliases[fromCwd]?.mergedPaths || [];
  aliases[fromCwd] = { mergedInto: intoCwd };
  if (!aliases[intoCwd]) aliases[intoCwd] = {};
  if (!aliases[intoCwd].mergedPaths) aliases[intoCwd].mergedPaths = [];
  if (!aliases[intoCwd].mergedPaths.includes(fromCwd)) aliases[intoCwd].mergedPaths.push(fromCwd);
  for (const p of inheritedPaths) {
    if (!aliases[intoCwd].mergedPaths.includes(p)) aliases[intoCwd].mergedPaths.push(p);
    if (aliases[p]) aliases[p].mergedInto = intoCwd;
  }
  saveSettings();
}

function doRepoint(oldCwd, newCwd) {
  if (!currentSettings.projectAliases) currentSettings.projectAliases = {};
  const aliases = currentSettings.projectAliases;
  // Preserve any name set on oldCwd and transfer to new primary
  const oldName = aliases[oldCwd]?.name;
  const inheritedPaths = aliases[oldCwd]?.mergedPaths || [];
  aliases[oldCwd] = { mergedInto: newCwd };
  if (!aliases[newCwd]) aliases[newCwd] = {};
  if (oldName && !aliases[newCwd].name) aliases[newCwd].name = oldName;
  if (!aliases[newCwd].mergedPaths) aliases[newCwd].mergedPaths = [];
  if (!aliases[newCwd].mergedPaths.includes(oldCwd)) aliases[newCwd].mergedPaths.push(oldCwd);
  for (const p of inheritedPaths) {
    if (!aliases[newCwd].mergedPaths.includes(p)) aliases[newCwd].mergedPaths.push(p);
    if (aliases[p]) aliases[p].mergedInto = newCwd;
  }
  saveSettings();
}

function doUnmerge(secondaryCwd, primaryCwd) {
  const aliases = currentSettings.projectAliases;
  if (!aliases) return;
  delete aliases[secondaryCwd];
  if (aliases[primaryCwd]?.mergedPaths) {
    aliases[primaryCwd].mergedPaths = aliases[primaryCwd].mergedPaths.filter((p) => p !== secondaryCwd);
    if (!aliases[primaryCwd].mergedPaths.length) delete aliases[primaryCwd].mergedPaths;
  }
  saveSettings();
}

function showMergeModal(text, onConfirm, onCancel, _confirmLabel) {
  if (window.confirm(text)) onConfirm();
  else if (onCancel) onCancel();
}

function renderMergedPathsSection(cwd) {
  const el = document.getElementById("project-merged-paths");
  if (!el) return;
  const aliases = currentSettings.projectAliases || {};
  const mergedPaths = aliases[cwd]?.mergedPaths || [];
  if (!mergedPaths.length) { el.innerHTML = ""; return; }
  const rows = mergedPaths.map((p) => `
    <div class="merged-path-row">
      <span class="merged-path-text" title="${p}">${p}</span>
      <button class="btn-secondary unmerge-btn" data-path="${p}" style="padding:2px 8px;font-size:0.7rem;flex-shrink:0">Unmerge</button>
    </div>`).join("");
  el.innerHTML = `<div class="section" style="padding:8px 14px;margin-top:0">
    <div class="section-title" style="font-size:0.72rem;margin-bottom:6px">Merged Paths</div>
    ${rows}
  </div>`;
  el.querySelectorAll(".unmerge-btn").forEach((btn) => {
    btn.onclick = () => {
      doUnmerge(btn.dataset.path, cwd);
      renderMergedPathsSection(cwd);
      renderProjectDetail();
      renderStats(lastTokenHistory);
    };
  });
}

// ── Project detail ──────────────────────────────────────────────────────────────
function openProjectDetail(cwd) {
  projectDetailState.cwd = cwd;
  projectDetailState.offset = 0;
  const title = document.getElementById("projectDetailTitle");
  const titleInput = document.getElementById("projectDetailTitleInput");
  if (title) title.textContent = projectLabel(cwd);
  const pathEl = document.getElementById("projectDetailPath");
  const pathInput = document.getElementById("projectDetailPathInput");
  const pathError = document.getElementById("projectDetailPathError");
  if (pathEl) {
    pathEl.textContent = cwd || "";
    pathEl.style.display = "";
  }
  if (pathInput) pathInput.style.display = "none";
  if (pathError) { pathError.style.display = "none"; pathError.textContent = ""; }

  // Inline repoint: click path to change root folder
  if (pathEl && pathInput) {
    pathEl.onclick = () => {
      pathInput.value = cwd || "";
      pathEl.style.display = "none";
      pathInput.style.display = "";
      if (pathError) { pathError.style.display = "none"; pathError.textContent = ""; }
      pathInput.focus();
      pathInput.select();
    };
    const cancelRepoint = () => {
      pathInput.style.display = "none";
      pathEl.style.display = "";
      if (pathError) { pathError.style.display = "none"; pathError.textContent = ""; }
    };
    const commitRepoint = async () => {
      const newCwd = pathInput.value.trim();
      if (!newCwd || newCwd === cwd) { cancelRepoint(); return; }
      const showErr = (msg) => {
        if (!pathError) return;
        pathError.textContent = msg;
        pathError.style.display = "block";
      };
      // Block repointing onto an existing primary that already has usage
      const aliases = currentSettings.projectAliases || {};
      const existingAlias = aliases[newCwd];
      if (existingAlias?.mergedInto) { showErr("Target is already merged into another project."); return; }
      const targetUsed = lastTokenHistory?.some((r) => r.cwd === newCwd);
      if (targetUsed) { showErr("Target folder is already a tracked project. Rename to merge instead."); return; }
      try {
        const existsMap = await window.electronAPI?.checkPathsExist([newCwd]);
        if (!existsMap || !existsMap[newCwd]) { showErr("Folder does not exist on disk."); return; }
      } catch (e) { showErr("Could not verify folder: " + e.message); return; }
      doRepoint(cwd, newCwd);
      renderStats(lastTokenHistory);
      openProjectDetail(newCwd);
    };
    pathInput.onblur = () => {
      // Defer so a click on an error message doesn't cancel prematurely
      setTimeout(() => { if (pathInput.style.display !== "none") commitRepoint(); }, 0);
    };
    pathInput.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); commitRepoint(); }
      if (e.key === "Escape") { e.preventDefault(); cancelRepoint(); }
    };
  }

  // Inline rename: click title to edit
  if (title && titleInput) {
    title.onclick = () => {
      titleInput.value = projectLabel(cwd);
      title.style.display = "none";
      titleInput.style.display = "";
      titleInput.focus();
      titleInput.select();
    };
    const commitRename = () => {
      const name = titleInput.value.trim();
      titleInput.style.display = "none";
      title.style.display = "";
      if (!name) return;
      if (!currentSettings.projectAliases) currentSettings.projectAliases = {};
      const aliases = currentSettings.projectAliases;
      // Build set of all primary cwds (from token history resolved to primaries + alias-only primaries)
      const primaryCwds = new Set();
      if (lastTokenHistory) {
        for (const r of lastTokenHistory) {
          if (!r.cwd) continue;
          primaryCwds.add(resolveMergeChain(r.cwd, aliases));
        }
      }
      for (const [c, a] of Object.entries(aliases)) {
        if (a && !a.mergedInto) primaryCwds.add(c);
      }
      // Check for name collision with another primary project
      let collisionCwd = null;
      for (const existingCwd of primaryCwds) {
        if (existingCwd === cwd) continue;
        if (projectLabel(existingCwd) === name) { collisionCwd = existingCwd; break; }
      }
      if (collisionCwd) {
        showMergeModal(
          `"${name}" already exists. Merge this project into it?`,
          () => {
            doMerge(cwd, collisionCwd);
            renderStats(lastTokenHistory);
            openProjectDetail(collisionCwd);
          },
          () => {
            title.style.display = "none";
            titleInput.style.display = "";
            titleInput.focus();
            titleInput.select();
          }
        );
      } else {
        aliases[cwd] = { ...aliases[cwd], name };
        saveSettings();
        title.textContent = projectLabel(cwd);
        renderStats(lastTokenHistory);
      }
    };
    titleInput.onblur = commitRename;
    titleInput.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
      if (e.key === "Escape") { titleInput.value = projectLabel(cwd); titleInput.blur(); }
    };
  }

  // Open project buttons
  const explorerBtn = document.getElementById("openExplorerBtn");
  const vscodeBtn = document.getElementById("openVSCodeBtn");
  const hideBtn = document.getElementById("hideProjectBtn");
  if (explorerBtn) explorerBtn.onclick = () => window.electronAPI.openInExplorer(cwd);
  if (vscodeBtn) vscodeBtn.onclick = () => window.electronAPI.openInVSCode(cwd);
  if (hideBtn) {
    hideBtn.onclick = () => {
      showMergeModal(
        `Hide "${projectLabel(cwd)}" from the list? You can unhide it later in settings.`,
        () => {
          doHideProject(cwd);
          renderStats(lastTokenHistory);
          showView("stats");
        },
        null,
        "Hide"
      );
    };
  }

  renderMergedPathsSection(cwd);
  renderProjectDetail();
  showView("stats-project");
}

function renderProjectDetail() {
  const { cwd, range, offset } = projectDetailState;
  const chartContainer = document.getElementById("project-chart-container");
  if (!chartContainer || !lastTokenHistory) return;

  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === range);
  });

  const mergedPaths = currentSettings.projectAliases?.[cwd]?.mergedPaths || [];
  const allCwds = new Set([cwd, ...mergedPaths]);
  let records = lastTokenHistory.filter((r) => allCwds.has(r.cwd));
  if (range !== "all") {
    const days = range === "7d" ? 7 : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    records = records.filter((r) => r.date >= cutoffStr);
  }

  const byDate = new Map();
  for (const r of records) {
    const d = r.date || "unknown";
    byDate.set(d, (byDate.get(d) || 0) + totalTok(r));
  }

  const sortedDays = Array.from(byDate.entries())
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const prevBtn = document.getElementById("chartPrevBtn");
  const nextBtn = document.getElementById("chartNextBtn");

  if (!sortedDays.length) {
    chartContainer.innerHTML = `<div class="no-data">No activity in this period</div>`;
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    renderSessionsList(cwd, range);
    return;
  }

  const BARS = 10;
  const endIdx = sortedDays.length - offset * BARS;
  const startIdx = Math.max(0, endIdx - BARS);
  const visible = sortedDays.slice(startIdx, endIdx);

  if (prevBtn) prevBtn.disabled = startIdx === 0;
  if (nextBtn) nextBtn.disabled = offset === 0;

  chartContainer.innerHTML = buildBarChartSVG(visible);
  renderSessionsList(cwd, range);
}

function buildBarChartSVG(days) {
  if (!days.length) return `<div class="no-data">No data</div>`;

  const W = 420, H = 160;
  const ML = 40, MR = 8, MT = 8, MB = 36;
  const PW = W - ML - MR;
  const PH = H - MT - MB;

  const maxTok = Math.max(...days.map((d) => d.tokens), 1);
  const spacing = PW / days.length;
  const barW = Math.max(4, spacing - 3);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    const val = frac * maxTok;
    const y = MT + (1 - frac) * PH;
    return `<line x1="${ML}" x2="${W - MR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2d2c44" stroke-width="1"/>
      <text x="${ML - 4}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="#6b6990" font-size="9" font-family="Fira Code,monospace">${fmtK(Math.round(val))}</text>`;
  }).join("");

  const bars = days.map((d, i) => {
    const x = ML + i * spacing + (spacing - barW) / 2;
    const barH = Math.max(1, (d.tokens / maxTok) * PH);
    const y = MT + PH - barH;
    const label = d.date.slice(5); // MM-DD
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="#9d7dfc" opacity="0.85"/>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(H - MB + 14).toFixed(1)}" text-anchor="middle" fill="#6b6990" font-size="9" font-family="DM Sans,system-ui">${label}</text>`;
  }).join("");

  return `<div class="chart-container"><svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
    ${yTicks}
    <line x1="${ML}" x2="${ML}" y1="${MT}" y2="${MT + PH}" stroke="#2d2c44" stroke-width="1"/>
    ${bars}
  </svg></div>`;
}

function renderSessionsList(cwd, range) {
  const list = document.getElementById("project-sessions-list");
  if (!list || !lastTokenHistory) return;

  const mergedPaths2 = currentSettings.projectAliases?.[cwd]?.mergedPaths || [];
  const allCwds2 = new Set([cwd, ...mergedPaths2]);
  let records = lastTokenHistory.filter((r) => allCwds2.has(r.cwd));
  if (range !== "all") {
    const days = range === "7d" ? 7 : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    records = records.filter((r) => r.date >= cutoff.toISOString().slice(0, 10));
  }

  if (!records.length) { list.innerHTML = ""; return; }

  const sorted = [...records].sort((a, b) => (a.date < b.date ? 1 : -1));
  const top = sorted.slice(0, 10);
  const rowsHTML = top.map((r) => {
    const tot = totalTok(r);
    const eff = cacheEffPct(r);
    return `<div class="today-row">
      <span style="font-family:'Fira Code',monospace;font-size:0.75rem;color:var(--text-dim)">${r.date}</span>
      <span style="font-family:'Fira Code',monospace;font-size:0.75rem">${fmtK(tot)} tok · ${r.turns || 0} turns${eff > 0 ? ` · ${eff}% cache` : ""}</span>
    </div>`;
  }).join("");

  list.innerHTML = `<div class="section" style="padding:10px 14px">
    <div class="section-title" style="margin-bottom:8px">Recent Sessions</div>
    ${rowsHTML}
    ${records.length > 10 ? `<div style="font-size:0.72rem;color:var(--text-dim);text-align:center;margin-top:6px">…and ${records.length - 10} more</div>` : ""}
  </div>`;
}
