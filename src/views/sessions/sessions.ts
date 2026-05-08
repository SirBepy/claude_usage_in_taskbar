import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { showView } from "../../shared/navigation";
import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { Composer } from "../../shared/chat/composer";
import "../../shared/chat/chat.css";
import "./sessions.css";
import type { Instance, ChatEvent, ContentBlock, ProjectGroup } from "../../types/ipc.generated";

type SortChoice = "name" | "recent";
const SORT_STORAGE_KEY = "claude_companion_sessions_modal_sort";

function readStoredSort(): SortChoice {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (v === "name" || v === "recent") return v;
  } catch { /* localStorage may throw in private mode; ignore */ }
  return "name";
}

function writeStoredSort(choice: SortChoice): void {
  try { localStorage.setItem(SORT_STORAGE_KEY, choice); }
  catch { /* ignore */ }
}

interface PendingNewSession {
  placeholderId: string;
  projectPath: string;
  projectName: string;
  // Once the real session_id is captured from the first SessionStarted event,
  // we record it here so refreshSessions/renderSidebar can suppress the real
  // entry from the registry list (the pending row, now upgraded, represents
  // it). Cleared when start_session resolves.
  realId: string | null;
}

interface SessionsState {
  mountId: number;
  sessions: Instance[];
  selectedId: string | null;
  filter: string;
  renderer: ChatRenderer | null;
  composer: Composer | null;
  unlistenInstances: (() => void) | null;
  pendingNewSession: PendingNewSession | null;
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
  pendingNewSession: null,
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
  const pending = state.pendingNewSession;
  // When a new-session turn is pending, suppress the real registry entry
  // (if any) so the sidebar shows ONLY the pending row. The real entry
  // appears the moment Rust captures SessionStarted and emits
  // instances-changed; without this filter the user briefly sees TWO rows
  // for the same in-progress session.
  let visible = state.sessions;
  if (pending && pending.realId) {
    visible = visible.filter((s) => s.session_id !== pending.realId);
  }
  const filtered = visible.filter((s) =>
    !filter || sessionTitle(s).toLowerCase().includes(filter),
  );
  const realRows = filtered
    .map(
      (s) =>
        `<li data-session-id="${escapeHtml(s.session_id)}" class="${s.session_id === state.selectedId ? "active" : ""}">
          <span class="session-status-dot ${statusClass(s)}"></span>
          <span class="session-title">${escapeHtml(sessionTitle(s))}</span>
          <span class="session-project" style="margin-left:auto;color:var(--text-dim);font-size:0.75rem">${s.kind}</span>
        </li>`,
    )
    .join("");
  let pendingRow = "";
  if (pending) {
    // Pending row is non-clickable (no data-session-id attr). Always
    // active-styled because while pending the user is interacting with it.
    const title = pending.projectName || "New session";
    pendingRow = `<li class="active pending" data-pending="1" title="Starting new session...">
          <span class="session-status-dot running"></span>
          <span class="session-title">${escapeHtml(title)}</span>
          <span class="session-project" style="margin-left:auto;color:var(--text-dim);font-size:0.75rem">starting...</span>
        </li>`;
  }
  listEl.innerHTML = pendingRow + realRows;
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

  // Fetch latest .jsonl mtime per project for the "Most recent" sort.
  // Best-effort: failures fall back to 0 (sorts to bottom).
  const mtimes = await Promise.all(
    projects.map((p) =>
      invoke<number>("project_last_activity_at", { cwd: p.path })
        .catch(() => 0),
    ),
  );

  return openProjectPickerModal(projects, mtimes);
}

