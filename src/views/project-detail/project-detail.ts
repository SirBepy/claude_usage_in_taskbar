import { html, render } from "lit-html";
import "./project-detail.css";
import { fmtK, totalTok, cacheEffPct, formatCompactTokens } from "../../shared/tokens";
import type { TokenRecord } from "../../shared/tokens";
import { projectLabel, renderAvatar } from "../../shared/projects";
import { resolveMergeChain, doMerge } from "../../shared/merges";
import { uptimeFrom } from "../../shared/time";
import {
  getSettings,
  getTokenHistory,
  getProjectDetailState,
  getProjectSubviewStack,
} from "../../shared/state";
import type { ProjectConfig } from "../../shared/state";
import {
  showView,
  openProjectSubview,
  openSessionDetail,
  openAllSessions,
  showMergeModal,
} from "../../shared/navigation";
import { saveSettings } from "../../shared/settings-save";
import { refreshProjectsUI } from "../projects/projects";

interface Instance {
  session_id: string;
  pid: number;
  started_at: string;
  cwd: string;
  end_reason?: string | null;
  is_remote?: boolean;
  kind?: string;
}

interface InstanceStats {
  tokens?: number;
  turns?: number;
  prompts?: number;
}

interface LegacyGlobals {
  electronAPI?: {
    listProjects(): Promise<ProjectConfig[]>;
    listInstancesForProject(id: string): Promise<Instance[]>;
    instanceTokenStats(sid: string): Promise<InstanceStats>;
    openInExplorer(p: string): Promise<unknown>;
    openInVSCode(p: string): Promise<unknown>;
    saveSettings(s: unknown): Promise<unknown>;
    onInstancesChanged(cb: () => void): () => void;
  };
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function fmtTokens(n: number): string {
  return formatCompactTokens(n);
}

function instanceRowHtml(i: Instance, stats: InstanceStats | undefined): string {
  const uptime = uptimeFrom(i.started_at);
  const tokens = stats?.tokens ?? 0;
  const turns = stats?.turns ?? 0;
  const prompts = stats?.prompts ?? 0;
  const pidPart = i.pid > 0 ? `pid ${i.pid}` : "no pid";
  return `
    <div class="instance-row clickable" data-session-id="${i.session_id}">
      <div class="status-dot"></div>
      <div class="row-line">${pidPart} · up ${uptime} · ${prompts} ${prompts === 1 ? "msg" : "msgs"} · ${fmtTokens(tokens)} tokens · ${turns} ${turns === 1 ? "turn" : "turns"}</div>
      <span class="chev">›</span>
    </div>
  `;
}

function setRunningInstancesEmpty(count: number): void {
  const c = document.getElementById("runningInstancesCount");
  const listEl = document.getElementById("runningInstancesList");
  const emptyEl = document.getElementById("runningInstancesEmpty");
  if (c) c.textContent = String(count);
  if (listEl) listEl.style.display = "none";
  if (emptyEl) emptyEl.style.display = "block";
}

async function renderRunningInstances(): Promise<void> {
  const cwd = getProjectDetailState().cwd;
  if (!cwd) return;
  const api = g().electronAPI;
  if (!api) return;
  const projects = await api.listProjects();
  const proj = projects.find((p) => p.path === cwd);
  if (!proj) {
    setRunningInstancesEmpty(0);
    return;
  }
  const instances = (await api.listInstancesForProject(proj.id))
    .filter((i) => !i.end_reason);
  const count = instances.length;

  const countEl = document.getElementById("runningInstancesCount");
  if (countEl) countEl.textContent = String(count);
  const listEl = document.getElementById("runningInstancesList");
  const emptyEl = document.getElementById("runningInstancesEmpty");
  if (!listEl || !emptyEl) return;
  if (count === 0) {
    listEl.style.display = "none";
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";
  listEl.style.display = "block";

  const stats = await Promise.all(
    instances.map((i) => api.instanceTokenStats(i.session_id)),
  );
  listEl.innerHTML = instances.map((i, idx) => instanceRowHtml(i, stats[idx])).join("");
  listEl.querySelectorAll<HTMLElement>(".instance-row").forEach((row) => {
    const sid = row.dataset.sessionId;
    const inst = instances.find((x) => x.session_id === sid);
    if (!inst) return;
    row.onclick = () => {
      openSessionDetail(inst, "project-detail");
    };
  });
}

function setHeader(cwd: string): void {
  const settings = getSettings();
  const configured = (settings.projects || []).find((p) => p.path === cwd);
  const avatar = configured?.avatar || {
    kind: "emoji" as const,
    value: (configured?.name || cwd || "?").charAt(0),
  };
  const aliases = settings.projectAliases || {};
  const avatarEl = document.getElementById("projectDetailAvatar");
  const pathEl = document.getElementById("projectDetailHeaderPath");
  const titleEl = document.getElementById("projectDetailTitle");
  if (avatarEl) avatarEl.innerHTML = renderAvatar(avatar);
  if (pathEl) pathEl.textContent = cwd || "";
  if (titleEl) titleEl.textContent = projectLabel(cwd, aliases);
}

function wireTitleRename(cwd: string): void {
  const title = document.getElementById("projectDetailTitle") as HTMLElement | null;
  const titleInput = document.getElementById("projectDetailTitleInput") as HTMLInputElement | null;
  if (!title || !titleInput) return;

  title.onclick = () => {
    titleInput.value = projectLabel(cwd, getSettings().projectAliases || {});
    title.style.display = "none";
    titleInput.style.display = "";
    titleInput.focus();
    titleInput.select();
  };

  const commitRename = () => {
    const name = titleInput.value.trim();
    titleInput.style.display = "none";
    title.style.display = "";
    if (!name) return;
    const settings = getSettings();
    if (!settings.projectAliases) settings.projectAliases = {};
    const aliases = settings.projectAliases;
    const primaryCwds = new Set<string>();
    const hist = getTokenHistory();
    if (hist) {
      for (const r of hist) {
        if (!r.cwd) continue;
        primaryCwds.add(resolveMergeChain(r.cwd, aliases));
      }
    }
    for (const [c, a] of Object.entries(aliases)) {
      if (a && !a.mergedInto) primaryCwds.add(c);
    }
    let collisionCwd: string | null = null;
    for (const existingCwd of primaryCwds) {
      if (existingCwd === cwd) continue;
      if (projectLabel(existingCwd, aliases) === name) {
        collisionCwd = existingCwd;
        break;
      }
    }
    if (collisionCwd) {
      showMergeModal(
        `"${name}" already exists. Merge this project into it?`,
        () => {
          doMerge(aliases, cwd, collisionCwd as string);
          saveSettings();
          refreshProjectsUI();
          openProjectDetailAgain(collisionCwd as string);
        },
        () => {
          title.style.display = "none";
          titleInput.style.display = "";
          titleInput.focus();
          titleInput.select();
        },
      );
    } else {
      aliases[cwd] = { ...aliases[cwd], name };
      saveSettings();
      title.textContent = projectLabel(cwd, aliases);
      refreshProjectsUI();
    }
  };

  titleInput.onblur = commitRename;
  titleInput.onkeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      titleInput.blur();
    }
    if (e.key === "Escape") {
      titleInput.value = projectLabel(cwd, getSettings().projectAliases || {});
      titleInput.blur();
    }
  };
}

