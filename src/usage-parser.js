"use strict";

function formatResetAt(iso) {
  if (!iso) return null;
  const resetDate = new Date(iso);
  const diff = resetDate - Date.now();
  if (diff <= 0) return "soon";

  const hh = resetDate.getHours().toString().padStart(2, "0");
  const mm = resetDate.getMinutes().toString().padStart(2, "0");
  const timeStr = `${hh}:${mm}`;

  const hoursUntil = diff / 3600000;
  if (hoursUntil > 20) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayStr = days[resetDate.getDay()];
    return `${dayStr} ${timeStr}`;
  }

  return timeStr;
}

/** 0–100 session (5-hour window) utilization, or null if unknown. */
function parseSessionPct(data) {
  return data?.five_hour?.utilization ?? null;
}

/** 0–100 weekly (7-day window) utilization, or null if unknown. */
function parseWeeklyPct(data) {
  return data?.seven_day?.utilization ?? null;
}

/** Builds the tray tooltip string from usage API data. */
function buildTooltip(data) {
  if (!data) return "Claude Usage — Loading...";

  const lines = [];

  const session = data.five_hour;
  if (session?.utilization != null) {
    const reset = session.resets_at
      ? ` - ${formatResetAt(session.resets_at)}`
      : "";
    lines.push(`Session: ${session.utilization}%${reset}`);
  }

  const weekly = data.seven_day;
  if (weekly?.utilization != null) {
    const reset = weekly.resets_at
      ? ` - ${formatResetAt(weekly.resets_at)}`
      : "";
    lines.push(`Weekly:  ${weekly.utilization}%${reset}`);
  }

  return lines.length ? lines.join("\n") : "Claude Usage";
}

module.exports = { parseSessionPct, parseWeeklyPct, buildTooltip };
