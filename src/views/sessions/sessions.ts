import { render } from "lit-html";
import { showView } from "../../shared/navigation";
import { template, detachedTemplate } from "./template";
import { invoke } from "../../shared/ipc";
import * as shortcuts from "../../shared/shortcuts";
import { showToast } from "../../shared/toast";
import "../../shared/chat/chat.css";
import "./sessions.css";
import "./session-statusbar.css";
import "./project-picker.css";
import "./model-effort-modal.css";
import { startNewSession, launchNewSession, discardDraft, resumeDraft, loadAndRestorePendingSession } from "./pending-flow";
import { openModelEffortModal } from "./model-effort-modal";
import { selectSession } from "./active-session";
import { state, resetState, setActiveSession } from "./state";
import { loadSort, LS_SORT, projectName } from "./sessions-helpers";
import { renderSidebar, refreshSessions, openCtxMenu, closeCtxMenu } from "./sidebar";

let _pane: HTMLElement | null = null;
let _pendingOpenPicker = false;
let _pendingHistoryResume: string | null = null;

export function queueHistoryResume(sessionId: string): void {
  _pendingHistoryResume = sessionId;
}

// ── Thinking indicator ────────────────────────────────────────────────────────

const THINKING_VERBS = [
  "Thinking", "Brainstorming", "Analyzing", "Pondering", "Computing",
  "Reflecting", "Synthesizing", "Reasoning", "Considering", "Processing",
  "Deliberating", "Formulating", "Examining", "Theorizing", "Musing",
];
let _verbIdx = 0;
let _verbTimer: number | null = null;

function isCurrentSessionBusy(): boolean {
  const pending = state.pendingNewSession;
  if (pending) {
    if (pending.realId) {
      return !!(state.sessions.find(s => s.session_id === pending.realId)?.busy);
    }
    // First message not yet sent = draft, no work in flight.
    if (!pending.firstMessageSent) return false;
    // First message sent, awaiting realId: show busy if placeholder active.
    return state.selectedId === pending.placeholderId;
  }
  return !!(state.sessions.find(s => s.session_id === state.selectedId)?.busy);
}

export function updateThinkingBar(): void {
  const pane = _pane;
  if (!pane) return;
  const bar = pane.querySelector<HTMLElement>(".session-thinking");
  if (!bar) return;
  const busy = isCurrentSessionBusy();
  if (busy) {
    if (bar.hasAttribute("hidden")) {
      bar.removeAttribute("hidden");
      _verbIdx = Math.floor(Math.random() * THINKING_VERBS.length);
      const tick = (): void => {
        bar.textContent = THINKING_VERBS[_verbIdx % THINKING_VERBS.length] + "…";
        _verbIdx++;
      };
      tick();
      _verbTimer = window.setInterval(tick, 1800);
    }
  } else {
    bar.setAttribute("hidden", "");
    if (_verbTimer !== null) { clearInterval(_verbTimer); _verbTimer = null; }
  }
}

export function triggerNewSessionGlobal(): void {
  if (_pane) {
    void startNewSession(_pane);
  } else {
    _pendingOpenPicker = true;
    showView("sessions");
  }
}

export function selectSessionByIndex(index: number): void {
  if (!_pane) return;
  const id = state.sortedSessionIds[index];
  if (id) void selectSession(id, _pane);
}

export function selectSessionBySlot(slot: number): void {
  if (!_pane) return;
  const sessionId = shortcuts.getSlotAssignment(slot);
  if (!sessionId) {
    showToast(`No chat assigned to slot ${slot} — press Ctrl+Shift+${slot} in a chat to assign it`);
    return;
  }
  const exists = state.sessions.find(s => s.session_id === sessionId);
  if (!exists) {
    showToast(`Chat assigned to slot ${slot} is no longer active`);
    return;
  }
  void selectSession(sessionId, _pane);
}

