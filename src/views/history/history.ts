import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { showView } from "../../shared/navigation";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { sessionEvents } from "../../shared/chat/event-store";
import { showChatLoadingOverlay } from "../../shared/chat/chat-loading";
import { queueHistoryResume } from "../sessions/sessions";
import "../../shared/chat/chat.css";
import "./history.css";
import type { HistoryEntry } from "../../types/ipc.generated";
import { cwdToProjectName } from "../sessions/sessions-helpers";

interface HistoryState {
  mountId: number;
  entries: HistoryEntry[];
  filter: string;
  selectedId: string | null;
  renderer: ChatRenderer | null;
}

let state: HistoryState = {
  mountId: 0,
  entries: [],
  filter: "",
  selectedId: null,
  renderer: null,
};
let nextMountId = 1;
let _pendingSelect: string | null = null;

/**
 * Open a specific past session read-only on the next History-view mount. Used
 * by the session-detail "Open in chats" CTA when the chat is already closed.
 */
export function queueHistorySelect(sessionId: string): void {
  _pendingSelect = sessionId;
}


async function fetchEntries(): Promise<void> {
  try {
    state.entries = (await invoke<HistoryEntry[]>("list_history", {
      projectId: null,
      search: null,
      limit: 200,
      offset: 0,
    })) || [];
  } catch (err) {
    console.error("[history] list_history failed", err);
    state.entries = [];
  }
}

function dateBucket(secs: number | bigint | null | undefined): string {
  if (!secs) return "Unknown date";
  const n = typeof secs === "bigint" ? Number(secs) : secs;
  if (!n) return "Unknown date";
  const d = new Date(n * 1000);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400_000);
  if (d >= startOfToday) return "Today";
  if (d >= startOfYesterday) return "Yesterday";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function renderList(listEl: HTMLElement): void {
  const filter = state.filter.toLowerCase();
  const filtered = state.entries.filter(
    (e) => !filter || cwdToProjectName(e.cwd).toLowerCase().includes(filter) || e.session_id.toLowerCase().includes(filter),
  );
  if (filtered.length === 0) {
    listEl.innerHTML = `<li class="history-empty-row">${
      filter ? "No matches" : "No past sessions"
    }</li>`;
    return;
  }

  const html: string[] = [];
  let lastBucket = "";
  for (const e of filtered) {
    const bucket = dateBucket(e.ended_at ?? e.started_at);
    if (bucket !== lastBucket) {
      lastBucket = bucket;
      html.push(`<li class="history-date-sep" aria-hidden="true">${escapeHtml(bucket)}</li>`);
    }
    html.push(
      `<li data-session-id="${escapeHtml(e.session_id)}" class="${
        e.session_id === state.selectedId ? "active" : ""
      }">
        <div class="history-row-title">${escapeHtml(cwdToProjectName(e.cwd))}</div>
        <div class="history-row-meta">${formatTime(e.ended_at ?? e.started_at)}</div>
      </li>`,
    );
  }
  listEl.innerHTML = html.join("");
}

function renderListLoading(listEl: HTMLElement): void {
  listEl.innerHTML = `<li class="history-loading-row"><span class="history-spinner"></span>Loading sessions&hellip;</li>`;
}

function formatTime(secs: number | bigint | null | undefined): string {
  if (secs === null || secs === undefined) return "";
  const n = typeof secs === "bigint" ? Number(secs) : secs;
  if (!n) return "";
  const d = new Date(n * 1000);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}


