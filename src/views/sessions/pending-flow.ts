import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { Composer, discardComposerDraft } from "../../shared/chat/composer";
import type { ChatEvent, ContentBlock } from "../../types/ipc.generated";
import { state, setActiveSession, type ParkedDraft } from "./state";
import { projectName } from "./sessions-helpers";
import { pickProject } from "./project-picker";
import { renderSidebar, refreshSessions } from "./sidebar";
import { openModelEffortModal, type SessionConfig } from "./model-effort-modal";
import { isAutoAccept, setAutoAccept } from "./permission-modal";
import { closeChat } from "./close-chat";
import { SessionStatusbar, loadStatuslineFields } from "./session-statusbar";
import { savePendingSession, loadPendingSession, clearPendingSession } from "./pending-draft-storage";
import type { GitInfo } from "../../types/ipc.generated";

/**
 * Generate a placeholder session id used to subscribe `chat:<id>` BEFORE
 * the real session_id is known. The Rust side validates this matches
 * `pending-` + alphanumeric/dash/underscore. We append a millisecond
 * timestamp + 8 random hex chars to keep two concurrent new-session
 * attempts isolated.
 */
export function makePlaceholderId(): string {
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `pending-${ts}-${rnd}`;
}


// If a restored pending entry has been "starting..." for longer than this,
// the previous app instance died before SessionStarted arrived (the Rust
// runner is per-turn and does NOT survive a process restart). Drop it so
// the user doesn't see a phantom spinner row that nothing in this process
// will ever resolve.
const STUCK_PENDING_TIMEOUT_MS = 90_000;

export function loadAndRestorePendingSession(): void {
  const pending = loadPendingSession();
  if (!pending) return;
  if (
    pending.firstMessageSent &&
    !pending.realId &&
    pending.firstMessageSentAt !== null &&
    Date.now() - pending.firstMessageSentAt > STUCK_PENDING_TIMEOUT_MS
  ) {
    clearPendingSession();
    return;
  }
  // Backfill timestamp for entries persisted by older app builds so they
  // also benefit from the auto-discard on the next restart.
  if (pending.firstMessageSent && pending.firstMessageSentAt === null) {
    pending.firstMessageSentAt = Date.now();
  }
  state.pendingNewSession = pending;
}

/**
 * Discard the current draft (pending session that hasn't sent its first
 * message yet). If the user is still viewing the draft pane, also clear it.
 * If they've navigated to another session, leave that pane alone — just drop
 * the pending state and refresh the sidebar.
 *
 * Safe to call on `firstMessageSent === true` too (used by close-session-btn
 * during pending-pane lifetime), but in that case start_session is in flight
 * and the renderer will catch up.
 */
export function discardDraft(pane: HTMLElement): void {
  const pending = state.pendingNewSession;
  if (!pending) return;
  const wasOnDraft = state.selectedId === pending.placeholderId;
  state.pendingNewSession = null;
  clearPendingSession();
  discardComposerDraft(pending.placeholderId);

  if (wasOnDraft) {
    state.statusbar?.destroy();
    state.statusbar = null;
    if (state.renderer?.currentSessionId() === pending.placeholderId) {
      state.renderer.detach();
      state.renderer = null;
    }
    state.composer?.destroy();
    state.composer = null;
    setActiveSession(null);
    pane.innerHTML = `<div class="session-empty">Select or create a session</div>`;
  }

  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }
}

/**
 * Re-open the current draft pending pane (used when the user has navigated
 * to another chat and clicks the draft row to come back). Tears down whatever
 * is currently in the pane and re-renders the pending pane with the original
 * placeholder + project + config. Textarea content is not preserved.
 *
 * No-op if there is no pending session or if the first message has already
 * been sent (in which case the row is "starting…", not a clickable draft).
 */
export async function resumeDraft(pane: HTMLElement): Promise<void> {
  const pending = state.pendingNewSession;
  if (!pending || pending.firstMessageSent) return;
  if (state.selectedId === pending.placeholderId) return;

  state.statusbar?.destroy();
  state.statusbar = null;
  state.renderer?.detach();
  state.renderer = null;
  state.composer?.destroy();
  state.composer = null;

  setActiveSession(pending.placeholderId);
  await renderPendingPane(
    pane,
    pending.placeholderId,
    { path: pending.projectPath, name: pending.projectName },
    pending.config,
  );

  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }
}