export function assignCurrentToSlot(slot: number): void {
  const id = state.selectedId;
  if (!id) { showToast("No active chat to assign"); return; }
  shortcuts.setSlotAssignment(slot, id);
  const sess = state.sessions.find(s => s.session_id === id);
  const label = sess ? projectName(sess) : id.slice(0, 8);
  showToast(`Slot ${slot} → ${label}`);
}

export function closeFocusedChat(): void {
  const id = state.selectedId;
  if (!id) return;
  const sess = state.sessions.find(s => s.session_id === id);
  if (!sess?.busy) return;
  void invoke<void>("cancel_turn", { sessionId: id });
}

export async function renderSessionsView(root: HTMLElement): Promise<() => void> {
  // Reset state on each mount; bump mountId so any pending async work from
  // a prior mount sees a stale id and bails.
  const myMount = resetState();
  loadAndRestorePendingSession();

  render(template(), root);

  const view = root.querySelector<HTMLElement>(".view-sessions");
  const listEl = root.querySelector<HTMLElement>("#sessions-list");
  const pane = root.querySelector<HTMLElement>("#session-pane");
  const newBtn = root.querySelector<HTMLButtonElement>("#newSessionBtn");

  if (!view || !listEl || !pane) {
    console.error("[sessions] view template missing expected nodes");
    return () => { /* no-op */ };
  }

  _pane = pane;
  if (_pendingOpenPicker) {
    _pendingOpenPicker = false;
    void startNewSession(pane);
  }

  // Register chats-view shortcuts
  for (let i = 0; i < 9; i++) {
    const slot = i + 1;
    shortcuts.register(`open-chat-${slot}`, () => {
      if (shortcuts.getChatSlotMode() === "manual") {
        selectSessionBySlot(slot);
      } else {
        selectSessionByIndex(i);
      }
    });
    shortcuts.register(`assign-slot-${slot}`, () => assignCurrentToSlot(slot));
  }
  shortcuts.register("close-chat", closeFocusedChat);

  let unlistenCtrlHeld: (() => void) | null = shortcuts.onCtrlHeld((held) => {
    listEl.classList.toggle("kbd-hint-active", held);
  });

  // Initial load
  await refreshSessions();
  renderSidebar(listEl);
  updateThinkingBar();

  // If the user clicked "Continue this chat" in the History view, auto-select
  // the resumed session (it was registered in the registry before navigation).
  if (_pendingHistoryResume) {
    const sid = _pendingHistoryResume;
    _pendingHistoryResume = null;
    if (state.sessions.find(s => s.session_id === sid)) {
      await selectSession(sid, pane);
      updateThinkingBar();
    }
  }

  // Subscribe to live registry updates
  const ev = window.__TAURI__?.event;
  if (ev?.listen) {
    state.unlistenInstances = await ev.listen("instances-changed", async () => {
      if (state.mountId !== myMount) return;
      await refreshSessions();
      if (state.mountId !== myMount) return;
      renderSidebar(listEl);
      updateThinkingBar();
      // If the previously-selected session vanished (e.g. takeover renamed it,
      // or it was ended externally), clear the pane to avoid stale content.
      // Skip this check while a new-session turn is pending: state.selectedId
      // is the placeholder id (not in the registry), and clearing the pane
      // would tear down the in-flight renderer mid-stream.
      if (
        !state.pendingNewSession &&
        state.selectedId &&
        !state.sessions.find((s) => s.session_id === state.selectedId)
      ) {
        if (state.renderer) state.renderer.detach();
        state.renderer = null;
        state.composer?.destroy();
        state.composer = null;
        setActiveSession(null);
        pane.innerHTML = `<div class="session-empty">Select or create a session</div>`;
      }
    });
  }

  // Wire +New
  if (newBtn) {
    newBtn.disabled = false;
    newBtn.title = "New session";
    newBtn.addEventListener("click", () => void startNewSession(pane));
  }


  const sortSelect = root.querySelector<HTMLSelectElement>("#sessions-sort");
  if (sortSelect) {
    sortSelect.value = loadSort();
    sortSelect.addEventListener("change", () => {
      try { localStorage.setItem(LS_SORT, sortSelect.value); } catch { /* ignore */ }
      renderSidebar(listEl);
    });
  }

  listEl.addEventListener("click", (e) => {
    // Discard-draft button intercept (sits on the pending row, no session_id).
    const discardBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-discard-draft]");
    if (discardBtn) {
      e.stopPropagation();
      discardDraft(pane);
      updateThinkingBar();
      return;
    }

    // 3-dot menu button intercept
    const menuBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".session-row-menu-btn");
    if (menuBtn) {
      e.stopPropagation();
      const sid = menuBtn.dataset.sessionId;
      if (sid) openCtxMenu(sid, menuBtn, {
        onNewHere: (project) => {
          void (async () => {
            const config = await openModelEffortModal(project.path, project.name);
            if (!config) return;
            await launchNewSession(pane, project, config);
          })();
        },
      });
      return;
    }

    // Draft row click: re-open the pending pane.
    const draftLi = (e.target as HTMLElement).closest<HTMLLIElement>("li.pending.draft");
    if (draftLi) {
      void (async () => { await resumeDraft(pane); updateThinkingBar(); })();
      return;
    }

    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
    if (!li) return;
    const id = li.dataset.sessionId;
    if (id) void (async () => { await selectSession(id, pane); updateThinkingBar(); })();
  });

  return () => {
    for (let i = 1; i <= 9; i++) {
      shortcuts.unregister(`open-chat-${i}`);
      shortcuts.unregister(`assign-slot-${i}`);
    }
    shortcuts.unregister("close-chat");
    if (unlistenCtrlHeld) { unlistenCtrlHeld(); unlistenCtrlHeld = null; }
    closeCtxMenu();
    teardownState();
  };
}