function openProjectDetailAgain(cwd: string): void {
  const s = getProjectDetailState();
  s.cwd = cwd;
  s.offset = 0;
  showView("project-detail");
}

export async function renderProjectDetailView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const cwd = getProjectDetailState().cwd;
  if (!cwd) {
    return () => { /* nothing */ };
  }

  setHeader(cwd);
  wireTitleRename(cwd);

  // Back
  const backBtn = root.querySelector<HTMLButtonElement>("#projectDetailBackBtn");
  if (backBtn) {
    backBtn.onclick = () => {
      getProjectSubviewStack().length = 0;
      showView("projects");
    };
  }

  // 3-dot menu
  const menuBtn = root.querySelector<HTMLButtonElement>("#projectDetailMenuBtn");
  const menu = root.querySelector<HTMLElement>("#projectDetailMenu");
  const onDocClick = (e: MouseEvent) => {
    if (!menu) return;
    if (menu.classList.contains("hidden")) return;
    const target = e.target as Node;
    if (menu.contains(target) || menuBtn?.contains(target)) return;
    menu.classList.add("hidden");
  };
  if (menuBtn && menu) {
    menuBtn.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      menu.classList.toggle("hidden");
    };
    menu.querySelectorAll<HTMLButtonElement>(".menu-item").forEach((btn) => {
      btn.onclick = () => {
        menu.classList.add("hidden");
        const kind = btn.dataset.menuItem;
        if (kind === "notif-overrides") openProjectSubview("project-notif-overrides");
        else if (kind === "automation") openProjectSubview("project-automation");
        else if (kind === "folder-mapping") openProjectSubview("project-folder-mapping");
      };
    });
    document.addEventListener("click", onDocClick);
  }

  // Explorer / VSCode
  const explorerBtn = root.querySelector<HTMLButtonElement>("#openExplorerBtn");
  const vscodeBtn = root.querySelector<HTMLButtonElement>("#openVSCodeBtn");
  if (explorerBtn) explorerBtn.onclick = () => g().electronAPI?.openInExplorer(cwd);
  if (vscodeBtn) vscodeBtn.onclick = () => g().electronAPI?.openInVSCode(cwd);

  // Range btns
  root.querySelectorAll<HTMLButtonElement>(".range-btn").forEach((btn) => {
    btn.onclick = () => {
      const s = getProjectDetailState();
      s.range = btn.dataset.range || "30d";
      s.offset = 0;
      renderProjectDetailContent();
    };
  });
  const prev = root.querySelector<HTMLButtonElement>("#chartPrevBtn");
  const next = root.querySelector<HTMLButtonElement>("#chartNextBtn");
  if (prev) prev.onclick = () => {
    getProjectDetailState().offset++;
    renderProjectDetailContent();
  };
  if (next) next.onclick = () => {
    const s = getProjectDetailState();
    s.offset = Math.max(0, s.offset - 1);
    renderProjectDetailContent();
  };

  // Render content
  try {
    renderProjectDetailContent();
  } catch (e) {
    console.error("[project-detail] renderProjectDetailContent failed", e);
  }
  void renderRunningInstances();

  const api = g().electronAPI;
  const unsub = api?.onInstancesChanged(() => {
    void renderRunningInstances();
  });

  return () => {
    try { unsub?.(); } catch { /* ignore */ }
    document.removeEventListener("click", onDocClick);
  };
}

