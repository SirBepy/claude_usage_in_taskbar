// Account-scoped dashboard widgets: session (5h) and weekly (7d) chart + bars
// (moved from the deleted src/views/statistics/statistics.ts, multi-account
// milestone 05). History is fetched per selected account via
// `api.getHistory({ accountId })`; `accountId: null` (pre-onboarding, empty
// registry) mirrors the old aggregate-history behaviour exactly.
//
// The "show more" -> full-page graph-detail flow (pagination through older
// sessions/weeks) is preserved via the pre-existing static `#view-graph-detail`
// view (src/index.html + main.ts back-button wiring) so no widget capability
// is lost by deleting Statistics.

import { getTokenHistory } from "../../../shared/state";
import type { TokenRecord } from "../../../shared/tokens";
import { formatTokens, totalTok } from "../../../shared/tokens";
import { hourToMs } from "../../../shared/time";
import { showView } from "../../../shared/navigation";
import { api } from "../../../shared/api";
import type { UsageRecord } from "../../../shared/api";
import {
  buildProjectListHTML,
  wireProjectListClicks,
  plabel,
  isBlackRef,
  type ListProject,
} from "./project-list";
import type { Widget, WidgetContext } from "./types";

// ── Module-local chart state (page offsets, line visibility) ───────────────
// Shared across accounts (mirrors the pre-milestone single-account behaviour;
// switching accounts does not reset "N sessions/weeks ago" pagination).

const lineVisible: Record<"session" | "weekly" | "expected", boolean> = {
  session: true,
  weekly: true,
  expected: true,
};
let sessionPageOffset = 0;
let weeklyPageOffset = 0;

type Wired = Element & { _wired?: boolean; _legWired?: boolean; _pageWired?: boolean; _hoverWired?: boolean };
function wired(el: Element): Wired { return el as Wired; }

// ── Per-account history fetch ───────────────────────────────────────────────

async function fetchHistory(accountId: string | null): Promise<UsageRecord[]> {
  try {
    return await api.getHistory({ accountId });
  } catch (err) {
    console.error("[dashboard] getHistory failed", err);
    return [];
  }
}

// ── Window projects list (used inside chart cards) ──────────────────────────

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

  const lineColor = lineKey === "s" ? "#9d7dfc" : "#6e8fff";
  const lineName = lineKey === "s" ? "session" : "weekly";

  const makeLine = (key: "s" | "w", color: string, name: string): string => {
    const f = pts.filter((p) => p[key] !== null && p[key] !== undefined) as Array<Pt & { s: number; w: number }>;
    if (f.length === 0) return `<g data-line="${name}"></g>`;
    if (f.length === 1) {
      const first = f[0]!;
      return `<circle data-line="${name}" cx="${px(first.t).toFixed(1)}" cy="${py(first[key]).toFixed(1)}" r="2.5" fill="${color}"/>`;
    }
    const cPts = f.map((p) => ({ x: px(p.t), y: py(p[key]) }));
    let d = `M${cPts[0]!.x.toFixed(1)},${cPts[0]!.y.toFixed(1)}`;
    for (let i = 0; i < cPts.length - 1; i++) {
      const p0 = cPts[Math.max(0, i - 1)]!;
      const p1 = cPts[i]!;
      const p2 = cPts[i + 1]!;
      const p3 = cPts[Math.min(cPts.length - 1, i + 2)]!;
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return `<path data-line="${name}" d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  };

  const hoverPts = pts
    .filter((p) => p[lineKey] !== null && p[lineKey] !== undefined)
    .map((p) => `${p.t}:${p[lineKey]}`)
    .join(";");
  const windowType = windowMs <= 12 * 3_600_000 ? "session" : "weekly";

  const hoverGroup =
    `<g id="${svgId}-hover" style="pointer-events:none;display:none">` +
    `<line id="${svgId}-hline" x1="0" x2="0" y1="${MT}" y2="${MT + PH}" stroke="#4a4870" stroke-width="1" stroke-dasharray="3,2"/>` +
    `<circle id="${svgId}-hdot" cx="0" cy="0" r="3.5" fill="${lineColor}" stroke="#1e1d30" stroke-width="1.5"/>` +
    `<rect id="${svgId}-hbox" rx="5" ry="5" fill="#1a1928" stroke="#2d2c44" stroke-width="1"/>` +
    `<text id="${svgId}-hlabel" fill="#8885aa" font-size="10" font-family="DM Sans, system-ui"></text>` +
    `<text id="${svgId}-hval" fill="${lineColor}" font-size="12" font-family="Fira Code, monospace" font-weight="600"></text>` +
    `</g>` +
    `<rect id="${svgId}-overlay" x="${ML}" y="${MT}" width="${PW}" height="${PH}" fill="transparent" style="cursor:crosshair"/>`;

  return (
    `<svg id="${svgId}" viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible"` +
    ` data-hover-pts="${hoverPts}" data-min-t="${minT}" data-max-t="${maxT}" data-window-type="${windowType}" data-line-color="${lineColor}">` +
    gridLines +
    `<line x1="${ML}" x2="${ML}" y1="${MT}" y2="${MT + PH}" stroke="#2d2c44" stroke-width="1"/>` +
    tickItems.join("") +
    refLine +
    makeLine(lineKey, lineColor, lineName) +
    hoverGroup +
    `</svg>`
  );
}

