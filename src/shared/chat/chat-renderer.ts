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

import MarkdownIt from "markdown-it";
// shiki/bundle/web ships ~80 web-relevant languages and is ~10x smaller than
// the default barrel "shiki" (which eagerly bundles every supported language,
// including emacs-lisp/wasm/cpp - causing ~3 MB of chunk bloat).
import { codeToHtml } from "shiki/bundle/web";
import type { ChatEvent, ContentBlock } from "../../types/ipc.generated";
import { escapeHtml } from "../escape-html";
import { sessionEvents } from "./event-store";
import { lookupSlash, skillDetailTarget, slashKindClass } from "./slash-registry";
import { showView } from "../navigation";

const md = new MarkdownIt({
  html: false, // safe: don't let assistant output inject HTML
  linkify: true,
  typographer: false,
});

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

interface RenderedMessage {
  kind: "system" | "user" | "assistant" | "tool_use" | "tool_result" | "notification";
  content?: ContentBlock[];
  text?: string; // for system/notification
  tool?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  output?: ContentBlock;
  is_error?: boolean;
  streaming?: boolean;
  ts: number;
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
  private meta: SessionMeta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0, hasUsage: false };
  private _cumulative: CumulativeUsage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, turns: 0, costUsd: 0 };
  public onMetaUpdate: ((meta: SessionMeta) => void) | null = null;

  get cumulativeUsage(): CumulativeUsage {
    return { ...this._cumulative };
  }

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.addEventListener("click", this.handleCopyClick);
    this.container.addEventListener("click", this.handleSlashClick);
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
      this.container.insertBefore(frag, firstExisting);
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

    void this.highlightCodeBlocks();
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
    this.messages = [];
    this.messageEls = [];
    this.dirtyIndices.clear();
    this.streamingIndex = null;
    this.container.innerHTML = "";
    const CHUNK = 8;
    for (let i = 0; i < events.length; i += CHUNK) {
      for (let j = i; j < Math.min(i + CHUNK, events.length); j++) {
        this.handleEvent(events[j]!, { silent: true, skipScroll: true });
      }
      this.flushRender();
      if (i + CHUNK < events.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
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
        // Strip Claude Code slash-command wrapper tags (`<command-name>`,
        // `<command-message>`, `<command-args>`, `<local-command-stdout>`)
        // from user text so the chat doesn't show internal markup. Drop the
        // message entirely if all blocks become empty (e.g. the JSONL row was
        // only tool_result blocks, which the parser already filters out, or
        // pure command-wrapper text).
        const cleaned = cleanUserBlocks(ev.content);
        if (cleaned.length === 0) break;
        this.messages.push({ kind: "user", content: cleaned, ts });
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
        this.messages.push({
          kind: "system",
          text: `Session ended${ev.exit_code !== null ? ` (exit ${ev.exit_code})` : ""}`,
          ts,
        });
        touched = true;
        break;
      case "turn_usage": {
        // Total context = input + cache_creation + cache_read.
        // Claude Code uses prompt caching aggressively, so most context lives
        // in cache_read_input_tokens, not input_tokens alone. Using only
        // input_tokens would show ~0% for any session with a warm cache.
        const totalCtx = Number(ev.input_tokens) + Number(ev.cache_creation_input_tokens) + Number(ev.cache_read_input_tokens);
        if (totalCtx > this.meta.inputTokens) {
          this.meta.inputTokens = totalCtx;
        }
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
        return; // no DOM update needed
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
    // 3. Async syntax highlight pass + blockquote card wrapping.
    void this.highlightCodeBlocks();
    this.wrapBlockquotes();
  }

  private buildMessageEl(m: RenderedMessage): HTMLElement {
    const wrap = document.createElement("div");
    wrap.innerHTML = this.renderMessage(m);
    return wrap.firstElementChild as HTMLElement;
  }

  private wrapBlockquotes(): void {
    const quotes = Array.from(
      this.container.querySelectorAll<HTMLElement>(".msg.assistant blockquote:not([data-wrapped])"),
    );
    for (const bq of quotes) {
      bq.dataset.wrapped = "true";
      const wrapper = document.createElement("div");
      wrapper.className = "copyable-block card-block";
      bq.parentNode!.insertBefore(wrapper, bq);
      wrapper.appendChild(bq);
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.setAttribute("aria-label", "Copy");
      btn.innerHTML = '<i class="ph ph-copy"></i>';
      wrapper.appendChild(btn);
    }
  }

  private async highlightCodeBlocks(): Promise<void> {
    // Two paths produce <pre><code>: (1) renderBlocks emits
    // <pre class="block code" data-lang="X"><code>...</code></pre>, and
    // (2) markdown-it's fence renderer emits <pre><code class="language-X">
    // ...</code></pre> with NO class on the <pre>. The selector must catch
    // both, hence we walk via <code> (which always exists) up to its <pre>.
    // The :not([data-highlighted]) guard means already-shiki'd blocks are
    // skipped on subsequent passes (incremental render preserves them).
    const codes = Array.from(
      this.container.querySelectorAll<HTMLElement>("pre > code:not([data-highlighted])"),
    );
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (!code) continue;
      const pre = code.parentElement as HTMLElement | null;
      if (!pre || pre.tagName !== "PRE") continue;
      const lang = pre.dataset.lang || extractFenceLang(code.className) || "text";
      try {
        const html = await codeToHtml(code.textContent ?? "", {
          lang,
          theme: "github-dark",
        });
        const safeLang = escapeHtml(lang);
        const wrapper = document.createElement("div");
        wrapper.className = "copyable-block";
        wrapper.innerHTML = `<div class="block code shiki-wrap" data-lang="${safeLang}" data-highlighted="true">${html}</div><button class="copy-btn" aria-label="Copy code"><i class="ph ph-copy"></i></button>`;
        pre.replaceWith(wrapper);
      } catch {
        code.dataset.highlighted = "true";
      }
      // Yield a macrotask between blocks so the browser can paint and stay
      // responsive when a transcript carries many or huge fenced blocks.
      // Each codeToHtml await is microtask-fast and won't yield on its own.
      if (i + 1 < codes.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
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

  private renderMessage(m: RenderedMessage): string {
    switch (m.kind) {
      case "system":
        return `<div class="msg system">${escapeHtml(m.text ?? "")}</div>`;
      case "user":
        return `<div class="msg user">${this.renderBlocks(m.content ?? [])}</div>`;
      case "assistant":
        return `<div class="msg assistant${m.streaming ? " streaming" : ""}"><button class="copy-btn msg-copy-btn" aria-label="Copy message"><i class="ph ph-copy"></i></button>${this.renderBlocks(m.content ?? [])}</div>`;
      case "tool_use":
        return `<div class="msg tool-use"><b>${escapeHtml(m.tool ?? "")}</b><div class="copyable-block"><pre>${escapeHtml(JSON.stringify(m.input ?? null, null, 2))}</pre><button class="copy-btn" aria-label="Copy"><i class="ph ph-copy"></i></button></div></div>`;
      case "tool_result":
        return `<div class="msg tool-result${m.is_error ? " error" : ""}">${m.output ? this.renderBlocks([m.output]) : ""}</div>`;
      case "notification":
        return `<div class="msg notification">${escapeHtml(m.text ?? "")}</div>`;
      default:
        return "";
    }
  }

  private renderBlocks(blocks: ContentBlock[]): string {
    return blocks
      .map((b) => {
        switch (b.type) {
          case "text":
            return `<div class="block text">${renderMarkdown(b.text)}</div>`;
          case "image":
            return `<img class="block image" src="data:${escapeHtml(b.mime)};base64,${escapeHtml(b.data)}" alt="">`;
          default:
            ((_: never) => "")(b);
        }
      })
      .join("");
  }

  private scrollToBottom(): void {
    this.container.scrollTop = this.container.scrollHeight;
  }
}

function renderMarkdown(text: string): string {
  // markdown-it with html:false escapes raw HTML; safe for untrusted input.
  return highlightSlashMentions(md.render(text));
}

function extractFenceLang(className: string): string | null {
  const m = className.match(/language-(\S+)/);
  return m ? m[1]! : null;
}

// Claude Code wraps slash-command prompts with internal tags like
// `<command-name>`, `<command-message>`, `<command-args>`, and shells out
// stdout via `<local-command-stdout>`. These are session bookkeeping, not
// content the user wants to see in the chat.
const COMMAND_TAG_RE = /<\/?(?:command-name|command-message|command-args|local-command-stdout)(?:\s[^>]*)?>/gi;

// When the user invokes a skill, Claude Code appends the entire SKILL.md
// body to the same user message AFTER `</command-args>`, followed by an
// `ARGUMENTS: ...` line repeating what the user typed. Strip from the
// `Base directory for this skill:` marker through end-of-text so the chat
// shows just the user's input (which is already preserved inside the
// command-args block).
const SKILL_BODY_RE = /^Base directory for this skill:[\s\S]*$/m;

function cleanUserBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      let stripped = b.text.replace(COMMAND_TAG_RE, "");
      stripped = stripped.replace(SKILL_BODY_RE, "");
      stripped = stripped.trim();
      if (stripped.length === 0) continue;
      out.push({ type: "text", text: stripped });
    } else {
      out.push(b);
    }
  }
  return out;
}