// ── Content renderers (ported from src/modules/stats.js) ─────────────────────

export function renderProjectDetailContent(): void {
  const { cwd, range, offset } = getProjectDetailState();
  const chartContainer = document.getElementById("project-chart-container");
  const history = getTokenHistory();
  if (!chartContainer || !history || !cwd) return;

  const settings = getSettings();
  const aliases = settings.projectAliases || {};

  const avatarEl = document.getElementById("projectDetailAvatar");
  const pathEl = document.getElementById("projectDetailHeaderPath");
  if (avatarEl && pathEl) {
    const configured = (settings.projects || []).find((p) => p.path === cwd);
    avatarEl.innerHTML = renderAvatar(
      configured?.avatar || {
        kind: "emoji",
        value: (configured?.name || cwd || "?").charAt(0),
      },
    );
    pathEl.textContent = cwd;
  }

  document.querySelectorAll<HTMLButtonElement>(".range-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === range);
  });

  const mergedPaths = aliases[cwd]?.mergedPaths || [];
  const allCwds = new Set([cwd, ...mergedPaths]);
  let records = history.filter((r) => r.cwd && allCwds.has(r.cwd));
  if (range !== "all") {
    const days = range === "7d" ? 7 : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    records = records.filter((r) => ((r as { date?: string }).date ?? "") >= cutoffStr);
  }

  const byDate = new Map<string, number>();
  for (const r of records) {
    const d = (r as { date?: string }).date || "unknown";
    byDate.set(d, (byDate.get(d) || 0) + totalTok(r));
  }

  const sortedDays = Array.from(byDate.entries())
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const prevBtn = document.getElementById("chartPrevBtn") as HTMLButtonElement | null;
  const nextBtn = document.getElementById("chartNextBtn") as HTMLButtonElement | null;

  if (!sortedDays.length) {
    chartContainer.innerHTML = `<div class="no-data">No activity in this period</div>`;
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    renderSessionsList(cwd, range);
    return;
  }

  const BARS = 10;
  const endIdx = sortedDays.length - offset * BARS;
  const startIdx = Math.max(0, endIdx - BARS);
  const visible = sortedDays.slice(startIdx, endIdx);

  if (prevBtn) prevBtn.disabled = startIdx === 0;
  if (nextBtn) nextBtn.disabled = offset === 0;

  chartContainer.innerHTML = buildBarChartSVG(visible);
  renderSessionsList(cwd, range);
}

