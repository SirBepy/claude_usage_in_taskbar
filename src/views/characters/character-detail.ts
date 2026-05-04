import { html, render, type TemplateResult } from "lit-html";
import { api, type Character, type CharacterSlot } from "../../shared/api";
import { loadCharacters } from "../../shared/characters";
import { hydrateCharacterAvatars } from "../../shared/projects";
import { showView } from "../../shared/navigation";
import "./character-detail.css";

const ALL_SLOTS: CharacterSlot[] = [
  "work_finished",
  "question_asked",
  "ready",
  "select",
  "annoyed",
  "death",
];

let currentCharacterId: string | null = null;

let activeFile: string | null = null;
let activeRoot: HTMLElement | null = null;
let activeChar: Character | null = null;

export function openCharacterDetail(id: string): void {
  void api.stopCharacterPreview();
  activeFile = null;
  currentCharacterId = id;
  showView("character-detail");
}

function rerender(): void {
  if (activeRoot && activeChar) {
    render(detailTemplate(activeChar), activeRoot);
  }
}

function togglePlay(file: string, charId: string): void {
  if (activeFile === file) {
    activeFile = null;
    rerender();
    void api.stopCharacterPreview();
    return;
  }
  activeFile = file;
  rerender();
  void api.previewCharacterFile(charId, file).catch((e) => {
    console.error("[char-detail] preview failed", e);
    activeFile = null;
    rerender();
  });
}

function formatSlot(slot: string): string {
  return slot.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function detailTemplate(c: Character): TemplateResult {
  return html`
    <div class="view view-character-detail">
      <div class="view-header">
        <button
          class="icon-btn"
          title="Back"
          @click=${() => {
            void api.stopCharacterPreview();
            activeFile = null;
            showView("characters");
          }}
        >
          <i class="ph ph-arrow-left"></i>
        </button>
        <h2>${c.label}</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="char-detail-hero">
          <img
            class="char-avatar char-detail-avatar"
            data-character-id="${c.id}"
            alt="${c.label}"
          />
          ${c.game_label || c.game
            ? html`<div class="char-detail-game-chip">${c.game_label ?? c.game}</div>`
            : ""}
          <div class="char-detail-sub">id: ${c.id} · v${c.version}</div>
        </div>
        <div class="section">
          <div class="section-title">Sound Slots</div>
          ${ALL_SLOTS.map((slot) => {
            const files = c.slots[slot] ?? [];
            return html`
              <div class="char-slot-row">
                <div class="char-slot-name">${formatSlot(slot)}</div>
                <div class="char-slot-files">
                  ${files.length === 0
                    ? html`<span class="char-slot-empty">(empty)</span>`
                    : files.map((f) => {
                        const isPlaying = activeFile === f;
                        return html`
                          <button
                            class="char-play-btn ${isPlaying ? "playing" : ""}"
                            @click=${() => togglePlay(f, c.id)}
                          >
                            <i class="ph ${isPlaying ? "ph-pause" : "ph-play"}"></i>
                            ${f.split("/").pop()}
                          </button>
                        `;
                      })}
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;
}

export async function renderCharacterDetailView(root: HTMLElement): Promise<() => void> {
  const id = currentCharacterId;
  if (!id) {
    showView("characters");
    return () => {};
  }

  activeRoot = root;

  render(
    html`
      <div class="view view-character-detail">
        <div class="view-header">
          <button
            class="icon-btn"
            @click=${() => {
              void api.stopCharacterPreview();
              activeFile = null;
              showView("characters");
            }}
          >
            <i class="ph ph-arrow-left"></i>
          </button>
          <h2>Loading...</h2>
          <div style="width:32px"></div>
        </div>
        <div class="view-body"></div>
      </div>
    `,
    root,
  );

  const chars = await loadCharacters();
  const c = chars.find((x) => x.id === id);
  if (!c) {
    activeRoot = null;
    showView("characters");
    return () => {};
  }

  activeChar = c;
  render(detailTemplate(c), root);
  await hydrateCharacterAvatars(root);

  const unlisten = api.onCharacterPreviewEnded(() => {
    activeFile = null;
    rerender();
  });

  return () => {
    void api.stopCharacterPreview();
    activeFile = null;
    activeRoot = null;
    activeChar = null;
    unlisten();
  };
}
