import { html, render } from "lit-html";
import { openSidemenu } from "../../shared/sidemenu";
import "./projects.css";
import { getTokenHistory, setTokenHistory } from "../../shared/state";
import { openProjectDetail } from "../../shared/navigation";
import { basenameProj, renderAvatar, escapeProjHtml, type Avatar } from "../../shared/projects";
import { formatTokens } from "../../shared/tokens";
import { timeAgo } from "../../shared/time";
import { api } from "../../shared/api";

interface ProjectRecord {
  id: string;
  path: string;
  name?: string;
  avatar?: Avatar;
  automation?: { enabled?: boolean } | null;
  last_active_at?: string;
}

interface Instance {
  cwd: string;
  started_at: string;
  is_remote?: boolean;
  kind?: string;
  end_reason?: string | null;
}

interface ProjectEntry {
  cwd: string;
  tokens_7d: number;
  live: number;
  anyRemote: boolean;
  anyAutomated: boolean;
  lastActiveMs: number;
  name?: string;
  avatar?: Avatar;
  projectId?: string;
}

type TokenRecordShape = {
  cwd?: string;
  inputTokens?: number;
  outputTokens?: number;
  lastActiveAt?: string;
  startedAt?: string;
};

function mkBucket(key: string): ProjectEntry {
  return {
    cwd: key,
    tokens_7d: 0,
    live: 0,
    anyRemote: false,
    anyAutomated: false,
    lastActiveMs: 0,
  };
}

function bump(bucket: ProjectEntry, iso?: string): void {
  if (!iso) return;
  const ms = Date.parse(iso);
  if (!Number.isNaN(ms) && ms > bucket.lastActiveMs) bucket.lastActiveMs = ms;
}

export function projectCardHtml(entry: ProjectEntry): string {
  const displayName = entry.name || basenameProj(entry.cwd);
  const avatar = renderAvatar(entry.avatar);
  const tokens = formatTokens(entry.tokens_7d || 0);
  const lastSeen = entry.lastActiveMs ? timeAgo(new Date(entry.lastActiveMs).toISOString()) : "";
  const tags = [
    entry.live ? `<span class="card-tag live">● ${entry.live}</span>` : "",
    entry.anyRemote ? `<span class="card-tag remote">📱</span>` : "",
    entry.anyAutomated ? `<span class="card-tag automated">⚙</span>` : "",
  ].filter(Boolean).join(" ");
  return `
    <div class="project-card" data-cwd="${escapeProjHtml(entry.cwd)}" data-project-id="${entry.projectId || ""}">
      <div class="avatar">${avatar}</div>
      <div class="body">
        <div class="name">${escapeProjHtml(displayName)}${tags ? ` <span class="card-tags">${tags}</span>` : ""}</div>
        <div class="tokens">${tokens} tokens${lastSeen ? ` · ${lastSeen}` : ""}</div>
      </div>
    </div>
  `;
}

function setupBackfillBtn(): void {
  const btn = document.getElementById("backfillBtn") as (HTMLButtonElement & { _hooked?: boolean }) | null;
  const status = document.getElementById("backfill-status");
  if (!btn || btn._hooked) return;
  btn._hooked = true;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Scanning...";
    if (status) { status.style.display = "block"; status.textContent = "This may take a while…"; }
    try {
      const result = await api.backfillTranscripts();
      const msg = result ? `Done - ${result.processed} new, ${result.skipped} skipped` : "Done";
      if (status) status.textContent = msg;
      const fresh = await api.getTokenHistory();
      setTokenHistory(fresh ?? null);
      await renderProjectsList();
    } catch (e) {
      if (status) status.textContent = "Error: " + (e as Error).message;
    } finally {
      btn.disabled = false;
      btn.textContent = "↺ Rebuild History";
    }
  };
}

// Re-exported from shared/navigation — imported at top of file.

