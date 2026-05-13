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

import { invoke } from "../../shared/ipc";
import { escapeHtml } from "../../shared/escape-html";

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
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

interface QuestionRequestedPayload {
  id: string;
  questions: Question | Question[];
  session_id?: string;
}

type Answers = Record<string, string | string[]>;

/**
 * Format answers as plain text so claude can read them in the permission
 * tool's `deny.message` field. Headless `claude -p` has no native way to
 * receive structured answers from the built-in `AskUserQuestion` tool, but
 * a denied-permission message is surfaced to claude as user feedback.
 */
function formatAnswersAsMessage(questions: Question[], answers: Answers): string {
  const lines: string[] = ["User answered the question(s):"];
  for (const q of questions) {
    const a = answers[q.question];
    if (a == null) continue;
    const formatted = Array.isArray(a) ? a.join(", ") : a;
    lines.push(`Q: ${q.question}`);
    lines.push(`A: ${formatted}`);
  }
  return lines.join("\n");
}

// ── Host placement ─────────────────────────────────────────────────────────

const HOST_ID = "prompt-card-host";

/**
 * Pick the best mount point for the floating card:
 * 1. Active `.session-composer` (anchors above it via `bottom: 100%`).
 * 2. `.session-pane` if no composer (e.g. read-only).
 * 3. `document.body` (fallback, fixed bottom).
 */
function ensureHost(): { host: HTMLElement; mode: "composer" | "pane" | "viewport" } {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;

  const composer = document.querySelector<HTMLElement>(".session-composer");
  if (composer) {
    host.classList.add("prompt-card-host--composer");
    composer.appendChild(host);
    return { host, mode: "composer" };
  }
  const pane = document.querySelector<HTMLElement>(".session-pane");
  if (pane) {
    host.classList.add("prompt-card-host--pane");
    pane.appendChild(host);
    return { host, mode: "pane" };
  }
  host.classList.add("prompt-card-host--viewport");
  document.body.appendChild(host);
  return { host, mode: "viewport" };
}

function clearHost(): void {
  document.getElementById(HOST_ID)?.remove();
}

// ── Card skeleton ──────────────────────────────────────────────────────────

function renderCardShell(titleHtml: string, bodyHtml: string, footerHtml: string): string {
  return `
    <div class="prompt-card" role="dialog" aria-modal="false">
      <div class="prompt-card__header">${titleHtml}</div>
      <div class="prompt-card__body">${bodyHtml}</div>
      <div class="prompt-card__footer">${footerHtml}</div>
    </div>
  `;
}

// ── Question shape detection ────────────────────────────────────────────────

/**
 * If `input` looks like an AskUserQuestion payload (`{questions: [...]}` with
 * at least one well-formed question), return the normalized array. Otherwise
 * null. Used to route permission requests for question-shaped tools through
 * the question UI instead of a JSON dump + Allow/Deny.
 */
function extractQuestions(input: unknown): Question[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Question[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string") return null;
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? (q.options as unknown[]).flatMap((o) => {
            if (!o || typeof o !== "object") return [];
            const oo = o as Record<string, unknown>;
            if (typeof oo.label !== "string") return [];
            return [{
              label: oo.label,
              description: typeof oo.description === "string" ? oo.description : undefined,
            }];
          })
        : undefined,
    });
  }
  return out;
}

// ── Question UI (shared by permission + question events) ────────────────────

interface QuestionUIOpts {
  questions: Question[];
  titleIcon: string;
  titleText: string;
  rightChipHtml?: string;
  submitLabel: string;
  submitIcon: string;
  /** Called with collected answers when user submits. */
  onSubmit: (answers: Answers) => void | Promise<void>;
  /** Called when user cancels/dismisses (Esc, Skip, Deny). */
  onCancel: () => void | Promise<void>;
  cancelLabel: string;
}

type Selection = string | Set<string>;

