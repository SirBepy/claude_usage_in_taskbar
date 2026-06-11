import type { ChatEvent } from "../../types/ipc.generated";
import { sessionEvents } from "./event-store";
import { cleanUserBlocks, wrapBlockquotes, RenderedMessage, renderMessage, isCompactUserMessage, detectStatusToken } from "./chat-transforms";
import { highlightCodeBlocks } from "./code-highlighter";
import { armLazyDiffEnhance } from "./diff-enhancer";
import { hydrateAttachments } from "./attachment-hydrator";
import { parseFileEdit, type FileEditView } from "./file-edits";
import { toolSummary, type ToolTally } from "./tool-meta";
import { ToolTallyState } from "./tool-tally-state";
import { handleCopyClick, handleSlashClick, handleAttachmentClick, handlePastedLogClick } from "./chat-click-handlers";
import { applyTurnCollapse, groupToolRange, clampUserMessages, type ToolGroup } from "./turn-collapse";
import { ChatPaginator } from "./chat-pagination";

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
  // Per-type tool-group elements for the turn in progress (key = canonical tool
  // name). Cleared at each turn end; re-populated by groupToolRange each flush.
  private activeToolGroups = new Map<string, ToolGroup>();
  private closeTurnQueue: { start: number; end: number }[] = [];
  private fileEdits: FileEditView[] = [];
  private lastActivity: string | null = null;
  // By-type cumulative tool tally state (counts + per-target details, dedup by
  // tool_use id). Owns the data behind the statusline `Read x4 · ...` tally.
  private tallyState = new ToolTallyState();
  public onMetaUpdate: ((meta: SessionMeta) => void) | null = null;
  public onFileEditsChanged: ((edits: FileEditView[]) => void) | null = null;
  public onToolTally: ((t: ToolTally) => void) | null = null;
  public onActivityUpdate: ((activity: string | null) => void) | null = null;
  public onStatusUpdate: ((status: "done" | "question" | null) => void) | null = null;
  private turnStatus: "done" | "question" | null = null;
  private paginator: ChatPaginator;

  private setTurnStatus(s: "done" | "question" | null): void {
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
    this.paginator = new ChatPaginator(container, {
      getSessionId: () => this.sessionId,
      getMessages: () => this.messages,
      getMessageEls: () => this.messageEls,
      setMessages: (m) => { this.messages = m; },
      setMessageEls: (els) => { this.messageEls = els; },
      buildMessageEl: (m) => this.buildMessageEl(m),
      clampUserMessages: () => clampUserMessages(this.messages, this.messageEls),
      onShift: (n) => {
        if (this.streamingIndex !== null) this.streamingIndex += n;
        if (this.dirtyIndices.size > 0) {
          const reindexed = new Set<number>();
          for (const idx of this.dirtyIndices) reindexed.add(idx + n);
          this.dirtyIndices = reindexed;
        }
        if (this.activeTurnStart !== null) this.activeTurnStart += n;
        if (this.closeTurnQueue.length > 0) {
          this.closeTurnQueue = this.closeTurnQueue.map(({ start, end }) => ({
            start: start + n,
            end: end + n,
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
    this.activeToolGroups.clear();
    this.tallyState.reset();
    this.onFileEditsChanged?.([]);
    this.onToolTally?.(this.tallyState.build());
    this.onActivityUpdate?.(null);
    this.container.innerHTML = "";
    this.activeTurnStart = null;
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
    this.streamingIndex = null;
    this.dirtyIndices.clear();
    this.activeTurnStart = null;
    this.activeToolGroups.clear();
    this.closeTurnQueue = [];
    this.setActivity(null);
    this.sessionId = null;
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
    if (this.lastActivity === a) return;
    this.lastActivity = a;
    this.onActivityUpdate?.(a);
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
    this.activeToolGroups.clear();
    this.tallyState.reset();
    this.onFileEditsChanged?.([]);
    this.onToolTally?.(this.tallyState.build());
    this.onActivityUpdate?.(null);
    this.container.innerHTML = "";
    const CHUNK = 8;
    for (let i = 0; i < events.length; i += CHUNK) {
      if (this._bulkGen !== myGen) { this.liveBuffer = null; return; }
      for (let j = i; j < Math.min(i + CHUNK, events.length); j++) {
        this.handleEvent(events[j]!, { silent: true, skipScroll: true });
      }
      this.flushRender();
      if (i + CHUNK < events.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (this._bulkGen !== myGen) { this.liveBuffer = null; return; }
    this.scrollToBottom();
    const buffered = this.liveBuffer;
    this.liveBuffer = null;
    for (const ev of buffered) {
      this.handleEvent(ev);
    }
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
        this.enqueueTurnClose();
        this.setActivity(null);
        this.setTurnStatus(null);
        if (isCompactUserMessage(ev.content)) {
          this.messages.push({ kind: "system", text: "Conversation compacted", ts });
          this.activeTurnStart = this.messages.length;
          touched = true;
          break;
        }
        const cleaned = cleanUserBlocks(ev.content);
        if (cleaned.length === 0) break;
        this.messages.push({ kind: "user", content: cleaned, ts });
        this.activeTurnStart = this.messages.length;
        touched = true;
        break;
      }
      case "assistant_message": {
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
          const joined = ev.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
          this.setTurnStatus(detectStatusToken(joined));
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
          this.onFileEditsChanged?.(this.getFileEdits());
        }
        {
          const t = this.tallyState.tallyToolUse(ev.tool_name, ev.input, ev.id);
          if (t) this.onToolTally?.(t);
        }
        this.setActivity(this.describeActivity(ev.tool_name, ev.input));
        touched = true;
        break;
      }
      case "tool_result":
        this.messages.push({
          kind: "tool_result",
          tool_use_id: ev.tool_use_id,
          output: ev.output,
          is_error: ev.is_error,
          ts,
        });
        touched = true;
        break;
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
        this.enqueueTurnClose();
        if (!opts.silent) {
          this.flushRender();
        }
        return;
      }
      default:
        break;
    }
    if (!touched) return;
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
          el.classList.add("msg--working");
        }
      }
    }
    this.processTurnCloseQueue();
    if (this.activeTurnStart !== null) {
      groupToolRange(this.messages, this.messageEls, this.activeTurnStart, this.messages.length, this.activeToolGroups);
    }
    void highlightCodeBlocks(this.container);
    wrapBlockquotes(this.container);
    clampUserMessages(this.messages, this.messageEls);
  }

  private enqueueTurnClose(): void {
    // The next turn folds into fresh groups; closed-turn rows already carry
    // data-tool-grouped, so processTurnCloseQueue won't re-fold them.
    this.activeToolGroups.clear();
    if (this.activeTurnStart === null) return;
    this.closeTurnQueue.push({ start: this.activeTurnStart, end: this.messages.length });
    this.activeTurnStart = null;
  }

  private processTurnCloseQueue(): void {
    if (this.closeTurnQueue.length === 0) return;
    for (const { start, end } of this.closeTurnQueue) {
      applyTurnCollapse(this.messages, this.messageEls, start, end);
    }
    this.closeTurnQueue = [];
  }

  private handleToolChipClick = (e: MouseEvent): void => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".tool-chip");
    if (!chip) return;
    const strip = chip.closest<HTMLElement>(".tool-strip");
    const panel = strip?.nextElementSibling as HTMLElement | null;
    if (!panel?.classList.contains("tool-strip-panel")) return;

    const tool = chip.dataset.tool;
    const wasActive = chip.classList.contains("tool-chip--active");

    strip?.querySelectorAll<HTMLElement>(".tool-chip").forEach(c => c.classList.remove("tool-chip--active"));
    for (const grp of panel.querySelectorAll<HTMLElement>(".tool-strip-group")) {
      grp.hidden = true;
    }

    if (!wasActive && tool) {
      chip.classList.add("tool-chip--active");
      for (const grp of panel.querySelectorAll<HTMLElement>(".tool-strip-group")) {
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
