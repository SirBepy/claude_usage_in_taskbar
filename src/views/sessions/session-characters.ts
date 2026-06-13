/**
 * Per-project Heroes of the Storm character lookup for the sessions sidebar.
 *
 * The backend assigns every project an `Avatar::Character(id)` (see
 * `characters::assign`). This module caches a `project -> character id` map AND
 * a `character id -> icon data URL` map so `renderSidebar` can emit a filled
 * `<img src>` synchronously. Inlining the data URL (rather than hydrating it
 * async after render) is what stops the icons flashing broken every time the
 * sidebar repaints on a selection change.
 *
 * Populated on mount and refreshed on the `settings-changed` event (which fires
 * whenever an avatar is (re)assigned).
 */

import { api } from "../../shared/api";
import type { Instance } from "../../types/ipc.generated";

let charById = new Map<string, string>();
let charByPathKey = new Map<string, string>();
let iconUrlById = new Map<string, string>();

/** Normalize a path the way two cwd spellings of the same folder collapse:
 * forward slashes, no trailing slash, lowercased. Mirrors the backend's
 * `project_key` intent closely enough for a display-only lookup. */
function pathKey(p: string): string {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** (Re)load the project -> character map and preload each hero's icon data URL.
 * Safe to call repeatedly; already-fetched icon URLs are reused. */
export async function loadProjectCharacters(): Promise<void> {
  try {
    const projects = await api.listProjects();
    const byId = new Map<string, string>();
    const byPath = new Map<string, string>();
    for (const p of projects) {
      const av = p.avatar as { kind?: string; value?: string } | undefined;
      if (av?.kind === "character" && av.value) {
        if (p.id) byId.set(p.id, av.value);
        if (p.path) byPath.set(pathKey(String(p.path)), av.value);
      }
    }
    charById = byId;
    charByPathKey = byPath;

    // Preload icon data URLs so rows render with `src` already set. Reuse any
    // URLs we already resolved so a refresh only fetches genuinely-new heroes.
    const ids = new Set<string>([...byId.values(), ...byPath.values()]);
    const urls = new Map<string, string>(iconUrlById);
    await Promise.all(
      [...ids].map(async (id) => {
        if (urls.has(id)) return;
        try {
          const url = await api.characterAssetUrl(id, "icon.png");
          if (url) urls.set(id, url);
        } catch {
          /* leave uncached; renderer falls back to async hydrate */
        }
      }),
    );
    iconUrlById = urls;
  } catch (e) {
    console.warn("[sessions] loadProjectCharacters failed", e);
  }
}

/** The assigned HotS character id for a session's project, or null if the
 * project has no character avatar (or the map isn't loaded yet). Matches by
 * project_id first, then falls back to the session cwd. */
export function characterForSession(s: Instance): string | null {
  return (
    charById.get(s.project_id) ??
    charByPathKey.get(pathKey(String(s.cwd))) ??
    null
  );
}

/** Preloaded icon data URL for a character id, or null if not yet cached. */
export function characterIconUrl(charId: string): string | null {
  return iconUrlById.get(charId) ?? null;
}
