// Character-picker sub-feature for the new-chat modal (ai_todo 184). Split out
// of model-effort-modal.ts once that file's character-pane section grew large
// enough to warrant its own module, mirroring the earlier account-field.ts
// extraction from the same file. model-effort-modal.ts is the only caller; it
// owns the returned CharacterPane and renders/reads it in its own closure.

import { escapeHtml } from "../../shared/escape-html";
import { api } from "../../shared/api";
import type { Character } from "../../shared/api";
import { openChangeCharacterModal } from "../../shared/change-character-modal";
import { state } from "./state";
import { characterForSession } from "./session-characters";

// ── Sound debounce ────────────────────────────────────────────────────────────
// Module-level so multiple rapid picks don't stack timers.
let _selectTimer: ReturnType<typeof setTimeout> | null = null;
function playSelect(id: string): void {
  if (_selectTimer !== null) clearTimeout(_selectTimer);
  _selectTimer = setTimeout(() => {
    _selectTimer = null;
    api.playCharacterSlot(id, "select").catch(() => {});
  }, 250);
}

/** Cancel any pending debounced "select" sound - call when the owning modal closes. */
export function cancelCharacterPaneSound(): void {
  if (_selectTimer !== null) { clearTimeout(_selectTimer); _selectTimer = null; }
}

export interface CharacterPane {
  /** Re-render `.me-char-pane` from current state. Call after every
   * `renderBody()` in the owning modal, since that rebuilds the overlay's
   * innerHTML (and with it, the empty `.me-char-pane` div this renders into). */
  render(): void;
  /** Kick off the background character-pool load (resolveWhitelistCharacters);
   * picks an initial character and renders once it resolves. Fire-and-forget. */
  loadPool(): void;
  /** The currently selected character's id, or null if none picked/available -
   * what the modal threads through into the returned SessionConfig. */
  currentCharacterId(): string | null;
}

/** Owns the character pool/selection/icon-cache for a new-chat modal's
 * right-side character pane and renders into `.me-char-pane` inside `overlay`. */
export function createCharacterPane(overlay: HTMLElement, projectId: string | null): CharacterPane {
  let character: Character | null = null;
  let pool: Character[] | null = null; // null = not loaded yet
  // icon url cache: charId -> url (null = in-flight)
  const iconCache = new Map<string, string | null>();

  /** Pick a random character from the pool, excluding `excludeId` and ids
   * already held by live sessions of this project. Falls back to the whole
   * pool (duplicate allowed) if the filtered set is empty. */
  function pickCharacter(excludeId: string | null): void {
    if (!pool || pool.length === 0) return;

    // Live-taken: ids held by any live session (global dedup)
    const liveTaken = new Set(
      state.sessions
        .filter((s) => !s.ended_at && !(s as { end_reason?: unknown }).end_reason)
        .map((s) => characterForSession(s))
        .filter((id): id is string => id !== null),
    );

    // Prefer: pool minus liveTaken minus excludeId
    let candidates = pool.filter((c) => !liveTaken.has(c.id) && c.id !== excludeId);
    // Fallback: pool minus excludeId
    if (candidates.length === 0) candidates = pool.filter((c) => c.id !== excludeId);
    // Last resort: whole pool
    if (candidates.length === 0) candidates = pool;

    const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
    character = pick;
    playSelect(pick.id);
  }

  /** Render just the right-side character pane HTML; replaces .me-char-pane in place. */
  function renderCharPane(): void {
    const pane = overlay.querySelector<HTMLElement>(".me-char-pane");
    if (!pane) return;

    if (pool !== null && pool.length === 0) {
      pane.innerHTML = `<div class="me-char-empty">No characters available</div>`;
      return;
    }

    if (pool === null) {
      pane.innerHTML = `<div class="me-char-loading">Loading character...</div>`;
      return;
    }

    if (!character) {
      pane.innerHTML = `<div class="me-char-empty">No character selected</div>`;
      return;
    }

    const charId = character.id;
    const cachedUrl = iconCache.get(charId);
    let portraitHtml: string;
    if (cachedUrl) {
      portraitHtml = `<img class="me-char-portrait" src="${escapeHtml(cachedUrl)}" alt="${escapeHtml(character.label)}" data-char-portrait="${escapeHtml(charId)}">`;
    } else {
      portraitHtml = `<div class="me-char-portrait me-char-portrait-ph" data-char-portrait-ph="${escapeHtml(charId)}"><i class="ph ph-question"></i></div>`;
    }

    const gameLine = character.game_label
      ? `<span class="me-char-game">${escapeHtml(character.game_label)}</span>`
      : "";

    pane.innerHTML = `
      ${portraitHtml}
      <span class="me-char-name">${escapeHtml(character.label)}</span>
      ${gameLine}
      <div class="me-char-btns">
        <button type="button" class="me-char-reroll"><i class="ph ph-shuffle"></i> Reroll</button>
        <button type="button" class="me-char-choose"><i class="ph ph-user"></i> Choose</button>
      </div>
    `;

    attachCharHandlers();

    // Lazy-load portrait if not cached yet
    if (!iconCache.has(charId)) {
      iconCache.set(charId, null); // in-flight sentinel
      api.characterAssetUrl(charId, "icon.png").then((url) => {
        iconCache.set(charId, url);
        // Patch DOM directly - avoid full re-render
        const ph = overlay.querySelector<HTMLElement>(`[data-char-portrait-ph="${CSS.escape(charId)}"]`);
        if (ph && url) {
          const img = document.createElement("img");
          img.className = "me-char-portrait";
          img.src = url;
          img.alt = character?.label ?? "";
          img.dataset.charPortrait = charId;
          ph.replaceWith(img);
        }
      }).catch(() => { /* leave placeholder */ });
    }
  }

  function attachCharHandlers(): void {
    overlay.querySelector<HTMLButtonElement>(".me-char-reroll")?.addEventListener("click", () => {
      pickCharacter(character?.id ?? null);
      renderCharPane();
    });

    overlay.querySelector<HTMLButtonElement>(".me-char-choose")?.addEventListener("click", () => {
      if (!projectId) return;
      void openChangeCharacterModal({
        projectId,
        currentId: character?.id ?? null,
      }).then(async (picked) => {
        if (!picked) return;
        // Look up in pool first; if not there (e.g. pool is "whitelisted" but user
        // picked from "all"), fetch the full list and find it there.
        let found = pool?.find((c) => c.id === picked) ?? null;
        if (!found) {
          try {
            const all = await api.listCharacters();
            found = all.find((c) => c.id === picked) ?? null;
          } catch {
            // best-effort; fall back to a stub
          }
        }
        if (found) {
          character = found;
        } else {
          // Stub: only id is known; label/game unavailable but pane still works
          character = { id: picked, label: picked, version: 0, icon: "", slots: {} };
        }
        playSelect(picked);
        renderCharPane();
      });
    });
  }

  return {
    render: renderCharPane,
    loadPool(): void {
      api.resolveWhitelistCharacters(projectId ?? "")
        .then((chars) => {
          pool = chars;
          if (pool.length > 0) {
            pickCharacter(null); // initial pick (plays sound)
          }
          renderCharPane();
        })
        .catch(() => {
          pool = []; // treat as unavailable
          renderCharPane();
        });
    },
    currentCharacterId(): string | null {
      return character?.id ?? null;
    },
  };
}