export async function renderProjectsList(): Promise<void> {
  const tokenHistory = (getTokenHistory() as unknown as TokenRecordShape[] | null)
    || ((await api.getTokenHistory()) as unknown as TokenRecordShape[] | undefined)
    || [];
  let projects: ProjectRecord[] = [];
  try { projects = (await api.listProjects()) as unknown as ProjectRecord[]; } catch { /* ignore */ }
  let liveInstances: Instance[] = [];
  try {
    liveInstances = ((await api.listInstances()) as unknown as Instance[]).filter((i) => !i.end_reason);
  } catch { /* ignore */ }

  const byPath = new Map<string, ProjectEntry>();
  for (const rec of tokenHistory) {
    const key = rec.cwd || "(unknown)";
    const bucket = byPath.get(key) || mkBucket(key);
    bucket.tokens_7d += (rec.inputTokens || 0) + (rec.outputTokens || 0);
    bump(bucket, rec.lastActiveAt || rec.startedAt);
    byPath.set(key, bucket);
  }

  for (const p of projects) {
    const existing = byPath.get(p.path) || mkBucket(p.path);
    existing.name = p.name;
    existing.avatar = p.avatar;
    existing.projectId = p.id;
    existing.anyAutomated = existing.anyAutomated || !!p.automation?.enabled;
    bump(existing, p.last_active_at);
    byPath.set(p.path, existing);
  }

  for (const inst of liveInstances) {
    const key = inst.cwd;
    const existing = byPath.get(key) || mkBucket(key);
    existing.live = (existing.live || 0) + 1;
    existing.anyRemote = existing.anyRemote || !!inst.is_remote;
    existing.anyAutomated = existing.anyAutomated || inst.kind === "automated";
    bump(existing, inst.started_at);
    existing.lastActiveMs = Math.max(existing.lastActiveMs, Date.now());
    byPath.set(key, existing);
  }

  const settingsForSort = (await api.getSettings()) || {};
  const sortBy = (settingsForSort as { projects_sort_by?: string }).projects_sort_by || "recent";
  const nameOf = (e: ProjectEntry): string => (e.name || basenameProj(e.cwd) || "").toLowerCase();
  const entries = [...byPath.values()].sort((a, b) => {
    switch (sortBy) {
      case "name":
        return nameOf(a).localeCompare(nameOf(b));
      case "live":
        if ((b.live || 0) !== (a.live || 0)) return (b.live || 0) - (a.live || 0);
        return (b.lastActiveMs || 0) - (a.lastActiveMs || 0);
      case "tokens":
        return (b.tokens_7d || 0) - (a.tokens_7d || 0);
      case "recent":
      default:
        return (b.lastActiveMs || 0) - (a.lastActiveMs || 0);
    }
  });

  const container = document.getElementById("projects-list");
  const empty = document.getElementById("projects-empty");
  if (!container || !empty) return;
  if (entries.length === 0) {
    container.innerHTML = "";
    empty.style.display = "block";
    setupBackfillBtn();
    return;
  }
  empty.style.display = "none";

  container.innerHTML = entries.map((e) => projectCardHtml(e)).join("");
  container.querySelectorAll<HTMLElement>(".project-card").forEach((el) => {
    el.onclick = () => {
      const cwd = el.dataset.cwd;
      if (cwd) openProjectDetail(cwd);
    };
  });

  setupBackfillBtn();
}

export function refreshProjectsUI(): void {
  void renderProjectsList();
}

// Back-compat window bindings for any remaining legacy callers.
(window as unknown as { renderProjectsList?: () => Promise<void> }).renderProjectsList = renderProjectsList;
(window as unknown as { refreshProjectsUI?: () => void }).refreshProjectsUI = refreshProjectsUI;

export async function renderProjectsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  const select = root.querySelector<HTMLSelectElement>("#projectsSortSelect");
  if (select) {
    try {
      const s = (await api.getSettings()) || {};
      select.value = (s as { projects_sort_by?: string }).projects_sort_by || "recent";
    } catch { /* ignore */ }
    select.addEventListener("change", async () => {
      await api.setProjectsSortBy(select.value);
      await renderProjectsList();
    });
  }

  await renderProjectsList();

  const unsubHistory = api.onHistoryUpdated(() => { void renderProjectsList(); });
  const unsubTokens = api.onTokenHistoryUpdated(() => { void renderProjectsList(); });
  const unsubInstances = api.onInstancesChanged(() => { void renderProjectsList(); });

  return () => {
    try { unsubHistory(); } catch { /* ignore */ }
    try { unsubTokens(); } catch { /* ignore */ }
    try { unsubInstances(); } catch { /* ignore */ }
  };
}

function template() {
  return html`
    <div class="view view-projects">
      <div class="view-header">
        <button
          class="icon-btn burger"
          title="Menu"
          data-burger="true"
          @click=${openSidemenu}
        >
          <i class="ph ph-list"></i>
        </button>
        <h2>Projects</h2>
        <div class="projects-sort">
          <label for="projectsSortSelect" class="projects-sort-label">Sort by</label>
          <select id="projectsSortSelect" class="projects-sort-select">
            <option value="recent">Recently used</option>
            <option value="live">Running instances</option>
            <option value="name">Name</option>
            <option value="tokens">Tokens used</option>
          </select>
        </div>
      </div>
      <div class="view-body">
        <div id="projects-empty" class="no-data" style="display:none">
          No projects yet.
        </div>
        <div id="projects-list" class="projects-list"></div>
        <div style="margin-top:14px">
          <button
            class="btn-secondary"
            id="backfillBtn"
            style="width:100%;font-size:0.8rem"
          >
            ↺ Rebuild History
          </button>
          <div
            id="backfill-status"
            style="text-align:center;font-size:0.72rem;color:var(--text-dim);margin-top:6px;display:none"
          ></div>
        </div>
      </div>
    </div>
  `;
}
