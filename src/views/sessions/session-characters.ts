/**
 * Per-SESSION Heroes of the Storm character lookup for the sessions sidebar.
 *
 * The backend assigns every live session an `Avatar::Character(id)` via
 * `ensure_session_character`. This module caches a `session_id -> char_id` map
 * AND a `char_id -> icon data URL` map so `renderSidebar` can emit a filled
 * `<img src>` synchronously without flashing broken images on every repaint.
 *
 * Populated on mount and refreshed on the `settings-changed` event (which fires
 * whenever a character is assigned or re-rolled).
 */

import { api } from "../../shared/api";
import type { Instance } from "../../types/ipc.generated";

/** session_id -> char_id */
let sessionCharMap = new Map<string, string>();
let iconUrlById = new Map<string, string>();

/** (Re)load the session -> character map and preload each hero's icon data URL.
 * Safe to call repeatedly; already-fetched icon URLs are reused. */
export async function loadSessionCharacters(): Promise<void> {
  try {
    const raw = await api.listSessionCharacters();
    const bySession = new Map<string, string>();
    for (const [sid, cid] of Object.entries(raw)) {
      if (cid) bySession.set(sid, cid);
    }
    sessionCharMap = bySession;

    // Preload icon data URLs so rows render with `src` already set. Reuse any
    // URLs we already resolved so a refresh only fetches genuinely-new heroes.
    const ids = new Set<string>(bySession.values());
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
    console.warn("[sessions] loadSessionCharacters failed", e);
  }
}

/** The assigned HotS character id for a session, or null if not yet assigned
 * (or the map isn't loaded yet). */
export function characterForSession(s: Instance): string | null {
  return sessionCharMap.get(s.session_id) ?? null;
}

/** Preloaded icon data URL for a character id, or null if not yet cached. */
export function characterIconUrl(charId: string): string | null {
  return iconUrlById.get(charId) ?? null;
}
