import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { showChatLoadingOverlay } from "../../shared/chat/chat-loading";
import { Composer } from "../../shared/chat/composer";
import { HeldMessages } from "../../shared/chat/held-messages";
import { setFileEditsProvider } from "../../shared/chat/file-viewer";
import type { ChatEvent, ContentBlock, Instance } from "../../types/ipc.generated";
import { state, setActiveSession } from "./state";
import { getSettings } from "../../shared/state";
import {
  projectName,
  sessionSubtitle,
  loadUnreadSet,
  saveUnreadSet,
  paneEmptyStateHtml,
  statusDotClass,
} from "./sessions-helpers";
import { SessionStatusbar, loadStatuslineRows, loadStatuslineHideZero, fetchGitInfo } from "./session-statusbar";
import { readLastChoice, readPresets } from "../../shared/effort-presets";
import { renderSidebar, refreshSessions } from "./sidebar";
import { characterForSession, characterIconUrl, loadSessionCharacters } from "./session-characters";
import { hydrateCharacterAvatars, hydrateProjectTechIcons } from "../../shared/projects";
import { api } from "../../shared/api";
import { openChangeCharacterModal } from "../../shared/change-character-modal";
import {
  addBackgroundSession,
  removeBackgroundSession,
  isAutoAccept,
  replayPendingPrompt,
  pendingPromptSessionIds,
} from "./permission-modal";
import { snapshotActiveCardDraft } from "./permission-modal/question-ui";
import { savePendingPromptDraft } from "./permission-modal/gating";
import { markSessionExiting } from "./sidebar-anim";
import { markSessionClosing, unmarkSessionClosing } from "./closing-sessions";
import { ChangesPanel, dedupeByPath } from "./changes-panel";
import { SessionHeader } from "./session-header";
import { setThinkingActivity, setThinkingProgress, isCurrentSessionBusy, updateThinkingBar } from "./session-thinking-bar";
import { rateLimitBanner } from "../../shared/chat/rate-limit-banner";
import { openModelEffortModal } from "./model-effort-modal";
import { registerCta } from "../../shared/chat/cta-registry";
import { completeHandoff } from "./handoff";

const HEADER_STATUS_CLASSES = [
  "st-working", "st-question", "st-done", "st-your-turn", "st-external", "st-attention", "st-rate-limited",
];

/** Status class (st-working / st-question / …) for an open session, using the
 * same classifier the sidebar rows use so the header avatar's border colour
 * matches the sidebar strip. Exported for the live recolour on the
 * instances-changed event. */
export function headerStatusClass(sess: Instance): string {
  const unread = loadUnreadSet();
  // A prompt shown for the currently-viewed chat is parked so it survives a
  // switch-away, but its card is already on screen - don't also alarm its own
  // row. Backgrounded chats with parked prompts still badge.
  const attention = pendingPromptSessionIds();
  if (state.selectedId) attention.delete(state.selectedId);
  const question = new Set<string>([
    ...state.questionSessions,
    ...state.sessions.filter((s) => s.awaiting === "question").map((s) => s.session_id),
  ]);
  return statusDotClass(sess, unread, attention, question, rateLimitBanner.interruptedSet);
}

/** Swap the header avatar's status ring class without re-rendering the whole
 * header. Called from both instances-changed and onStatusUpdate so the border
 * stays in sync with the sidebar regardless of which event arrives first. */
export function updateHeaderAvatarStatus(pane: HTMLElement, sess: Instance): void {
  const heroEl = pane.querySelector<HTMLElement>(".session-header-avatar");
  if (!heroEl) return;
  const st = headerStatusClass(sess);
  if (heroEl.classList.contains(st)) return;
  heroEl.classList.remove(...HEADER_STATUS_CLASSES);
  heroEl.classList.add(st);
}

/**
 * Open the Change Character modal for a session and apply the pick: persist the
 * session->character mapping, reload the session-character cache, play the new
 * character's `select` sound (best-effort), and refresh the header face + the
 * sidebar row. Shared by the header face click and the ⋮ "Change character"
 * menu (the latter imports this dynamically to avoid an import cycle).
 */
