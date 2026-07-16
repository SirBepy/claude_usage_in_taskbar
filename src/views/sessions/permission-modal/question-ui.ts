import { escapeHtml } from "../../../shared/escape-html";
import { registerOverlayBack } from "../../../shared/back-button";
import { clearHost, ensureHost, renderCardShell } from "./host";
import type { Answers, Question, QuestionDraft, QuestionUIOpts, Selection } from "./types";

/**
 * Pure "is this question answered" check, shared between the floating card's
 * own gating (via a per-index wrapper below) and external callers - e.g. the
 * chat-transcript live-progress sync - that only have a raw QuestionDraft, not
 * this module's closures.
 */
export function isQuestionAnswered(q: Question | undefined, freeText: string, selection: Selection | undefined): boolean {
  if (!q?.options?.length) return true;
  if (freeText.trim()) return true;
  if (q.multiSelect) return (selection instanceof Set ? selection.size : 0) > 0;
  return typeof selection === "string";
}

/**
 * Format answers as plain text so claude can read them in the permission
 * tool's `deny.message` field. Headless `claude -p` has no native way to
 * receive structured answers from the built-in `AskUserQuestion` tool, but
 * a denied-permission message is surfaced to claude as user feedback.
 */
export function formatAnswersAsMessage(questions: Question[], answers: Answers): string {
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

/**
 * If `input` looks like an AskUserQuestion payload (`{questions: [...]}` with
 * at least one well-formed question), return the normalized array. Otherwise
 * null. Used to route permission requests for question-shaped tools through
 * the question UI instead of a JSON dump + Allow/Deny.
 */
export function extractQuestions(input: unknown): Question[] | null {
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

// The currently-shown question card, so a daemon "prompt-resolved" / expiry
// event can dismiss it from outside (e.g. it timed out, or was answered on
// another device). Only one card shows at a time.
let activeCard: {
  id: string;
  sessionId?: string;
  teardown: () => void;
  getDraft: () => import("./types").QuestionDraft;
} | null = null;

/**
 * Dismiss the live question card if it matches `id` (or unconditionally when no
 * id is given). No-op if nothing matches - safe to call for an already-closed
 * or different card. Does NOT fire onCancel (the prompt already resolved).
 */
export function dismissQuestionCard(id?: string): void {
  if (!activeCard) return;
  if (id && activeCard.id !== id) return;
  activeCard.teardown();
}

/**
 * Return a snapshot of the active card's current answer state if it belongs to
 * the given session, without tearing it down. Returns null if no card is up or
 * the card belongs to a different session.
 */
export function snapshotActiveCardDraft(sessionId: string): import("./types").QuestionDraft | null {
  if (!activeCard || activeCard.sessionId !== sessionId) return null;
  return activeCard.getDraft();
}

// Synthetic option appended to every multiSelect question so "nothing
// applies" is an explicit, selectable answer instead of an implicit
// zero-selections state - lets isQuestionAnswered require a real choice
// (checkbox or free text) instead of treating an untouched question as done.
const NONE_LABEL = "None of the above";

export function renderQuestionUI(opts: QuestionUIOpts): void {
  const { host } = ensureHost();
  const questions: Question[] = opts.questions.map((q) => {
    if (!q.multiSelect || !q.options?.length) return q;
    if (q.options.some((o) => o.label === NONE_LABEL)) return q;
    return { ...q, options: [...q.options, { label: NONE_LABEL }] };
  });

  const selections = new Map<number, Selection>();
  const freeText = new Map<number, string>();
  if (opts.initialDraft) {
    opts.initialDraft.freeText.forEach((v, k) => freeText.set(k, v));
    opts.initialDraft.selections.forEach((v, k) => {
      selections.set(k, v instanceof Set ? new Set(v) : v);
    });
  }
  questions.forEach((q, i) => {
    if (q.multiSelect && !selections.has(i)) selections.set(i, new Set<string>());
  });

  const messagesEl = document.querySelector<HTMLElement>(".session-messages");
  const savedScrollTop = messagesEl?.scrollTop ?? 0;
  const savedPaddingBottom = messagesEl?.style.paddingBottom ?? "";
  let resizeObs: ResizeObserver | null = null;
  const syncMessagesPadding = (): void => {
    if (!messagesEl) return;
    const card = host.querySelector<HTMLElement>(".prompt-card");
    if (!card) return;
    messagesEl.style.paddingBottom = `${card.offsetHeight + 12}px`;
    messagesEl.scrollTop = messagesEl.scrollHeight - messagesEl.clientHeight;
  };

  // Phone back button skips the question (same as Escape / the Skip button) so
  // the card never traps the user, and the prompt resolves rather than silently
  // hiding. Registered below once `cancel` exists; disposed on teardown.
  let backDisposer: (() => void) | null = null;

  const teardown = () => {
    backDisposer?.();
    backDisposer = null;
    clearHost();
    document.removeEventListener("keydown", keydownHandler);
    if (resizeObs) { try { resizeObs.disconnect(); } catch { /* ignore */ } resizeObs = null; }
    if (messagesEl) {
      messagesEl.style.paddingBottom = savedPaddingBottom;
      messagesEl.scrollTop = savedScrollTop;
    }
    if (activeCard?.teardown === teardown) activeCard = null;
  };
  const currentDraft = (): QuestionDraft => ({
    freeText: new Map(freeText),
    selections: new Map(
      Array.from(selections.entries()).map(([k, v]) => [k, v instanceof Set ? new Set(v) : v])
    ),
    activeTab,
  });
  if (opts.id) {
    activeCard = {
      id: opts.id,
      sessionId: opts.sessionId,
      teardown,
      getDraft: currentDraft,
    };
  }

  const keydownHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      teardown();
      void opts.onCancel();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      triggerPrimaryShortcut();
    }
  };
  document.addEventListener("keydown", keydownHandler);

  // Per-question answer, normalized: multiSelect -> string[] (possibly empty,
  // always present), single-select/free-text -> string or null if unanswered.
  const answerFor = (qi: number): string | string[] | null => {
    const q = questions[qi];
    const typed = (freeText.get(qi) ?? "").trim();
    const s = selections.get(qi);
    if (q?.multiSelect) {
      const set = Array.from((s as Set<string> | undefined) ?? []);
      if (typed) set.push(typed);
      return set;
    }
    if (typed) return typed;
    if (typeof s === "string") return s;
    return null;
  };

  const submit = () => {
    const answers: Answers = {};
    questions.forEach((q, i) => {
      const a = answerFor(i);
      if (q.multiSelect) {
        answers[q.question] = a as string[];
      } else if (a != null) {
        answers[q.question] = a;
      }
    });
    teardown();
    void opts.onSubmit(answers);
  };

  const cancel = () => {
    teardown();
    void opts.onCancel();
  };

  backDisposer = registerOverlayBack(() => {
    cancel();
    return true;
  });

  const answeredAt = (qi: number): boolean =>
    isQuestionAnswered(questions[qi], freeText.get(qi) ?? "", selections.get(qi));

  const answerPreview = (qi: number): string => {
    const q = questions[qi];
    const a = answerFor(qi);
    if (q?.multiSelect) return (a as string[]).length ? (a as string[]).join(", ") : "Not answered";
    return typeof a === "string" && a ? a : "Not answered";
  };

  const showTabs = questions.length > 1;
  let isCollapsed = false;
  let activeTab = opts.initialDraft?.activeTab ?? 0;
  // Only meaningful when showTabs: "answer" is the per-question tab/form view,
  // "summary" is the final recap-before-send screen.
  let mode: "answer" | "summary" = "answer";
  let firstRender = true;

  const goNext = () => {
    activeTab = Math.min(activeTab + 1, questions.length - 1);
    render();
  };
  const goToSummary = () => {
    mode = "summary";
    render();
  };
  const goBackToAnswers = () => {
    mode = "answer";
    render();
  };
  const triggerPrimaryShortcut = () => {
    const allAnsweredNow = questions.every((_, i) => answeredAt(i));
    if (!showTabs || mode === "summary") {
      if (allAnsweredNow) submit();
      return;
    }
    if (!answeredAt(activeTab)) return;
    if (activeTab < questions.length - 1) goNext();
    else goToSummary();
  };

  const render = () => {
    const title = `
      <span class="prompt-card__title">
        <i class="ph ${opts.titleIcon}"></i>
        ${escapeHtml(opts.titleText)}
      </span>
      ${opts.rightChipHtml ?? ""}
    `;

    const isSummary = showTabs && mode === "summary";
    const tabsHtml = showTabs && !isSummary
      ? `<div class="prompt-tabs" role="tablist">
          ${questions.map((q, qi) => {
            const label = q.header?.trim() || `Question ${qi + 1}`;
            const answered = answeredAt(qi);
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
      const isNone = q!.multiSelect && opt.label === NONE_LABEL;
      return `
        <label class="prompt-opt${selected ? " is-selected" : ""}${isNone ? " prompt-opt--none" : ""}">
          <input type="${inputType}" name="q-${activeTab}" data-label="${escapeHtml(opt.label)}" ${selected ? "checked" : ""} />
          <span class="prompt-opt__body">
            <span class="prompt-opt__label">${escapeHtml(opt.label)}</span>
            ${desc}
          </span>
        </label>
      `;
    }).join("");

    const typedValue = freeText.get(activeTab) ?? "";
    const summaryRows = questions.map((sq, qi) => {
      const label = sq.header?.trim() || `Question ${qi + 1}`;
      const answered = answeredAt(qi);
      return `
        <button type="button" class="prompt-summary-row${answered ? "" : " is-unanswered"}" data-summary-tab="${qi}">
          <span class="prompt-summary-row__main">
            <span class="prompt-summary-row__label">${escapeHtml(label)}</span>
            <span class="prompt-summary-row__answer">${escapeHtml(answerPreview(qi))}</span>
          </span>
          <i class="ph ph-pencil-simple"></i>
        </button>
      `;
    }).join("");

    const body = isSummary
      ? `
        <div class="prompt-summary" role="tabpanel">
          <div class="prompt-summary__intro">Review your answers before sending:</div>
          ${summaryRows}
        </div>
      `
      : `
        ${tabsHtml}
        <div class="prompt-q" role="tabpanel">
          <div class="prompt-q__head">${qHeaderTag}${modeHtml}</div>
          <div class="prompt-q__text">${escapeHtml(q?.question ?? "")}</div>
          <div class="prompt-q__opts">${rows}</div>
          <label class="prompt-q__other">
            <span class="prompt-q__other-label">Or write something:</span>
            <textarea class="prompt-q__other-input" rows="1" placeholder="Type your own answer...">${escapeHtml(typedValue)}</textarea>
          </label>
        </div>
      `;

    const allAnswered = questions.every((_, i) => answeredAt(i));
    const submitDisabled = allAnswered ? "" : "disabled";
    let footer: string;
    if (!showTabs) {
      footer = `
        <button type="button" class="btn btn-secondary" data-act="cancel">${escapeHtml(opts.cancelLabel)}</button>
        <button type="button" class="btn btn-primary" data-act="submit" ${submitDisabled}>
          <i class="ph ${opts.submitIcon}"></i> ${escapeHtml(opts.submitLabel)}
        </button>
      `;
    } else if (isSummary) {
      footer = `
        <button type="button" class="btn btn-secondary" data-act="cancel">${escapeHtml(opts.cancelLabel)}</button>
        <button type="button" class="btn btn-secondary" data-act="back"><i class="ph ph-arrow-left"></i> Back</button>
        <button type="button" class="btn btn-primary" data-act="submit" ${submitDisabled}>
          <i class="ph ${opts.submitIcon}"></i> ${escapeHtml(opts.submitLabel)}
        </button>
      `;
    } else {
      const isLast = activeTab === questions.length - 1;
      const stepDisabled = answeredAt(activeTab) ? "" : "disabled";
      footer = `
        <button type="button" class="btn btn-secondary" data-act="cancel">${escapeHtml(opts.cancelLabel)}</button>
        <button type="button" class="btn btn-primary" data-act="${isLast ? "review" : "next"}" ${stepDisabled}>
          <i class="ph ${isLast ? "ph-list-checks" : "ph-arrow-right"}"></i> ${isLast ? "Review" : "Next"}
        </button>
      `;
    }

    host.innerHTML = renderCardShell(title, body, footer);
    const card = host.querySelector<HTMLElement>(".prompt-card");
    if (!firstRender) card?.classList.add("prompt-card--no-anim");
    firstRender = false;

    if (card) {
      if (isCollapsed) card.classList.add("prompt-card--collapsed");
      const header = card.querySelector<HTMLElement>(".prompt-card__header");
      if (header) {
        const collapseBtn = document.createElement("button");
        collapseBtn.type = "button";
        collapseBtn.className = "prompt-card__collapse";
        collapseBtn.setAttribute("aria-label", isCollapsed ? "Expand" : "Collapse");
        collapseBtn.innerHTML = `<i class="ph ${isCollapsed ? "ph-caret-up" : "ph-caret-down"}"></i>`;
        collapseBtn.addEventListener("click", () => {
          isCollapsed = !isCollapsed;
          card.classList.toggle("prompt-card--collapsed", isCollapsed);
          collapseBtn.setAttribute("aria-label", isCollapsed ? "Expand" : "Collapse");
          const icon = collapseBtn.querySelector("i");
          if (icon) icon.className = `ph ${isCollapsed ? "ph-caret-up" : "ph-caret-down"}`;
          requestAnimationFrame(() => syncMessagesPadding());
        });
        header.appendChild(collapseBtn);
      }
    }

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
          if (label === NONE_LABEL) {
            // Exclusive: picking "None of the above" clears every other pick.
            set.clear();
            if (input.checked) set.add(NONE_LABEL);
          } else if (input.checked) {
            set.delete(NONE_LABEL);
            set.add(label);
          } else {
            set.delete(label);
          }
          selections.set(qi, set);
        } else if (input.checked) {
          selections.set(qi, label);
        }
        // Single-select: auto-advance to next unanswered tab.
        if (!q.multiSelect && questions.length > 1) {
          const next = questions.findIndex((_, i) => i !== qi && !answeredAt(i));
          if (next >= 0) activeTab = next;
        }
        render();
      });
    });

    const otherEl = host.querySelector<HTMLTextAreaElement>(".prompt-q__other-input");
    if (otherEl) {
      const autoSize = () => {
        otherEl.style.height = "auto";
        otherEl.style.height = `${Math.min(otherEl.scrollHeight, 160)}px`;
      };
      autoSize();
      otherEl.addEventListener("input", () => {
        freeText.set(activeTab, otherEl.value);
        autoSize();
        const allAnsweredNow = questions.every((_, i) => answeredAt(i));
        const submitBtn = host.querySelector<HTMLButtonElement>('[data-act="submit"]');
        if (submitBtn) submitBtn.disabled = !allAnsweredNow;
        const stepBtn = host.querySelector<HTMLButtonElement>('[data-act="next"], [data-act="review"]');
        if (stepBtn) stepBtn.disabled = !answeredAt(activeTab);
        const tabBtn = host.querySelector<HTMLElement>(`.prompt-tab[data-tab="${activeTab}"]`);
        if (tabBtn) {
          tabBtn.classList.toggle("is-answered", answeredAt(activeTab));
          const dotIcon = tabBtn.querySelector("i");
          if (dotIcon) dotIcon.className = answeredAt(activeTab) ? "ph-fill ph-check-circle" : "ph ph-circle";
        }
        syncMessagesPadding();
        opts.onDraftChange?.(currentDraft());
      });
    }

    host.querySelector<HTMLButtonElement>('[data-act="submit"]')
      ?.addEventListener("click", submit);
    host.querySelector<HTMLButtonElement>('[data-act="cancel"]')
      ?.addEventListener("click", cancel);
    host.querySelector<HTMLButtonElement>('[data-act="next"]')
      ?.addEventListener("click", goNext);
    host.querySelector<HTMLButtonElement>('[data-act="review"]')
      ?.addEventListener("click", goToSummary);
    host.querySelector<HTMLButtonElement>('[data-act="back"]')
      ?.addEventListener("click", goBackToAnswers);
    host.querySelectorAll<HTMLButtonElement>('[data-summary-tab]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.summaryTab);
        if (Number.isFinite(idx)) {
          activeTab = idx;
          mode = "answer";
          render();
        }
      });
    });

    requestAnimationFrame(() => syncMessagesPadding());
    if (!resizeObs && messagesEl && typeof ResizeObserver !== "undefined") {
      const card = host.querySelector<HTMLElement>(".prompt-card");
      if (card) {
        resizeObs = new ResizeObserver(() => syncMessagesPadding());
        resizeObs.observe(card);
      }
    }
    opts.onDraftChange?.(currentDraft());
  };

  render();
}

