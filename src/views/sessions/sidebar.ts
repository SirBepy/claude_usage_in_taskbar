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
  }

  const filtered = visible.filter(s =>
    !filter ||
    projectName(s).toLowerCase().includes(filter) ||
    sessionSubtitle(s).toLowerCase().includes(filter)
  );

  const sorted = sortSessions(filtered, sort, unread);
  state.sortedSessionIds = sorted.map(s => s.session_id);

  const realRows = sorted.map((s, i) => {
    const isActive = s.session_id === state.selectedId;
    const indicator = statusIndicator(s, unread, style, escapeHtml);
    const kbdHint = i < 9 ? ` data-kbd-hint="${i + 1}"` : "";
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
  /** "Run /close" — only wired for non-busy interactive rows. */
  onSelectAfterSend: (sessionId: string) => void;
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
        actions.onSelectAfterSend(sessionId);
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
