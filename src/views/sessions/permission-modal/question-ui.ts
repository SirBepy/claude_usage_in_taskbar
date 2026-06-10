import { escapeHtml } from "../../../shared/escape-html";
import { clearHost, ensureHost, renderCardShell } from "./host";
import type { Answers, Question, QuestionUIOpts, Selection } from "./types";

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

export function renderQuestionUI(opts: QuestionUIOpts): void {
  const { host } = ensureHost();
  const { questions } = opts;

  const selections = new Map<number, Selection>();
  const freeText = new Map<number, string>();
  questions.forEach((q, i) => {
    if (q.multiSelect) selections.set(i, new Set<string>());
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

  const teardown = () => {
    clearHost();
    document.removeEventListener("keydown", escHandler);
    if (resizeObs) { try { resizeObs.disconnect(); } catch { /* ignore */ } resizeObs = null; }
    if (messagesEl) {
      messagesEl.style.paddingBottom = savedPaddingBottom;
      messagesEl.scrollTop = savedScrollTop;
    }
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
      const typed = (freeText.get(i) ?? "").trim();
      const s = selections.get(i);
      if (q.multiSelect) {
        const set = Array.from((s as Set<string> | undefined) ?? []);
        if (typed) set.push(typed);
        answers[q.question] = set;
      } else if (typed) {
        answers[q.question] = typed;
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
    if ((freeText.get(qi) ?? "").trim()) return true;
    // multiSelect is "select all that apply" - zero selections is a valid
    // answer (none apply / answered via the free-text box), so never block it.
    if (q.multiSelect) return true;
    const s = selections.get(qi);
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

    const typedValue = freeText.get(activeTab) ?? "";
    const body = `
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
        const allAnsweredNow = questions.every((_, i) => isQuestionAnswered(i));
        const submitBtn = host.querySelector<HTMLButtonElement>('[data-act="submit"]');
        if (submitBtn) submitBtn.disabled = !allAnsweredNow;
        const tabBtn = host.querySelector<HTMLElement>(`.prompt-tab[data-tab="${activeTab}"]`);
        if (tabBtn) {
          tabBtn.classList.toggle("is-answered", isQuestionAnswered(activeTab));
          const dotIcon = tabBtn.querySelector("i");
          if (dotIcon) dotIcon.className = isQuestionAnswered(activeTab) ? "ph-fill ph-check-circle" : "ph ph-circle";
        }
        syncMessagesPadding();
      });
      otherEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (questions.every((_, i) => isQuestionAnswered(i))) submit();
        }
      });
    }

    host.querySelector<HTMLButtonElement>('[data-act="submit"]')
      ?.addEventListener("click", submit);
    host.querySelector<HTMLButtonElement>('[data-act="cancel"]')
      ?.addEventListener("click", cancel);

    requestAnimationFrame(() => syncMessagesPadding());
    if (!resizeObs && messagesEl && typeof ResizeObserver !== "undefined") {
      const card = host.querySelector<HTMLElement>(".prompt-card");
      if (card) {
        resizeObs = new ResizeObserver(() => syncMessagesPadding());
        resizeObs.observe(card);
      }
    }
  };

  render();
}

