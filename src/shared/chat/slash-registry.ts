// Module-level shared slash-command registry. Populated by SlashProvider
// instances after each `list_slash_commands` refetch. The chat renderer reads
// from it to color-code `/X` mentions inline (builtin vs skill vs command).
//
// Multiple SlashProvider instances (one per composer) all push into the same
// store; last write wins. In practice they fetch the same data for the same
// project, so this is benign.

import type { SlashEntry, SlashSource } from "../../types/ipc.generated";

let _entries: SlashEntry[] = [];
let _lookup = new Map<string, SlashSource>();

export function setSlashEntries(entries: SlashEntry[]): void {
  _entries = entries;
  _lookup = new Map();
  for (const e of entries) _lookup.set(e.name, e.source);
}

export function getSlashSource(name: string): SlashSource | null {
  return _lookup.get(name) ?? null;
}

/**
 * Resolve a slash token that may be either `name` (user skill / command /
 * builtin) or `plugin:name` (plugin skill / plugin command). Returns the
 * registered source plus the bare name as the registry knows it. Returns
 * null if no match.
 */
export function lookupSlash(raw: string): { name: string; source: SlashSource } | null {
  const direct = _lookup.get(raw);
  if (direct) return { name: raw, source: direct };
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const plugin = raw.slice(0, colon);
    const bare = raw.slice(colon + 1);
    const src = _lookup.get(bare);
    if (src && (src.kind === "plugin-skill" || src.kind === "plugin-command")) {
      if ((src as { plugin: string }).plugin === plugin) {
        return { name: bare, source: src };
      }
    }
  }
  return null;
}

/**
 * Build the identifier the skill-detail view expects for a given slash
 * source. user-skill = bare name; plugin-skill = `<plugin>:<name>`.
 * Commands/builtins have no detail page; returns null.
 */
export function skillDetailTarget(name: string, source: SlashSource): string | null {
  if (source.kind === "user-skill") return name;
  if (source.kind === "plugin-skill") return `${(source as { plugin: string }).plugin}:${name}`;
  return null;
}

export function getSlashEntries(): SlashEntry[] {
  return _entries;
}

/** CSS class suffix for a slash kind. Returns `"unknown"` for null. */
export function slashKindClass(source: SlashSource | null): string {
  if (!source) return "unknown";
  return source.kind;
}
