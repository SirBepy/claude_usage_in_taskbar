import { invoke } from "../../shared/ipc";
import { isAutoAccept, setAutoAccept, autoAcceptParked } from "./permission-modal";
import { closeChat } from "./close-chat";

// The ⋮ "More options" dropdown shared by the active-session header and a
// freshly-started chat header, so both surfaces show the exact same menu
// (auto-accept / terminal / detach / stop / close) instead of a row of
// separate icon buttons.

let _moreMenu: HTMLElement | null = null;
let _moreMenuCleanup: (() => void) | null = null;

export function closeMoreMenu(): void {
  _moreMenu?.remove();
  _moreMenu = null;
  if (_moreMenuCleanup) { _moreMenuCleanup(); _moreMenuCleanup = null; }
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
    }
    items.push(`<button class="smore-item" data-action="change-character"><i class="ph ph-user-switch"></i>Change character</button>`);
    items.push(`<button class="smore-item" data-action="terminal"><i class="ph ph-terminal-window"></i>Open in Terminal</button>`);
    items.push(`<button class="smore-item" data-action="detach"><i class="ph ph-arrow-square-out"></i>Detach</button>`);
    if (!readOnly) {
      items.push(`<div class="smore-sep"></div>`);
      items.push(`<button class="smore-item" data-action="stop"><i class="ph ph-x"></i>Stop turn</button>`);
      items.push(`<button class="smore-item smore-danger" data-action="close"><i class="ph ph-x-circle"></i>Close session</button>`);
    }
  }
  menu.innerHTML = items.join("");
  document.body.appendChild(menu);
  _moreMenu = menu;

  const rect = btn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;

  menu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    if (!item) return;
    const action = item.dataset.action;
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
          // Turning it ON should clear an already-parked prompt (and its sidebar
          // dot) right away, not wait for a switch-away/back.
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
        case "stop":
          try { await invoke<void>("cancel_turn", { sessionId }); }
          catch (err) { console.error("[sessions] cancel_turn failed", err); }
          break;
        case "close":
          void closeChat(sessionId);
          break;
      }
    })();
  });

  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== btn) {
      closeMoreMenu();
    }
  };
  setTimeout(() => document.addEventListener("click", onOutside), 0);
  _moreMenuCleanup = () => document.removeEventListener("click", onOutside);
}
