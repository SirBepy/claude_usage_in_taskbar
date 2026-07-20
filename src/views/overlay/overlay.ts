// Floating multi-account overlay (milestone 06), circle-dial layout (see
// .for_bepy/overlay-circle-mockup.html — the approved design this ports).
// Rendered into the always-on-top `session-overlay` Tauri window (see
// src-tauri/src/ipc/overlay_window.rs::toggle_overlay_window), toggled by a
// tray left-click. One dial per account: the OUTER thick ring is the 5h
// session window, the INNER thin ring is the 7d weekly window, and the
// account-coloured icon sits in the centre (identity), on a per-dial disc
// (circles mode) or a shared row card (card mode). Hovering a dial fades out
// its graph + icon and shows an info circle in its place: the account name and
// both windows' current%/safe%.

import { escapeHtml } from "../../shared/escape-html";
import "./overlay.css";
import { valueColor } from "../../shared/formatters";
import type { ValueColorSettings } from "../../shared/formatters";
import { api } from "../../shared/api";
import { getSettings, setSettings } from "../../shared/state";
import type { SettingsShape } from "../../shared/state";
import { buildOverlayRows } from "./overlay-logic";
import type { OverlayMetric, OverlayRow } from "./overlay-logic";
import { initOverlayDrag, resizeOverlayToContent } from "./overlay-drag";

const DEFAULT_OVERLAY_OPACITY = 0.72;
const REFRESH_INTERVAL_MS = 30_000;
// Local IPC refreshes are usually near-instant; only show the spinner if one
// runs long enough to actually be worth signalling, so a normal 30s tick
// doesn't flash the icon for a frame.
const REFRESH_SPINNER_DELAY_MS = 150;

// Dial geometry — ported 1:1 from the mockup's arc()/seg()/ring()/dial() so
// the rendered result matches it exactly (viewBox 0 0 44 44, centre 22,22).
const OUTER_R = 19;
const OUTER_W = 4.5;
const INNER_R = 12;
const INNER_W = 3;
const TRACK_COLOR = "var(--color-surface-alt, #262637)";
// Filled backing disc behind each dial (circles mode). Gives contrast on light
// desktops where the fully-transparent window was hard to read, while staying
// subtle on dark ones (its fill honours the overlay-opacity slider — see
// .oc-disc in overlay.css). Sized to sit a `DISC_PAD` gap OUTSIDE the outer
// ring so the graph is padded within the disc rather than touching its rim.
const DISC_PAD = 4;
const DISC_R = OUTER_R + OUTER_W / 2 + DISC_PAD;
// Small breathing gap around the rings in card mode, where the shared row card
// (not a per-dial disc) is the backing — so dials sit compactly in the card
// rather than floating in the disc's padding.
const CARD_MARGIN = 2;

/** Uniform scale from viewBox units to rendered px. >1 enlarges the whole dial
 * (rings + disc + icon together). Kept a touch bigger than 1:1 so the resting
 * circles and the (now smaller) hover info circle are close in size. */
const DIAL_SCALE = 1.2;

/** The ring maths all draw around centre (22,22) inside a 44-unit box. Widening
 * the viewBox symmetrically with a negative origin keeps the centre at (22,22)
 * (so none of the seg/ring code changes) while making room around the rings —
 * the margin differs by mode (large in circles mode to become the disc's
 * padding, small in card mode). The rendered px is that unit-box scaled by
 * DIAL_SCALE, so the graph keeps its proportions and just renders larger. */
function dialGeometry(showDisc: boolean): { viewBox: string; sizeCss: string } {
  const margin = showDisc ? DISC_PAD : CARD_MARGIN;
  const size = 44 + 2 * margin;
  const px = Math.round(size * DIAL_SCALE);
  return { viewBox: `${-margin} ${-margin} ${size} ${size}`, sizeCss: `width:${px}px;height:${px}px` };
}

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

function dialHtml(row: OverlayRow, settings: ValueColorSettings, showDisc: boolean): string {
  const outer = ringSvg(OUTER_R, OUTER_W, row.session, settings);
  const inner = ringSvg(INNER_R, INNER_W, row.weekly, settings);
  const icon = escapeHtml(row.icon);
  // Centre icon carries the account's own colour (identity); the rings carry
  // pace status. Falls back to the CSS neutral when an account has no colour.
  const iconColor = row.colour ? ` style="color:${escapeHtml(row.colour)}"` : "";
  // Circles mode draws a per-dial backing disc; card mode omits it (the shared
  // row card is the backing instead — see .oc-dial-row.oc-card in overlay.css).
  const disc = showDisc ? `<circle class="oc-disc" cx="22" cy="22" r="${DISC_R}"/>` : "";
  const { viewBox, sizeCss } = dialGeometry(showDisc);
  // Spinner glyph sits alongside the account icon at all times, hidden by
  // default — #ocRows.oc-refreshing (set by refresh() while a fetch is in
  // flight) swaps which one is visible, so a background refresh reads as the
  // dial "working" instead of the icon just silently updating.
  const icons = `<i class="ph ph-${icon} oc-ic-glyph"></i><i class="ph ph-spinner oc-ic-spin"></i>`;
  return `<div class="oc-dial" style="${sizeCss}"><svg viewBox="${viewBox}" style="${sizeCss}">${disc}${outer}${inner}</svg><div class="oc-ic"${iconColor}>${icons}</div></div>`;
}

