import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { showView } from "../../shared/navigation";
import { invoke } from "../../shared/ipc";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { Composer } from "../../shared/chat/composer";
import "../../shared/chat/chat.css";
import "./sessions.css";
import type { Instance, ChatEvent, ContentBlock, ProjectGroup, GitInfo } from "../../types/ipc.generated";
import {
  projectName,
  sessionSubtitle,
  statusIndicator,
  sortSessions,
  loadUnreadSet,
  saveUnreadSet,
  loadSort,
  loadStateStyle,
  LS_SORT,
} from "./sessions-helpers";
import type { SessionSort } from "./sessions-helpers";

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
  statusbar: SessionStatusbar | null;
  prevBusyMap: Map<string, boolean>;
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
  statusbar: null,
  prevBusyMap: new Map(),
};
let nextMountId = 1;

let activeCtxMenu: HTMLElement | null = null;

function closeCtxMenu(): void {
  if (activeCtxMenu) {
    activeCtxMenu.remove();
    activeCtxMenu = null;
  }
}

function openCtxMenu(
  sessionId: string,
  anchor: HTMLElement,
  pane: HTMLElement,
): void {
  closeCtxMenu();

  const sess = state.sessions.find(s => s.session_id === sessionId);
  if (!sess) return;

  const menu = document.createElement("div");
  menu.className = "session-ctx-menu";

  // "New agent here"
  const newItem = document.createElement("button");
  newItem.className = "session-ctx-item";
  newItem.innerHTML = '<i class="ph ph-plus"></i> New agent here';
  newItem.addEventListener("click", () => {
    closeCtxMenu();
    void launchNewSession(pane, { path: String(sess.cwd), name: projectName(sess) });
  });
  menu.appendChild(newItem);

  // "Run /close" — interactive non-busy only
  if (sess.kind === "interactive" && !sess.busy) {
    const closeItem = document.createElement("button");
    closeItem.className = "session-ctx-item";
    closeItem.innerHTML = '<i class="ph ph-door-open"></i> Run /close';
    closeItem.addEventListener("click", async () => {
      closeCtxMenu();
      try {
        await invoke<void>("send_message", {
          sessionId,
          cwd: String(sess.cwd ?? "."),
          blocks: [{ type: "text", text: "/close" }],
        });
        void selectSession(sessionId, pane);
      } catch (err) {
        console.error("[sessions] send /close failed", err);
      }
    });
    menu.appendChild(closeItem);
  }

  // "Open in VS Code"
  const codeItem = document.createElement("button");
  codeItem.className = "session-ctx-item";
  codeItem.innerHTML = '<i class="ph ph-code"></i> Open in VS Code';
  codeItem.addEventListener("click", async () => {
    closeCtxMenu();
    try {
      await invoke<void>("open_in_vscode", { path: String(sess.cwd) });
    } catch {
      /* silently ignore — code may not be installed */
    }
  });
  menu.appendChild(codeItem);

  document.body.appendChild(menu);
  activeCtxMenu = menu;

  // Position below the anchor button, right-aligned
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.right - menuRect.width;
  if (left < 4) left = 4;
  if (top + menuRect.height > window.innerHeight - 4) top = rect.top - menuRect.height - 4;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

// Close context menu on outside click or Escape (wired once at module load)
document.addEventListener("click", (e) => {
  if (activeCtxMenu && !activeCtxMenu.contains(e.target as Node)) {
    closeCtxMenu();
  }
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activeCtxMenu) closeCtxMenu();
});

function isLive(i: Instance): boolean {
  return !i.ended_at && (i.kind === "interactive" || i.kind === "external");
}

