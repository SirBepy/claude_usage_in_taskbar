import { render } from "lit-html";
import { showView } from "../../shared/navigation";
import { template, detachedTemplate } from "./template";
import { invoke } from "../../shared/ipc";
import * as shortcuts from "../../shared/shortcuts";
import "../../shared/chat/chat.css";
import "./sessions.css";
import "./session-statusbar.css";
import "./project-picker.css";
import "./model-effort-modal.css";
import { startNewSession, launchNewSession, discardDraft } from "./pending-flow";
import { openModelEffortModal } from "./model-effort-modal";
import { selectSession } from "./active-session";
import { state, resetState, setActiveSession } from "./state";
import { loadSort, LS_SORT } from "./sessions-helpers";
import { renderSidebar, refreshSessions, openCtxMenu, closeCtxMenu } from "./sidebar";

let _pane: HTMLElement | null = null;
let _pendingOpenPicker = false;

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
    const idx = i;
    shortcuts.register(`open-chat-${i + 1}`, () => selectSessionByIndex(idx));
  }
  shortcuts.register("close-chat", closeFocusedChat);

  let unlistenCtrlHeld: (() => void) | null = shortcuts.onCtrlHeld((held) => {
    listEl.classList.toggle("kbd-hint-active", held);
  });

  // Initial load
  await refreshSessions();
  renderSidebar(listEl);
  updateThinkingBar();

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

    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
    if (!li) return;
    const id = li.dataset.sessionId;
    if (id) void (async () => { await selectSession(id, pane); updateThinkingBar(); })();
  });

  return () => {
    for (let i = 1; i <= 9; i++) shortcuts.unregister(`open-chat-${i}`);
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