// ── Line visibility + legend toggles + pagination ─────────────────────────

function applyLineVisibility(root: ParentNode): void {
  for (const key of ["session", "weekly", "expected"] as const) {
    root.querySelectorAll<HTMLElement>(`[data-line="${key}"]`).forEach((el) => {
      el.style.display = lineVisible[key] ? "" : "none";
    });
    root.querySelectorAll<HTMLElement>(`[data-legend="${key}"]`).forEach((leg) => {
      leg.style.opacity = lineVisible[key] ? "1" : "0.35";
    });
  }
}

function setupLegendToggles(root: ParentNode, onToggle: () => void): void {
  root.querySelectorAll<HTMLElement>("[data-legend]").forEach((el) => {
    const w = wired(el);
    if (w._legWired) return;
    w._legWired = true;
    el.onclick = () => {
      const key = el.dataset["legend"] as keyof typeof lineVisible | undefined;
      if (!key) return;
      lineVisible[key] = !lineVisible[key];
      applyLineVisibility(root);
      onToggle();
    };
  });
}

function setupPaginationButtons(root: ParentNode, onPage: () => void): void {
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
      onPage();
    };
  });
}

// ── Chart hover tooltips ──────────────────────────────────────────────────

function formatHoverLabel(t: number, windowType: string): string {
  const d = new Date(t);
  if (windowType === "session") {
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  const m = d.getMonth() + 1;
  const dy = d.getDate();
  return `${day} ${m}/${dy}`;
}

function setupChartHover(root: ParentNode): void {
  const W = 420, H = 172;
  const ML = 30, MR = 8, MT = 8, MB = 42;
  const PW = W - ML - MR;
  const PH = H - MT - MB;

  root.querySelectorAll<SVGElement>("svg[data-hover-pts]").forEach((svg) => {
    const w = wired(svg as unknown as Element);
    if (w._hoverWired) return;
    w._hoverWired = true;

    const svgId = svg.id;
    const overlay = document.getElementById(`${svgId}-overlay`);
    if (!overlay) return;

    const ptsRaw = svg.dataset["hoverPts"] || "";
    const minT = parseInt(svg.dataset["minT"] || "0");
    const maxT = parseInt(svg.dataset["maxT"] || "1");
    const windowType = svg.dataset["windowType"] || "session";
    const color = svg.dataset["lineColor"] || "#9d7dfc";
    const tRange = maxT - minT || 1;

    const hoverPts: Array<{ t: number; v: number }> = ptsRaw
      ? ptsRaw.split(";").map((s) => {
          const [ts, vs] = s.split(":");
          return { t: parseInt(ts!), v: parseFloat(vs!) };
        }).filter((p) => !isNaN(p.t) && !isNaN(p.v))
      : [];

    const hoverGroup = document.getElementById(`${svgId}-hover`);
    const hline = document.getElementById(`${svgId}-hline`);
    const hdot = document.getElementById(`${svgId}-hdot`);
    const hbox = document.getElementById(`${svgId}-hbox`);
    const hlabel = document.getElementById(`${svgId}-hlabel`);
    const hval = document.getElementById(`${svgId}-hval`);
    if (!hoverGroup || !hline || !hdot || !hbox || !hlabel || !hval) return;

    overlay.addEventListener("mousemove", (e: Event) => {
      const me = e as MouseEvent;
      const rect = svg.getBoundingClientRect();
      const svgX = (me.clientX - rect.left) * (W / rect.width);
      const t = minT + ((svgX - ML) / PW) * tRange;

      let v = 0;
      if (hoverPts.length === 0) return;
      if (hoverPts.length === 1) {
        v = hoverPts[0]!.v;
      } else {
        let lo = hoverPts[0]!, hi = hoverPts[hoverPts.length - 1]!;
        for (let i = 0; i < hoverPts.length - 1; i++) {
          if (hoverPts[i]!.t <= t && hoverPts[i + 1]!.t >= t) {
            lo = hoverPts[i]!;
            hi = hoverPts[i + 1]!;
            break;
          }
        }
        const frac = hi.t === lo.t ? 0 : (t - lo.t) / (hi.t - lo.t);
        v = lo.v + frac * (hi.v - lo.v);
      }
      v = Math.max(0, Math.min(100, v));

      const cx = ML + ((t - minT) / tRange) * PW;
      const cy = MT + (1 - v / 100) * PH;

      hline.setAttribute("x1", cx.toFixed(1));
      hline.setAttribute("x2", cx.toFixed(1));
      hdot.setAttribute("cx", cx.toFixed(1));
      hdot.setAttribute("cy", cy.toFixed(1));
      hdot.setAttribute("fill", color);

      const label = formatHoverLabel(t, windowType);
      const valText = `${Math.round(v)}%`;
      hlabel.textContent = label;
      hval.textContent = valText;

      const tipW = Math.max(label.length * 6.2, valText.length * 7.8) + 18;
      const tipH = 34;
      let tipX = cx + 10;
      if (tipX + tipW > W - MR) tipX = cx - tipW - 10;
      let tipY = cy - tipH - 6;
      if (tipY < MT) tipY = cy + 8;

      hbox.setAttribute("x", tipX.toFixed(1));
      hbox.setAttribute("y", tipY.toFixed(1));
      hbox.setAttribute("width", tipW.toFixed(1));
      hbox.setAttribute("height", tipH.toFixed(1));
      const midX = (tipX + tipW / 2).toFixed(1);
      hlabel.setAttribute("x", midX);
      hlabel.setAttribute("y", (tipY + 13).toFixed(1));
      hlabel.setAttribute("text-anchor", "middle");
      hval.setAttribute("x", midX);
      hval.setAttribute("y", (tipY + 27).toFixed(1));
      hval.setAttribute("text-anchor", "middle");

      hoverGroup.style.display = "";
    });

    overlay.addEventListener("mouseleave", () => {
      hoverGroup.style.display = "none";
    });
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
      <span class="project-bar-value">${pct !== null ? pct + "%" : formatTokens(p.tokens)}</span>
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
      <span class="project-bar-value">${pct !== null ? pct + "%" : formatTokens(otherTokens)}</span>
    </div>`);
    if (listId) {
      rows.push(`<div class="project-bars-more" data-bars-list-id="${listId}">Show ${rest.length} more</div>`);
    }
  }

  const totalLabel = totalPct !== null ? `Total: ${totalPct}%` : `Total: ${formatTokens(totalTokens)} tokens`;
  return `<div class="project-bars">
    ${rows.join("")}
    <div class="project-bars-total">${totalLabel}</div>
  </div>`;
}

export function wireBarsMore(container: HTMLElement | null, onShowMore: (listId: string) => void): void {
  if (!container) return;
  container.querySelectorAll<HTMLElement>(".project-bars-more").forEach((link) => {
    const w = wired(link);
    if (w._wired) return;
    w._wired = true;
    link.onclick = () => {
      const listId = link.dataset["barsListId"];
      if (listId) onShowMore(listId);
    };
  });
}

// ── Graph card builder ────────────────────────────────────────────────────

interface GraphCardOpts {
  metric: "session" | "weekly";
  kind: "chart" | "bars";
  history: UsageRecord[];
  startMs: number;
  endMs: number;
  lineKey: "s" | "w";
  pctKey: "s" | "w";
  pageOffset: number;
  hasPrev: boolean;
  pageLabel: string;
  legends: string[];
  maxItems: number | null;
}

// Keyed by projectListId, per selected account (a listId embeds startMs, so
// this only grows across pagination within one mount - acceptable, mirrors
// the pre-migration statistics.ts module-level cache).
const graphDetailConfigs: Record<string, { opts: GraphCardOpts; accountId: string | null }> = {};

function buildGraphCard(opts: GraphCardOpts, accountId: string | null): string {
  const { metric, kind, history, startMs, endMs, lineKey, pctKey,
    pageOffset, hasPrev, pageLabel, legends, maxItems } = opts;
  const cardId = `${metric}-${kind}`;
  const svgId = `chart-${cardId}`;
  const projectListId = `window-${cardId}-${startMs}`;
  const prevId = `prev-${cardId}`;
  const nextId = `next-${cardId}`;

  graphDetailConfigs[projectListId] = { opts, accountId };

  const content = kind === "chart"
    ? `<div class="chart-legend">${legends.join("")}</div>
       ${buildChart(history, startMs, endMs, lineKey, svgId)}
       ${buildWindowProjectsHTML(startMs, endMs, history, pctKey, maxItems, projectListId)}`
    : buildProjectBarsView(startMs, endMs, history, pctKey, maxItems, projectListId);

  return `<div class="chart-container" style="margin-bottom:12px">
    <div class="chart-pagination">
      <button id="${prevId}" data-page-nav="prev" data-page-graph="${metric}" class="btn-secondary nav-arrow left" ${hasPrev ? "" : "disabled"}>◀</button>
      <span class="chart-pagination-label">${pageLabel}</span>
      <button id="${nextId}" data-page-nav="next" data-page-graph="${metric}" class="btn-secondary nav-arrow right" ${pageOffset === 0 ? "disabled" : ""}>▶</button>
    </div>
    ${content}
  </div>`;
}

// ── Graph detail view (opened via show-more) ───────────────────────────────

function detailTitle(opts: GraphCardOpts): string {
  const m = opts.metric === "session" ? "Session" : "Weekly";
  const k = opts.kind === "chart" ? "chart" : "bars";
  return `${m} ${k}`;
}

function openGraphDetail(listId: string): void {
  const entry = graphDetailConfigs[listId];
  if (!entry) return;
  const { opts: config, accountId } = entry;

  const container = document.getElementById("graph-detail-content");
  const title = document.getElementById("graphDetailTitle");
  if (!container) return;
  if (title) title.textContent = detailTitle(config);

  container.innerHTML = buildGraphCard({ ...config, maxItems: null }, accountId);
  wireDetailNav(container, config.metric, config.kind, accountId);
  wireProjectListClicks(container, () => renderGraphDetailFromCurrent(config.metric, config.kind, accountId));
  wireBarsMore(container, (id) => openGraphDetail(id));
  setupChartHover(container);
  showView("graph-detail");
}

function wireDetailNav(container: HTMLElement, metric: "session" | "weekly", kind: "chart" | "bars", accountId: string | null): void {
  const cardId = `${metric}-${kind}`;
  const prevBtn = container.querySelector<HTMLButtonElement>(`#prev-${cardId}`);
  const nextBtn = container.querySelector<HTMLButtonElement>(`#next-${cardId}`);
  if (metric === "session") {
    if (prevBtn) prevBtn.onclick = () => { sessionPageOffset++; void renderGraphDetailFromCurrent(metric, kind, accountId); };
    if (nextBtn) nextBtn.onclick = () => { sessionPageOffset = Math.max(0, sessionPageOffset - 1); void renderGraphDetailFromCurrent(metric, kind, accountId); };
  } else {
    if (prevBtn) prevBtn.onclick = () => { weeklyPageOffset++; void renderGraphDetailFromCurrent(metric, kind, accountId); };
    if (nextBtn) nextBtn.onclick = () => { weeklyPageOffset = Math.max(0, weeklyPageOffset - 1); void renderGraphDetailFromCurrent(metric, kind, accountId); };
  }
}

async function renderGraphDetailFromCurrent(metric: "session" | "weekly", kind: "chart" | "bars", accountId: string | null): Promise<void> {
  const lastHistory = await fetchHistory(accountId);
  if (!lastHistory.length) return;

  let config: GraphCardOpts;
  if (metric === "session") {
    config = { ...sessionWindow(lastHistory), metric: "session", kind, history: lastHistory, maxItems: null };
  } else {
    config = { ...weeklyWindow(lastHistory), metric: "weekly", kind, history: lastHistory, maxItems: null };
  }

  const container = document.getElementById("graph-detail-content");
  if (!container) return;
  const title = document.getElementById("graphDetailTitle");
  if (title) title.textContent = detailTitle(config);
  container.innerHTML = buildGraphCard(config, accountId);
  wireDetailNav(container, metric, kind, accountId);
  wireProjectListClicks(container, () => void renderGraphDetailFromCurrent(metric, kind, accountId));
  wireBarsMore(container, (id) => openGraphDetail(id));
  setupChartHover(container);
}

// ── Per-metric window helpers ─────────────────────────────────────────────

interface WindowState {
  startMs: number;
  endMs: number;
  hasPrev: boolean;
  pageLabel: string;
  pageOffset: number;
  legends: string[];
  lineKey: "s" | "w";
  pctKey: "s" | "w";
}

function legendItem(elId: string, color: string, isDashed: boolean, label: string): string {
  const key = elId.replace(/^legend-/, "");
  const dot = isDashed
    ? `<span style="display:inline-block;width:14px;height:2px;background:${color};vertical-align:middle;margin-right:4px;border-radius:1px;border-top:2px dashed ${color};"></span>`
    : `<span class="legend-dot" style="background:${color}"></span>`;
  return `<span data-legend="${key}" style="cursor:pointer">${dot}${label}</span>`;
}

function sessionWindow(history: UsageRecord[]): WindowState {
  const SESSION_MS = 5 * 3_600_000;
  const latest = history[history.length - 1]!;
  const sessionEndMs = latest.session_resets_at
    ? new Date(latest.session_resets_at).getTime()
    : Date.now() + 3_600_000;
  const shiftMs = sessionPageOffset * SESSION_MS;
  const endMs = sessionEndMs - shiftMs;
  const startMs = endMs - SESSION_MS;
  const hasPrev = history.some((r) => {
    const t = hourToMs(r.hour);
    return t >= startMs - SESSION_MS && t < startMs;
  });
  return {
    startMs, endMs, hasPrev,
    pageLabel: sessionPageOffset === 0 ? "This session" : `${sessionPageOffset} session${sessionPageOffset > 1 ? "s" : ""} ago`,
    pageOffset: sessionPageOffset,
    legends: [legendItem("legend-session", "#9d7dfc", false, "Session"), legendItem("legend-expected", "#6b6990", true, "Expected")],
    lineKey: "s", pctKey: "s",
  };
}

function weeklyWindow(history: UsageRecord[]): WindowState {
  const WEEK_MS = 7 * 24 * 3_600_000;
  const latest = history[history.length - 1]!;
  const weeklyEndMs = latest.weekly_resets_at
    ? new Date(latest.weekly_resets_at).getTime()
    : Date.now() + 3_600_000;
  const shiftMs = weeklyPageOffset * WEEK_MS;
  const endMs = weeklyEndMs - shiftMs;
  const startMs = endMs - WEEK_MS;
  const hasPrev = history.some((r) => {
    const t = hourToMs(r.hour);
    return t >= startMs - WEEK_MS && t < startMs;
  });
  return {
    startMs, endMs, hasPrev,
    pageLabel: weeklyPageOffset === 0 ? "This week" : `${weeklyPageOffset}w ago`,
    pageOffset: weeklyPageOffset,
    legends: [legendItem("legend-weekly", "#6e8fff", false, "Weekly"), legendItem("legend-expected", "#6b6990", true, "Expected")],
    lineKey: "w", pctKey: "w",
  };
}

// ── Widget mount: shared render for the 4 session/weekly x chart/bars combos ──

function mountUsageWidget(
  metric: "session" | "weekly",
  kind: "chart" | "bars",
  root: HTMLElement,
  ctx: WidgetContext,
): (() => void) | void {
  let disposed = false;

  const draw = async () => {
    const history = await fetchHistory(ctx.accountId);
    if (disposed) return;
    if (!history.length) {
      root.innerHTML = `<div class="no-data">No history recorded yet.</div>`;
      return;
    }
    const win = metric === "session" ? sessionWindow(history) : weeklyWindow(history);
    const config: GraphCardOpts = { ...win, metric, kind, history, maxItems: 5 };
    root.innerHTML = buildGraphCard(config, ctx.accountId);
    setupLegendToggles(root, () => void draw());
    applyLineVisibility(root);
    setupPaginationButtons(root, () => void draw());
    setupChartHover(root);
    wireBarsMore(root, (id) => openGraphDetail(id));
    wireProjectListClicks(root, () => void draw(), (id) => openGraphDetail(id));
  };

  void draw();

  return () => { disposed = true; };
}

export const sessionChartWidget: Widget = {
  id: "session-chart",
  title: "Session usage",
  scope: "account",
  dataDeps: ["usageHistory", "tokenHistory"],
  render: (root, ctx) => mountUsageWidget("session", "chart", root, ctx),
};

export const sessionBarsWidget: Widget = {
  id: "session-bars",
  title: "Session by project",
  scope: "account",
  dataDeps: ["usageHistory", "tokenHistory"],
  render: (root, ctx) => mountUsageWidget("session", "bars", root, ctx),
};

export const weeklyChartWidget: Widget = {
  id: "weekly-chart",
  title: "Weekly session usage",
  scope: "account",
  dataDeps: ["usageHistory", "tokenHistory"],
  render: (root, ctx) => mountUsageWidget("weekly", "chart", root, ctx),
};

export const weeklyBarsWidget: Widget = {
  id: "weekly-bars",
  title: "Weekly by project",
  scope: "account",
  dataDeps: ["usageHistory", "tokenHistory"],
  render: (root, ctx) => mountUsageWidget("weekly", "bars", root, ctx),
};
