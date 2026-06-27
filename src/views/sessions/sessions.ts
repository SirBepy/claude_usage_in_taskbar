import { render } from "lit-html";
import { template, detachedTemplate } from "./template";
import { invoke } from "../../shared/ipc";
import * as shortcuts from "../../shared/shortcuts";
import "../../shared/chat/chat.css";
import "./sessions.css";
import "./session-avatar.css";
import "./session-statusbar.css";
import "./project-picker.css";
import "./model-effort-modal.css";
import "./new-project-modal.css";
import { startNewSession, launchNewSession, discardDraft, resumeDraft, loadAndRestorePendingSession } from "./pending-flow";
import { discardComposerDraft, moveComposerDraft } from "../../shared/chat/composer";
import { selectSession, unwatchCurrentExternalSession, updateHeaderAvatarStatus } from "./active-session";
import { state, resetState, setActiveSession, loadLastSelectedSession } from "./state";
import { initThinkingBar, updateThinkingBar } from "./session-thinking-bar";
import { sessionSubtitle, paneEmptyStateHtml } from "./sessions-helpers";
import { renderSidebar, refreshSessions, openCtxMenu, closeCtxMenu, openDraftCtxMenu } from "./sidebar";
import { loadSessionCharacters } from "./session-characters";
import { api } from "../../shared/api";
import { rateLimitBanner } from "../../shared/chat/rate-limit-banner";
import { sessionEvents } from "../../shared/chat/event-store";
import type { ContentBlock, ChatEvent } from "../../types/ipc.generated";
import {
  initWhenDone,
  subscribeWhenDone,
} from "./when-done";
import {
  closeViewMoreMenu,
  refreshViewMoreIndicator,
  rerenderViewMenuProtocol,
  toggleViewMoreMenu,
} from "./view-more-menu";
import {
  dismissQuestionCard,
  getSelectedSessionId,
  replayPendingPrompt,
} from "./permission-modal";
import {
  setPaneRef,
  consumePendingOpenPicker,
  consumePendingHistoryResume,
  consumePendingNewChat,
  selectSessionByIndex,
  selectSessionBySlot,
  assignCurrentToSlot,
  closeFocusedChat,
} from "./session-controls";
export {
  queueHistoryResume,
  queueSessionSelect,
  queueNewChat,
  triggerNewSessionGlobal,
  selectSessionByIndex,
  selectSessionBySlot,
  assignCurrentToSlot,
  closeFocusedChat,
} from "./session-controls";

/** Session ids for which we have already called ensureSessionCharacter this
 * runtime. Prevents redundant IPC chatter on every instances-changed event.
 * Cleared on unmount so a fresh mount re-ensures any sessions that appeared
 * while the view was hidden. */
const _ensuredSessionIds = new Set<string>();

// ── Daemon setup stall detection ──────────────────────────────────────────────

// If the daemon hasn't connected within this window, the sidebar's
// "Setting up..." spinner swaps to a visible warning (state.daemonSetupStalled)
// instead of spinning forever. The app's reconnect loop keeps retrying
// underneath; this is purely a surface so the user knows something is wrong.
const SETUP_STALL_MS = 15_000;
let _setupStallTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-render the pane's empty state (the centered "Setting up..." /
 * "Select or create a session" block) to match the current daemon state.
 * No-op while a session or draft occupies the pane.
 */
function refreshPaneEmptyState(pane: HTMLElement): void {
  if (!pane.querySelector(".session-empty")) return;
  pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
}

function armSetupStallTimer(listEl: HTMLElement, pane: HTMLElement, myMount: number): void {
  if (_setupStallTimer !== null) clearTimeout(_setupStallTimer);
  _setupStallTimer = setTimeout(() => {
    _setupStallTimer = null;
    if (state.mountId !== myMount) return;
    if (state.daemonConnected === true) return;
    state.daemonSetupStalled = true;
    renderSidebar(listEl);
    refreshPaneEmptyState(pane);
  }, SETUP_STALL_MS);
}

function disarmSetupStallTimer(): void {
  if (_setupStallTimer !== null) {
    clearTimeout(_setupStallTimer);
    _setupStallTimer = null;
  }
}

