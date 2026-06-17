/**
 * Permission + question relay UI for the chat hub.
 *
 * Listens for `permission-requested` and `question-requested` Tauri events
 * (emitted by the hooks server when the MCP permission-prompt tool fires
 * during a `claude -p` turn). Renders a floating card anchored just above
 * the active session's composer.
 *
 * Special case: when the permission request is for an AskUserQuestion-style
 * tool (built-in `AskUserQuestion` or our MCP `ask_user_question`), the input
 * itself contains the questions. We render the question UI directly inside
 * the permission card, allow the tool on submit, AND cache the chosen answers
 * keyed by session_id so the follow-up `question-requested` event (for our
 * MCP tool) auto-resolves without prompting the user twice.
 *
 * Install once at app startup via `installPermissionModalListener()`.
 */

import { invoke } from "../../../shared/ipc";
import { dismissQuestionCard, extractQuestions, renderQuestionUI } from "./question-ui";
import { showPermissionCard } from "./permission-card";
import {
  allowPermission,
  autoAllowIfRemembered,
  isAutoAccept,
  isForSelectedSession,
  gateDiag,
  storePendingPrompt,
  takePendingPrompt,
  clearPendingPromptById,
} from "./gating";
import type { PermissionRequestedPayload, Question, QuestionRequestedPayload } from "./types";

export {
  isAutoAccept,
  setAutoAccept,
  setSelectedSessionId,
  addBackgroundSession,
  removeBackgroundSession,
  clearPendingPrompt,
  pendingPromptSessionIds,
} from "./gating";

// Sidebar re-render is injected rather than statically imported: a direct
// `import { renderSidebar } from "../sidebar"` would close a module cycle
// (sidebar -> state -> permission-modal -> sidebar) and pull sidebar.ts's
// top-level document listeners into this module's graph, breaking node-env
// unit tests. main.ts wires the hook at startup.
let _rerenderSidebar: (() => void) | null = null;

export function setSidebarRerenderHook(fn: () => void): void {
  _rerenderSidebar = fn;
}

/** Re-render the sessions sidebar so a newly-parked prompt's attention marker
 *  appears (or clears) on the row. No-op until the hook is wired. */
function rerenderSidebar(): void {
  _rerenderSidebar?.();
}

function showQuestionCard(payload: QuestionRequestedPayload): void {
  // Park the prompt while it's on screen so switching chats and back re-surfaces
  // it (the reliable poll only emits each id once, so a card torn down by
  // navigation is otherwise lost while the daemon turn hangs). Cleared when the
  // prompt resolves (see the `prompt-resolved` listener).
  if (payload.session_id) {
    storePendingPrompt(payload.session_id, { kind: "question", payload });
  }
  const questions: Question[] = Array.isArray(payload.questions)
    ? payload.questions
    : [payload.questions];

  renderQuestionUI({
    id: payload.id,
    questions,
    titleIcon: "ph-chat-circle-dots",
    titleText: "Claude is asking",
    submitLabel: "Submit",
    submitIcon: "ph-paper-plane-right",
    cancelLabel: "Skip",
    onSubmit: async (answers) => {
      try {
        await invoke("respond_question", { id: payload.id, answers });
      } catch (e) { console.warn("respond_question failed:", e); }
    },
    onCancel: async () => {
      try {
        await invoke("respond_question", { id: payload.id, answers: {} });
      } catch { /* ignore */ }
    },
  });
}

let installed = false;

