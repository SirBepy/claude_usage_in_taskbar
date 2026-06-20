import { escapeHtml } from "../../shared/escape-html";
import { invoke } from "../../shared/ipc";
import { type ToolTally } from "../../shared/chat/tool-meta";
import { formatTokenCount } from "../../shared/chat/turn-chips";
import { ToolTallyRow } from "./session-tally";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { AiTodoEntry, GitInfo, ContextStatus, ChatDrain } from "../../types/ipc.generated";
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
  drainCache,
  fetchGitInfo,
  type SessionCounts,
  type StatusbarOptions,
} from "./session-statusbar-helpers";
export {
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

// NOTE: a split of the chip-render concern into a separate `statusline-chip-render.ts`
// was evaluated and rejected (ai_todo 98). The render methods read ~18 instance
// fields and depend on a LIVE controller (`this.tally.renderChipFor` for tool chips)
// plus a MUTABLE `animatedKeys` Set (`animClass` has a side effect), so a "pure
// function + small snapshot" seam doesn't hold - the snapshot balloons and threading
// the controller + mutable set out worsens readability. This file uses plain
// innerHTML strings (not lit) and sits only marginally over the ~400-line guideline,
// which this codebase tolerates. Leave as-is; don't re-attempt without a new seam.
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
  private aiTodoFiles: AiTodoEntry[] = [];
  private aiTodosLoaded = false;
  private aiTodosPopoverOpen = false;
  // Per-chat token-drain (share of a 5h session + weekly, plus per-message
  // rundown), via chat_drain IPC. null = not yet fetched / unavailable.
  private drain: ChatDrain | null = null;
  private drainInflight = false;
  // The drain rundown popover is body-appended (rich content), so it survives
  // statusbar re-renders; managed by its own open/close like the tally popover.
  private drainPopoverEl: HTMLElement | null = null;
  private drainPopoverCleanup: (() => void) | null = null;
  private startedAt: string | null;
  private cwd: string | null;
  private effort: string;
  private sessionId: string | null;
  private sessionModel: string | null;
  private readOnlyEffort: boolean;
  private onEffortChange: ((effort: string) => void) | null;
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
    this.onEffortChange = opts.onEffortChange ?? null;
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
      const cachedDrain = drainCache.get(this.sessionId);
      if (cachedDrain) this.drain = cachedDrain;
    }

    this.render();
    if (this.wantsTimer()) this.startTimer();
    if (this.wantsCounts()) void this.refreshCounts();
    if (this.wantsContext()) void this.refreshContextStatus();
    if (this.hasChip("dirty")) void this.refreshDirty();
    if (this.hasChip("ai_todos") && this.cwd) void this.refreshAiTodos();
    if (this.wantsDrain()) void this.refreshDrain();
  }

  private hasChip(type: string): boolean {
    return this.rows.some((r) => r.includes(type as ChipType));
  }
  private wantsCounts(): boolean { return this.hasChip("messages") || this.hasChip("turns"); }
  private wantsContext(): boolean { return this.hasChip("context_pct") || this.hasChip("context_tokens"); }
  private wantsTimer(): boolean { return this.hasChip("duration") || this.hasChip("clock"); }
  private wantsDrain(): boolean { return this.hasChip("drain"); }

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

  private async refreshContextStatus(allowRetry = true): Promise<void> {
    const sid = this.sessionId;
    if (!sid) return;
    // Capture hasUsage before the await: if the turn just completed and the
    // JSONL hasn't been flushed yet, we get null back and need a retry.
    const hadUsage = this.meta.hasUsage;
    try {
      const r = await invoke<ContextStatus | null>("context_status", { sessionId: sid });
      if (this.sessionId !== sid) return;
      if (r) {
        this.ctxStatus = r;
        ctxStatusCache.set(sid, r);
        this.render();
      } else if (allowRetry && hadUsage && !this.ctxStatus) {
        // Turn completed (hasUsage=true) but the transcript JSONL may not have
        // been flushed to disk yet (claude CLI can write stdout before the file).
        // Retry once after 1.5 s to resolve the write-buffer race.
        setTimeout(() => {
          if (this.sessionId === sid && !this.ctxStatus) void this.refreshContextStatus(false);
        }, 1500);
      }
    } catch { /* command may predate this binary, or transient - keep fallback */ }
  }

  private async refreshGitInfo(): Promise<void> {
    const cwd = this.cwd;
    if (!cwd) return;
    try {
      const info = await fetchGitInfo(cwd);
      if (this.cwd !== cwd) return;
      this.updateGitInfo(info);
    } catch { /* transient */ }
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

  private async refreshAiTodos(): Promise<void> {
    const cwd = this.cwd;
    if (!cwd) return;
    try {
      const files = await invoke<AiTodoEntry[]>("list_ai_todos", { cwd });
      if (this.cwd !== cwd) return;
      this.aiTodoFiles = files;
      this.aiTodosLoaded = true;
      this.render();
    } catch { /* transient - keep last known */ }
  }

  // This chat's token-drain breakdown. session-based (reset on setSessionId).
  // Guards against overlapping in-flight calls (it's re-fired on every meta
  // update as the chat spends, like refreshCounts/refreshContextStatus).
  private async refreshDrain(): Promise<void> {
    const sid = this.sessionId;
    if (!sid || this.drainInflight) return;
    this.drainInflight = true;
    try {
      const d = await invoke<ChatDrain | null>("chat_drain", { sessionId: sid });
      if (this.sessionId !== sid) return;
      if (d) {
        this.drain = d;
        drainCache.set(sid, d);
        this.render();
        // Keep an open rundown popover in sync as the chat spends.
        if (this.drainPopoverEl) this.openDrainPopover();
      }
    } catch { /* command may predate this binary, or transient - keep last known */ }
    finally { this.drainInflight = false; }
  }

  private renderAiTodos(): string {
    if (!this.cwd) return "";
    if (!this.aiTodosLoaded) return this.skeletonChip("ai_todos", "sb-ai-todos", "ph-check-square", "55px");
    const n = this.aiTodoFiles.length;
    if (n === 0) return "";
    return `<span class="sb-chip sb-ai-todos sb-ai-todos-btn${this.animClass("ai_todos")}" role="button" tabindex="0" title="${n} AI todo${n === 1 ? "" : "s"} in .for_bepy/ai_todos"><i class="ph ph-check-square"></i>${n} todo${n === 1 ? "" : "s"}</span>`;
  }

  updateMeta(meta: SessionMeta): void {
    const turnJustCompleted = !this.meta.hasUsage && meta.hasUsage;
    this.meta = meta;
    this.metaLoaded = true;
    if (this.sessionId) metaCache.set(this.sessionId, meta);
    this.render();
    if (this.wantsCounts()) void this.refreshCounts();
    if (this.wantsContext()) void this.refreshContextStatus();
    if (this.wantsDrain()) void this.refreshDrain();
    if (turnJustCompleted && this.cwd) void this.refreshGitInfo();
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

  /** Wire the shared custom-view provider (the chat renderer's message-derived
   *  HTML) so the tool-chip popovers reuse the in-chat Read/File-Changes/Skills/
   *  Questions views. Forwarded to the ToolTallyRow controller. */
  setToolViewProvider(fn: (tool: string) => string | null): void {
    this.tally.setCustomViewProvider(fn);
  }

  setSessionId(id: string): void {
    this.sessionId = id;
    this.counts = null;
    this.countsLoaded = false;
    this.ctxStatus = null;
    this.drain = null;
    this.closeDrainPopover();
    const cached = countsCache.get(id);
    if (cached) { this.counts = cached; this.countsLoaded = true; }
    const cachedCtx = ctxStatusCache.get(id);
    if (cachedCtx) this.ctxStatus = cachedCtx;
    const cachedDrain = drainCache.get(id);
    if (cachedDrain) this.drain = cachedDrain;
    this.render();
    if (this.wantsCounts()) void this.refreshCounts();
    if (this.wantsContext()) void this.refreshContextStatus();
    if (this.wantsDrain()) void this.refreshDrain();
    // Fallback for fast turns that complete before the JS event-store listener
    // is set up (the live turn_usage event is dropped). Re-check after 3 s; by
    // then any fast turn is done and the JSONL is definitely flushed.
    if (this.wantsContext() && id && !id.startsWith("pending-")) {
      setTimeout(() => {
        if (this.sessionId === id && !this.ctxStatus) void this.refreshContextStatus();
      }, 3000);
    }
  }

  setReadOnlyEffort(readOnly: boolean): void {
    if (this.readOnlyEffort === readOnly) return;
    this.readOnlyEffort = readOnly;
    this.render();
  }

  destroy(): void {
    if (this.durationTimer) { clearInterval(this.durationTimer); this.durationTimer = null; }
    this.tally.destroy();
    this.closeDrainPopover();
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
      case "ai_todos": return this.renderAiTodos();
      case "drain": return this.renderDrain();
      case "separator":
        return `<span class="sb-separator" aria-hidden="true"></span>`;
      case "flex_separator":
        return `<span class="sb-flex-sep" aria-hidden="true"></span>`;
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
      const body = asTokens ? `${formatTokenCount(Number(c.occupancy), { decimals: 0 })} / ${formatTokenCount(Number(c.window), { decimals: 0 })}` : `${pctStr}%`;
      return `<span class="sb-chip sb-context${cls}${this.animClass(key)}" title="${occ} / ${win} tokens (conversation + system prompt + tools)${note}"><i class="ph ph-stack"></i>${body}</span>`;
    } else if (this.meta.inputTokens > 0) {
      const window = modelContextWindow(this.sessionModel || this.meta.model);
      const raw = (this.meta.inputTokens / window) * 100;
      if (raw >= 100) console.warn("[ctx-100] context pinned at 100%", { inputTokens: this.meta.inputTokens, window, sessionModel: this.sessionModel, metaModel: this.meta.model });
      const cls = raw >= 80 ? " danger" : raw >= 50 ? " warn" : "";
      const pctStr = raw < 1 ? "<1" : String(Math.min(100, Math.round(raw)));
      const body = asTokens ? `${formatTokenCount(this.meta.inputTokens, { decimals: 0 })} / ${formatTokenCount(window, { decimals: 0 })}` : `${pctStr}%`;
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

  private renderDrain(): string {
    const d = this.drain;
    if (!d) {
      // Muted placeholder while the first chat_drain fetch is in flight (or if
      // the chat has no usage yet). Stays a real button so the popover (with its
      // own empty state) is still reachable.
      return `<span class="sb-chip sb-drain sb-drain-btn muted${this.animClass("drain")}" role="button" tabindex="0" aria-label="Token drain (loading)" title="Share of a 5h session this chat has drained (loading)"><i class="ph ph-drop"></i>··%</span>`;
    }
    const five = Math.round(d.fiveHourPct);
    const week = Math.round(d.weeklyPct);
    const cls = d.fiveHourPct >= 80 ? " danger" : d.fiveHourPct >= 50 ? " warn" : "";
    const label = `This chat has drained ${five}% of a 5h session and ${week}% of the week. Click for a per-message rundown.`;
    return `<span class="sb-chip sb-drain sb-drain-btn${cls}${this.animClass("drain")}" role="button" tabindex="0" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class="ph ph-drop"></i>${five}% · ${week}%w</span>`;
  }

  // Body-appended, fixed-position rundown popover anchored to the drain chip.
  // Mirrors ToolTallyRow.openToolPopover: positioned off the anchor, dismissed
  // on outside click, torn down on close/destroy. Rebuilt in place as the chat
  // spends (refreshDrain re-calls this while open).
  private openDrainPopover(): void {
    const anchor = this.container.querySelector<HTMLElement>(".sb-drain-btn");
    if (!anchor) return;
    this.drainPopoverCleanup?.();
    this.drainPopoverCleanup = null;
    this.drainPopoverEl?.remove();

    const pop = document.createElement("div");
    pop.className = "sb-drain-popover";
    pop.innerHTML = this.drainPopoverHtml();
    document.body.appendChild(pop);
    this.drainPopoverEl = pop;

    const rect = anchor.getBoundingClientRect();
    const maxLeft = window.innerWidth - pop.offsetWidth - 8;
    pop.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
    const below = window.innerHeight - rect.bottom;
    if (below >= pop.offsetHeight + 8 || below >= rect.top) {
      pop.style.top = `${rect.bottom + 4}px`;
    } else {
      pop.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    }

    const onOutside = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        this.closeDrainPopover();
      }
    };
    setTimeout(() => document.addEventListener("click", onOutside), 0);
    this.drainPopoverCleanup = () => document.removeEventListener("click", onOutside);
  }

  private closeDrainPopover(): void {
    this.drainPopoverCleanup?.();
    this.drainPopoverCleanup = null;
    this.drainPopoverEl?.remove();
    this.drainPopoverEl = null;
  }

  private toggleDrainPopover(): void {
    if (this.drainPopoverEl) this.closeDrainPopover();
    else this.openDrainPopover();
  }

  private drainPopoverHtml(): string {
    const d = this.drain;
    if (!d) {
      return `<div class="sb-drain-empty">No drain data yet</div>`;
    }
    const five = Math.round(d.fiveHourPct);
    const week = Math.round(d.weeklyPct);
    const tokens = formatTokenCount(Number(d.tokens), { decimals: 1 });
    const header = `
      <div class="sb-drain-header">
        <span class="sb-drain-stat"><span class="sb-drain-stat-val">${five}%</span><span class="sb-drain-stat-lbl">of a 5h session</span></span>
        <span class="sb-drain-stat"><span class="sb-drain-stat-val">${week}%</span><span class="sb-drain-stat-lbl">of the week</span></span>
      </div>
      <div class="sb-drain-secondary"><i class="ph ph-coins"></i>${escapeHtml(tokens)} tokens drained</div>`;
    const rows = d.messages.length === 0
      ? `<div class="sb-drain-empty">No message breakdown yet</div>`
      : d.messages.map((m) => {
          const flag = m.expensive ? ' <i class="ph ph-warning sb-drain-flag"></i>' : "";
          const expCls = m.expensive ? " expensive" : "";
          return `<div class="sb-drain-row${expCls}" title="${escapeHtml(m.preview)}"><span class="sb-drain-idx">#${m.index}</span><span class="sb-drain-preview">${escapeHtml(m.preview)}</span>${flag}<span class="sb-drain-usd">~$${m.drainUsd.toFixed(2)}</span></div>`;
        }).join("");
    return `${header}<div class="sb-drain-list">${rows}</div>`;
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

    const aiTodosPopoverHtml = this.aiTodosPopoverOpen && this.aiTodoFiles.length > 0 ? `
      <div class="sb-ai-todos-popover">
        <div class="sb-ai-todos-popover-header">AI Todos (${this.aiTodoFiles.length})</div>
        <div class="sb-ai-todos-popover-list">
          ${this.aiTodoFiles.map((f) => `<div class="sb-ai-todos-popover-file" role="button" tabindex="0" data-path="${escapeHtml(f.path)}">${escapeHtml(f.name)}</div>`).join("")}
        </div>
      </div>
    ` : "";

    this.container.innerHTML = `
      <div class="sb-rows">${rowsHtml || '<span class="sb-empty">No chips</span>'}</div>
      ${effortPopoverHtml}
      ${modelPopoverHtml}
      ${aiTodosPopoverHtml}
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
        if (!next) return;
        const newEffort = next;
        if (this.onEffortChange) {
          this.onEffortChange(newEffort);
          this.effort = newEffort;
          this.effortPopoverOpen = false;
          this.render();
          return;
        }
        if (!this.sessionId) return;
        const sid = this.sessionId;
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

    this.container.querySelector<HTMLElement>(".sb-ai-todos-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.aiTodosPopoverOpen = !this.aiTodosPopoverOpen;
      this.effortPopoverOpen = false;
      this.modelPopoverOpen = false;
      this.render();
    });

    this.container.querySelector<HTMLElement>(".sb-drain-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleDrainPopover();
    });

    this.container.querySelectorAll<HTMLElement>(".sb-ai-todos-popover-file").forEach((el) => {
      el.addEventListener("click", () => {
        const p = el.dataset.path;
        if (p) void invoke<void>("open_in_editor", { path: p });
      });
    });

    if (this.aiTodosPopoverOpen) {
      const closeOnOutsideAiTodos = (e: MouseEvent) => {
        if (!this.container.contains(e.target as Node)) {
          this.aiTodosPopoverOpen = false;
          this.render();
          document.removeEventListener("click", closeOnOutsideAiTodos);
        }
      };
      setTimeout(() => document.addEventListener("click", closeOnOutsideAiTodos), 0);
    }

    // The drain popover is body-appended and survives re-renders, but its anchor
    // chip was just replaced. Re-anchor (rebuild + reposition) if it's open so a
    // background refresh (counts/git/etc.) doesn't leave it bound to a detached
    // node and break outside-click dismissal.
    if (this.drainPopoverEl) this.openDrainPopover();
  }
}
