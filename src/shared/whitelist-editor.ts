/**
 * Shared whitelist editor helper.
 *
 * Renders a self-contained character whitelist editor into `host` using
 * plain innerHTML (NOT lit templates) so it works correctly with the
 * production lit-html renderer, which silently drops repeated/nested
 * templates containing <select> or <input> lists.
 *
 * Empty-custom guard: if mode is "custom" but both `games` and `ids` are
 * empty, the Save button is disabled and an inline hint is shown instead
 * of emitting an invalid whitelist. This is the cleaner choice - the user
 * sees exactly what's wrong without a silent auto-fall-back that hides intent.
 */

import { api, type Character } from "./api";
import type { CharacterWhitelist } from "../types/ipc.generated";
import { escapeHtml } from "./escape-html";
import { hydrateCharacterIcons } from "./character-icon";
import "./whitelist-editor.css";

export interface WhitelistEditorOpts {
  value: CharacterWhitelist;
  /** When false, the "Use default" radio and "Reset to default" button are hidden. */
  allowDefault: boolean;
  onChange: (wl: CharacterWhitelist) => void;
}

interface GameGroup {
  /** The `game` field slug (may be empty string for characters without a game). */
  slug: string;
  label: string;
  chars: Character[];
}

let _cachedChars: Character[] | null = null;

async function getCharacters(): Promise<Character[]> {
  if (_cachedChars) return _cachedChars;
  _cachedChars = await api.listCharacters();
  return _cachedChars;
}

function groupCharacters(chars: Character[]): GameGroup[] {
  const map = new Map<string, GameGroup>();
  for (const c of chars) {
    const slug = c.game ?? "";
    const label = c.game_label ?? (slug || "Other");
    if (!map.has(slug)) map.set(slug, { slug, label, chars: [] });
    map.get(slug)!.chars.push(c);
  }
  return Array.from(map.values());
}

/** Build the HTML for the groups list. Icon src is a data-id placeholder; hydrated async. */
function buildGroupsHtml(
  groups: GameGroup[],
  wl: CharacterWhitelist,
): string {
  const customGames = wl.mode === "custom" ? new Set(wl.games) : new Set<string>();
  const customIds = wl.mode === "custom" ? new Set(wl.ids) : new Set<string>();
  const isCustom = wl.mode === "custom";

  let html = "";
  for (const g of groups) {
    const gameChecked = isCustom && customGames.has(g.slug);
    const slugAttr = g.slug ? escapeHtml(g.slug) : "";
    html += `<div class="wle-game-group">`;
    html += `<label class="wle-game-row">`;
    html += `<input type="checkbox" class="wle-game-cb" data-game="${slugAttr}"${gameChecked ? " checked" : ""}>`;
    html += `<span class="wle-game-label">${escapeHtml(g.label)}</span>`;
    html += `</label>`;
    html += `<div class="wle-chars">`;
    for (const c of g.chars) {
      // When the game checkbox is on, character rows are checked + disabled (covered by game rule).
      // When game is off, character rows reflect individual ids[].
      const coveredByGame = gameChecked;
      const checked = coveredByGame || (isCustom && customIds.has(c.id));
      const disabled = coveredByGame;
      html += `<label class="wle-char-row${disabled ? " wle-char-disabled" : ""}">`;
      html += `<input type="checkbox" class="wle-char-cb" data-id="${escapeHtml(c.id)}"`;
      if (checked) html += ` checked`;
      if (disabled) html += ` disabled`;
      html += `>`;
      // Icon: rendered as a tiny img; src will be filled by async hydration below.
      html += `<img class="wle-char-icon" data-char-id="${escapeHtml(c.id)}" src="" alt="" width="16" height="16">`;
      html += `<span class="wle-char-label">${escapeHtml(c.label)}</span>`;
      html += `</label>`;
    }
    html += `</div>`;
    html += `</div>`;
  }
  return html;
}

/**
 * Re-reads the DOM state inside host to derive the current CharacterWhitelist.
 * Returns null if mode is "custom" and both games and ids are empty (invalid).
 */
function readWhitelist(host: HTMLElement): CharacterWhitelist | null {
  const modeEl = host.querySelector<HTMLInputElement>("input[name='wle-mode']:checked");
  const mode = modeEl?.value ?? "all";

  if (mode === "default") return { mode: "default" };
  if (mode === "all") return { mode: "all" };

  // custom
  const games: string[] = [];
  host.querySelectorAll<HTMLInputElement>(".wle-game-cb:checked").forEach((cb) => {
    const slug = cb.dataset.game ?? "";
    if (slug) games.push(slug);
  });
  const ids: string[] = [];
  host.querySelectorAll<HTMLInputElement>(".wle-char-cb:checked:not(:disabled)").forEach((cb) => {
    const id = cb.dataset.id ?? "";
    if (id) ids.push(id);
  });

  if (games.length === 0 && ids.length === 0) return null; // empty-custom guard
  return { mode: "custom", games, ids };
}

