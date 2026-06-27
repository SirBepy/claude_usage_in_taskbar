// Per-row 3-dot context menu, split out of sidebar.ts.
// Uses a rerender callback (injected by sidebar.ts) to avoid a circular import.

import { positionDropdown } from "./position-dropdown";
import { invoke } from "../../shared/ipc";
import { state } from "./state";
import {
  projectName,
  loadHiddenSessions,
  saveHiddenSessions,
  loadHiddenCollapsed,
  saveHiddenCollapsed,
  toggleSegCollapse,
} from "./sessions-helpers";
import { closeChat } from "./close-chat";
import { loadAnimEnabled, markSessionExiting } from "./sidebar-anim";

let activeCtxMenu: HTMLElement | null = null;
let rerenderSidebar: (() => void) | null = null;

export function setRerenderCallback(fn: () => void): void {
  rerenderSidebar = fn;
}

export function closeCtxMenu(): void {
  if (activeCtxMenu) {
    activeCtxMenu.remove();
    activeCtxMenu = null;
  }
}

export function openDraftCtxMenu(anchor: HTMLElement, onDiscard: () => void): void {
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = "session-ctx-menu";
  const item = document.createElement("button");
  item.className = "session-ctx-item";
  item.innerHTML = '<i class="ph ph-x"></i> Discard draft';
  item.addEventListener("click", () => { closeCtxMenu(); onDiscard(); });
  menu.appendChild(item);
  document.body.appendChild(menu);
  activeCtxMenu = menu;
  positionDropdown(menu, anchor);
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

  // "Open project in dashboard" — focuses (or opens) the main window and
  // navigates to this session's project detail view.
  if (sess.cwd) {
    const sessCwd = String(sess.cwd);
    const dashItem = document.createElement("button");
    dashItem.className = "session-ctx-item";
    dashItem.innerHTML = '<i class="ph ph-squares-four"></i> Open project in dashboard';
    dashItem.addEventListener("click", async () => {
      closeCtxMenu();
      try {
        await invoke<void>("open_dashboard_project", { cwd: sessCwd });
      } catch (e) {
        console.error("[ctx-menu] open_dashboard_project failed", e);
      }
    });
    menu.appendChild(dashItem);
  }

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

  // "Hide" / "Unhide"
  const hiddenSet = loadHiddenSessions();
  const isHidden = hiddenSet.has(sessionId);
  const hideItem = document.createElement("button");
  hideItem.className = "session-ctx-item";
  if (isHidden) {
    hideItem.innerHTML = '<i class="ph ph-eye"></i> Unhide';
    hideItem.addEventListener("click", () => {
      closeCtxMenu();
      hiddenSet.delete(sessionId);
      saveHiddenSessions(hiddenSet);
      rerenderSidebar?.();
    });
  } else {
    hideItem.innerHTML = '<i class="ph ph-eye-slash"></i> Hide';
    hideItem.addEventListener("click", () => {
      closeCtxMenu();
      hiddenSet.add(sessionId);
      saveHiddenSessions(hiddenSet);
      rerenderSidebar?.();
    });
  }
  menu.appendChild(hideItem);

  // "Close" — kills the underlying claude process (per-turn child for
  // interactive sessions, the user's terminal claude pid for external)
  // and drops the row from the sidebar. clear_session handles both kinds.
  const closeItem = document.createElement("button");
  closeItem.className = "session-ctx-item";
  const closeLabel = sess.kind === "external" ? "Close (kill terminal)" : "Close";
  closeItem.innerHTML = `<i class="ph ph-x"></i> ${closeLabel}`;
  closeItem.addEventListener("click", () => {
    closeCtxMenu();
    const listEl = anchor.closest<HTMLElement>("#sessions-list");
    if (listEl && loadAnimEnabled()) markSessionExiting(listEl, sessionId);
    void closeChat(sessionId);
  });
  menu.appendChild(closeItem);

  document.body.appendChild(menu);
  activeCtxMenu = menu;
  positionDropdown(menu, anchor);
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

document.addEventListener("click", (e) => {
  const toggle = (e.target as HTMLElement).closest<HTMLElement>("[data-hidden-toggle]");
  if (toggle) {
    saveHiddenCollapsed(!loadHiddenCollapsed());
    rerenderSidebar?.();
  }
});

document.addEventListener("click", (e) => {
  const segToggle = (e.target as HTMLElement).closest<HTMLElement>("[data-seg-toggle]");
  if (segToggle) {
    const seg = parseInt(segToggle.dataset.segToggle!, 10);
    toggleSegCollapse(seg);
    rerenderSidebar?.();
  }
});
