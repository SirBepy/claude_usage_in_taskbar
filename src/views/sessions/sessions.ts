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
import { discardComposerDraft, moveComposerDraft } from "../../shared/chat/composer";
import { openModelEffortModal } from "./model-effort-modal";
import { selectSession, unwatchCurrentExternalSession } from "./active-session";
import { state, resetState, setActiveSession, loadLastSelectedSession } from "./state";
import { loadSort, LS_SORT, projectName, sessionSubtitle } from "./sessions-helpers";
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
  "Investigating", "Planning", "Exploring", "Crafting", "Evaluating",
  "Generating", "Contemplating", "Inferring", "Calculating", "Researching",
  "Strategizing", "Conceptualizing", "Working", "Iterating", "Revising",
];
let _activeActivity: string | null = null;
// The one-shot verb for the current turn's initial gap (before the first real
// action). Sticky until a real action arrives or the turn resets.
let _gapVerb: string | null = null;

export function setThinkingActivity(s: string | null): void {
  _activeActivity = s;
  // Null = turn boundary: drop the gap verb so the next turn picks a fresh one.
  if (s === null) _gapVerb = null;
  updateThinkingBar();
}

function isCurrentSessionBusy(): boolean {
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
  if (!busy) {
    bar.setAttribute("hidden", "");
    _activeActivity = null;
    _gapVerb = null;
    return;
  }
  bar.removeAttribute("hidden");
  // A real tool action takes priority and stays pinned until the next action
  // (or the turn resets). Only the initial gap - before any action this turn -
  // shows a single random verb.
  if (_activeActivity) {
    bar.textContent = _activeActivity;
    return;
  }
  if (_gapVerb === null) {
    _gapVerb = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)] + "…";
  }
  bar.textContent = _gapVerb;
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

