// Non-rendering concerns split out of question-ui.ts (ai_todo 262): payload
// normalization, the module-level "active card" draft registry, and the pure
// answer-completeness check. question-ui.ts re-exports these so existing
// importers (permission-card.ts, permission-modal/index.ts, gating.ts,
// active-session.ts) keep working unchanged.

import type { Answers, Question, QuestionDraft, Selection } from "./types";

/**
 * Pure "is this question answered" check, shared between the floating card's
 * own gating (via a per-index wrapper in question-ui.ts) and external callers
 * - e.g. the chat-transcript live-progress sync - that only have a raw
 * QuestionDraft, not question-ui.ts's closures.
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

// ── Module-level draft registry ─────────────────────────────────────────────
// The currently-shown question card, so a daemon "prompt-resolved" / expiry
// event can dismiss it from outside (e.g. it timed out, or was answered on
// another device). Only one card shows at a time. Owned here; question-ui.ts
// registers/clears it via setActiveCard/clearActiveCardIfCurrent rather than
// touching module state directly.
export interface ActiveQuestionCard {
  id: string;
  sessionId?: string;
  teardown: () => void;
  getDraft: () => QuestionDraft;
}

let activeCard: ActiveQuestionCard | null = null;

/** Register (or clear, with `null`) the live question card. Called by
 * question-ui.ts's renderQuestionUI once the card's teardown/getDraft
 * closures exist. */
export function setActiveCard(card: ActiveQuestionCard | null): void {
  activeCard = card;
}

/** Clear the registry only if it's still pointing at `teardown` - guards
 * against a stale card's own teardown() (e.g. fired after a newer card
 * already replaced it) wiping out that newer card. */
export function clearActiveCardIfCurrent(teardown: () => void): void {
  if (activeCard?.teardown === teardown) activeCard = null;
}

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
export function snapshotActiveCardDraft(sessionId: string): QuestionDraft | null {
  if (!activeCard || activeCard.sessionId !== sessionId) return null;
  return activeCard.getDraft();
}
