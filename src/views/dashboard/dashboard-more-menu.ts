// Dashboard header "more options" kebab menu - extracted from dashboard.ts
// (ai_todo 174) so dashboard.ts can stay focused on mount/lifecycle/refresh +
// widget shell. Talks back to dashboard.ts purely via the injected deps bag
// (never imports dashboard.ts state directly) to avoid an import cycle - see
// the sidebar.ts import-cycle memory.

import { escapeHtml } from "../../shared/escape-html";
import { getWidget } from "./widget-registry";
import type { DashboardWidgetEntry } from "./widget-registry";
import { positionDropdown, positionSubmenu } from "../sessions/position-dropdown";
import { registerMenuCloser, closeAllMenus } from "../sessions/menu-registry";

export interface DashMoreMenuDeps {
  isEditMode: () => boolean;
  onToggleEditMode: () => void;
  triggerRefresh: () => Promise<void>;
  getDashboardWidgets: () => DashboardWidgetEntry[];
  /** Marks the widget enabled, persists the layout, and re-renders the shell. */
  enableWidget: (id: string) => void;
}

let dashMenu: HTMLElement | null = null;
let dashSubmenu: HTMLElement | null = null;
let dashMenuCleanup: (() => void) | null = null;

registerMenuCloser(closeDashMenu);

export function closeDashMenu(): void {
  dashSubmenu?.remove();
  dashSubmenu = null;
  dashMenu?.remove();
  dashMenu = null;
  if (dashMenuCleanup) { dashMenuCleanup(); dashMenuCleanup = null; }
}

export function onDashMoreClick(e: Event, deps: DashMoreMenuDeps): void {
  const btn = e.currentTarget as HTMLButtonElement;
  if (dashMenu) closeDashMenu();
  else openDashMenu(btn, deps);
}

export function openDashMenu(btn: HTMLButtonElement, deps: DashMoreMenuDeps): void {
  closeAllMenus();
  const menu = document.createElement("div");
  menu.className = "session-more-menu";
  document.body.appendChild(menu);
  dashMenu = menu;

  const editMode = deps.isEditMode();
  const editItem = document.createElement("button");
  editItem.className = "smore-item" + (editMode ? " is-on" : "");
  editItem.innerHTML =
    `<i class="ph ph-sliders-horizontal"></i>` +
    `<span>${editMode ? "Done editing" : "Edit dashboard"}</span>` +
    (editMode ? `<span class="smore-check-dot"></span>` : "");
  editItem.onclick = () => { closeDashMenu(); deps.onToggleEditMode(); };
  menu.appendChild(editItem);

  const refreshItem = document.createElement("button");
  refreshItem.className = "smore-item";
  refreshItem.innerHTML = `<i class="ph ph-arrows-clockwise"></i><span>Refresh now</span>`;
  refreshItem.onclick = () => { closeDashMenu(); void deps.triggerRefresh(); };
  menu.appendChild(refreshItem);

  const sep = document.createElement("div");
  sep.className = "smore-sep";
  menu.appendChild(sep);

  const addParent = document.createElement("button");
  addParent.className = "smore-item smore-has-sub";
  addParent.innerHTML =
    `<i class="ph ph-plus"></i><span>Add widget</span>` +
    `<i class="ph ph-caret-right smore-sub-caret"></i>`;
  addParent.onclick = (ev) => {
    ev.stopPropagation();
    if (dashSubmenu) { dashSubmenu.remove(); dashSubmenu = null; return; }
    openAddWidgetSubmenu(addParent, deps);
  };
  menu.appendChild(addParent);

  positionDropdown(menu, btn);

  const onOutside = (ev: MouseEvent) => {
    const t = ev.target as Node;
    if (!menu.contains(t) && t !== btn && !dashSubmenu?.contains(t)) closeDashMenu();
  };
  setTimeout(() => document.addEventListener("click", onOutside), 0);
  dashMenuCleanup = () => document.removeEventListener("click", onOutside);
}

/** Add-widget submenu: every registry widget is listed; already-added ones are
 * greyed out (not clickable), the rest enable on click. */
function openAddWidgetSubmenu(parent: HTMLElement, deps: DashMoreMenuDeps): void {
  const sub = document.createElement("div");
  sub.className = "session-more-menu";
  for (const entry of deps.getDashboardWidgets()) {
    const widget = getWidget(entry.id);
    if (!widget) continue;
    const item = document.createElement("button");
    item.className = "smore-item" + (entry.enabled ? " is-disabled" : "");
    item.innerHTML =
      `<i class="ph ${escapeHtml(widget.icon)}"></i>` +
      `<span>${escapeHtml(widget.title)}</span>` +
      (entry.enabled ? `<i class="ph ph-check" style="margin-left:auto;opacity:0.6"></i>` : "");
    if (entry.enabled) {
      item.title = "Already added";
    } else {
      item.onclick = () => {
        deps.enableWidget(entry.id);
        closeDashMenu();
      };
    }
    sub.appendChild(item);
  }
  document.body.appendChild(sub);
  dashSubmenu = sub;

  positionSubmenu(sub, parent);
}