function openProjectPickerModal(
  projects: ProjectGroup[],
  mtimes: number[],
): Promise<{ path: string; name: string } | null> {
  return new Promise((resolve) => {
    const host = ensureModalHost();
    let resolved = false;
    const finish = (val: { path: string; name: string } | null) => {
      if (resolved) return;
      resolved = true;
      closeModal();
      resolve(val);
    };

    let sort: SortChoice = readStoredSort();
    let filter = "";

    const computeRows = (): ProjectGroup[] => {
      const f = filter.trim().toLowerCase();
      let rows = projects.filter((p) =>
        !f
        || p.name.toLowerCase().includes(f)
        || p.path.toLowerCase().includes(f)
      );
      if (sort === "name") {
        rows = rows.slice().sort((a, b) => a.name.localeCompare(b.name));
      } else {
        // "recent": use mtimes index lookup. Items with mtime=0 sort last.
        rows = rows.slice().sort((a, b) => {
          const ai = projects.indexOf(a);
          const bi = projects.indexOf(b);
          const am = mtimes[ai] ?? 0;
          const bm = mtimes[bi] ?? 0;
          return bm - am;
        });
      }
      return rows;
    };

    const renderModal = () => {
      const rows = computeRows();
      const tpl = html`
        <div class="modal-backdrop" @click=${() => finish(null)}></div>
        <div
          class="modal-card project-picker-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Pick project"
        >
          <header class="modal-header">
            <h3>Pick project</h3>
            <select
              class="project-picker-sort"
              .value=${sort}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v === "name" || v === "recent") {
                  sort = v;
                  writeStoredSort(sort);
                  renderModal();
                }
              }}
            >
              <option value="name">Name (A-Z)</option>
              <option value="recent">Most recent</option>
            </select>
          </header>
          <div class="modal-body project-picker-body">
            <input
              id="project-picker-search"
              class="project-picker-search"
              type="text"
              placeholder="Search projects..."
              .value=${filter}
              @input=${(e: Event) => {
                filter = (e.target as HTMLInputElement).value;
                renderModal();
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  if (filter !== "") {
                    e.preventDefault();
                    e.stopPropagation();
                    filter = "";
                    renderModal();
                  } else {
                    finish(null);
                  }
                } else if (e.key === "Enter") {
                  const matches = computeRows();
                  if (matches.length === 1) {
                    e.preventDefault();
                    const m = matches[0]!;
                    finish({ path: m.path, name: m.name });
                  }
                }
              }}
            />
            <ul class="project-picker-list">
              ${rows.length === 0
                ? html`<li class="project-picker-empty">No matches</li>`
                : rows.map(
                    (p) => html`
                      <li
                        class="project-picker-row"
                        @click=${() => finish({ path: p.path, name: p.name })}
                      >
                        <span class="project-picker-name">${p.name}</span>
                        <span class="project-picker-path">${p.path}</span>
                      </li>
                    `,
                  )}
            </ul>
          </div>
          <footer class="modal-footer">
            <button class="btn btn-secondary" @click=${() => finish(null)}>Cancel</button>
          </footer>
        </div>
      `;
      render(tpl, host);
      // Autofocus the search input on first render. Re-focus on subsequent
      // renders only if focus was already inside the modal (avoid stealing
      // focus from the dropdown).
      const input = host.querySelector<HTMLInputElement>("#project-picker-search");
      const active = document.activeElement;
      const shouldFocus = !active
        || active === document.body
        || (active instanceof HTMLElement && active.id === "project-picker-search");
      if (input && shouldFocus) {
        // Defer to next tick so lit-html finishes attaching DOM.
        setTimeout(() => input.focus(), 0);
      }
    };

    host.classList.add("open");
    renderModal();
  });
}

function ensureModalHost(): HTMLElement {
  let host = document.getElementById("modal-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "modal-host";
    document.body.appendChild(host);
  }
  return host;
}

function closeModal(): void {
  const host = document.getElementById("modal-host");
  if (!host) return;
  host.classList.remove("open");
  render(html``, host);
}

/**
 * Generate a placeholder session id used to subscribe `chat:<id>` BEFORE
 * the real session_id is known. The Rust side validates this matches
 * `pending-` + alphanumeric/dash/underscore. We append a millisecond
 * timestamp + 8 random hex chars to keep two concurrent new-session
 * attempts isolated.
 */
function makePlaceholderId(): string {
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `pending-${ts}-${rnd}`;
}

