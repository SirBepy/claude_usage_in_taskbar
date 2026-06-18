import { invoke } from "../../shared/ipc";
import { positionDropdown } from "./position-dropdown";
import { isAutoAccept, setAutoAccept, autoAcceptParked } from "./permission-modal";
import { closeChat } from "./close-chat";
import { state } from "./state";

// The ⋮ "More options" dropdown shared by the active-session header and a
// freshly-started chat header, so both surfaces show the exact same menu
// (auto-accept / terminal / detach / close) instead of a row of separate icon buttons.

let _moreMenu: HTMLElement | null = null;
let _moreMenuCleanup: (() => void) | null = null;
let _subMenu: HTMLElement | null = null;

function closeSubMenu(): void {
  _subMenu?.remove();
  _subMenu = null;
}

export function closeMoreMenu(): void {
  closeSubMenu();
  _moreMenu?.remove();
  _moreMenu = null;
  if (_moreMenuCleanup) { _moreMenuCleanup(); _moreMenuCleanup = null; }
}

function positionSubmenu(sub: HTMLElement, parentItem: HTMLElement): void {
  document.body.appendChild(sub);
  const itemRect = parentItem.getBoundingClientRect();
  const subRect = sub.getBoundingClientRect();
  let left = itemRect.right + 4;
  if (left + subRect.width > window.innerWidth - 4) {
    left = itemRect.left - subRect.width - 4;
  }
  let top = itemRect.top;
  if (top + subRect.height > window.innerHeight - 4) {
    top = window.innerHeight - subRect.height - 4;
  }
  if (top < 4) top = 4;
  sub.style.left = `${left}px`;
  sub.style.top = `${top}px`;
}

export function openMoreMenu(btn: HTMLButtonElement, sessionId: string | null, readOnly: boolean, onDiscard?: () => void): void {
  closeMoreMenu();

  const menu = document.createElement("div");
  menu.className = "session-more-menu";

  const items: string[] = [];
  if (sessionId === null) {
    items.push(`<button class="smore-item smore-danger" data-action="discard"><i class="ph ph-x-circle"></i>Discard draft</button>`);
  } else {
    const autoOn = isAutoAccept(sessionId);
    if (!readOnly) {
      items.push(`<button class="smore-item smore-auto-accept${autoOn ? " is-on" : ""}" data-action="auto-accept"><i class="ph ph-shield-check"></i>Auto-accept${autoOn ? '<span class="smore-check-dot"></span>' : ""}</button>`);
      items.push(`<div class="smore-sep"></div>`);
    }
    items.push(`<button class="smore-item" data-action="change-character"><i class="ph ph-user-switch"></i>Change character</button>`);
    items.push(`<button class="smore-item" data-action="terminal"><i class="ph ph-terminal-window"></i>Move Session to Terminal</button>`);
    items.push(`<button class="smore-item smore-has-sub" data-action="dir-open"><i class="ph ph-folder-open"></i>Open directory<i class="ph ph-caret-right smore-sub-caret"></i></button>`);
    items.push(`<button class="smore-item" data-action="detach"><i class="ph ph-arrow-square-out"></i>Detach</button>`);
    if (!readOnly) {
      items.push(`<div class="smore-sep"></div>`);
      items.push(`<button class="smore-item smore-danger" data-action="close"><i class="ph ph-x-circle"></i>Close session</button>`);
    }
  }
  menu.innerHTML = items.join("");
  document.body.appendChild(menu);
  _moreMenu = menu;

  positionDropdown(menu, btn);

  menu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    if (!item) return;
    const action = item.dataset.action;

    if (action === "dir-open") {
      if (_subMenu) { closeSubMenu(); return; }
      const sub = document.createElement("div");
      sub.className = "session-more-menu smore-submenu";
      sub.innerHTML = [
        `<button class="smore-item" data-subaction="vscode"><i class="ph ph-code"></i>Open in VS Code</button>`,
        `<button class="smore-item" data-subaction="terminal-dir"><i class="ph ph-terminal-window"></i>Open in Terminal</button>`,
        `<button class="smore-item" data-subaction="explorer"><i class="ph ph-folder-notch-open"></i>Open in File Explorer</button>`,
      ].join("");
      _subMenu = sub;
      positionSubmenu(sub, item);

      sub.addEventListener("click", (ev) => {
        const subItem = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-subaction]");
        if (!subItem || !sessionId) return;
        const subAction = subItem.dataset.subaction;
        closeMoreMenu();
        void (async () => {
          const cwd = state.sessions.find(s => s.session_id === sessionId)?.cwd;
          switch (subAction) {
            case "vscode":
              if (cwd) {
                try { await invoke<void>("open_in_vscode", { path: String(cwd) }); }
                catch { /* code may not be installed */ }
              }
              break;
            case "terminal-dir":
              if (cwd) {
                try { await invoke<void>("open_terminal_in_directory", { path: String(cwd) }); }
                catch (err) { alert(`Failed to open terminal: ${err}`); }
              }
              break;
            case "explorer":
              if (cwd) {
                try { await invoke<void>("open_in_explorer", { path: String(cwd) }); }
                catch (err) { alert(`Failed to open file explorer: ${err}`); }
              }
              break;
          }
        })();
      });
      return;
    }

    closeMoreMenu();
    void (async () => {
      if (action === "discard") { onDiscard?.(); return; }
      if (!sessionId) return;
      switch (action) {
        case "auto-accept": {
          const next = !isAutoAccept(sessionId);
          setAutoAccept(sessionId, next);
          const moreBtnEl = document.querySelector<HTMLButtonElement>(".session-header .more-btn");
          if (moreBtnEl) moreBtnEl.classList.toggle("has-indicator", next);
          if (next) autoAcceptParked(sessionId);
          break;
        }
        case "change-character": {
          // Dynamic import breaks the active-session <-> more-menu static cycle.
          const m = await import("./active-session");
          await m.changeCharacterForSession(sessionId);
          break;
        }
        case "terminal":
          try { await invoke<void>("open_session_in_terminal", { sessionId }); }
          catch (err) { alert(`Failed to open terminal: ${err}`); }
          break;
        case "detach":
          try { await invoke<void>("detach_window", { sessionId }); }
          catch (err) { console.warn("[sessions] detach_window unavailable", err); }
          break;
        case "close":
          void closeChat(sessionId);
          break;
      }
    })();
  });

  const onOutside = (e: MouseEvent) => {
    const target = e.target as Node;
    if (!menu.contains(target) && target !== btn && !_subMenu?.contains(target)) {
      closeMoreMenu();
    }
  };
  setTimeout(() => document.addEventListener("click", onOutside), 0);
  _moreMenuCleanup = () => document.removeEventListener("click", onOutside);
}
