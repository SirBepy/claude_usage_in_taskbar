import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { Composer } from "../../shared/chat/composer";
import type { ChatEvent, ContentBlock } from "../../types/ipc.generated";
import { state, setActiveSession } from "./state";
import { projectName } from "./sessions-helpers";
import { pickProject } from "./project-picker";
import { renderSidebar, refreshSessions } from "./sidebar";
import { openModelEffortModal, type SessionConfig } from "./model-effort-modal";

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
  if (state.pendingNewSession) {
    if (state.pendingNewSession.realId !== null) {
      // A turn is already in flight - cannot interrupt.
      alert("Another new session is still starting; please wait for it to finish.");
      return;
    }
    // No message sent yet - abandon the empty pending session silently.
    state.pendingNewSession = null;
  }

  const placeholderId = makePlaceholderId();
  state.pendingNewSession = {
    placeholderId,
    projectPath: project.path,
    projectName: project.name,
    realId: null,
    preExistingSessionIds: new Set(state.sessions.map(s => s.session_id)),
  };
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
      <button class="icon-btn cancel-btn" title="Cancel turn"><i class="ph ph-x"></i></button>
    </header>
    <div class="session-messages">
      <div class="session-pending-hint">
        <i class="ph ph-paper-plane-tilt"></i>
        <p>Type a message below to start a new session in <strong>${escapeHtml(project.name)}</strong>.</p>
      </div>
    </div>
    <div class="session-composer"></div>
  `;

  if (state.renderer) state.renderer.detach();
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (messagesEl) {
    const renderer = new ChatRenderer(messagesEl);
    state.renderer = renderer;
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
      if (state.pendingNewSession) state.pendingNewSession.realId = realId;
      if (state.renderer && state.renderer.currentSessionId() === placeholderId) {
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
              if (state.renderer && state.renderer.currentSessionId() !== sessionId) {
                await state.renderer.swapSubscription(sessionId);
              }
              if (state.composer) state.composer.setSessionId(sessionId, { readOnly: false });
              setActiveSession(sessionId);
              state.pendingNewSession = null;
              await refreshSessions();
              if (state.mountId !== myMount) return;
              const root2 = document.querySelector<HTMLElement>(".view-sessions");
              if (root2) {
                const listEl = root2.querySelector<HTMLElement>("#sessions-list");
                if (listEl) renderSidebar(listEl);
              }
              rebindPaneHeader(pane, sessionId);
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
}

/**
 * After start_session resolves, rewire the pane header buttons to use the
 * real session_id (replacing the placeholder for detach/cancel/etc). We
 * don't re-render the whole header to avoid losing the live messages
 * container the renderer is bound to.
 */
function rebindPaneHeader(pane: HTMLElement, sessionId: string): void {
  const header = pane.querySelector<HTMLElement>(".session-header");
  if (!header) return;
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  const meta = header.querySelector<HTMLElement>(".meta");
  if (meta && sess) {
    meta.textContent = projectName(sess);
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
}
