import { invoke } from "../../../shared/ipc";
import { state } from "../state";
import { isDestructive, loadRulesForCwd, matchesRule } from "../permission-rules";
import { extractQuestions } from "./question-ui";
import type { PermissionRequestedPayload, QuestionRequestedPayload } from "./types";

// ── Auto-accept (per-session) ──────────────────────────────────────────────
//
// When set for a session_id, permission-requested events for that session
// auto-respond `allow` with the original input, skipping the modal. Reset on
// every app launch (no persistence). AskUserQuestion-shaped requests are NOT
// auto-answered (see gate in installPermissionModalListener).

const _autoAccept = new Map<string, boolean>();

export function isAutoAccept(sessionId: string | undefined | null): boolean {
  if (!sessionId) return false;
  return _autoAccept.get(sessionId) === true;
}

export function setAutoAccept(sessionId: string, value: boolean): void {
  if (value) _autoAccept.set(sessionId, true);
  else _autoAccept.delete(sessionId);
}

// ── Session-ID gating ──────────────────────────────────────────────────────

let _selectedSessionId: string | null = null;
const _backgroundSessionIds = new Set<string>();

export function setSelectedSessionId(id: string | null): void {
  _selectedSessionId = id;
}

export function addBackgroundSession(id: string): void {
  _backgroundSessionIds.add(id);
}

export function removeBackgroundSession(id: string): void {
  _backgroundSessionIds.delete(id);
}

export function isForSelectedSession(eventSessionId: string | undefined): boolean {
  if (!eventSessionId) return false;
  if (_selectedSessionId === eventSessionId) return true;
  if (_backgroundSessionIds.has(eventSessionId)) return true;
  // During a brand-new session's first turn, selectedId is still the placeholder
  // while the active pane already shows the real session (the renderer swapped
  // its subscription on SessionStarted but setActiveSession lags until
  // start_session resolves). Accept the pending realId so an early prompt isn't
  // dropped.
  const pending = state.pendingNewSession;
  if (pending?.realId === eventSessionId && state.selectedId === pending.placeholderId) {
    return true;
  }
  return false;
}

// ── Parked prompts for switched-away chats ──────────────────────────────────
//
// A permission/question raised on a chat the user has switched AWAY from must
// NOT be dropped: the daemon parks a oneshot waiting for respond_permission /
// respond_question, so a dropped event hangs that chat's turn forever. Instead
// we stash the payload keyed by session_id and replay it when the user selects
// that chat. While a prompt is parked the sidebar marks the row as needing
// attention so the user knows to switch back. (The `/close` background path
// still surfaces inline via `_backgroundSessionIds` and is not parked here.)

export type PendingPrompt =
  | { kind: "permission"; payload: PermissionRequestedPayload }
  | { kind: "question"; payload: QuestionRequestedPayload };

const _pendingPrompts = new Map<string, PendingPrompt>();

export function storePendingPrompt(sessionId: string, prompt: PendingPrompt): void {
  _pendingPrompts.set(sessionId, prompt);
}

/** Returns and removes the parked prompt for a session, if any. */
export function takePendingPrompt(sessionId: string): PendingPrompt | null {
  const p = _pendingPrompts.get(sessionId) ?? null;
  if (p) _pendingPrompts.delete(sessionId);
  return p;
}

export function clearPendingPrompt(sessionId: string): void {
  _pendingPrompts.delete(sessionId);
}

/** Remove whichever parked prompt carries this prompt id, if any. Keyed by the
 *  payload id (not session) so the reliable `prompt-resolved` poll - which only
 *  knows the id - can drop a park once its prompt leaves the daemon's pending
 *  list (answered, denied, or timed out). */
export function clearPendingPromptById(id: string): void {
  for (const [sessionId, prompt] of _pendingPrompts) {
    if (prompt.payload.id === id) {
      _pendingPrompts.delete(sessionId);
      return;
    }
  }
}

/** Session ids with a parked prompt - the sidebar marks these as needing
 *  attention. */
export function pendingPromptSessionIds(): Set<string> {
  return new Set(_pendingPrompts.keys());
}

/** Diagnostic snapshot of the gate's current ids. Logged when a prompt is
 *  dropped so we can see WHY a permission/question event didn't surface. */
export function gateDiag(): {
  selected: string | null;
  background: string[];
  pendingRealId: string | null;
  pendingPlaceholder: string | null;
} {
  return {
    selected: _selectedSessionId,
    background: [..._backgroundSessionIds],
    pendingRealId: state.pendingNewSession?.realId ?? null,
    pendingPlaceholder: state.pendingNewSession?.placeholderId ?? null,
  };
}

/** Resolve the cwd for a session_id from runtime state. Used to look up the
 *  project's remembered permission rules. Real sessions live in
 *  `state.sessions`; the pending placeholder of a brand-new chat lives in
 *  `state.pendingNewSession.projectPath`. */
export function resolveCwdForSession(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const inst = state.sessions.find((s) => s.session_id === sessionId);
  if (inst?.cwd) return String(inst.cwd);
  if (state.pendingNewSession?.placeholderId === sessionId) {
    return state.pendingNewSession.projectPath;
  }
  return null;
}

export function allowPermission(payload: { id: string; input?: unknown }, logTag: string): void {
  void invoke("respond_permission", {
    id: payload.id, behavior: "allow", updatedInput: payload.input ?? {}, message: null,
  }).catch((e) => console.warn(`[auto-accept] ${logTag} failed:`, e));
}

export async function autoAllowIfRemembered(
  payload: PermissionRequestedPayload,
): Promise<boolean> {
  if (extractQuestions(payload.input) !== null) return false;
  if (isDestructive(payload.tool_name, payload.input)) return false;
  const cwd = resolveCwdForSession(payload.session_id);
  if (!cwd) return false;
  let settings: Record<string, unknown> = {};
  try {
    settings = await invoke<Record<string, unknown>>("get_settings");
  } catch {
    return false;
  }
  const rules = loadRulesForCwd(settings, cwd);
  const hit = rules.find((r) => matchesRule(r, payload.tool_name, payload.input));
  if (!hit) return false;
  try {
    await invoke("respond_permission", {
      id: payload.id,
      behavior: "allow",
      updatedInput: payload.input ?? {},
      message: null,
    });
    console.debug("[perm-rules] auto-allow", payload.tool_name, "matched", hit.raw);
    return true;
  } catch (e) {
    console.warn("[perm-rules] auto-allow respond failed:", e);
    return false;
  }
}
