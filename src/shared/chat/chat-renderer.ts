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
import { cleanUserBlocks, wrapBlockquotes, RenderedMessage, renderMessage } from "./chat-transforms";
import { highlightCodeBlocks } from "./code-highlighter";
import { invoke } from "../ipc";
import { escapeHtml } from "../escape-html";
import { openLightbox, type LightboxContent } from "./lightbox";

// WeakMap so GC can collect chips when their container is removed.
const chipData = new WeakMap<HTMLElement, { mime: string; base64: string }>();

async function hydrateAttachments(el: HTMLElement): Promise<void> {
  const chips = Array.from(el.querySelectorAll<HTMLElement>(".attachment-chip[data-attachment-path]"));
  for (const chip of chips) {
    if (!document.contains(chip)) continue;
    const path = chip.dataset.attachmentPath;
    if (!path) continue;
    const name = chip.dataset.filename ?? path.split(/[\\/]/).pop() ?? "file";
    try {
      const data = await invoke<{ mime: string; base64: string }>("read_attachment", { path });
      if (!document.contains(chip)) continue;
      if (data.mime.startsWith("image/")) {
        const thumb = document.createElement("div");
        thumb.className = "sent-attachment-thumb";
        const img = document.createElement("img");
        img.src = `data:${escapeHtml(data.mime)};base64,${escapeHtml(data.base64)}`;
        img.alt = name;
        img.title = "Click to enlarge";
        thumb.appendChild(img);
        const { mime, base64 } = data;
        thumb.addEventListener("click", () => {
          openLightbox({ type: "image", mime, base64, filename: name });
        });
        chip.replaceWith(thumb);
      } else {
        chipData.set(chip, data);
        chip.classList.remove("loading");
        if (data.mime === "application/pdf") {
          chip.classList.add("previewable");
          chip.innerHTML = `<i class="ph ph-file-pdf"></i><span class="chip-name">${escapeHtml(name)}</span>`;
        } else if (data.mime.startsWith("text/") || data.mime === "application/json") {
          chip.classList.add("previewable");
          chip.innerHTML = `<i class="ph ph-file-text"></i><span class="chip-name">${escapeHtml(name)}</span>`;
        } else {
          chip.innerHTML = `<i class="ph ph-file"></i><span class="chip-name">${escapeHtml(name)}</span>`;
        }
      }
    } catch {
      chip.innerHTML = `<i class="ph ph-warning"></i><span class="chip-name">${escapeHtml(name)}</span>`;
    }
  }
}

function chipToLightboxContent(chip: HTMLElement): LightboxContent | null {
  const data = chipData.get(chip);
  if (!data) return null;
  const name = chip.dataset.filename;
  if (data.mime.startsWith("image/")) return { type: "image", mime: data.mime, base64: data.base64, filename: name };
  if (data.mime === "application/pdf") return { type: "pdf", base64: data.base64, filename: name };
  if (data.mime.startsWith("text/") || data.mime === "application/json") {
    try { return { type: "text", content: atob(data.base64), filename: name }; } catch { return null; }
  }
  return null;
}

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
  private sessionId: string | null = null;
  private _bulkGen = 0;
  private meta: SessionMeta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };
  private _cumulative: CumulativeUsage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, turns: 0, costUsd: 0 };
  /** Index of first message in the current active Claude turn (after the user message). */
  private activeTurnStart: number | null = null;
  /** Turns whose messages are ready to be collapsed in flushRender. */
  private closeTurnQueue: { start: number; end: number }[] = [];
  public onMetaUpdate: ((meta: SessionMeta) => void) | null = null;

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
    this.container.innerHTML = "";

    this.activeTurnStart = null;
    this.closeTurnQueue = [];
    this.unsubscribe = sessionEvents.subscribe(sessionId, (ev) => {
      this.handleEvent(ev);
    });
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
    const events = await sessionEvents.loadInitial(sid, cwd);
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
      const msg = this.eventToRenderedMessage(ev);
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
  }

  /**
   * Pure mapping from a ChatEvent to a RenderedMessage. Mirrors the cases in
   * handleEvent that produce a row but does NOT mutate any renderer state.
   * Returns null for events that shouldn't render a row (e.g. turn_usage,
   * empty user_message after command-tag stripping).
   */
  private eventToRenderedMessage(ev: ChatEvent): RenderedMessage | null {
    const ts = "timestamp" in ev ? Number((ev as { timestamp: bigint }).timestamp) : Date.now();
    switch (ev.type) {
      case "session_started":
        return { kind: "system", text: `Session started${ev.model ? ` (${ev.model})` : ""}`, ts };
      case "user_message": {
        const cleaned = cleanUserBlocks(ev.content);
        if (cleaned.length === 0) return null;
        return { kind: "user", content: cleaned, ts };
      }
      case "assistant_message":
        return { kind: "assistant", content: ev.content, streaming: ev.streaming, ts };
      case "tool_use":
        return { kind: "tool_use", tool: ev.tool_name, input: ev.input, id: ev.id, ts };
      case "tool_result":
        return { kind: "tool_result", tool_use_id: ev.tool_use_id, output: ev.output, is_error: ev.is_error, ts };
      case "notification":
        return { kind: "notification", text: ev.body, ts: Date.now() };
      case "session_ended":
        return { kind: "system", text: `Session ended${ev.exit_code !== null ? ` (exit ${ev.exit_code})` : ""}`, ts };
      default:
        return null;
    }
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
      this.handleEvent(ev);
    });
  }

  currentSessionId(): string | null {
    return this.sessionId;
  }

  getMeta(): SessionMeta {
    return { ...this.meta };
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
    this.messages = [];
    this.messageEls = [];
    this.dirtyIndices.clear();
    this.streamingIndex = null;
    this.container.innerHTML = "";
    const CHUNK = 8;
    for (let i = 0; i < events.length; i += CHUNK) {
      if (this._bulkGen !== myGen) return;
      for (let j = i; j < Math.min(i + CHUNK, events.length); j++) {
        this.handleEvent(events[j]!, { silent: true, skipScroll: true });
      }
      this.flushRender();
      if (i + CHUNK < events.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (this._bulkGen !== myGen) return;
    this.scrollToBottom();
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
        touched = true;
        break;
      }
      case "tool_use":
        this.messages.push({
          kind: "tool_use",
          tool: ev.tool_name,
          input: ev.input,
          id: ev.id,
          ts,
        });
        touched = true;
        break;
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
    const toolCalls = this.messages.slice(start, intermediateEnd).filter(m => m.kind === "tool_use").length;
    const label = toolCalls > 0
      ? `${toolCalls} tool call${toolCalls !== 1 ? "s" : ""}`
      : `${intermediateCount} step${intermediateCount !== 1 ? "s" : ""}`;
    summary.innerHTML = `<i class="ph ph-wrench"></i> ${label}`;
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