function buildEditorHtml(
  groups: GameGroup[],
  wl: CharacterWhitelist,
  allowDefault: boolean,
): string {
  const isDefault = wl.mode === "default";
  const isAll = wl.mode === "all";
  const isCustom = wl.mode === "custom";
  const isReadOnly = isDefault && allowDefault;

  let html = `<div class="wle-root">`;

  // Mode controls
  html += `<div class="wle-modes">`;
  if (allowDefault) {
    html += `<label class="wle-mode-row">`;
    html += `<input type="radio" name="wle-mode" value="default"${isDefault ? " checked" : ""}>`;
    html += `<span>Use default list</span>`;
    html += `</label>`;
  }
  html += `<label class="wle-mode-row">`;
  html += `<input type="radio" name="wle-mode" value="all"${isAll ? " checked" : ""}>`;
  html += `<span>All characters</span>`;
  html += `</label>`;
  html += `<label class="wle-mode-row">`;
  html += `<input type="radio" name="wle-mode" value="custom"${isCustom ? " checked" : ""}>`;
  html += `<span>Custom selection</span>`;
  html += `</label>`;
  html += `</div>`;

  // Inheriting-default notice
  if (isReadOnly) {
    html += `<p class="wle-default-notice">Inheriting the global default</p>`;
  }

  // Custom group list (shown when custom; disabled/read-only when inheriting default)
  html += `<div class="wle-groups-section${isCustom ? "" : " wle-hidden"}">`;
  if (isReadOnly) {
    html += `<div class="wle-groups wle-groups-disabled">`;
  } else {
    html += `<div class="wle-groups">`;
  }
  html += buildGroupsHtml(groups, wl);
  html += `</div>`;

  // Empty-custom guard hint (hidden by default; shown dynamically via JS)
  html += `<p class="wle-empty-hint wle-hidden">Pick at least one game or character, or choose a different mode.</p>`;
  html += `</div>`;

  // Reset button (only when allowDefault)
  if (allowDefault) {
    html += `<div class="wle-actions">`;
    html += `<button class="btn-secondary wle-reset-btn" style="font-size:0.8rem">Reset to default</button>`;
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

export async function renderWhitelistEditor(
  host: HTMLElement,
  opts: WhitelistEditorOpts,
): Promise<void> {
  const { allowDefault, onChange } = opts;
  let currentWl: CharacterWhitelist = opts.value;

  const chars = await getCharacters();
  const groups = groupCharacters(chars);

  function render(): void {
    host.innerHTML = buildEditorHtml(groups, currentWl, allowDefault);
    wireInteractions();
    // Kick off async icon hydration without blocking
    void hydrateCharacterIcons(host);
  }

  function updateGroupsSection(): void {
    const groupsSection = host.querySelector<HTMLElement>(".wle-groups-section");
    const modeEl = host.querySelector<HTMLInputElement>("input[name='wle-mode']:checked");
    const mode = modeEl?.value ?? "all";
    const isCustom = mode === "custom";
    if (groupsSection) {
      if (isCustom) groupsSection.classList.remove("wle-hidden");
      else groupsSection.classList.add("wle-hidden");
    }
  }

  function rebuildGroupsHtml(): void {
    const groupsDiv = host.querySelector<HTMLElement>(".wle-groups");
    if (!groupsDiv) return;
    groupsDiv.classList.remove("wle-groups-disabled");
    groupsDiv.innerHTML = buildGroupsHtml(groups, currentWl);
    wireCheckboxes();
    void hydrateCharacterIcons(host);
  }

  function showEmptyHint(show: boolean): void {
    const hint = host.querySelector<HTMLElement>(".wle-empty-hint");
    if (!hint) return;
    if (show) hint.classList.remove("wle-hidden");
    else hint.classList.add("wle-hidden");
  }

  function emitChange(): void {
    const wl = readWhitelist(host);
    if (wl === null) {
      // Empty custom - show the guard hint, don't emit
      showEmptyHint(true);
      return;
    }
    showEmptyHint(false);
    currentWl = wl;
    onChange(wl);
  }

  function wireCheckboxes(): void {
    // Game checkboxes - toggling a game re-renders its member char rows
    host.querySelectorAll<HTMLInputElement>(".wle-game-cb").forEach((gameCb) => {
      gameCb.onchange = () => {
        const gameGroup = gameCb.closest<HTMLElement>(".wle-game-group");
        if (gameGroup) {
          const charCbs = gameGroup.querySelectorAll<HTMLInputElement>(".wle-char-cb");
          charCbs.forEach((charCb) => {
            // When game is checked, char rows become checked+disabled (covered by game rule).
            // When game is unchecked, char rows revert to unchecked+enabled.
            charCb.checked = gameCb.checked;
            charCb.disabled = gameCb.checked;
            const label = charCb.closest<HTMLElement>(".wle-char-row");
            if (label) {
              if (gameCb.checked) label.classList.add("wle-char-disabled");
              else label.classList.remove("wle-char-disabled");
            }
          });
        }
        emitChange();
      };
    });

    // Individual char checkboxes
    host.querySelectorAll<HTMLInputElement>(".wle-char-cb").forEach((charCb) => {
      charCb.onchange = () => emitChange();
    });
  }

  function wireInteractions(): void {
    // Mode radios
    host.querySelectorAll<HTMLInputElement>("input[name='wle-mode']").forEach((radio) => {
      radio.onchange = () => {
        const mode = radio.value as CharacterWhitelist["mode"];
        updateGroupsSection();

        if (mode === "default") {
          // Immediately emit default; don't need groups
          showEmptyHint(false);
          currentWl = { mode: "default" };
          onChange(currentWl);
          return;
        }
        if (mode === "all") {
          showEmptyHint(false);
          currentWl = { mode: "all" };
          onChange(currentWl);
          return;
        }
        // custom: rebuild groups with fresh state (empty games+ids unless prior state was custom)
        if (currentWl.mode !== "custom") {
          currentWl = { mode: "custom", games: [], ids: [] };
        }
        rebuildGroupsHtml();
        // Empty custom on first switch - show hint immediately
        if (currentWl.games.length === 0 && currentWl.ids.length === 0) {
          showEmptyHint(true);
        }
      };
    });

    // Reset to default button
    const resetBtn = host.querySelector<HTMLButtonElement>(".wle-reset-btn");
    if (resetBtn) {
      resetBtn.onclick = () => {
        currentWl = { mode: "default" };
        render();
        onChange(currentWl);
      };
    }

    wireCheckboxes();
  }

  render();
}
