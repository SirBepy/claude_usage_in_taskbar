import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { GitInfo } from "../../types/ipc.generated";
import { EFFORTS } from "../../shared/effort-presets";

// ── Statusline helpers ────────────────────────────────────────────────────────

export const DEFAULT_STATUSLINE_FIELDS = ["model", "effort", "branch", "repo", "context", "thinking", "messages", "turns"];

export const ALL_STATUSLINE_FIELDS = [
  { key: "branch",   label: "Branch" },
  { key: "repo",     label: "Repo" },
  { key: "folder",   label: "Project Folder" },
  { key: "model",    label: "Model" },
  { key: "effort",   label: "Effort" },
  { key: "context",  label: "Context %" },
  { key: "thinking", label: "Thinking" },
  { key: "duration", label: "Duration" },
  { key: "messages", label: "Messages" },
  { key: "turns",    label: "Turns" },
];


export async function loadStatuslineFields(): Promise<string[]> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    const v = s["statuslineFields"];
    if (Array.isArray(v)) return v as string[];
  } catch { /* ignore */ }
  return [...DEFAULT_STATUSLINE_FIELDS];
}

export async function saveStatuslineFields(fields: string[]): Promise<void> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    await invoke("save_settings", { updated: { ...s, statuslineFields: fields } });
  } catch (e) {
    console.error("[statusbar] save fields failed", e);
  }
}

export function modelContextWindow(model: string | null): number {
  // Opus (currently 4.7) has a 1M token context window; all other current
  // models use 200K. Claude Code does not emit context_window in the
  // stream-json init line, so we derive it from the model name. Accept both
  // the locked session short name ("opus") and the full stream id
  // ("claude-opus-4-7") so the denominator stays correct regardless of source.
  if (model && model.includes("opus")) return 1_000_000;
  return 200_000;
}

export function shortModelName(model: string): string {
  // "claude-opus-4-7" -> "Opus 4.7", "claude-sonnet-4-6" -> "Sonnet 4.6"
  const m = model.replace(/^claude-/, "").replace(/-(\d)/, " $1");
  return m.charAt(0).toUpperCase() + m.slice(1);
}

export function formatDuration(startedAt: string): string {
  const ms = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Cross-mount caches ───────────────────────────────────────────────────────
// Switching between chats re-creates the statusbar each time. These caches
// avoid the visible "empty bar → chips pop in" flash by keeping the last
// known values around for re-use on the next mount, while still firing a
// background refresh (stale-while-revalidate for git).

const gitInfoCache = new Map<string, GitInfo>();
const gitInflight = new Map<string, Promise<GitInfo>>();
const metaCache = new Map<string, SessionMeta>();

/** messages (= user prompts sent) and agent turns, parsed from the session
 *  transcript by the `instance_token_stats` IPC - the SAME source Project
 *  Detail > Chats uses, so the numbers always match. Cached across mounts to
 *  avoid the empty→chip flash when switching chats. */
interface SessionCounts { prompts: number; turns: number; }
const countsCache = new Map<string, SessionCounts>();

export function fetchGitInfo(cwd: string): Promise<GitInfo> {
  let p = gitInflight.get(cwd);
  if (!p) {
    p = invoke<GitInfo>("get_git_info", { cwd })
      .then((info) => { gitInfoCache.set(cwd, info); gitInflight.delete(cwd); return info; })
      .catch((e) => { gitInflight.delete(cwd); throw e; });
    gitInflight.set(cwd, p);
  }
  return p;
}

// ── SessionStatusbar ─────────────────────────────────────────────────────────

export interface StatusbarOptions {
  cwd?: string | null;
  effort?: string;
  sessionId?: string | null;
  readOnly?: boolean;
  /** Locked session model (short name e.g. "opus"). Authoritative source for
   *  the context-window denominator - meta.model can be polluted by per-turn
   *  sub-call models (internal Haiku calls), which would collapse the window. */
  sessionModel?: string | null;
}

const EMPTY_META: SessionMeta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };

export class SessionStatusbar {
  private container: HTMLElement;
  private fields: string[];
  private meta: SessionMeta = EMPTY_META;
  private gitInfo: GitInfo = { branch: null, repo: null };
  private gitInfoLoaded = false;
  private metaLoaded = false;
  private counts: SessionCounts | null = null;
  private countsLoaded = false;
  private startedAt: string | null;
  private cwd: string | null;
  private effort: string;
  private sessionId: string | null;
  private sessionModel: string | null;
  private readOnlyEffort: boolean;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private effortPopoverOpen = false;
  private modelPopoverOpen = false;
  // Tracks which chip keys have already been rendered with real data, so the
  // fade-in animation only plays the first time a chip appears - not on every
  // duration tick or popover toggle.
  private animatedKeys = new Set<string>();

