// Renders ChatEvent streams into the DOM. Used by both the live Sessions view
// (with a per-session Tauri event subscription) and the read-only History view
// (replays a static array). Markdown via markdown-it; code-block syntax
// highlighting via shiki, applied in a post-render async pass.

import MarkdownIt from "markdown-it";
// shiki/bundle/web ships ~80 web-relevant languages and is ~10x smaller than
// the default barrel "shiki" (which eagerly bundles every supported language,
// including emacs-lisp/wasm/cpp - causing ~3 MB of chunk bloat).
import { codeToHtml } from "shiki/bundle/web";
import type { ChatEvent, ContentBlock } from "../../types/ipc.generated";

const md = new MarkdownIt({
  html: false, // safe: don't let assistant output inject HTML
  linkify: true,
  typographer: false,
});

type Unlisten = () => void;

export interface SessionMeta {
  model: string | null;
  /** Full context window input for the latest turn (not additive). */
  inputTokens: number;
  hasThinking: boolean;
  totalCostUsd: number;
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

export class ChatRenderer {
  private container: HTMLElement;
  private messages: RenderedMessage[] = [];
  private unlisten: Unlisten | null = null;
  private streamingIndex: number | null = null;
  private sessionId: string | null = null;
  private meta: SessionMeta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0 };
  public onMetaUpdate: ((meta: SessionMeta) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /**
   * Subscribe to live events for `sessionId`. Detaches any prior subscription.
   */
  async attach(sessionId: string): Promise<void> {
    this.detach();
    this.sessionId = sessionId;
    this.messages = [];
    this.streamingIndex = null;
    this.meta = { model: null, inputTokens: 0, hasThinking: false, totalCostUsd: 0 };
    this.render();

    const ev = window.__TAURI__?.event;
    if (!ev?.listen) {
      console.warn("[ChatRenderer] Tauri event API unavailable");
      return;
    }
    this.unlisten = await ev.listen<ChatEvent>(`chat:${sessionId}`, (e) => {
      this.handleEvent(e.payload);
    });
  }

  detach(): void {
    if (this.unlisten) {
      try {
        this.unlisten();
      } catch {
        /* ignore */
      }
      this.unlisten = null;
    }
    this.streamingIndex = null;
    this.sessionId = null;
  }

  /**
   * Swap the live event subscription from the current session id to a new
   * one (typically: placeholder -> real). Preserves the current rendered
   * messages and streaming index so the user keeps seeing the in-progress
   * turn instead of a flicker. Used when start_session captures the real
   * session_id from claude's first SessionStarted event.
   */
  async swapSubscription(newSessionId: string): Promise<void> {
    if (this.sessionId === newSessionId) return;
    if (this.unlisten) {
      try {
        this.unlisten();
      } catch {
        /* ignore */
      }
      this.unlisten = null;
    }
    this.sessionId = newSessionId;
    const ev = window.__TAURI__?.event;
    if (!ev?.listen) return;
    this.unlisten = await ev.listen<ChatEvent>(`chat:${newSessionId}`, (e) => {
      this.handleEvent(e.payload);
    });
  }

  /** Currently subscribed session id, if any. */
  currentSessionId(): string | null {
    return this.sessionId;
  }

  getMeta(): SessionMeta {
    return { ...this.meta };
  }

  /**
   * Replace the message list with the given history. Used for read-only
   * history view replay or for restoring the chat pane on reopen.
   */
  loadHistory(events: ChatEvent[]): void {
    this.messages = [];
    this.streamingIndex = null;
    for (const ev of events) this.handleEvent(ev, /*skipScroll=*/ true);
    this.render();
    this.scrollToBottom();
  }

  handleEvent(ev: ChatEvent, skipScroll = false): void {
    const ts = "timestamp" in ev ? Number((ev as { timestamp: bigint }).timestamp) : Date.now();
    switch (ev.type) {
      case "session_started":
        this.meta = { model: ev.model || null, inputTokens: 0, hasThinking: false, totalCostUsd: 0 };
        this.onMetaUpdate?.(this.getMeta());
        this.messages.push({
          kind: "system",
          text: `Session started${ev.model ? ` (${ev.model})` : ""}`,
          ts,
        });
        break;
      case "user_message":
        this.messages.push({ kind: "user", content: ev.content, ts });
        break;
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
          } else {
            this.streamingIndex = this.messages.length;
            this.messages.push(msg);
          }
        } else {
          if (this.streamingIndex !== null) {
            this.messages[this.streamingIndex] = msg;
            this.streamingIndex = null;
          } else {
            this.messages.push(msg);
          }
        }
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
        break;
      case "tool_result":
        this.messages.push({
          kind: "tool_result",
          tool_use_id: ev.tool_use_id,
          output: ev.output,
          is_error: ev.is_error,
          ts,
        });
        break;
      case "notification":
        this.messages.push({ kind: "notification", text: ev.body, ts: Date.now() });
        break;
      case "session_ended":
        this.messages.push({
          kind: "system",
          text: `Session ended${ev.exit_code !== null ? ` (exit ${ev.exit_code})` : ""}`,
          ts,
        });
        break;
      case "turn_usage":
        this.meta.inputTokens = ev.input_tokens;
        this.meta.totalCostUsd = ev.total_cost_usd;
        if (ev.has_thinking) this.meta.hasThinking = true;
        this.onMetaUpdate?.(this.getMeta());
        return; // no DOM update needed
      default:
        // Unknown variant; ignore for forward compat
        break;
    }
    this.render();
    if (!skipScroll) this.scrollToBottom();
  }

  private render(): void {
    this.container.innerHTML = this.messages.map((m) => this.renderMessage(m)).join("");
    // Async syntax highlighting pass; ignore failures (unknown languages
    // leave the block as-is). Don't await - let highlight stream in after
    // the initial render lands so streaming feels live.
    void this.highlightCodeBlocks();
  }

  private async highlightCodeBlocks(): Promise<void> {
    // Two paths produce <pre><code>: (1) renderBlocks emits
    // <pre class="block code" data-lang="X"><code>...</code></pre>, and
    // (2) markdown-it's fence renderer emits <pre><code class="language-X">
    // ...</code></pre> with NO class on the <pre>. The selector must catch
    // both, hence we walk via <code> (which always exists) up to its <pre>.
    const codes = Array.from(
      this.container.querySelectorAll<HTMLElement>("pre > code:not([data-highlighted])"),
    );
    for (const code of codes) {
      const pre = code.parentElement as HTMLElement | null;
      if (!pre || pre.tagName !== "PRE") continue;
      const lang = pre.dataset.lang || extractFenceLang(code.className) || "text";
      try {
        // Single theme to avoid the CSS-var bridge problem with shiki's
        // dual-theme mode. github-dark reads OK on both light and dark app
        // themes for v1; light-theme users get a slightly darker code panel
        // than ideal but tokens stay readable. Theme switching is a polish
        // item.
        const html = await codeToHtml(code.textContent ?? "", {
          lang,
          theme: "github-dark",
        });
        const safeLang = escapeHtml(lang);
        pre.outerHTML = `<div class="block code shiki-wrap" data-lang="${safeLang}" data-highlighted="true">${html}</div>`;
      } catch {
        // Unknown language - mark BOTH the code element AND a wrapping
        // attribute so the no-op fallback render survives subsequent passes.
        code.dataset.highlighted = "true";
      }
    }
  }

  private renderMessage(m: RenderedMessage): string {
    switch (m.kind) {
      case "system":
        return `<div class="msg system">${escapeHtml(m.text ?? "")}</div>`;
      case "user":
        return `<div class="msg user">${this.renderBlocks(m.content ?? [])}</div>`;
      case "assistant":
        return `<div class="msg assistant${m.streaming ? " streaming" : ""}">${this.renderBlocks(m.content ?? [])}</div>`;
      case "tool_use":
        return `<div class="msg tool-use"><b>${escapeHtml(m.tool ?? "")}</b><pre>${escapeHtml(JSON.stringify(m.input ?? null, null, 2))}</pre></div>`;
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
          case "code":
            return `<pre class="block code"${b.language ? ` data-lang="${escapeHtml(b.language)}"` : ""}><code>${escapeHtml(b.text)}</code></pre>`;
          case "image":
            return `<img class="block image" src="data:${escapeHtml(b.mime)};base64,${escapeHtml(b.data)}" alt="">`;
          default:
            return "";
        }
      })
      .join("");
  }

  private scrollToBottom(): void {
    this.container.scrollTop = this.container.scrollHeight;
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

function renderMarkdown(text: string): string {
  // markdown-it with html:false escapes raw HTML; safe for untrusted input.
  return md.render(text);
}

function extractFenceLang(className: string): string | null {
  const m = className.match(/language-(\S+)/);
  return m ? m[1]! : null;
}
