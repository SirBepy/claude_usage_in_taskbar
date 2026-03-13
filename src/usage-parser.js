"use strict";

function formatResetAt(iso, style = "absolute") {
  if (!iso) return null;
  const resetDate = new Date(iso);
  const diff = resetDate - Date.now();
  if (diff <= 0) return "soon";

  if (style === "countdown") {
    const hours = Math.floor(diff / 3600000);
    const mins = Math.round((diff % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

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

function formatTokens(num) {
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return num.toString();
}

/** Builds the tray tooltip string from usage API data. */
function buildTooltip(data, settings = {}) {
  if (!data) return "Claude Usage — Loading...";

  const style = settings.timeStyle || "absolute";

  const session = data.five_hour;
  const w = data.seven_day;

  const sNode = session?.utilization != null;
  const wNode = w?.utilization != null;

  if (!sNode && !wNode) return "Claude Usage";

  const lines = [];

  function row(s, wStr) {
    if (sNode && wNode) return `${s}\t${wStr}`;
    if (sNode) return s;
    return wStr;
  }

  lines.push(row("Session:", "Weekly:"));
  lines.push(row(`${session?.utilization ?? ""}%`, `${w?.utilization ?? ""}%`));

  const sTime = sNode && session.resets_at ? formatResetAt(session.resets_at, style) : "";
  const wTime = wNode && w.resets_at ? formatResetAt(w.resets_at, style) : "";
  if (sTime || wTime) {
    lines.push(row(sTime, wTime));
  }

  if (settings.estimateTokens) {
    let sEst = "";
    if (sNode && settings.sessionPlan) {
      const left = Math.round(Math.max(0, 100 - session.utilization) / 100 * settings.sessionPlan);
      sEst = `${formatTokens(left)} left`;
    }
    let wEst = "";
    if (wNode && settings.weeklyPlan) {
      const left = Math.round(Math.max(0, 100 - w.utilization) / 100 * settings.weeklyPlan);
      wEst = `${formatTokens(left)} left`;
    }
    if (sEst || wEst) {
      lines.push(row(sEst, wEst));
    }
  }

  return lines.join("\n");
}

module.exports = { parseSessionPct, parseWeeklyPct, buildTooltip };
