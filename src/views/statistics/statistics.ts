import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import "./statistics.css";
import {
  getSettings,
  setSettings,
  getTokenHistory,
  getUsageHistory,
  setUsageHistory,
} from "../../shared/state";
import type { SettingsShape } from "../../shared/state";
import type { TokenRecord, AliasMap } from "../../shared/tokens";
import { fmtK, totalTok, cacheEffPct } from "../../shared/tokens";
import { hourToMs, timeAgo } from "../../shared/time";
import { projectLabel, isBlacklisted } from "../../shared/projects";

// ── Types ──────────────────────────────────────────────────────────────────

export interface UsageRecord {
  hour: string;
  session_pct: number | null;
  weekly_pct: number | null;
  session_resets_at: string | null;
  weekly_resets_at: string | null;
  [k: string]: unknown;
}

interface ElectronAPI {
  getUsageHistory(): Promise<UsageRecord[]>;
  onHistoryUpdated(cb: (h: UsageRecord[]) => void): () => void;
  saveSettings(s: SettingsShape): Promise<unknown>;
}

interface LegacyGlobals {
  electronAPI?: ElectronAPI;
  openProjectDetail?(cwd: string): void;
  showView?(name: string): void;
  activeView?: string;
  renderProjectsList?(): void;
  // Legacy back-compat - we set these below.
  renderStatistics?: (h: UsageRecord[]) => void;
  buildPinnedCardsHTML?: (h: UsageRecord[]) => string;
  wirePinButtons?: (c: HTMLElement, opts?: { onHomeUnpin?: boolean }) => void;
  wireProjectListClicks?: (c: HTMLElement, onSort?: (listId?: string) => void) => void;
  refreshDashboard?: () => void;
  setupPaginationButtons?: (container?: HTMLElement) => void;
  setupLegendToggles?: () => void;
  applyLineVisibility?: () => void;
  wireChartModeToggles?: (container: HTMLElement) => void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

// ── Chart state (module-local, persists across re-renders) ─────────────────

const lineVisible: Record<"session" | "weekly" | "expected", boolean> = {
  session: true,
  weekly: true,
  expected: true,
};
let sessionPageOffset = 0;
let weeklyPageOffset = 0;
const chartMode: Record<string, "chart" | "bars"> = {
  session: "chart",
  weekly: "chart",
};

// Element-flag shims to track wired handlers without "any" sprinkles
type Wired = Element & { _wired?: boolean; _legWired?: boolean; _pageWired?: boolean };
function wired(el: Element): Wired { return el as Wired; }

// Types for list sort state
interface ListSortState { col: string; dir: 1 | -1; }
const listSortState: Record<string, ListSortState> = {};

// Per-list project shape
interface ListProject {
  cwd: string;
  tokens: number;
  lastActiveAt?: string;
  sessionPct?: number;
}

// ── Save settings helper ──────────────────────────────────────────────────

function saveSettings(): void {
  const s = getSettings();
  void g().electronAPI?.saveSettings(s);
}

// ── Pin state ─────────────────────────────────────────────────────────────

function getPinnedSet(): Set<string> {
  const s = getSettings() as SettingsShape & { pinnedCards?: string[] };
  return new Set(Array.isArray(s.pinnedCards) ? s.pinnedCards : []);
}
function isPinned(id: string): boolean { return getPinnedSet().has(id); }
function setPinned(id: string, on: boolean): void {
  const set = getPinnedSet();
  if (on) set.add(id); else set.delete(id);
  const s = getSettings() as SettingsShape & { pinnedCards?: string[] };
  s.pinnedCards = Array.from(set);
  setSettings(s);
  saveSettings();
}

function pinLabel(id: string): string {
  if (id === "session") return "Session graph";
  if (id === "weekly") return "Weekly graph";
  if (id === "today") return "Today";
  return id;
}

function showUndoToast(message: string, onUndo: () => void): void {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<span class="toast-msg"></span><button class="toast-undo btn-secondary">Undo</button>`;
  const msgEl = toast.querySelector(".toast-msg");
  if (msgEl) msgEl.textContent = message;
  const undoBtn = toast.querySelector<HTMLButtonElement>(".toast-undo");
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 250);
  };
  if (undoBtn) undoBtn.onclick = () => { onUndo?.(); finish(); };
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(finish, 5000);
}

// ── Project label helper (reads aliases from settings) ────────────────────

function plabel(cwd: string): string {
  const aliases = (getSettings().projectAliases || {}) as AliasMap;
  return projectLabel(cwd, aliases);
}

function isBlackRef(cwd: string): boolean {
  const s = getSettings();
  return isBlacklisted(cwd, (s.projectAliases || {}) as AliasMap, s.projectBlacklist);
}

function deadPaths(): Set<string> {
  const fn = (window as unknown as { getDeadPaths?: () => Set<string> }).getDeadPaths;
  try { return fn ? fn() : new Set<string>(); } catch { return new Set<string>(); }
}

// ── Project list builder ──────────────────────────────────────────────────

interface BuildListOpts {
  title?: string;
  projects: ListProject[];
  maxItems?: number | null;
  showTime?: boolean;
  showPct?: boolean;
  sortable?: boolean;
  defaultSort?: string;
  id?: string;
  style?: string;
}

function buildProjectListHTML(opts: BuildListOpts): string {
  const {
    title, projects, maxItems, showTime = true, showPct = false,
    sortable = false, defaultSort = "lastActiveAt", id, style,
  } = opts;
  if (!projects || !projects.length) return "";

  const containerId = id || `plist-${Math.random().toString(36).slice(2, 8)}`;
  if (!listSortState[containerId]) {
    listSortState[containerId] = { col: defaultSort, dir: -1 };
  }
  const ss = listSortState[containerId]!;

  const cols: Array<{ key: string; label: string }> = [{ key: "project", label: "Project" }];
  cols.push({ key: "tokens", label: "Total" });
  if (showPct) cols.push({ key: "sessionPct", label: "Session %" });
  if (showTime) cols.push({ key: "lastActiveAt", label: "Last active" });

  const sortVal = (p: ListProject, col: string): string | number => {
    if (col === "project") return plabel(p.cwd).toLowerCase();
    if (col === "tokens") return p.tokens || 0;
    if (col === "sessionPct") return p.sessionPct ?? -1;
    if (col === "lastActiveAt") return p.lastActiveAt || "";
    return 0;
  };
  const sorted = [...projects].sort((a, b) => {
    const av = sortVal(a, ss.col);
    const bv = sortVal(b, ss.col);
    return (av < bv ? -1 : av > bv ? 1 : 0) * ss.dir;
  });

  const capped = !!(maxItems && sorted.length > maxItems);
  const visible = capped && maxItems ? sorted.slice(0, maxItems) : sorted;

  let headerRow = "";
  if (sortable) {
    headerRow = "<thead><tr>" + cols.map((c) => {
      const arrow = ss.col === c.key ? (ss.dir === -1 ? " ↓" : " ↑") : "";
      const cls = ss.col === c.key ? " sort-active" : "";
      return `<th class="${cls}" data-sort="${c.key}" data-list="${containerId}">${c.label}${arrow}</th>`;
    }).join("") + "</tr></thead>";
  }

  const dead = deadPaths();
  const renderRow = (p: ListProject): string => {
    const isDead = dead.has(p.cwd);
    const deadIcon = isDead ? `<span class="dead-path-warning" title="Folder no longer exists">⚠</span> ` : "";
    return `<tr class="proj-row" data-cwd="${p.cwd}">
      <td style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${deadIcon}${plabel(p.cwd)}</td>
      <td class="mono">${fmtK(p.tokens)}</td>
      ${showPct ? `<td class="mono">${p.sessionPct != null ? p.sessionPct + "%" : "-"}</td>` : ""}
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

// ── Today section ─────────────────────────────────────────────────────────

function buildTodaySectionHTML(tokenHistory: TokenRecord[] | null, opts: { pinnable?: boolean } = {}): string {
  if (!tokenHistory || !tokenHistory.length) return "";
  const today = new Date().toISOString().slice(0, 10);
  const todayRecords = tokenHistory.filter((r) => r.date === today);
  if (!todayRecords.length) return "";

  const byProject = new Map<string, ListProject>();
  for (const r of todayRecords) {
    const key = r.cwd || "(unknown)";
    if (isBlackRef(key)) continue;
    let p = byProject.get(key);
    if (!p) {
      p = { cwd: key, tokens: 0, lastActiveAt: "" };
      byProject.set(key, p);
    }
    p.tokens += totalTok(r);
    const ts = r.lastActiveAt || r.recordedAt || r.date || "";
    if (ts > (p.lastActiveAt || "")) p.lastActiveAt = ts;
  }

  const showPin = opts.pinnable !== false;
  const pinned = isPinned("today");
  const pinBtn = showPin
    ? `<button class="pin-btn${pinned ? " pinned" : ""}" data-pin-id="today" title="${pinned ? "Unpin from Home" : "Pin to Home"}" aria-label="Pin toggle"><i class="ph ph-push-pin${pinned ? "-fill" : ""}"></i></button>`
    : "";

  return `<div class="pinnable-wrap">${pinBtn}${buildProjectListHTML({
    title: "Today",
    projects: Array.from(byProject.values()),
    sortable: true,
    defaultSort: "lastActiveAt",
    id: "today-projects",
  })}</div>`;
}

// ── Window projects list (used inside graph cards) ────────────────────────

function buildWindowProjectsHTML(
  startMs: number, endMs: number,
  usageHistory: UsageRecord[] | undefined,
  pctKey: "s" | "w" = "s",
  maxItems: number | null = 5,
  listId: string | null = null,
): string {
  const tokenHistory = getTokenHistory();
  if (!tokenHistory || !tokenHistory.length) return "";

  const byProject = new Map<string, ListProject>();
  for (const r of tokenHistory) {
    const endTs = r.lastActiveAt || "";
    const startTs = (r as TokenRecord & { startedAt?: string }).startedAt || "";
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
    if (isBlackRef(key)) continue;
    let p = byProject.get(key);
    if (!p) {
      p = { cwd: key, tokens: 0, lastActiveAt: "" };
      byProject.set(key, p);
    }
    p.tokens += totalTok(r);
    if (endTs > (p.lastActiveAt || "")) p.lastActiveAt = endTs;
  }

  const projects = Array.from(byProject.values());
  let hasPct = false;
  if (usageHistory && usageHistory.length && projects.length) {
    const pctField = pctKey === "w" ? "weekly_pct" : "session_pct";
    const windowPts = usageHistory
      .filter((r) => (r as Record<string, unknown>)[pctField] != null)
      .map((r) => ({ t: hourToMs(r.hour), pct: (r as Record<string, number>)[pctField] as number }))
      .filter((p) => p.t >= startMs && p.t <= endMs)
      .sort((a, b) => a.t - b.t);

    if (windowPts.length >= 2) {
      const first = windowPts[0]!;
      const last = windowPts[windowPts.length - 1]!;
      const delta = last.pct - first.pct;
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
    maxItems,
    showTime: false,
    showPct: hasPct,
    sortable: true,
    defaultSort: hasPct ? "sessionPct" : "tokens",
    id: listId || `window-${startMs}`,
    style: "margin-top:2px;margin-bottom:8px",
  });
}

// ── Chart SVG ─────────────────────────────────────────────────────────────

function buildChart(
  history: UsageRecord[],
  startMs: number, endMs: number,
  lineKey: "s" | "w",
  svgId: string,
): string {
  const W = 420, H = 172;
  const ML = 30, MR = 8, MT = 8, MB = 42;
  const PW = W - ML - MR;
  const PH = H - MT - MB;

  const minT = startMs;
  const maxT = endMs;
  const tRange = maxT - minT || 1;
  const px = (t: number): number => ML + ((t - minT) / tRange) * PW;
  const py = (v: number): number => MT + (1 - v / 100) * PH;

  const gridLines = [0, 25, 50, 75, 100].map((v) => {
    const y = py(v);
    return `<line x1="${ML}" x2="${W - MR}" y1="${y}" y2="${y}" stroke="#2d2c44" stroke-width="1"/>
            <text x="${ML - 4}" y="${y + 3.5}" text-anchor="end" fill="#6b6990" font-size="10" font-family="Fira Code, monospace">${v}</text>`;
  }).join("");

  const tickItems: string[] = [];
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
        `<text x="${x}" y="${H - MB + 14}" text-anchor="middle" fill="#6b6990" font-size="10" font-family="DM Sans, system-ui">${hh}:${mm}</text>`,
      );
    }
  } else {
    const cursor = new Date(minT);
    cursor.setHours(24, 0, 0, 0);
    while (cursor.getTime() <= maxT) {
      const x = px(cursor.getTime()).toFixed(1);
      const dayName = cursor.toLocaleDateString("en-US", { weekday: "short" });
      const dateStr = (cursor.getMonth() + 1) + "/" + cursor.getDate();
      tickItems.push(
        `<line x1="${x}" x2="${x}" y1="${MT + PH}" y2="${MT + PH + 4}" stroke="#2d2c44" stroke-width="1"/>` +
        `<text x="${x}" y="${H - MB + 14}" text-anchor="middle" fill="#6b6990" font-size="10" font-family="DM Sans, system-ui">${dayName}</text>` +
        `<text x="${x}" y="${H - MB + 26}" text-anchor="middle" fill="#4a4870" font-size="9" font-family="DM Sans, system-ui">${dateStr}</text>`,
      );
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  const refLine =
    `<line data-line="expected"` +
    ` x1="${px(minT).toFixed(1)}" y1="${py(0).toFixed(1)}"` +
    ` x2="${px(maxT).toFixed(1)}" y2="${py(100).toFixed(1)}"` +
    ` stroke="#6b6990" stroke-width="1.5" stroke-dasharray="5,4"/>`;

  interface Pt { t: number; s: number | null; w: number | null; }
  const pts: Pt[] = history
    .map((r) => ({ t: hourToMs(r.hour), s: r.session_pct, w: r.weekly_pct }))
    .filter((p) => p.t >= minT && p.t <= maxT);

  if (pts.length && pts[0]!.t > minT) {
    pts.unshift({ t: minT, s: 0, w: 0 });
  }

  const makeLine = (key: "s" | "w", color: string, lineName: string): string => {
    const f = pts.filter((p) => p[key] !== null && p[key] !== undefined) as Array<Pt & { s: number; w: number }>;
    if (f.length === 0) return `<g data-line="${lineName}"></g>`;
    if (f.length === 1) {
      const first = f[0]!;
      return `<circle data-line="${lineName}" cx="${px(first.t).toFixed(1)}" cy="${py(first[key]).toFixed(1)}" r="2.5" fill="${color}"/>`;
    }
    const d = f.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.t).toFixed(1)},${py(p[key]).toFixed(1)}`).join(" ");
    return `<path data-line="${lineName}" d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  };

  return (
    `<svg id="${svgId}" viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">` +
    gridLines +
    `<line x1="${ML}" x2="${ML}" y1="${MT}" y2="${MT + PH}" stroke="#2d2c44" stroke-width="1"/>` +
    tickItems.join("") +
    refLine +
    (lineKey === "s" ? makeLine("s", "#9d7dfc", "session") : makeLine("w", "#6e8fff", "weekly")) +
    `</svg>`
  );
}

