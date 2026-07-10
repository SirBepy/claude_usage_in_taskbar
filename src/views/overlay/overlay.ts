// Floating multi-account overlay (milestone 06), circle-dial layout (see
// .for_bepy/overlay-circle-mockup.html — the approved design this ports).
// Rendered into the always-on-top `session-overlay` Tauri window (see
// src-tauri/src/ipc/overlay_window.rs::toggle_overlay_window), toggled by a
// tray left-click. One dial per account: the OUTER thick ring is the 5h
// session window, the INNER thin ring is the 7d weekly window, and the
// account icon sits dimmed/neutral in the centre (colour is entirely pace
// status now, so it can't also carry the account identity — the icon does
// that instead). Hovering a dial surfaces a popup with both windows'
// current%/safe% and, per row, a small tooltip with the time-left/reset
// clock for that window.

import { escapeHtml } from "../../shared/escape-html";
import "./overlay.css";
import { valueColor } from "../../shared/formatters";
import type { ValueColorSettings } from "../../shared/formatters";
import { api } from "../../shared/api";
import { getSettings, setSettings } from "../../shared/state";
import type { SettingsShape } from "../../shared/state";
import { buildOverlayRows } from "./overlay-logic";
import type { OverlayMetric, OverlayRow } from "./overlay-logic";
import { initOverlayDrag, resizeOverlayToContent, attachOverlayHoverResize } from "./overlay-drag";

const DEFAULT_OVERLAY_OPACITY = 0.72;
const REFRESH_INTERVAL_MS = 30_000;

// Dial geometry — ported 1:1 from the mockup's arc()/seg()/ring()/dial() so
// the rendered result matches it exactly (viewBox 0 0 44 44, centre 22,22).
const OUTER_R = 19;
const OUTER_W = 4.5;
const INNER_R = 12;
const INNER_W = 3;
const TRACK_COLOR = "var(--color-surface-alt, #262637)";

/** One arc's dasharray + rotation, matching the mockup's `arc()`. */
function arcGeometry(r: number, startPct: number, lenPct: number): { dash: string; rot: string } {
  const c = 2 * Math.PI * r;
  const dash = `${((lenPct / 100) * c).toFixed(2)} ${c.toFixed(2)}`;
  const rot = (-90 + (startPct / 100) * 360).toFixed(2);
  return { dash, rot };
}

/** One arc segment, matching the mockup's `seg()`. */
function seg(r: number, w: number, startPct: number, lenPct: number, stroke: string, cap: boolean, opacity?: number): string {
  const a = arcGeometry(r, startPct, lenPct);
  const capAttr = cap ? ' stroke-linecap="round"' : "";
  const opacityAttr = opacity != null ? ` opacity="${opacity}"` : "";
  return `<circle cx="22" cy="22" r="${r}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-dasharray="${a.dash}" transform="rotate(${a.rot} 22 22)"${capAttr}${opacityAttr}/>`;
}

/**
 * One ring (either the 5h or the 7d), matching the mockup's `ring()` exactly:
 * a full-track base, then either a single solid arc (on pace), a faded
 * safe-pace arc under a solid current arc (under pace — solid up to current,
 * ghost out to the safe mark), or a bright current arc under a darker
 * safe-pace arc (over pace — darker up to safe, bright for the overshoot).
 */
function ring(r: number, w: number, cur: number, safe: number, color: string): string {
  let out = seg(r, w, 0, 100, TRACK_COLOR, false);
  if (cur === safe) {
    out += seg(r, w, 0, cur, color, true);
  } else if (cur < safe) {
    out += seg(r, w, 0, safe, color, true, 0.3);
    out += seg(r, w, 0, cur, color, true);
  } else {
    const darker = `color-mix(in srgb, ${color} 52%, #08060c)`;
    out += seg(r, w, 0, cur, color, true);
    out += seg(r, w, 0, safe, darker, true);
  }
  return out;
}

/** Base ring colour for one metric: the app's settings-driven pace colour
 * (getPaceColor, via valueColor which also honours the existing colorApplyTo
 * "off" escape hatch and falls back to a plain percent-threshold colour when
 * there's no safe-pace anchor yet) — never a hand-rolled green/amber/red. */
function metricColor(metric: OverlayMetric, settings: ValueColorSettings): string {
  if (metric.pct == null) return "var(--color-text-muted, #8a8aa0)";
  return valueColor(metric.pct, metric.safePct, settings, "overlay");
}

