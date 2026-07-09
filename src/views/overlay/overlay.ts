// Floating multi-account overlay (milestone 06). Rendered into the
// always-on-top `session-overlay` Tauri window (see
// src-tauri/src/ipc/window.rs::toggle_overlay_window), toggled by a tray
// left-click. Lists every registered account's 5h + 7d usage as
// `usage%/safepace%` with a safe-pace tick, translucent by default and
// opaque on hover (see overlay.css) — matches
// .for_bepy/multi-account-mockup.html section 5.

import { escapeHtml } from "../../shared/escape-html";
import { accountIconBadgeHtml } from "../../shared/account-chip";
import "../../shared/account-chip.css";
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
/** Logical width of the overlay window (matches OVERLAY_WIDTH in window.rs). */
const OVERLAY_WIDTH_CSS = 320;

/** The 5h/7d label, carrying a hover tooltip with that window's exact reset
 * time when there's an active reset (point 8: reset time on hover). */
function labelHtml(label: string, metric: OverlayMetric): string {
  if (!metric.resetAbs) return `<span class="oc-k">${label}</span>`;
  return `<span class="oc-k oc-k-tip">${label}<span class="oc-tip">resets ${escapeHtml(metric.resetAbs)}</span></span>`;
}

function metricHtml(label: string, metric: OverlayMetric, colour: string, settings: ValueColorSettings): string {
  if (metric.pct == null) {
    return `<div class="oc-metric">${labelHtml(label, metric)}<div class="oc-bar"></div><span class="oc-nums"><b class="oc-cur oc-cur-dim">--</b></span></div>`;
  }
  const color = valueColor(metric.pct, metric.safePct, settings, "overlay");
  const tick = metric.safePct != null ? `<i class="oc-tick" style="left:${metric.safePct}%"></i>` : "";
  const safeNum = metric.safePct != null ? `<span class="oc-safe">/${metric.safePct}%</span>` : "";
  return `<div class="oc-metric">
    ${labelHtml(label, metric)}
    <div class="oc-bar" style="--acc:${escapeHtml(colour)}"><span style="width:${Math.max(0, Math.min(100, metric.pct))}%"></span>${tick}</div>
    <span class="oc-nums" title="usage / safe pace. Safe pace is the even-burn line; green = under it, red = over.">
      <b class="oc-cur" style="color:${escapeHtml(color)}">${metric.pct}%</b>${safeNum}
    </span>
  </div>`;
}

function rowHtml(row: OverlayRow, settings: ValueColorSettings): string {
  return `<div class="oc-row" data-acc-id="${escapeHtml(row.id)}" style="--acc:${escapeHtml(row.colour)}">
    <div class="oc-top">${accountIconBadgeHtml(row)}<span class="oc-nm">${escapeHtml(row.label)}</span><span class="grow"></span><span class="oc-rs">${escapeHtml(row.resetLabel)}</span></div>
    ${metricHtml("5h", row.session, row.colour, settings)}
    ${metricHtml("7d", row.weekly, row.colour, settings)}
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

export async function renderOverlay(root: HTMLElement): Promise<() => void> {
  // Transparency is driven purely by the per-card `.oc-row` hover reveal (see
  // overlay.css): off-hover the cards carry no background so the whole window
  // reads straight through to the desktop. Deliberately NOT a whole-body
  // `opacity` dim - setting `opacity` on the root of a transparent WebView2
  // window forces the body onto its own compositing layer with a black
  // backing, so the panel goes *darker* instead of see-through (the exact bug
  // this used to have). Card backgrounds use rgba/color-mix instead, which
  // composite correctly over the transparent window.

  // Transparent panel: a top drag grip + a stack of floating account cards,
  // window height sized to fit (see overlay.css + overlay-drag.ts). Dragging
  // is only via the grip; clicking a card opens the dashboard for that account.
  root.innerHTML = `<div id="ocPanel">
    <div class="oc-grip" id="ocGrip" title="drag to move — flick toward a corner to snap"><i class="ph ph-dots-six"></i></div>
    <div id="ocRows" class="oc-rows"><div class="oc-empty">Loading…</div></div>
  </div>`;
  const panelEl = root.querySelector<HTMLElement>("#ocPanel");
  const gripEl = root.querySelector<HTMLElement>("#ocGrip");
  const rowsEl = root.querySelector<HTMLElement>("#ocRows");

  function syncSize(): void {
    if (panelEl) requestAnimationFrame(() => void resizeOverlayToContent(panelEl, OVERLAY_WIDTH_CSS));
  }

  // Click a card → surface the dashboard focused on that account.
  rowsEl?.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".oc-row[data-acc-id]");
    const id = card?.dataset["accId"];
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
    rowsEl.innerHTML = rows.map((r) => rowHtml(r, settings)).join("");
    syncSize();
  }

  await refresh();
  const cleanupDrag = gripEl ? initOverlayDrag(gripEl) : () => {};
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