// ── Line visibility + legend toggles + pagination ─────────────────────────

export function applyLineVisibility(): void {
  for (const key of ["session", "weekly", "expected"] as const) {
    document.querySelectorAll<HTMLElement>(`[data-line="${key}"]`).forEach((el) => {
      el.style.display = lineVisible[key] ? "" : "none";
    });
    document.querySelectorAll<HTMLElement>(`[data-legend="${key}"]`).forEach((leg) => {
      leg.style.opacity = lineVisible[key] ? "1" : "0.35";
    });
  }
}

export function setupLegendToggles(): void {
  document.querySelectorAll<HTMLElement>("[data-legend]").forEach((el) => {
    const w = wired(el);
    if (w._legWired) return;
    w._legWired = true;
    el.onclick = () => {
      const key = el.dataset["legend"] as keyof typeof lineVisible | undefined;
      if (!key) return;
      lineVisible[key] = !lineVisible[key];
      applyLineVisibility();
    };
  });
}

export function setupPaginationButtons(container?: HTMLElement | null): void {
  const root: ParentNode = container || document;
  root.querySelectorAll<HTMLElement>("[data-page-nav]").forEach((btn) => {
    const w = wired(btn);
    if (w._pageWired) return;
    w._pageWired = true;
    const graph = btn.dataset["pageGraph"];
    const dir = btn.dataset["pageNav"];
    btn.onclick = () => {
      if (graph === "session") {
        sessionPageOffset = dir === "prev" ? sessionPageOffset + 1 : Math.max(0, sessionPageOffset - 1);
      } else if (graph === "weekly") {
        weeklyPageOffset = dir === "prev" ? weeklyPageOffset + 1 : Math.max(0, weeklyPageOffset - 1);
      }
      refreshDashboard();
    };
  });
}

