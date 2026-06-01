import { html, render } from "lit-html";
import * as shortcuts from "../../../../shared/shortcuts";
import { normalizeEvent } from "../../../../shared/shortcuts";
import type { ShortcutDef } from "../../../../shared/shortcuts";
import "./shortcuts.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

interface ShortcutsUIState {
  capturingId: string | null;
  conflictMsg: string | null;
  captureListener: ((e: KeyboardEvent) => void) | null;
}

function renderShortcutsSection(container: HTMLElement): () => void {
  const s: ShortcutsUIState = { capturingId: null, conflictMsg: null, captureListener: null };

  const re = () => {
    const defs = shortcuts.getAll();
    const globalDefs = defs.filter(d => !d.context && !d.todo);
    const chatsDefs = defs.filter(d => d.context === "sessions" && !d.todo && !d.id.startsWith("assign-slot-"));
    const assignDefs = defs.filter(d => d.id.startsWith("assign-slot-") && !d.todo);
    const todoDefs = defs.filter(d => !!d.todo);
    const slotMode = shortcuts.getChatSlotMode();
    const isManual = slotMode === "manual";

    function kbdHtml(id: string): string {
      const binding = shortcuts.getBinding(id);
      return binding.split("+").map(k =>
        `<kbd>${k.charAt(0).toUpperCase() + k.slice(1)}</kbd>`
      ).join("+");
    }

    function rowHtml(def: ShortcutDef): string {
      const isCapturing = s.capturingId === def.id;
      const hasOverride = shortcuts.hasOverride(def.id);
      const isTodo = !!def.todo;

      const bindingEl = isCapturing
        ? `<span class="shortcut-capture-input">Press a key combo...</span>`
        : `<span class="shortcut-kbd">${kbdHtml(def.id)}</span>`;

      const conflictEl = (isCapturing && s.conflictMsg)
        ? `<div class="shortcut-conflict-msg">${s.conflictMsg}</div>`
        : "";

      const controls = isTodo
        ? `<span class="shortcut-row-todo-tag">coming soon</span>`
        : `<div class="shortcut-row-controls">
            <div>
              ${bindingEl}
              ${conflictEl}
            </div>
            <button class="shortcut-rebind-btn" data-rebind="${def.id}">${isCapturing ? "Cancel" : "Rebind"}</button>
            ${hasOverride ? `<button class="shortcut-reset-btn" data-reset="${def.id}" title="Reset to default"><i class="ph ph-arrow-counter-clockwise"></i></button>` : ""}
          </div>`;

      return `<div class="shortcut-row${isTodo ? " is-todo" : ""}" data-id="${def.id}">
        <div class="shortcut-row-info">
          <span class="shortcut-row-label">${def.label}</span>
          <span class="shortcut-row-desc">${def.description}</span>
        </div>
        ${controls}
      </div>`;
    }

    container.innerHTML = `
      <div class="shortcut-group-header">Global</div>
      ${globalDefs.map(rowHtml).join("")}
      <div class="shortcut-group-header">Chats</div>
      ${chatsDefs.map(rowHtml).join("")}
      <label class="shortcut-slot-mode-toggle">
        <input type="checkbox" id="slot-mode-checkbox" ${isManual ? "checked" : ""}>
        <span class="shortcut-slot-mode-label">
          <strong>Manual slot assignment</strong>
          <span class="shortcut-slot-mode-desc">${isManual
            ? "Ctrl+Shift+1-9 pins a chat to a slot. Ctrl+1-9 opens the pinned chat."
            : "Ctrl+1-9 opens chats by their sorted position."
          }</span>
        </span>
      </label>
      ${isManual ? `<div class="shortcut-group-header shortcut-group-header--sub">Slot assignment keys</div>${assignDefs.map(rowHtml).join("")}` : ""}
      <div class="shortcut-group-header">Coming Soon</div>
      ${todoDefs.map(rowHtml).join("")}
    `;

    container.querySelectorAll<HTMLButtonElement>("[data-rebind]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.rebind!;
        if (s.capturingId === id) {
          stopCapture();
        } else {
          startCapture(id);
        }
      });
    });

    container.querySelectorAll<HTMLButtonElement>("[data-reset]").forEach(btn => {
      btn.addEventListener("click", () => {
        shortcuts.resetBinding(btn.dataset.reset!);
        stopCapture();
      });
    });

    const slotCheckbox = container.querySelector<HTMLInputElement>("#slot-mode-checkbox");
    if (slotCheckbox) {
      slotCheckbox.addEventListener("change", () => {
        shortcuts.setChatSlotMode(slotCheckbox.checked ? "manual" : "auto");
        re();
      });
    }
  };

  function startCapture(id: string): void {
    stopCapture();
    s.capturingId = id;
    s.conflictMsg = null;

    const listener = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") { stopCapture(); return; }

      const combo = normalizeEvent(e);
      if (!combo) return;

      const conflict = shortcuts.findConflict(combo, id);
      if (conflict) {
        s.conflictMsg = `Already used by: ${conflict.label}`;
        re();
        return;
      }

      shortcuts.setBinding(id, combo);
      stopCapture();
    };

    s.captureListener = listener;
    document.addEventListener("keydown", listener, true);
    re();
  }

  function stopCapture(): void {
    if (s.captureListener) {
      document.removeEventListener("keydown", s.captureListener, true);
      s.captureListener = null;
    }
    s.capturingId = null;
    s.conflictMsg = null;
    re();
  }

  re();
  return () => stopCapture();
}

export function renderShortcutsView(root: HTMLElement): () => void {
  render(template(), root);

  const backBtn = root.querySelector<HTMLButtonElement>(".back-to-settings");
  if (backBtn) backBtn.onclick = () => g().navigateTo("settings");

  const container = root.querySelector<HTMLElement>("#shortcuts-section-container");
  const cleanup = container ? renderShortcutsSection(container) : () => {};

  return cleanup;
}

function template() {
  return html`
    <div class="view view-settings-shortcuts">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">
          <i class="ph ph-arrow-left"></i>
        </button>
        <h2>Shortcuts</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="kit-section">
          <div id="shortcuts-section-container"></div>
        </div>
      </div>
    </div>
  `;
}
