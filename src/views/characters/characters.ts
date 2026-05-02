import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import { loadCharacters, invalidateCharactersCache, slotFillCount } from "../../shared/characters";
import { hydrateCharacterAvatars } from "../../shared/projects";
import { api, type Character, type CharacterSlot } from "../../shared/api";
import "./characters.css";

const ALL_SLOTS: CharacterSlot[] = ["work_finished", "question_asked", "ready", "select", "annoyed", "death"];

let lastSelectedId: string | null = null;

function characterCardTemplate(c: Character) {
  const { filled, total } = slotFillCount(c);
  const active = c.id === lastSelectedId ? " active" : "";
  return html`
    <div class="char-card${active}" data-character-id="${c.id}">
      <img class="char-avatar" data-character-id="${c.id}" alt="${c.label}" />
      <div class="body">
        <div class="name">${c.label}</div>
        <div class="meta">${filled}/${total} slots filled</div>
      </div>
    </div>
  `;
}

function renderDetail(c: Character): void {
  lastSelectedId = c.id;
  const detail = document.getElementById("character-detail");
  if (!detail) return;
  const tmpl = html`
    <h3>${c.label}</h3>
    <p class="muted">id: ${c.id} · v${c.version}</p>
    ${ALL_SLOTS.map((slot) => {
      const files = c.slots[slot] ?? [];
      return html`
        <div class="slot-row">
          <div class="slot-name">${slot}</div>
          <div class="slot-files">
            ${files.length === 0
              ? html`<span class="muted">(empty)</span>`
              : files.map((f) => html`
                  <button class="play-btn" @click=${() => api.playCharacterSlot(c.id, slot).catch(console.error)}>
                    ▶ ${f}
                  </button>
                `)}
          </div>
        </div>
      `;
    })}
  `;
  render(tmpl, detail);
}

async function refresh(): Promise<void> {
  const list = document.getElementById("characters-list");
  if (!list) return;
  const chars = await loadCharacters();
  if (chars.length === 0) {
    list.innerHTML = `<div class="no-data">No characters installed. Run <code>/character-creator &lt;name&gt;</code> in Claude Code to make one, or open the characters folder and drop one in.</div>`;
    const detail = document.getElementById("character-detail");
    if (detail) detail.innerHTML = "";
    return;
  }
  render(html`${chars.map(characterCardTemplate)}`, list);
  await hydrateCharacterAvatars(list);
  for (const card of Array.from(list.querySelectorAll<HTMLElement>(".char-card"))) {
    card.onclick = () => {
      const id = card.dataset.characterId;
      if (!id) return;
      const c = chars.find((x) => x.id === id);
      if (c) {
        list.querySelectorAll<HTMLElement>(".char-card.active").forEach((el) => el.classList.remove("active"));
        card.classList.add("active");
        renderDetail(c);
      }
    };
  }
  const initial = (lastSelectedId && chars.find((c) => c.id === lastSelectedId)) || chars[0];
  if (!initial) return;
  renderDetail(initial);
  list.querySelector<HTMLElement>(`.char-card[data-character-id="${initial.id}"]`)?.classList.add("active");
}

function template() {
  return html`
    <div class="view view-characters">
      <div class="view-header">
        <button class="icon-btn burger" title="Menu" data-burger="true" @click=${openSidemenu}>
          <i class="ph ph-list"></i>
        </button>
        <h2>Characters</h2>
        <div class="view-header-actions">
          <button class="icon-btn" id="characters-refresh" title="Refresh">
            <i class="ph ph-arrow-clockwise"></i>
          </button>
          <button class="btn-secondary" id="characters-open-folder">
            <i class="ph ph-folder-open"></i> Folder
          </button>
          <button class="btn-secondary" id="characters-create-new">
            <i class="ph ph-plus"></i> New
          </button>
        </div>
      </div>
      <div class="view-body">
        <div id="characters-list" class="characters-grid"></div>
        <div id="character-detail"></div>
      </div>
    </div>
  `;
}

export async function renderCharactersView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  const refreshBtn = root.querySelector<HTMLButtonElement>("#characters-refresh");
  if (refreshBtn) refreshBtn.onclick = () => {
    invalidateCharactersCache();
    void refresh();
  };

  const openFolder = root.querySelector<HTMLButtonElement>("#characters-open-folder");
  if (openFolder) openFolder.onclick = async () => {
    try {
      const dir = await api.getCharactersDir();
      await api.openInExplorer(dir);
    } catch (e) {
      console.error("openCharactersFolder failed", e);
    }
  };

  const createBtn = root.querySelector<HTMLButtonElement>("#characters-create-new");
  if (createBtn) createBtn.onclick = () => {
    alert("To make a new character, run this in Claude Code:\n\n  /character-creator <name>\n\nThe skill searches sprite + sound sources, downloads candidates, and asks you to pick which go into each slot.");
  };

  await refresh();

  return () => {
    /* nothing to tear down */
  };
}
