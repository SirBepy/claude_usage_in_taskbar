import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { Composer } from "../../shared/chat/composer";
import "../../shared/chat/chat.css";
import "./sessions.css";
import type { Instance, ChatEvent, ContentBlock, ProjectGroup } from "../../types/ipc.generated";

interface SessionsState {
  mountId: number;
  sessions: Instance[];
  selectedId: string | null;
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
  listEl.innerHTML = filtered
    .map(
      (s) =>
        `<li data-session-id="${escapeHtml(s.session_id)}" class="${s.session_id === state.selectedId ? "active" : ""}">
          <span class="session-status-dot ${statusClass(s)}"></span>
          <span class="session-title">${escapeHtml(sessionTitle(s))}</span>
          <span class="session-project" style="margin-left:auto;color:var(--text-dim);font-size:0.75rem">${s.kind}</span>
        </li>`,
    )
    .join("");
}

async function pickProject(): Promise<{ path: string; name: string } | null> {
  let projects: ProjectGroup[] = [];
  try {
    projects = (await invoke<ProjectGroup[]>("list_project_groups")) || [];
  } catch (err) {
    console.error("[sessions] list_project_groups failed", err);
  }
  if (!projects.length) {
    alert("No projects detected yet. Run claude in a folder first or add a project.");
    return null;
  }
  const lines = projects
    .map((p, i) => `${i + 1}. ${p.name} (${p.path})`)
    .join("\n");
  const choice = window.prompt(`Pick project (number):\n${lines}`, "1");
  if (!choice) return null;
  const idx = parseInt(choice, 10) - 1;
  const picked = projects[idx];
  if (!picked) return null;
  return { path: picked.path, name: picked.name };
}

async function startNewSession(pane: HTMLElement): Promise<void> {
  const project = await pickProject();
  if (!project) return;
  const firstPrompt = window.prompt("First message to send:");
  if (!firstPrompt) return;
  try {
    const sessionId = await invoke<string>("start_session", {
      cwd: project.path,
      prompt: firstPrompt,
    });
    if (sessionId) {
      await refreshSessions();
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
}

async function selectSession(sessionId: string, pane: HTMLElement): Promise<void> {
  const myMount = state.mountId;
  state.selectedId = sessionId;
  const sess = state.sessions.find((s) => s.session_id === sessionId);
  if (!sess) {
    pane.innerHTML = `<div class="session-empty">Session ${escapeHtml(sessionId)} not found</div>`;
    return;
  }
  const readOnly = sess.kind === "external";

  pane.innerHTML = `
    <header class="session-header">
      <span class="title">${escapeHtml(sessionTitle(sess))}</span>
      <span class="meta">${escapeHtml(sess.kind)} - ${sess.pid ? `pid ${sess.pid}` : "no pid"}</span>
      ${readOnly ? '<button class="icon-btn takeover-btn" title="Take over"><i class="ph ph-arrow-clockwise"></i></button>' : ""}
      <button class="icon-btn detach-btn" title="Detach"><i class="ph ph-arrow-square-out"></i></button>
      <button class="icon-btn cancel-btn" title="Cancel turn"><i class="ph ph-x"></i></button>
    </header>
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
    // Replay history if available (Phase 8 IPC; tolerate absence). Pass cwd so
    // the backend hits ~/.claude/projects/<encoded-cwd>/<id>.jsonl directly
    // without scanning every project dir.
    try {
      const events = await invoke<ChatEvent[]>("load_history", {
        sessionId,
        cwd: String(sess.cwd ?? ""),
      });
      if (state.mountId !== myMount || state.selectedId !== sessionId) {
        renderer.detach();
        return;
      }
      if (Array.isArray(events) && events.length > 0) renderer.loadHistory(events);
    } catch {
      /* Phase 8a not landed yet; skip silently */
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