/**
 * Shared teardown: detach renderer/composer/statusbar, drop instance
 * listener, clear active session, drop the cached pane reference. Used by
 * both the main view and the detached-window entry.
 */
function teardownState(): void {
  if (_verbTimer !== null) { clearInterval(_verbTimer); _verbTimer = null; }
  _pane = null;
  if (state.unlistenInstances) {
    try { state.unlistenInstances(); } catch { /* ignore */ }
    state.unlistenInstances = null;
  }
  if (state.renderer) {
    state.renderer.detach();
    state.renderer = null;
  }
  if (state.statusbar) {
    state.statusbar.destroy();
    state.statusbar = null;
  }
  state.composer?.destroy();
  state.composer = null;
  setActiveSession(null);
}

/**
 * Detached-window entry point. Renders ONLY the chat pane for `sessionId`
 * (no sidebar, no header). Called from main.ts when the URL hash starts
 * with `#detached?session=...`. Reuses the same selectSession internals
 * for renderer + composer wiring.
 *
 * Returns a teardown closure that detaches the renderer.
 */
export async function renderDetachedSession(
  root: HTMLElement,
  sessionId: string,
): Promise<() => void> {
  const myMount = resetState();

  // Solo chat layout: just the .session-pane, no sidebar, no header burger.
  render(detachedTemplate(sessionId), root);

  const pane = root.querySelector<HTMLElement>("#session-pane");
  if (!pane) {
    console.error("[sessions] detached template missing #session-pane");
    return () => { /* no-op */ };
  }

  // We need state.sessions populated so selectSession can find the entry.
  await refreshSessions();
  if (state.mountId !== myMount) return () => { /* superseded */ };

  // Subscribe to instances-changed so the meta line refreshes if the
  // registry kind/busy/pid changes (e.g. takeover).
  const ev = window.__TAURI__?.event;
  if (ev?.listen) {
    state.unlistenInstances = await ev.listen("instances-changed", async () => {
      if (state.mountId !== myMount) return;
      await refreshSessions();
      // We don't have a sidebar to refresh here, but a follow-up could
      // re-render the header meta line.
    });
  }

  await selectSession(sessionId, pane);

  return teardownState;
}
