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
import { extractQuestions, renderQuestionUI } from "./question-ui";
import { showPermissionCard } from "./permission-card";
import {
  autoAllowIfRemembered,
  isAutoAccept,
  isForSelectedSession,
} from "./gating";
import type { PermissionRequestedPayload, Question, QuestionRequestedPayload } from "./types";

export {
  isAutoAccept,
  setAutoAccept,
  setSelectedSessionId,
  addBackgroundSession,
  removeBackgroundSession,
} from "./gating";

function showQuestionCard(payload: QuestionRequestedPayload): void {
  const questions: Question[] = Array.isArray(payload.questions)
    ? payload.questions
    : [payload.questions];

  renderQuestionUI({
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
    if (!isForSelectedSession(payload.session_id)) return;

    if (
      payload.session_id
      && isAutoAccept(payload.session_id)
      && extractQuestions(payload.input) === null
    ) {
      console.debug("[auto-accept] allowing", payload.tool_name, "for", payload.session_id);
      void invoke("respond_permission", {
        id: payload.id,
        behavior: "allow",
        updatedInput: payload.input ?? {},
        message: null,
      }).catch((e) => console.warn("[auto-accept] respond_permission failed:", e));
      return;
    }

    void (async () => {
      if (await autoAllowIfRemembered(payload)) return;
      showPermissionCard(payload);
    })();
  });

  ev.listen<QuestionRequestedPayload>("question-requested", (event) => {
    if (!isForSelectedSession(event.payload.session_id)) return;
    showQuestionCard(event.payload);
  });
}