function renderQuestionUI(opts: QuestionUIOpts): void {
  const { host } = ensureHost();
  const { questions } = opts;

  const selections = new Map<number, Selection>();
  questions.forEach((q, i) => {
    if (q.multiSelect) selections.set(i, new Set<string>());
  });

  const teardown = () => {
    clearHost();
    document.removeEventListener("keydown", escHandler);
  };

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      teardown();
      void opts.onCancel();
    }
  };
  document.addEventListener("keydown", escHandler);

  const submit = () => {
    const answers: Answers = {};
    questions.forEach((q, i) => {
      const s = selections.get(i);
      if (q.multiSelect) {
        answers[q.question] = Array.from((s as Set<string> | undefined) ?? []);
      } else if (typeof s === "string") {
        answers[q.question] = s;
      }
    });
    teardown();
    void opts.onSubmit(answers);
  };

  const cancel = () => {
    teardown();
    void opts.onCancel();
  };

  const isQuestionAnswered = (qi: number): boolean => {
    const q = questions[qi];
    if (!q?.options?.length) return true;
    const s = selections.get(qi);
    if (q.multiSelect) return s instanceof Set && s.size > 0;
    return typeof s === "string";
  };

  let activeTab = 0;
  let firstRender = true;
  const render = () => {
    const title = `
      <span class="prompt-card__title">
        <i class="ph ${opts.titleIcon}"></i>
        ${escapeHtml(opts.titleText)}
      </span>
      ${opts.rightChipHtml ?? ""}
    `;

    const showTabs = questions.length > 1;
    const tabsHtml = showTabs
      ? `<div class="prompt-tabs" role="tablist">
          ${questions.map((q, qi) => {
            const label = q.header?.trim() || `Question ${qi + 1}`;
            const answered = isQuestionAnswered(qi);
            const isActive = qi === activeTab;
            return `
              <button type="button" role="tab" class="prompt-tab${isActive ? " is-active" : ""}${answered ? " is-answered" : ""}" data-tab="${qi}" aria-selected="${isActive}">
                <span class="prompt-tab__dot"><i class="${answered ? "ph-fill ph-check-circle" : "ph ph-circle"}"></i></span>
                <span class="prompt-tab__label">${escapeHtml(label)}</span>
              </button>
            `;
          }).join("")}
        </div>`
      : "";

    const q = questions[activeTab];
    const qHeaderTag = !showTabs && q?.header
      ? `<span class="prompt-q__tag">${escapeHtml(q.header)}</span>`
      : "";
    const modeHtml = q?.options?.length
      ? `<span class="prompt-q__mode">${q.multiSelect ? "Select all that apply" : "Pick one"}</span>`
      : "";
    const rows = (q?.options ?? []).map((opt) => {
      const selected = q!.multiSelect
        ? (selections.get(activeTab) as Set<string> | undefined)?.has(opt.label) ?? false
        : selections.get(activeTab) === opt.label;
      const inputType = q!.multiSelect ? "checkbox" : "radio";
      const desc = opt.description
        ? `<span class="prompt-opt__desc">${escapeHtml(opt.description)}</span>`
        : "";
      return `
        <label class="prompt-opt${selected ? " is-selected" : ""}">
          <input type="${inputType}" name="q-${activeTab}" data-label="${escapeHtml(opt.label)}" ${selected ? "checked" : ""} />
          <span class="prompt-opt__body">
            <span class="prompt-opt__label">${escapeHtml(opt.label)}</span>
            ${desc}
          </span>
        </label>
      `;
    }).join("");

    const body = `
      ${tabsHtml}
      <div class="prompt-q" role="tabpanel">
        <div class="prompt-q__head">${qHeaderTag}${modeHtml}</div>
        <div class="prompt-q__text">${escapeHtml(q?.question ?? "")}</div>
        <div class="prompt-q__opts">${rows}</div>
      </div>
    `;

    const allAnswered = questions.every((_, i) => isQuestionAnswered(i));
    const submitDisabled = allAnswered ? "" : "disabled";
    const footer = `
      <button type="button" class="btn btn-secondary" data-act="cancel">${escapeHtml(opts.cancelLabel)}</button>
      <button type="button" class="btn btn-primary" data-act="submit" ${submitDisabled}>
        <i class="ph ${opts.submitIcon}"></i> ${escapeHtml(opts.submitLabel)}
      </button>
    `;

    host.innerHTML = renderCardShell(title, body, footer);
    if (!firstRender) {
      host.querySelector(".prompt-card")?.classList.add("prompt-card--no-anim");
    }
    firstRender = false;

    host.querySelectorAll<HTMLButtonElement>(".prompt-tab").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        const idx = Number(tabBtn.dataset.tab);
        if (Number.isFinite(idx)) {
          activeTab = idx;
          render();
        }
      });
    });

    host.querySelectorAll<HTMLInputElement>('.prompt-opt input').forEach((input) => {
      input.addEventListener("change", () => {
        const qi = activeTab;
        const label = input.dataset.label ?? "";
        const q = questions[qi];
        if (!q) return;
        if (q.multiSelect) {
          const set = (selections.get(qi) as Set<string> | undefined) ?? new Set<string>();
          if (input.checked) set.add(label); else set.delete(label);
          selections.set(qi, set);
        } else if (input.checked) {
          selections.set(qi, label);
        }
        // Single-select: auto-advance to next unanswered tab.
        if (!q.multiSelect && questions.length > 1) {
          const next = questions.findIndex((_, i) => i !== qi && !isQuestionAnswered(i));
          if (next >= 0) activeTab = next;
        }
        render();
      });
    });

    host.querySelector<HTMLButtonElement>('[data-act="submit"]')
      ?.addEventListener("click", submit);
    host.querySelector<HTMLButtonElement>('[data-act="cancel"]')
      ?.addEventListener("click", cancel);
  };

  render();
}

