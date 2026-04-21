"use strict";

// ── Chart state (persists across re-renders) ──────────────────────────────────
const lineVisible = { session: true, weekly: true, expected: true };
let sessionPageOffset = 0;  // 0 = current session window, 1 = one window back, etc.
let weeklyPageOffset = 0;   // 0 = current week, 1 = one week back, etc.

// Chart vs Bars toggle state per graph type
const chartMode = { session: "chart", weekly: "chart" };

// ── Chart rendering ───────────────────────────────────────────────────────────
function buildChart(history, weeklyStartMs, weeklyEndMs, lineKey, svgId) {
  const W = 420, H = 172;
  const ML = 30, MR = 8, MT = 8, MB = 42;
  const PW = W - ML - MR;
  const PH = H - MT - MB;

  const minT = weeklyStartMs;
  const maxT = weeklyEndMs;
  const tRange = maxT - minT || 1;

  function px(t) { return ML + ((t - minT) / tRange) * PW; }
  function py(v) { return MT + (1 - v / 100) * PH; }

  // Grid lines + y labels
  const gridLines = [0, 25, 50, 75, 100].map((v) => {
    const y = py(v);
    return `<line x1="${ML}" x2="${W - MR}" y1="${y}" y2="${y}" stroke="#2d2c44" stroke-width="1"/>
            <text x="${ML - 4}" y="${y + 3.5}" text-anchor="end" fill="#6b6990" font-size="10" font-family="Fira Code, monospace">${v}</text>`;
  }).join("");

  // X-axis ticks: hours for short windows (≤12h), days for longer ones
  const tickItems = [];
  const windowMs = maxT - minT;
  if (windowMs <= 12 * 3_600_000) {
    const hourMs = 3_600_000;
    const firstTick = Math.ceil(minT / hourMs) * hourMs;
    for (let t = firstTick; t <= maxT; t += hourMs) {
      const x = px(t).toFixed(1);
      const d = new Date(t);
      const hh = d.getHours().toString().padStart(2, "0");
      const mm = d.getMinutes().toString().padStart(2, "0");
      tickItems.push(
        `<line x1="${x}" x2="${x}" y1="${MT + PH}" y2="${MT + PH + 4}" stroke="#2d2c44" stroke-width="1"/>` +
        `<text x="${x}" y="${H - MB + 14}" text-anchor="middle" fill="#6b6990" font-size="10" font-family="DM Sans, system-ui">${hh}:${mm}</text>`
      );
    }
  } else {
    const cursor = new Date(minT);
    cursor.setHours(24, 0, 0, 0); // advance to first midnight after minT
    while (cursor.getTime() <= maxT) {
      const x = px(cursor.getTime()).toFixed(1);
      const dayName = cursor.toLocaleDateString("en-US", { weekday: "short" });
      const dateStr = (cursor.getMonth() + 1) + "/" + cursor.getDate();
      tickItems.push(
        `<line x1="${x}" x2="${x}" y1="${MT + PH}" y2="${MT + PH + 4}" stroke="#2d2c44" stroke-width="1"/>` +
        `<text x="${x}" y="${H - MB + 14}" text-anchor="middle" fill="#6b6990" font-size="10" font-family="DM Sans, system-ui">${dayName}</text>` +
        `<text x="${x}" y="${H - MB + 26}" text-anchor="middle" fill="#4a4870" font-size="9" font-family="DM Sans, system-ui">${dateStr}</text>`
      );
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // Reference diagonal: (weeklyStart, 0%) → (weeklyEnd, 100%)
  const refLine =
    `<line id="line-expected"` +
    ` x1="${px(minT).toFixed(1)}" y1="${py(0).toFixed(1)}"` +
    ` x2="${px(maxT).toFixed(1)}" y2="${py(100).toFixed(1)}"` +
    ` stroke="#6b6990" stroke-width="1.5" stroke-dasharray="5,4"/>`;

  // Data polylines — clamp to window bounds to prevent old records leaking outside the SVG
  const pts = history
    .map((r) => ({ t: hourToMs(r.hour), s: r.session_pct, w: r.weekly_pct }))
    .filter((p) => p.t >= minT && p.t <= maxT);

  // Extend line to the left edge: if the first data point is after window start,
  // insert a 0% anchor at the window start (session was idle before first record).
  if (pts.length && pts[0].t > minT) {
    pts.unshift({ t: minT, s: 0, w: 0 });
  }

  function makeLine(key, color, id) {
    const f = pts.filter((p) => p[key] !== null && p[key] !== undefined);
    if (f.length === 0) return `<g id="${id}"></g>`;
    if (f.length === 1) {
      return `<circle id="${id}" cx="${px(f[0].t).toFixed(1)}" cy="${py(f[0][key]).toFixed(1)}" r="2.5" fill="${color}"/>`;
    }
    const d = f.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.t).toFixed(1)},${py(p[key]).toFixed(1)}`).join(" ");
    return `<path id="${id}" d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  return (
    `<svg id="${svgId}" viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">` +
    gridLines +
    `<line x1="${ML}" x2="${ML}" y1="${MT}" y2="${MT + PH}" stroke="#2d2c44" stroke-width="1"/>` +
    tickItems.join("") +
    refLine +
    (lineKey === "s" ? makeLine("s", "#9d7dfc", "line-session") : makeLine("w", "#6e8fff", "line-weekly")) +
    `</svg>`
  );
}

// ── Line visibility ───────────────────────────────────────────────────────────
function applyLineVisibility() {
  for (const key of ["session", "weekly", "expected"]) {
    const el = document.getElementById(`line-${key}`);
    if (el) el.style.display = lineVisible[key] ? "" : "none";
    const leg = document.getElementById(`legend-${key}`);
    if (leg) leg.style.opacity = lineVisible[key] ? "1" : "0.35";
  }
}

function setupLegendToggles() {
  for (const key of ["session", "weekly", "expected"]) {
    const el = document.getElementById(`legend-${key}`);
    if (!el) continue;
    el.onclick = () => {
      lineVisible[key] = !lineVisible[key];
      applyLineVisibility();
    };
  }
}

function setupPaginationButtons() {
  const prevSession = document.getElementById("prev-session");
  const nextSession = document.getElementById("next-session");
  const prevWeekly = document.getElementById("prev-weekly");
  const nextWeekly = document.getElementById("next-weekly");
  if (prevSession) prevSession.onclick = () => { sessionPageOffset++; refreshDashboard(); };
  if (nextSession) nextSession.onclick = () => { sessionPageOffset = Math.max(0, sessionPageOffset - 1); refreshDashboard(); };
  if (prevWeekly) prevWeekly.onclick = () => { weeklyPageOffset++; refreshDashboard(); };
  if (nextWeekly) nextWeekly.onclick = () => { weeklyPageOffset = Math.max(0, weeklyPageOffset - 1); refreshDashboard(); };
}

// ── Project bars view (alternative to chart) ─────────────────────────────────
const BAR_COLORS = ["#9d7dfc", "#6e8fff", "#7af0c0", "#e67e22", "#e74c3c"];

function buildProjectBarsView(startMs, endMs, usageHistory, pctKey, maxItems, listId) {
  if (!lastTokenHistory || !lastTokenHistory.length) {
    return '<div class="no-data" style="padding:24px 0">No project data</div>';
  }

  // Gather projects active in window
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
    if (!byProject.has(key)) byProject.set(key, { cwd: key, tokens: 0 });
    byProject.get(key).tokens += totalTok(r);
  }

  const projects = Array.from(byProject.values()).sort((a, b) => b.tokens - a.tokens);
  if (!projects.length) {
    return '<div class="no-data" style="padding:24px 0">No projects in this window</div>';
  }

  // Compute % attribution from usage delta
  const pctField = pctKey === "w" ? "weekly_pct" : "session_pct";
  let totalPct = null;
  if (usageHistory && usageHistory.length) {
    const windowPts = usageHistory
      .filter((r) => r[pctField] != null)
      .map((r) => ({ t: hourToMs(r.hour), pct: r[pctField] }))
      .filter((p) => p.t >= startMs && p.t <= endMs)
      .sort((a, b) => a.t - b.t);
    if (windowPts.length >= 2) {
      totalPct = windowPts[windowPts.length - 1].pct - windowPts[0].pct;
      if (totalPct <= 0) totalPct = null;
    }
  }

  const totalTokens = projects.reduce((s, p) => s + p.tokens, 0);
  const maxTokens = projects[0].tokens;

  // Top 5, rest as "Other"
  const top = maxItems ? projects.slice(0, maxItems) : projects;
  const rest = maxItems ? projects.slice(maxItems) : [];
  const otherTokens = rest.reduce((s, p) => s + p.tokens, 0);

  const rows = top.map((p, i) => {
    const pct = totalPct !== null ? Math.round((p.tokens / totalTokens) * totalPct) : null;
    const barWidth = Math.max(2, Math.round((p.tokens / maxTokens) * 100));
    const color = BAR_COLORS[i % BAR_COLORS.length];
    return `<div class="project-bar-row">
      <span class="project-bar-label" title="${p.cwd}">${projectLabel(p.cwd)}</span>
      <div class="project-bar-track">
        <div class="project-bar-fill" style="width:${barWidth}%;background:${color}"></div>
      </div>
      <span class="project-bar-value">${pct !== null ? pct + "%" : fmtK(p.tokens)}</span>
    </div>`;
  });

  if (otherTokens > 0) {
    const pct = totalPct !== null ? Math.round((otherTokens / totalTokens) * totalPct) : null;
    const barWidth = Math.max(2, Math.round((otherTokens / maxTokens) * 100));
    rows.push(`<div class="project-bar-row">
      <span class="project-bar-label" style="color:var(--text-dim)">Other</span>
      <div class="project-bar-track">
        <div class="project-bar-fill" style="width:${barWidth}%;background:var(--text-dim)"></div>
      </div>
      <span class="project-bar-value">${pct !== null ? pct + "%" : fmtK(otherTokens)}</span>
    </div>`);

    if (listId) {
      rows.push(`<div class="project-bars-more" data-bars-list-id="${listId}">Show ${rest.length} more</div>`);
    }
  }

  const totalLabel = totalPct !== null ? `Total: ${totalPct}%` : `Total: ${fmtK(totalTokens)} tokens`;

  return `<div class="project-bars">
    ${rows.join("")}
    <div class="project-bars-total">${totalLabel}</div>
  </div>`;
}

