// ── View-level "more options" overflow menu ──────────────────────────────────
//
// Extracted from sessions.ts (ai_todo 108). Self-contained: it has no coupling
// to renderSessionsView beyond the exported entry points below, and imports
// nothing from sessions.ts (so no import cycle).
//
// Reuses the per-session .session-more-menu dropdown pattern (fixed-position,
// innerHTML-populated, closes on outside click). The Sort/New-chat/History
// controls live in a hidden #view-more-host in the template so their handlers
// bind by id at mount; we RELOCATE the live nodes into the menu on open and
// move them back on close, preserving the bound listeners. The two protocol
// toggles + countdown chip are appended below a separator.

import type { TerminalAction } from "../../types/ipc.generated";
import { positionDropdown } from "./position-dropdown";
import {
  armOrToggleWhenDone,
  cancelWhenDone,
  whenDoneArmed,
  whenDoneMenuHtml,
} from "./when-done";

let _viewMenu: HTMLElement | null = null;
let _viewMenuCleanup: (() => void) | null = null;

/** Move the relocated host controls back, then drop the menu DOM + listeners. */
export function closeViewMoreMenu(): void {
  const host = document.getElementById("view-more-host");
  if (_viewMenu && host) {
    // Move the live nodes (with their bound listeners) back to the host.
    const sortLabel = _viewMenu.querySelector(".view-more-sort-label");
    const sortSel = _viewMenu.querySelector("#sessions-sort");
    const newBtn = _viewMenu.querySelector("#newSessionBtn");
    const histBtn = _viewMenu.querySelector("#historyBtn");
    if (sortLabel) host.appendChild(sortLabel);
    if (sortSel) host.appendChild(sortSel);
    if (newBtn) host.appendChild(newBtn);
    if (histBtn) host.appendChild(histBtn);
  }
  _viewMenu?.remove();
  _viewMenu = null;
  if (_viewMenuCleanup) { _viewMenuCleanup(); _viewMenuCleanup = null; }
}

export function refreshViewMoreIndicator(): void {
  const btn = document.getElementById("viewMoreBtn");
  if (btn) btn.classList.toggle("has-indicator", whenDoneArmed());
}

/** Rebuild the protocol section of the open menu in place (toggles + chip). */
export function rerenderViewMenuProtocol(): void {
  if (!_viewMenu) return;
  const slot = _viewMenu.querySelector<HTMLElement>(".view-more-protocol");
  if (slot) slot.innerHTML = whenDoneMenuHtml();
}

function openViewMoreMenu(btn: HTMLButtonElement): void {
  closeViewMoreMenu();
  const host = document.getElementById("view-more-host");

  const menu = document.createElement("div");
  menu.className = "session-more-menu view-more-menu";

  // Static skeleton: a slot for the relocated controls, a separator, then the
  // protocol slot (populated from when-done state).
  menu.innerHTML =
    `<div class="view-more-controls"></div>` +
    `<div class="smore-sep"></div>` +
    `<div class="view-more-protocol"></div>`;

  document.body.appendChild(menu);
  _viewMenu = menu;

  // Relocate the host's live controls into the controls slot (preserves their
  // bound listeners). Order: Sort label + select, New chat, History.
  const controlsSlot = menu.querySelector<HTMLElement>(".view-more-controls");
  if (host && controlsSlot) {
    const sortLabel = host.querySelector(".view-more-sort-label");
    const sortSel = host.querySelector("#sessions-sort");
    const newBtn = host.querySelector("#newSessionBtn");
    const histBtn = host.querySelector("#historyBtn");
    if (newBtn) controlsSlot.appendChild(newBtn);
    if (histBtn) controlsSlot.appendChild(histBtn);
    if (sortLabel) controlsSlot.appendChild(sortLabel);
    if (sortSel) controlsSlot.appendChild(sortSel);
  }

  rerenderViewMenuProtocol();

  positionDropdown(menu, btn);

  // Protocol clicks (toggles + cancel). Clicks on the relocated New/History
  // buttons keep firing their own bound listeners; we just close the menu for
  // those so the dropdown does not linger.
  menu.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    const cancelBtn = target.closest("[data-when-done-cancel]");
    if (cancelBtn) {
      void cancelWhenDone();
      return;
    }

    const toggle = target.closest<HTMLButtonElement>("[data-when-done]");
    if (toggle) {
      const action = toggle.dataset.whenDone as TerminalAction;
      void armOrToggleWhenDone(action);
      return;
    }

    // New chat / History: their own listeners already ran; close the menu.
    if (target.closest("#newSessionBtn") || target.closest("#historyBtn")) {
      closeViewMoreMenu();
    }
  });

  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== btn) {
      closeViewMoreMenu();
    }
  };
  setTimeout(() => document.addEventListener("click", onOutside), 0);
  _viewMenuCleanup = () => document.removeEventListener("click", onOutside);
}

/** Toggle the menu open/closed. Replaces the inline `_viewMenu ? close : open`
 *  check in sessions.ts so `_viewMenu` stays private to this module. */
export function toggleViewMoreMenu(btn: HTMLButtonElement): void {
  if (_viewMenu) closeViewMoreMenu();
  else openViewMoreMenu(btn);
}