export function installPermissionModalListener(): void {
  if (installed) return;
  installed = true;

  const ev = window.__TAURI__?.event;
  if (!ev?.listen) return;

  ev.listen<PermissionRequestedPayload>("permission-requested", (event) => {
    const payload = event.payload;
    console.info("[perm-relay] frontend received permission-requested", { tool: payload.tool_name, session: payload.session_id, ...gateDiag() });
    if (!isForSelectedSession(payload.session_id)) {
      if (payload.session_id) {
        // Auto-accept is on for this backgrounded chat: allow NOW rather than
        // parking, so no "needs attention" dot appears for a prompt that will
        // never need the user. (Questions still park - never auto-answered.)
        if (isAutoAccept(payload.session_id) && extractQuestions(payload.input) === null) {
          console.debug("[auto-accept] background allow", payload.tool_name, "for", payload.session_id);
          allowPermission(payload, "background respond_permission");
          return;
        }
        // Switched-away busy chat: park the prompt and mark the row so the
        // daemon oneshot isn't left hanging. Replayed on selectSession.
        storePendingPrompt(payload.session_id, { kind: "permission", payload });
        rerenderSidebar();
        console.warn("[perm-gate] PARKED permission-requested for backgrounded chat", { eventSessionId: payload.session_id, tool: payload.tool_name, ...gateDiag() });
      } else {
        console.warn("[perm-gate] DROPPED permission-requested (no session_id)", { tool: payload.tool_name, ...gateDiag() });
      }
      return;
    }

    if (
      payload.session_id
      && isAutoAccept(payload.session_id)
      && extractQuestions(payload.input) === null
    ) {
      console.debug("[auto-accept] allowing", payload.tool_name, "for", payload.session_id);
      allowPermission(payload, "respond_permission");
      return;
    }

    void (async () => {
      if (await autoAllowIfRemembered(payload)) return;
      showPermissionCard(payload);
    })();
  });

  ev.listen<QuestionRequestedPayload>("question-requested", (event) => {
    const payload = event.payload;
    console.info("[perm-relay] frontend received question-requested", { session: payload.session_id, ...gateDiag() });
    if (!isForSelectedSession(payload.session_id)) {
      if (payload.session_id) {
        storePendingPrompt(payload.session_id, { kind: "question", payload });
        rerenderSidebar();
        console.warn("[perm-gate] PARKED question-requested for backgrounded chat", { eventSessionId: payload.session_id, ...gateDiag() });
      } else {
        console.warn("[perm-gate] DROPPED question-requested (no session_id)", { ...gateDiag() });
      }
      return;
    }
    showQuestionCard(payload);
  });

  // A prompt closed on the daemon (timed out, or answered elsewhere). Remove its
  // card if it's the one on screen. Emitted by the reliable pending-prompt poll
  // (daemon_link.rs), so it survives the lossy broadcast.
  ev.listen<{ id: string }>("prompt-resolved", (event) => {
    const id = event.payload?.id;
    if (id) {
      dismissQuestionCard(id);
      // Drop the park now that the daemon no longer holds this prompt, so it
      // can't re-surface on a later switch-back, and clear the row's marker.
      clearPendingPromptById(id);
      rerenderSidebar();
    }
  });
}

/**
 * Replay a parked permission/question prompt for a session the user just
 * selected. Mirrors the arrival path (auto-accept, remembered-rule auto-allow,
 * then the card) so a switch-back surfaces exactly what would have shown had
 * the chat been focused when the tool fired. No-op if nothing is parked.
 *
 * Called from selectSession AFTER the pane is mounted so the card anchors over
 * the right composer.
 */
/**
 * Drain a parked permission prompt for a session that just had auto-accept
 * toggled ON: allow it immediately and clear the sidebar attention dot. A
 * parked question (never auto-answered) is left in place. No-op if nothing is
 * parked. Called from the auto-accept toggle so flipping it on retroactively
 * clears an already-waiting prompt instead of leaving the dot until switch-back.
 */
export function autoAcceptParked(sessionId: string): void {
  const pending = takePendingPrompt(sessionId);
  if (!pending) return;
  if (pending.kind === "permission" && extractQuestions(pending.payload.input) === null) {
    allowPermission(pending.payload, "flush respond_permission");
    rerenderSidebar();
    return;
  }
  // Can't auto-answer (question / AskUserQuestion-shaped): leave it parked.
  storePendingPrompt(sessionId, pending);
}

export function replayPendingPrompt(sessionId: string): void {
  const pending = takePendingPrompt(sessionId);
  if (!pending) return;
  rerenderSidebar(); // clear the attention marker now that we're surfacing it
  if (pending.kind === "question") {
    showQuestionCard(pending.payload);
    return;
  }
  const payload = pending.payload;
  if (
    payload.session_id
    && isAutoAccept(payload.session_id)
    && extractQuestions(payload.input) === null
  ) {
    allowPermission(payload, "replay respond_permission");
    return;
  }
  void (async () => {
    if (await autoAllowIfRemembered(payload)) return;
    showPermissionCard(payload);
  })();
}
