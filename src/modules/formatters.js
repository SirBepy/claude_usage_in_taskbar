"use strict";

// ── Formatting & color utilities ─────────────────────────────────────────────

function hourToMs(h) {
  // "YYYY-MM-DDTHH" or "YYYY-MM-DDTHH:MM" → local-time epoch ms
  const [date, time] = h.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const parts = time.split(":");
  const hr = Number(parts[0]);
  const min = parts[1] ? Number(parts[1]) : 0;
  return new Date(y, m - 1, d, hr, min).getTime();
}

function pctColor(v) {
  if (v === null || v === undefined) return "var(--text-dim)";
  if (v >= 80) return "#e74c3c";
  if (v >= 50) return "#e67e22";
  return "#27ae60";
}

function getThresholdColor(value, thresholds) {
  if (value == null || !thresholds || thresholds.length === 0) return null;
  const sorted = [...thresholds].sort((a, b) => b.min - a.min);
  for (const t of sorted) {
    if (value >= t.min) return t.color;
  }
  return null;
}

function getPaceColor(pct, safePace, settings) {
  const band = settings.paceBand ?? 10;
  const pc = settings.paceColors || {};
  if (pct < safePace - band) return pc.under || "#27ae60";
  if (pct < safePace) return pc.nearSafe || "#f1c40f";
  if (pct < safePace + band) return pc.nearOver || "#e67e22";
  return pc.over || "#e74c3c";
}

function valueColor(pct, safePace) {
  const s = (typeof currentSettings === "object" && currentSettings) || {};
  if (s.colorApplyTo?.dashboard === false) return "var(--text)";
  if (s.colorMode === "pace" && safePace != null) {
    return getPaceColor(pct, safePace, s);
  }
  const c = getThresholdColor(pct, s.colorThresholds);
  return c || pctColor(pct);
}

function fmtPct(v) {
  return v !== null && v !== undefined ? v + "%" : "--";
}

function fmtResetTime(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d)) return null;
  const now = Date.now();
  const diffMs = d - now;
  if (diffMs <= 0) return "now";
  const h = Math.floor(diffMs / 3_600_000);
  const m = Math.floor((diffMs % 3_600_000) / 60_000);
  if (h > 12) {
    const day = d.toLocaleDateString("en-US", { weekday: "short" });
    const opts = d.getMinutes() === 0
      ? { hour: "numeric", hour12: true }
      : { hour: "numeric", minute: "2-digit", hour12: true };
    const hour = d.toLocaleTimeString("en-US", opts);
    return `resets ${day}<br>${hour}`;
  }
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}