export function buildBarChartSVG(days: Array<{ date: string; tokens: number }>): string {
  if (!days.length) return `<div class="no-data">No data</div>`;

  const W = 420, H = 160;
  const ML = 40, MR = 8, MT = 8, MB = 36;
  const PW = W - ML - MR;
  const PH = H - MT - MB;

  const maxTok = Math.max(...days.map((d) => d.tokens), 1);
  const spacing = PW / days.length;
  const barW = Math.max(4, spacing - 3);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    const val = frac * maxTok;
    const y = MT + (1 - frac) * PH;
    return `<line x1="${ML}" x2="${W - MR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2d2c44" stroke-width="1"/>
      <text x="${ML - 4}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="#6b6990" font-size="9" font-family="Fira Code,monospace">${fmtK(Math.round(val))}</text>`;
  }).join("");

  const bars = days.map((d, i) => {
    const x = ML + i * spacing + (spacing - barW) / 2;
    const barH = Math.max(1, (d.tokens / maxTok) * PH);
    const y = MT + PH - barH;
    const label = d.date.slice(5);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="#9d7dfc" opacity="0.85"/>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(H - MB + 14).toFixed(1)}" text-anchor="middle" fill="#6b6990" font-size="9" font-family="DM Sans,system-ui">${label}</text>`;
  }).join("");

  return `<div class="chart-container"><svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
    ${yTicks}
    <line x1="${ML}" x2="${ML}" y1="${MT}" y2="${MT + PH}" stroke="#2d2c44" stroke-width="1"/>
    ${bars}
  </svg></div>`;
}

function renderSessionsList(cwd: string, range: string): void {
  const list = document.getElementById("project-sessions-list");
  const history = getTokenHistory();
  if (!list || !history) return;

  const aliases = getSettings().projectAliases || {};
  const mergedPaths = aliases[cwd]?.mergedPaths || [];
  const allCwds = new Set([cwd, ...mergedPaths]);
  let records = history.filter((r) => r.cwd && allCwds.has(r.cwd));
  if (range !== "all") {
    const days = range === "7d" ? 7 : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    records = records.filter((r) => ((r as { date?: string }).date ?? "") >= cutoffStr);
  }
  records = records.filter((r) => totalTok(r) > 0);

  if (!records.length) { list.innerHTML = ""; return; }

  const sorted = [...records].sort((a, b) =>
    (((a as { date?: string }).date ?? "") < ((b as { date?: string }).date ?? "") ? 1 : -1),
  );
  const top = sorted.slice(0, 5);
  const rowsHTML = top.map((r, i) => {
    const tot = totalTok(r);
    const eff = cacheEffPct(r);
    const date = (r as { date?: string }).date ?? "";
    const turns = (r as TokenRecord).turns || 0;
    return `<div class="today-row session-row" data-session-idx="${i}" style="cursor:pointer">
      <span style="font-family:'Fira Code',monospace;font-size:0.75rem;color:var(--text-dim)">${date}</span>
      <span style="font-family:'Fira Code',monospace;font-size:0.75rem">${fmtK(tot)} tok · ${turns} turns${eff > 0 ? ` · ${eff}% cache` : ""}</span>
    </div>`;
  }).join("");
  const seeAll = sorted.length > 5
    ? `<button class="see-all-link" id="seeAllSessionsBtn">See all ${sorted.length} sessions</button>`
    : "";
  list.innerHTML = `<div class="section" style="padding:10px 14px">
    <div class="section-title" style="margin-bottom:8px">Recent sessions</div>
    ${rowsHTML}
    ${seeAll}
  </div>`;

  list.querySelectorAll<HTMLElement>(".session-row").forEach((el) => {
    el.onclick = () => {
      const idx = Number(el.dataset.sessionIdx);
      openSessionDetail(top[idx]);
    };
  });
  const seeAllBtn = list.querySelector<HTMLButtonElement>("#seeAllSessionsBtn");
  if (seeAllBtn) seeAllBtn.onclick = () => {
    openAllSessions(cwd);
  };
}

