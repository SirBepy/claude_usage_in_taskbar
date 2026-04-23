import { html, render } from "lit-html";
import "./project-detail.css";

interface Avatar {
  kind?: string;
  value?: string;
}

interface ProjectConfig {
  id: string;
  path: string;
  name?: string;
  avatar?: Avatar;
  automation?: { enabled?: boolean } | null;
}

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

interface TokenRecord {
  cwd?: string;
  [k: string]: unknown;
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
  projectDetailState: { cwd: string | null; range: string; offset: number };
  projectSubviewStack: string[];
  currentSettings: {
    projects?: ProjectConfig[];
    projectAliases?: Record<string, { name?: string; mergedInto?: string; mergedPaths?: string[] }>;
  };
  lastTokenHistory?: TokenRecord[] | null;
  projectLabel(cwd: string): string;
  renderAvatar(a: Avatar | undefined): string;
  renderProjectDetail(): void;
  showView(name: string): void;
  openProjectSubview(name: string): void;
  openSessionDetail?(inst: Instance, origin?: string): void;
  saveSettings?(): void;
  showMergeModal(
    msg: string,
    onOk: () => void,
    onCancel?: (() => void) | null,
    okLabel?: string,
  ): void;
  resolveMergeChain?(cwd: string, aliases: Record<string, unknown>): string;
  doMerge?(from: string, to: string): void;
  refreshProjectsUI?(): void;
}

function g(): LegacyGlobals {
  return window as unknown as LegacyGlobals;
}

function fmtTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function uptimeFrom(iso: string): string {
  const start = new Date(iso).getTime();
  const delta = Math.max(0, Date.now() - start);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
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
  const cwd = g().projectDetailState?.cwd;
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
      const fn = g().openSessionDetail;
      if (typeof fn === "function") fn(inst, "project-detail");
    };
  });
}

function setHeader(cwd: string): void {
  const settings = g().currentSettings || {};
  const configured = (settings.projects || []).find((p) => p.path === cwd);
  const avatar = configured?.avatar || {
    kind: "emoji",
    value: (configured?.name || cwd || "?").charAt(0),
  };
  const avatarEl = document.getElementById("projectDetailAvatar");
  const pathEl = document.getElementById("projectDetailHeaderPath");
  const titleEl = document.getElementById("projectDetailTitle");
  if (avatarEl) avatarEl.innerHTML = g().renderAvatar(avatar);
  if (pathEl) pathEl.textContent = cwd || "";
  if (titleEl) titleEl.textContent = g().projectLabel(cwd);
}

function wireTitleRename(cwd: string): void {
  const title = document.getElementById("projectDetailTitle") as HTMLElement | null;
  const titleInput = document.getElementById("projectDetailTitleInput") as HTMLInputElement | null;
  if (!title || !titleInput) return;

  title.onclick = () => {
    titleInput.value = g().projectLabel(cwd);
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
    const settings = g().currentSettings;
    if (!settings.projectAliases) settings.projectAliases = {};
    const aliases = settings.projectAliases;
    const primaryCwds = new Set<string>();
    const hist = g().lastTokenHistory;
    if (hist) {
      for (const r of hist) {
        if (!r.cwd) continue;
        const resolve = g().resolveMergeChain;
        if (typeof resolve === "function") primaryCwds.add(resolve(r.cwd, aliases as Record<string, unknown>));
        else primaryCwds.add(r.cwd);
      }
    }
    for (const [c, a] of Object.entries(aliases)) {
      if (a && !a.mergedInto) primaryCwds.add(c);
    }
    let collisionCwd: string | null = null;
    for (const existingCwd of primaryCwds) {
      if (existingCwd === cwd) continue;
      if (g().projectLabel(existingCwd) === name) {
        collisionCwd = existingCwd;
        break;
      }
    }
    if (collisionCwd) {
      g().showMergeModal(
        `"${name}" already exists. Merge this project into it?`,
        () => {
          g().doMerge?.(cwd, collisionCwd as string);
          g().refreshProjectsUI?.();
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
      g().saveSettings?.();
      title.textContent = g().projectLabel(cwd);
      g().refreshProjectsUI?.();
    }
  };

  titleInput.onblur = commitRename;
  titleInput.onkeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      titleInput.blur();
    }
    if (e.key === "Escape") {
      titleInput.value = g().projectLabel(cwd);
      titleInput.blur();
    }
  };
}

function openProjectDetailAgain(cwd: string): void {
  g().projectDetailState.cwd = cwd;
  g().projectDetailState.offset = 0;
  g().showView("project-detail");
}

export async function renderProjectDetailView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const cwd = g().projectDetailState?.cwd;
  if (!cwd) {
    return () => { /* nothing */ };
  }

  setHeader(cwd);
  wireTitleRename(cwd);

  // Back
  const backBtn = root.querySelector<HTMLButtonElement>("#projectDetailBackBtn");
  if (backBtn) {
    backBtn.onclick = () => {
      g().projectSubviewStack.length = 0;
      g().showView("projects");
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
        if (kind === "notif-overrides") g().openProjectSubview("project-notif-overrides");
        else if (kind === "automation") g().openProjectSubview("project-automation");
        else if (kind === "folder-mapping") g().openProjectSubview("project-folder-mapping");
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
      g().projectDetailState.range = btn.dataset.range || "30d";
      g().projectDetailState.offset = 0;
      g().renderProjectDetail();
    };
  });
  const prev = root.querySelector<HTMLButtonElement>("#chartPrevBtn");
  const next = root.querySelector<HTMLButtonElement>("#chartNextBtn");
  if (prev) prev.onclick = () => {
    g().projectDetailState.offset++;
    g().renderProjectDetail();
  };
  if (next) next.onclick = () => {
    g().projectDetailState.offset = Math.max(0, g().projectDetailState.offset - 1);
    g().renderProjectDetail();
  };

  // Render content
  try {
    g().renderProjectDetail();
  } catch (e) {
    console.error("[project-detail] renderProjectDetail failed", e);
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