  constructor(container: HTMLElement, startedAt: string | null, fields: string[], opts: StatusbarOptions = {}) {
    this.container = container;
    this.startedAt = startedAt;
    this.fields = fields;
    this.cwd = opts.cwd ?? null;
    this.effort = opts.effort ?? "";
    this.sessionId = opts.sessionId ?? null;
    this.sessionModel = opts.sessionModel ?? null;
    this.readOnlyEffort = opts.readOnly ?? false;
    this.container.className = "session-statusbar";

    // Warm from caches before first paint so revisits avoid the empty flash.
    if (this.cwd) {
      const cached = gitInfoCache.get(this.cwd);
      if (cached) { this.gitInfo = cached; this.gitInfoLoaded = true; }
    } else {
      // No cwd = no git data is ever coming; skip the skeleton entirely.
      this.gitInfoLoaded = true;
    }
    if (this.sessionId) {
      const cached = metaCache.get(this.sessionId);
      if (cached) { this.meta = cached; this.metaLoaded = true; }
      const cachedCounts = countsCache.get(this.sessionId);
      if (cachedCounts) { this.counts = cachedCounts; this.countsLoaded = true; }
    }

    this.render();
    if (this.fields.includes("duration")) this.startDurationTimer();
    if (this.wantsCounts()) void this.refreshCounts();
  }

  private wantsCounts(): boolean {
    return this.fields.includes("messages") || this.fields.includes("turns");
  }

