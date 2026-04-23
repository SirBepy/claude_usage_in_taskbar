import { html, render } from "lit-html";
import "./folder-mapping.css";
import { getProjectDetailState, getProjectSubviewStack, getSettings, getTokenHistory } from "../../../../shared/state";
import { projectLabel } from "../../../../shared/projects";
import { doRepoint, doUnmerge, resolveMergeChain } from "../../../../shared/merges";
import { populateProjectSubviewHeader } from "../sessions-list/sessions-list";
import { renderProjectDetailContent } from "../../project-detail";

interface ElectronAPIShape {
  checkPathsExist(paths: string[]): Promise<Record<string, boolean>>;
  saveSettings(s: unknown): Promise<unknown>;
}

interface LegacyGlobals {
  electronAPI?: ElectronAPIShape;
  showView(name: string): void;
  backFromSubview(): void;
  showMergeModal(
    msg: string,
    onOk: () => void,
    onCancel?: (() => void) | null,
    okLabel?: string,
  ): void;
  saveSettings?(): void;
  refreshProjectsUI?(): void;
  openProjectDetail?(cwd: string): void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function openProjectDetail(cwd: string): void {
  const fn = g().openProjectDetail;
  if (typeof fn === "function") {
    fn(cwd);
    return;
  }
  const s = getProjectDetailState();
  s.cwd = cwd;
  s.offset = 0;
  g().showView("project-detail");
}

function doHideProject(cwd: string): void {
  const settings = getSettings();
  if (!settings.projectBlacklist) settings.projectBlacklist = [];
  const aliases = settings.projectAliases || {};
  const resolved = resolveMergeChain(cwd, aliases);
  if (!settings.projectBlacklist.includes(resolved)) {
    settings.projectBlacklist.push(resolved);
  }
  g().saveSettings?.();
}

export function renderMergedPathsSection(cwd: string): void {
  const el = document.getElementById("project-merged-paths");
  if (!el) return;
  const aliases = getSettings().projectAliases || {};
  const mergedPaths = aliases[cwd]?.mergedPaths || [];
  if (!mergedPaths.length) { el.innerHTML = ""; return; }
  const rows = mergedPaths.map((p) => `
    <div class="merged-path-row">
      <span class="merged-path-text" title="${p}">${p}</span>
      <button class="btn-secondary unmerge-btn" data-path="${p}" style="padding:2px 8px;font-size:0.7rem;flex-shrink:0">Unmerge</button>
    </div>`).join("");
  el.innerHTML = `<div class="section" style="padding:8px 14px;margin-top:0">
    <div class="section-title" style="font-size:0.72rem;margin-bottom:6px">Merged Paths</div>
    ${rows}
  </div>`;
  el.querySelectorAll<HTMLButtonElement>(".unmerge-btn").forEach((btn) => {
    btn.onclick = () => {
      const path = btn.dataset.path;
      if (!path) return;
      doUnmerge(aliases, path, cwd);
      g().saveSettings?.();
      renderMergedPathsSection(cwd);
      renderProjectDetailContent();
      g().refreshProjectsUI?.();
    };
  });
}

export function wireFolderMappingSubview(cwd: string): void {
  const pathEl = document.getElementById("projectDetailPath") as HTMLElement | null;
  const pathInput = document.getElementById("projectDetailPathInput") as HTMLInputElement | null;
  const pathError = document.getElementById("projectDetailPathError") as HTMLElement | null;
  const hideBtn = document.getElementById("hideProjectBtn") as HTMLButtonElement | null;

  if (pathEl) {
    pathEl.textContent = cwd || "";
    pathEl.style.display = "";
  }
  if (pathInput) pathInput.style.display = "none";
  if (pathError) { pathError.style.display = "none"; pathError.textContent = ""; }

  if (pathEl && pathInput) {
    pathEl.onclick = () => {
      pathInput.value = cwd || "";
      pathEl.style.display = "none";
      pathInput.style.display = "";
      if (pathError) { pathError.style.display = "none"; pathError.textContent = ""; }
      pathInput.focus();
      pathInput.select();
    };
    const cancelRepoint = () => {
      pathInput.style.display = "none";
      pathEl.style.display = "";
      if (pathError) { pathError.style.display = "none"; pathError.textContent = ""; }
    };
    const commitRepoint = async () => {
      const newCwd = pathInput.value.trim();
      if (!newCwd || newCwd === cwd) { cancelRepoint(); return; }
      const showErr = (msg: string) => {
        if (!pathError) return;
        pathError.textContent = msg;
        pathError.style.display = "block";
      };
      const settings = getSettings();
      const aliases = settings.projectAliases || {};
      const existingAlias = aliases[newCwd];
      if (existingAlias?.mergedInto) { showErr("Target is already merged into another project."); return; }
      const history = getTokenHistory();
      const targetUsed = history?.some((r) => r.cwd === newCwd);
      if (targetUsed) { showErr("Target folder is already a tracked project. Rename to merge instead."); return; }
      try {
        const existsMap = await g().electronAPI?.checkPathsExist([newCwd]);
        if (!existsMap || !existsMap[newCwd]) { showErr("Folder does not exist on disk."); return; }
      } catch (e) { showErr("Could not verify folder: " + (e as Error).message); return; }
      if (!settings.projectAliases) settings.projectAliases = {};
      doRepoint(settings.projectAliases, cwd, newCwd);
      g().saveSettings?.();
      g().refreshProjectsUI?.();
      getProjectSubviewStack().length = 0;
      openProjectDetail(newCwd);
    };
    pathInput.onblur = () => {
      setTimeout(() => { if (pathInput.style.display !== "none") void commitRepoint(); }, 0);
    };
    pathInput.onkeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); void commitRepoint(); }
      if (e.key === "Escape") { e.preventDefault(); cancelRepoint(); }
    };
  }

  if (hideBtn) {
    hideBtn.onclick = () => {
      const aliases = getSettings().projectAliases || {};
      g().showMergeModal(
        `Hide "${projectLabel(cwd, aliases)}" from the list? You can unhide it later in settings.`,
        () => {
          doHideProject(cwd);
          g().refreshProjectsUI?.();
          getProjectSubviewStack().length = 0;
          g().showView("projects");
        },
        null,
        "Hide",
      );
    };
  }

  renderMergedPathsSection(cwd);
}

