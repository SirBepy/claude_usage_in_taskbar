import { html, render } from "lit-html";
import { loadCharacters, populateCharacterSelect } from "../../../../shared/characters";
import { renderAvatar, hydrateCharacterAvatars, projectLabel } from "../../../../shared/projects";
import { getProjectDetailState, getSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import { backFromSubview } from "../../../../shared/navigation";
import "./character-pick.css";

function template() {
  return html`
    <div class="view view-project-character-pick">
      <div class="view-header">
        <button class="icon-btn" id="characterPickBackBtn" title="Back"><i class="ph ph-arrow-left"></i></button>
        <div style="display:flex;align-items:center;gap:8px;flex:1">
          <div class="avatar-mini" id="characterPickAvatar">?</div>
          <h2 id="characterPickTitle" style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Character</h2>
        </div>
      </div>
      <div class="view-body">
        <p class="muted">Plays this character's sounds when this project finishes work or asks a question. None falls back to the global default sound.</p>
        <label for="character-select">Character</label>
        <select id="character-select"></select>
      </div>
    </div>
  `;
}

export async function renderCharacterPickView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  const back = root.querySelector<HTMLButtonElement>("#characterPickBackBtn");
  if (back) back.onclick = () => backFromSubview();

  const cwd = getProjectDetailState().cwd;
  if (!cwd) return () => { /* nothing */ };

  // Populate header
  const settings = getSettings();
  const configured = (settings.projects || []).find((p) => p.path === cwd);
  const avatar = configured?.avatar || {
    kind: "emoji" as const,
    value: (configured?.name || cwd || "?").charAt(0),
  };
  const aliases = settings.projectAliases || {};

  const titleEl = root.querySelector<HTMLElement>("#characterPickTitle");
  if (titleEl) titleEl.textContent = projectLabel(cwd, aliases);

  const avatarEl = root.querySelector<HTMLElement>("#characterPickAvatar");
  if (avatarEl) {
    avatarEl.innerHTML = renderAvatar(avatar);
    if (avatar.kind === "character") {
      void hydrateCharacterAvatars(avatarEl);
    }
  }

  const select = root.querySelector<HTMLSelectElement>("#character-select");
  if (!select) return () => { /* nothing */ };

  // Fetch project from backend to get current assignment
  const projects = (await api.listProjects()) as unknown as Array<{ id: string; path: string; avatar?: { kind?: string; value?: string } }>;
  const proj = projects.find((p) => p.path === cwd);

  const chars = await loadCharacters();
  const currentAvatar = proj?.avatar;
  const currentId = currentAvatar?.kind === "character" ? (currentAvatar.value ?? null) : null;
  populateCharacterSelect(select, chars, currentId);

  select.onchange = async () => {
    if (!proj) return;
    const value = select.value === "" ? null : select.value;
    try {
      await api.assignCharacter(proj.id, value);
    } catch (e) {
      console.error("[character-pick] assign failed", e);
    }
  };

  return () => { /* nothing to tear down */ };
}