export async function changeCharacterForSession(sessionId: string): Promise<void> {
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) return;
  const current = characterForSession(sess);
  const picked = await openChangeCharacterModal({ projectId: sess.project_id, currentId: current });
  if (!picked || picked === current) return;
  try {
    await api.setSessionCharacter(sessionId, picked);
    await loadSessionCharacters();
    void api.playCharacterSlot(picked, "select").catch(() => { /* sound is best-effort */ });
  } catch (e) {
    console.error("[active-session] change character failed", e);
    return;
  }
  // Surgically swap the active pane's header face (avoid a full pane re-render
  // that would tear down the live renderer/composer mid-session).
  if (state.selectedId === sessionId) {
    const header = document.querySelector<HTMLElement>(".session-header");
    const old = header?.querySelector<HTMLElement>(".header-char-clickable");
    if (header && old) {
      const url = characterIconUrl(picked);
      const wrapper = document.createElement("span");
      wrapper.className = `session-header-avatar header-char-clickable ${headerStatusClass(sess)}`;
      wrapper.title = "Change character";
      wrapper.setAttribute("role", "button");
      wrapper.tabIndex = 0;
      const backdrop = document.createElement("img");
      backdrop.className = "char-avatar session-header-backdrop";
      backdrop.dataset.characterId = picked;
      backdrop.alt = "";
      backdrop.setAttribute("aria-hidden", "true");
      if (url) { backdrop.src = url; backdrop.dataset.hydrated = picked; }
      const sharp = document.createElement("img");
      sharp.className = "char-avatar session-header-char";
      sharp.dataset.characterId = picked;
      sharp.alt = "";
      if (url) { sharp.src = url; sharp.dataset.hydrated = picked; }
      wrapper.appendChild(backdrop);
      wrapper.appendChild(sharp);
      old.replaceWith(wrapper);
    }
  }
  const root = document.querySelector<HTMLElement>(".view-sessions");
  const listEl = root?.querySelector<HTMLElement>("#sessions-list");
  if (listEl) renderSidebar(listEl);
}

function isCloseCommand(blocks: ContentBlock[]): boolean {
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return text.includes("/close");
}

let _watchedId: string | null = null;

export function unwatchCurrentExternalSession(): void {
  if (_watchedId) {
    void invoke<void>("unwatch_session_transcript", { sessionId: _watchedId }).catch(() => {});
    sessionEvents.stopWatchListener(_watchedId);
    _watchedId = null;
  }
}

export function dismountActivePane(opts?: { rerenderSidebar?: boolean }): void {
  state.statusbar?.destroy();
  state.statusbar = null;
  state.renderer?.detach();
  state.renderer = null;
  state.composer?.destroy();
  state.composer = null;
  state.changesPanel?.unmount();
  state.changesPanel = null;
  state.activeChatActions = null;
  setThinkingActivity(null);
  setActiveSession(null);
  const pane = document.querySelector<HTMLElement>(".session-pane #session-pane")
    ?? document.querySelector<HTMLElement>("#session-pane");
  if (pane) pane.innerHTML = paneEmptyStateHtml(state.daemonConnected, state.daemonSetupStalled);
  if (opts?.rerenderSidebar !== false) {
    const root = document.querySelector<HTMLElement>(".view-sessions");
    if (root) {
      const listEl = root.querySelector<HTMLElement>("#sessions-list");
      if (listEl) renderSidebar(listEl);
    }
  }
}

registerCta("pickup", {
  label: "Close & start new chat with /pickup",
  icon: "hand-fist",
  handler: async () => {
    const sess = state.sessions.find(s => s.session_id === state.selectedId);
    if (!sess) return;
    const project = { path: String(sess.cwd ?? ""), name: projectName(sess) };
    const config = await openModelEffortModal(project.path, project.name);
    if (!config) return;
    void state.composer?.sendText("/close");
    state.launchNewChatCallback?.(project, { ...config, initialMessage: "/pickup" });
  },
});