// Store configs so the detail view can re-render the same graph with full project list
const graphDetailConfigs = {};

/**
 * Reusable graph card: chart + pagination + legend + project list.
 * @param {object} opts
 * @param {string} opts.id         - Unique key ("session" or "weekly")
 * @param {object[]} opts.history  - Usage history records
 * @param {number} opts.startMs    - Window start
 * @param {number} opts.endMs      - Window end
 * @param {string} opts.lineKey    - "s" or "w"
 * @param {string} opts.pctKey     - "s" or "w" for session/weekly pct attribution
 * @param {number} opts.pageOffset
 * @param {boolean} opts.hasPrev
 * @param {string} opts.prevId     - DOM id for prev button
 * @param {string} opts.nextId     - DOM id for next button
 * @param {string} opts.pageLabel  - e.g. "This session", "1 session ago"
 * @param {string[]} opts.legends  - Legend HTML items
 * @param {number|null} opts.maxItems - Max projects to show (null = unlimited)
 * @returns {string} HTML
 */
function buildGraphCard(opts) {
  const { id, history, startMs, endMs, lineKey, pctKey, pageOffset, hasPrev, prevId, nextId, pageLabel, legends, maxItems } = opts;
  const svgId = `chart-${id}`;
  const projectListId = `window-${id}-${startMs}`;
  const mode = chartMode[id] || "chart";

  // Save config for detail view
  graphDetailConfigs[projectListId] = opts;

  const chartActive = mode === "chart" ? " active" : "";
  const barsActive = mode === "bars" ? " active" : "";

  const chartContent = mode === "chart"
    ? `<div class="chart-legend">${legends.join("")}</div>
       ${buildChart(history, startMs, endMs, lineKey, svgId)}
       ${buildWindowProjectsHTML(startMs, endMs, history, pctKey, maxItems, projectListId)}`
    : buildProjectBarsView(startMs, endMs, history, pctKey, maxItems, projectListId);

  return `<div class="chart-container"${id === "session" ? ' style="margin-bottom:12px"' : ""}>
    <div class="chart-pagination">
      <button id="${prevId}" class="btn-secondary" ${hasPrev ? "" : "disabled"}>◀</button>
      <span class="chart-pagination-label">${pageLabel}</span>
      <button id="${nextId}" class="btn-secondary" ${pageOffset === 0 ? "disabled" : ""}>▶</button>
      <div class="chart-mode-toggle">
        <button class="chart-mode-btn${chartActive}" data-mode="chart" data-graph="${id}">Chart</button>
        <button class="chart-mode-btn${barsActive}" data-mode="bars" data-graph="${id}">Bars</button>
      </div>
    </div>
    ${chartContent}
  </div>`;
}