/** One `<cur>%/<safe>%` line inside the hover info circle, the current %
 * tinted by pace colour. Shows `--` when there's no data yet. */
function infoMetricLine(metric: OverlayMetric, settings: ValueColorSettings): string {
  const color = metricColor(metric, settings);
  const curText = metric.pct != null ? `${metric.pct}%` : "--";
  const safeText = metric.safePct != null ? `/${metric.safePct}%` : "";
  return `<div class="oc-info-row"><b style="color:${escapeHtml(color)}">${curText}</b><span class="oc-info-safe">${escapeHtml(safeText)}</span></div>`;
}

/** Hover content shown INSIDE the circle in place of the graph: the account
 * name plus the session/weekly current%/safe% lines (top = session, bottom =
 * weekly). Fades in (and the dial graph fades out) on cell hover — see .oc-info
 * in overlay.css. */
function infoHtml(row: OverlayRow, settings: ValueColorSettings): string {
  return `<div class="oc-info">
    <div class="oc-info-nm">${escapeHtml(row.label)}</div>
    ${infoMetricLine(row.session, settings)}
    ${infoMetricLine(row.weekly, settings)}
  </div>`;
}

function cellHtml(row: OverlayRow, settings: ValueColorSettings, showDisc: boolean): string {
  return `<div class="oc-cell" data-acc-id="${escapeHtml(row.id)}">
    ${dialHtml(row, settings, showDisc)}
    ${infoHtml(row, settings)}
  </div>`;
}

function readOverlayOpacity(settings: SettingsShape): number {
  const raw = settings["overlayOpacity"];
  const n = typeof raw === "number" ? raw : DEFAULT_OVERLAY_OPACITY;
  return Math.max(0, Math.min(1, n));
}

/** Overlay backing style: per-dial circular discs ("circles", default) or one
 * shared rounded card behind the whole row ("card"). */
function readBackgroundStyle(settings: SettingsShape): "circles" | "card" {
  return settings["overlayBackgroundStyle"] === "card" ? "card" : "circles";
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

export async function renderOverlay(root: HTMLElement): Promise<() => void> {
  // Off-hover the dials carry only their (semi-transparent) backing disc/card
  // so the window reads mostly through to the desktop. Deliberately NOT a
  // whole-body `opacity` dim - setting `opacity` on the root of a transparent
  // WebView2 window forces the body onto its own compositing layer with a black
  // backing, so the panel goes *darker* instead of see-through (the exact bug
  // this used to have). Backgrounds use rgba/color-mix instead, which composite
  // correctly over the transparent window.

  // Transparent panel: just a horizontal row of account dials, window sized to
  // hug that row (see overlay.css + overlay-drag.ts). The WHOLE panel is the
  // drag surface now (no separate grip) — press-and-move drags/flicks it, a
  // plain click (no movement past a small threshold) opens the dashboard for
  // the clicked account instead.
  root.innerHTML = `<div id="ocPanel">
    <div id="ocRows" class="oc-dial-row"><div class="oc-empty">Loading…</div></div>
  </div>`;
  const panelEl = root.querySelector<HTMLElement>("#ocPanel");
  const rowsEl = root.querySelector<HTMLElement>("#ocRows");

  function syncSize(): void {
    if (panelEl) requestAnimationFrame(() => void resizeOverlayToContent(panelEl));
  }

  // Click (a press that didn't turn into a drag) on a dial → surface the
  // dashboard focused + highlighted on that account. Routed through the drag
  // handler's pointerup rather than a native `click` listener: the whole panel
  // is the drag surface and takes pointer capture on press, which would
  // redirect the synthesized click away from the dial's cell.
  const openClickedAccount = (target: EventTarget | null): void => {
    const cell = (target as HTMLElement | null)?.closest<HTMLElement>(".oc-cell[data-acc-id]");
    const id = cell?.dataset["accId"];
    if (id) void api.openDashboardAccount(id);
  };

  async function refresh(): Promise<void> {
    const settings = getSettings();
    applyOverlayTheme(settings);
    document.documentElement.style.setProperty("--overlay-opacity", `${readOverlayOpacity(settings) * 100}%`);
    if (!rowsEl) return;
    // Only spin existing dials — the very first load already shows the
    // "Loading…" placeholder text, which the spinner would be redundant with.
    const hasDials = !!rowsEl.querySelector(".oc-cell");
    const spinnerTimer = hasDials
      ? window.setTimeout(() => rowsEl.classList.add("oc-refreshing"), REFRESH_SPINNER_DELAY_MS)
      : undefined;
    const [accounts, usageMap] = await Promise.all([api.listAccounts(), api.getUsageMap()]);
    if (spinnerTimer != null) window.clearTimeout(spinnerTimer);
    rowsEl.classList.remove("oc-refreshing");
    if (!accounts.length) {
      rowsEl.innerHTML = `<div class="oc-empty">No accounts yet</div>`;
      syncSize();
      return;
    }
    const cardMode = readBackgroundStyle(settings) === "card";
    rowsEl.classList.toggle("oc-card", cardMode);
    const rows = buildOverlayRows(accounts, usageMap);
    rowsEl.innerHTML = rows.map((r) => cellHtml(r, settings, !cardMode)).join("");
    syncSize();
  }

  await refresh();
  const cleanupDrag = panelEl ? initOverlayDrag(panelEl, openClickedAccount) : () => {};
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
    window.clearInterval(timer);
  };
}
