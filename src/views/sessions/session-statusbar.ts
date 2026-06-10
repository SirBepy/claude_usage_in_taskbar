import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { type ToolTally } from "../../shared/chat/tool-meta";
import { ToolTallyRow } from "./session-tally";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { GitInfo, ContextStatus } from "../../types/ipc.generated";
import { EFFORTS } from "../../shared/effort-presets";
import {
  formatDuration,
  shortModelName,
  modelContextWindow,
  gitInfoCache,
  metaCache,
  countsCache,
  ctxStatusCache,
  type SessionCounts,
  type StatusbarOptions,
} from "./session-statusbar-helpers";
export {
  DEFAULT_STATUSLINE_FIELDS,
  ALL_STATUSLINE_FIELDS,
  loadStatuslineFields,
  saveStatuslineFields,
  TALLY_TOOL_OPTIONS,
  DEFAULT_TALLY_HIDDEN_TOOLS,
  loadTallyHiddenTools,
  saveTallyHiddenTools,
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
  // Daemon-computed context occupancy is the source of truth for the context
  // chip; the frontend modelContextWindow calc is only a transition/offline
  // fallback (see render). null = not yet fetched or unavailable for this session.
  private ctxStatus: ContextStatus | null = null;
  private startedAt: string | null;
  private cwd: string | null;
  private effort: string;
  private sessionId: string | null;
  private sessionModel: string | null;
  private readOnlyEffort: boolean;
  // Raw tool names hidden from the tally row (settings-configurable).
  private tallyHiddenTools: string[];
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private effortPopoverOpen = false;
  private modelPopoverOpen = false;
  private animatedKeys = new Set<string>();
  private toolTally: ToolTally = { byType: [] };
  // Cumulative tool tally row: one chip per tool type, each its OWN drill-down
  // popover listing that tool's distinct targets. The chip-row build, popover,
  // open/close/toggle and outside-click cleanup live in the ToolTallyRow
  // controller; this class owns only the toolTally + tallyHiddenTools state.
  private tally: ToolTallyRow;

  constructor(container: HTMLElement, startedAt: string | null, fields: string[], opts: StatusbarOptions = {}) {
    this.container = container;
    this.startedAt = startedAt;
    this.fields = fields;
    this.cwd = opts.cwd ?? null;
    this.effort = opts.effort ?? "";
    this.sessionId = opts.sessionId ?? null;
    this.sessionModel = opts.sessionModel ?? null;
    this.readOnlyEffort = opts.readOnly ?? false;
    this.tallyHiddenTools = opts.tallyHiddenTools ?? [];
    this.container.className = "session-statusbar";
    this.tally = new ToolTallyRow(this.container);

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
      const cachedCtx = ctxStatusCache.get(this.sessionId);
      if (cachedCtx) this.ctxStatus = cachedCtx;
    }

    this.render();
    if (this.fields.includes("duration")) this.startDurationTimer();
    if (this.wantsCounts()) void this.refreshCounts();
    if (this.wantsContext()) void this.refreshContextStatus();
  }

  private wantsCounts(): boolean {
    return this.fields.includes("messages") || this.fields.includes("turns");
  }

  private wantsContext(): boolean {
    return this.fields.includes("context");
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

  // Fetch the daemon-computed context occupancy (source of truth). Does not
  // block render; render reads the cached this.ctxStatus and falls back to the
  // frontend calc until this resolves. arg key is camelCase `sessionId` to
  // match the Rust `session_id` param (Tauri auto-converts), same convention
  // as instance_token_stats above.
  private async refreshContextStatus(): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    try {
      const r = await invoke<ContextStatus | null>("context_status", { sessionId: sid });
      if (this.sessionId !== sid) return;
      if (r) {
        this.ctxStatus = r;
        ctxStatusCache.set(sid, r);
        this.render();
      }
      // r === null: keep last known / fall back to frontend calc, no re-render needed.
    } catch { /* command may predate this binary, or transient - keep fallback */ }
  }

  updateMeta(meta: SessionMeta): void {
    this.meta = meta;
    this.metaLoaded = true;
    if (this.sessionId) metaCache.set(this.sessionId, meta);
    this.render();
    if (this.wantsCounts()) void this.refreshCounts();
    if (this.wantsContext()) void this.refreshContextStatus();
  }

  updateGitInfo(info: GitInfo): void {
    this.gitInfo = info;
    this.gitInfoLoaded = true;
    if (this.cwd) gitInfoCache.set(this.cwd, info);
    this.render();
  }

  // Cumulative tool tally for this session (Read/Edit/Bash/... counts + the
  // distinct file/image targets behind the Files|Media popover). Re-renders the
  // row; an open popover is rebuilt so its lists stay in sync.
  updateToolTally(t: ToolTally): void {
    this.toolTally = t;
    this.render();
    this.tally.update(t);
  }

  setSessionId(id: string): void {
    this.sessionId = id;
    // Reset per-session state so a prior session's counts/context never linger
    // on screen, then re-seed from cache (stale-while-revalidate) and re-render.
    this.counts = null;
    this.countsLoaded = false;
    this.ctxStatus = null;
    const cached = countsCache.get(id);
    if (cached) { this.counts = cached; this.countsLoaded = true; }
    const cachedCtx = ctxStatusCache.get(id);
    if (cachedCtx) this.ctxStatus = cachedCtx;
    this.render();
    if (this.wantsCounts()) void this.refreshCounts();
    if (this.wantsContext()) void this.refreshContextStatus();
  }

  setReadOnlyEffort(readOnly: boolean): void {
    if (this.readOnlyEffort === readOnly) return;
    this.readOnlyEffort = readOnly;
    this.render();
  }

  destroy(): void {
    if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; }
    this.tally.destroy();
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
      // Prefer the live meta model, but fall back to the session's known model
      // (passed at construction) so the chip shows instantly on first open
      // instead of a skeleton until the first meta event streams in.
      const model = this.meta.model ?? this.sessionModel;
      if (model) {
        claudeChips.push(`<span class="sb-chip sb-model sb-model-btn${this.animClass("model")}" role="button" tabindex="0"><i class="ph ph-robot"></i>${escapeHtml(shortModelName(model))}</span>`);
      } else if (!this.metaLoaded) {
        claudeChips.push(this.skeletonChip("model", "sb-model", "ph-robot", "70px"));
      }
    }
    if (f.includes("effort") && this.effort) {
      const cls = this.readOnlyEffort ? " readonly" : " sb-effort-btn";
      claudeChips.push(`<span class="sb-chip sb-effort${cls}${this.animClass("effort")}" role="button" tabindex="0"><i class="ph ph-gauge"></i>${escapeHtml(this.effort)}</span>`);
    }
    if (f.includes("context")) {
      // Source of truth is the daemon's context_status (this.ctxStatus): it
      // computes occupancy + window app-side with a sticky >200K correction
      // that fixes the old "pinned at 100%" bug. The frontend calc below is a
      // transition/offline fallback for when the IPC returns null/throws (e.g.
      // a running binary that predates the command, or no usage yet).
      if (this.ctxStatus) {
        const c = this.ctxStatus;
        const raw = c.pct_used;
        const estimated = c.confidence !== "proven";
        if (raw >= 100) {
          console.warn("[ctx-100] context pinned at 100% (daemon)", { occupancy: String(c.occupancy), window: String(c.window), model: c.model, confidence: c.confidence });
        }
        const pctNum = raw < 1 && raw > 0 ? "<1" : String(Math.min(100, Math.round(raw)));
        // No "~" prefix: the rough number is good enough to show plainly. The
        // estimated state still surfaces via the "(estimated)" tooltip note.
        const pctStr = pctNum;
        const cls = raw >= 80 ? " danger" : raw >= 50 ? " warn" : "";
        const occ = Number(c.occupancy).toLocaleString();
        const win = Number(c.window).toLocaleString();
        const note = estimated ? " (estimated)" : "";
        claudeChips.push(`<span class="sb-chip sb-context${cls}${this.animClass("context")}" title="${occ} / ${win} tokens (conversation + system prompt + tools)${note}"><i class="ph ph-stack"></i>${pctStr}%</span>`);
      } else if (this.meta.inputTokens > 0) {
        // Fallback: frontend-only calc (transition/offline, not source of truth).
        const window = modelContextWindow(this.sessionModel || this.meta.model);
        const raw = (this.meta.inputTokens / window) * 100;
        if (raw >= 100) {
          console.warn("[ctx-100] context pinned at 100%", { inputTokens: this.meta.inputTokens, window, sessionModel: this.sessionModel, metaModel: this.meta.model });
        }
        const pctStr = raw < 1 ? "<1" : String(Math.min(100, Math.round(raw)));
        const cls = raw >= 80 ? " danger" : raw >= 50 ? " warn" : "";
        claudeChips.push(`<span class="sb-chip sb-context${cls}${this.animClass("context")}" title="${this.meta.inputTokens.toLocaleString()} / ${window.toLocaleString()} tokens (conversation + system prompt + tools)"><i class="ph ph-stack"></i>${pctStr}%</span>`);
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

    // Cumulative tool-tally chips (Read x4, Edited x6, ...). Always-on group,
    // not gated on `fields`. Built + wired by the ToolTallyRow controller.
    const tallyRowHtml = this.tally.renderChips(this.toolTally, this.tallyHiddenTools);

    const allChips: string[] = [];
    for (const group of [gitChips, claudeChips, countChips]) {
      if (group.length === 0) continue;
      if (allChips.length > 0) allChips.push(`<span class="sb-sep"></span>`);
      allChips.push(...group);
    }
    if (tallyRowHtml) {
      if (allChips.length > 0) allChips.push(`<span class="sb-sep"></span>`);
      allChips.push(tallyRowHtml);
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

    const popoverModel = this.meta.model ?? this.sessionModel;
    const modelPopoverHtml = this.modelPopoverOpen && popoverModel ? `
      <div class="sb-model-popover">
        <div class="sb-model-popover-name">${escapeHtml(popoverModel)}</div>
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

    this.tally.wireChips();

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
