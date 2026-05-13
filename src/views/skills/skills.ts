import { html, render, type TemplateResult } from "lit-html";
import { api } from "../../shared/api";
import type { InstalledSkill } from "../../types/ipc.generated";
import { showView } from "../../shared/navigation";
import { openSidemenu } from "../../shared/sidemenu";
import "./skills.css";

let allSkills: InstalledSkill[] = [];
let query = "";

function filtered(): InstalledSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return allSkills;
  return allSkills.filter(
    (s) =>
      s.skill.toLowerCase().includes(q) ||
      (s.description || "").toLowerCase().includes(q) ||
      (s.plugin || "").toLowerCase().includes(q) ||
      (s.project || "").toLowerCase().includes(q),
  );
}

function openSkill(skill: string) {
  (window as unknown as { skillDetailTarget?: string }).skillDetailTarget = skill;
  showView("skill-detail");
}

function template(loading: boolean): TemplateResult {
  const rows = filtered();
  return html`
    <div class="view view-skills">
      <div class="view-header">
        <button class="icon-btn burger" title="Menu" data-burger="true" @click=${openSidemenu}>
          <i class="ph ph-list"></i>
        </button>
        <h2>Skills</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="skills-search">
          <input
            type="search"
            placeholder="Search skills..."
            .value=${query}
            @input=${(e: Event) => {
              query = (e.target as HTMLInputElement).value;
              draw();
            }}
            autocomplete="off"
            spellcheck="false"
          />
          <div class="skills-count">${rows.length} of ${allSkills.length}</div>
        </div>
        ${loading
          ? html`<div class="skills-empty">Loading&hellip;</div>`
          : allSkills.length === 0
            ? html`<div class="skills-empty">No skills found under <code>~/.claude/skills/</code> or installed plugin caches.</div>`
            : rows.length === 0
              ? html`<div class="skills-empty">No skills match &quot;${query}&quot;.</div>`
              : html`
                <ul class="skills-list">
                  ${rows.map(
                    (s) => html`
                      <li @click=${() => openSkill(s.skill)}>
                        <div class="skill-row-main">
                          <span class="skill-name">${s.skill}</span>
                          ${s.plugin
                            ? html`<span class="skill-plugin">${s.plugin}</span>`
                            : s.project
                              ? html`<span class="skill-plugin project">${s.project}</span>`
                              : html`<span class="skill-plugin user">user</span>`}
                        </div>
                        ${s.description
                          ? html`<div class="skill-desc">${s.description}</div>`
                          : ""}
                      </li>
                    `,
                  )}
                </ul>
              `}
      </div>
    </div>
  `;
}

let mounted: HTMLElement | null = null;

function draw() {
  if (!mounted) return;
  render(template(allSkills.length === 0 && query === "" && loadingFlag), mounted);
}

let loadingFlag = true;

export async function renderSkillsView(root: HTMLElement): Promise<() => void> {
  mounted = root;
  loadingFlag = true;
  draw();
  try {
    allSkills = await api.listInstalledSkills();
  } catch (err) {
    console.error("listInstalledSkills failed", err);
    allSkills = [];
  }
  loadingFlag = false;
  draw();

  return () => {
    mounted = null;
  };
}