function discardStuckPending(pane: HTMLElement): void {
  const pending = state.pendingNewSession;
  if (!pending) return;
  // No confirm() guard: native confirm routes through the dialog plugin, which
  // is blocked by the ACL in this window. The X is already explicit intent.
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

export async function renderSessionsView(root: HTMLElement): Promise<() => void> {
  // Reset state on each mount; bump mountId so any pending async work from
  // a prior mount sees a stale id and bails.
  const myMount = resetState();
  _ensuredSessionIds.clear();
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

  setPaneRef(pane);
  state.launchNewChatCallback = (project, config) => { void launchNewSession(pane, project, config); };
  initThinkingBar(pane);

  // Clicking a pending "awaiting answer" chip in the chat dismisses any active
  // AUQ card and re-surfaces it. Handles the case where the modal somehow got
  // closed without answering (navigated away and back, dismissed by mistake).
  pane.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".tool-qa-a--pending")) return;
    const sid = getSelectedSessionId();
    if (!sid) return;
    dismissQuestionCard();
    replayPendingPrompt(sid);
  });

  // Mount the global rate-limit banner (top of the Chats window) and wire its
  // auto-continue to re-send "continue" to each interrupted chat on reset.
  const rlHost = root.querySelector<HTMLElement>("#rate-limit-banner-host");
  if (rlHost) rateLimitBanner.mount(rlHost);
  sessionEvents.setRateLimitHandler((sid, body) => rateLimitBanner.report(sid, body));
  rateLimitBanner.setSendContinue((sid) => {
    const sess = state.sessions.find((s) => s.session_id === sid);
    const blocks: ContentBlock[] = [{ type: "text", text: "continue" }];
    sessionEvents.pushSynthetic(sid, {
      type: "user_message",
      content: blocks,
      timestamp: BigInt(Date.now()),
    } as ChatEvent);
    void invoke<void>("send_message", { sessionId: sid, cwd: String(sess?.cwd ?? "."), blocks })
      .catch((err) => console.error("[rate-limit] auto-continue send failed", sid, err));
  });

  if (consumePendingOpenPicker()) {
    void startNewSession(pane);
  }

  // Wire the "more options" overflow button.
  const viewMoreBtn = root.querySelector<HTMLButtonElement>("#viewMoreBtn");
  if (viewMoreBtn) {
    viewMoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleViewMoreMenu(viewMoreBtn);
    });
  }

  // Hydrate + subscribe to the global sleep/shutdown-when-done protocol state.
  // The subscriber refreshes the more-button indicator dot and, if the menu is
  // open, live-updates its protocol section (toggles + countdown chip).
  const unlistenWhenDone = await initWhenDone();
  const unsubWhenDone = subscribeWhenDone(() => {
    refreshViewMoreIndicator();
    rerenderViewMenuProtocol();
  });
  refreshViewMoreIndicator();

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

  // Show setup indicator immediately (daemonConnected = null → centered
  // "Setting up..." in the pane; the sidebar stays blank until connected).
  renderSidebar(listEl);
  refreshPaneEmptyState(pane);
  armSetupStallTimer(listEl, pane, myMount);

  // Initial load - fetch sessions and daemon status in parallel
  const [, connected] = await Promise.all([
    refreshSessions(),
    invoke<boolean>("is_daemon_connected").catch(() => null),
    loadSessionCharacters(),
  ]);
  if (state.mountId === myMount) {
    state.daemonConnected = connected ?? null;
    if (connected === true) {
      state.daemonSetupStalled = false;
      disarmSetupStallTimer();
    }
    renderSidebar(listEl);
    refreshPaneEmptyState(pane);
    updateThinkingBar();
  }

  // Queued-chat / restore-selection flow. MUST NOT abort the mount: the click
  // and event listeners below are registered after this block, so an exception
  // here would leave the sidebar rendered but permanently unclickable (the
  // "I can't click any of the chats" failure). Restore is best-effort.
  try {
    // If a new chat was queued (e.g. project-detail "+"), launch it now. Takes
    // precedence over history-resume / last-selected restore.
    const pendingNew = consumePendingNewChat();
    if (pendingNew) {
      const { project, config } = pendingNew;
      await launchNewSession(pane, project, config);
      updateThinkingBar();
    } else {
      const sid = consumePendingHistoryResume();
      if (sid && state.sessions.find(s => s.session_id === sid)) {
        await selectSession(sid, pane);
        updateThinkingBar();
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
    }
  } catch (err) {
    console.error("[sessions] restore-selection failed; continuing mount", err);
  }

  // Subscribe to live registry updates
  const ev = window.__TAURI__?.event;
  let unlistenDaemonStatus: (() => void) | null = null;
  let unlistenSettingsChanged: (() => void) | null = null;
  if (ev?.listen) {
    // Re-resolve session hero assignments whenever a character changes
    // (ensure on appearance, manual pick, or re-roll), then repaint the sidebar.
    unlistenSettingsChanged = await ev.listen("settings-changed", async () => {
      if (state.mountId !== myMount) return;
      await loadSessionCharacters();
      if (state.mountId !== myMount) return;
      renderSidebar(listEl);
    });

    unlistenDaemonStatus = await ev.listen<{ connected: boolean }>("daemon-status-changed", (e) => {
      if (state.mountId !== myMount) return;
      state.daemonConnected = e.payload.connected;
      if (e.payload.connected) {
        state.daemonSetupStalled = false;
        disarmSetupStallTimer();
        // Re-sync on reconnect: the seed `instances-changed` from fetch_and_reseed_instances
        // fires before the JS listener at line 336 is registered and is silently lost.
        // Calling refreshSessions() here (after daemon-status-changed, which fires after
        // instances-changed in the Rust sequence) guarantees we get the live busy flags.
        void (async () => {
          await refreshSessions();
          if (state.mountId !== myMount) return;
          renderSidebar(listEl);
          updateThinkingBar();
          // If the initial mount's session restore failed (cached_instances was empty
          // at that point), try again now that the daemon is connected.
          if (!state.selectedId && !state.pendingNewSession) {
            const lastId = loadLastSelectedSession();
            if (lastId && state.sessions.find(s => s.session_id === lastId)) {
              await selectSession(lastId, pane);
              if (state.mountId !== myMount) return;
              updateThinkingBar();
            }
          }
        })();
      } else {
        armSetupStallTimer(listEl, pane, myMount);
      }
      renderSidebar(listEl);
      refreshPaneEmptyState(pane);
    });

    state.unlistenInstances = await ev.listen("instances-changed", async () => {
      if (state.mountId !== myMount) return;
      await refreshSessions();
      if (state.mountId !== myMount) return;

      // Ensure every newly-appeared live session gets a character assigned.
      // Track ensured ids so we don't re-call on every subsequent event.
      const liveSessions = state.sessions.filter((s) => !s.ended_at && !s.end_reason);
      const newOnes = liveSessions.filter((s) => !_ensuredSessionIds.has(s.session_id));
      if (newOnes.length > 0) {
        for (const s of newOnes) {
          _ensuredSessionIds.add(s.session_id);
        }
        await Promise.all(newOnes.map((s) => api.ensureSessionCharacter(s.session_id).catch(() => null)));
        if (state.mountId !== myMount) return;
        await loadSessionCharacters();
        if (state.mountId !== myMount) return;
      }

      renderSidebar(listEl);
      updateThinkingBar();
      // If the initial mount's session restore failed (daemon not yet connected),
      // restore now on the first instances-changed that populates the list.
      if (!state.selectedId && !state.pendingNewSession) {
        const lastId = loadLastSelectedSession();
        if (lastId && state.sessions.find(s => s.session_id === lastId)) {
          await selectSession(lastId, pane);
          if (state.mountId !== myMount) return;
          updateThinkingBar();
        }
      }
      // Live-update the pane header title when the session name resolves, and
      // recolour the header avatar's status ring (busy -> done, etc.).
      if (state.selectedId && !state.pendingNewSession) {
        const sess = state.sessions.find((s) => s.session_id === state.selectedId);
        if (sess) {
          const titleEl = pane.querySelector<HTMLElement>(".session-header .title");
          if (titleEl) {
            const newTitle = sessionSubtitle(sess);
            if (titleEl.textContent !== newTitle) titleEl.textContent = newTitle;
          }
          updateHeaderAvatarStatus(pane, sess);
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
        pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
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

  // Wire the floating "new chat" CTA on the chats list (same action as +New).
  const fab = root.querySelector<HTMLButtonElement>("#sessionsFab");
  fab?.addEventListener("click", () => void startNewSession(pane));

  // Mobile back button: return from the chat pane to the session list overlay.
  // Only visible on ≤768px in chat mode (CSS-driven); a no-op on desktop.
  const backBtn = root.querySelector<HTMLButtonElement>("#sessionsBackBtn");
  backBtn?.addEventListener("click", () => view.setAttribute("data-mobile-pane", "list"));


  // Sort select moved to Settings. No binding needed here; sessions.ts reads
  // the persisted localStorage value on each renderSidebar call via loadSort().

  // Right-click anywhere on a session row opens the same context menu the
  // hover-revealed ⋮ button does (the button stays for discoverability).
  listEl.addEventListener("contextmenu", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
    const sid = li?.dataset.sessionId;
    if (!li || !sid) return;
    e.preventDefault();
    openCtxMenu(sid, li);
  });

  listEl.addEventListener("click", (e) => {
    // All row menu buttons (3-dot) — handles live sessions, active drafts, and parked drafts.
    const menuBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".session-row-menu-btn");
    if (menuBtn) {
      e.stopPropagation();
      const sid = menuBtn.dataset.sessionId;
      const parkedPid = menuBtn.dataset.parkedPlaceholderId;
      if (sid) {
        openCtxMenu(sid, menuBtn);
      } else if (parkedPid) {
        openDraftCtxMenu(menuBtn, () => {
          state.parkedDrafts = state.parkedDrafts.filter(d => d.placeholderId !== parkedPid);
          discardComposerDraft(parkedPid);
          renderSidebar(listEl);
        });
      } else if (menuBtn.dataset.draftMenu === "1") {
        openDraftCtxMenu(menuBtn, () => {
          if (state.pendingNewSession?.firstMessageSent) discardStuckPending(pane);
          else { discardDraft(pane); updateThinkingBar(); }
        });
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
    if (id) {
      void (async () => { await selectSession(id, pane); updateThinkingBar(); })()
        .catch((err) => console.error(`[sessions] selectSession(${id}) failed`, err));
    }
  });

  let unlistenDragEnter: (() => void) | null = null;
  let unlistenDragLeave: (() => void) | null = null;
  let unlistenFileDrop: (() => void) | null = null;
  void (async () => {
    if (!ev?.listen) return;
    [unlistenDragEnter, unlistenDragLeave, unlistenFileDrop] = await Promise.all([
      ev.listen("tauri://drag-enter", () => { view.classList.add("drag-over"); }),
      ev.listen("tauri://drag-leave", () => { view.classList.remove("drag-over"); }),
      ev.listen<{ paths: string[] }>("tauri://drop", (e) => {
        view.classList.remove("drag-over");
        if (!state.composer || !e.payload.paths.length) return;
        void (async (composer, paths) => {
          for (const path of paths) await composer.attachFromPath(path);
        })(state.composer, e.payload.paths);
      }),
    ]);
  })();

  const onSessionClosed = (e: Event) => {
    const { sessionId } = (e as CustomEvent<{ sessionId: string }>).detail;
    if (state.selectedId !== sessionId) return;
    if (state.renderer) state.renderer.detach();
    state.renderer = null;
    state.composer?.destroy();
    state.composer = null;
    setActiveSession(null);
    pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
  };
  document.addEventListener("cc:session-closed", onSessionClosed);

  // When the Settings view changes the sort preference, rerender the sidebar.
  const onSortChanged = () => {
    if (state.mountId !== myMount) return;
    renderSidebar(listEl);
  };
  document.addEventListener("cc-sort-changed", onSortChanged);

  // view-more-menu dispatches this when the draft "Delete draft" is tapped.
  const onDiscardPendingDraft = () => {
    if (state.mountId !== myMount) return;
    if (state.pendingNewSession?.firstMessageSent) discardStuckPending(pane);
    else { discardDraft(pane); updateThinkingBar(); }
  };
  document.addEventListener("discard-pending-draft", onDiscardPendingDraft);

  return () => {
    document.removeEventListener("cc:session-closed", onSessionClosed);
    document.removeEventListener("cc-sort-changed", onSortChanged);
    document.removeEventListener("discard-pending-draft", onDiscardPendingDraft);
    if (unlistenDragEnter) { try { unlistenDragEnter(); } catch { /* ignore */ } unlistenDragEnter = null; }
    if (unlistenDragLeave) { try { unlistenDragLeave(); } catch { /* ignore */ } unlistenDragLeave = null; }
    if (unlistenFileDrop) { try { unlistenFileDrop(); } catch { /* ignore */ } unlistenFileDrop = null; }
    view.classList.remove("drag-over");
    for (let i = 1; i <= 9; i++) {
      shortcuts.unregister(`open-chat-${i}`);
      shortcuts.unregister(`assign-slot-${i}`);
    }
    shortcuts.unregister("close-chat");
    if (unlistenCtrlHeld) { unlistenCtrlHeld(); unlistenCtrlHeld = null; }
    closeCtxMenu();
    closeViewMoreMenu();
    unsubWhenDone();
    unlistenWhenDone();
    if (unlistenDaemonStatus) { try { unlistenDaemonStatus(); } catch { /* ignore */ } unlistenDaemonStatus = null; }
    if (unlistenSettingsChanged) { try { unlistenSettingsChanged(); } catch { /* ignore */ } unlistenSettingsChanged = null; }
    disarmSetupStallTimer();
    teardownState();
  };
}

/**
 * Shared teardown: detach renderer/composer/statusbar, drop instance
 * listener, clear active session, drop the cached pane reference. Used by
 * both the main view and the detached-window entry.
 */
function teardownState(): void {
  unwatchCurrentExternalSession();
  setPaneRef(null);
  initThinkingBar(null);
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
      // Live-update the pane header title when the session name resolves, and
      // recolour the header avatar's status ring.
      if (state.selectedId) {
        const sess = state.sessions.find((s) => s.session_id === state.selectedId);
        if (sess) {
          const titleEl = pane.querySelector<HTMLElement>(".session-header .title");
          if (titleEl) {
            const newTitle = sessionSubtitle(sess);
            if (titleEl.textContent !== newTitle) titleEl.textContent = newTitle;
          }
          updateHeaderAvatarStatus(pane, sess);
        }
      }
    });
  }

  await selectSession(sessionId, pane);

  return teardownState;
}