  // Pulls message/turn counts from the transcript via the shared
  // `instance_token_stats` IPC (same source as Project Detail > Chats).
  // Fired on mount and after every completed turn (updateMeta).
  private async refreshCounts(): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    try {
      const r = await invoke<{ tokens: number; turns: number; prompts?: number }>("instance_token_stats", { sessionId: sid });
      if (this.sessionId !== sid) return; // session swapped out from under us
      this.counts = { prompts: r.prompts ?? 0, turns: r.turns ?? 0 };
      this.countsLoaded = true;
      countsCache.set(sid, this.counts);
      this.render();
    } catch { /* transient - keep last known counts */ }
  }

  updateMeta(meta: SessionMeta): void {
    this.meta = meta;
    this.metaLoaded = true;
    if (this.sessionId) metaCache.set(this.sessionId, meta);
    this.render();
    // A meta update means a turn just finished - refresh the message/turn counts.
    if (this.wantsCounts()) void this.refreshCounts();
  }

  updateGitInfo(info: GitInfo): void {
    this.gitInfo = info;
    this.gitInfoLoaded = true;
    if (this.cwd) gitInfoCache.set(this.cwd, info);
    this.render();
  }

  setSessionId(id: string): void {
    this.sessionId = id;
    const cached = countsCache.get(id);
    if (cached) { this.counts = cached; this.countsLoaded = true; }
    if (this.wantsCounts()) void this.refreshCounts();
  }

  setReadOnlyEffort(readOnly: boolean): void {
    if (this.readOnlyEffort === readOnly) return;
    this.readOnlyEffort = readOnly;
    this.render();
  }

  destroy(): void {
    if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; }
  }

  // Targeted duration-text update. Avoids a full re-render every second,
  // which would replay the fade-in animation on every chip.
  private tickDuration(): void {
    if (!this.startedAt) return;
    const el = this.container.querySelector<HTMLElement>(".sb-duration .sb-duration-text");
    if (el) el.textContent = formatDuration(this.startedAt);
  }

  private startDurationTimer(): void {
    this.durationTimer = setInterval(() => this.tickDuration(), 1000);
  }

  private skeletonChip(key: string, extraClass: string, iconClass: string, width: string): string {
    return `<span class="sb-chip sb-skeleton ${extraClass}" data-skeleton="${key}" style="min-width:${width}"><i class="ph ${iconClass}"></i><span class="sb-skel-bar"></span></span>`;
  }

  // Marks a key as "seen with real data". Returns the class fragment for the
  // chip - " sb-fadein" only on first real appearance, "" thereafter.
  private animClass(key: string): string {
    if (this.animatedKeys.has(key)) return "";
    this.animatedKeys.add(key);
    return " sb-fadein";
  }

  private render(): void {
    const f = this.fields;

    // Git group: branch, repo, folder
    const gitChips: string[] = [];
    if (f.includes("branch")) {
      if (this.gitInfo.branch) {
        gitChips.push(`<span class="sb-chip sb-branch${this.animClass("branch")}"><i class="ph ph-git-branch"></i>${escapeHtml(this.gitInfo.branch)}</span>`);
      } else if (!this.gitInfoLoaded) {
        gitChips.push(this.skeletonChip("branch", "sb-branch", "ph-git-branch", "60px"));
      }
    }
    if (f.includes("repo")) {
      if (this.gitInfo.repo) {
        gitChips.push(`<span class="sb-chip sb-repo${this.animClass("repo")}"><i class="ph ph-folder-simple"></i>${escapeHtml(this.gitInfo.repo)}</span>`);
      } else if (!this.gitInfoLoaded) {
        gitChips.push(this.skeletonChip("repo", "sb-repo", "ph-folder-simple", "80px"));
      }
    }
    if (f.includes("folder") && this.cwd) {
      const folderName = this.cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? this.cwd;
      const cwdEsc = escapeHtml(this.cwd);
      gitChips.push(`<span class="sb-chip sb-folder sb-folder-btn${this.animClass("folder")}" role="button" title="${cwdEsc}" data-cwd="${cwdEsc}"><i class="ph ph-folder-open"></i>${escapeHtml(folderName)}</span>`);
    }

    // Claude group: model, effort, context, thinking, duration
    const claudeChips: string[] = [];
    if (f.includes("model")) {
      if (this.meta.model) {
        claudeChips.push(`<span class="sb-chip sb-model sb-model-btn${this.animClass("model")}" role="button" tabindex="0"><i class="ph ph-robot"></i>${escapeHtml(shortModelName(this.meta.model))}</span>`);
      } else if (!this.metaLoaded) {
        claudeChips.push(this.skeletonChip("model", "sb-model", "ph-robot", "70px"));
      }
    }
    if (f.includes("effort") && this.effort) {
      const cls = this.readOnlyEffort ? " readonly" : " sb-effort-btn";
      claudeChips.push(`<span class="sb-chip sb-effort${cls}${this.animClass("effort")}" role="button" tabindex="0"><i class="ph ph-gauge"></i>${escapeHtml(this.effort)}</span>`);
    }
    if (f.includes("context")) {
      if (this.meta.inputTokens > 0) {
        // Denominator uses the locked session model, NOT meta.model: the latter
        // can be transiently overwritten by an internal sub-call's model (e.g.
        // Haiku), which would collapse a 1M Opus window to 200K and pin ctx at
        // 100%. Fall back to meta.model only when the session model is unknown.
        const window = modelContextWindow(this.sessionModel || this.meta.model);
        const raw = (this.meta.inputTokens / window) * 100;
        if (raw >= 100) {
          console.warn("[ctx-100] context pinned at 100%", { inputTokens: this.meta.inputTokens, window, sessionModel: this.sessionModel, metaModel: this.meta.model });
        }
        const pctStr = raw < 1 ? "<1" : String(Math.min(100, Math.round(raw)));
        const cls = raw >= 80 ? " danger" : raw >= 50 ? " warn" : "";
        claudeChips.push(`<span class="sb-chip sb-context${cls}${this.animClass("context")}" title="${this.meta.inputTokens.toLocaleString()} / ${window.toLocaleString()} tokens"><i class="ph ph-stack"></i>${pctStr}%</span>`);
      } else if (!this.metaLoaded) {
        claudeChips.push(this.skeletonChip("context", "sb-context", "ph-stack", "40px"));
      }
    }
    if (f.includes("thinking") && this.meta.hasThinking) {
      claudeChips.push(`<span class="sb-chip sb-thinking active${this.animClass("thinking")}"><i class="ph ph-brain"></i>thinking</span>`);
    }
    if (f.includes("duration") && this.startedAt) {
      claudeChips.push(`<span class="sb-chip sb-duration${this.animClass("duration")}"><i class="ph ph-timer"></i><span class="sb-duration-text">${formatDuration(this.startedAt)}</span></span>`);
    }

    // Counts group: messages (user prompts sent), turns (agent turns).
    const countChips: string[] = [];
    if (f.includes("messages")) {
      if (this.counts) {
        const n = this.counts.prompts;
        countChips.push(`<span class="sb-chip sb-messages${this.animClass("messages")}"><i class="ph ph-chat-circle"></i>${n} ${n === 1 ? "msg" : "msgs"}</span>`);
      } else if (!this.countsLoaded) {
        countChips.push(this.skeletonChip("messages", "sb-messages", "ph-chat-circle", "52px"));
      }
    }
    if (f.includes("turns")) {
      if (this.counts) {
        const n = this.counts.turns;
        countChips.push(`<span class="sb-chip sb-turns${this.animClass("turns")}"><i class="ph ph-arrows-clockwise"></i>${n} ${n === 1 ? "turn" : "turns"}</span>`);
      } else if (!this.countsLoaded) {
        countChips.push(this.skeletonChip("turns", "sb-turns", "ph-arrows-clockwise", "55px"));
      }
    }

    // Join non-empty groups with a separator between each adjacent pair.
    const allChips: string[] = [];
    for (const group of [gitChips, claudeChips, countChips]) {
      if (group.length === 0) continue;
      if (allChips.length > 0) allChips.push(`<span class="sb-sep"></span>`);
      allChips.push(...group);
    }

    const effortIdx = Math.max(0, EFFORTS.indexOf(this.effort as typeof EFFORTS[number]));
    const effortPopoverHtml = this.effortPopoverOpen ? `
      <div class="sb-effort-popover">
        <div class="sb-effort-popover-label">Effort</div>
        <input type="range" class="sb-effort-slider" min="0" max="${EFFORTS.length - 1}" step="1" value="${effortIdx}">
        <div class="sb-effort-stops">
          ${EFFORTS.map((e, i) => `<span class="sb-effort-stop${i === effortIdx ? " active" : ""}">${escapeHtml(e)}</span>`).join("")}
        </div>
      </div>
    ` : "";

    const modelPopoverHtml = this.modelPopoverOpen && this.meta.model ? `
      <div class="sb-model-popover">
        <div class="sb-model-popover-name">${escapeHtml(this.meta.model)}</div>
        <div class="sb-model-popover-hint">Locked for this session. Start a new session to change.</div>
      </div>
    ` : "";

    this.container.innerHTML = `
      <div class="sb-chips">${allChips.length > 0 ? allChips.join("") : '<span class="sb-empty">No fields</span>'}</div>
      ${effortPopoverHtml}
      ${modelPopoverHtml}
    `;

    this.container.querySelector<HTMLElement>(".sb-folder-btn")?.addEventListener("click", () => {
      if (this.cwd) {
        void invoke<void>("open_in_explorer", { path: this.cwd });
      }
    });

    this.container.querySelector<HTMLElement>(".sb-model-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.modelPopoverOpen = !this.modelPopoverOpen;
      this.effortPopoverOpen = false;
      this.render();
    });

    this.container.querySelector<HTMLElement>(".sb-effort-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.readOnlyEffort) return;
      this.effortPopoverOpen = !this.effortPopoverOpen;
      this.modelPopoverOpen = false;
      this.render();
    });

    if (this.effortPopoverOpen) {
      const slider = this.container.querySelector<HTMLInputElement>(".sb-effort-slider");
      slider?.addEventListener("change", () => {
        const i = Number(slider.value);
        const next = EFFORTS[i];
        if (!next || !this.sessionId) return;
        const sid = this.sessionId;
        const newEffort = next;
        void invoke<void>("set_session_effort", { sessionId: sid, effort: newEffort })
          .then(() => {
            this.effort = newEffort;
            this.effortPopoverOpen = false;
            this.render();
          })
          .catch((err) => {
            console.error("[statusbar] set_session_effort failed", err);
          });
      });
      const closeOnOutsideEffort = (e: MouseEvent) => {
        if (!this.container.contains(e.target as Node)) {
          this.effortPopoverOpen = false;
          this.render();
          document.removeEventListener("click", closeOnOutsideEffort);
        }
      };
      setTimeout(() => document.addEventListener("click", closeOnOutsideEffort), 0);
    }

    if (this.modelPopoverOpen) {
      const closeOnOutsideModel = (e: MouseEvent) => {
        if (!this.container.contains(e.target as Node)) {
          this.modelPopoverOpen = false;
          this.render();
          document.removeEventListener("click", closeOnOutsideModel);
        }
      };
      setTimeout(() => document.addEventListener("click", closeOnOutsideModel), 0);
    }

  }
}
