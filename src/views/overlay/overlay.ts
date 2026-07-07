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

const DEFAULT_OVERLAY_OPACITY = 0.72;
const REFRESH_INTERVAL_MS = 30_000;

function metricHtml(label: string, metric: OverlayMetric, colour: string, settings: ValueColorSettings): string {
  if (metric.pct == null) {
    return `<div class="oc-metric"><span class="oc-k">${label}</span><div class="oc-bar"></div><span class="oc-nums"><b class="oc-cur oc-cur-dim">--</b></span></div>`;
  }
  const color = valueColor(metric.pct, metric.safePct, settings, "overlay");
  const tick = metric.safePct != null ? `<i class="oc-tick" style="left:${metric.safePct}%"></i>` : "";
  const safeNum = metric.safePct != null ? `<span class="oc-safe">/${metric.safePct}%</span>` : "";
  return `<div class="oc-metric">
    <span class="oc-k">${label}</span>
    <div class="oc-bar" style="--acc:${escapeHtml(colour)}"><span style="width:${Math.max(0, Math.min(100, metric.pct))}%"></span>${tick}</div>
    <span class="oc-nums" title="usage / safe pace. Safe pace is the even-burn line; green = under it, red = over.">
      <b class="oc-cur" style="color:${escapeHtml(color)}">${metric.pct}%</b>${safeNum}
    </span>
  </div>`;
}

function rowHtml(row: OverlayRow, settings: ValueColorSettings): string {
  return `<div class="oc-row" style="--acc:${escapeHtml(row.colour)}">
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

export async function renderOverlay(root: HTMLElement): Promise<() => void> {
  root.innerHTML = `<div class="oc-panel">
    <div class="oc-head"><i class="ph ph-gauge"></i> Claude usage<span class="grow"></span></div>
    <div id="ocRows" class="oc-rows"><div class="oc-empty">Loading…</div></div>
  </div>`;
  const rowsEl = root.querySelector<HTMLElement>("#ocRows");

  async function refresh(): Promise<void> {
    const settings = getSettings();
    document.documentElement.style.setProperty("--overlay-opacity", `${readOverlayOpacity(settings) * 100}%`);
    if (!rowsEl) return;
    const [accounts, usageMap] = await Promise.all([api.listAccounts(), api.getUsageMap()]);
    if (!accounts.length) {
      rowsEl.innerHTML = `<div class="oc-empty">No accounts yet</div>`;
      return;
    }
    const rows = buildOverlayRows(accounts, usageMap);
    rowsEl.innerHTML = rows.map((r) => rowHtml(r, settings)).join("");
  }

  await refresh();
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
    window.clearInterval(timer);
  };
}
