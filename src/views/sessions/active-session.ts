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
import {
  addBackgroundSession,
  removeBackgroundSession,
  isAutoAccept,
  setAutoAccept,
} from "./permission-modal";

function isCloseCommand(blocks: ContentBlock[]): boolean {
  if (blocks.length !== 1) return false;
  const b = blocks[0];
  if (!b || b.type !== "text") return false;
  return b.text.trim() === "/close";
}

let _externalWatchedId: string | null = null;
let _paneDropCleanup: (() => void) | null = null;

export function unwatchCurrentExternalSession(): void {
  if (_externalWatchedId) {
    void invoke<void>("unwatch_session_transcript", { sessionId: _externalWatchedId }).catch(() => {});
    _externalWatchedId = null;
  }
}

function dismountActivePane(): void {
  state.statusbar?.destroy();
  state.statusbar = null;
  state.renderer?.detach();
  state.renderer = null;
  state.composer?.destroy();
  state.composer = null;
  setActiveSession(null);
  const pane = document.querySelector<HTMLElement>(".session-pane #session-pane")
    ?? document.querySelector<HTMLElement>("#session-pane");
  if (pane) pane.innerHTML = `<div class="session-empty">Select or create a session</div>`;
  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }
}

function showChatLoadingOverlay(pane: HTMLElement): HTMLElement {
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
  if (state.selectedId === sessionId) return;
  _paneDropCleanup?.();
  _paneDropCleanup = null;
  // Unwatch any previous external session if we're switching to a different one.
  if (_externalWatchedId && _externalWatchedId !== sessionId) {
    void invoke<void>("unwatch_session_transcript", { sessionId: _externalWatchedId }).catch(() => {});
    _externalWatchedId = null;
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
  const readOnly = sess.kind === "external";

  pane.innerHTML = `
    <header class="session-header">
      <span class="title">${escapeHtml(sessionSubtitle(sess))}</span>
      <span class="meta">${escapeHtml(projectName(sess))}</span>
      ${readOnly ? "" : `<button class="icon-btn auto-accept-btn${isAutoAccept(sess.session_id) ? " is-on" : ""}" title="${isAutoAccept(sess.session_id) ? "Auto-accepting tool permissions. Click to disable." : "Auto-accept tool permissions for this session"}" aria-pressed="${isAutoAccept(sess.session_id) ? "true" : "false"}"><i class="ph ph-shield-check"></i></button>`}
      <button class="icon-btn open-terminal-btn" title="Open this chat in an external terminal (survives app restart)"><i class="ph ph-terminal-window"></i></button>
      <button class="icon-btn detach-btn" title="Detach"><i class="ph ph-arrow-square-out"></i></button>
      ${readOnly ? "" : '<button class="icon-btn close-session-btn" title="Close session"><i class="ph ph-x-circle"></i></button>'}
      ${readOnly ? "" : '<button class="icon-btn cancel-btn" title="Cancel turn"><i class="ph ph-x"></i></button>'}
    </header>
    <div class="session-statusbar-host"></div>
    ${readOnly ? '<div class="readonly-banner"><i class="ph ph-eye"></i> <span class="readonly-banner-text">Read-only session</span><button type="button" class="refresh-btn" title="Reload messages"><i class="ph ph-arrows-clockwise"></i></button><button type="button" class="takeover-btn">Take Over</button></div>' : ""}
    <div class="session-messages"></div>
    <div class="session-thinking" hidden></div>
    <div class="session-composer"></div>
  `;

  // Mount statusbar.
  const sbHost = pane.querySelector<HTMLElement>(".session-statusbar-host");
  if (sbHost) {
    const fields = await loadStatuslineFields();
    const sb = new SessionStatusbar(sbHost, sess.started_at, fields, {
      cwd: sess.cwd ? String(sess.cwd) : null,
      effort: sess.effort ?? "",
      sessionId: sess.session_id,
      readOnly: sess.kind === "external",
    });
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
    state.composer?.destroy();
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

        // `/close`: dismount the pane immediately and let the skill run in
        // the background. AskUserQuestion modals still surface (background
        // gate). When the turn ends, clear the session from the registry.
        if (isCloseCommand(blocks)) {
          const cwd = String(sess.cwd ?? ".");
          addBackgroundSession(sessionId);
          dismountActivePane();
          invoke<void>("send_message", { sessionId, cwd, blocks })
            .catch(err => console.error("[sessions] background /close send_message failed", err))
            .finally(() => {
              removeBackgroundSession(sessionId);
              invoke<void>("clear_session", { sessionId }).catch(() => {});
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
      },
    });
    state.composer.setSessionId(sessionId, { readOnly });

    const onPaneDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      pane.classList.add("drag-over");
    };
    const onPaneDragLeave = (e: DragEvent) => {
      if (e.relatedTarget && pane.contains(e.relatedTarget as Node)) return;
      pane.classList.remove("drag-over");
    };
    const onPaneDrop = async (e: Event) => {
      e.preventDefault();
      pane.classList.remove("drag-over");
      const drag = e as DragEvent;
      if (!drag.dataTransfer?.files.length) return;
      const composer = state.composer;
      if (!composer) return;
      await composer.dropFiles(Array.from(drag.dataTransfer.files));
    };
    pane.addEventListener("dragover", onPaneDragOver);
    pane.addEventListener("dragleave", onPaneDragLeave);
    pane.addEventListener("drop", onPaneDrop);
    _paneDropCleanup = () => {
      pane.removeEventListener("dragover", onPaneDragOver);
      pane.removeEventListener("dragleave", onPaneDragLeave);
      pane.removeEventListener("drop", onPaneDrop);
      pane.classList.remove("drag-over");
    };
  }

  // Wire header buttons
  const autoBtn = pane.querySelector<HTMLButtonElement>(".auto-accept-btn");
  if (autoBtn) {
    autoBtn.addEventListener("click", () => {
      const next = !isAutoAccept(sessionId);
      setAutoAccept(sessionId, next);
      autoBtn.classList.toggle("is-on", next);
      autoBtn.setAttribute("aria-pressed", next ? "true" : "false");
      autoBtn.title = next
        ? "Auto-accepting tool permissions. Click to disable."
        : "Auto-accept tool permissions for this session";
    });
  }
  pane.querySelector<HTMLButtonElement>(".open-terminal-btn")?.addEventListener("click", async () => {
    try {
      await invoke<void>("open_session_in_terminal", { sessionId });
    } catch (err) {
      console.error("[sessions] open_session_in_terminal failed", err);
      alert(`Failed to open terminal: ${err}`);
    }
  });
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
      const currentSess = state.sessions.find(s => s.session_id === sessionId);
      if (currentSess?.busy) {
        if (!confirm("A turn is in progress. Close and discard it?")) return;
        await invoke<void>("cancel_turn", { sessionId });
      }
      await invoke<void>("clear_session", { sessionId });
    });
  }
  if (readOnly) {
    // Start real-time file watcher: new JSONL lines emit chat:<id> events
    // which the renderer's existing subscriber picks up automatically.
    _externalWatchedId = sessionId;
    void invoke<void>("watch_session_transcript", { sessionId, cwd: sess.cwd ?? null }).catch(() => {});

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
}