// Wrap `/word` tokens in <span class="slash-mention slash-<kind>"> when the
// name is in the shared slash registry. Only matches outside <a>/<code>/<pre>
// (markdown-it already escapes user HTML, so we walk the rendered string at
// the text-node level using a tag-skipping regex). Unknown names stay plain.
const SLASH_MENTION_RE = /(^|[\s(>])\/([a-zA-Z][\w-]*(?::[a-zA-Z][\w-]*)?)\b/g;

function highlightSlashMentions(html: string): string {
  // Skip content inside <code>, <pre>, <a>. Split on these tags and only
  // transform the chunks that are outside.
  const parts = html.split(/(<(?:code|pre|a)(?:\s[^>]*)?>[\s\S]*?<\/(?:code|pre|a)>)/gi);
  for (let i = 0; i < parts.length; i++) {
    // Even indices are outside the protected tags; odd indices are matches.
    if (i % 2 === 1) continue;
    const part = parts[i];
    if (!part) continue;
    parts[i] = part.replace(SLASH_MENTION_RE, (_match, pre: string, raw: string) => {
      const hit = lookupSlash(raw);
      if (!hit) return `${pre}/${raw}`;
      const cls = `slash-mention slash-${slashKindClass(hit.source)}`;
      const target = skillDetailTarget(hit.name, hit.source);
      const targetAttr = target ? ` data-skill-target="${escapeHtml(target)}"` : "";
      return `${pre}<span class="${cls}" data-slash="${escapeHtml(raw)}"${targetAttr}>/${escapeHtml(raw)}</span>`;
    });
  }
  return parts.join("");
}