// ── Permission card ────────────────────────────────────────────────────────

function showPermissionCard(payload: PermissionRequestedPayload): void {
  // Question-shaped permission? Render the question UI directly. On submit,
  // route answers back as a deny.message so headless claude reads them as
  // user feedback (this is the only channel claude -p has for built-in
  // AskUserQuestion answers; see lifecycle.rs respond_permission doc).
  const questions = extractQuestions(payload.input);
  if (questions) {
    renderQuestionUI({
      questions,
      titleIcon: "ph-chat-circle-dots",
      titleText: "Claude is asking",
      rightChipHtml: `<span class="prompt-card__tool"><code>${escapeHtml(payload.tool_name)}</code></span>`,
      submitLabel: "Answer",
      submitIcon: "ph-paper-plane-right",
      cancelLabel: "Skip",
      onSubmit: async (answers) => {
        try {
          await invoke("respond_permission", {
            id: payload.id,
            behavior: "deny",
            updatedInput: null,
            message: formatAnswersAsMessage(questions, answers),
          });
        } catch (e) { console.warn("respond_permission failed:", e); }
      },
      onCancel: async () => {
        try {
          await invoke("respond_permission", {
            id: payload.id,
            behavior: "deny",
            updatedInput: null,
            message: "User skipped the question.",
          });
        } catch (e) { console.warn("respond_permission failed:", e); }
      },
    });
    return;
  }

  // Generic permission gate (Bash/Edit/Write/etc.)
  const { host } = ensureHost();

  const respond = async (behavior: "allow" | "deny") => {
    clearHost();
    document.removeEventListener("keydown", escHandler);
    try {
      await invoke("respond_permission", {
        id: payload.id,
        behavior,
        // On allow, echo the original input so claude proceeds unchanged.
        // On deny, omit updatedInput (backend builds the deny shape).
        updatedInput: behavior === "allow" ? (payload.input ?? {}) : null,
        message: behavior === "deny" ? "Denied by user." : null,
      });
    } catch (e) {
      console.warn("respond_permission failed:", e);
    }
  };
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") void respond("deny");
  };
  document.addEventListener("keydown", escHandler);

  const inputJson = JSON.stringify(payload.input ?? {}, null, 2);

  const title = `
    <span class="prompt-card__title">
      <i class="ph ph-shield-warning"></i>
      Permission requested
    </span>
    <span class="prompt-card__tool"><code>${escapeHtml(payload.tool_name)}</code></span>
  `;
  const body = `
    <details class="prompt-card__details">
      <summary>Tool input</summary>
      <pre class="prompt-card__pre"></pre>
    </details>
  `;
  const footer = `
    <button type="button" class="btn btn-secondary" data-act="deny">Deny</button>
    <button type="button" class="btn btn-primary" data-act="allow">
      <i class="ph ph-check"></i> Allow
    </button>
  `;

  host.innerHTML = renderCardShell(title, body, footer);
  host.querySelector<HTMLElement>(".prompt-card__pre")!.textContent = inputJson;

  host.querySelector<HTMLButtonElement>('[data-act="allow"]')!
    .addEventListener("click", () => void respond("allow"));
  host.querySelector<HTMLButtonElement>('[data-act="deny"]')!
    .addEventListener("click", () => void respond("deny"));
}

// ── Question event ─────────────────────────────────────────────────────────

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

function isForSelectedSession(eventSessionId: string | undefined): boolean {
  if (!eventSessionId) return true;
  if (_selectedSessionId === eventSessionId) return true;
  return _backgroundSessionIds.has(eventSessionId);
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
    showPermissionCard(event.payload);
  });

  ev.listen<QuestionRequestedPayload>("question-requested", (event) => {
    if (!isForSelectedSession(event.payload.session_id)) return;
    showQuestionCard(event.payload);
  });
}
