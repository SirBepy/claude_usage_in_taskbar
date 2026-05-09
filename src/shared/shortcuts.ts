// src/shared/shortcuts.ts
import { getActiveView } from "./navigation";

export interface ShortcutDef {
  id: string;
  defaultKeys: string;
  label: string;
  description: string;
  context?: string;
  suppressInInput: boolean;
  todo?: string;
}

const SHORTCUT_DEFS: ShortcutDef[] = [
  // Global
  { id: "new-chat",   defaultKeys: "ctrl+n",       label: "New chat",       description: "Open project picker to start a chat",   suppressInInput: true },
  { id: "go-home",    defaultKeys: "ctrl+shift+h",  label: "Go to Home",     description: "Navigate to the Home view",              suppressInInput: true },
  { id: "go-chats",   defaultKeys: "ctrl+shift+c",  label: "Go to Chats",    description: "Navigate to the Chats view",             suppressInInput: true },

  // Chats view
  { id: "open-chat-1", defaultKeys: "ctrl+1", label: "Open chat 1", description: "Open the most recent chat",    context: "sessions", suppressInInput: true },
  { id: "open-chat-2", defaultKeys: "ctrl+2", label: "Open chat 2", description: "Open the 2nd most recent chat", context: "sessions", suppressInInput: true },
  { id: "open-chat-3", defaultKeys: "ctrl+3", label: "Open chat 3", description: "Open the 3rd most recent chat", context: "sessions", suppressInInput: true },
  { id: "open-chat-4", defaultKeys: "ctrl+4", label: "Open chat 4", description: "Open the 4th most recent chat", context: "sessions", suppressInInput: true },
  { id: "open-chat-5", defaultKeys: "ctrl+5", label: "Open chat 5", description: "Open the 5th most recent chat", context: "sessions", suppressInInput: true },
  { id: "open-chat-6", defaultKeys: "ctrl+6", label: "Open chat 6", description: "Open the 6th most recent chat", context: "sessions", suppressInInput: true },
  { id: "open-chat-7", defaultKeys: "ctrl+7", label: "Open chat 7", description: "Open the 7th most recent chat", context: "sessions", suppressInInput: true },
  { id: "open-chat-8", defaultKeys: "ctrl+8", label: "Open chat 8", description: "Open the 8th most recent chat", context: "sessions", suppressInInput: true },
  { id: "open-chat-9", defaultKeys: "ctrl+9", label: "Open chat 9", description: "Open the 9th most recent chat", context: "sessions", suppressInInput: true },
  { id: "close-chat",  defaultKeys: "ctrl+w", label: "Close chat",  description: "Cancel the focused chat's active turn", context: "sessions", suppressInInput: true },

  // Future (todo — shown in settings, no handler wired)
  { id: "open-chat-split-1", defaultKeys: "ctrl+shift+1", label: "Open chat 1 in split", description: "Open most recent chat in splitscreen",    context: "sessions", suppressInInput: true, todo: "Requires splitscreen implementation" },
  { id: "open-chat-split-2", defaultKeys: "ctrl+shift+2", label: "Open chat 2 in split", description: "Open 2nd most recent chat in splitscreen",  context: "sessions", suppressInInput: true, todo: "Requires splitscreen implementation" },
  { id: "open-chat-split-3", defaultKeys: "ctrl+shift+3", label: "Open chat 3 in split", description: "Open 3rd most recent chat in splitscreen",  context: "sessions", suppressInInput: true, todo: "Requires splitscreen implementation" },
  { id: "open-chat-split-4", defaultKeys: "ctrl+shift+4", label: "Open chat 4 in split", description: "Open 4th most recent chat in splitscreen",  context: "sessions", suppressInInput: true, todo: "Requires splitscreen implementation" },
  { id: "open-chat-split-5", defaultKeys: "ctrl+shift+5", label: "Open chat 5 in split", description: "Open 5th most recent chat in splitscreen",  context: "sessions", suppressInInput: true, todo: "Requires splitscreen implementation" },
  { id: "open-chat-split-6", defaultKeys: "ctrl+shift+6", label: "Open chat 6 in split", description: "Open 6th most recent chat in splitscreen",  context: "sessions", suppressInInput: true, todo: "Requires splitscreen implementation" },
  { id: "open-chat-split-7", defaultKeys: "ctrl+shift+7", label: "Open chat 7 in split", description: "Open 7th most recent chat in splitscreen",  context: "sessions", suppressInInput: true, todo: "Requires splitscreen implementation" },
  { id: "open-chat-split-8", defaultKeys: "ctrl+shift+8", label: "Open chat 8 in split", description: "Open 8th most recent chat in splitscreen",  context: "sessions", suppressInInput: true, todo: "Requires splitscreen implementation" },
  { id: "open-chat-split-9", defaultKeys: "ctrl+shift+9", label: "Open chat 9 in split", description: "Open 9th most recent chat in splitscreen",  context: "sessions", suppressInInput: true, todo: "Requires splitscreen implementation" },
];