export async function selectSession(sessionId: string, pane: HTMLElement): Promise<void> {
  // Mobile single-pane: opening a chat reveals the chat pane (CSS only acts on
  // this attribute inside the ≤768px media query, so desktop is unaffected).
  // Set before the same-session early return so re-tapping the open chat from
  // the list overlay still switches away from the list.
  document.querySelector(".view-sessions")?.setAttribute("data-mobile-pane", "chat");
  if (state.selectedId === sessionId) return;
  // Snapshot any in-progress AUQ answer before the pane is replaced, so it
  // survives the session switch even if another session also gets an AUQ.
  if (state.selectedId) {
    const draft = snapshotActiveCardDraft(state.selectedId);
    if (draft) savePendingPromptDraft(state.selectedId, draft);
  }
  // Unwatch any previously watched session if we're switching to a different one.
  if (_watchedId && _watchedId !== sessionId) {
    void invoke<void>("unwatch_session_transcript", { sessionId: _watchedId }).catch(() => {});
    sessionEvents.stopWatchListener(_watchedId);
    _watchedId = null;
  }
  const myMount = state.mountId;
  setActiveSession(sessionId);

  // Mark session as read
  const unread = loadUnreadSet();
  if (unread.has(sessionId)) {
    unread.delete(sessionId);
    saveUnreadSet(unread);
  }

  // Clean up prior statusbar timer before wiping the pane.
  if (state.statusbar) {
    state.statusbar.destroy();
    state.statusbar = null;
  }

  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) {
    pane.innerHTML = `<div class="session-empty">Session ${escapeHtml(sessionId)} not found</div>`;
    return;
  }
  const readOnly = sess.kind === "external" || sess.kind === "automated";
  const headerCharId = characterForSession(sess);
  const headerIconUrl = headerCharId ? characterIconUrl(headerCharId) : null;
  const headerStatus = headerStatusClass(sess);

  // Opt-in cue (Settings > Sound, default off): play the character's "select"
  // sound when a session row is clicked. Per-slot toggle + mute enforced in Rust.
  if (headerCharId && getSettings().selectOnSessionClick === true) {
    void api.playCharacterSlot(headerCharId, "select").catch(() => { /* best-effort */ });
  }

  const header = new SessionHeader({ title: sessionSubtitle(sess), meta: projectName(sess) });
  header.onCharClick = () => { void changeCharacterForSession(sess.session_id); };
  header.setRemote(sess.is_remote);
  header.bindSession({
    sessionId: sess.session_id,
    readOnly,
    charId: headerCharId,
    charUrl: headerIconUrl,
    charStatus: headerStatus,
    cwd: sess.cwd ? String(sess.cwd) : null,
    autoAcceptOn: !readOnly && isAutoAccept(sess.session_id),
  });

  pane.innerHTML = [
    `<div class="session-statusbar-host"></div>`,
    readOnly ? `<div class="readonly-banner"><i class="ph ph-eye"></i> <span class="readonly-banner-text">Read-only session</span><button type="button" class="refresh-btn" title="Reload messages"><i class="ph ph-arrows-clockwise"></i></button><button type="button" class="takeover-btn">Take Over</button></div>` : "",
    `<div class="session-messages"></div>`,
    `<div class="session-thinking" hidden><span class="thinking-text"></span><span class="held-chip-slot"></span><button class="thinking-pause-btn icon-btn" title="Stop turn" hidden><i class="ph ph-stop-circle"></i></button></div>`,
    `<div class="session-composer"></div>`,
  ].join("");
  pane.insertBefore(header.el, pane.firstChild);

  pane.querySelector<HTMLButtonElement>(".thinking-pause-btn")?.addEventListener("click", () => {
    void invoke<void>("cancel_turn", { sessionId: sess.session_id }).catch(err => console.error("[sessions] cancel_turn failed", err));
  });

  if (headerCharId) void hydrateCharacterAvatars(pane);
  void hydrateProjectTechIcons(pane);

  // Mount statusbar.
  const sbHost = pane.querySelector<HTMLElement>(".session-statusbar-host");
  if (sbHost) {
    const rows = await loadStatuslineRows();
    const hideZero = await loadStatuslineHideZero();
    let effortDisplay = sess.effort ?? "";
    if (!effortDisplay && sess.kind === "external" && sess.cwd) {
      try {
        const settings = await invoke<Record<string, unknown>>("get_settings");
        const last = readLastChoice(settings, String(sess.cwd));
        const normal = readPresets(settings).find((p) => p.name === "Normal");
        effortDisplay = last?.effort ?? normal?.effort ?? "";
      } catch { /* leave blank */ }
    }
    const sb = new SessionStatusbar(sbHost, sess.started_at, rows, {
      cwd: sess.cwd ? String(sess.cwd) : null,
      effort: effortDisplay,
      sessionId: sess.session_id,
      readOnly: sess.kind === "external",
      sessionModel: sess.model || null,
      hideZero,
    });
    state.statusbar = sb;
    // Fetch git info async (cache-first; instantly populated by constructor
    // when cwd is a revisit, this just refreshes in case branch changed).
    if (sess.cwd) {
      fetchGitInfo(String(sess.cwd))
        .then((info) => { if (state.statusbar === sb) sb.updateGitInfo(info); })
        .catch(() => { /* no git, fields just stay hidden */ });
    }
  }

  // Attach renderer
  if (state.renderer) state.renderer.detach();
  state.changesPanel?.unmount();
  state.changesPanel = null;
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (messagesEl) {
    const renderer = new ChatRenderer(messagesEl);
    state.renderer = renderer;
    // Wire meta updates to statusbar (model, tokens, thinking, cost).
    const sbForRenderer = state.statusbar;
    if (sbForRenderer) {
      renderer.onMetaUpdate = (meta) => {
        if (state.statusbar === sbForRenderer) sbForRenderer.updateMeta(meta);
      };
      renderer.onToolTally = (t) => {
        if (state.statusbar === sbForRenderer) sbForRenderer.updateToolTally(t);
      };
      // Tool-chip popovers reuse the in-chat custom views (Read/File Changes/
      // Skills/Questions), built from this renderer's messages.
      sbForRenderer.setToolViewProvider((tool) => renderer.customToolView(tool));
      // Reopened chat: surface its already-accrued tool counts immediately.
      sbForRenderer.updateToolTally(renderer.toolTally);
    }
    // Mount the all-changes panel + wire renderer callbacks. Panel listens
    // for file mutations; activity feed routes to the thinking bar.
    const panel = new ChangesPanel();
    panel.mount(pane, messagesEl);
    state.changesPanel = panel;
    renderer.onFileEditsChanged = (edits) => {
      panel.onUpdate(edits);
      header.setChangesBadge(dedupeByPath(edits).length);
    };
    // Let the file viewer's Diff tab resolve this session's edits for any file.
    setFileEditsProvider(() => renderer.getFileEdits());
    renderer.onActivityUpdate = (activity) => setThinkingActivity(activity);
    renderer.onProgressUpdate = (n, m) => setThinkingProgress(n, m);
    renderer.onNextAiPromptDone = () => {
      if (state.renderer !== renderer) return;
      renderer.injectCta("pickup");
    };
    renderer.onHandoffReady = () => {
      if (state.renderer !== renderer) return;
      if (state.selectedId !== sessionId) return;
      completeHandoff(sessionId);
    };
    // Track Claude's self-reported turn status for this session so the sidebar
    // shows a red "answer me" flag for questions and a calm icon otherwise.
    // Suppresses sidebar re-renders during history replay (loadFromStore).
    // onStatusUpdate fires for every historical cc-status marker; intermediate
    // question→done transitions cause spurious FLIP animation that makes rows
    // appear to reorder and snap back. questionSessions is still updated
    // correctly throughout; the final renderSidebar below captures the result.
    let historyLoaded = false;
    renderer.onStatusUpdate = (status) => {
      if (state.renderer !== renderer) return;
      if (status === "question") state.questionSessions.add(sessionId);
      else state.questionSessions.delete(sessionId);
      if (!historyLoaded) return;
      const root = document.querySelector<HTMLElement>(".view-sessions");
      const listEl = root?.querySelector<HTMLElement>("#sessions-list");
      if (listEl) renderSidebar(listEl);
      // Sync header avatar border immediately — don't wait for instances-changed.
      const sess = state.sessions.find(s => s.session_id === sessionId);
      if (sess) updateHeaderAvatarStatus(pane, sess);
      // work_finished / question_asked sounds are fired by the daemon-link
      // (notifications::rules::fire) which already resolves the character slot
      // and respects mute settings. Playing here too causes a double sound.
    };
    header.onChangesClick = () => panel.toggle();
    // Expose the panel toggle through the state seam so view-more-menu and
    // sidebar-ctx-menu can offer "View changes" for the active session.
    state.activeChatActions = { viewChanges: () => panel.toggle() };
    await renderer.attach(sessionId);
    // Bail if a newer mount or selectSession superseded us during await.
    if (state.mountId !== myMount || state.selectedId !== sessionId) {
      renderer.detach();
      return;
    }
    // Pull from the shared event store. Cache hit = instant render with no
    // IPC. Cache miss triggers load_history_page under the hood (last 20
    // messages). Either way the store keeps the live `chat:<id>` listener
    // attached so events accrue even when this session isn't selected.
    const overlay = sessionEvents.isLoaded(sessionId) ? null : showChatLoadingOverlay(messagesEl);
    try {
      await renderer.loadFromStore(sess.cwd ? String(sess.cwd) : undefined);
      if (state.mountId !== myMount || state.selectedId !== sessionId) {
        renderer.detach();
        return;
      }
    } catch {
      /* tolerate absence */
    } finally {
      overlay?.remove();
    }
    historyLoaded = true;
    // Sync sidebar once after replay: questionSessions is now populated but no
    // renderSidebar fired during replay (suppressed to avoid FLIP flicker).
    const rootEl = document.querySelector<HTMLElement>(".view-sessions");
    const listAfterLoad = rootEl?.querySelector<HTMLElement>("#sessions-list");
    if (listAfterLoad) renderSidebar(listAfterLoad);
  }

  // Attach composer + held-messages controller
  const composerEl = pane.querySelector<HTMLElement>(".session-composer");
  if (composerEl) {
    // The real send-to-daemon path. Shared by the composer (normal send) and
    // by the held-messages controller (flushing a bundled set as one message).
    const sendBundle = async (blocks: ContentBlock[]): Promise<void> => {
      // Optimistically push the user's message via the store; claude -p
      // doesn't echo it back via stream-json. Cache stays consistent.
      sessionEvents.pushSynthetic(sessionId, {
        type: "user_message",
        content: blocks,
        timestamp: BigInt(Date.now()),
      } as ChatEvent);

      // `/close`: mark the row as "closing" (red dimmed state) while the
      // retrospective skill runs in the background, then tear down once done.
      // AskUserQuestion modals still surface via the background gate.
      if (isCloseCommand(blocks)) {
        const cwd = String(sess.cwd ?? ".");
        addBackgroundSession(sessionId);
        markSessionClosing(sessionId);
        const listEl = document.querySelector<HTMLElement>("#sessions-list");
        if (listEl) renderSidebar(listEl);

        // Wait for the /close turn to actually finish before tearing down.
        // send_message resolves immediately (stdin write), so .finally() would
        // have killed the process before the skill ran. Instead, subscribe and
        // finalize only on turn_usage (turn complete) or session_ended (crash).
        const finalize = () => {
          removeBackgroundSession(sessionId);
          unmarkSessionClosing(sessionId);
          const exitListEl = document.querySelector<HTMLElement>("#sessions-list");
          if (exitListEl) markSessionExiting(exitListEl, sessionId);
          invoke<void>("clear_session", { sessionId })
            .catch(() => {})
            .finally(() => {
              if (state.selectedId === sessionId) {
                dismountActivePane({ rerenderSidebar: true });
              } else {
                const el = document.querySelector<HTMLElement>("#sessions-list");
                if (el) renderSidebar(el);
              }
            });
        };

        let finalized = false;
        const unsub = sessionEvents.subscribe(sessionId, (ev) => {
          if (ev.type === "turn_usage" || ev.type === "session_ended") {
            if (finalized) return;
            finalized = true;
            unsub();
            finalize();
          }
        });

        invoke<void>("send_message", { sessionId, cwd, blocks })
          .catch(err => {
            console.error("[sessions] background /close send_message failed", err);
            if (!finalized) { finalized = true; unsub(); finalize(); }
          });
        return;
      }

      try {
        await invoke<void>("send_message", {
          sessionId,
          cwd: String(sess.cwd ?? "."),
          blocks,
        });
      } catch (err) {
        console.error("[sessions] send_message failed", err);
        alert(`Send failed: ${err}`);
      }
    };

    state.composer?.destroy();
    const composer = new Composer(composerEl, {
      projectDir: sess.cwd ?? null,
      getRenderer: () => state.renderer,
      onSend: sendBundle,
      // While busy, Enter stages instead of sends; when not busy but a held set
      // exists, a normal send bundles it with the draft as one message.
      isBusy: () => isCurrentSessionBusy(),
      onStage: (blocks) => state.heldMessages?.stage(blocks),
      hasHeld: () => !!state.heldMessages?.hasItemsForActive(),
      flushHeldWithDraft: (draftBlocks) => { void state.heldMessages?.flushHeldWithDraft(draftBlocks); },
      onDraftActivity: () => state.heldMessages?.notifyDraftActivity(),
    });
    state.composer = composer;
    composer.setSessionId(sessionId, { readOnly });
    if (state.renderer) {
      state.renderer.onSendText = (text) => { void sendBundle([{ type: "text", text }]); };
    }

    // Held-messages controller is a singleton (its per-session set survives
    // session switches); re-attach it to this freshly-mounted pane + session.
    if (!state.heldMessages) state.heldMessages = new HeldMessages();
    const thinkingBar = pane.querySelector<HTMLElement>(".session-thinking");
    const chipSlot = pane.querySelector<HTMLElement>(".held-chip-slot");
    if (thinkingBar && chipSlot) {
      state.heldMessages.attach({
        sessionId,
        chipSlot,
        anchor: thinkingBar,
        send: sendBundle,
        interrupt: () => invoke<void>("cancel_turn", { sessionId }),
        getDraftBlocks: () => composer.getDraftBlocks(),
        isDraftEmpty: () => composer.isDraftEmpty(),
        isComposing: () => composer.isComposing(),
        clearComposer: () => composer.clearComposer(),
        getIsBusy: () => isCurrentSessionBusy(),
        onChange: () => updateThinkingBar(),
      });
    }
    updateThinkingBar();
  }

  // Start real-time file watcher for all sessions. External sessions get new
  // messages this way; Interactive sessions also need it so that turns
  // continued in a terminal appear in the UI. Watcher emits chat-watch:<id>
  // events; the store's ensureWatchListener deduplicates against runner events.
  _watchedId = sessionId;
  void invoke<void>("watch_session_transcript", { sessionId, cwd: sess.cwd ?? null })
    .then(() => sessionEvents.ensureWatchListener(sessionId))
    .catch((err) => console.warn("[sessions] watch_session_transcript failed:", err));

  if (readOnly) {
    pane.querySelector<HTMLButtonElement>(".refresh-btn")?.addEventListener("click", async () => {
      sessionEvents.bust(sessionId);
      // Clear selectedId so selectSession doesn't bail on the equality check.
      setActiveSession(null);
      await selectSession(sessionId, pane);
    });
    pane.querySelector<HTMLButtonElement>(".takeover-btn")?.addEventListener("click", async () => {
      if (!confirm(`Take over manual session? This kills the external claude process (pid ${sess.pid}) so this app can resume the session.`)) return;
      try {
        const newId = await invoke<string>("takeover_manual", { manualPid: sess.pid });
        if (newId) {
          await refreshSessions();
          const root = document.querySelector<HTMLElement>(".view-sessions");
          if (root) {
            const listEl = root.querySelector<HTMLElement>("#sessions-list");
            if (listEl) renderSidebar(listEl);
          }
          await selectSession(newId, pane);
        }
      } catch (err) {
        console.error("[sessions] takeover_manual failed", err);
        alert(`Takeover failed: ${err}`);
      }
    });
  }

  // Re-render sidebar to mark active row.
  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }

  // If this chat parked a permission/question prompt while it was in the
  // background, surface it now that the pane (and composer anchor) is mounted.
  replayPendingPrompt(sessionId);
}

