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

export function sessionSubtitle(i: Instance): string {
  return i.name || "New chat";
}

/** 0=Working, 1=Done(unread), 2=YourTurn, 3=External */
export function statusPriority(i: Instance, unread: Set<string>): number {
  if (i.kind === "external") return 3;
  if (i.busy) return 0;
  if (unread.has(i.session_id)) return 1;
  return 2;
}

export function stateTooltip(i: Instance, unread: Set<string>): string {
  if (i.kind === "external") return "External session (read-only)";
  if (i.busy) return "Claude is running";
  if (unread.has(i.session_id)) return "Claude responded - click to read";
  return "Waiting for your input";
}

export function sortSessions(
  sessions: Instance[],
  sort: SessionSort,
  unread: Set<string>,
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
    const pa = statusPriority(a, unread);
    const pb = statusPriority(b, unread);
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
  style: SessionStateStyle,
  escapeHtmlFn: (s: string) => string,
): string {
  const tooltip = escapeHtmlFn(stateTooltip(i, unread));
  if (style === "dots") {
    let cls = "session-status-dot";
    if (i.kind === "external") cls += " st-external";
    else if (i.busy) cls += " st-working";
    else if (unread.has(i.session_id)) cls += " st-done";
    else cls += " st-your-turn";
    return `<span class="${cls}" title="${tooltip}"></span>`;
  }
  // icons mode
  if (i.kind === "external") {
    return `<i class="session-state-icon ph ph-eye s-blue" title="${tooltip}"></i>`;
  }
  if (i.busy) {
    return `<i class="session-state-icon ph ph-spinner s-green spinning" title="${tooltip}"></i>`;
  }
  if (unread.has(i.session_id)) {
    return `<i class="session-state-icon ph ph-check-circle s-yellow" title="${tooltip}"></i>`;
  }
  return `<i class="session-state-icon ph ph-warning-circle s-red" title="${tooltip}"></i>`;
}