// Export for legacy call sites (folder-mapping/merge handlers still in dashboard.js)
// until those views own the call.
(window as unknown as { renderProjectDetail?: () => void }).renderProjectDetail =
  renderProjectDetailContent;

function template() {
  return html`
    <div class="view view-project-detail">
      <div class="view-header project-detail-header">
        <button class="icon-btn" id="projectDetailBackBtn" title="Back">
          <i class="ph ph-arrow-left"></i>
        </button>
        <div class="project-detail-heading">
          <div class="avatar-mini" id="projectDetailAvatar">?</div>
          <div class="project-detail-titles">
            <h2 id="projectDetailTitle" style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" title="Click to rename">Project</h2>
            <input id="projectDetailTitleInput" type="text" style="display:none;flex:1;font-weight:600;font-size:0.88rem">
            <div class="project-detail-path" id="projectDetailHeaderPath"></div>
          </div>
        </div>
        <div class="menu-anchor">
          <button class="icon-btn" id="projectDetailMenuBtn" title="Project menu">
            <i class="ph ph-dots-three-vertical"></i>
          </button>
          <div id="projectDetailMenu" class="menu-popover hidden" role="menu">
            <button class="menu-item" data-menu-item="notif-overrides" role="menuitem">Notification overrides</button>
            <button class="menu-item" data-menu-item="automation" role="menuitem">Automation</button>
            <button class="menu-item" data-menu-item="folder-mapping" role="menuitem">Folder mapping</button>
          </div>
        </div>
      </div>
      <div class="view-body">
        <section class="instances-section" id="runningInstancesSection">
          <div class="section-title">Running instances <span id="runningInstancesCount" class="count-pill">0</span></div>
          <div id="runningInstancesEmpty" class="no-data">No Claude Code instances running in this project.</div>
          <div id="runningInstancesList" style="display:none"></div>
        </section>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="range-toggle">
            <button class="range-btn" data-range="7d">7d</button>
            <button class="range-btn active" data-range="30d">30d</button>
            <button class="range-btn" data-range="all">All</button>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn-secondary" id="chartPrevBtn" style="padding:3px 10px;font-size:0.75rem">◀</button>
            <button class="btn-secondary" id="chartNextBtn" style="padding:3px 10px;font-size:0.75rem">▶</button>
          </div>
        </div>
        <div id="project-chart-container"></div>
        <div id="project-sessions-list" style="margin-top:12px"></div>
        <div style="padding:4px 0 8px">
          <div class="section-title" style="margin-bottom:8px;font-size:0.72rem">Open project</div>
          <div style="display:flex;gap:8px">
            <button class="btn-secondary" id="openExplorerBtn" style="flex:1;font-size:0.8rem">File Explorer</button>
            <button class="btn-secondary" id="openVSCodeBtn" style="flex:1;font-size:0.8rem">VSCode</button>
          </div>
        </div>
      </div>
    </div>
  `;
}
