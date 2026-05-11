import type { ChatRenderer } from "../chat-renderer";

export const KNOWN_BUILTINS = [
  "help",
  "clear",
  "cost",
  "exit",
  "config",
  "permissions",
] as const;
export type BuiltinName = (typeof KNOWN_BUILTINS)[number];

export interface BuiltinParsed {
  name: BuiltinName;
  args: string;
}

export interface BuiltinContext {
  sessionId: string | null;
  projectDir: string | null;
  getRenderer: () => ChatRenderer | null;
  pane: HTMLElement | null;
}

export type BuiltinHandler = (
  parsed: BuiltinParsed,
  ctx: BuiltinContext,
) => Promise<void> | void;

const KNOWN = new Set<string>(KNOWN_BUILTINS);

export function parseBuiltin(text: string): BuiltinParsed | null {
  const m = text.match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!m) return null;
  const name = m[1];
  if (!name || !KNOWN.has(name)) return null;
  return { name: name as BuiltinName, args: (m[2] ?? "").trim() };
}

export const HANDLERS: Partial<Record<BuiltinName, BuiltinHandler>> = {};
