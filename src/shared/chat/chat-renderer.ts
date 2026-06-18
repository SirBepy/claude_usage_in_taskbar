import type { ChatEvent } from "../../types/ipc.generated";
import { blocksToText } from "./content-blocks";
import { sessionEvents } from "./event-store";
import { cleanUserBlocks, wrapBlockquotes, RenderedMessage, renderMessage, isCompactUserMessage, isBoundaryMessage, detectStatusToken, isSilentSystemUserMessage, isResumeContinuationUserMessage, noiseAssistantLabel } from "./chat-transforms";
import { highlightCodeBlocks, highlightInlineCode } from "./code-highlighter";
import { armLazyDiffEnhance } from "./diff-enhancer";
import { hydrateAttachments } from "./attachment-hydrator";
import { parseFileEdit, type FileEditView } from "./file-edits";
import { toolSummary, canonicalTool, type ToolTally } from "./tool-meta";
import { ToolTallyState } from "./tool-tally-state";
import { handleCopyClick, handleSlashClick, handleAttachmentClick, handlePastedLogClick } from "./chat-click-handlers";
import { openFileViewer } from "./file-viewer";
import { applyTurnCollapse, groupToolRange, clampUserMessages, type ToolGroup } from "./turn-collapse";
import { renderCustomToolView } from "./tool-views";
import { ChatPaginator } from "./chat-pagination";
import { TurnFooterRegistry, type TurnChipKey, type TurnUsageTotals } from "./turn-chips";

export interface SessionMeta {
  model: string | null;
  /** Full context window input for the latest completed turn (input + cache_creation + cache_read). */
  inputTokens: number;
  hasThinking: boolean;
  /** Accumulated cost estimate across all turns (local API-rate estimate, not actual charge). */
  totalCostUsd: number;
  /** True once any TurnUsage event has been received this session. */
  hasUsage: boolean;
}

export interface CumulativeUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  turns: number;
  costUsd: number;
}

interface HandleEventOpts {
  /** Skip DOM updates; caller will batch-render later via flushRender. */
  silent?: boolean;
  /** Skip auto-scroll-to-bottom. */
  skipScroll?: boolean;
}