// ── Storage ────────────────────────────────────────────────────────────────

const LS_KEY = "cc_shortcuts_bindings";

function loadBindings(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch { /* ignore */ }
  return {};
}

function saveBindings(overrides: Record<string, string>): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)); }
  catch { /* ignore */ }
}

// ── Runtime state ──────────────────────────────────────────────────────────

const handlers = new Map<string, () => void | Promise<void>>();
const ctrlHeldCallbacks = new Set<(held: boolean) => void>();

// ── Pure helpers (exported for tests) ─────────────────────────────────────

export function normalizeEvent(e: {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  key: string;
}): string {
  const key = e.key.toLowerCase();
  if (key === "control" || key === "shift" || key === "alt" || key === "meta") return "";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  parts.push(key);
  return parts.join("+");
}

export function findConflict(keys: string, excludeId?: string): ShortcutDef | null {
  const overrides = loadBindings();
  for (const def of SHORTCUT_DEFS) {
    if (def.id === excludeId) continue;
    const current = overrides[def.id] ?? def.defaultKeys;
    if (current === keys) return def;
  }
  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function register(id: string, handler: () => void | Promise<void>): void {
  handlers.set(id, handler);
}

export function unregister(id: string): void {
  handlers.delete(id);
}

export function onCtrlHeld(cb: (held: boolean) => void): () => void {
  ctrlHeldCallbacks.add(cb);
  return () => ctrlHeldCallbacks.delete(cb);
}

export function getAll(): ShortcutDef[] {
  return [...SHORTCUT_DEFS];
}

export function getBinding(id: string): string {
  const overrides = loadBindings();
  const def = SHORTCUT_DEFS.find(d => d.id === id);
  if (!def) return "";
  return overrides[id] ?? def.defaultKeys;
}

export function setBinding(id: string, keys: string): void {
  const overrides = loadBindings();
  overrides[id] = keys;
  saveBindings(overrides);
}

export function resetBinding(id: string): void {
  const overrides = loadBindings();
  delete overrides[id];
  saveBindings(overrides);
}

export function hasOverride(id: string): boolean {
  const overrides = loadBindings();
  return Object.prototype.hasOwnProperty.call(overrides, id);
}

// ── Dispatcher (DOM — guarded for test environments) ──────────────────────

function fireCtrlHeld(held: boolean): void {
  for (const cb of ctrlHeldCallbacks) cb(held);
}

function _init(): void {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Control" || e.key === "Meta") {
      fireCtrlHeld(true);
      return;
    }

    const combo = normalizeEvent(e);
    if (!combo) return;

    const overrides = loadBindings();
    const def = SHORTCUT_DEFS.find(d => {
      const binding = overrides[d.id] ?? d.defaultKeys;
      return binding === combo;
    });
    if (!def) return;

    if (def.suppressInInput) {
      const t = document.activeElement;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) return;
    }

    if (def.context && getActiveView() !== def.context) return;

    const handler = handlers.get(def.id);
    if (!handler) return;

    e.preventDefault();
    void handler();
  });

  document.addEventListener("keyup", (e) => {
    if (e.key === "Control" || e.key === "Meta") fireCtrlHeld(false);
  });

  window.addEventListener("blur", () => fireCtrlHeld(false));
}

if (typeof document !== "undefined") {
  _init();
}