/** Open the graph detail view for a given project list. */
function openGraphDetail(listId) {
  const config = graphDetailConfigs[listId];
  if (!config) return;

  const container = document.getElementById("graph-detail-content");
  const title = document.getElementById("graphDetailTitle");
  if (!container) return;

  title.textContent = config.id === "session" ? "Session" : "Weekly";

  // Re-render the same card but with no maxItems cap
  container.innerHTML = buildGraphCard({ ...config, maxItems: null });

  // Wire up pagination within the detail view
  const prevBtn = container.querySelector(`#${config.prevId}`);
  const nextBtn = container.querySelector(`#${config.nextId}`);
  if (config.id === "session") {
    if (prevBtn) prevBtn.onclick = () => { sessionPageOffset++; renderGraphDetailFromCurrent("session"); };
    if (nextBtn) nextBtn.onclick = () => { sessionPageOffset = Math.max(0, sessionPageOffset - 1); renderGraphDetailFromCurrent("session"); };
  } else {
    if (prevBtn) prevBtn.onclick = () => { weeklyPageOffset++; renderGraphDetailFromCurrent("weekly"); };
    if (nextBtn) nextBtn.onclick = () => { weeklyPageOffset = Math.max(0, weeklyPageOffset - 1); renderGraphDetailFromCurrent("weekly"); };
  }

  wireProjectListClicks(container, refreshDashboard);
  wireChartModeToggles(container);
  showView("graph-detail");
}

