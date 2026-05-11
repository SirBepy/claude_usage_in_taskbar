import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { Composer } from "../../shared/chat/composer";
import type { ChatEvent, ContentBlock, GitInfo } from "../../types/ipc.generated";
import { state, setActiveSession } from "./state";
import {
  projectName,
  sessionSubtitle,
  loadUnreadSet,
  saveUnreadSet,
} from "./sessions-helpers";
import { SessionStatusbar, loadStatuslineFields } from "./session-statusbar";
import { renderSidebar, refreshSessions } from "./sidebar";

export function showChatLoadingOverlay(pane: HTMLElement): HTMLElement {
  pane.querySelector(".chat-loading-overlay")?.remove();
  if (getComputedStyle(pane).position === "static") {
    pane.style.position = "relative";
  }
  const overlay = document.createElement("div");
  overlay.className = "chat-loading-overlay";
  overlay.innerHTML = '<div class="chat-loading-ring"></div><div>Loading transcript&hellip;</div>';
  pane.appendChild(overlay);
  return overlay;
}

export async function selectSession(sessionId: string, pane: HTMLElement): Promise<void> {
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
  const readOnly = sess.kind === "external";

  pane.innerHTML = `
    <header class="session-header">
      <span class="title">${escapeHtml(sessionSubtitle(sess))}</span>
      <span class="meta">${escapeHtml(projectName(sess))}</span>
      <button class="icon-btn detach-btn" title="Detach"><i class="ph ph-arrow-square-out"></i></button>
      ${readOnly ? "" : '<button class="icon-btn close-session-btn" title="Close session"><i class="ph ph-x-circle"></i></button>'}
      ${readOnly ? "" : '<button class="icon-btn cancel-btn" title="Cancel turn"><i class="ph ph-x"></i></button>'}
    </header>
    <div class="session-statusbar-host"></div>
    ${readOnly ? '<div class="readonly-banner"><i class="ph ph-eye"></i> <span class="readonly-banner-text">Read-only session</span><button type="button" class="refresh-btn" title="Reload messages"><i class="ph ph-arrows-clockwise"></i></button><button type="button" class="takeover-btn">Take Over</button></div>' : ""}
    <div class="session-messages"></div>
    <div class="session-composer"></div>
  `;

  // Capture dirty file baseline for session-scoped commit detection.
  let baselineDirtyFiles: string[] = [];
  if (sess.cwd) {
    invoke<string[]>("get_git_dirty", { cwd: String(sess.cwd) })
      .then(files => { baselineDirtyFiles = files; })
      .catch(() => {});
  }

  // Mount statusbar.
  const sbHost = pane.querySelector<HTMLElement>(".session-statusbar-host");
  if (sbHost) {
    const fields = await loadStatuslineFields();
    const sb = new SessionStatusbar(sbHost, sess.started_at, fields, sess.cwd ? String(sess.cwd) : null);
    state.statusbar = sb;
    // Fetch git info async (non-blocking, populates when ready).
    if (sess.cwd) {
      invoke<GitInfo>("get_git_info", { cwd: String(sess.cwd) })
        .then((info) => { if (state.statusbar === sb) sb.updateGitInfo(info); })
        .catch(() => { /* no git, fields just stay hidden */ });
    }
  }

  // Attach renderer
  if (state.renderer) state.renderer.detach();
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
    }
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
  }

  // Attach composer
  const composerEl = pane.querySelector<HTMLElement>(".session-composer");
  if (composerEl) {
    state.composer = new Composer(composerEl, {
      projectDir: sess.cwd ?? null,
      getRenderer: () => state.renderer,
      onSend: async (blocks: ContentBlock[]) => {
        // Optimistically push the user's message via the store; claude -p
        // doesn't echo it back via stream-json. Cache stays consistent.
        sessionEvents.pushSynthetic(sessionId, {
          type: "user_message",
          content: blocks,
          timestamp: BigInt(Date.now()),
        } as ChatEvent);
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
      },
    });
    state.composer.setSessionId(sessionId, { readOnly });
  }

  // Wire header buttons
  pane.querySelector<HTMLButtonElement>(".detach-btn")?.addEventListener("click", async () => {
    try {
      await invoke<void>("detach_window", { sessionId });
    } catch (err) {
      console.warn("[sessions] detach_window unavailable", err);
    }
  });
  pane.querySelector<HTMLButtonElement>(".cancel-btn")?.addEventListener("click", async () => {
    try {
      await invoke<void>("cancel_turn", { sessionId });
    } catch (err) {
      console.error("[sessions] cancel_turn failed", err);
    }
  });
  if (!readOnly) {
    pane.querySelector<HTMLButtonElement>(".close-session-btn")?.addEventListener("click", async () => {
      const myMount = state.mountId;

      const currentSess = state.sessions.find(s => s.session_id === sessionId);
      if (currentSess?.busy) {
        if (!confirm("A turn is in progress. Close and discard it?")) return;
        await invoke<void>("cancel_turn", { sessionId });
        await invoke<void>("clear_session", { sessionId });
        return;
      }

      if (!sess.cwd) {
        await invoke<void>("clear_session", { sessionId });
        return;
      }

      let currentDirty: string[] = [];
      try {
        currentDirty = await invoke<string[]>("get_git_dirty", { cwd: String(sess.cwd) });
      } catch {
        await invoke<void>("clear_session", { sessionId });
        return;
      }
      if (state.mountId !== myMount) return;

      const newDirty = currentDirty.filter(f => !baselineDirtyFiles.includes(f));

      if (newDirty.length === 0) {
        await invoke<void>("clear_session", { sessionId });
        return;
      }

      const choice = await showCloseConfirmModal(pane, newDirty.length);
      if (state.mountId !== myMount) return;

      if (choice === "cancel") return;

      if (choice === "close-only") {
        await invoke<void>("clear_session", { sessionId });
        return;
      }

      // "commit" - show closing banner, hide composer
      const composerEl = pane.querySelector<HTMLElement>(".session-composer");
      if (composerEl) composerEl.style.display = "none";

      const banner = document.createElement("div");
      banner.className = "session-closing-banner";
      banner.innerHTML = `
        <i class="ph ph-hourglass"></i>
        <span class="closing-banner-text">Closing session…</span>
        <button type="button" class="cancel-closing-btn">Cancel</button>
      `;
      pane.insertBefore(banner, composerEl ?? null);

      sessionEvents.pushSynthetic(sessionId, {
        type: "user_message",
        content: [{ type: "text", text: "/close /commit" }],
        timestamp: BigInt(Date.now()),
      } as ChatEvent);

      banner.querySelector<HTMLButtonElement>(".cancel-closing-btn")?.addEventListener("click", async () => {
        banner.remove();
        if (composerEl) composerEl.style.display = "";
        await invoke<void>("cancel_turn", { sessionId });
      });

      try {
        await invoke<void>("send_message", {
          sessionId,
          cwd: String(sess.cwd ?? "."),
          blocks: [{ type: "text", text: "/close /commit" } as ContentBlock],
        });
        if (state.mountId !== myMount) return;
        await invoke<void>("clear_session", { sessionId });
      } catch {
        if (state.mountId !== myMount) return;
        banner.remove();
        if (composerEl) composerEl.style.display = "";
      }
    });
  }
  if (readOnly) {
    pane.querySelector<HTMLButtonElement>(".refresh-btn")?.addEventListener("click", async () => {
      sessionEvents.bust(sessionId);
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
}

function showCloseConfirmModal(
  pane: HTMLElement,
  changedCount: number,
): Promise<"commit" | "close-only" | "cancel"> {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "close-confirm-overlay";
    const noun = changedCount === 1 ? "file" : "files";
    overlay.innerHTML = `
      <div class="close-confirm-dialog">
        <i class="ph ph-git-branch close-confirm-icon"></i>
        <div class="close-confirm-title">Uncommitted changes</div>
        <div class="close-confirm-body">${changedCount} ${noun} changed this session. Commit before closing?</div>
        <div class="close-confirm-actions">
          <button class="btn-ccd-cancel">Cancel</button>
          <button class="btn-ccd-skip">Close without committing</button>
          <button class="btn-ccd-commit">Commit &amp; Close</button>
        </div>
      </div>
    `;
    overlay.querySelector(".btn-ccd-cancel")?.addEventListener("click", () => { overlay.remove(); resolve("cancel"); });
    overlay.querySelector(".btn-ccd-skip")?.addEventListener("click", () => { overlay.remove(); resolve("close-only"); });
    overlay.querySelector(".btn-ccd-commit")?.addEventListener("click", () => { overlay.remove(); resolve("commit"); });
    pane.appendChild(overlay);
  });
}