export async function startNewSession(pane: HTMLElement): Promise<void> {
  const myMount = state.mountId;
  const project = await pickProject();
  if (!project) return;
  if (state.mountId !== myMount) return;
  const config = await openModelEffortModal(project.path, project.name);
  if (!config) return;
  if (state.mountId !== myMount) return;
  await launchNewSession(pane, project, config);
}

export async function launchNewSession(
  pane: HTMLElement,
  project: { path: string; name: string },
  config: SessionConfig,
): Promise<void> {
  // If there's an unsent draft, park it as a sidebar row the user can return
  // to or dismiss manually. If it already sent its first message ("starting...")
  // just drop the frontend tracking — the backend process keeps running and
  // will surface as a normal session row once SessionStarted fires.
  if (state.pendingNewSession) {
    if (!state.pendingNewSession.firstMessageSent) {
      const parked: ParkedDraft = {
        placeholderId: state.pendingNewSession.placeholderId,
        projectPath: state.pendingNewSession.projectPath,
        projectName: state.pendingNewSession.projectName,
        config: state.pendingNewSession.config,
      };
      state.parkedDrafts = [...state.parkedDrafts, parked];
    }
    state.pendingNewSession = null;
    clearPendingSession();
  }

  const placeholderId = makePlaceholderId();
  state.pendingNewSession = {
    placeholderId,
    projectPath: project.path,
    projectName: project.name,
    config,
    realId: null,
    firstMessageSent: false,
    preExistingSessionIds: new Set(state.sessions.map(s => s.session_id)),
    firstMessageSentAt: null,
  };
  savePendingSession(state.pendingNewSession);
  setActiveSession(placeholderId);

  await renderPendingPane(pane, placeholderId, project, config);

  // Re-render sidebar to show the pending row.
  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }
}

/**
 * Render the chat pane in "pending" mode: header (showing the placeholder
 * project name), an empty messages container with a renderer pre-attached
 * to `chat:<placeholderId>`, and a composer that already shows the
 * already-typed first prompt as a sent user message via the live stream.
 *
 * The renderer's swapSubscription is triggered automatically when the
 * SessionStarted event arrives, so the caller doesn't need to wire it.
 */
