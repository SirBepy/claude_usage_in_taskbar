import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { Composer } from "../../shared/chat/composer";
import type { ChatEvent, ContentBlock } from "../../types/ipc.generated";
import { state, setActiveSession } from "./state";
import { projectName, sessionSubtitle } from "./sessions-helpers";
import { renderSidebar, refreshSessions } from "./sidebar";
import type { SessionConfig } from "./model-effort-modal";
import { isAutoAccept, setAutoAccept } from "./permission-modal";
import { closeChat } from "./close-chat";
import { SessionStatusbar, loadStatuslineFields, fetchGitInfo } from "./session-statusbar";
import { savePendingSession, clearPendingSession } from "./pending-draft-storage";

function rebuildSidebar(): void {
  const listEl = document.querySelector<HTMLElement>("#sessions-list");
  if (listEl) renderSidebar(listEl);
}

export async function renderPendingPane(
  pane: HTMLElement,
  placeholderId: string,
  project: { path: string; name: string },
  config: SessionConfig,
  onDiscard?: (pane: HTMLElement) => void,
): Promise<void> {
  const myMount = state.mountId;
  pane.innerHTML = `
    <header class="session-header">
      <span class="title">New chat</span>
      <span class="meta">${escapeHtml(project.name)} - ${escapeHtml(project.path)}</span>
      <button class="icon-btn close-session-btn" title="Close session"><i class="ph ph-x-circle"></i></button>
      <button class="icon-btn cancel-btn" title="Cancel turn" hidden><i class="ph ph-x"></i></button>
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
    fetchGitInfo(project.path)
      .then((info) => { if (state.statusbar === sb) sb.updateGitInfo(info); })
      .catch(() => {});
  }

  if (state.renderer) state.renderer.detach();
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (messagesEl) {
    const renderer = new ChatRenderer(messagesEl);
    state.renderer = renderer;
    const sbForRenderer = state.statusbar;
    if (sbForRenderer) {
      renderer.onMetaUpdate = (meta) => {
        if (state.statusbar === sbForRenderer) sbForRenderer.updateMeta(meta);
      };
    }
    // Must attach BEFORE the first invoke so the placeholder channel is
    // subscribed before Rust mirrors SessionStarted onto it.
    await renderer.attach(placeholderId);
    if (state.mountId !== myMount) { renderer.detach(); return; }

    let unsubPlaceholderWatch: (() => void) | null = null;
    unsubPlaceholderWatch = sessionEvents.subscribe(placeholderId, async (payload) => {
      if (payload.type !== "session_started") return;
      const realId = payload.session_id;
      if (!realId) return;
      if (unsubPlaceholderWatch) {
        try { unsubPlaceholderWatch(); } catch { /* ignore */ }
        unsubPlaceholderWatch = null;
      }
      if (state.mountId !== myMount) return;
      // Guard: don't clobber a newer pending if the user started another chat.
      if (state.pendingNewSession?.placeholderId === placeholderId) {
        state.pendingNewSession.realId = realId;
        savePendingSession(state.pendingNewSession);
      }
      const isStillActive = state.selectedId === placeholderId;
      if (isStillActive && state.renderer && state.renderer.currentSessionId() === placeholderId) {
        await state.renderer.swapSubscription(realId);
      }
      rebuildSidebar();
    });
  }

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

        // Synthetic push: claude -p never echoes the prompt on stdout, so
        // without this the user wouldn't see their typed text in the chat.
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
          pane.querySelector(".session-pending-hint")?.remove();
          rebuildSidebar();
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
              const isStillActive = state.selectedId === placeholderId || state.selectedId === sessionId;
              if (isStillActive && state.renderer && state.renderer.currentSessionId() !== sessionId) {
                await state.renderer.swapSubscription(sessionId);
              }
              if (isStillActive && state.composer) state.composer.setSessionId(sessionId, { readOnly: false });
              if (isStillActive) setActiveSession(sessionId);
              // Guard: don't clobber a newer pending if the user started another chat.
              if (state.pendingNewSession?.placeholderId === placeholderId) {
                state.pendingNewSession = null;
                clearPendingSession();
              }
              await refreshSessions();
              if (state.mountId !== myMount) return;
              rebuildSidebar();
              if (isStillActive) rebindPaneHeader(pane, sessionId);
            }
          } catch (err) {
            console.error("[sessions] start_session failed", err);
            started = false;
            alert(`Failed to start session: ${err}`);
          }
          return;
        }

        const realId = state.pendingNewSession?.realId ?? state.selectedId;
        if (!realId || realId === placeholderId) {
          alert("Session is still starting; please wait for the first response.");
          return;
        }
        try {
          await invoke<void>("send_message", { sessionId: realId, cwd: project.path, blocks });
        } catch (err) {
          console.error("[sessions] send_message failed", err);
          alert(`Send failed: ${err}`);
        }
      },
    });
    state.composer.setSessionId(placeholderId, { readOnly: false });
  }

  const ta = pane.querySelector<HTMLTextAreaElement>(".composer-textarea");
  if (ta) ta.focus();

  // cancel_turn targets placeholder while realId is unknown; rebindPaneHeader
  // replaces this handler with a direct-id version once start_session resolves.
  pane.querySelector<HTMLButtonElement>(".cancel-btn")?.addEventListener("click", async () => {
    const cancelTarget = state.pendingNewSession?.realId || placeholderId;
    try {
      await invoke<void>("cancel_turn", { sessionId: cancelTarget });
    } catch (err) {
      console.error("[sessions] cancel_turn failed", err);
    }
  });

  pane.querySelector<HTMLButtonElement>(".close-session-btn")?.addEventListener("click", () => {
    if (!state.pendingNewSession?.firstMessageSent && onDiscard) {
      onDiscard(pane);
      return;
    }
    const closeTarget = state.pendingNewSession?.realId || placeholderId;
    void closeChat(closeTarget);
  });
}

function rebindPaneHeader(pane: HTMLElement, sessionId: string): void {
  if (state.statusbar) {
    state.statusbar.setSessionId(sessionId);
    state.statusbar.setReadOnlyEffort(false);
  }

  const header = pane.querySelector<HTMLElement>(".session-header");
  if (!header) return;
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  const title = header.querySelector<HTMLElement>(".title");
  if (title && sess) title.textContent = sessionSubtitle(sess);
  const meta = header.querySelector<HTMLElement>(".meta");
  if (meta && sess) meta.textContent = projectName(sess);
  pane.querySelector(".session-pending-hint")?.remove();

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

  const cancelBtn = header.querySelector<HTMLButtonElement>(".cancel-btn");
  if (cancelBtn) {
    const fresh = cancelBtn.cloneNode(true) as HTMLButtonElement;
    cancelBtn.replaceWith(fresh);
    fresh.removeAttribute("hidden");
    fresh.addEventListener("click", async () => {
      try {
        await invoke<void>("cancel_turn", { sessionId });
      } catch (err) {
        console.error("[sessions] cancel_turn failed", err);
      }
    });
  }

  const closeBtn = header.querySelector<HTMLButtonElement>(".close-session-btn");
  if (closeBtn) {
    const fresh = closeBtn.cloneNode(true) as HTMLButtonElement;
    closeBtn.replaceWith(fresh);
    fresh.addEventListener("click", () => { void closeChat(sessionId); });
  }
}