async function selectHistorySession(sessionId: string, pane: HTMLElement): Promise<void> {
  const myMount = state.mountId;
  state.selectedId = sessionId;

  pane.innerHTML = `
    <div class="session-messages"></div>
    <div class="history-session-actions">
      <button class="btn-continue-chat">
        <i class="ph ph-play"></i> Continue this chat
      </button>
    </div>
  `;

  const entry = state.entries.find(e => e.session_id === sessionId);
  if (entry) {
    pane.querySelector<HTMLButtonElement>(".btn-continue-chat")?.addEventListener("click", async () => {
      try {
        await invoke<void>("register_historical_session", { sessionId: entry.session_id, cwd: entry.cwd });
      } catch (err) {
        console.error("[history] register_historical_session failed", err);
      }
      queueHistoryResume(entry.session_id);
      showView("sessions");
    });
  }

  if (state.renderer) state.renderer.detach();
  const messagesEl = pane.querySelector<HTMLElement>(".session-messages");
  if (!messagesEl) return;
  const renderer = new ChatRenderer(messagesEl);
  state.renderer = renderer;

  await renderer.attach(sessionId);
  if (state.mountId !== myMount || state.selectedId !== sessionId) {
    renderer.detach();
    return;
  }
  // Paginated load via the shared event store: last ~20 messages now, older
  // ones fetched on scroll by the renderer's paginator (load_history_page under
  // the hood). Passing the entry's cwd lets the backend locate the transcript
  // directly instead of scanning every project dir. A cache hit renders with no
  // IPC; a miss shows the loading overlay while the first page loads.
  const cwd = entry?.cwd ? String(entry.cwd) : undefined;
  const overlay = sessionEvents.isLoaded(sessionId) ? null : showChatLoadingOverlay(messagesEl);
  try {
    await renderer.loadFromStore(cwd);
    if (state.mountId !== myMount || state.selectedId !== sessionId) {
      renderer.detach();
      return;
    }
  } catch (err) {
    console.error("[history] loadFromStore failed", err);
    pane.innerHTML = `<div class="history-empty">Failed to load: ${escapeHtml(String(err))}</div>`;
  } finally {
    overlay?.remove();
  }
}

export async function renderHistoryView(root: HTMLElement): Promise<() => void> {
  const myMount = nextMountId++;
  state = {
    mountId: myMount,
    entries: [],
    filter: "",
    selectedId: null,
    renderer: null,
  };

  render(template(), root);

  const listEl = root.querySelector<HTMLElement>("#history-list");
  const pane = root.querySelector<HTMLElement>(".history-pane");
  const filterInput = root.querySelector<HTMLInputElement>("#history-filter");

  if (!listEl || !pane) {
    console.error("[history] view template missing expected nodes");
    return () => { /* no-op */ };
  }

  renderListLoading(listEl);
  await fetchEntries();
  if (state.mountId !== myMount) return () => { /* superseded */ };
  renderList(listEl);

  // If session-detail asked us to open a specific closed chat, select it now.
  // Otherwise auto-select the most recent session so the pane isn't blank.
  const pendingOrFirst = _pendingSelect ?? state.entries[0]?.session_id ?? null;
  if (pendingOrFirst) {
    if (_pendingSelect) _pendingSelect = null;
    const li = listEl.querySelector<HTMLLIElement>(`li[data-session-id="${CSS.escape(pendingOrFirst)}"]`);
    if (li) {
      listEl.querySelectorAll("li[data-session-id]").forEach((el) => el.classList.remove("active"));
      li.classList.add("active");
      li.scrollIntoView({ block: "center" });
    }
    void selectHistorySession(pendingOrFirst, pane);
  }

  if (filterInput) {
    filterInput.addEventListener("input", () => {
      state.filter = filterInput.value;
      renderList(listEl);
    });
  }

  listEl.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-session-id]");
    if (!li) return;
    const id = li.dataset.sessionId;
    if (id) {
      // Update active class immediately without re-rendering the whole list.
      listEl.querySelectorAll("li[data-session-id]").forEach(el => el.classList.remove("active"));
      li.classList.add("active");
      void selectHistorySession(id, pane);
    }
  });

  return () => {
    if (state.renderer) {
      state.renderer.detach();
      state.renderer = null;
    }
    state.selectedId = null;
  };
}

function template() {
  return html`
    <div class="view view-history">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>History</h2>
        <button
          class="icon-btn"
          title="Back to Chats"
          @click=${() => showView("sessions")}
        >
          <i class="ph ph-chats"></i>
        </button>
      </div>
      <div class="view-body" id="history-content">
        <div class="history-layout">
          <aside class="history-sidebar">
            <input
              id="history-filter"
              type="search"
              placeholder="Filter past sessions"
            />
            <ul id="history-list"></ul>
          </aside>
          <main class="history-pane">
            <div class="history-empty">Pick a past session</div>
          </main>
        </div>
      </div>
    </div>
  `;
}