/** SVG for one ring, degrading to a bare track when there's no data yet, and
 * to a single solid arc (no faded/darker split) when there's data but no
 * safe-pace anchor to compare it against (e.g. no active reset window). */
function ringSvg(r: number, w: number, metric: OverlayMetric, settings: ValueColorSettings): string {
  if (metric.pct == null) return seg(r, w, 0, 100, TRACK_COLOR, false);
  const cur = Math.max(0, Math.min(100, metric.pct));
  const safe = metric.safePct != null ? Math.max(0, Math.min(100, metric.safePct)) : cur;
  return ring(r, w, cur, safe, metricColor(metric, settings));
}

function dialHtml(row: OverlayRow, settings: ValueColorSettings): string {
  const outer = ringSvg(OUTER_R, OUTER_W, row.session, settings);
  const inner = ringSvg(INNER_R, INNER_W, row.weekly, settings);
  const icon = escapeHtml(row.icon);
  return `<div class="oc-dial"><svg viewBox="0 0 44 44">${outer}${inner}</svg><div class="oc-ic"><i class="ph ph-${icon}"></i></div></div>`;
}

/** One `5h`/`7d` row inside the popup: current%/safe% plus a session
 * tooltip (window name, time-left, absolute reset clock) on hover. Omitted
 * when there's no data for that metric yet. */
function popupMetricRow(label: string, windowName: string, metric: OverlayMetric, settings: ValueColorSettings): string {
  const color = metricColor(metric, settings);
  const curText = metric.pct != null ? `${metric.pct}%` : "--";
  const safeText = metric.safePct != null ? ` / ${metric.safePct}%` : "";
  const tooltip =
    metric.pct != null && metric.resetRelative
      ? `<div class="oc-pop-tt">
          <div class="oc-tt-l1" style="color:${escapeHtml(color)}">${escapeHtml(windowName)}</div>
          <div class="oc-tt-l2">${escapeHtml(metric.resetRelative)}</div>
          ${metric.resetAbs ? `<div class="oc-tt-l3">resets ${escapeHtml(metric.resetAbs)}</div>` : ""}
        </div>`
      : "";
  return `<div class="oc-pop-row">
    <span class="oc-pop-k">${escapeHtml(label)}</span>
    <span class="oc-pop-val"><b style="color:${escapeHtml(color)}">${curText}</b><span class="oc-pop-safe">${escapeHtml(safeText)}</span></span>
    ${tooltip}
  </div>`;
}

function popupHtml(row: OverlayRow, settings: ValueColorSettings): string {
  return `<div class="oc-pop">
    <div class="oc-pop-nm"><i class="ph ph-${escapeHtml(row.icon)}"></i>${escapeHtml(row.label)}</div>
    ${popupMetricRow("5h", "5h session", row.session, settings)}
    ${popupMetricRow("7d", "7d window", row.weekly, settings)}
  </div>`;
}

function cellHtml(row: OverlayRow, settings: ValueColorSettings): string {
  return `<div class="oc-cell" data-acc-id="${escapeHtml(row.id)}">
    ${popupHtml(row, settings)}
    ${dialHtml(row, settings)}
  </div>`;
}

function readOverlayOpacity(settings: SettingsShape): number {
  const raw = settings["overlayOpacity"];
  const n = typeof raw === "number" ? raw : DEFAULT_OVERLAY_OPACITY;
  return Math.max(0, Math.min(1, n));
}

/** Mirror the user's chosen theme/mode onto this window's <html>. The overlay
 * skips initBoot(), so it never runs boot.ts's applyThemeFromSettings and would
 * otherwise stay stuck on overlay.html's static `data-theme="void"` default.
 * Replicated (not imported) to keep boot.ts's heavy view graph out of the
 * overlay chunk (see overlay-main.ts). Runs from refresh(), which fires on both
 * initial render and the settings-changed path, so live theme switches follow. */
function applyOverlayTheme(settings: SettingsShape): void {
  const fullId = (settings.theme as string) || "void";
  const isLight = fullId.endsWith("-light");
  const el = document.documentElement;
  el.dataset.theme = isLight ? fullId.replace("-light", "") : fullId;
  el.dataset.mode = isLight ? "light" : "dark";
}

/**
 * Flip a hovered popup row's session tooltip to open toward the panel's own
 * centre instead of always opening the same direction (the mockup's static
 * demo always opened left, because that demo's dial was permanently docked
 * at the right edge of its canvas — the real overlay is draggable to any
 * corner, so "inward" has to be measured, not assumed). Measured against this
 * webview's own viewport (which — since the window is now sized tight to its
 * content — closely tracks the panel's own bounds) rather than the physical
 * monitor, so it needs no async Tauri monitor lookup.
 */
