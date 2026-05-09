/**
 * Permission + question relay UI for the chat hub.
 *
 * Listens for `permission-requested` and `question-requested` Tauri events
 * (emitted by the hooks server when the MCP permission-prompt tool fires
 * during a `claude -p` turn), renders a modal overlay, and calls the
 * `respond_permission` / `respond_question` IPC once the user acts.
 *
 * Install once at app startup via `installPermissionModalListener()`.
 */

import { invoke } from "../../shared/ipc";

// ── Types ──────────────────────────────────────────────────────────────────

interface PermissionRequestedPayload {
  id: string;
  tool_name: string;
  input: unknown;
  session_id?: string;
}

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  options?: QuestionOption[];
}

interface QuestionRequestedPayload {
  id: string;
  questions: Question | Question[];
  session_id?: string;
}

// ── Modal host ─────────────────────────────────────────────────────────────

function ensurePermissionHost(): HTMLElement {
  let host = document.getElementById("permission-modal-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "permission-modal-host";
    document.body.appendChild(host);
  }
  return host;
}

function clearPermissionHost(): void {
  const host = document.getElementById("permission-modal-host");
  if (host) host.innerHTML = "";
}

// ── Permission modal ───────────────────────────────────────────────────────

function showPermissionModal(payload: PermissionRequestedPayload): void {
  const host = ensurePermissionHost();

  const respond = async (behavior: "allow" | "deny") => {
    clearPermissionHost();
    try {
      await invoke("respond_permission", { id: payload.id, behavior, updatedInput: null });
    } catch (e) {
      console.warn("respond_permission failed:", e);
    }
  };

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      document.removeEventListener("keydown", escHandler);
      respond("deny");
    }
  };
  document.addEventListener("keydown", escHandler);

  const inputJson = JSON.stringify(payload.input ?? {}, null, 2);

  host.innerHTML = `
    <div class="permission-modal-backdrop"></div>
    <div class="permission-modal-card" role="dialog" aria-modal="true" aria-label="Permission requested">
      <div class="permission-modal-header">
        <span class="permission-modal-title">Permission requested</span>
      </div>
      <div class="permission-modal-body">
        <div class="permission-modal-tool">Tool: <strong class="permission-modal-toolname"></strong></div>
        <pre class="permission-modal-input"></pre>
      </div>
      <div class="permission-modal-footer">
        <button class="btn btn-primary" id="perm-allow-btn">Allow</button>
        <button class="btn btn-secondary" id="perm-deny-btn">Deny</button>
      </div>
    </div>
  `;

  // Set text content safely (no innerHTML injection from payload).
  host.querySelector<HTMLElement>(".permission-modal-toolname")!.textContent = payload.tool_name;
  host.querySelector<HTMLElement>(".permission-modal-input")!.textContent = inputJson;

  host.querySelector("#perm-allow-btn")!.addEventListener("click", () => {
    document.removeEventListener("keydown", escHandler);
    respond("allow");
  });
  host.querySelector("#perm-deny-btn")!.addEventListener("click", () => {
    document.removeEventListener("keydown", escHandler);
    respond("deny");
  });
  host.querySelector<HTMLElement>(".permission-modal-backdrop")!.addEventListener("click", () => {
    document.removeEventListener("keydown", escHandler);
    respond("deny");
  });
}

// ── Question modal ─────────────────────────────────────────────────────────

function showQuestionModal(payload: QuestionRequestedPayload): void {
  const host = ensurePermissionHost();
  const questions: Question[] = Array.isArray(payload.questions)
    ? payload.questions
    : [payload.questions as Question];

  const respond = async (answers: Record<string, string>) => {
    clearPermissionHost();
    try {
      await invoke("respond_question", { id: payload.id, answers });
    } catch (e) {
      console.warn("respond_question failed:", e);
    }
  };

  // Collect answers per question; require all questions to be answered.
  const selected: Record<string, string> = {};

  const render = () => {
    host.innerHTML = `
      <div class="permission-modal-backdrop"></div>
      <div class="permission-modal-card question-modal" role="dialog" aria-modal="true" aria-label="Question">
        <div class="permission-modal-header">
          <span class="permission-modal-title">Claude is asking</span>
        </div>
        <div class="permission-modal-body question-modal-body" id="question-modal-body">
        </div>
        <div class="permission-modal-footer">
          <button class="btn btn-primary" id="quest-submit-btn" disabled>Submit</button>
          <button class="btn btn-secondary" id="quest-skip-btn">Skip</button>
        </div>
      </div>
    `;

    const body = host.querySelector<HTMLElement>("#question-modal-body")!;
    questions.forEach((q) => {
      const qDiv = document.createElement("div");
      qDiv.className = "question-block";

      const qText = document.createElement("div");
      qText.className = "question-text";
      qText.textContent = q.question;
      qDiv.appendChild(qText);

      const opts = q.options ?? [];
      if (opts.length > 0) {
        const btnRow = document.createElement("div");
        btnRow.className = "question-options";
        opts.forEach((opt) => {
          const btn = document.createElement("button");
          btn.className = "btn btn-option" + (selected[q.question] === opt.label ? " selected" : "");
          btn.textContent = opt.label;
          if (opt.description) btn.title = opt.description;
          btn.addEventListener("click", () => {
            selected[q.question] = opt.label;
            render();
          });
          btnRow.appendChild(btn);
        });
        qDiv.appendChild(btnRow);
      }

      body.appendChild(qDiv);
    });

    const allAnswered = questions.every((q) =>
      !q.options?.length || selected[q.question] != null
    );

    const submitBtn = host.querySelector<HTMLButtonElement>("#quest-submit-btn")!;
    submitBtn.disabled = !allAnswered;
    submitBtn.addEventListener("click", () => respond({ ...selected }));

    host.querySelector("#quest-skip-btn")!.addEventListener("click", () => {
      clearPermissionHost();
      void invoke("respond_question", { id: payload.id, answers: {} }).catch(() => {});
    });

    host.querySelector<HTMLElement>(".permission-modal-backdrop")!.addEventListener("click", () => {
      clearPermissionHost();
      void invoke("respond_question", { id: payload.id, answers: {} }).catch(() => {});
    });
  };

  render();
}

// ── Session-ID gating ──────────────────────────────────────────────────────

// The sessions view updates this whenever the active session changes so the
// modal only fires in the window that owns the relevant session.
let _selectedSessionId: string | null = null;

export function setSelectedSessionId(id: string | null): void {
  _selectedSessionId = id;
}

/** Returns true if the event belongs to the currently-selected session. */
function isForSelectedSession(eventSessionId: string | undefined): boolean {
  // No gating when there is no session context (e.g. blank session_id on the
  // very first turn before the real id is assigned) — allow through.
  if (!eventSessionId) return true;
  return _selectedSessionId === eventSessionId;
}

// ── Listener installation ──────────────────────────────────────────────────

let installed = false;

export function installPermissionModalListener(): void {
  if (installed) return;
  installed = true;

  const ev = window.__TAURI__?.event;
  if (!ev?.listen) return;

  ev.listen<PermissionRequestedPayload>("permission-requested", (event) => {
    if (!isForSelectedSession(event.payload.session_id)) return;
    showPermissionModal(event.payload);
  });

  ev.listen<QuestionRequestedPayload>("question-requested", (event) => {
    if (!isForSelectedSession(event.payload.session_id)) return;
    showQuestionModal(event.payload);
  });
}