/** Re-render the graph detail after pagination change, recomputing window bounds. */
function renderGraphDetailFromCurrent(type) {
  if (!lastHistory || !lastHistory.length) return;
  const latest = lastHistory[lastHistory.length - 1];
  const SESSION_MS = 5 * 3_600_000;
  const WEEK_MS = 7 * 24 * 3_600_000;

  const legendItem = (elId, color, isDashed, label) => {
    const dot = isDashed
      ? `<span style="display:inline-block;width:14px;height:2px;background:${color};vertical-align:middle;margin-right:4px;border-radius:1px;border-top:2px dashed ${color};"></span>`
      : `<span class="legend-dot" style="background:${color}"></span>`;
    return `<span id="${elId}" style="cursor:pointer">${dot}${label}</span>`;
  };

  let config;
  if (type === "session") {
    const sessionEndMs = latest.session_resets_at ? new Date(latest.session_resets_at).getTime() : Date.now() + 3_600_000;
    const shiftMs = sessionPageOffset * SESSION_MS;
    const startMs = sessionEndMs - SESSION_MS - shiftMs;
    const endMs = sessionEndMs - shiftMs;
    const hasPrev = lastHistory.some((r) => { const t = hourToMs(r.hour); return t >= startMs - SESSION_MS && t < startMs; });
    config = {
      id: "session", history: lastHistory, startMs, endMs, lineKey: "s", pctKey: "s",
      pageOffset: sessionPageOffset, hasPrev, prevId: "prev-session", nextId: "next-session",
      pageLabel: sessionPageOffset === 0 ? "This session" : `${sessionPageOffset} session${sessionPageOffset > 1 ? "s" : ""} ago`,
      legends: [legendItem("legend-session", "#9d7dfc", false, "Session"), legendItem("legend-expected", "#6b6990", true, "Expected")],
      maxItems: null,
    };
  } else {
    const weeklyEndMs = latest.weekly_resets_at ? new Date(latest.weekly_resets_at).getTime() : Date.now() + 3_600_000;
    const weeklyStartMs = weeklyEndMs - WEEK_MS;
    const shiftMs = weeklyPageOffset * WEEK_MS;
    const startMs = weeklyStartMs - shiftMs;
    const endMs = weeklyEndMs - shiftMs;
    const hasPrev = lastHistory.some((r) => { const t = hourToMs(r.hour); return t >= startMs - WEEK_MS && t < startMs; });
    config = {
      id: "weekly", history: lastHistory, startMs, endMs, lineKey: "w", pctKey: "w",
      pageOffset: weeklyPageOffset, hasPrev, prevId: "prev-weekly", nextId: "next-weekly",
      pageLabel: weeklyPageOffset === 0 ? "This week" : `${weeklyPageOffset}w ago`,
      legends: [legendItem("legend-weekly", "#6e8fff", false, "Weekly"), legendItem("legend-expected", "#6b6990", true, "Expected")],
      maxItems: null,
    };
  }

  const container = document.getElementById("graph-detail-content");
  container.innerHTML = buildGraphCard(config);

  const prevBtn = container.querySelector(`#${config.prevId}`);
  const nextBtn = container.querySelector(`#${config.nextId}`);
  if (type === "session") {
    if (prevBtn) prevBtn.onclick = () => { sessionPageOffset++; renderGraphDetailFromCurrent("session"); };
    if (nextBtn) nextBtn.onclick = () => { sessionPageOffset = Math.max(0, sessionPageOffset - 1); renderGraphDetailFromCurrent("session"); };
  } else {
    if (prevBtn) prevBtn.onclick = () => { weeklyPageOffset++; renderGraphDetailFromCurrent("weekly"); };
    if (nextBtn) nextBtn.onclick = () => { weeklyPageOffset = Math.max(0, weeklyPageOffset - 1); renderGraphDetailFromCurrent("weekly"); };
  }

  wireProjectListClicks(container, refreshDashboard);
  wireChartModeToggles(container);
}

/** Wire chart/bars toggle buttons and bars "Show X more" links within a container. */
function wireChartModeToggles(container) {
  if (!container) return;
  container.querySelectorAll(".chart-mode-btn").forEach((btn) => {
    if (btn._wired) return;
    btn._wired = true;
    btn.onclick = () => {
      const graphId = btn.dataset.graph;
      const mode = btn.dataset.mode;
      if (chartMode[graphId] === mode) return;
      chartMode[graphId] = mode;
      if (activeView === "graph-detail") {
        renderGraphDetailFromCurrent(graphId);
      } else {
        refreshDashboard();
      }
    };
  });
  container.querySelectorAll(".project-bars-more").forEach((link) => {
    if (link._wired) return;
    link._wired = true;
    link.onclick = () => {
      const listId = link.dataset.barsListId;
      if (listId && graphDetailConfigs[listId]) {
        openGraphDetail(listId);
      }
    };
  });
}
