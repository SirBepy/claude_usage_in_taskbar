import { html, render } from "lit-html";
import "./sessions-list.css";
import { fmtK, totalTok, cacheEffPct } from "../../../../shared/tokens";
import type { TokenRecord } from "../../../../shared/tokens";
import { renderAvatar, projectLabel } from "../../../../shared/projects";
import { getProjectDetailState, getSettings, getTokenHistory } from "../../../../shared/state";
import { backFromSubview, openSessionDetail } from "../../../../shared/navigation";

export function populateProjectSubviewHeader(prefix: string): void {
  const cwd = getProjectDetailState().cwd || "";
  const settings = getSettings();
  const configured = (settings.projects || []).find((p) => p.path === cwd);
  const avatar = configured?.avatar || {
    kind: "emoji" as const,
    value: (configured?.name || cwd || "?").charAt(0),
  };
  const aliases = settings.projectAliases || {};
  const avatarEl = document.getElementById(`${prefix}Avatar`);
  const titleEl = document.getElementById(`${prefix}Title`);
  const pathEl = document.getElementById(`${prefix}Path`);
  if (avatarEl) avatarEl.innerHTML = renderAvatar(avatar);
  if (titleEl) titleEl.textContent = projectLabel(cwd, aliases);
  if (pathEl) pathEl.textContent = cwd;
}

export function renderAllSessionsList(cwd: string): void {
  const list = document.getElementById("all-sessions-list");
  const history = getTokenHistory();
  if (!list || !history) return;
  const aliases = getSettings().projectAliases || {};
  const mergedPaths = aliases[cwd]?.mergedPaths || [];
  const allCwds = new Set([cwd, ...mergedPaths]);
  const records = history.filter((r) => r.cwd && allCwds.has(r.cwd) && totalTok(r) > 0);
  if (!records.length) {
    list.innerHTML = `<div class="no-data">No sessions.</div>`;
    return;
  }
  const sorted = [...records].sort((a, b) =>
    (((a as { date?: string }).date ?? "") < ((b as { date?: string }).date ?? "") ? 1 : -1),
  );
  const rowsHTML = sorted.map((r, i) => {
    const tot = totalTok(r);
    const eff = cacheEffPct(r);
    const date = (r as { date?: string }).date ?? "";
    const turns = (r as TokenRecord).turns || 0;
    return `<div class="today-row session-row" data-session-idx="${i}" style="cursor:pointer">
      <span style="font-family:'Fira Code',monospace;font-size:0.75rem;color:var(--text-dim)">${date}</span>
      <span style="font-family:'Fira Code',monospace;font-size:0.75rem">${fmtK(tot)} tok · ${turns} turns${eff > 0 ? ` · ${eff}% cache` : ""}</span>
    </div>`;
  }).join("");
  list.innerHTML = rowsHTML;
  list.querySelectorAll<HTMLElement>(".session-row").forEach((el) => {
    el.onclick = () => {
      const idx = Number(el.dataset.sessionIdx);
      openSessionDetail(sorted[idx], "project-sessions");
    };
  });
}

(window as unknown as { renderAllSessionsList?: (cwd: string) => void }).renderAllSessionsList =
  renderAllSessionsList;

export async function renderSessionsListView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  populateProjectSubviewHeader("allSessions");

  const backBtn = root.querySelector<HTMLButtonElement>("#allSessionsBackBtn");
  if (backBtn) backBtn.onclick = () => backFromSubview();

  const cwd = getProjectDetailState().cwd;
  if (cwd) {
    try {
      renderAllSessionsList(cwd);
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
