import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { showView } from "../../shared/navigation";
import { ChatRenderer } from "../../shared/chat/chat-renderer";
import { queueHistoryResume } from "../sessions/sessions";
import "../../shared/chat/chat.css";
import "./history.css";
import type { ChatEvent, HistoryEntry } from "../../types/ipc.generated";

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

function projectNameFromCwd(cwd: string): string {
  return cwd.split(/[/\\]/).filter(Boolean).pop() ?? cwd;
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
    (e) => !filter || projectNameFromCwd(e.cwd).toLowerCase().includes(filter) || e.session_id.toLowerCase().includes(filter),
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
        <div class="history-row-title">${escapeHtml(projectNameFromCwd(e.cwd))}</div>
        <div class="history-row-meta">${formatTime(e.ended_at ?? e.started_at)}</div>
      </li>`,
    );
  }
  listEl.innerHTML = html.join("");
}

function formatTime(secs: number | bigint | null | undefined): string {
  if (secs === null || secs === undefined) return "";
  const n = typeof secs === "bigint" ? Number(secs) : secs;
  if (!n) return "";
  const d = new Date(n * 1000);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDate(secs: number | bigint | null | undefined): string {
  if (secs === null || secs === undefined) return "";
  const n = typeof secs === "bigint" ? Number(secs) : secs;
  if (!n) return "";
  const d = new Date(n * 1000);
  return d.toLocaleString();
}

async function selectHistorySession(sessionId: string, pane: HTMLElement): Promise<void> {
  const myMount = state.mountId;
  state.selectedId = sessionId;

  pane.innerHTML = `
    <div class="history-session-actions">
      <button class="btn-continue-chat">
        <i class="ph ph-play"></i> Continue this chat
      </button>
    </div>
    <div class="session-messages"></div>
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

  let events: ChatEvent[] = [];
  try {
    events = (await invoke<ChatEvent[]>("load_history", { sessionId, cwd: null })) || [];
  } catch (err) {
    console.error("[history] load_history failed", err);
    pane.innerHTML = `<div class="history-empty">Failed to load: ${escapeHtml(String(err))}</div>`;
    return;
  }
  if (state.mountId !== myMount || state.selectedId !== sessionId) {
    renderer.detach();
    return;
  }
  renderer.loadHistory(events);
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

  await fetchEntries();
  if (state.mountId !== myMount) return () => { /* superseded */ };
  renderList(listEl);

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
