// Renders ChatEvent streams into the DOM. Used by both the live Sessions view
// (with a per-session Tauri event subscription) and the read-only History view
// (replays a static array). Markdown rendering is the placeholder escapeHtml
// for now; Phase 5d wires markdown-it + shiki.

import type { ChatEvent, ContentBlock } from "../../types/ipc.generated";

type Unlisten = () => void;

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
    const ts = Number(ev.timestamp ?? Date.now());
    switch (ev.type) {
      case "session_started":
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
      default:
        // Unknown variant; ignore for forward compat
        break;
    }
    this.render();
    if (!skipScroll) this.scrollToBottom();
  }

  private render(): void {
    this.container.innerHTML = this.messages.map((m) => this.renderMessage(m)).join("");
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

// Phase 5d wires markdown-it + shiki here. v1 just escapes.
function renderMarkdown(text: string): string {
  return escapeHtml(text);
}