function discardStuckPending(pane: HTMLElement): void {
  const pending = state.pendingNewSession;
  if (!pending) return;
  if (!confirm("Discard this stuck session attempt?")) return;
  void (async () => {
    const target = pending.realId ?? pending.placeholderId;
    try { await invoke<void>("cancel_turn", { sessionId: target }); } catch { /* best-effort */ }
    if (pending.realId) {
      try { await invoke<void>("clear_session", { sessionId: pending.realId }); } catch { /* best-effort */ }
    }
    discardDraft(pane);
    updateThinkingBar();
  })();
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
  } else if (!state.pendingNewSession && !state.selectedId) {
    // Restore the last-viewed session across reloads. Skipped when a pending
    // draft was just restored (it owns the active pane) or when history-resume
    // already picked one above.
    const lastId = loadLastSelectedSession();
    if (lastId && state.sessions.find(s => s.session_id === lastId)) {
      await selectSession(lastId, pane);
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
      // Live-update the pane header title when the session name resolves.
      if (state.selectedId && !state.pendingNewSession) {
        const sess = state.sessions.find((s) => s.session_id === state.selectedId);
        if (sess) {
          const titleEl = pane.querySelector<HTMLElement>(".session-header .title");
          if (titleEl) {
            const newTitle = sessionSubtitle(sess);
            if (titleEl.textContent !== newTitle) titleEl.textContent = newTitle;
          }
        }
      }
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
      // If the selected session's kind changed (e.g. Interactive -> External
      // after "Open in Terminal"), the pane must re-render to show the correct
      // read-only UI. Detect by comparing pane DOM vs current kind.
      if (!state.pendingNewSession && state.selectedId) {
        const updatedSess = state.sessions.find((s) => s.session_id === state.selectedId);
        if (updatedSess) {
          const paneIsReadOnly = !!pane.querySelector(".readonly-banner");
          const sessIsReadOnly = updatedSess.kind === "external";
          if (paneIsReadOnly !== sessIsReadOnly) {
            const reloadId = state.selectedId;
            setActiveSession(null);
            await selectSession(reloadId, pane);
          }
        }
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
    // Discard parked draft (X on a parked row).
    const discardParkedBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-discard-parked]");
    if (discardParkedBtn) {
      e.stopPropagation();
      const pid = discardParkedBtn.dataset.discardParked;
      if (pid) {
        state.parkedDrafts = state.parkedDrafts.filter(d => d.placeholderId !== pid);
        discardComposerDraft(pid);
        renderSidebar(listEl);
      }
      return;
    }

    // Click on a parked draft row body: resume it as a new draft.
    const parkedLi = (e.target as HTMLElement).closest<HTMLLIElement>("li.parked-draft[data-placeholder-id]");
    if (parkedLi) {
      const pid = parkedLi.dataset.placeholderId;
      if (pid) {
        const draft = state.parkedDrafts.find(d => d.placeholderId === pid);
        if (draft) {
          const oldPid = draft.placeholderId;
          state.parkedDrafts = state.parkedDrafts.filter(d => d.placeholderId !== pid);
          void (async () => {
            await launchNewSession(pane, { path: draft.projectPath, name: draft.projectName }, draft.config);
            const newPid = state.pendingNewSession?.placeholderId;
            if (newPid && newPid !== oldPid) {
              moveComposerDraft(oldPid, newPid);
              state.composer?.setSessionId(newPid, { readOnly: false });
            }
            updateThinkingBar();
          })();
        }
      }
      return;
    }

    // Discard-draft button intercept (sits on the pending row, no session_id).
    const discardBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-discard-draft]");
    if (discardBtn) {
      e.stopPropagation();
      discardDraft(pane);
      updateThinkingBar();
      return;
    }

    // Discard-stuck button: visible on the "starting..." pending row so the
    // user can bail out when start_session never completes (typically after
    // the app crashed mid-spawn and the pending state was restored from
    // localStorage on the next launch).
    const stuckBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-discard-stuck]");
    if (stuckBtn) {
      e.stopPropagation();
      discardStuckPending(pane);
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

    // Starting pending row click. Two cases:
    //   - realId already known (SessionStarted fired): navigate to the real
    //     session so the user can see what's going on. The pending row stays
    //     visible until start_session resolves; click on the X button (handled
    //     above via [data-discard-stuck]) is still the only way to abort.
    //   - realId not yet known: leave the click as a no-op. The X button on
    //     the row handles discard; clicking the row body shouldn't trigger a
    //     destructive confirm dialog.
    const startingLi = (e.target as HTMLElement).closest<HTMLLIElement>("li.pending:not(.draft)");
    if (startingLi && startingLi.dataset.pending === "1") {
      const pending = state.pendingNewSession;
      const realId = pending?.realId;
      if (realId) {
        void (async () => { await selectSession(realId, pane); updateThinkingBar(); })();
      }
      return;
    }

    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
    if (!li) return;
    const id = li.dataset.sessionId;
    if (id) void (async () => { await selectSession(id, pane); updateThinkingBar(); })();
  });

  const onViewDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    view.classList.add("drag-over");
  };
  const onViewDragLeave = (e: DragEvent) => {
    if (e.relatedTarget && view.contains(e.relatedTarget as Node)) return;
    view.classList.remove("drag-over");
  };
  const onViewDrop = async (e: Event) => {
    e.preventDefault();
    view.classList.remove("drag-over");
    const drag = e as DragEvent;
    if (!drag.dataTransfer?.files.length) return;
    if (!state.composer) return;
    await state.composer.dropFiles(Array.from(drag.dataTransfer.files));
  };
  view.addEventListener("dragover", onViewDragOver);
  view.addEventListener("dragleave", onViewDragLeave);
  view.addEventListener("drop", onViewDrop);

  return () => {
    view.removeEventListener("dragover", onViewDragOver);
    view.removeEventListener("dragleave", onViewDragLeave);
    view.removeEventListener("drop", onViewDrop);
    view.classList.remove("drag-over");
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
  _activeActivity = null;
  _gapVerb = null;
  unwatchCurrentExternalSession();
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
      // Live-update the pane header title when the session name resolves.
      if (state.selectedId) {
        const sess = state.sessions.find((s) => s.session_id === state.selectedId);
        if (sess) {
          const titleEl = pane.querySelector<HTMLElement>(".session-header .title");
          if (titleEl) {
            const newTitle = sessionSubtitle(sess);
            if (titleEl.textContent !== newTitle) titleEl.textContent = newTitle;
          }
        }
      }
    });
  }

  await selectSession(sessionId, pane);

  return teardownState;
}