export class ChatRenderer {
  private container: HTMLElement;
  private messages: RenderedMessage[] = [];
  private messageEls: HTMLElement[] = [];
  private dirtyIndices = new Set<number>();
  private unsubscribe: (() => void) | null = null;
  private streamingIndex: number | null = null;
  private liveBuffer: ChatEvent[] | null = null;
  private sessionId: string | null = null;
  private _bulkGen = 0;
  private meta: SessionMeta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };
  private _cumulative: CumulativeUsage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, turns: 0, costUsd: 0 };
  private activeTurnStart: number | null = null;
  // True once the active turn has produced its end-of-turn usage (live: the
  // single `result` TurnUsage). Stops the working shimmer WITHOUT closing the
  // turn, so a later usage event (history replays one per assistant line) does
  // not orphan the turn's remaining tool rows. Reset when the next turn opens.
  private activeTurnSettled = false;
  // Per-renderer footer registry (instance state - chip keys are a local
  // sequence, a shared registry would collide across renderer instances).
  private turnFooters = new TurnFooterRegistry();
  // Key for the current turn's footer (created on user_message, frozen on
  // close). Null when no turn is in progress.
  private activeTurnChipKey: TurnChipKey | null = null;
  // Monotonically-increasing counter for chip keys. Using a counter instead of
  // Date.now() ensures uniqueness even when tests freeze system time.
  private _chipKeySeq = 0;
  // Accumulated streamed assistant text for the current turn (for live token
  // estimate). Reset at each new turn.
  private activeTurnStreamedText = "";
  // Wall-clock ms when the active turn's user message arrived. Drives the
  // live elapsed display (NEVER derive elapsed from the key - it's a counter).
  private activeTurnStartedAtMs = 0;
  // Combined usage for the active turn. History replays one turn_usage per
  // assistant line, so output/cache/cost SUM across events; input is the
  // latest (context-size semantics); durationMs is the max seen (live's
  // single result event carries the real one, history carries none).
  private activeTurnUsage: TurnUsageTotals | null = null;
  // First/last real event timestamps of the active turn - the duration
  // fallback for history, where duration_ms is absent. Live events all carry
  // timestamp 0, so the span stays 0 there (live has real duration_ms).
  private activeTurnFirstTs = 0;
  private activeTurnLastTs = 0;
  // Per-type tool-group elements for the turn in progress (key = canonical tool
  // name). Cleared at each turn end; re-populated by groupToolRange each flush.
  private activeToolGroups = new Map<string, ToolGroup>();
  private closeTurnQueue: {
    start: number;
    end: number;
    chipKey: TurnChipKey | null;
    usage: TurnUsageTotals | null;
    tsSpanMs: number;
  }[] = [];
  private fileEdits: FileEditView[] = [];
  private lastActivity: string | null = null;
  // Canonical tool of the CURRENT activity (the most recent tool_use, the one
  // `lastActivity` describes, e.g. "Editing api.ts" -> "Edit"). Drives the
  // single working-chip highlight so only the chip for what the AI is doing
  // right now pulses - not every tool that has an in-flight call. Cleared on
  // turn boundary / reset, same lifecycle as lastActivity.
  private activityToolCanon: string | null = null;
  // By-type cumulative tool tally state (counts + per-target details, dedup by
  // tool_use id). Owns the data behind the statusline `Read x4 · ...` tally.
  private tallyState = new ToolTallyState();
  public onMetaUpdate: ((meta: SessionMeta) => void) | null = null;
  public onFileEditsChanged: ((edits: FileEditView[]) => void) | null = null;
  public onToolTally: ((t: ToolTally) => void) | null = null;
  public onActivityUpdate: ((activity: string | null) => void) | null = null;
  public onStatusUpdate: ((status: "done" | "question" | "waiting" | null) => void) | null = null;
  private turnStatus: "done" | "question" | "waiting" | null = null;
  // True only while bulkLoadEvents replays HISTORY on open. During replay the
  // per-event onActivityUpdate / onFileEditsChanged callbacks are suppressed so
  // the header changes-badge doesn't visibly count up and the thinking bar
  // doesn't flip through every past activity; the final state is delivered once
  // when replay finishes. Live events (after hydration) animate normally.
  private hydrating = false;
  private paginator: ChatPaginator;

  private setTurnStatus(s: "done" | "question" | "waiting" | null): void {
    if (this.turnStatus === s) return;
    this.turnStatus = s;
    this.onStatusUpdate?.(s);
  }

  get cumulativeUsage(): CumulativeUsage {
    return { ...this._cumulative };
  }

  constructor(container: HTMLElement) {
    this.container = container;
    // Edit windows are default-collapsed; their diffs enhance on first open.
    armLazyDiffEnhance(this.container);
    this.container.addEventListener("click", handleCopyClick);
    this.container.addEventListener("click", handleSlashClick);
    this.container.addEventListener("click", handleAttachmentClick);
    this.container.addEventListener("click", handlePastedLogClick);
    this.container.addEventListener("click", this.handleToolChipClick);
    this.container.addEventListener("click", this.handleToolFileClick);
    this.paginator = new ChatPaginator(container, {
      getSessionId: () => this.sessionId,
      getMessages: () => this.messages,
      getMessageEls: () => this.messageEls,
      setMessages: (m) => { this.messages = m; },
      setMessageEls: (els) => { this.messageEls = els; },
      buildMessageEl: (m) => this.buildMessageEl(m),
      clampUserMessages: () => clampUserMessages(this.messages, this.messageEls),
      foldClosedRange: (start, end, usage, tsSpanMs) => this.foldClosedRange(start, end, usage, tsSpanMs),
      onShift: (n) => {
        if (this.streamingIndex !== null) this.streamingIndex += n;
        if (this.dirtyIndices.size > 0) {
          const reindexed = new Set<number>();
          for (const idx of this.dirtyIndices) reindexed.add(idx + n);
          this.dirtyIndices = reindexed;
        }
        if (this.activeTurnStart !== null) this.activeTurnStart += n;
        if (this.closeTurnQueue.length > 0) {
          this.closeTurnQueue = this.closeTurnQueue.map((entry) => ({
            ...entry,
            start: entry.start + n,
            end: entry.end + n,
          }));
        }
      },
    });
  }

  async attach(sessionId: string): Promise<void> {
    this.detach();
    this.sessionId = sessionId;
    this.messages = [];
    this.messageEls = [];
    this.dirtyIndices.clear();
    this.streamingIndex = null;
    this.meta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };
    this._cumulative = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, turns: 0, costUsd: 0 };
    this.fileEdits = [];
    this.lastActivity = null;
    this.activityToolCanon = null;
    this.activeToolGroups.clear();
    this.tallyState.reset();
    this.onFileEditsChanged?.([]);
    this.onToolTally?.(this.tallyState.build());
    this.onActivityUpdate?.(null);
    this.container.innerHTML = "";
    this.activeTurnStart = null;
    this.resetActiveTurnMeta();
    this.turnFooters.clear();
    this.closeTurnQueue = [];
    this.unsubscribe = sessionEvents.subscribe(sessionId, (ev) => {
      this.handleLive(ev);
    });
  }

  private handleLive(ev: ChatEvent): void {
    if (this.liveBuffer !== null) {
      this.liveBuffer.push(ev);
    } else {
      this.handleEvent(ev);
    }
  }

  async loadFromStore(cwd?: string): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.paginator.cwdHint = cwd;
    const events = [...(await sessionEvents.loadInitial(sid, cwd))];
    if (this.sessionId !== sid) return;
    await this.bulkLoadEvents(events);
    if (this.sessionId !== sid) return;
    this.paginator.install();
  }

  detach(): void {
    if (this.unsubscribe) {
      try { this.unsubscribe(); } catch { /* ignore */ }
      this.unsubscribe = null;
    }
    this.paginator.remove();
    this.paginator.resetTurnCarry();
    this.streamingIndex = null;
    this.dirtyIndices.clear();
    this.activeTurnStart = null;
    this.resetActiveTurnMeta();
    this.turnFooters.clear();
    this.activeToolGroups.clear();
    this.closeTurnQueue = [];
    this.setActivity(null);
    this.sessionId = null;
    // A load aborted mid-flight (detach before its settle reveal) must never
    // leave the transcript stuck at opacity 0 when the container is reused.
    this.revealTranscript();
  }

  async swapSubscription(newSessionId: string): Promise<void> {
    if (this.sessionId === newSessionId) return;
    const oldId = this.sessionId;
    if (this.unsubscribe) {
      try { this.unsubscribe(); } catch { /* ignore */ }
      this.unsubscribe = null;
    }
    this.sessionId = newSessionId;
    if (oldId) await sessionEvents.swap(oldId, newSessionId);
    this.unsubscribe = sessionEvents.subscribe(newSessionId, (ev) => {
      this.handleLive(ev);
    });
  }

  /** Exposed for tests that drive pagination without a real IntersectionObserver. */
  fetchOlder(): Promise<void> {
    return this.paginator.fetchOlder();
  }

  currentSessionId(): string | null {
    return this.sessionId;
  }

  getMeta(): SessionMeta {
    return { ...this.meta };
  }

  getFileEdits(): FileEditView[] {
    return [...this.fileEdits];
  }

  /** Clone of the by-type tool tally (no internal refs leaked). */
  get toolTally(): ToolTally {
    return this.tallyState.build();
  }

  /**
   * Rendered custom-view HTML for a tool over ALL loaded messages, or null when
   * the tool has no custom view. Lets the statusline tally popover reuse the
   * exact same Read/File-Changes/Skills/Questions views as the in-chat chips.
   */
  customToolView(tool: string): string | null {
    return renderCustomToolView(tool, this.messages, 0, this.messages.length);
  }

  private describeActivity(toolName: string, input: unknown): string {
    const { target } = toolSummary(toolName, input);
    let s: string;
    switch (toolName) {
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit":
        s = `Editing ${target}`;
        break;
      case "Write":
        s = `Writing ${target}`;
        break;
      case "Read":
        s = `Reading ${target}`;
        break;
      case "Bash":
      case "PowerShell":
        s = `Running: ${target}`;
        break;
      case "Grep":
        s = `Grepping ${target}`;
        break;
      case "Glob":
        s = `Searching ${target}`;
        break;
      default:
        s = `${toolName}…`;
    }
    return s.length > 60 ? s.slice(0, 59) + "…" : s;
  }

  private setActivity(a: string | null): void {
    // Activity cleared (turn boundary / new assistant text) -> the working-chip
    // highlight has nothing to track anymore.
    if (a === null) this.activityToolCanon = null;
    if (this.lastActivity === a) return;
    this.lastActivity = a;
    // Suppressed during history replay; the final activity is fired once when
    // bulkLoadEvents finishes (see `hydrating`).
    if (!this.hydrating) this.onActivityUpdate?.(a);
  }

  async loadHistory(events: ChatEvent[]): Promise<void> {
    await this.bulkLoadEvents(events);
  }

  private async bulkLoadEvents(events: ChatEvent[]): Promise<void> {
    const myGen = ++this._bulkGen;
    this.liveBuffer = [];
    this.messages = [];
    this.messageEls = [];
    this.dirtyIndices.clear();
    this.streamingIndex = null;
    this.fileEdits = [];
    this.lastActivity = null;
    this.activityToolCanon = null;
    this.activeToolGroups.clear();
    this.activeTurnStart = null;
    this.resetActiveTurnMeta();
    this.turnFooters.clear();
    this.closeTurnQueue = [];
    this.paginator.resetTurnCarry();
    this.tallyState.reset();
    this.onFileEditsChanged?.([]);
    this.onToolTally?.(this.tallyState.build());
    this.onActivityUpdate?.(null);
    this.container.innerHTML = "";
    // Replay history with the per-event header/thinking-bar callbacks gated; the
    // accumulated final state is fired once below (after the chunk loop).
    this.hydrating = true;
    // Hold the transcript hidden while it assembles. The build is visibly ugly
    // - rows paint top-down, fold into chips, the view snaps to the bottom, and
    // shiki recolors code - all in ~100ms. We reveal the finished frame in one
    // fade once the settle pass has folded, pinned, and highlighted it.
    this.beginRevealHold();
    const CHUNK = 8;
    for (let i = 0; i < events.length; i += CHUNK) {
      if (this._bulkGen !== myGen) { this.liveBuffer = null; this.hydrating = false; return; }
      for (let j = i; j < Math.min(i + CHUNK, events.length); j++) {
        this.handleEvent(events[j]!, { silent: true, skipScroll: true });
      }
      this.flushRender();
      if (i + CHUNK < events.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (this._bulkGen !== myGen) { this.liveBuffer = null; this.hydrating = false; return; }
    // History replay is done: deliver the FINAL header badge + thinking-bar
    // state in ONE shot (per-event updates were gated above so the badge didn't
    // count up and the bar didn't flip through every past activity). A done turn
    // leaves lastActivity null -> the bar clears; a still-busy turn shows its
    // last activity, and buffered live events below take over from there.
    this.hydrating = false;
    this.onFileEditsChanged?.(this.getFileEdits());
    this.onActivityUpdate?.(this.lastActivity);
    // The final turn of the load never gets a closing user_message: settle its
    // meta row from whatever usage accumulated (re-settleable if the session
    // is live and more usage streams in after this).
    if (this.activeTurnChipKey !== null && this.activeTurnUsage) {
      const u = this.activeTurnUsage;
      this.turnFooters.settleMetaRow(this.activeTurnChipKey, {
        ...u,
        durationMs: u.durationMs > 0 ? u.durationMs : this.activeTurnTsSpan(),
      });
    }
    this.foldLeadingPartialTurn();
    this.scrollToBottom();
    const buffered = this.liveBuffer;
    this.liveBuffer = null;
    for (const ev of buffered) {
      this.handleEvent(ev);
    }
    // The scroll above runs before async content settles: shiki code
    // highlighting and attachment/image hydration grow the transcript height
    // AFTER it, so the newest turn's chips ended up cut off below the fold on
    // open. Re-pin to the bottom once that settles. Generation-guarded so a
    // newer load/attach started in the meantime never gets yanked.
    void this.scrollToBottomWhenSettled(myGen);
  }

  /**
   * Re-pin to the bottom after the bulk load's async content has grown the
   * transcript: await the code-highlight pass (it replaces each <pre> with a
   * taller shiki block), then scroll, then scroll once more on the next
   * macrotask to catch late attachment/image/font reflow. Initial-load pin, so
   * it does NOT gate on isNearBottom (async growth above the fold pushes the
   * bottom out of view, which would read as "scrolled up" and wrongly skip).
   */
  private async scrollToBottomWhenSettled(gen: number): Promise<void> {
    // Reveal no later than this even if shiki is slow on a huge code-heavy load,
    // so the transcript never stays blank for an awkward beat. The settle path
    // below reveals earlier (the common, fast case) and reveal is idempotent.
    const safety = setTimeout(() => {
      if (this._bulkGen === gen) this.revealTranscript();
    }, 220);
    try { await highlightCodeBlocks(this.container); } catch { /* ignore */ }
    highlightInlineCode(this.container);
    if (this._bulkGen !== gen || !this.sessionId) { clearTimeout(safety); return; }
    this.scrollToBottom();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clearTimeout(safety);
    if (this._bulkGen !== gen || !this.sessionId) return;
    this.scrollToBottom();
    this.revealTranscript();
  }

  /**
   * Hide the transcript instantly (no fade-out) so its build is invisible.
   * Paired with revealTranscript, which fades the finished frame back in.
   */
  private beginRevealHold(): void {
    this.container.style.transition = "none";
    this.container.style.opacity = "0";
    // Start slightly below resting so the reveal settles UP into place.
    this.container.style.transform = "translateY(8px)";
  }

  /**
   * Fade + slide the assembled transcript in. Idempotent: a no-op once already
   * shown, so the settle reveal, the safety-timeout reveal, and the detach reset
   * can all call it freely.
   */
  private revealTranscript(): void {
    if (this.container.style.opacity === "" || this.container.style.opacity === "1") return;
    // Commit the opacity:0 / offset paint before enabling the transition, else
    // the browser coalesces both into one frame and there is no animation.
    void this.container.offsetHeight;
    this.container.style.transition = "opacity 150ms ease, transform 180ms ease";
    this.container.style.opacity = "1";
    this.container.style.transform = "translateY(0)";
  }

  handleEvent(ev: ChatEvent, opts: HandleEventOpts = {}): void {
    const ts = "timestamp" in ev ? Number((ev as { timestamp: bigint }).timestamp) : Date.now();
    // Capture before mutating: if the user had scrolled up to read history, we
    // preserve their position instead of yanking them to the bottom on a live
    // update. Sending a user_message leaves them at the bottom anyway, so the
    // gate naturally re-engages auto-scroll for their own messages.
    const wasAtBottom = this.isNearBottom();
    let touched = false;
    switch (ev.type) {
      case "session_started":
        this.meta = { model: ev.model || null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };
        this.onMetaUpdate?.(this.getMeta());
        this.messages.push({
          kind: "system",
          text: `Session started${ev.model ? ` (${ev.model})` : ""}`,
          ts,
        });
        touched = true;
        break;
      case "user_message": {
        // Only a message the USER actually sent (or a compaction) is a turn
        // boundary. Real streams deliver every tool result as a user-role
        // line whose blocks the parser drops (content empty) - rotating the
        // turn for those split the footer per tool cycle ("tokens split up
        // per answer"). Decide visibility FIRST, rotate after.
        const isCompact = isCompactUserMessage(ev.content);
        const cleaned = isCompact ? [] : cleanUserBlocks(ev.content);
        if (!isCompact && cleaned.length === 0) break;
        // Drop the resume system's "Continue from where you left off." turn - the
        // user never typed it; the assistant's "Continuing chat" notice is the marker.
        if (!isCompact && isResumeContinuationUserMessage(cleaned)) break;
        // Silent system turns (e.g. rate-limit auto-continue) rotate the turn
        // chip so usage is tracked but render no user bubble.
        const isSilent = !isCompact && isSilentSystemUserMessage(cleaned);
        this.enqueueTurnClose();
        this.setActivity(null);
        this.setTurnStatus(null);
        // Open a new turn footer. The key is a sequence counter (unique even
        // when tests freeze system time); the wall-clock start drives the
        // live elapsed display.
        this.activeTurnChipKey = ++this._chipKeySeq;
        this.activeTurnStreamedText = "";
        this.activeTurnStartedAtMs = Date.now();
        this.activeTurnUsage = null;
        this.activeTurnFirstTs = ts > 0 ? ts : 0;
        this.activeTurnLastTs = this.activeTurnFirstTs;
        if (isCompact) {
          this.messages.push({ kind: "system", text: "Conversation compacted", ts });
        } else if (isSilent) {
          this.messages.push({ kind: "system", text: "Continuing session…", ts });
        } else {
          this.messages.push({ kind: "user", content: cleaned, ts });
        }
        this.activeTurnStart = this.messages.length;
        touched = true;
        break;
      }
      case "assistant_message": {
        if (!ev.streaming) {
          const msgText = blocksToText(ev.content).trim();
          const noiseLabel = noiseAssistantLabel(msgText);
          if (noiseLabel !== null) {
            // Internal CLI messages become inline system notices.
            // Finalize any in-progress streaming bubble first.
            if (this.streamingIndex !== null) {
              const existing = this.messages[this.streamingIndex] as RenderedMessage;
              this.messages[this.streamingIndex] = { ...existing, streaming: false };
              this.dirtyIndices.add(this.streamingIndex);
              this.streamingIndex = null;
            }
            this.messages.push({ kind: "system", text: noiseLabel, ts });
            this.setTurnStatus(null);
            touched = true;
            break;
          }
        }
        const msg: RenderedMessage = {
          kind: "assistant",
          content: ev.content,
          streaming: ev.streaming,
          ts,
        };
        if (ev.streaming) {
          if (this.streamingIndex !== null) {
            this.messages[this.streamingIndex] = msg;
            this.dirtyIndices.add(this.streamingIndex);
          } else {
            this.streamingIndex = this.messages.length;
            this.messages.push(msg);
          }
        } else {
          if (this.streamingIndex !== null) {
            this.messages[this.streamingIndex] = msg;
            this.dirtyIndices.add(this.streamingIndex);
            this.streamingIndex = null;
          } else {
            this.messages.push(msg);
          }
        }
        if (!ev.streaming) {
          const joined = blocksToText(ev.content);
          this.setTurnStatus(detectStatusToken(joined));
        }
        // Update live token estimate from accumulated streamed assistant text
        if (this.activeTurnChipKey !== null) {
          const joined = blocksToText(ev.content);
          this.activeTurnStreamedText = joined;
          this.turnFooters.updateLiveTokenEstimate(this.activeTurnChipKey, joined);
        }
        touched = true;
        break;
      }
      case "tool_use": {
        this.messages.push({
          kind: "tool_use",
          tool: ev.tool_name,
          input: ev.input,
          id: ev.id,
          ts,
          parentToolUseId: ev.parent_tool_use_id ?? null,
        });
        const view = parseFileEdit(ev.tool_name, ev.input);
        if (view) {
          this.fileEdits.push(view);
          // Suppressed during history replay so the header badge doesn't count
          // up; the final total is fired once when bulkLoadEvents finishes.
          if (!this.hydrating) this.onFileEditsChanged?.(this.getFileEdits());
        }
        {
          const t = this.tallyState.tallyToolUse(ev.tool_name, ev.input, ev.id);
          if (t) this.onToolTally?.(t);
        }
        this.activityToolCanon = canonicalTool(ev.tool_name);
        this.setActivity(this.describeActivity(ev.tool_name, ev.input));
        touched = true;
        break;
      }
      case "tool_result": {
        this.messages.push({
          kind: "tool_result",
          tool_use_id: ev.tool_use_id,
          output: ev.output,
          is_error: ev.is_error,
          ts,
        });
        // The tally counts didn't change, but a result can complete a custom
        // view (e.g. an AskUserQuestion answer): nudge the statusline so an open
        // popover re-renders from the now-updated messages.
        this.onToolTally?.(this.tallyState.build());
        touched = true;
        break;
      }
      case "notification":
        this.messages.push({ kind: "notification", text: ev.body, ts: Date.now() });
        touched = true;
        break;
      case "session_ended":
        this.enqueueTurnClose();
        this.messages.push({
          kind: "system",
          text: `Session ended${ev.exit_code !== null ? ` (exit ${ev.exit_code})` : ""}`,
          ts,
        });
        touched = true;
        break;
      case "turn_usage": {
        const totalCtx = Number(ev.input_tokens) + Number(ev.cache_creation_input_tokens) + Number(ev.cache_read_input_tokens);
        console.debug("[ctx] turn_usage", { model: ev.model, input: Number(ev.input_tokens), cacheCreate: Number(ev.cache_creation_input_tokens), cacheRead: Number(ev.cache_read_input_tokens), output: Number(ev.output_tokens), totalCtx });
        this.meta.inputTokens = totalCtx;
        this.meta.totalCostUsd += ev.total_cost_usd;
        this.meta.hasUsage = true;
        if (ev.has_thinking) this.meta.hasThinking = true;
        if (ev.model) this.meta.model = ev.model;
        this._cumulative.input += Number(ev.input_tokens) || 0;
        this._cumulative.output += Number(ev.output_tokens) || 0;
        this._cumulative.cacheCreate += Number(ev.cache_creation_input_tokens) || 0;
        this._cumulative.cacheRead += Number(ev.cache_read_input_tokens) || 0;
        this._cumulative.costUsd += Number(ev.total_cost_usd) || 0;
        this._cumulative.turns += 1;
        this.onMetaUpdate?.(this.getMeta());
        // A turn boundary is the next USER message, not this usage event - so we
        // settle the turn (stop the shimmer) but keep it OPEN. Live emits one
        // usage at turn end; history emits one per assistant line, and closing
        // here would orphan the turn's remaining tool rows on reload (the "chips
        // vanish when I reopen the chat" bug).
        //
        // Only the AUTHORITATIVE end-of-turn usage settles the working shimmer.
        // An open chat runs the frontend transcript watcher alongside the runner
        // stream; the watcher re-parses each assistant line (history mode) and
        // emits a usage event per line with duration_ms 0, MID-TURN. Settling on
        // those makes a live turn look done between assistant lines (gray border,
        // no activity text, frozen tokens during a long tool call). The runner's
        // real turn-end usage carries a non-zero duration_ms; bulk replay
        // (opts.silent) is already-complete history, so settle as before.
        if (opts.silent || Number(ev.duration_ms) > 0) {
          this.activeTurnSettled = true;
        }
        // Accumulate the turn's COMBINED usage. History replays one usage
        // event per assistant line: output/cache/cost sum, input is the
        // latest (context size), duration keeps the max (only live's single
        // result event carries a real one). The meta row freezes from these
        // totals - at turn close for history, right here for live.
        if (this.activeTurnChipKey !== null) {
          const u = this.activeTurnUsage ?? {
            durationMs: 0, outputTokens: 0, inputTokens: 0,
            cacheCreate: 0, cacheRead: 0, costUsd: 0,
          };
          u.outputTokens += Number(ev.output_tokens) || 0;
          u.inputTokens = Number(ev.input_tokens) || u.inputTokens;
          u.cacheCreate += Number(ev.cache_creation_input_tokens) || 0;
          u.cacheRead += Number(ev.cache_read_input_tokens) || 0;
          u.costUsd += Number(ev.total_cost_usd) || 0;
          u.durationMs = Math.max(u.durationMs, Number(ev.duration_ms) || 0);
          this.activeTurnUsage = u;
          // Live path: settle immediately so the row stops ticking the moment
          // usage lands. Watched external sessions stream one usage per
          // assistant line; each re-settle overwrites with the bigger sums.
          if (!opts.silent) {
            this.ensureActiveTurnFooter();
            this.turnFooters.settleMetaRow(this.activeTurnChipKey, {
              ...u,
              durationMs: u.durationMs > 0 ? u.durationMs : this.activeTurnTsSpan(),
            });
          }
        }
        if (!opts.silent) {
          this.flushRender();
        }
        return;
      }
      default:
        break;
    }
    if (!touched) return;
    // Track the turn's timestamp span (history duration fallback). Live
    // events carry timestamp 0 and never move these.
    if (ts > 0 && this.activeTurnChipKey !== null) {
      if (this.activeTurnFirstTs === 0) this.activeTurnFirstTs = ts;
      if (ts > this.activeTurnLastTs) this.activeTurnLastTs = ts;
    }
    if (!opts.silent) {
      this.flushRender();
      if (!opts.skipScroll && wasAtBottom) this.scrollToBottom();
    }
  }

  private flushRender(): void {
    if (this.dirtyIndices.size > 0) {
      for (const idx of this.dirtyIndices) {
        if (idx < this.messageEls.length) {
          const newEl = this.buildMessageEl(this.messages[idx]!);
          const oldEl = this.messageEls[idx]!;
          oldEl.replaceWith(newEl);
          this.messageEls[idx] = newEl;
        }
      }
      this.dirtyIndices.clear();
    }
    if (this.messageEls.length < this.messages.length) {
      const frag = document.createDocumentFragment();
      while (this.messageEls.length < this.messages.length) {
        const idx = this.messageEls.length;
        const el = this.buildMessageEl(this.messages[idx]!);
        frag.appendChild(el);
        this.messageEls.push(el);
      }
      this.container.appendChild(frag);
    }
    if (this.activeTurnStart !== null) {
      for (let i = this.activeTurnStart; i < this.messageEls.length; i++) {
        const el = this.messageEls[i];
        const msg = this.messages[i];
        if (el && msg && msg.kind !== "user") {
          // Shimmer while the turn is in flight; drop it once the turn settles
          // (its end-of-turn usage arrived) even though the turn stays open.
          el.classList.toggle("msg--working", !this.activeTurnSettled);
        }
      }
    }
    this.processTurnCloseQueue();
    this.ensureActiveTurnFooter();
    if (this.activeTurnStart !== null) {
      const footer = this.activeTurnChipKey !== null ? this.turnFooters.getOrCreateFooter(this.activeTurnChipKey) : null;
      groupToolRange(this.messages, this.messageEls, this.activeTurnStart, this.messages.length, this.activeToolGroups, footer);
    }
    this.applyRunningHighlight();
    void highlightCodeBlocks(this.container);
    wrapBlockquotes(this.container);
    highlightInlineCode(this.container);
    clampUserMessages(this.messages, this.messageEls);
  }

  /** The active turn's history-timestamp span (duration fallback), or 0. */
  private activeTurnTsSpan(): number {
    if (this.activeTurnFirstTs <= 0 || this.activeTurnLastTs <= this.activeTurnFirstTs) return 0;
    const span = this.activeTurnLastTs - this.activeTurnFirstTs;
    // Distrust spans over 24h: mixed/garbage timestamps, hide the chip instead.
    return span <= 24 * 3600 * 1000 ? span : 0;
  }

  /**
   * Ensure the active turn's footer exists and is the LAST child of the
   * container, so it always sits below everything the turn has rendered.
   * Once the turn closes the footer stays pinned where it is (the next user
   * message renders after it). Live turns also get the ticking meta row;
   * bulk loads skip it (their rows settle from real totals at close).
   */
  private ensureActiveTurnFooter(): void {
    if (this.activeTurnChipKey === null) return;
    const footer = this.turnFooters.getOrCreateFooter(this.activeTurnChipKey);
    if (footer !== this.container.lastElementChild) {
      this.container.appendChild(footer);
    }
    if (this.liveBuffer === null) {
      this.turnFooters.ensureLiveMetaRow(this.activeTurnChipKey, this.activeTurnStartedAtMs || Date.now());
      if (this.activeTurnStreamedText) {
        this.turnFooters.updateLiveTokenEstimate(this.activeTurnChipKey, this.activeTurnStreamedText);
      }
    }
  }

  /**
   * Fold the loaded window's LEADING partial turn at initial load.
   *
   * `read_page` cuts the window by assistant-reply count, so it almost always
   * begins MID-turn: the rows before the first real boundary (the turn's
   * opening user message lives below the window) were rendered flat, because no
   * turn was open to group them when they streamed through bulkLoadEvents. That
   * left raw Read/Grep/... cards on screen until the user scrolled up far enough
   * for pagination to prepend the older batch and heal them.
   *
   * Run that same heal once here, at load: fold those leading rows into a chip
   * strip immediately. We have no usage for the turn (its turn_usage events
   * arrived before any turn was open and were dropped), so the meta row stays
   * absent until pagination brings the opening message - strictly better than
   * the flat cards shown before. No-op when the window already starts at a
   * boundary (no leading partial turn) or is empty.
   */
  private foldLeadingPartialTurn(): void {
    if (this.messages.length === 0) return;
    if (isBoundaryMessage(this.messages[0]!)) return;
    let end = this.messages.length;
    for (let i = 0; i < this.messages.length; i++) {
      if (isBoundaryMessage(this.messages[i]!)) { end = i; break; }
    }
    this.foldClosedRange(0, end, null, 0);
  }

  /**
   * Fold a CLOSED turn range that arrived via pagination prepend (or heal the
   * window's leading partial turn once its opening user message arrives).
   * Reuses the turn's existing footer when some of its rows were folded
   * earlier (chunk straddling); otherwise creates one before the range's
   * closing boundary element and settles its meta row from the usage the
   * paginator accumulated out of the raw events.
   */
  private foldClosedRange(
    start: number,
    end: number,
    usage: TurnUsageTotals | null,
    tsSpanMs: number,
  ): void {
    if (end <= start) return;
    // An existing footer for this turn: rows folded earlier live inside its
    // strip buckets.
    let footer: HTMLElement | null = null;
    for (let i = start; i < end; i++) {
      const f = this.messageEls[i]?.closest<HTMLElement>(".turn-footer");
      if (f) { footer = f; break; }
    }
    const totals = usage
      ? { ...usage, durationMs: usage.durationMs > 0 ? usage.durationMs : tsSpanMs }
      : null;
    if (!footer) {
      // Skip the footer entirely for a turn with nothing to show (no usage,
      // no foldable tool rows) - an empty box helps nobody.
      const hasToolRows = this.messages
        .slice(start, end)
        .some((m) => m.kind === "tool_use" || m.kind === "tool_result");
      if (!totals && !hasToolRows) {
        applyTurnCollapse(this.messages, this.messageEls, start, end, null);
        return;
      }
      const key = ++this._chipKeySeq;
      footer = this.turnFooters.getOrCreateFooter(key);
      const anchor = this.messageEls[end] ?? null;
      if (anchor && anchor.parentElement === this.container) {
        this.container.insertBefore(footer, anchor);
      } else {
        const last = this.messageEls[end - 1];
        if (last && last.parentElement === this.container) last.after(footer);
        else this.container.appendChild(footer);
      }
      if (totals) this.turnFooters.settleMetaRow(key, totals);
    } else if (totals && !footer.querySelector(".turn-meta-chips")) {
      const key = Number(footer.dataset.turnId);
      if (Number.isFinite(key)) this.turnFooters.settleMetaRow(key, totals);
    }
    applyTurnCollapse(this.messages, this.messageEls, start, end, footer);
  }

  private enqueueTurnClose(): void {
    // The next turn folds into fresh groups; closed-turn rows already carry
    // data-tool-grouped, so processTurnCloseQueue won't re-fold them.
    this.clearRunningHighlight();
    this.activeToolGroups.clear();
    this.activeTurnSettled = false;
    if (this.activeTurnChipKey !== null) {
      this.closeTurnQueue.push({
        start: this.activeTurnStart ?? this.messages.length,
        end: this.messages.length,
        chipKey: this.activeTurnChipKey,
        usage: this.activeTurnUsage,
        tsSpanMs: this.activeTurnTsSpan(),
      });
    }
    this.resetActiveTurnMeta();
    this.activeTurnStart = null;
  }

  /**
   * Drop the "currently working" pulse from a turn's chips and forget its
   * in-flight calls. Called when the turn closes (the next user message) so a
   * tool that never reported a result can't leave its chip pulsing forever.
   */
  private clearRunningHighlight(): void {
    if (this.activeTurnChipKey !== null) {
      const footer = this.turnFooters.getOrCreateFooter(this.activeTurnChipKey);
      footer.querySelectorAll<HTMLElement>(".tool-chip--running")
        .forEach((c) => c.classList.remove("tool-chip--running"));
    }
    this.activityToolCanon = null;
  }

  /**
   * Pulse the SINGLE main-strip chip for the AI's current activity (the tool the
   * `lastActivity` line describes, e.g. "Editing api.ts" -> the File-Changes
   * chip). Only that chip pulses - NOT every tool with an in-flight call, which
   * lit up the whole strip during parallel calls / subagent turns. Live only:
   * bulk replay nets every result and the transcript is hidden until it settles,
   * so a pulse there would be both invisible and misleading.
   */
  private applyRunningHighlight(): void {
    if (this.liveBuffer !== null || this.activeTurnChipKey === null) return;
    const footer = this.turnFooters.getOrCreateFooter(this.activeTurnChipKey);
    // The main strip is a direct child of the footer (subagent strips live
    // deeper inside buckets - we only pulse top-level chips). Walk children
    // directly rather than rely on :scope, which jsdom handles inconsistently.
    const strip = [...footer.children].find(
      (c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains("tool-strip"),
    );
    if (!strip) return;
    for (const node of strip.children) {
      if (!(node instanceof HTMLElement) || !node.classList.contains("tool-chip")) continue;
      const tool = node.dataset.tool;
      const running = !!tool && tool === this.activityToolCanon;
      node.classList.toggle("tool-chip--running", running);
    }
  }

  /** Clear all per-turn meta tracking (key, usage, timestamps, streamed text). */
  private resetActiveTurnMeta(): void {
    this.activeTurnChipKey = null;
    this.activeTurnStreamedText = "";
    this.activeTurnStartedAtMs = 0;
    this.activeTurnUsage = null;
    this.activeTurnFirstTs = 0;
    this.activeTurnLastTs = 0;
  }

  private processTurnCloseQueue(): void {
    if (this.closeTurnQueue.length === 0) return;
    for (const { start, end, chipKey, usage, tsSpanMs } of this.closeTurnQueue) {
      let footer: HTMLElement | null = null;
      if (chipKey !== null) {
        footer = this.turnFooters.getOrCreateFooter(chipKey);
        // Pin the footer at the turn's bottom: right before the next turn's
        // first element (always a direct container child), else at the end.
        const anchor = this.messageEls[end] ?? null;
        if (anchor && anchor.parentElement === this.container) {
          this.container.insertBefore(footer, anchor);
        } else if (footer.parentElement !== this.container) {
          this.container.appendChild(footer);
        }
        if (usage) {
          // History turns have no duration_ms; fall back to the ts span.
          this.turnFooters.settleMetaRow(chipKey, {
            ...usage,
            durationMs: usage.durationMs > 0 ? usage.durationMs : tsSpanMs,
          });
        } else {
          // No usage ever arrived (interrupted live turn): freeze the live
          // row at its last elapsed/estimate. No-op when no row exists.
          this.turnFooters.cancelMetaRow(chipKey);
        }
      }
      applyTurnCollapse(this.messages, this.messageEls, start, end, footer);
    }
    this.closeTurnQueue = [];
  }

  // Custom chip-panel file rows (Read / File Changes) open their target in the
  // in-app read-only file viewer (ai_todo 95 slice 1). The external-editor jump
  // is preserved via the "Open in VS Code" button in the viewer header.
  private handleToolFileClick = (e: MouseEvent): void => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tool-file-row[data-path]");
    if (!row) return;
    const path = row.dataset.path;
    if (path) openFileViewer(path);
  };

  private handleToolChipClick = (e: MouseEvent): void => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".tool-chip");
    if (!chip) return;
    const strip = chip.closest<HTMLElement>(".tool-strip");
    const panel = strip?.nextElementSibling as HTMLElement | null;
    if (!panel?.classList.contains("tool-strip-panel")) return;

    const tool = chip.dataset.tool;
    const wasActive = chip.classList.contains("tool-chip--active");

    // Scope to DIRECT-child chips/groups so a click at one nesting level never
    // toggles a deeper level's chips/buckets (3-level: Subagent > subagent > tool).
    strip?.querySelectorAll<HTMLElement>(":scope > .tool-chip").forEach(c => c.classList.remove("tool-chip--active"));
    for (const grp of panel.querySelectorAll<HTMLElement>(":scope > .tool-strip-group")) {
      grp.hidden = true;
    }

    if (!wasActive && tool) {
      chip.classList.add("tool-chip--active");
      for (const grp of panel.querySelectorAll<HTMLElement>(":scope > .tool-strip-group")) {
        grp.hidden = grp.dataset.tool !== tool;
      }
      panel.hidden = false;
    } else {
      panel.hidden = true;
    }
  };

  private buildMessageEl(m: RenderedMessage): HTMLElement {
    const wrap = document.createElement("div");
    wrap.innerHTML = renderMessage(m);
    const el = wrap.firstElementChild as HTMLElement;
    if (el.querySelector(".attachment-chip[data-attachment-path]")) {
      void hydrateAttachments(el);
    }
    return el;
  }

  /** Distance (px) from the bottom within which we still treat the user as "at the bottom". */
  private static readonly SCROLL_BOTTOM_THRESHOLD = 64;

  /**
   * True when the scroll position is at (or within SCROLL_BOTTOM_THRESHOLD px of)
   * the bottom of the container, so a live update should keep following along.
   */
  private isNearBottom(): boolean {
    const el = this.container;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= ChatRenderer.SCROLL_BOTTOM_THRESHOLD;
  }

  private scrollToBottom(): void {
    this.container.scrollTop = this.container.scrollHeight;
  }
}