// ── Project bars view (alt mode) ──────────────────────────────────────────

const BAR_COLORS = ["#9d7dfc", "#6e8fff", "#7af0c0", "#e67e22", "#e74c3c"];

function buildProjectBarsView(
  startMs: number, endMs: number,
  usageHistory: UsageRecord[] | undefined,
  pctKey: "s" | "w",
  maxItems: number | null,
  listId: string | null,
): string {
  const tokenHistory = getTokenHistory();
  if (!tokenHistory || !tokenHistory.length) {
    return '<div class="no-data" style="padding:24px 0">No project data</div>';
  }

  const byProject = new Map<string, ListProject>();
  for (const r of tokenHistory) {
    const endTs = r.lastActiveAt || "";
    const startTs = (r as TokenRecord & { startedAt?: string }).startedAt || "";
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
    let p = byProject.get(key);
    if (!p) {
      p = { cwd: key, tokens: 0 };
      byProject.set(key, p);
    }
    p.tokens += totalTok(r);
  }

  const projects = Array.from(byProject.values()).sort((a, b) => b.tokens - a.tokens);
  if (!projects.length) {
    return '<div class="no-data" style="padding:24px 0">No projects in this window</div>';
  }

  const pctField = pctKey === "w" ? "weekly_pct" : "session_pct";
  let totalPct: number | null = null;
  if (usageHistory && usageHistory.length) {
    const windowPts = usageHistory
      .filter((r) => (r as Record<string, unknown>)[pctField] != null)
      .map((r) => ({ t: hourToMs(r.hour), pct: (r as Record<string, number>)[pctField] as number }))
      .filter((p) => p.t >= startMs && p.t <= endMs)
      .sort((a, b) => a.t - b.t);
    if (windowPts.length >= 2) {
      const first = windowPts[0]!;
      const last = windowPts[windowPts.length - 1]!;
      totalPct = last.pct - first.pct;
      if (totalPct <= 0) totalPct = null;
    }
  }

  const totalTokens = projects.reduce((s, p) => s + p.tokens, 0);
  const maxTokens = projects[0]!.tokens;

  const top = maxItems ? projects.slice(0, maxItems) : projects;
  const rest = maxItems ? projects.slice(maxItems) : [];
  const otherTokens = rest.reduce((s, p) => s + p.tokens, 0);

  const rows: string[] = top.map((p, i) => {
    const pct = totalPct !== null ? Math.round((p.tokens / totalTokens) * totalPct) : null;
    const barWidth = Math.max(2, Math.round((p.tokens / maxTokens) * 100));
    const color = BAR_COLORS[i % BAR_COLORS.length];
    return `<div class="project-bar-row">
      <span class="project-bar-label" title="${p.cwd}">${plabel(p.cwd)}</span>
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

// ── Graph card builder ────────────────────────────────────────────────────

interface GraphCardOpts {
  id: "session" | "weekly";
  history: UsageRecord[];
  startMs: number;
  endMs: number;
  lineKey: "s" | "w";
  pctKey: "s" | "w";
  pageOffset: number;
  hasPrev: boolean;
  prevId: string;
  nextId: string;
  pageLabel: string;
  legends: string[];
  maxItems: number | null;
  pinnable?: boolean;
  showPin?: boolean;
}

const graphDetailConfigs: Record<string, GraphCardOpts> = {};

function buildGraphCard(opts: GraphCardOpts): string {
  const { id, history, startMs, endMs, lineKey, pctKey, pageOffset, hasPrev,
    prevId, nextId, pageLabel, legends, maxItems, pinnable, showPin } = opts;
  const svgId = `chart-${id}`;
  const projectListId = `window-${id}-${startMs}`;
  const mode = chartMode[id] || "chart";

  graphDetailConfigs[projectListId] = opts;

  const chartActive = mode === "chart" ? " active" : "";
  const barsActive = mode === "bars" ? " active" : "";
  const legendHtml = mode === "chart" ? legends.join("") : "";
  const legendRow = `<div class="chart-legend-row">
      <div class="chart-legend">${legendHtml}</div>
      <div class="chart-mode-toggle">
        <button class="chart-mode-btn${chartActive}" data-mode="chart" data-graph="${id}" aria-label="Chart view" title="Chart"><i class="ph ph-chart-line-up"></i></button>
        <button class="chart-mode-btn${barsActive}" data-mode="bars" data-graph="${id}" aria-label="Bars view" title="Bars"><i class="ph ph-chart-bar"></i></button>
      </div>
    </div>`;

  const chartContent = mode === "chart"
    ? `${legendRow}
       ${buildChart(history, startMs, endMs, lineKey, svgId)}
       ${buildWindowProjectsHTML(startMs, endMs, history, pctKey, maxItems, projectListId)}`
    : `${legendRow}${buildProjectBarsView(startMs, endMs, history, pctKey, maxItems, projectListId)}`;

  const pinBtn = (pinnable && showPin !== false)
    ? `<button class="pin-btn${isPinned(id) ? " pinned" : ""}" data-pin-id="${id}" title="${isPinned(id) ? "Unpin from Home" : "Pin to Home"}" aria-label="Pin toggle"><i class="ph ph-push-pin${isPinned(id) ? "-fill" : ""}"></i></button>`
    : "";

  return `<div class="chart-container"${id === "session" ? ' style="margin-bottom:12px"' : ""}>
    ${pinBtn}
    <div class="chart-pagination">
      <button id="${prevId}" data-page-nav="prev" data-page-graph="${id}" class="btn-secondary nav-arrow left" ${hasPrev ? "" : "disabled"}>◀</button>
      <span class="chart-pagination-label">${pageLabel}</span>
      <button id="${nextId}" data-page-nav="next" data-page-graph="${id}" class="btn-secondary nav-arrow right" ${pageOffset === 0 ? "disabled" : ""}>▶</button>
    </div>
    ${chartContent}
  </div>`;
}

// ── Graph detail view (opened via show-more button) ───────────────────────

function openGraphDetail(listId: string): void {
  const config = graphDetailConfigs[listId];
  if (!config) return;

  const container = document.getElementById("graph-detail-content");
  const title = document.getElementById("graphDetailTitle");
  if (!container) return;
  if (title) title.textContent = config.id === "session" ? "Session" : "Weekly";

  container.innerHTML = buildGraphCard({ ...config, maxItems: null });

  const prevBtn = container.querySelector<HTMLButtonElement>(`#${config.prevId}`);
  const nextBtn = container.querySelector<HTMLButtonElement>(`#${config.nextId}`);
  if (config.id === "session") {
    if (prevBtn) prevBtn.onclick = () => { sessionPageOffset++; renderGraphDetailFromCurrent("session"); };
    if (nextBtn) nextBtn.onclick = () => { sessionPageOffset = Math.max(0, sessionPageOffset - 1); renderGraphDetailFromCurrent("session"); };
  } else {
    if (prevBtn) prevBtn.onclick = () => { weeklyPageOffset++; renderGraphDetailFromCurrent("weekly"); };
    if (nextBtn) nextBtn.onclick = () => { weeklyPageOffset = Math.max(0, weeklyPageOffset - 1); renderGraphDetailFromCurrent("weekly"); };
  }

  wireProjectListClicks(container, refreshDashboard);
  wireChartModeToggles(container);
  g().showView?.("graph-detail");
}

function renderGraphDetailFromCurrent(type: "session" | "weekly"): void {
  const lastHistory = (getUsageHistory() as UsageRecord[] | null) || null;
  if (!lastHistory || !lastHistory.length) return;
  const latest = lastHistory[lastHistory.length - 1]!;
  const SESSION_MS = 5 * 3_600_000;
  const WEEK_MS = 7 * 24 * 3_600_000;

  const legendItem = (elId: string, color: string, isDashed: boolean, label: string): string => {
    const key = elId.replace(/^legend-/, "");
    const dot = isDashed
      ? `<span style="display:inline-block;width:14px;height:2px;background:${color};vertical-align:middle;margin-right:4px;border-radius:1px;border-top:2px dashed ${color};"></span>`
      : `<span class="legend-dot" style="background:${color}"></span>`;
    return `<span data-legend="${key}" style="cursor:pointer">${dot}${label}</span>`;
  };

  let config: GraphCardOpts;
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
  if (!container) return;
  container.innerHTML = buildGraphCard(config);

  const prevBtn = container.querySelector<HTMLButtonElement>(`#${config.prevId}`);
  const nextBtn = container.querySelector<HTMLButtonElement>(`#${config.nextId}`);
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

// ── Chart mode toggles + project-list click wiring ────────────────────────

export function wireChartModeToggles(container: HTMLElement | null): void {
  if (!container) return;
  container.querySelectorAll<HTMLElement>(".chart-mode-btn").forEach((btn) => {
    const w = wired(btn);
    if (w._wired) return;
    w._wired = true;
    btn.onclick = () => {
      const graphId = btn.dataset["graph"];
      const mode = btn.dataset["mode"] as "chart" | "bars" | undefined;
      if (!graphId || !mode) return;
      if (chartMode[graphId] === mode) return;
      chartMode[graphId] = mode;
      if (g().activeView === "graph-detail") {
        renderGraphDetailFromCurrent(graphId as "session" | "weekly");
      } else {
        refreshDashboard();
      }
    };
  });
  container.querySelectorAll<HTMLElement>(".project-bars-more").forEach((link) => {
    const w = wired(link);
    if (w._wired) return;
    w._wired = true;
    link.onclick = () => {
      const listId = link.dataset["barsListId"];
      if (listId && graphDetailConfigs[listId]) openGraphDetail(listId);
    };
  });
}

export function wireProjectListClicks(
  container: HTMLElement | null,
  onSort?: (listId?: string) => void,
): void {
  if (!container) return;
  container.querySelectorAll<HTMLElement>(".proj-row").forEach((row) => {
    const w = wired(row);
    if (row.dataset["cwd"] && !w._wired) {
      w._wired = true;
      row.onclick = () => {
        const cwd = row.dataset["cwd"];
        if (!cwd) return;
        g().openProjectDetail?.(cwd);
      };
    }
  });
  container.querySelectorAll<HTMLElement>(".show-more-btn").forEach((btn) => {
    const w = wired(btn);
    if (w._wired) return;
    w._wired = true;
    btn.onclick = () => {
      const listId = btn.dataset["listId"];
      if (listId && graphDetailConfigs[listId]) openGraphDetail(listId);
    };
  });
  container.querySelectorAll<HTMLElement>("th[data-sort][data-list]").forEach((th) => {
    const w = wired(th);
    if (w._wired) return;
    w._wired = true;
    th.onclick = () => {
      const listId = th.dataset["list"];
      const col = th.dataset["sort"];
      if (!listId || !col) return;
      const ss = listSortState[listId];
      if (!ss) return;
      if (ss.col === col) ss.dir = (ss.dir * -1) as 1 | -1;
      else { ss.col = col; ss.dir = -1; }
      onSort?.(listId);
    };
  });
}

// ── Pin button wiring ─────────────────────────────────────────────────────

export function wirePinButtons(
  container: HTMLElement | null,
  opts: { onHomeUnpin?: boolean } = {},
): void {
  if (!container) return;
  container.querySelectorAll<HTMLElement>(".pin-btn").forEach((btn) => {
    const w = wired(btn);
    if (w._wired) return;
    w._wired = true;
    btn.onclick = (e: Event) => {
      e.stopPropagation();
      const id = btn.dataset["pinId"];
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

// ── Pinned cards HTML (used by Home) ──────────────────────────────────────

export function buildPinnedCardsHTML(history: UsageRecord[]): string {
  const pinned = getPinnedSet();
  if (!pinned.size) return "";

  const latest = history[history.length - 1]!;
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
  const hasSessionPrev = history.some((r) => {
    const t = hourToMs(r.hour);
    return t >= shiftedSessionStartMs - SESSION_MS && t < shiftedSessionStartMs;
  });

  const shiftedWeeklyEndMs = weeklyEndMs - weeklyPageOffset * WEEK_MS;
  const shiftedWeeklyStartMs = weeklyStartMs - weeklyPageOffset * WEEK_MS;
  const hasWeeklyPrev = history.some((r) => {
    const t = hourToMs(r.hour);
    return t >= shiftedWeeklyStartMs - WEEK_MS && t < shiftedWeeklyStartMs;
  });

  const legendItem = (elId: string, color: string, isDashed: boolean, label: string): string => {
    const key = elId.replace(/^legend-/, "");
    const dot = isDashed
      ? `<span style="display:inline-block;width:14px;height:2px;background:${color};vertical-align:middle;margin-right:4px;border-radius:1px;border-top:2px dashed ${color};"></span>`
      : `<span class="legend-dot" style="background:${color}"></span>`;
    return `<span data-legend="${key}" style="cursor:pointer">${dot}${label}</span>`;
  };

  const parts: string[] = [];
  if (pinned.has("today")) {
    parts.push(buildTodaySectionHTML(getTokenHistory(), { pinnable: true }));
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

// ── Statistics renderer ───────────────────────────────────────────────────

function getStatisticsContent(): HTMLElement | null {
  return document.getElementById("statistics-content");
}

export function renderStatistics(history: UsageRecord[]): void {
  const latest = history[history.length - 1]!;

  const weeklyEndMs = latest.weekly_resets_at
    ? new Date(latest.weekly_resets_at).getTime()
    : Date.now() + 3_600_000;
  const weeklyStartMs = weeklyEndMs - 7 * 24 * 3_600_000;

  const SESSION_MS = 5 * 3_600_000;
  const sessionEndMs = latest.session_resets_at
    ? new Date(latest.session_resets_at).getTime()
    : Date.now() + 3_600_000;
  const sessionBaseStartMs = sessionEndMs - SESSION_MS;
  const WEEK_MS = 7 * 24 * 3_600_000;

  const sessionShiftMs = sessionPageOffset * SESSION_MS;
  const shiftedSessionEndMs = sessionEndMs - sessionShiftMs;
  const shiftedSessionStartMs = sessionBaseStartMs - sessionShiftMs;
  const hasSessionPrev = history.some((r) => {
    const t = hourToMs(r.hour);
    return t >= shiftedSessionStartMs - SESSION_MS && t < shiftedSessionStartMs;
  });

  const weeklyShiftMs = weeklyPageOffset * WEEK_MS;
  const shiftedWeeklyEndMs = weeklyEndMs - weeklyShiftMs;
  const shiftedWeeklyStartMs = weeklyStartMs - weeklyShiftMs;
  const hasWeeklyPrev = history.some((r) => {
    const t = hourToMs(r.hour);
    return t >= shiftedWeeklyStartMs - WEEK_MS && t < shiftedWeeklyStartMs;
  });

  const legendItem = (elId: string, color: string, isDashed: boolean, label: string): string => {
    const key = elId.replace(/^legend-/, "");
    const dot = isDashed
      ? `<span style="display:inline-block;width:14px;height:2px;background:${color};vertical-align:middle;margin-right:4px;border-radius:1px;border-top:2px dashed ${color};"></span>`
      : `<span class="legend-dot" style="background:${color}"></span>`;
    return `<span data-legend="${key}" style="cursor:pointer">${dot}${label}</span>`;
  };

  const statisticsContent = getStatisticsContent();
  if (!statisticsContent) return;
  statisticsContent.innerHTML = `
    ${buildTodaySectionHTML(getTokenHistory(), { pinnable: true })}
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

// ── refreshDashboard ──────────────────────────────────────────────────────

export function refreshDashboard(): void {
  const lastHistory = (getUsageHistory() as UsageRecord[] | null) || null;
  if (!lastHistory) return;
  const c = getStatisticsContent();
  if (c) {
    if (!lastHistory.length) {
      c.innerHTML = `<div class="no-data">No history recorded yet.<br><small style="font-size:0.8rem">Data appears after the first successful refresh.</small></div>`;
    } else {
      setUsageHistory(lastHistory);
      renderStatistics(lastHistory);
      wireProjectListClicks(c, refreshDashboard);
    }
  }
  window.dispatchEvent(new CustomEvent("refresh-dashboard-home"));
}

// Unused-imports suppression (cacheEffPct kept for parity w/ legacy; can be dropped later)
void cacheEffPct;

// ── Legacy-global back-compat ─────────────────────────────────────────────

(window as unknown as LegacyGlobals).renderStatistics = renderStatistics;
(window as unknown as LegacyGlobals).buildPinnedCardsHTML = buildPinnedCardsHTML;
(window as unknown as LegacyGlobals).wirePinButtons = wirePinButtons;
(window as unknown as LegacyGlobals).wireProjectListClicks = wireProjectListClicks;
(window as unknown as LegacyGlobals).refreshDashboard = refreshDashboard;
(window as unknown as LegacyGlobals).setupPaginationButtons = setupPaginationButtons;
(window as unknown as LegacyGlobals).setupLegendToggles = setupLegendToggles;
(window as unknown as LegacyGlobals).applyLineVisibility = applyLineVisibility;
(window as unknown as LegacyGlobals).wireChartModeToggles = wireChartModeToggles;

// ── View render ───────────────────────────────────────────────────────────

export async function renderStatisticsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const api = g().electronAPI;
  if (api && !getUsageHistory()) {
    try {
      setUsageHistory(await api.getUsageHistory());
    } catch (e) {
      console.error("[statistics] initial history fetch failed", e);
    }
  }
  fill();

  const unlisten = api?.onHistoryUpdated((h) => {
    setUsageHistory(h);
    fill();
  });

  const onRefresh = () => fill();
  window.addEventListener("refresh-dashboard-home", onRefresh);

  function fill(): void {
    const c = getStatisticsContent();
    if (!c) return;
    const history = getUsageHistory() as UsageRecord[] | null;
    if (!history || history.length === 0) {
      c.innerHTML = `<div class="no-data">No data yet.</div>`;
      return;
    }
    renderStatistics(history);
    wireProjectListClicks(c, refreshDashboard);
  }

  return () => {
    try { unlisten?.(); } catch { /* ignore */ }
    window.removeEventListener("refresh-dashboard-home", onRefresh);
  };
}

function template() {
  return html`
    <div class="view view-statistics">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Statistics</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div id="statistics-content">
          <div class="no-data">No data yet.</div>
        </div>
      </div>
    </div>
  `;
}
