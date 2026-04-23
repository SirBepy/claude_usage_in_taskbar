import { html, render } from "lit-html";
import "./folder-mapping.css";

interface LegacyGlobals {
  projectDetailState: { cwd: string | null };
  backFromSubview(): void;
  populateProjectSubviewHeader(prefix: string): void;
  wireFolderMappingSubview(cwd: string): void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

export async function renderFolderMappingView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  g().populateProjectSubviewHeader("folderMapping");

  const backBtn = root.querySelector<HTMLButtonElement>("#folderMappingBackBtn");
  if (backBtn) backBtn.onclick = () => g().backFromSubview();

  const cwd = g().projectDetailState?.cwd;
  if (cwd) {
    try {
      g().wireFolderMappingSubview(cwd);
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