(window as unknown as { wireFolderMappingSubview?: (cwd: string) => void }).wireFolderMappingSubview =
  wireFolderMappingSubview;

export async function renderFolderMappingView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  populateProjectSubviewHeader("folderMapping");

  const backBtn = root.querySelector<HTMLButtonElement>("#folderMappingBackBtn");
  if (backBtn) backBtn.onclick = () => g().backFromSubview();

  const cwd = getProjectDetailState().cwd;
  if (cwd) {
    try {
      wireFolderMappingSubview(cwd);
    } catch (e) {
      console.error("[folder-mapping] wire failed", e);
    }
  }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-project-folder-mapping">
      <div class="view-header subview-header">
        <button class="icon-btn" id="folderMappingBackBtn" title="Back"><i class="ph ph-arrow-left"></i></button>
        <div class="project-detail-heading">
          <div class="avatar-mini" id="folderMappingAvatar">?</div>
          <div class="project-detail-titles">
            <h2 id="folderMappingTitle" style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Project</h2>
            <div class="project-detail-path" id="folderMappingPath"></div>
          </div>
        </div>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="section" style="margin-top:12px">
          <div class="section-title">Current folder</div>
          <div id="projectDetailPath" style="padding:6px 0;font-size:0.72rem;color:var(--text-dim);font-family:'Fira Code',monospace;word-break:break-all;cursor:pointer" title="Click to repoint to a different folder"></div>
          <input id="projectDetailPathInput" type="text" style="display:none;width:100%;font-size:0.72rem;font-family:'Fira Code',monospace;margin:4px 0;padding:4px 6px">
          <div id="projectDetailPathError" style="display:none;font-size:0.68rem;color:var(--danger, #e74c3c);margin:2px 0 6px"></div>
        </div>
        <div id="project-merged-paths"></div>
        <div class="section" style="margin-top:12px">
          <button class="btn-danger" id="hideProjectBtn" style="width:100%;font-size:0.8rem">Hide from list</button>
        </div>
      </div>
    </div>
  `;
}