async function refreshSessions(): Promise<void> {
  try {
    const all = await invoke<Instance[]>("list_instances");
    const next = (all || []).filter(isLive);

    const unread = loadUnreadSet();
    const liveIds = new Set(next.map(s => s.session_id));

    // GC: prune unread entries for sessions no longer alive
    for (const id of [...unread]) {
      if (!liveIds.has(id)) unread.delete(id);
    }

    // Mark unread for sessions that just finished a busy turn (busy true->false)
    // and are not currently open/selected
    for (const s of next) {
      const wasBusy = state.prevBusyMap.get(s.session_id);
      if (wasBusy === true && !s.busy && s.session_id !== state.selectedId) {
        unread.add(s.session_id);
      }
    }

    // Update prevBusyMap for next call
    state.prevBusyMap = new Map(next.map(s => [s.session_id, s.busy]));

    saveUnreadSet(unread);
    state.sessions = next;
  } catch (err) {
    console.error("[sessions] list_instances failed", err);
    state.sessions = [];
  }
}


function renderSidebar(listEl: HTMLElement): void {
  const filter = state.filter.toLowerCase();
  const pending = state.pendingNewSession;
  const unread = loadUnreadSet();
  const style = loadStateStyle();
  const sort = loadSort();

  let visible = state.sessions;
  if (pending?.realId) {
    visible = visible.filter(s => s.session_id !== pending.realId);
  }

  const filtered = visible.filter(s =>
    !filter ||
    projectName(s).toLowerCase().includes(filter) ||
    sessionSubtitle(s).toLowerCase().includes(filter)
  );

  const sorted = sortSessions(filtered, sort, unread);

  const realRows = sorted.map(s => {
    const isActive = s.session_id === state.selectedId;
    const indicator = statusIndicator(s, unread, style, escapeHtml);
    return `<li data-session-id="${escapeHtml(s.session_id)}" class="${isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""}">
      ${indicator}
      <div class="session-row-text">
        <span class="session-row-project">${escapeHtml(projectName(s))}</span>
        <span class="session-row-subtitle">${escapeHtml(sessionSubtitle(s))}</span>
      </div>
      <button class="session-row-menu-btn icon-btn" title="More options" data-session-id="${escapeHtml(s.session_id)}">
        <i class="ph ph-dots-three-vertical"></i>
      </button>
    </li>`;
  }).join("");

  let pendingRow = "";
  if (pending) {
    pendingRow = `<li class="active pending" data-pending="1" title="Starting new session...">
      <i class="session-state-icon ph ph-spinner spinning s-green" title="Starting..."></i>
      <div class="session-row-text">
        <span class="session-row-project">${escapeHtml(pending.projectName || "New session")}</span>
        <span class="session-row-subtitle">starting...</span>
      </div>
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
    // Keyboard-navigable highlight. Always points at a row in the current
    // filtered/sorted `computeRows()` output. Reset to 0 whenever filter or
    // sort changes (top of the new list).
    let selectedIdx = 0;

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
                  selectedIdx = 0;
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
              autocomplete="off"
              placeholder="Search projects..."
              .value=${filter}
              @input=${(e: Event) => {
                filter = (e.target as HTMLInputElement).value;
                selectedIdx = 0;
                renderModal();
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  if (filter !== "") {
                    e.preventDefault();
                    e.stopPropagation();
                    filter = "";
                    selectedIdx = 0;
                    renderModal();
                  } else {
                    finish(null);
                  }
                } else if (e.key === "Enter") {
                  const matches = computeRows();
                  if (matches.length > 0) {
                    e.preventDefault();
                    const idx = Math.min(selectedIdx, matches.length - 1);
                    const m = matches[idx]!;
                    finish({ path: m.path, name: m.name });
                  }
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  const matches = computeRows();
                  if (matches.length > 0) {
                    selectedIdx = Math.min(selectedIdx + 1, matches.length - 1);
                    renderModal();
                  }
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  const matches = computeRows();
                  if (matches.length > 0) {
                    selectedIdx = Math.max(selectedIdx - 1, 0);
                    renderModal();
                  }
                } else if (e.key === "Home") {
                  e.preventDefault();
                  selectedIdx = 0;
                  renderModal();
                } else if (e.key === "End") {
                  e.preventDefault();
                  const matches = computeRows();
                  if (matches.length > 0) {
                    selectedIdx = matches.length - 1;
                    renderModal();
                  }
                }
              }}
            />
            <ul class="project-picker-list">
              ${rows.length === 0
                ? html`<li class="project-picker-empty">No matches</li>`
                : rows.map(
                    (p, i) => html`
                      <li
                        class="project-picker-row ${i === Math.min(selectedIdx, rows.length - 1) ? "selected" : ""}"
                        data-row-idx=${i}
                        @mouseenter=${() => {
                          if (selectedIdx !== i) {
                            selectedIdx = i;
                            renderModal();
                          }
                        }}
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
      const focusIsInsideModal = active instanceof HTMLElement && host.contains(active);
      if (input && !focusIsInsideModal) {
        // Defer to next tick so lit-html finishes attaching DOM.
        setTimeout(() => input.focus(), 0);
      }
      // Keep the selected row visible when keyboard nav scrolls past the
      // viewport edge. block: "nearest" avoids unnecessary jumps when the
      // row is already fully visible.
      const selectedEl = host.querySelector<HTMLElement>(".project-picker-row.selected");
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: "nearest" });
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
  await launchNewSession(pane, project);
}