function attachTooltipSideFlip(rowsEl: HTMLElement): () => void {
  const onOver = (e: Event): void => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".oc-pop-row");
    if (!row) return;
    const openRight = row.getBoundingClientRect().left < window.innerWidth / 2;
    row.classList.toggle("oc-tt-right", openRight);
  };
  rowsEl.addEventListener("pointerover", onOver);
  return () => rowsEl.removeEventListener("pointerover", onOver);
}

export async function renderOverlay(root: HTMLElement): Promise<() => void> {
  // Transparency is driven purely by the per-popup hover reveal (see
  // overlay.css): off-hover the dials carry no background so the whole window
  // reads straight through to the desktop. Deliberately NOT a whole-body
  // `opacity` dim - setting `opacity` on the root of a transparent WebView2
  // window forces the body onto its own compositing layer with a black
  // backing, so the panel goes *darker* instead of see-through (the exact bug
  // this used to have). Card backgrounds use rgba/color-mix instead, which
  // composite correctly over the transparent window.

  // Transparent panel: a top drag grip + a horizontal row of account dials,
  // window sized to hug that row (see overlay.css + overlay-drag.ts).
  // Dragging is only via the grip; clicking a dial opens the dashboard for
  // that account.
  root.innerHTML = `<div id="ocPanel">
    <div class="oc-grip" id="ocGrip" title="drag to move — flick toward a corner to snap"><i class="ph ph-dots-six"></i></div>
    <div id="ocRows" class="oc-dial-row"><div class="oc-empty">Loading…</div></div>
  </div>`;
  const panelEl = root.querySelector<HTMLElement>("#ocPanel");
  const gripEl = root.querySelector<HTMLElement>("#ocGrip");
  const rowsEl = root.querySelector<HTMLElement>("#ocRows");

  function syncSize(): void {
    if (panelEl) requestAnimationFrame(() => void resizeOverlayToContent(panelEl));
  }

  // Click a dial (or its popup) → surface the dashboard focused on that account.
  rowsEl?.addEventListener("click", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".oc-cell[data-acc-id]");
    const id = cell?.dataset["accId"];
    if (id) void api.openDashboardAccount(id);
  });

  async function refresh(): Promise<void> {
    const settings = getSettings();
    applyOverlayTheme(settings);
    document.documentElement.style.setProperty("--overlay-opacity", `${readOverlayOpacity(settings) * 100}%`);
    if (!rowsEl) return;
    const [accounts, usageMap] = await Promise.all([api.listAccounts(), api.getUsageMap()]);
    if (!accounts.length) {
      rowsEl.innerHTML = `<div class="oc-empty">No accounts yet</div>`;
      syncSize();
      return;
    }
    const rows = buildOverlayRows(accounts, usageMap);
    rowsEl.innerHTML = rows.map((r) => cellHtml(r, settings)).join("");
    syncSize();
  }

  await refresh();
  const cleanupDrag = gripEl ? initOverlayDrag(gripEl) : () => {};
  const cleanupHoverResize = rowsEl && panelEl ? attachOverlayHoverResize(rowsEl, panelEl) : () => {};
  const cleanupTooltipFlip = rowsEl ? attachTooltipSideFlip(rowsEl) : () => {};
  const unlistenHistory = api.onHistoryUpdated(() => void refresh());
  // The overlay window skips initBoot(), so it has no other subscription to
  // settings changes made elsewhere (e.g. Settings > Visuals color rules) -
  // without this, the panel would keep rendering with whatever settings were
  // in effect at window-open time until the window is recreated.
  let unlistenSettings: (() => void) | null = null;
  const ev = window.__TAURI__?.event;
  if (ev?.listen) {
    unlistenSettings = await ev.listen("settings-changed", async () => {
      try {
        const settings = await api.getSettings();
        if (settings) setSettings(settings);
      } catch (e) {
        console.error("overlay: settings refresh failed", e);
      }
      void refresh();
    });
  }
  const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

  return () => {
    try { unlistenHistory(); } catch { /* ignore */ }
    if (unlistenSettings) { try { unlistenSettings(); } catch { /* ignore */ } }
    try { cleanupDrag(); } catch { /* ignore */ }
    try { cleanupHoverResize(); } catch { /* ignore */ }
    try { cleanupTooltipFlip(); } catch { /* ignore */ }
    window.clearInterval(timer);
  };
}
