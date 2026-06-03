import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { GitInfo } from "../../types/ipc.generated";
import { EFFORTS } from "../../shared/effort-presets";
import {
  formatDuration,
  shortModelName,
  modelContextWindow,
  gitInfoCache,
  metaCache,
  countsCache,
  type SessionCounts,
  type StatusbarOptions,
} from "./session-statusbar-helpers";
export {
  DEFAULT_STATUSLINE_FIELDS,
  ALL_STATUSLINE_FIELDS,
  loadStatuslineFields,
  saveStatuslineFields,
  shortModelName,
  modelContextWindow,
  formatDuration,
  fetchGitInfo,
  type StatusbarOptions,
} from "./session-statusbar-helpers";

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

    if (this.cwd) {
      const cached = gitInfoCache.get(this.cwd);
      if (cached) { this.gitInfo = cached; this.gitInfoLoaded = true; }
    } else {
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

  private async refreshCounts(): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    try {
      const r = await invoke<{ tokens: number; turns: number; prompts?: number }>("instance_token_stats", { sessionId: sid });
      if (this.sessionId !== sid) return;
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

  private animClass(key: string): string {
    if (this.animatedKeys.has(key)) return "";
    this.animatedKeys.add(key);
    return " sb-fadein";
  }

  private render(): void {
    const f = this.fields;

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