async function launchNewSession(
  pane: HTMLElement,
  project: { path: string; name: string },
): Promise<void> {
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

  await renderPendingPane(pane, placeholderId, project);

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
async function renderPendingPane(
  pane: HTMLElement,
  placeholderId: string,
  project: { path: string; name: string },
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
    let started = false;
    state.composer = new Composer(composerEl, {
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
              placeholderId,
            });
            if (state.mountId !== myMount) return;
            if (sessionId) {
              if (state.renderer && state.renderer.currentSessionId() !== sessionId) {
                await state.renderer.swapSubscription(sessionId);
              }
              if (state.composer) state.composer.setSessionId(sessionId, { readOnly: false });
              state.selectedId = sessionId;
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
    meta.textContent = `${projectName(sess)}${sess.pid ? ` · pid ${sess.pid}` : ""}`;
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
      <span class="meta">${escapeHtml(projectName(sess))}${sess.pid ? ` · pid ${sess.pid}` : ""}</span>
      ${readOnly ? '<button class="icon-btn takeover-btn" title="Take over"><i class="ph ph-arrow-clockwise"></i></button>' : ""}
      <button class="icon-btn detach-btn" title="Detach"><i class="ph ph-arrow-square-out"></i></button>
      ${readOnly ? "" : '<button class="icon-btn cancel-btn" title="Cancel turn"><i class="ph ph-x"></i></button>'}
    </header>
    ${readOnly ? '<div class="readonly-banner"><i class="ph ph-eye"></i> Read-only session - click <strong>Take Over</strong> to interact.</div>' : ""}
    <div class="session-statusbar-host"></div>
    <div class="session-messages"></div>
    <div class="session-composer"></div>
  `;

  // Mount statusbar.
  const sbHost = pane.querySelector<HTMLElement>(".session-statusbar-host");
  if (sbHost) {
    const fields = await loadStatuslineFields();
    const sb = new SessionStatusbar(sbHost, sess.started_at, fields);
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
    // IPC. Cache miss triggers load_history under the hood. Either way the
    // store keeps the live `chat:<id>` listener attached so events accrue
    // even when this session isn't selected.
    try {
      await renderer.loadFromStore(sess.cwd ? String(sess.cwd) : undefined);
      if (state.mountId !== myMount || state.selectedId !== sessionId) {
        renderer.detach();
        return;
      }
    } catch {
      /* tolerate absence */
    }
  }

  // Attach composer
  const composerEl = pane.querySelector<HTMLElement>(".session-composer");
  if (composerEl) {
    state.composer = new Composer(composerEl, {
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
    statusbar: null,
    prevBusyMap: new Map(),
  };

  render(template(), root);

  const view = root.querySelector<HTMLElement>(".view-sessions");
  const listEl = root.querySelector<HTMLElement>("#sessions-list");
  const pane = root.querySelector<HTMLElement>("#session-pane");
  const newBtn = root.querySelector<HTMLButtonElement>("#newSessionBtn");

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
        state.composer?.destroy();
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


  const sortSelect = root.querySelector<HTMLSelectElement>("#sessions-sort");
  if (sortSelect) {
    sortSelect.value = loadSort();
    sortSelect.addEventListener("change", () => {
      try { localStorage.setItem(LS_SORT, sortSelect.value); } catch { /* ignore */ }
      renderSidebar(listEl);
    });
  }

  // Wire row clicks (delegated). Block clicks while a new-session turn is
  // pending so the user can't accidentally navigate away from the in-flight
  // chat (which would orphan the renderer subscription and surface the bug
  // we just fixed). The pending row itself has no data-session-id so it's
  // naturally non-clickable.
  listEl.addEventListener("click", (e) => {
    // 3-dot menu button intercept
    const menuBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".session-row-menu-btn");
    if (menuBtn) {
      e.stopPropagation();
      const sid = menuBtn.dataset.sessionId;
      if (sid) openCtxMenu(sid, menuBtn, pane);
      return;
    }

    if (state.pendingNewSession) return;
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
    if (!li) return;
    const id = li.dataset.sessionId;
    if (id) void selectSession(id, pane);
  });

  return () => {
    closeCtxMenu();
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
          <div class="sessions-controls">
            <select id="sessions-sort" class="sessions-sort">
              <option value="status">Status</option>
              <option value="recent">Recent</option>
              <option value="name">Name</option>
            </select>
          </div>
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
    statusbar: null,
    prevBusyMap: new Map(),
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
    if (state.statusbar) {
      state.statusbar.destroy();
      state.statusbar = null;
    }
    state.composer?.destroy();
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

// ── Statusline helpers ────────────────────────────────────────────────────────

const DEFAULT_STATUSLINE_FIELDS = ["model", "branch", "repo", "context", "thinking"];

const ALL_STATUSLINE_FIELDS = [
  { key: "model",    label: "Model" },
  { key: "branch",   label: "Branch" },
  { key: "repo",     label: "Repo" },
  { key: "context",  label: "Context %" },
  { key: "thinking", label: "Thinking" },
  { key: "duration", label: "Duration" },
  { key: "cost",     label: "Cost" },
];

async function loadStatuslineFields(): Promise<string[]> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    const v = s["statuslineFields"];
    if (Array.isArray(v)) return v as string[];
  } catch { /* ignore */ }
  return [...DEFAULT_STATUSLINE_FIELDS];
}

async function saveStatuslineFields(fields: string[]): Promise<void> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    await invoke("save_settings", { settings: { ...s, statuslineFields: fields } });
  } catch (e) {
    console.error("[statusbar] save fields failed", e);
  }
}

function shortModelName(model: string): string {
  // "claude-opus-4-7" -> "Opus 4.7", "claude-sonnet-4-6" -> "Sonnet 4.6"
  const m = model.replace(/^claude-/, "").replace(/-(\d)/, " $1");
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function formatDuration(startedAt: string): string {
  const ms = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── SessionStatusbar ─────────────────────────────────────────────────────────

class SessionStatusbar {
  private container: HTMLElement;
  private fields: string[];
  private meta: SessionMeta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0 };
  private gitInfo: GitInfo = { branch: null, repo: null };
  private startedAt: string | null;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private popoverOpen = false;

  constructor(container: HTMLElement, startedAt: string | null, fields: string[]) {
    this.container = container;
    this.startedAt = startedAt;
    this.fields = fields;
    this.container.className = "session-statusbar";
    this.render();
    if (this.fields.includes("duration")) this.startDurationTimer();
  }

  updateMeta(meta: SessionMeta): void {
    this.meta = meta;
    this.render();
  }

  updateGitInfo(info: GitInfo): void {
    this.gitInfo = info;
    this.render();
  }

  destroy(): void {
    if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; }
  }

  private startDurationTimer(): void {
    this.durationTimer = setInterval(() => this.render(), 1000);
  }

  private render(): void {
    const f = this.fields;
    const chips: string[] = [];

    if (f.includes("model") && this.meta.model) {
      chips.push(`<span class="sb-chip sb-model"><i class="ph ph-robot"></i>${escapeHtml(shortModelName(this.meta.model))}</span>`);
    }
    if (f.includes("branch") && this.gitInfo.branch) {
      chips.push(`<span class="sb-chip sb-branch"><i class="ph ph-git-branch"></i>${escapeHtml(this.gitInfo.branch)}</span>`);
    }
    if (f.includes("repo") && this.gitInfo.repo) {
      chips.push(`<span class="sb-chip sb-repo"><i class="ph ph-folder-simple"></i>${escapeHtml(this.gitInfo.repo)}</span>`);
    }
    if (f.includes("context") && this.meta.inputTokens > 0) {
      const pct = Math.min(100, Math.round((this.meta.inputTokens / 200_000) * 100));
      const cls = pct >= 80 ? " danger" : pct >= 50 ? " warn" : "";
      chips.push(`<span class="sb-chip sb-context${cls}"><i class="ph ph-stack"></i>${pct}%</span>`);
    }
    if (f.includes("thinking") && this.meta.hasThinking) {
      chips.push(`<span class="sb-chip sb-thinking active"><i class="ph ph-brain"></i>thinking</span>`);
    }
    if (f.includes("duration") && this.startedAt) {
      chips.push(`<span class="sb-chip sb-duration"><i class="ph ph-timer"></i>${formatDuration(this.startedAt)}</span>`);
    }
    if (f.includes("cost") && this.meta.totalCostUsd > 0) {
      chips.push(`<span class="sb-chip sb-cost"><i class="ph ph-coin"></i>$${this.meta.totalCostUsd.toFixed(4)}</span>`);
    }

    const popoverHtml = this.popoverOpen ? `
      <div class="sb-popover">
        ${ALL_STATUSLINE_FIELDS.map(({ key, label }) => `
          <label class="sb-popover-row">
            <input type="checkbox" data-key="${key}"${f.includes(key) ? " checked" : ""}>
            ${escapeHtml(label)}
          </label>
        `).join("")}
      </div>
    ` : "";

    this.container.innerHTML = `
      <div class="sb-chips">${chips.join("") || '<span class="sb-empty">No fields</span>'}</div>
      <button class="sb-gear icon-btn" title="Configure statusline"><i class="ph ph-sliders-horizontal"></i></button>
      ${popoverHtml}
    `;

    this.container.querySelector(".sb-gear")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.popoverOpen = !this.popoverOpen;
      this.render();
    });

    if (this.popoverOpen) {
      this.container.querySelectorAll<HTMLInputElement>(".sb-popover input").forEach((cb) => {
        cb.addEventListener("change", () => {
          const key = cb.dataset.key!;
          if (cb.checked) {
            if (!this.fields.includes(key)) this.fields = [...this.fields, key];
          } else {
            this.fields = this.fields.filter((k) => k !== key);
          }
          void saveStatuslineFields(this.fields);
          if (key === "duration") {
            if (this.fields.includes("duration") && !this.durationTimer) {
              this.startDurationTimer();
            } else if (!this.fields.includes("duration") && this.durationTimer) {
              clearInterval(this.durationTimer);
              this.durationTimer = null;
            }
          }
          this.render();
        });
      });

      const closeOnOutside = (e: MouseEvent) => {
        if (!this.container.contains(e.target as Node)) {
          this.popoverOpen = false;
          this.render();
          document.removeEventListener("click", closeOnOutside);
        }
      };
      setTimeout(() => document.addEventListener("click", closeOnOutside), 0);
    }
  }
}
