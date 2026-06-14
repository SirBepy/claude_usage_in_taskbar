import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { type ToolTally } from "../../shared/chat/tool-meta";
import { ToolTallyRow } from "./session-tally";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { GitInfo, ContextStatus } from "../../types/ipc.generated";
import { EFFORTS } from "../../shared/effort-presets";
import { type ChipType, isToolChip, chipToolName } from "./statusline-catalog";
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
  loadStatuslineRows,
  saveStatuslineRows,
  loadStatuslineHideZero,
  saveStatuslineHideZero,
  migrateLegacyFields,
  shortModelName,
  modelContextWindow,
  formatDuration,
  fetchGitInfo,
  type StatusbarOptions,
} from "./session-statusbar-helpers";

const EMPTY_META: SessionMeta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };

/** Compact token count for the context-tokens chip, e.g. 90123 => "90k". */
function fmtTokens(n: number): string {
  const v = Math.round(Number(n) || 0);
  return v >= 1000 ? `${Math.round(v / 1000)}k` : String(v);
}

export class SessionStatusbar {
  private container: HTMLElement;
  private rows: ChipType[][];
  private meta: SessionMeta = EMPTY_META;
  private gitInfo: GitInfo = { branch: null, repo: null, ahead: null, behind: null, sha: null, insertions: null, deletions: null };
  private gitInfoLoaded = false;
  private metaLoaded = false;
  private counts: SessionCounts | null = null;
  private countsLoaded = false;
  // Daemon-computed context occupancy is the source of truth for the context
  // chip; the frontend modelContextWindow calc is only a transition/offline
  // fallback (see renderContext). null = not yet fetched or unavailable.
  private ctxStatus: ContextStatus | null = null;
  // Uncommitted-file count for the `dirty` chip (via get_git_dirty IPC, cwd-based).
  private dirtyCount: number | null = null;
  private dirtyLoaded = false;
  private startedAt: string | null;
  private cwd: string | null;
  private effort: string;
  private sessionId: string | null;
  private sessionModel: string | null;
  private readOnlyEffort: boolean;
  // Global hide-at-zero: when true, count/tool chips resolving to 0 are omitted.
  private hideZero: boolean;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private effortPopoverOpen = false;
  private modelPopoverOpen = false;
  private animatedKeys = new Set<string>();
  private toolTally: ToolTally = { byType: [] };
  // Per-tool chips delegate their drill-down popover to this controller.
  private tally: ToolTallyRow;

  constructor(container: HTMLElement, startedAt: string | null, rows: ChipType[][], opts: StatusbarOptions = {}) {
    this.container = container;
    this.startedAt = startedAt;
    this.rows = rows;
    this.cwd = opts.cwd ?? null;
    this.effort = opts.effort ?? "";
    this.sessionId = opts.sessionId ?? null;
    this.sessionModel = opts.sessionModel ?? null;
    this.readOnlyEffort = opts.readOnly ?? false;
    this.hideZero = opts.hideZero ?? true;
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
    if (this.wantsTimer()) this.startTimer();
    if (this.wantsCounts()) void this.refreshCounts();
    if (this.wantsContext()) void this.refreshContextStatus();
    if (this.hasChip("dirty")) void this.refreshDirty();
  }

