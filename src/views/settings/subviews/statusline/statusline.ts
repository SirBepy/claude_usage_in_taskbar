import { html, render } from "lit-html";
import {
  ALL_STATUSLINE_FIELDS,
  DEFAULT_STATUSLINE_FIELDS,
  loadStatuslineFields,
  saveStatuslineFields,
  shortModelName,
} from "../../../sessions/session-statusbar";
import "../../settings.css";
import "./statusline.css";
import "../../../sessions/session-statusbar.css";

interface LegacyGlobals {
  navigateTo(name: string): Promise<void>;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

// Mock data used for the live preview.
const MOCK = {
  branch: "main",
  repo: "my-project",
  folder: "my-project",
  model: shortModelName("claude-sonnet-4-6"),
  effort: "Normal",
  contextPct: "45",
  duration: "2m 30s",
};

function previewChips(fields: string[]): string {
  const git: string[] = [];
  const claude: string[] = [];

  if (fields.includes("branch"))
    git.push(`<span class="sb-chip sb-branch"><i class="ph ph-git-branch"></i>${MOCK.branch}</span>`);
  if (fields.includes("repo"))
    git.push(`<span class="sb-chip sb-repo"><i class="ph ph-folder-simple"></i>${MOCK.repo}</span>`);
  if (fields.includes("folder"))
    git.push(`<span class="sb-chip sb-folder"><i class="ph ph-folder-open"></i>${MOCK.folder}</span>`);

  if (fields.includes("model"))
    claude.push(`<span class="sb-chip sb-model"><i class="ph ph-robot"></i>${MOCK.model}</span>`);
  if (fields.includes("effort"))
    claude.push(`<span class="sb-chip sb-effort"><i class="ph ph-gauge"></i>${MOCK.effort}</span>`);
  if (fields.includes("context"))
    claude.push(`<span class="sb-chip sb-context"><i class="ph ph-stack"></i>${MOCK.contextPct}%</span>`);
  if (fields.includes("thinking"))
    claude.push(`<span class="sb-chip sb-thinking active"><i class="ph ph-brain"></i>thinking</span>`);
  if (fields.includes("duration"))
    claude.push(`<span class="sb-chip sb-duration"><i class="ph ph-timer"></i>${MOCK.duration}</span>`);

  if (git.length === 0 && claude.length === 0)
    return `<span class="sb-empty">No fields</span>`;

  const sep = git.length > 0 && claude.length > 0 ? `<span class="sb-sep"></span>` : "";
  return [...git, ...(sep ? [sep] : []), ...claude].join("");
}

function template(fields: string[]) {
  return html`
    <div class="view view-settings-statusline">
      <div class="view-header">
        <button class="icon-btn back-to-settings" title="Back">←</button>
        <h2>Statusline</h2>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">

        <div class="section sl-section">
          <div class="section-title">Preview</div>
          <div class="sl-preview-wrap">
            <div class="sl-preview-chrome">my-project — active session</div>
            <div class="sl-preview-bar sl-preview-bar-live">
              ${fields.length > 0
                ? html`<div class="sb-chips" style="flex:1;display:flex;align-items:center;gap:4px;overflow:hidden;" .innerHTML=${previewChips(fields)}></div>`
                : html`<span class="sb-empty">No fields selected</span>`}
            </div>
            <div class="sl-preview-body">
              <span class="sl-preview-body-hint">chat messages</span>
            </div>
          </div>
        </div>

        <div class="section sl-section">
          <div class="section-title">Fields</div>
          <div class="sl-fields">
            ${ALL_STATUSLINE_FIELDS.map(({ key, label }) => html`
              <label class="sl-field-row">
                <input type="checkbox" data-key="${key}" ?checked=${fields.includes(key)}>
                ${label}
              </label>
            `)}
          </div>
        </div>

        <div class="section">
          <button class="btn-secondary" id="slResetBtn" style="font-size:0.8rem;">Reset to defaults</button>
        </div>

      </div>
    </div>
  `;
}

export async function renderStatuslineView(root: HTMLElement): Promise<() => void> {
  let fields = await loadStatuslineFields();

  function rerender(): void {
    render(template(fields), root);
    wire(root);
  }

  rerender();

  return () => {};
}

function wire(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>(".back-to-settings")!.onclick = () => g().navigateTo("settings");

  root.querySelectorAll<HTMLInputElement>(".sl-field-row input").forEach((cb) => {
    cb.addEventListener("change", () => {
      const key = cb.dataset.key!;
      const fields = getFields(root);
      const next = cb.checked
        ? [...fields, key].filter((k, i, a) => a.indexOf(k) === i)
        : fields.filter((k) => k !== key);
      void saveStatuslineFields(next);
      // Re-render to update preview.
      root.querySelector<HTMLElement>(".sl-preview-bar-live .sb-chips")?.remove();
      const bar = root.querySelector<HTMLElement>(".sl-preview-bar-live");
      if (bar) {
        bar.innerHTML = `<div class="sb-chips" style="flex:1;display:flex;align-items:center;gap:4px;overflow:hidden;"></div>`;
        const chips = bar.querySelector<HTMLElement>(".sb-chips");
        if (chips) chips.innerHTML = previewChips(next);
      }
    });
  });

  root.querySelector<HTMLButtonElement>("#slResetBtn")?.addEventListener("click", async () => {
    await saveStatuslineFields([...DEFAULT_STATUSLINE_FIELDS]);
    root.querySelectorAll<HTMLInputElement>(".sl-field-row input").forEach((cb) => {
      cb.checked = DEFAULT_STATUSLINE_FIELDS.includes(cb.dataset.key!);
    });
    const bar = root.querySelector<HTMLElement>(".sl-preview-bar-live");
    if (bar) {
      bar.innerHTML = `<div class="sb-chips" style="flex:1;display:flex;align-items:center;gap:4px;overflow:hidden;"></div>`;
      const chips = bar.querySelector<HTMLElement>(".sb-chips");
      if (chips) chips.innerHTML = previewChips([...DEFAULT_STATUSLINE_FIELDS]);
    }
  });
}

function getFields(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>(".sl-field-row input"))
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.key!);
}
