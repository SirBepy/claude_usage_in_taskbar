import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import type { Instance } from "../../types/ipc.generated";
import {
  projectName,
  sessionSubtitle,
  statusIndicator,
  sortSessions,
  loadUnreadSet,
  saveUnreadSet,
  loadSort,
  loadStateStyle,
} from "./sessions-helpers";
import { state } from "./state";
import { getChatSlotMode, getSlotAssignment } from "../../shared/shortcuts";

export function isLive(i: Instance): boolean {
  return !i.ended_at && (i.kind === "interactive" || i.kind === "external");
}

export async function refreshSessions(): Promise<void> {
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

export function renderSidebar(listEl: HTMLElement): void {
  const filter = state.filter.toLowerCase();
  const pending = state.pendingNewSession;
  const unread = loadUnreadSet();
  const style = loadStateStyle();
  const sort = loadSort();

  let visible = state.sessions;
  if (pending?.realId) {
    visible = visible.filter(s => s.session_id !== pending.realId);
  } else if (pending) {
    // Pre-resolution window: the SessionStart hook on our own `claude -p`
    // spawn registers an External entry before chat IPC captures the real
    // session_id. Hide that newcomer row so it doesn't double-render
    // alongside the pending placeholder. Pre-existing sessions in the same
    // cwd stay visible.
    visible = visible.filter(s =>
      !(String(s.cwd) === pending.projectPath && !pending.preExistingSessionIds.has(s.session_id))
    );
  }

  const filtered = visible.filter(s =>
    !filter ||
    projectName(s).toLowerCase().includes(filter) ||
    sessionSubtitle(s).toLowerCase().includes(filter)
  );

  const sorted = sortSessions(filtered, sort, unread);
  state.sortedSessionIds = sorted.map(s => s.session_id);

  const isManualSlots = getChatSlotMode() === "manual";
  const slotBySession: Record<string, number> = {};
  if (isManualSlots) {
    for (let slot = 1; slot <= 9; slot++) {
      const sid = getSlotAssignment(slot);
      if (sid) slotBySession[sid] = slot;
    }
  }

  const realRows = sorted.map((s, i) => {
    const isActive = s.session_id === state.selectedId;
    const indicator = statusIndicator(s, unread, style, escapeHtml);
    let kbdHint = "";
    if (isManualSlots) {
      const slot = slotBySession[s.session_id];
      if (slot) kbdHint = ` data-kbd-hint="${slot}"`;
    } else {
      if (i < 9) kbdHint = ` data-kbd-hint="${i + 1}"`;
    }
    return `<li data-session-id="${escapeHtml(s.session_id)}"${kbdHint} class="${isActive ? "active" : ""} ${s.kind === "external" ? "is-external" : ""}">
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
    const isPendingActive = state.selectedId === pending.placeholderId;
    const activeCls = isPendingActive ? "active" : "";
    if (!pending.firstMessageSent) {
      pendingRow = `<li class="${activeCls} pending draft" data-pending="1" title="Draft — type a message to start">
        <i class="session-state-icon ph ph-note-pencil" title="Draft"></i>
        <div class="session-row-text">
          <span class="session-row-project">${escapeHtml(pending.projectName || "New session")}</span>
          <span class="session-row-subtitle">Draft New Chat</span>
        </div>
        <button class="session-row-menu-btn icon-btn" title="Discard draft" data-discard-draft="1">
          <i class="ph ph-x-circle"></i>
        </button>
      </li>`;
    } else {
      pendingRow = `<li class="${activeCls} pending" data-pending="1" title="Starting new session... click X to discard if stuck">
        <i class="session-state-icon ph ph-spinner spinning s-green" title="Starting..."></i>
        <div class="session-row-text">
          <span class="session-row-project">${escapeHtml(pending.projectName || "New session")}</span>
          <span class="session-row-subtitle">starting...</span>
        </div>
        <button class="session-row-menu-btn icon-btn" title="Discard stuck session" data-discard-stuck="1">
          <i class="ph ph-x-circle"></i>
        </button>
      </li>`;
    }
  }

  const parkedRows = state.parkedDrafts.map(d =>
    `<li class="parked-draft" data-placeholder-id="${escapeHtml(d.placeholderId)}" title="Parked draft — click to resume">
      <i class="session-state-icon ph ph-note-pencil" title="Parked draft"></i>
      <div class="session-row-text">
        <span class="session-row-project">${escapeHtml(d.projectName || "New session")}</span>
        <span class="session-row-subtitle">Draft New Chat</span>
      </div>
      <button class="session-row-menu-btn icon-btn" title="Discard draft" data-discard-parked="${escapeHtml(d.placeholderId)}">
        <i class="ph ph-x-circle"></i>
      </button>
    </li>`
  ).join("");

  listEl.innerHTML = pendingRow + parkedRows + realRows;
}

// ── Per-row 3-dot context menu ───────────────────────────────────────────────

let activeCtxMenu: HTMLElement | null = null;

export function closeCtxMenu(): void {
  if (activeCtxMenu) {
    activeCtxMenu.remove();
    activeCtxMenu = null;
  }
}

export interface CtxMenuActions {
  /** "New agent here" — start a new session in this row's cwd. */
  onNewHere: (project: { path: string; name: string }) => void;
}

export function openCtxMenu(
  sessionId: string,
  anchor: HTMLElement,
  actions: CtxMenuActions,
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
    actions.onNewHere({ path: String(sess.cwd), name: projectName(sess) });
  });
  menu.appendChild(newItem);

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

  // "Copy PID" — only if session has a pid
  if (sess.pid) {
    const pidItem = document.createElement("button");
    pidItem.className = "session-ctx-item";
    pidItem.innerHTML = '<i class="ph ph-copy"></i> Copy PID';
    pidItem.addEventListener("click", () => {
      closeCtxMenu();
      void navigator.clipboard.writeText(String(sess.pid));
    });
    menu.appendChild(pidItem);
  }

  // "Close" — interactive only
  if (sess.kind === "interactive") {
    const closeItem = document.createElement("button");
    closeItem.className = "session-ctx-item";
    closeItem.innerHTML = '<i class="ph ph-x"></i> Close';
    closeItem.addEventListener("click", async () => {
      closeCtxMenu();
      if (sess.busy) {
        if (!confirm("A turn is in progress. Close and discard it?")) return;
        try { await invoke<void>("cancel_turn", { sessionId }); } catch {}
      }
      try { await invoke<void>("clear_session", { sessionId }); } catch (err) {
        console.error("[sessions] close chat failed", err);
      }
    });
    menu.appendChild(closeItem);
  }

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
