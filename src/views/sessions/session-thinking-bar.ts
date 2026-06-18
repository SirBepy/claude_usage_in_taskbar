import { state } from "./state";

const THINKING_VERBS = [
  "Thinking", "Brainstorming", "Analyzing", "Pondering", "Computing",
  "Reflecting", "Synthesizing", "Reasoning", "Considering", "Processing",
  "Deliberating", "Formulating", "Examining", "Theorizing", "Musing",
  "Investigating", "Planning", "Exploring", "Crafting", "Evaluating",
  "Generating", "Contemplating", "Inferring", "Calculating", "Researching",
  "Strategizing", "Conceptualizing", "Working", "Iterating", "Revising",
];
let _activeActivity: string | null = null;
// The one-shot verb for the current turn's initial gap (before the first real
// action). Sticky until a real action arrives or the turn resets.
let _gapVerb: string | null = null;
let _pane: HTMLElement | null = null;

export function initThinkingBar(pane: HTMLElement | null): void {
  _pane = pane;
}

export function setThinkingActivity(s: string | null): void {
  _activeActivity = s;
  // Null = turn boundary: drop the gap verb so the next turn picks a fresh one.
  if (s === null) _gapVerb = null;
  updateThinkingBar();
}

export function isCurrentSessionBusy(): boolean {
  const pending = state.pendingNewSession;
  if (pending) {
    // selectedId stays as placeholderId for the whole turn; only applies to
    // the pane that's actually showing the pending session.
    if (state.selectedId !== pending.placeholderId) {
      // User switched to a different session — check that session instead.
      return !!(state.sessions.find(s => s.session_id === state.selectedId)?.busy);
    }
    if (pending.realId) {
      return !!(state.sessions.find(s => s.session_id === pending.realId)?.busy);
    }
    // First message not yet sent = draft, no work in flight.
    if (!pending.firstMessageSent) return false;
    // First message sent, awaiting realId: show busy if placeholder active.
    return true;
  }
  return !!(state.sessions.find(s => s.session_id === state.selectedId)?.busy);
}

export function updateThinkingBar(): void {
  const pane = _pane;
  if (!pane) return;
  const bar = pane.querySelector<HTMLElement>(".session-thinking");
  if (!bar) return;
  const busy = isCurrentSessionBusy();
  // The bar also hosts the held-messages chip, which can outlive the turn (an
  // auto-flush deferred while the user is typing). Show it while busy OR while
  // held items exist for the active session.
  const hasHeld = !!state.heldMessages?.hasItemsForActive();
  const textEl = bar.querySelector<HTMLElement>(".thinking-text");
  bar.classList.toggle("busy", busy);
  // The header cancel button (pending pane) only belongs mid-turn; hide it while
  // drafting so "Cancel turn" never shows when there's no turn to cancel.
  const cancelBtn = pane.querySelector<HTMLButtonElement>(".cancel-btn");
  if (cancelBtn) cancelBtn.toggleAttribute("hidden", !busy);
  const pauseBtn = pane.querySelector<HTMLButtonElement>(".thinking-pause-btn");
  if (pauseBtn) pauseBtn.toggleAttribute("hidden", !(busy && !hasHeld));

  if (!busy && !hasHeld) {
    bar.setAttribute("hidden", "");
    if (textEl) textEl.textContent = "";
    _activeActivity = null;
    _gapVerb = null;
    state.heldMessages?.renderChip();
    return;
  }
  bar.removeAttribute("hidden");
  if (busy) {
    // A real tool action takes priority and stays pinned until the next action
    // (or the turn resets). Only the initial gap - before any action this turn -
    // shows a single random verb.
    if (_activeActivity) {
      if (textEl) textEl.textContent = _activeActivity;
    } else {
      if (_gapVerb === null) {
        _gapVerb = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)] + "…";
      }
      if (textEl) textEl.textContent = _gapVerb;
    }
  } else {
    // Not busy, only held items remain: no thinking text, just the chip.
    if (textEl) textEl.textContent = "";
    _activeActivity = null;
    _gapVerb = null;
  }
  state.heldMessages?.renderChip();
}