async function startNewSession(pane: HTMLElement): Promise<void> {
  const myMount = state.mountId;
  const project = await pickProject();
  if (!project) return;
  if (state.mountId !== myMount) return;
  const firstPrompt = window.prompt("First message to send:");
  if (!firstPrompt) return;
  if (state.mountId !== myMount) return;

  // Refuse to overlap two pending new-session attempts. The user can wait
  // for the in-flight one to complete before starting another.
  if (state.pendingNewSession) {
    alert("Another new session is still starting; please wait for it to finish.");
    return;
  }

  const placeholderId = makePlaceholderId();
  state.pendingNewSession = {
    placeholderId,
    projectPath: project.path,
    projectName: project.name,
    realId: null,
  };
  state.selectedId = placeholderId;

  // Render the pane immediately. The renderer subscribes to chat:<placeholder>
  // BEFORE invoking start_session, so it sees the SessionStarted event mirrored
  // by Rust onto the placeholder channel and can swap to the real id without
  // missing any partial-message stream events.
  await renderPendingPane(pane, placeholderId, project, firstPrompt);
  if (state.mountId !== myMount) return;

  // Re-render sidebar to show the pending row.
  const root = document.querySelector<HTMLElement>(".view-sessions");
  if (root) {
    const listEl = root.querySelector<HTMLElement>("#sessions-list");
    if (listEl) renderSidebar(listEl);
  }

  try {
    const sessionId = await invoke<string>("start_session", {
      cwd: project.path,
      prompt: firstPrompt,
      placeholderId,
    });
    if (state.mountId !== myMount) return;
    if (sessionId) {
      // The renderer should have already swapped to chat:<sessionId> when
      // the SessionStarted event fired mid-stream. If for any reason it
      // didn't (race), force-swap now so subsequent send_message events
      // land in this renderer.
      if (state.renderer && state.renderer.currentSessionId() !== sessionId) {
        await state.renderer.swapSubscription(sessionId);
      }
      // Rebind the composer to the real session id so future onSend calls
      // use send_message(real_id) instead of trying to start a new session.
      if (state.composer) {
        state.composer.setSessionId(sessionId, { readOnly: false });
      }
      state.selectedId = sessionId;
      // Clear pending; refreshSessions will surface the real entry now.
      state.pendingNewSession = null;
      await refreshSessions();
      if (state.mountId !== myMount) return;
      const root2 = document.querySelector<HTMLElement>(".view-sessions");
      if (root2) {
        const listEl = root2.querySelector<HTMLElement>("#sessions-list");
        if (listEl) renderSidebar(listEl);
      }
      // Rewire the pane header buttons to use the real id (the pending pane
      // wired them to the placeholder for cancel_turn).
      rebindPaneHeader(pane, sessionId);
    }
  } catch (err) {
    console.error("[sessions] start_session failed", err);
    state.pendingNewSession = null;
    state.selectedId = null;
    if (state.renderer) state.renderer.detach();
    state.renderer = null;
    state.composer = null;
    pane.innerHTML = `<div class="session-empty">Failed to start session: ${escapeHtml(String(err))}</div>`;
    const root2 = document.querySelector<HTMLElement>(".view-sessions");
    if (root2) {
      const listEl = root2.querySelector<HTMLElement>("#sessions-list");
      if (listEl) renderSidebar(listEl);
    }
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
async function renderPendingPane(
  pane: HTMLElement,
  placeholderId: string,
  project: { path: string; name: string },
  _firstPrompt: string,
): Promise<void> {
  const myMount = state.mountId;
  pane.innerHTML = `
    <header class="session-header">
      <span class="title">${escapeHtml(project.name)}</span>
      <span class="meta">starting new session...</span>
      <button class="icon-btn cancel-btn" title="Cancel turn"><i class="ph ph-x"></i></button>
    </header>
    <div class="session-messages"></div>
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
    // Hook into the placeholder channel to capture the real session_id and
    // swap subscription. We use a separate listener (not the renderer's own)
    // so we can read the SessionStarted payload and call swapSubscription.
    const ev = window.__TAURI__?.event;
    if (ev?.listen) {
      const unlistenPromise = ev.listen<ChatEvent>(`chat:${placeholderId}`, async (e) => {
        const payload = e.payload;
        if (payload.type === "session_started") {
          const realId = payload.session_id;
          if (!realId) return;
          if (state.mountId !== myMount) return;
          // Mark realId so renderSidebar suppresses the duplicate registry row.
          if (state.pendingNewSession) {
            state.pendingNewSession.realId = realId;
          }
          // Swap renderer subscription to the real id channel.
          if (state.renderer && state.renderer.currentSessionId() === placeholderId) {
            await state.renderer.swapSubscription(realId);
          }
          // Re-render sidebar to suppress the just-added duplicate row.
          const root = document.querySelector<HTMLElement>(".view-sessions");
          if (root) {
            const listEl = root.querySelector<HTMLElement>("#sessions-list");
            if (listEl) renderSidebar(listEl);
          }
          // One-shot: drop this listener now that we've captured the id.
          try {
            (await unlistenPromise)();
          } catch {
            /* ignore */
          }
        }
      });
      // Fire-and-forget; the listener cleans itself up after capture.
      void unlistenPromise;
    }
  }

  // Composer is attached here so the user CAN type a follow-up turn while
  // the first turn is still streaming. onSend uses the resolved real id if
  // available (set on state.pendingNewSession.realId), otherwise queues by
  // disabling the composer until SessionStarted fires. For v1 simplicity:
  // composer is enabled but onSend bails with a notice if the real id is
  // not yet known.
  const composerEl = pane.querySelector<HTMLElement>(".session-composer");
  if (composerEl) {
    state.composer = new Composer(composerEl, {
      onSend: async (blocks: ContentBlock[]) => {
        const realId = state.pendingNewSession?.realId;
        if (!realId) {
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
    meta.textContent = `${sess.kind} - ${sess.pid ? `pid ${sess.pid}` : "no pid"}`;
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
    // Replay history if available (Phase 8 IPC; tolerate absence).
    try {
      const events = await invoke<ChatEvent[]>("load_history", { sessionId });
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
    pendingNewSession: null,
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

  // Wire row clicks (delegated). Block clicks while a new-session turn is
  // pending so the user can't accidentally navigate away from the in-flight
  // chat (which would orphan the renderer subscription and surface the bug
  // we just fixed). The pending row itself has no data-session-id so it's
  // naturally non-clickable.
  listEl.addEventListener("click", (e) => {
    if (state.pendingNewSession) return;
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
          id="historyBtn"
          title="History"
          @click=${() => showView("history")}
        >
          <i class="ph ph-clock-counter-clockwise"></i>
        </button>
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
    pendingNewSession: null,
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
