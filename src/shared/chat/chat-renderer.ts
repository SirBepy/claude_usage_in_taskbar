// Renders ChatEvent streams into the DOM. Used by both the live Sessions view
// (with a per-session Tauri event subscription via `sessionEvents`) and the
// read-only History view (replays a static array). Markdown via markdown-it;
// code-block syntax highlighting via shiki, applied in a post-render async
// pass.
//
// Performance contract: this renderer does INCREMENTAL DOM updates. The
// container is filled once on attach/loadHistory; subsequent events append
// or replace single message nodes rather than rebuilding the whole list.
// Code-block highlighting is guarded by `data-highlighted` so already-shiki'd
// blocks survive across renders without re-tokenization.

import type { ChatEvent } from "../../types/ipc.generated";
import { sessionEvents } from "./event-store";
import { showView } from "../navigation";
import { cleanUserBlocks, wrapBlockquotes, RenderedMessage, renderMessage, eventToRenderedMessage, isCompactUserMessage, detectStatusToken } from "./chat-transforms";
import { highlightCodeBlocks } from "./code-highlighter";
import { openLightbox } from "./lightbox";
import { hydrateAttachments, chipToLightboxContent } from "./attachment-hydrator";
import { parseFileEdit, type FileEditView } from "./file-edits";
import { basename } from "../path-utils";

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
  /** Parallel to `messages`. Each entry is the rendered DOM node for the
   * message at the same index. Lets us append/replace single nodes instead
   * of rebuilding the whole list. */
  private messageEls: HTMLElement[] = [];
  /** Indices whose node needs to be replaced on next flushRender (e.g. the
   * streaming assistant message got new content). */
  private dirtyIndices = new Set<number>();
  private unsubscribe: (() => void) | null = null;
  private streamingIndex: number | null = null;
  /** Non-null while bulkLoadEvents is running. Live subscription events are
   * queued here instead of going directly to handleEvent so they don't race
   * against partially-processed history chunks (ai_todo 47 render dupe). */
  private liveBuffer: ChatEvent[] | null = null;
  private sessionId: string | null = null;
  private _bulkGen = 0;
  private meta: SessionMeta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };
  private _cumulative: CumulativeUsage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, turns: 0, costUsd: 0 };
  /** Index of first message in the current active Claude turn (after the user message). */
  private activeTurnStart: number | null = null;
  /** Turns whose messages are ready to be collapsed in flushRender. */
  private closeTurnQueue: { start: number; end: number }[] = [];
  /** Chronological list of file-mutation tool_use calls in this session. */
  private fileEdits: FileEditView[] = [];
  /** Last activity string fired via onActivityUpdate (de-dupe). */
  private lastActivity: string | null = null;
  public onMetaUpdate: ((meta: SessionMeta) => void) | null = null;
  public onFileEditsChanged: ((edits: FileEditView[]) => void) | null = null;
  public onActivityUpdate: ((activity: string | null) => void) | null = null;
  /** Fires when the latest finished turn's self-reported status changes:
   * "question" (Claude is waiting on the user), "done", or null (turn in
   * progress / reset by a new user message). Drives the sidebar state icon. */
  public onStatusUpdate: ((status: "done" | "question" | null) => void) | null = null;
  private turnStatus: "done" | "question" | null = null;

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
    this.container.addEventListener("click", this.handleCopyClick);
    this.container.addEventListener("click", this.handleSlashClick);
    this.container.addEventListener("click", this.handleAttachmentClick);
  }

  private handleSlashClick = (e: MouseEvent): void => {
    const span = (e.target as Element).closest<HTMLElement>(".slash-mention[data-skill-target]");
    if (!span) return;
    // Detached chat windows live on a `#detached?...` route - navigating
    // would discard the chat. Skip; future: open the main window's view via
    // Tauri instead.
    if (window.location.hash.startsWith("#detached")) return;
    const target = span.dataset.skillTarget;
    if (!target) return;
    e.preventDefault();
    (window as unknown as { skillDetailTarget?: string }).skillDetailTarget = target;
    showView("skill-detail");
  };

  private handleAttachmentClick = (e: MouseEvent): void => {
    const chip = (e.target as Element).closest<HTMLElement>(".attachment-chip.previewable");
    if (!chip) return;
    const content = chipToLightboxContent(chip);
    if (content) openLightbox(content);
  };

  /**
   * Subscribe to live events for `sessionId` via the shared event store.
   * Detaches any prior subscription. Does NOT load history; call
   * `loadFromStore(cwd)` after attach to populate the pane from cache + JSONL.
   */
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
    this.onFileEditsChanged?.([]);
    this.onActivityUpdate?.(null);
    this.container.innerHTML = "";

    this.activeTurnStart = null;
    this.closeTurnQueue = [];
    this.unsubscribe = sessionEvents.subscribe(sessionId, (ev) => {
      this.handleLive(ev);
    });
  }

  /** Routes live events through the buffer while bulkLoadEvents is running. */
  private handleLive(ev: ChatEvent): void {
    if (this.liveBuffer !== null) {
      this.liveBuffer.push(ev);
    } else {
      this.handleEvent(ev);
    }
  }

  /**
   * Pull cached events for the current session and bulk-render them in a
   * single DOM pass. Cache hit = zero IPC, instant render. Cache miss =
   * triggers `load_history` IPC under the hood (the store handles it).
   *
   * Idempotent: safe to call multiple times. Resets the message list before
   * loading.
   */
  async loadFromStore(cwd?: string): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.cwdHint = cwd;
    // Snapshot: loadInitial returns the live entry.events reference. If a new
    // event arrives from the subscription during a chunk-yield inside bulkLoad,
    // it gets pushed to that array AND fires handleEvent via the subscriber.
    // Without the snapshot, bulkLoad would also hit it when the loop reaches
    // the new index, processing it twice and appending a duplicate message.
    const events = [...(await sessionEvents.loadInitial(sid, cwd))];
    if (this.sessionId !== sid) return;
    await this.bulkLoadEvents(events);
    if (this.sessionId !== sid) return;
    this.installTopSentinel();
  }

  private cwdHint: string | undefined = undefined;
  private topSentinel: HTMLElement | null = null;
  private topObserver: IntersectionObserver | null = null;

  private installTopSentinel(): void {
    this.removeTopSentinel();
    if (!this.sessionId) return;
    if (!sessionEvents.hasMore(this.sessionId)) return;
    const sentinel = document.createElement("div");
    sentinel.className = "chat-top-sentinel";
    sentinel.innerHTML = '<div class="chat-top-spinner" hidden></div>';
    this.container.prepend(sentinel);
    this.topSentinel = sentinel;
    this.topObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          void this.fetchOlder();
        }
      }
    });
    this.topObserver.observe(sentinel);
  }

  private removeTopSentinel(): void {
    if (this.topObserver) {
      try { this.topObserver.disconnect(); } catch { /* ignore */ }
      this.topObserver = null;
    }
    if (this.topSentinel && this.topSentinel.parentNode) {
      this.topSentinel.parentNode.removeChild(this.topSentinel);
    }
    this.topSentinel = null;
  }

  private async fetchOlder(): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    if (!sessionEvents.hasMore(sid)) {
      this.removeTopSentinel();
      return;
    }
    const spinner = this.topSentinel?.querySelector(".chat-top-spinner") as HTMLElement | null;
    if (spinner) spinner.hidden = false;
    const scroller = this.findScroller();
    const oldScrollTop = scroller ? scroller.scrollTop : 0;
    const oldScrollHeight = scroller ? scroller.scrollHeight : 0;

    const older = await sessionEvents.loadOlder(sid, this.cwdHint);
    if (this.sessionId !== sid) return;

    if (!older || older.length === 0) {
      if (spinner) spinner.hidden = true;
      if (!sessionEvents.hasMore(sid)) this.removeTopSentinel();
      return;
    }

    this.prependEvents(older);
    if (this.sessionId !== sid) return;

    if (scroller) {
      const newScrollHeight = scroller.scrollHeight;
      scroller.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
    }

    if (sessionEvents.hasMore(sid)) {
      this.installTopSentinel();
    } else {
      this.removeTopSentinel();
    }
  }

  /**
   * Render `events` (an older page from `loadOlder`) into a DocumentFragment
   * and prepend it to the container without rebuilding existing nodes. Keeps
   * `messages` / `messageEls` 1:1 by re-indexing `streamingIndex` and
   * `dirtyIndices` so the live tail keeps pointing at the right rows.
   *
   * Older pages are by definition historical, so none of them can be the
   * currently-streaming assistant message; we never set/clear streamingIndex
   * here, just shift it.
   */
  private prependEvents(events: ChatEvent[]): void {
    if (events.length === 0) return;

    // Build new RenderedMessage list + DOM nodes in isolation, mirroring the
    // logic in handleEvent / flushRender but writing into a local buffer so
    // existing this.messages / this.messageEls stay untouched until splice.
    const newMessages: RenderedMessage[] = [];
    const newEls: HTMLElement[] = [];
    const frag = document.createDocumentFragment();

    for (const ev of events) {
      const msg = eventToRenderedMessage(ev);
      if (!msg) continue;
      newMessages.push(msg);
      const el = this.buildMessageEl(msg);
      newEls.push(el);
      frag.appendChild(el);
    }

    if (newMessages.length === 0) return;

    // Insert before the existing first message but after the top sentinel
    // (which is `this.topSentinel`). Using container.prepend would put the
    // fragment before the sentinel; instead, insertBefore the existing first
    // message so the sentinel keeps its place at the very top.
    const firstExisting = this.messageEls[0] ?? null;
    if (firstExisting) {
      // messageEls[0] may be inside a <details> turn-group; walk up to the
      // direct child of container so we prepend before the group, not inside it.
      this.container.insertBefore(frag, this.rootChildOf(firstExisting));
    } else if (this.topSentinel && this.topSentinel.parentNode === this.container) {
      // No existing messages but sentinel present: append after sentinel.
      this.container.appendChild(frag);
    } else {
      this.container.prepend(frag);
    }

    const shift = newMessages.length;
    this.messages = [...newMessages, ...this.messages];
    this.messageEls = [...newEls, ...this.messageEls];

    if (this.streamingIndex !== null) {
      this.streamingIndex += shift;
    }
    if (this.dirtyIndices.size > 0) {
      const reindexed = new Set<number>();
      for (const idx of this.dirtyIndices) reindexed.add(idx + shift);
      this.dirtyIndices = reindexed;
    }
    if (this.activeTurnStart !== null) {
      this.activeTurnStart += shift;
    }
    if (this.closeTurnQueue.length > 0) {
      this.closeTurnQueue = this.closeTurnQueue.map(({ start, end }) => ({
        start: start + shift,
        end: end + shift,
      }));
    }

    void highlightCodeBlocks(this.container);
    this.clampUserMessages();
  }


  private findScroller(): HTMLElement | null {
    let n: HTMLElement | null = this.container;
    while (n) {
      const overflowY = getComputedStyle(n).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && n.scrollHeight > n.clientHeight) {
        return n;
      }
      n = n.parentElement;
    }
    return null;
  }

  detach(): void {
    if (this.unsubscribe) {
      try { this.unsubscribe(); } catch { /* ignore */ }
      this.unsubscribe = null;
    }
    this.removeTopSentinel();
    this.streamingIndex = null;
    this.dirtyIndices.clear();
    this.activeTurnStart = null;
    this.closeTurnQueue = [];
    this.setActivity(null);
    this.sessionId = null;
  }

  /**
   * Swap subscription from the current session id to a new one (typically
   * placeholder -> real). Delegates to `sessionEvents.swap` so the cache
   * follows. Preserves rendered messages so the user does not see a flicker.
   */
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

  currentSessionId(): string | null {
    return this.sessionId;
  }

  getMeta(): SessionMeta {
    return { ...this.meta };
  }

  getFileEdits(): FileEditView[] {
    return [...this.fileEdits];
  }

  private describeActivity(toolName: string, input: unknown): string {
    const obj = (input && typeof input === "object") ? input as Record<string, unknown> : {};
    const fp = typeof obj.file_path === "string"
      ? obj.file_path
      : typeof obj.notebook_path === "string"
        ? obj.notebook_path
        : "";
    const bname = fp ? basename(fp) : "";
    let s: string;
    switch (toolName) {
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit":
        s = `Editing ${bname}`;
        break;
      case "Write":
        s = `Writing ${bname}`;
        break;
      case "Read":
        s = `Reading ${bname}`;
        break;
      case "Bash": {
        const cmd = typeof obj.command === "string" ? obj.command : "";
        const cmdShort = cmd.length > 40 ? cmd.slice(0, 40) + "…" : cmd;
        s = `Running: ${cmdShort}`;
        break;
      }
      case "Grep":
      case "Glob": {
        const pat = typeof obj.pattern === "string" ? obj.pattern : "";
        s = `Searching ${pat}`;
        break;
      }
      default:
        s = `Calling ${toolName}`;
    }
    return s.length > 60 ? s.slice(0, 59) + "…" : s;
  }

  private setActivity(a: string | null): void {
    if (this.lastActivity === a) return;
    this.lastActivity = a;
    this.onActivityUpdate?.(a);
  }

  /**
   * Replace the message list with the given history (read-only path used by
   * the History view). Chunked render with event-loop yields between batches
   * so the UI stays responsive on big transcripts.
   */
  async loadHistory(events: ChatEvent[]): Promise<void> {
    await this.bulkLoadEvents(events);
  }

  /**
   * Build the message list in chunks, flushing DOM after each batch and
   * yielding to the event loop in between so window resize / clicks /
   * other input keep working. The chat is covered by the loading overlay
   * during this so the user sees the rolling render only once it lifts.
   */
  private async bulkLoadEvents(events: ChatEvent[]): Promise<void> {
    const myGen = ++this._bulkGen;
    this.liveBuffer = []; // mute live events during history replay
    this.messages = [];
    this.messageEls = [];
    this.dirtyIndices.clear();
    this.streamingIndex = null;
    this.fileEdits = [];
    this.lastActivity = null;
    this.onFileEditsChanged?.([]);
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
    // Flush events that arrived while history was loading. These are applied
    // after the full history is committed so streamingIndex is in the correct
    // position to replace-in-place rather than append a duplicate.
    const buffered = this.liveBuffer;
    this.liveBuffer = null;
    for (const ev of buffered) {
      this.handleEvent(ev);
    }
  }

  handleEvent(ev: ChatEvent, opts: HandleEventOpts = {}): void {
    const ts = "timestamp" in ev ? Number((ev as { timestamp: bigint }).timestamp) : Date.now();
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
        // Close any in-flight Claude turn before showing the new user message.
        this.enqueueTurnClose();
        // New turn starts: drop the previous turn's pinned action so the gap
        // before the first action shows a fresh "thinking" verb.
        this.setActivity(null);
        // A new user message resets the turn status — the ball is back in
        // Claude's court until it finishes and re-reports.
        this.setTurnStatus(null);
        // /compact injects the summary back as a user message — show a system
        // notice instead so the multi-KB summary doesn't appear as a chat bubble.
        if (isCompactUserMessage(ev.content)) {
          this.messages.push({ kind: "system", text: "Conversation compacted", ts });
          this.activeTurnStart = this.messages.length;
          touched = true;
          break;
        }
        // Strip Claude Code slash-command wrapper tags (`<command-name>`,
        // `<command-message>`, `<command-args>`, `<local-command-stdout>`)
        // from user text so the chat doesn't show internal markup. Drop the
        // message entirely if all blocks become empty (e.g. the JSONL row was
        // only tool_result blocks, which the parser already filters out, or
        // pure command-wrapper text).
        const cleaned = cleanUserBlocks(ev.content);
        if (cleaned.length === 0) break;
        this.messages.push({ kind: "user", content: cleaned, ts });
        // Claude's response turn starts here (after the user message).
        this.activeTurnStart = this.messages.length;
        touched = true;
        break;
      }
      case "assistant_message": {
        // Activity is NOT cleared here: the last tool action stays pinned in the
        // thinking bar while Claude streams its reply (Joe's "keep the last msg"
        // behavior). It resets on the next user_message / when the session goes idle.
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
        // On a finalized turn, read Claude's self-reported status marker (the
        // result line carries the full final text incl. the token). Absent
        // token = done (calm). Reset to null happens on the next user_message.
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
        });
        const view = parseFileEdit(ev.tool_name, ev.input);
        if (view) {
          this.fileEdits.push(view);
          this.onFileEditsChanged?.(this.getFileEdits());
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
        // Total context = input + cache_creation + cache_read + output.
        // Output tokens from this turn enter the conversation history and will
        // be loaded (as cache_read) in the next turn, so they already consume
        // context. Including them here matches Claude's own "X% remaining"
        // warning, which accounts for the full accumulated history.
        const totalCtx = Number(ev.input_tokens) + Number(ev.cache_creation_input_tokens) + Number(ev.cache_read_input_tokens) + Number(ev.output_tokens);
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
        // Don't clear activity here: it would flash a random verb between the
        // last action and the session going idle. The bar hides on idle, and
        // the next user_message resets the pinned action.
        // turn_usage is the definitive signal that Claude has finished a turn.
        // Enqueue collapse so the working steps fold up after the next flush.
        this.enqueueTurnClose();
        if (!opts.silent) {
          this.flushRender();
        }
        return;
      }
      default:
        break; // unknown variant, ignore for forward compat
    }
    if (!touched) return;
    if (!opts.silent) {
      this.flushRender();
      if (!opts.skipScroll) this.scrollToBottom();
    }
  }

  /**
   * Apply pending DOM changes: replace dirty indices, append new messages.
   * Cheap when there are no pending changes (early-return on empty diff).
   */
  private flushRender(): void {
    // 1. Replace nodes for dirty (in-place mutated) messages.
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
    // 2. Append nodes for newly-pushed messages.
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
    // 3. Apply msg--working class to all messages in the active Claude turn.
    if (this.activeTurnStart !== null) {
      for (let i = this.activeTurnStart; i < this.messageEls.length; i++) {
        const el = this.messageEls[i];
        const msg = this.messages[i];
        if (el && msg && msg.kind !== "user") {
          el.classList.add("msg--working");
        }
      }
    }
    // 4. Collapse completed turns (wraps intermediate messages in <details>).
    this.processTurnCloseQueue();
    // 5. Async syntax highlight pass + blockquote card wrapping.
    void highlightCodeBlocks(this.container);
    wrapBlockquotes(this.container);
    // 6. Clamp over-long user messages (pasted/typed walls) to ~10 lines.
    this.clampUserMessages();
  }

  /**
   * Collapse any user message taller than ~10 lines behind a "Show more"
   * toggle. The bubble content moves into an overflow-hidden inner body so the
   * toggle (a sibling) stays visible; clicking flips an `expanded` class.
   * Idempotent via a `data-clamp-checked` marker — user messages never stream,
   * so a row is measured exactly once.
   */
  private clampUserMessages(): void {
    const MAX_PX = 220; // roughly ten lines of bubble text
    for (let i = 0; i < this.messageEls.length; i++) {
      if (this.messages[i]?.kind !== "user") continue;
      const el = this.messageEls[i];
      if (!el || el.dataset.clampChecked) continue;
      el.dataset.clampChecked = "1";
      if (el.scrollHeight <= MAX_PX + 40) continue;
      const body = document.createElement("div");
      body.className = "msg-clamp-body";
      while (el.firstChild) body.appendChild(el.firstChild);
      el.appendChild(body);
      el.classList.add("has-clamp");
      const toggle = document.createElement("button");
      toggle.className = "msg-clamp-toggle";
      toggle.textContent = "Show more";
      toggle.addEventListener("click", () => {
        const expanded = el.classList.toggle("expanded");
        toggle.textContent = expanded ? "Show less" : "Show more";
      });
      el.appendChild(toggle);
    }
  }

  private enqueueTurnClose(): void {
    if (this.activeTurnStart === null) return;
    this.closeTurnQueue.push({ start: this.activeTurnStart, end: this.messages.length });
    this.activeTurnStart = null;
  }

  private processTurnCloseQueue(): void {
    if (this.closeTurnQueue.length === 0) return;
    for (const { start, end } of this.closeTurnQueue) {
      this.applyTurnCollapse(start, end);
    }
    this.closeTurnQueue = [];
  }

  private applyTurnCollapse(start: number, end: number): void {
    if (end <= start) return;

    // Find the last assistant message in the range — this is the final answer.
    let lastAssistantIdx = -1;
    for (let i = end - 1; i >= start; i--) {
      if (this.messages[i]?.kind === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }

    // Number of intermediate messages (everything before the final answer).
    const intermediateEnd = lastAssistantIdx === -1 ? end : lastAssistantIdx;
    const intermediateCount = intermediateEnd - start;

    // Promote the final answer out of working state.
    if (lastAssistantIdx !== -1 && this.messageEls[lastAssistantIdx]) {
      this.messageEls[lastAssistantIdx]!.classList.remove("msg--working");
    }

    if (intermediateCount === 0) return;

    // Guard: skip if elements aren't in the DOM yet (shouldn't happen after
    // flushRender, but be safe).
    const firstEl = this.messageEls[start];
    if (!firstEl || !firstEl.parentElement) return;

    // Build the <details> wrapper and insert it before the first intermediate.
    const details = document.createElement("details");
    details.className = "turn-steps";
    const summary = document.createElement("summary");
    summary.className = "turn-steps-summary";
    const label = `${intermediateCount} step${intermediateCount !== 1 ? "s" : ""}`;
    summary.innerHTML = `<i class="ph ph-list-bullets"></i> ${label}`;
    details.appendChild(summary);

    firstEl.parentElement.insertBefore(details, firstEl);
    for (let i = start; i < intermediateEnd; i++) {
      const el = this.messageEls[i];
      if (el) details.appendChild(el);
    }
  }

  private rootChildOf(el: HTMLElement): HTMLElement {
    let n = el;
    while (n.parentElement && n.parentElement !== this.container) {
      n = n.parentElement as HTMLElement;
    }
    return n;
  }

  private buildMessageEl(m: RenderedMessage): HTMLElement {
    const wrap = document.createElement("div");
    wrap.innerHTML = renderMessage(m);
    const el = wrap.firstElementChild as HTMLElement;
    if (el.querySelector(".attachment-chip[data-attachment-path]")) {
      void hydrateAttachments(el);
    }
    return el;
  }

  private handleCopyClick = (e: MouseEvent): void => {
    const btn = (e.target as Element).closest(".copy-btn") as HTMLButtonElement | null;
    if (!btn) return;

    let text = "";
    const block = btn.closest(".copyable-block");
    if (block) {
      const shikiPre = block.querySelector<HTMLElement>("pre.shiki");
      const fallbackPre = block.querySelector<HTMLElement>("pre");
      const pre = shikiPre ?? fallbackPre;
      if (pre) {
        text = pre.textContent ?? "";
      } else {
        // card-block: blockquote or similar - clone and strip the button
        const clone = block.cloneNode(true) as HTMLElement;
        clone.querySelector(".copy-btn")?.remove();
        text = clone.textContent ?? "";
      }
    } else {
      const msg = btn.closest(".msg") as HTMLElement | null;
      if (!msg) return;
      const clone = msg.cloneNode(true) as HTMLElement;
      clone.querySelector(".msg-copy-btn")?.remove();
      text = clone.textContent ?? "";
    }

    void navigator.clipboard.writeText(text.trim()).then(() => {
      const icon = btn.querySelector("i");
      if (!icon) return;
      icon.className = "ph ph-check";
      btn.classList.add("copied");
      setTimeout(() => {
        icon.className = "ph ph-copy";
        btn.classList.remove("copied");
      }, 1500);
    });
  };

  private scrollToBottom(): void {
    this.container.scrollTop = this.container.scrollHeight;
  }
}

