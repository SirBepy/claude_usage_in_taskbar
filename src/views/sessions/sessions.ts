import { html, render, type TemplateResult } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { Composer } from "../../shared/chat/composer";
import "../../shared/chat/chat.css";
import "./sessions.css";
import type { Instance, ChatEvent, ContentBlock, ProjectGroup } from "../../types/ipc.generated";

interface PendingNewSession {
  cwd: string;
  name: string;
}

interface SessionsState {
  mountId: number;
  sessions: Instance[];
  selectedId: string | null;
  pendingNewSession: PendingNewSession | null;
  filter: string;
  renderer: ChatRenderer | null;
  composer: Composer | null;
  unlistenInstances: (() => void) | null;
}

// Module-level singleton. mountId protects against stale-mount writes when
// the user rapid-fires view switches: every async callback reads the current
// state.mountId and bails if it no longer matches the captured id.
let state: SessionsState = {
  mountId: 0,
  sessions: [],
  selectedId: null,
  pendingNewSession: null,
  filter: "",
  renderer: null,
  composer: null,
  unlistenInstances: null,
};
let nextMountId = 1;

function isLive(i: Instance): boolean {
  return !i.ended_at && (i.kind === "interactive" || i.kind === "external");
}

async function refreshSessions(): Promise<void> {
  try {
    const all = await invoke<Instance[]>("list_instances");
    state.sessions = (all || []).filter(isLive);
  } catch (err) {
    console.error("[sessions] list_instances failed", err);
    state.sessions = [];
  }
}

function statusClass(i: Instance): string {
  if (i.kind === "external") return "done"; // Manual = read-only, dim
  if (i.busy) return "running";
  return "input"; // not busy = waiting for user input
}

function sessionTitle(i: Instance): string {
  return i.name || i.session_id.slice(0, 12);
}

function renderSidebar(listEl: HTMLElement): void {
  const filter = state.filter.toLowerCase();
  const filtered = state.sessions.filter((s) =>
    !filter || sessionTitle(s).toLowerCase().includes(filter),
  );
  const items = filtered
    .map((s) => {
      const isExternal = s.kind === "external";
      const badge = isExternal
        ? '<span class="session-row-badge readonly" title="Read-only external session"><i class="ph ph-eye"></i></span>'
        : "";
      return `<li data-session-id="${escapeHtml(s.session_id)}" class="${s.session_id === state.selectedId ? "active" : ""} ${isExternal ? "is-external" : ""}">
          <span class="session-status-dot ${statusClass(s)}"></span>
          <span class="session-title">${escapeHtml(sessionTitle(s))}</span>
          ${badge}
          <span class="session-row-kind">${escapeHtml(s.kind)}</span>
        </li>`;
    })
    .join("");
  // Pending-new-session row (transient, rendered above real sessions).
  const pending = state.pendingNewSession;
  const pendingRow = pending
    ? `<li class="pending-new active">
        <span class="session-status-dot input"></span>
        <span class="session-title">New chat - ${escapeHtml(pending.name)}</span>
        <span class="session-row-kind">draft</span>
      </li>`
    : "";
  listEl.innerHTML = pendingRow + items;
}

// ──────────────────────────────────────────────────────────────────────────
// Project picker modal (replaces window.prompt)
// ──────────────────────────────────────────────────────────────────────────

function ensureModalHost(): HTMLElement {
  let host = document.getElementById("sessions-modal-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "sessions-modal-host";
    document.body.appendChild(host);
  }
  return host;
}

function closeModal(host: HTMLElement, onEsc: (e: KeyboardEvent) => void): void {
  host.classList.remove("open");
  render(html``, host);
  document.removeEventListener("keydown", onEsc);
}

