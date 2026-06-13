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

/**
 * The pane's empty-state markup (nothing selected). Doubles as the daemon
 * boot indicator: while the daemon is not connected the CENTER of the screen
 * shows an animated "Setting up..." (or the stalled warning), not the
 * sidebar - the sidebar stays blank until the daemon is reachable.
 */
export function paneEmptyStateHtml(connected: boolean | null, stalled: boolean): string {
  if (connected === true) {
    return `<div class="session-empty">Select or create a session</div>`;
  }
  if (stalled) {
    return `<div class="session-empty session-empty--setup session-empty--stalled"><i class="ph ph-warning"></i><span>Daemon unreachable, retrying. See daemon.log if this persists.</span></div>`;
  }
  return `<div class="session-empty session-empty--setup"><i class="ph ph-spinner"></i><span>Setting up...</span></div>`;
}

/** 0=NeedsPermission, 1=Question, 2=Working, 3=Done(unread), 4=YourTurn, 5=External/Automated.
 * Question (Claude is waiting on the user) sorts above Working so idle-blocked
 * agents surface first for triage. */
export function statusPriority(i: Instance, unread: Set<string>, attention: Set<string>, question: Set<string>): number {
  if (attention.has(i.session_id)) return 0;
  if (i.kind === "external" || i.kind === "automated") return 5;
  if (i.busy) return 2;
  if (question.has(i.session_id)) return 1;
  if (unread.has(i.session_id)) return 3;
  return 4;
}

export function stateTooltip(i: Instance, unread: Set<string>, attention: Set<string>, question: Set<string>): string {
  if (attention.has(i.session_id)) return "Needs your permission - click to answer";
  if (i.kind === "external") return "External session (read-only)";
  if (i.kind === "automated") return "Automated session (remote-controlled)";
  if (i.busy) return "Claude is running";
  if (question.has(i.session_id)) return "Claude asked a question - click to answer";
  if (unread.has(i.session_id)) return "Claude responded - click to read";
  return "Done - your turn";
}

export function sortSessions(
  sessions: Instance[],
  sort: SessionSort,
  unread: Set<string>,
  attention: Set<string>,
  question: Set<string>,
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
    const pa = statusPriority(a, unread, attention, question);
    const pb = statusPriority(b, unread, attention, question);
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

/** The `st-*` status modifier for a session, shared by the dots-style indicator
 * and the hero-avatar corner dot. Priority matches `statusIndicator`. */
export function statusDotClass(
  i: Instance,
  unread: Set<string>,
  attention: Set<string>,
  question: Set<string>,
): string {
  if (attention.has(i.session_id)) return "st-attention";
  if (i.kind === "external" || i.kind === "automated") return "st-external";
  if (i.busy) return "st-working";
  if (question.has(i.session_id)) return "st-question";
  if (unread.has(i.session_id)) return "st-done";
  return "st-your-turn";
}

export function statusIndicator(
  i: Instance,
  unread: Set<string>,
  attention: Set<string>,
  question: Set<string>,
  style: SessionStateStyle,
  escapeHtmlFn: (s: string) => string,
): string {
  const tooltip = escapeHtmlFn(stateTooltip(i, unread, attention, question));
  const needsAttention = attention.has(i.session_id);
  const isExternal = i.kind === "external" || i.kind === "automated";
  const isQuestion = !needsAttention && !isExternal && !i.busy && question.has(i.session_id);
  if (style === "dots") {
    const cls = `session-status-dot ${statusDotClass(i, unread, attention, question)}`;
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
  if (isQuestion) {
    return `<i class="session-state-icon ph ph-chat-circle-dots s-amber" title="${tooltip}"></i>`;
  }
  if (unread.has(i.session_id)) {
    return `<i class="session-state-icon ph ph-check-circle s-yellow" title="${tooltip}"></i>`;
  }
  // Done / your turn: a calm muted check, NOT the old red exclamation. The red
  // alarm is reserved for genuine permission prompts (attention-pulse above).
  return `<i class="session-state-icon ph ph-check s-muted" title="${tooltip}"></i>`;
}