  private hasChip(type: string): boolean {
    return this.rows.some((r) => r.includes(type as ChipType));
  }
  private wantsCounts(): boolean { return this.hasChip("messages") || this.hasChip("turns"); }
  private wantsContext(): boolean { return this.hasChip("context_pct") || this.hasChip("context_tokens"); }
  private wantsTimer(): boolean { return this.hasChip("duration") || this.hasChip("clock"); }

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
    } catch { /* command may predate this binary, or transient - keep fallback */ }
  }

  // Uncommitted-file count for the `dirty` chip. cwd-based (not session-based),
  // so it is not reset on setSessionId. Mirrors refreshCounts.
  private async refreshDirty(): Promise<void> {
    const cwd = this.cwd;
    if (!cwd) return;
    try {
      const files = await invoke<string[]>("get_git_dirty", { cwd });
      if (this.cwd !== cwd) return;
      this.dirtyCount = files.length;
      this.dirtyLoaded = true;
      this.render();
    } catch { /* transient - keep last known */ }
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
    if (this.hasChip("dirty")) void this.refreshDirty();
  }

  updateToolTally(t: ToolTally): void {
    this.toolTally = t;
    this.render();
    this.tally.update(t);
  }

  setSessionId(id: string): void {
    this.sessionId = id;
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

  private tickTimer(): void {
    if (this.startedAt) {
      const el = this.container.querySelector<HTMLElement>(".sb-duration .sb-duration-text");
      if (el) el.textContent = formatDuration(this.startedAt);
    }
    const clock = this.container.querySelector<HTMLElement>(".sb-clock .sb-clock-text");
    if (clock) clock.textContent = this.clockText();
  }

  private startTimer(): void {
    this.durationTimer = setInterval(() => this.tickTimer(), 1000);
  }

  private skeletonChip(key: string, extraClass: string, iconClass: string, width: string): string {
    return `<span class="sb-chip sb-skeleton ${extraClass}" data-skeleton="${key}" style="min-width:${width}"><i class="ph ${iconClass}"></i><span class="sb-skel-bar"></span></span>`;
  }

  private animClass(key: string): string {
    if (this.animatedKeys.has(key)) return "";
    this.animatedKeys.add(key);
    return " sb-fadein";
  }

  private clockText(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  // ── chip dispatch ──────────────────────────────────────────────────────────
  private renderChip(type: ChipType): string {
    if (isToolChip(type)) {
      const tool = chipToolName(type);
      const count = this.toolTally.byType.find((b) => b.tool === tool)?.count ?? 0;
      return this.tally.renderChipFor(tool, count, this.hideZero);
    }
    switch (type) {
      case "model": {
        const model = this.meta.model ?? this.sessionModel;
        if (model) return `<span class="sb-chip sb-model sb-model-btn${this.animClass("model")}" role="button" tabindex="0"><i class="ph ph-robot"></i>${escapeHtml(shortModelName(model))}</span>`;
        if (!this.metaLoaded) return this.skeletonChip("model", "sb-model", "ph-robot", "70px");
        return "";
      }
      case "effort": {
        if (!this.effort) return "";
        const cls = this.readOnlyEffort ? " readonly" : " sb-effort-btn";
        return `<span class="sb-chip sb-effort${cls}${this.animClass("effort")}" role="button" tabindex="0"><i class="ph ph-gauge"></i>${escapeHtml(this.effort)}</span>`;
      }
      case "context_pct": return this.renderContext(false);
      case "context_tokens": return this.renderContext(true);
      case "thinking":
        return this.meta.hasThinking ? `<span class="sb-chip sb-thinking active${this.animClass("thinking")}"><i class="ph ph-brain"></i>thinking</span>` : "";
      case "branch": {
        if (this.gitInfo.branch) return `<span class="sb-chip sb-branch${this.animClass("branch")}"><i class="ph ph-git-branch"></i>${escapeHtml(this.gitInfo.branch)}</span>`;
        if (!this.gitInfoLoaded) return this.skeletonChip("branch", "sb-branch", "ph-git-branch", "60px");
        return "";
      }
      case "repo": {
        if (this.gitInfo.repo) return `<span class="sb-chip sb-repo${this.animClass("repo")}"><i class="ph ph-folder-simple"></i>${escapeHtml(this.gitInfo.repo)}</span>`;
        if (!this.gitInfoLoaded) return this.skeletonChip("repo", "sb-repo", "ph-folder-simple", "80px");
        return "";
      }
      case "folder": {
        if (!this.cwd) return "";
        const folderName = this.cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? this.cwd;
        const cwdEsc = escapeHtml(this.cwd);
        return `<span class="sb-chip sb-folder sb-folder-btn${this.animClass("folder")}" role="button" title="${cwdEsc}" data-cwd="${cwdEsc}"><i class="ph ph-folder-open"></i>${escapeHtml(folderName)}</span>`;
      }
      case "commits": return this.renderCommits("both");
      case "commits_ahead": return this.renderCommits("ahead");
      case "commits_behind": return this.renderCommits("behind");
      case "dirty": return this.renderDirty();
      case "sha":
        if (this.gitInfo.sha) return `<span class="sb-chip sb-sha${this.animClass("sha")}"><i class="ph ph-hash"></i>${escapeHtml(this.gitInfo.sha)}</span>`;
        return this.gitInfoLoaded ? "" : this.skeletonChip("sha", "sb-sha", "ph-hash", "60px");
      case "diffstat": return this.renderDiffstat();
      case "messages": {
        if (this.counts) {
          const n = this.counts.prompts;
          if (n === 0 && this.hideZero) return "";
          return `<span class="sb-chip sb-messages${this.animClass("messages")}"><i class="ph ph-chat-circle"></i>${n} ${n === 1 ? "msg" : "msgs"}</span>`;
        }
        return this.countsLoaded ? "" : this.skeletonChip("messages", "sb-messages", "ph-chat-circle", "52px");
      }
      case "turns": {
        if (this.counts) {
          const n = this.counts.turns;
          if (n === 0 && this.hideZero) return "";
          return `<span class="sb-chip sb-turns${this.animClass("turns")}"><i class="ph ph-arrows-clockwise"></i>${n} ${n === 1 ? "turn" : "turns"}</span>`;
        }
        return this.countsLoaded ? "" : this.skeletonChip("turns", "sb-turns", "ph-arrows-clockwise", "55px");
      }
      case "duration":
        if (!this.startedAt) return "";
        return `<span class="sb-chip sb-duration${this.animClass("duration")}"><i class="ph ph-timer"></i><span class="sb-duration-text">${formatDuration(this.startedAt)}</span></span>`;
      case "cost": return this.renderCost();
      case "clock":
        return `<span class="sb-chip sb-clock${this.animClass("clock")}"><i class="ph ph-clock"></i><span class="sb-clock-text">${this.clockText()}</span></span>`;
      default: return "";
    }
  }

  private renderContext(asTokens: boolean): string {
    const key = asTokens ? "context_tokens" : "context_pct";
    if (this.ctxStatus) {
      const c = this.ctxStatus;
      const raw = c.pct_used;
      const estimated = c.confidence !== "proven";
      if (raw >= 100) console.warn("[ctx-100] context pinned at 100% (daemon)", { occupancy: String(c.occupancy), window: String(c.window), model: c.model, confidence: c.confidence });
      const cls = raw >= 80 ? " danger" : raw >= 50 ? " warn" : "";
      const occ = Number(c.occupancy).toLocaleString();
      const win = Number(c.window).toLocaleString();
      const note = estimated ? " (estimated)" : "";
      const pctStr = raw < 1 && raw > 0 ? "<1" : String(Math.min(100, Math.round(raw)));
      const body = asTokens ? `${fmtTokens(Number(c.occupancy))} / ${fmtTokens(Number(c.window))}` : `${pctStr}%`;
      return `<span class="sb-chip sb-context${cls}${this.animClass(key)}" title="${occ} / ${win} tokens (conversation + system prompt + tools)${note}"><i class="ph ph-stack"></i>${body}</span>`;
    } else if (this.meta.inputTokens > 0) {
      const window = modelContextWindow(this.sessionModel || this.meta.model);
      const raw = (this.meta.inputTokens / window) * 100;
      if (raw >= 100) console.warn("[ctx-100] context pinned at 100%", { inputTokens: this.meta.inputTokens, window, sessionModel: this.sessionModel, metaModel: this.meta.model });
      const cls = raw >= 80 ? " danger" : raw >= 50 ? " warn" : "";
      const pctStr = raw < 1 ? "<1" : String(Math.min(100, Math.round(raw)));
      const body = asTokens ? `${fmtTokens(this.meta.inputTokens)} / ${fmtTokens(window)}` : `${pctStr}%`;
      return `<span class="sb-chip sb-context${cls}${this.animClass(key)}" title="${this.meta.inputTokens.toLocaleString()} / ${window.toLocaleString()} tokens (conversation + system prompt + tools)"><i class="ph ph-stack"></i>${body}</span>`;
    } else if (!this.metaLoaded) {
      return this.skeletonChip(key, "sb-context", "ph-stack", asTokens ? "70px" : "40px");
    }
    return "";
  }

  private renderCommits(mode: "ahead" | "behind" | "both"): string {
    const a = this.gitInfo.ahead ?? null, b = this.gitInfo.behind ?? null;
    if (a === null && b === null) {
      return this.gitInfoLoaded ? "" : this.skeletonChip("commits", "sb-commits", "ph-arrows-down-up", "44px");
    }
    let txt = "", icon = "ph-arrows-down-up";
    if (mode === "ahead") { txt = `↑${a ?? 0}`; icon = "ph-arrow-up"; }
    else if (mode === "behind") { txt = `↓${b ?? 0}`; icon = "ph-arrow-down"; }
    else { txt = `↑${a ?? 0} ↓${b ?? 0}`; }
    const key = `commits_${mode}`;
    return `<span class="sb-chip sb-commits${this.animClass(key)}" title="${a ?? 0} ahead, ${b ?? 0} behind upstream"><i class="ph ${icon}"></i>${txt}</span>`;
  }

  private renderDirty(): string {
    const n = this.dirtyCount;
    if (n === null) return this.dirtyLoaded ? "" : this.skeletonChip("dirty", "sb-dirty", "ph-pencil-simple", "44px");
    if (n === 0 && this.hideZero) return "";
    return `<span class="sb-chip sb-dirty${this.animClass("dirty")}" title="${n} uncommitted file${n === 1 ? "" : "s"}"><i class="ph ph-pencil-simple"></i>${n} dirty</span>`;
  }

  private renderDiffstat(): string {
    const ins = this.gitInfo.insertions, del = this.gitInfo.deletions;
    if (ins == null && del == null) return this.gitInfoLoaded ? "" : this.skeletonChip("diffstat", "sb-diffstat", "ph-plus-minus", "50px");
    if ((ins ?? 0) === 0 && (del ?? 0) === 0 && this.hideZero) return "";
    return `<span class="sb-chip sb-diffstat${this.animClass("diffstat")}" title="uncommitted: +${ins ?? 0} / -${del ?? 0}"><i class="ph ph-plus-minus"></i><span class="sb-ins">+${ins ?? 0}</span> <span class="sb-del">-${del ?? 0}</span></span>`;
  }

  private renderCost(): string {
    const c = this.meta.totalCostUsd;
    if (!this.metaLoaded) return this.skeletonChip("cost", "sb-cost", "ph-currency-dollar", "44px");
    if ((!c || c <= 0) && this.hideZero) return "";
    return `<span class="sb-chip sb-cost${this.animClass("cost")}" title="Estimated session cost (local estimate, not a charge)"><i class="ph ph-currency-dollar"></i>~$${(c ?? 0).toFixed(2)}</span>`;
  }

  private render(): void {
    const rowsHtml = this.rows.map((row) => {
      const chips = row.map((t) => this.renderChip(t)).filter(Boolean).join("");
      return chips ? `<div class="sb-row">${chips}</div>` : "";
    }).filter(Boolean).join("");

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
      <div class="sb-rows">${rowsHtml || '<span class="sb-empty">No chips</span>'}</div>
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