export async function renderPendingPane(
  pane: HTMLElement,
  placeholderId: string,
  project: { path: string; name: string },
  config: SessionConfig,
): Promise<void> {
  const myMount = state.mountId;
  pane.innerHTML = `
    <header class="session-header">
      <span class="title">New chat</span>
      <span class="meta">${escapeHtml(project.name)} - ${escapeHtml(project.path)}</span>
      <button class="icon-btn close-session-btn" title="Close session"><i class="ph ph-x-circle"></i></button>
      <button class="icon-btn cancel-btn" title="Cancel turn"><i class="ph ph-x"></i></button>
    </header>
    <div class="session-statusbar-host"></div>
    <div class="session-messages">
      <div class="session-pending-hint">
        <i class="ph ph-paper-plane-tilt"></i>
        <p>Type a message below to start a new session in <strong>${escapeHtml(project.name)}</strong>.</p>
      </div>
    </div>
    <div class="session-thinking" hidden></div>
    <div class="session-composer"></div>
  `;

  // Mount the statusbar. While the placeholder is active, effort is readonly
  // (no real session_id yet for set_session_effort to target). rebindPaneHeader
  // flips it editable once realId arrives.
  const sbHost = pane.querySelector<HTMLElement>(".session-statusbar-host");
  if (sbHost) {
    const fields = await loadStatuslineFields();
    const sb = new SessionStatusbar(sbHost, null, fields, {
      cwd: project.path,
      effort: config.effort,
      sessionId: placeholderId,
      readOnly: true,
    });
    state.statusbar = sb;
    invoke<GitInfo>("get_git_info", { cwd: project.path })
      .then((info) => { if (state.statusbar === sb) sb.updateGitInfo(info); })
      .catch(() => { /* no git, fields stay hidden */ });
  }

  if (state.renderer) state.renderer.detach();
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (messagesEl) {
    const renderer = new ChatRenderer(messagesEl);
    state.renderer = renderer;
    // Wire meta updates to the statusbar so model/tokens/etc appear once
    // the first stream-json arrives.
    const sbForRenderer = state.statusbar;
    if (sbForRenderer) {
      renderer.onMetaUpdate = (meta) => {
        if (state.statusbar === sbForRenderer) sbForRenderer.updateMeta(meta);
      };
    }
    // Attach to the placeholder channel BEFORE invoke - this is the whole
    // point: we must not miss the SessionStarted event Rust mirrors on the
    // placeholder channel. Once it arrives, the renderer's handleEvent
    // ignores it (it's a system event); we read the real id off the
    // payload via a one-shot interceptor below.
    await renderer.attach(placeholderId);
    if (state.mountId !== myMount) {
      renderer.detach();
      return;
    }
    // Hook into the placeholder channel via the event store to capture the
    // real session_id and swap subscription. The store also moves the
    // cached events under the new key so subsequent reopens hit the cache.
    let unsubPlaceholderWatch: (() => void) | null = null;
    unsubPlaceholderWatch = sessionEvents.subscribe(placeholderId, async (payload) => {
      if (payload.type !== "session_started") return;
      const realId = payload.session_id;
      if (!realId) return;
      // Tear down THIS subscriber before swap so we don't leak under realId.
      if (unsubPlaceholderWatch) {
        try { unsubPlaceholderWatch(); } catch { /* ignore */ }
        unsubPlaceholderWatch = null;
      }
      if (state.mountId !== myMount) return;
      // Only mutate pending state if it still belongs to OUR placeholder. If
      // the user has since started another new chat, state.pendingNewSession
      // points at a different draft now and must not be touched.
      if (state.pendingNewSession?.placeholderId === placeholderId) {
        state.pendingNewSession.realId = realId;
        savePendingSession(state.pendingNewSession);
      }
      const isStillActive = state.selectedId === placeholderId;
      if (isStillActive && state.renderer && state.renderer.currentSessionId() === placeholderId) {
        await state.renderer.swapSubscription(realId);
      }
      const root = document.querySelector<HTMLElement>(".view-sessions");
      if (root) {
        const listEl = root.querySelector<HTMLElement>("#sessions-list");
        if (listEl) renderSidebar(listEl);
      }
    });
  }

  // Composer is attached here. The FIRST send invokes start_session
  // (passing placeholderId so Rust mirrors SessionStarted onto the channel
  // we're already subscribed to). Subsequent sends route through
  // send_message against the real id captured from SessionStarted.
  const composerEl = pane.querySelector<HTMLElement>(".session-composer");
  if (composerEl) {
    state.composer?.destroy();
    let started = false;
    state.composer = new Composer(composerEl, {
      projectDir: project.path,
      getRenderer: () => state.renderer,
      onSend: async (blocks: ContentBlock[]) => {
        if (state.mountId !== myMount) return;
        const promptText = blocks
          .map((b) => (b && b.type === "text" ? b.text : ""))
          .filter((s) => s)
          .join("\n");
        if (!promptText.trim()) return;

        // Optimistically push the user's message into the cache. claude -p's
        // stream-json output never echoes the prompt back on stdout (verified
        // against the spike fixture), so without this the user wouldn't see
        // their typed text in the chat at all. Going through the store rather
        // than the renderer directly means the synthetic event lives in the
        // cache too, so a later detach/reopen still shows the message.
        const targetSid = state.renderer?.currentSessionId() ?? placeholderId;
        sessionEvents.pushSynthetic(targetSid, {
          type: "user_message",
          content: blocks,
          timestamp: BigInt(Date.now()),
        } as ChatEvent);

        if (!started) {
          started = true;
          if (state.pendingNewSession) {
            state.pendingNewSession.firstMessageSent = true;
            state.pendingNewSession.firstMessageSentAt = Date.now();
            savePendingSession(state.pendingNewSession);
          }
          // Re-render the sidebar so the draft row swaps to the spinner row.
          const rootEarly = document.querySelector<HTMLElement>(".view-sessions");
          if (rootEarly) {
            const listEl = rootEarly.querySelector<HTMLElement>("#sessions-list");
            if (listEl) renderSidebar(listEl);
          }
          try {
            const sessionId = await invoke<string>("start_session", {
              cwd: project.path,
              prompt: promptText,
              model: config.model,
              effort: config.effort,
              placeholderId,
            });
            if (state.mountId !== myMount) return;
            if (sessionId) {
              // Only update the pane if user hasn't navigated to a different session.
              const isStillActive = state.selectedId === placeholderId || state.selectedId === sessionId;
              if (isStillActive && state.renderer && state.renderer.currentSessionId() !== sessionId) {
                await state.renderer.swapSubscription(sessionId);
              }
              if (isStillActive && state.composer) state.composer.setSessionId(sessionId, { readOnly: false });
              if (isStillActive) setActiveSession(sessionId);
              // Same guard as the SessionStarted subscriber: don't clobber a
              // newer pending the user has since started.
              if (state.pendingNewSession?.placeholderId === placeholderId) {
                state.pendingNewSession = null;
                clearPendingSession();
              }
              await refreshSessions();
              if (state.mountId !== myMount) return;
              const root2 = document.querySelector<HTMLElement>(".view-sessions");
              if (root2) {
                const listEl = root2.querySelector<HTMLElement>("#sessions-list");
                if (listEl) renderSidebar(listEl);
              }
              if (isStillActive) rebindPaneHeader(pane, sessionId);
            }
          } catch (err) {
            console.error("[sessions] start_session failed", err);
            started = false;
            alert(`Failed to start session: ${err}`);
          }
          return;
        }

        // Subsequent sends: real id known via SessionStarted swap or via the
        // start_session resolution above.
        const realId = state.pendingNewSession?.realId ?? state.selectedId;
        if (!realId || realId === placeholderId) {
          alert("Session is still starting; please wait for the first response.");
          return;
        }
        try {
          await invoke<void>("send_message", {
            sessionId: realId,
            cwd: project.path,
            blocks,
          });
        } catch (err) {
          console.error("[sessions] send_message failed", err);
          alert(`Send failed: ${err}`);
        }
      },
    });
    state.composer.setSessionId(placeholderId, { readOnly: false });
  }

  // Focus composer textarea so user can immediately type.
  const ta = pane.querySelector<HTMLTextAreaElement>(".composer-textarea");
  if (ta) ta.focus();

  // Cancel button kills the in-flight first turn via cancel_turn(placeholder).
  // Rust's ChatState.running tracks the slot under the placeholder key when
  // session_id_in is None. After SessionStarted fires it tracks under the
  // real id; we rebind in startNewSession after it resolves.
  pane.querySelector<HTMLButtonElement>(".cancel-btn")?.addEventListener("click", async () => {
    const realId = state.pendingNewSession?.realId;
    const cancelTarget = realId || placeholderId;
    try {
      await invoke<void>("cancel_turn", { sessionId: cancelTarget });
    } catch (err) {
      console.error("[sessions] cancel_turn failed", err);
    }
  });

  pane.querySelector<HTMLButtonElement>(".close-session-btn")?.addEventListener("click", () => {
    const realId = state.pendingNewSession?.realId;
    const closeTarget = realId || placeholderId;
    void closeChat(closeTarget);
  });
}

