import type { Instance } from "../../types/ipc.generated";

export type SessionSort = "status" | "recent" | "name";
export type SessionStateStyle = "icons" | "dots";

export const LS_STATE_STYLE = "cc_session_state_style";
export const LS_SORT = "cc_session_sort";
export const LS_UNREAD = "cc_session_unread";

export function projectName(i: Instance): string {
  const cwd = String(i.cwd ?? "");
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function cwdToProjectName(cwd: string): string {
  const parts = String(cwd ?? "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function sessionSubtitle(i: Instance): string {
  return i.name || "New chat";
}

/** 0=NeedsPermission, 1=Working, 2=Done(unread), 3=YourTurn, 4=External/Automated */
export function statusPriority(i: Instance, unread: Set<string>, attention: Set<string>): number {
  if (attention.has(i.session_id)) return 0;
  if (i.kind === "external" || i.kind === "automated") return 4;
  if (i.busy) return 1;
  if (unread.has(i.session_id)) return 2;
  return 3;
}

export function stateTooltip(i: Instance, unread: Set<string>, attention: Set<string>): string {
  if (attention.has(i.session_id)) return "Needs your permission - click to answer";
  if (i.kind === "external") return "External session (read-only)";
  if (i.kind === "automated") return "Automated session (remote-controlled)";
  if (i.busy) return "Claude is running";
  if (unread.has(i.session_id)) return "Claude responded - click to read";
  return "Waiting for your input";
}

export function sortSessions(
  sessions: Instance[],
  sort: SessionSort,
  unread: Set<string>,
  attention: Set<string>,
): Instance[] {
  const copy = sessions.slice();
  if (sort === "name") {
    return copy.sort((a, b) =>
      projectName(a).localeCompare(projectName(b), undefined, { sensitivity: "base" })
    );
  }
  if (sort === "recent") {
    return copy.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  }
  // status sort
  return copy.sort((a, b) => {
    const pa = statusPriority(a, unread, attention);
    const pb = statusPriority(b, unread, attention);
    if (pa !== pb) return pa - pb;
    return (b.started_at ?? "").localeCompare(a.started_at ?? "");
  });
}

export function loadUnreadSet(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_UNREAD);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

export function saveUnreadSet(set: Set<string>): void {
  try { localStorage.setItem(LS_UNREAD, JSON.stringify([...set])); }
  catch { /* ignore */ }
}

export function loadSort(): SessionSort {
  try {
    const v = localStorage.getItem(LS_SORT);
    if (v === "status" || v === "recent" || v === "name") return v;
  } catch { /* ignore */ }
  return "status";
}

export function loadStateStyle(): SessionStateStyle {
  try {
    const v = localStorage.getItem(LS_STATE_STYLE);
    if (v === "icons" || v === "dots") return v;
  } catch { /* ignore */ }
  return "icons";
}

export function statusIndicator(
  i: Instance,
  unread: Set<string>,
  attention: Set<string>,
  style: SessionStateStyle,
  escapeHtmlFn: (s: string) => string,
): string {
  const tooltip = escapeHtmlFn(stateTooltip(i, unread, attention));
  const needsAttention = attention.has(i.session_id);
  if (style === "dots") {
    let cls = "session-status-dot";
    if (needsAttention) cls += " st-attention";
    else if (i.kind === "external" || i.kind === "automated") cls += " st-external";
    else if (i.busy) cls += " st-working";
    else if (unread.has(i.session_id)) cls += " st-done";
    else cls += " st-your-turn";
    return `<span class="${cls}" title="${tooltip}"></span>`;
  }
  // icons mode
  if (needsAttention) {
    return `<i class="session-state-icon ph ph-shield-warning s-red attention-pulse" title="${tooltip}"></i>`;
  }
  if (i.kind === "external") {
    return `<i class="session-state-icon ph ph-eye s-blue" title="${tooltip}"></i>`;
  }
  if (i.kind === "automated") {
    return `<i class="session-state-icon ph ph-robot s-blue" title="${tooltip}"></i>`;
  }
  if (i.busy) {
    return `<i class="session-state-icon ph ph-spinner s-green spinning" title="${tooltip}"></i>`;
  }
  if (unread.has(i.session_id)) {
    return `<i class="session-state-icon ph ph-check-circle s-yellow" title="${tooltip}"></i>`;
  }
  return `<i class="session-state-icon ph ph-warning-circle s-red" title="${tooltip}"></i>`;
}
