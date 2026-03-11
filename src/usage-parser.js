"use strict";

/**
 * Recursively searches an object for the first key that matches any of the
 * given names, returning its value. Used to handle API response field variants.
 */
function deepFind(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  for (const v of Object.values(obj)) {
    const f = deepFind(v, keys);
    if (f !== undefined) return f;
  }
}

/** Extracts the current session usage percentage (0–100) from API data. */
function parseSessionPct(data) {
  let pct = deepFind(data, [
    "current_session_percentage",
    "sessionPercentage",
    "session_percentage",
    "session_pct",
  ]);
  if (pct == null) {
    const used = deepFind(data, [
      "messages_used",
      "session_messages_used",
      "current_messages_used",
    ]);
    const limit = deepFind(data, [
      "messages_allowed",
      "session_messages_limit",
      "session_limit",
      "message_limit",
    ]);
    if (used != null && limit) pct = (used / limit) * 100;
  }
  return pct != null ? Math.round(pct) : null;
}

function formatTimeUntil(iso) {
  if (!iso) return null;
  const diff = new Date(iso) - Date.now();
  if (diff <= 0) return "soon";
  const h = Math.floor(diff / 3600000),
    m = Math.floor((diff % 3600000) / 60000);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Builds the tray tooltip string from usage API data. */
function buildTooltip(data) {
  if (!data) return "Claude Usage — Loading...";

  const sessionPct = parseSessionPct(data);

  let weeklyPct = deepFind(data, ["weekly_percentage", "weeklyPercentage", "weekly_pct"]);
  if (weeklyPct == null) {
    const used = deepFind(data, ["weekly_messages_used", "weekly_used"]);
    const limit = deepFind(data, ["weekly_messages_limit", "weekly_limit", "weekly_allowed"]);
    if (used != null && limit) weeklyPct = Math.round((used / limit) * 100);
  }

  const sessionResetsAt = deepFind(data, [
    "session_resets_at",
    "session_reset_at",
    "current_session_reset_at",
    "resets_at",
  ]);
  const weeklyResetsAt = deepFind(data, [
    "weekly_resets_at",
    "weekly_reset_at",
    "next_weekly_reset",
  ]);

  const lines = [];
  if (sessionPct != null)
    lines.push(`Session: ${sessionPct}%${sessionResetsAt ? ` (resets ${formatTimeUntil(sessionResetsAt)})` : ""}`);
  if (weeklyPct != null)
    lines.push(`Weekly: ${Math.round(weeklyPct)}%${weeklyResetsAt ? ` (resets ${formatTimeUntil(weeklyResetsAt)})` : ""}`);

  return lines.length ? lines.join("\n") : "Claude Usage";
}

module.exports = { deepFind, parseSessionPct, buildTooltip };
