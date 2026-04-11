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
    return `${days[resetDate.getDay()]} ${timeStr}`;
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

function getThresholdColor(value, thresholds) {
  if (value == null || !thresholds || thresholds.length === 0) return null;
  const sorted = [...thresholds].sort((a, b) => b.min - a.min);
  for (const t of sorted) {
    if (value >= t.min) return t.color;
  }
  return null;
}

function hexToEmoji(hex) {
  if (!hex || hex.length < 7) return "";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  if (max === r && g < 120) return "🔴";
  if (max === r && g >= 120) return "🟠";
  if (max === g) return "🟢";
  if (max === b) return "🔵";
  return "⚪";
}

function getPaceColor(pct, safePace, settings) {
  const band = settings.paceBand ?? 10;
  const pc = settings.paceColors || {};
  if (pct < safePace - band) return pc.under || "#27ae60";
  if (pct < safePace) return pc.nearSafe || "#f1c40f";
  if (pct < safePace + band) return pc.nearOver || "#e67e22";
  return pc.over || "#e74c3c";
}

function calcSafePct(resetAt, windowMs) {
  if (!resetAt) return null;
  const diff = new Date(resetAt) - Date.now();
  if (diff < 0) return 100;
  return Math.max(0, Math.min(100, Math.round((windowMs - diff) / windowMs * 100)));
}

/** Builds the tray tooltip string from usage API data. */
function buildTooltip(data, settings = {}) {
  if (!data) return "Claude Usage — Loading...";

  const timeStyle = settings.timeStyle || "absolute";
  const layout = settings.tooltipLayout || "rows";
  const showSafePace = settings.tooltipShowSafePace !== false;
  const useColors = settings.colorApplyTo?.tooltip !== false;
  // support old key name for backward compat
  const estimateTokens = settings.tooltipEstimateTokens ?? settings.estimateTokens ?? false;

  const session = data.five_hour;
  const weekly = data.seven_day;

  const hasSession = session?.utilization != null;
  const hasWeekly = weekly?.utilization != null;

  if (!hasSession && !hasWeekly) return "Claude Usage";

  const sessionSafe = hasSession ? calcSafePct(session.resets_at, 5 * 3600000) : null;
  const weeklySafe = hasWeekly ? calcSafePct(weekly.resets_at, 7 * 24 * 3600000) : null;

  const sTime = hasSession && session.resets_at ? formatResetAt(session.resets_at, timeStyle) : null;
  const wTime = hasWeekly && weekly.resets_at ? formatResetAt(weekly.resets_at, timeStyle) : null;

  function tokensLeft(utilization, plan) {
    if (!plan) return null;
    return `${formatTokens(Math.round((Math.max(0, 100 - utilization) / 100) * plan))} left`;
  }
  const sessionTokens = estimateTokens && hasSession ? tokensLeft(session.utilization, settings.sessionPlan) : null;
  const weeklyTokens = estimateTokens && hasWeekly ? tokensLeft(weekly.utilization, settings.weeklyPlan) : null;

  function pctStr(utilization, safePace) {
    const pct = `${utilization}%`;
    if (!useColors) return pct;
    let hex;
    if (settings.colorMode === "pace" && safePace != null) {
      hex = getPaceColor(utilization, safePace, settings);
    } else {
      hex = getThresholdColor(utilization, settings.colorThresholds);
    }
    return hex ? `${hexToEmoji(hex)} ${pct}` : pct;
  }

  if (layout === "columns") {
    const lines = [];

    if (hasSession && hasWeekly) lines.push("Session\tWeekly");

    lines.push(
      [hasSession ? pctStr(session.utilization, sessionSafe) : null, hasWeekly ? pctStr(weekly.utilization, weeklySafe) : null]
        .filter(Boolean).join("\t")
    );

    if (showSafePace && (sessionSafe !== null || weeklySafe !== null)) {
      lines.push(
        [sessionSafe !== null ? `${sessionSafe}%` : "", weeklySafe !== null ? `${weeklySafe}%` : ""]
          .join("\t").trimEnd()
      );
    }

    if (sTime || wTime) {
      lines.push([sTime || "", wTime || ""].join("\t").trimEnd());
    }

    if (sessionTokens || weeklyTokens) {
      lines.push([sessionTokens || "", weeklyTokens || ""].join("\t").trimEnd());
    }

    return lines.join("\n");
  }

  // rows layout
  const lines = [];

  if (hasSession) {
    const parts = [`Session  ${pctStr(session.utilization, sessionSafe)}`];
    if (showSafePace && sessionSafe !== null) parts.push(`${sessionSafe}%`);
    if (sTime) parts.push(sTime);
    if (sessionTokens) parts.push(sessionTokens);
    lines.push(parts.join("  "));
  }

  if (hasWeekly) {
    const parts = [`Weekly   ${pctStr(weekly.utilization, weeklySafe)}`];
    if (showSafePace && weeklySafe !== null) parts.push(`${weeklySafe}%`);
    if (wTime) parts.push(wTime);
    if (weeklyTokens) parts.push(weeklyTokens);
    lines.push(parts.join("  "));
  }

  return lines.join("\n");
}

module.exports = { parseSessionPct, parseWeeklyPct, buildTooltip, calcSafePct };