/**
 * After start_session resolves, rewire the pane header buttons to use the
 * real session_id (replacing the placeholder for detach/cancel/etc). We
 * don't re-render the whole header to avoid losing the live messages
 * container the renderer is bound to.
 */
function rebindPaneHeader(pane: HTMLElement, sessionId: string): void {
  // Pin the statusbar to the real session_id and unlock effort.
  if (state.statusbar) {
    state.statusbar.setSessionId(sessionId);
    state.statusbar.setReadOnlyEffort(false);
  }

  const header = pane.querySelector<HTMLElement>(".session-header");
  if (!header) return;
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  const meta = header.querySelector<HTMLElement>(".meta");
  if (meta && sess) {
    meta.textContent = projectName(sess);
  }
  // Add auto-accept button (omitted from pending header; meaningless until
  // realId is known). Insert before detach (which sits before cancel).
  if (!header.querySelector(".auto-accept-btn")) {
    const detachBtnEl = header.querySelector(".detach-btn");
    const cancelBtn = header.querySelector(".cancel-btn");
    const on = isAutoAccept(sessionId);
    const autoBtn = document.createElement("button");
    autoBtn.className = "icon-btn auto-accept-btn" + (on ? " is-on" : "");
    autoBtn.title = on
      ? "Auto-accepting tool permissions. Click to disable."
      : "Auto-accept tool permissions for this session";
    autoBtn.setAttribute("aria-pressed", on ? "true" : "false");
    autoBtn.innerHTML = '<i class="ph ph-shield-check"></i>';
    autoBtn.addEventListener("click", () => {
      const next = !isAutoAccept(sessionId);
      setAutoAccept(sessionId, next);
      autoBtn.classList.toggle("is-on", next);
      autoBtn.setAttribute("aria-pressed", next ? "true" : "false");
      autoBtn.title = next
        ? "Auto-accepting tool permissions. Click to disable."
        : "Auto-accept tool permissions for this session";
    });
    const anchor = detachBtnEl ?? cancelBtn;
    if (anchor) header.insertBefore(autoBtn, anchor);
    else header.appendChild(autoBtn);
  }

  // Add open-in-terminal button (omitted from pending header; no real
  // session_id to resume until now). Insert before detach/cancel.
  if (!header.querySelector(".open-terminal-btn")) {
    const cancelBtn = header.querySelector(".cancel-btn");
    const detachBtnExisting = header.querySelector(".detach-btn");
    const termBtn = document.createElement("button");
    termBtn.className = "icon-btn open-terminal-btn";
    termBtn.title = "Open this chat in an external terminal (survives app restart)";
    termBtn.innerHTML = '<i class="ph ph-terminal-window"></i>';
    termBtn.addEventListener("click", async () => {
      try {
        await invoke<void>("open_session_in_terminal", { sessionId });
      } catch (err) {
        console.error("[sessions] open_session_in_terminal failed", err);
        alert(`Failed to open terminal: ${err}`);
      }
    });
    const anchor = detachBtnExisting ?? cancelBtn;
    if (anchor) header.insertBefore(termBtn, anchor);
    else header.appendChild(termBtn);
  }

  // Add detach button (was omitted from pending header). Insert before cancel.
  if (!header.querySelector(".detach-btn")) {
    const cancelBtn = header.querySelector(".cancel-btn");
    const detachBtn = document.createElement("button");
    detachBtn.className = "icon-btn detach-btn";
    detachBtn.title = "Detach";
    detachBtn.innerHTML = '<i class="ph ph-arrow-square-out"></i>';
    detachBtn.addEventListener("click", async () => {
      try {
        await invoke<void>("detach_window", { sessionId });
      } catch (err) {
        console.warn("[sessions] detach_window unavailable", err);
      }
    });
    if (cancelBtn) header.insertBefore(detachBtn, cancelBtn);
    else header.appendChild(detachBtn);
  }
  // Replace the cancel handler so it targets the real id directly (no more
  // pendingNewSession.realId indirection).
  const cancelBtn = header.querySelector<HTMLButtonElement>(".cancel-btn");
  if (cancelBtn) {
    const fresh = cancelBtn.cloneNode(true) as HTMLButtonElement;
    cancelBtn.replaceWith(fresh);
    fresh.addEventListener("click", async () => {
      try {
        await invoke<void>("cancel_turn", { sessionId });
      } catch (err) {
        console.error("[sessions] cancel_turn failed", err);
      }
    });
  }

  // Same for the close-session button: rebind to the real id.
  const closeBtn = header.querySelector<HTMLButtonElement>(".close-session-btn");
  if (closeBtn) {
    const fresh = closeBtn.cloneNode(true) as HTMLButtonElement;
    closeBtn.replaceWith(fresh);
    fresh.addEventListener("click", () => { void closeChat(sessionId); });
  }
}