async function openProjectPickerModal(): Promise<{ path: string; name: string } | null> {
  let projects: ProjectGroup[] = [];
  try {
    projects = (await invoke<ProjectGroup[]>("list_project_groups")) || [];
  } catch (err) {
    console.error("[sessions] list_project_groups failed", err);
  }
  if (!projects.length) {
    // Still surface a styled message rather than alert(), but the modal
    // collapses to a "no projects" state with just a Cancel.
    return new Promise((resolve) => {
      const host = ensureModalHost();
      const onEsc = (e: KeyboardEvent) => {
        if (e.key === "Escape") finish(null);
      };
      const finish = (val: { path: string; name: string } | null) => {
        closeModal(host, onEsc);
        resolve(val);
      };
      render(
        html`
          <div class="sm-backdrop" @click=${() => finish(null)}></div>
          <div class="sm-card" role="dialog" aria-modal="true" aria-label="Pick a project">
            <header class="sm-header"><h3>Pick a project</h3></header>
            <div class="sm-body">
              <p class="sm-empty">No projects detected yet. Run claude in a folder first or add a project from the Projects view.</p>
            </div>
            <footer class="sm-footer">
              <button class="btn btn-secondary" @click=${() => finish(null)}>Close</button>
            </footer>
          </div>
        `,
        host,
      );
      host.classList.add("open");
      document.addEventListener("keydown", onEsc);
    });
  }

  return new Promise((resolve) => {
    const host = ensureModalHost();
    let selectedIdx: number | null = null;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };
    const finish = (val: { path: string; name: string } | null) => {
      closeModal(host, onEsc);
      resolve(val);
    };
    const onContinue = () => {
      if (selectedIdx === null) return;
      const p = projects[selectedIdx];
      if (!p) return finish(null);
      finish({ path: p.path, name: p.name });
    };
    const draw = () => {
      const tpl: TemplateResult = html`
        <div class="sm-backdrop" @click=${() => finish(null)}></div>
        <div class="sm-card" role="dialog" aria-modal="true" aria-label="Pick a project">
          <header class="sm-header"><h3>Pick a project</h3></header>
          <div class="sm-body sm-body-list">
            <ul class="sm-project-list">
              ${projects.map(
                (p, i) => html`
                  <li
                    class="sm-project-row ${selectedIdx === i ? "selected" : ""}"
                    @click=${() => {
                      selectedIdx = i;
                      draw();
                    }}
                    @dblclick=${() => {
                      selectedIdx = i;
                      onContinue();
                    }}
                  >
                    <div class="sm-project-name">${p.name}</div>
                    <div class="sm-project-path">${p.path}</div>
                  </li>
                `,
              )}
            </ul>
          </div>
          <footer class="sm-footer">
            <button class="btn btn-secondary" @click=${() => finish(null)}>Cancel</button>
            <button
              class="btn btn-primary"
              ?disabled=${selectedIdx === null}
              @click=${onContinue}
            >
              Continue
            </button>
          </footer>
        </div>
      `;
      render(tpl, host);
    };
    draw();
    host.classList.add("open");
    document.addEventListener("keydown", onEsc);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// New-session flow
// ──────────────────────────────────────────────────────────────────────────

async function startNewSession(pane: HTMLElement): Promise<void> {
  const project = await openProjectPickerModal();
  if (!project) return;

  // Set transient pending state and render an empty chat pane immediately.
  state.pendingNewSession = { cwd: project.path, name: project.name };
  state.selectedId = null;

  // Refresh sidebar to show the pending row + clear any active row.
  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }

  renderPendingPane(pane);
}

function renderPendingPane(pane: HTMLElement): void {
  const myMount = state.mountId;
  const pending = state.pendingNewSession;
  if (!pending) return;

  // Tear down any prior renderer/composer.
  if (state.renderer) {
    state.renderer.detach();
    state.renderer = null;
  }
  state.composer = null;

  pane.innerHTML = `
    <header class="session-header">
      <span class="title">New chat</span>
      <span class="meta">${escapeHtml(pending.name)} - ${escapeHtml(pending.cwd)}</span>
    </header>
    <div class="session-messages">
      <div class="session-pending-hint">
        <i class="ph ph-paper-plane-tilt"></i>
        <p>Type a message below to start a new session in <strong>${escapeHtml(pending.name)}</strong>.</p>
      </div>
    </div>
    <div class="session-composer"></div>
  `;

  const composerEl = pane.querySelector<HTMLElement>(".session-composer");
  if (!composerEl) return;
  // Composer with onSend that bootstraps the real session, then routes
  // subsequent messages through send_message.
  state.composer = new Composer(composerEl, {
    onSend: async (blocks: ContentBlock[]) => {
      // Bail if mount/state changed during the await (e.g. user navigated away).
      if (state.mountId !== myMount) return;
      const cwd = pending.cwd;
      // Collapse blocks into a single text prompt for start_session. The
      // backend's start_session takes a string prompt; image attachments are
      // surfaced as <file:path> mention text inside the same prompt.
      const promptText = blocks
        .map((b) => (b && b.type === "text" ? b.text : ""))
        .filter((s) => s)
        .join("\n");
      if (!promptText.trim()) return;
      try {
        const sessionId = await invoke<string>("start_session", {
          cwd,
          prompt: promptText,
        });
        if (state.mountId !== myMount) return;
        if (sessionId) {
          state.pendingNewSession = null;
          await refreshSessions();
          if (state.mountId !== myMount) return;
          const root = document.querySelector<HTMLElement>(".view-sessions");
          if (root) {
            const listEl = root.querySelector<HTMLElement>("#sessions-list");
            if (listEl) renderSidebar(listEl);
          }
          await selectSession(sessionId, pane);
        }
      } catch (err) {
        console.error("[sessions] start_session failed", err);
        alert(`Failed to start session: ${err}`);
      }
    },
  });
  // No real session_id yet. Pass a placeholder; image-paste is allowed
  // visually but paste_image IPC requires a session_id, so the composer's
  // attachments path will fall back to "image dropped" until the real
  // session_id materialises.
  state.composer.setSessionId("__pending__", { readOnly: false });

  // Focus composer so user can immediately type.
  const ta = pane.querySelector<HTMLTextAreaElement>(".composer-textarea");
  if (ta) ta.focus();
}

async function selectSession(sessionId: string, pane: HTMLElement): Promise<void> {
  const myMount = state.mountId;
  state.selectedId = sessionId;
  state.pendingNewSession = null;
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) {
    pane.innerHTML = `<div class="session-empty">Session ${escapeHtml(sessionId)} not found</div>`;
    return;
  }
  const readOnly = sess.kind === "external";

  pane.innerHTML = `
    <header class="session-header">
      <span class="title">${escapeHtml(sessionTitle(sess))}</span>
      <span class="meta">${escapeHtml(sess.kind)}${sess.pid ? ` - pid ${sess.pid}` : ""}</span>
      ${readOnly ? '<button class="icon-btn takeover-btn" title="Take over"><i class="ph ph-arrow-clockwise"></i></button>' : ""}
      <button class="icon-btn detach-btn" title="Detach"><i class="ph ph-arrow-square-out"></i></button>
      ${readOnly ? "" : '<button class="icon-btn cancel-btn" title="Cancel turn"><i class="ph ph-x"></i></button>'}
    </header>
    ${readOnly ? '<div class="readonly-banner"><i class="ph ph-eye"></i> Read-only session - click <strong>Take Over</strong> to interact.</div>' : ""}
    <div class="session-messages"></div>
    <div class="session-composer"></div>
  `;

  // Attach renderer
  if (state.renderer) state.renderer.detach();
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (messagesEl) {
    const renderer = new ChatRenderer(messagesEl);
    state.renderer = renderer;
    await renderer.attach(sessionId);
    // Bail if a newer mount or selectSession superseded us during await.
    if (state.mountId !== myMount || state.selectedId !== sessionId) {
      renderer.detach();
      return;
    }
    // Replay history if available. For external read-only sessions the
    // backend now accepts a cwd hint so it can locate the JSONL.
    try {
      const args: { sessionId: string; cwd?: string } = { sessionId };
      if (sess.cwd) args.cwd = String(sess.cwd);
      const events = await invoke<ChatEvent[]>("load_history", args);
      if (state.mountId !== myMount || state.selectedId !== sessionId) {
        renderer.detach();
        return;
      }
      if (Array.isArray(events) && events.length > 0) renderer.loadHistory(events);
    } catch {
      /* load_history not yet available; skip silently */
    }
  }

  // Attach composer
  const composerEl = pane.querySelector<HTMLElement>(".session-composer");
  if (composerEl) {
    state.composer = new Composer(composerEl, {
      onSend: async (blocks: ContentBlock[]) => {
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
  if (readOnly) {
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

export async function renderSessionsView(root: HTMLElement): Promise<() => void> {
  // Reset state on each mount; bump mountId so any pending async work from
  // a prior mount sees a stale id and bails.
  const myMount = nextMountId++;
  state = {
    mountId: myMount,
    sessions: [],
    selectedId: null,
    pendingNewSession: null,
    filter: "",
    renderer: null,
    composer: null,
    unlistenInstances: null,
  };

  render(template(), root);

  const view = root.querySelector<HTMLElement>(".view-sessions");
  const listEl = root.querySelector<HTMLElement>("#sessions-list");
  const pane = root.querySelector<HTMLElement>("#session-pane");
  const newBtn = root.querySelector<HTMLButtonElement>("#newSessionBtn");
  const filterInput = root.querySelector<HTMLInputElement>("#sessions-filter");

  if (!view || !listEl || !pane) {
    console.error("[sessions] view template missing expected nodes");
    return () => { /* no-op */ };
  }

  // Initial load
  await refreshSessions();
  renderSidebar(listEl);

  // Subscribe to live registry updates
  const ev = window.__TAURI__?.event;
  if (ev?.listen) {
    state.unlistenInstances = await ev.listen("instances-changed", async () => {
      if (state.mountId !== myMount) return;
      await refreshSessions();
      if (state.mountId !== myMount) return;
      renderSidebar(listEl);
      // If the previously-selected session vanished (e.g. takeover renamed it,
      // or it was ended externally), clear the pane to avoid stale content.
      if (state.selectedId && !state.sessions.find((s) => s.session_id === state.selectedId)) {
        if (state.renderer) state.renderer.detach();
        state.renderer = null;
        state.composer = null;
        state.selectedId = null;
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

  // Wire filter input
  if (filterInput) {
    filterInput.addEventListener("input", () => {
      state.filter = filterInput.value;
      renderSidebar(listEl);
    });
  }

  // Wire row clicks (delegated)
  listEl.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
    if (!li) return;
    const id = li.dataset.sessionId;
    if (id) void selectSession(id, pane);
  });

  return () => {
    if (state.unlistenInstances) {
      try { state.unlistenInstances(); } catch { /* ignore */ }
      state.unlistenInstances = null;
    }
    if (state.renderer) {
      state.renderer.detach();
      state.renderer = null;
    }
    state.composer = null;
    state.selectedId = null;
    state.pendingNewSession = null;
    // Tear down any open project-picker modal so it doesn't outlive the view.
    const modalHost = document.getElementById("sessions-modal-host");
    if (modalHost) {
      modalHost.classList.remove("open");
      render(html``, modalHost);
    }
  };
}

function template() {
  return html`
    <div class="view view-sessions">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Sessions</h2>
        <button
          class="icon-btn"
          id="newSessionBtn"
          title="Loading..."
          disabled
        >
          <i class="ph ph-plus"></i>
        </button>
      </div>
      <div class="view-body sessions-layout">
        <aside class="sessions-sidebar">
          <input
            id="sessions-filter"
            class="sessions-filter"
            type="search"
            placeholder="Filter"
          />
          <ul id="sessions-list" class="sessions-list"></ul>
        </aside>
        <main class="session-pane" id="session-pane">
          <div class="session-empty">Select or create a session</div>
        </main>
      </div>
    </div>
  `;
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
  const myMount = nextMountId++;
  state = {
    mountId: myMount,
    sessions: [],
    selectedId: null,
    pendingNewSession: null,
    filter: "",
    renderer: null,
    composer: null,
    unlistenInstances: null,
  };

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

  return () => {
    if (state.unlistenInstances) {
      try { state.unlistenInstances(); } catch { /* ignore */ }
      state.unlistenInstances = null;
    }
    if (state.renderer) {
      state.renderer.detach();
      state.renderer = null;
    }
    state.composer = null;
    state.selectedId = null;
    state.pendingNewSession = null;
  };
}

function detachedTemplate(sessionId: string) {
  return html`
    <div class="view view-sessions detached">
      <div class="view-body sessions-layout detached-layout">
        <main class="session-pane" id="session-pane" data-session-id=${sessionId}>
          <div class="session-empty">Loading...</div>
        </main>
      </div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}
