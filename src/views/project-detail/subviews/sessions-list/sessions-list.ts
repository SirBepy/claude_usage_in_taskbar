import { html, render } from "lit-html";
import "./sessions-list.css";

interface LegacyGlobals {
  projectDetailState: { cwd: string | null };
  backFromSubview(): void;
  populateProjectSubviewHeader(prefix: string): void;
  renderAllSessionsList(cwd: string): void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

export async function renderSessionsListView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  g().populateProjectSubviewHeader("allSessions");

  const backBtn = root.querySelector<HTMLButtonElement>("#allSessionsBackBtn");
  if (backBtn) backBtn.onclick = () => g().backFromSubview();

  const cwd = g().projectDetailState?.cwd;
  if (cwd) {
    try {
      g().renderAllSessionsList(cwd);
    } catch (e) {
      console.error("[sessions-list] render failed", e);
    }
  }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-project-sessions">
      <div class="view-header subview-header">
        <button class="icon-btn" id="allSessionsBackBtn" title="Back"><i class="ph ph-arrow-left"></i></button>
        <div class="project-detail-heading">
          <div class="avatar-mini" id="allSessionsAvatar">?</div>
          <div class="project-detail-titles">
            <h2 id="allSessionsTitle" style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Project</h2>
            <div class="project-detail-path" id="allSessionsPath"></div>
          </div>
        </div>
        <div style="width:32px"></div>
      </div>
      <div class="view-body">
        <div class="section" style="margin-top:12px">
          <div class="section-title">All sessions</div>
          <div id="all-sessions-list"></div>
        </div>
      </div>
    </div>
  `;
}
