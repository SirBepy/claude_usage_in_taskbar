import MarkdownIt from "markdown-it";
import type { ContentBlock, ChatEvent } from "../../types/ipc.generated";
import { escapeHtml } from "../escape-html";
import { lookupSlash, skillDetailTarget, slashKindClass } from "./slash-registry";
import { parseFileEdit } from "./file-edits";
import { renderEditWindow } from "./edit-window";
import { basename } from "../path-utils";
import { toolSummary } from "./tool-meta";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});

// User messages: render single newlines as hard breaks so a multi-line message
// the user typed (Shift+Enter) keeps its line breaks instead of collapsing into
// one paragraph. Assistant/tool output keeps the default `md` (no forced breaks)
// so Claude's own markdown paragraphing renders normally.
const mdBreaks = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: true,
});

// Matches <file:PATH> or <file:PATH::DISPLAYNAME> tokens in user message text.
// Group 1 = path, group 2 = display name (optional).
const FILE_TOKEN_RE = /<file:(.+?)(?:::(.+?))?>/g;

// A large paste held in the composer is sent wrapped in this sentinel (see
// composer.ts). Claude reads the full body inline; the chat collapses the
// wrapper into a clickable chip so the user never sees the wall of text in
// their own message. Group 1 = display name, group 2 = body.
// Matches both nonce format (new) and legacy format (old messages without nonce).
// New:    <pasted-log id="NONCE" name="NAME">BODY</pasted-log:NONCE>
// Legacy: <pasted-log name="NAME">BODY</pasted-log>
// Groups: [1]=nonce, [2]=name (new) | [3]=body (new) | [4]=name (legacy) | [5]=body (legacy)
const PASTED_LOG_RE = /<pasted-log id="([^"]+)" name="([^"]*)">\n?([\s\S]*?)\n?<\/pasted-log:\1>|<pasted-log name="([^"]*)">\n?([\s\S]*?)\n?<\/pasted-log>/g;

// Turn-status marker injected via `--append-system-prompt` (see
// daemon/lifecycle.rs). Claude ends each reply with `<cc-status:done>` or
// `<cc-status:question>`. The app reads it for the sidebar state and must never
// display it. STATUS_TOKEN_RE matches a complete marker anywhere;
// STATUS_TAIL_RE matches an incomplete trailing fragment (a streamed prefix of
// the marker) so the token never flashes mid-stream. The tail pattern is the
// literal "<cc-status:done|question>" with every position optional, anchored to
// end-of-text, with a mandatory leading "<c" to avoid eating a lone trailing
// "<".
const STATUS_TOKEN_RE = /<cc-status:(?:done|question)>/gi;
const STATUS_TAIL_RE = /<c(?:c(?:-(?:s(?:t(?:a(?:t(?:u(?:s(?::(?:d(?:o(?:n(?:e)?)?)?|q(?:u(?:e(?:s(?:t(?:i(?:o(?:n)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?>?\s*$/i;

// Title marker injected alongside the status marker (see daemon/lifecycle.rs).
// Claude emits `<cc-title:Some Title>` each turn; the title is read off the
// transcript for the sidebar and must never display. TITLE_TOKEN_RE matches a
// complete marker; TITLE_TAIL_RE matches an incomplete trailing fragment (the
// literal "<cc-title:" with every position optional, plus any partial title
// text after the colon) so it never flashes mid-stream.
// Some model versions emit XML-style `<cc-title>Text</cc-title>` instead of
// the colon form; TITLE_XML_TOKEN_RE and TITLE_XML_TAIL_RE handle that variant.
const TITLE_TOKEN_RE = /<cc-title:[^>]*>/gi;
const TITLE_TAIL_RE = /<c(?:c(?:-(?:t(?:i(?:t(?:l(?:e(?::[^>]*)?)?)?)?)?)?)?)?\s*$/i;
const TITLE_XML_TOKEN_RE = /<cc-title>[\s\S]*?<\/cc-title>/gi;
const TITLE_XML_TAIL_RE = /<cc-title>[\s\S]*$/i;

/** Strips both the status and title markers (complete or partial) plus trailing
 * whitespace, so neither ever reaches the rendered message body. */
export function stripStatusToken(text: string): string {
  return text
    .replace(STATUS_TOKEN_RE, "")
    .replace(TITLE_TOKEN_RE, "")
    .replace(TITLE_XML_TOKEN_RE, "")
    .replace(STATUS_TAIL_RE, "")
    .replace(TITLE_TAIL_RE, "")
    .replace(TITLE_XML_TAIL_RE, "")
    .replace(/\s+$/, "");
}

/** Last status marker in `text`, or null if none. */
export function detectStatusToken(text: string): "done" | "question" | null {
  const matches = [...text.matchAll(/<cc-status:(done|question)>/gi)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1]![1]!.toLowerCase() as "done" | "question";
}

function renderTextBlock(rawText: string, breaks = false): string {
  const text = stripStatusToken(rawText);
  // First peel off any <pasted-log> blocks into chips; render the surrounding
  // text (which may still carry <file:> tokens) through the file-token path.
  PASTED_LOG_RE.lastIndex = 0;
  if (!PASTED_LOG_RE.test(text)) {
    PASTED_LOG_RE.lastIndex = 0;
    return renderFileSegments(text, breaks);
  }
  PASTED_LOG_RE.lastIndex = 0;
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = PASTED_LOG_RE.exec(text)) !== null) {
    if (match.index > last) {
      const seg = text.slice(last, match.index);
      if (seg.trim()) parts.push(renderFileSegments(seg, breaks));
    }
    const chipName = match[2] ?? match[4] ?? "pasted_log.txt";
    const chipBody = match[3] ?? match[5] ?? "";
    parts.push(pastedLogChipHtml(chipName, chipBody));
    last = match.index + match[0].length;
  }
  const tail = text.slice(last);
  if (tail.trim()) parts.push(renderFileSegments(tail, breaks));
  return parts.join("");
}

// Renders a text segment, turning any <file:> tokens into attachment chips and
// the rest into markdown.
function renderFileSegments(text: string, breaks = false): string {
  FILE_TOKEN_RE.lastIndex = 0;
  if (!FILE_TOKEN_RE.test(text)) {
    FILE_TOKEN_RE.lastIndex = 0;
    return `<div class="block text">${renderMarkdown(text, breaks)}</div>`;
  }
  FILE_TOKEN_RE.lastIndex = 0;
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_TOKEN_RE.exec(text)) !== null) {
    if (match.index > last) {
      const seg = text.slice(last, match.index).trim();
      if (seg) parts.push(`<div class="block text">${renderMarkdown(seg, breaks)}</div>`);
    }
    const path = match[1] ?? "";
    const name = match[2] ?? basename(path);
    parts.push(attachmentChipHtml(path, name));
    last = match.index + match[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) parts.push(`<div class="block text">${renderMarkdown(tail, breaks)}</div>`);
  return parts.join("");
}

function attachmentChipHtml(path: string, name: string): string {
  return `<div class="attachment-chip" data-attachment-path="${escapeHtml(path)}" data-filename="${escapeHtml(name)}"><i class="ph ph-file"></i><span class="chip-name">${escapeHtml(name)}</span></div>`;
}

/** UTF-8-safe base64 (btoa is Latin1-only). Chunked to avoid arg-count limits
 * on large pastes. */
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Inverse of utf8ToBase64. Returns "" on malformed input. */
export function base64ToUtf8(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

// A pasted-log chip mirrors the composer chip: a file-text glyph + name, the
// full body stashed (base64) on the element so a click can open it in the
// lightbox without re-parsing the message.
function pastedLogChipHtml(name: string, body: string): string {
  return `<div class="attachment-chip pasted-log-chip previewable" data-pasted-name="${escapeHtml(name)}" data-pasted-text="${utf8ToBase64(body)}"><i class="ph ph-file-text"></i><span class="chip-name">${escapeHtml(name)}</span></div>`;
}

export interface RenderedMessage {
  kind: "system" | "user" | "assistant" | "tool_use" | "tool_result" | "notification";
  content?: ContentBlock[];
  text?: string;
  tool?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  output?: ContentBlock;
  is_error?: boolean;
  streaming?: boolean;
  ts: number;
  /** Set on tool_use events that are child calls dispatched by a subagent.
   *  Equals the tool_use id of the parent Agent/Task dispatch. Null for
   *  main-agent tool calls. */
  parentToolUseId?: string | null;
}

/**
 * A turn boundary row: a real user message or a compaction marker. These open
 * a turn, so the tool/assistant rows that follow belong to it. Single source
 * of truth for "what starts a turn", shared by the renderer (folding the
 * window's leading partial turn at initial load) and the paginator (folding
 * prepended ranges). Mirrors the user_message gate in ChatRenderer.handleEvent:
 * a tool-result-only user line renders to empty content and is dropped (never
 * becomes a kind:"user" row), so checking kind here is sufficient.
 */
export function isBoundaryMessage(m: RenderedMessage): boolean {
  return m.kind === "user" || (m.kind === "system" && m.text === "Conversation compacted");
}

export function renderBlocks(blocks: ContentBlock[], breaks = false): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "text":
          return renderTextBlock(b.text, breaks);
        case "image":
          return `<img class="block image" src="data:${escapeHtml(b.mime)};base64,${escapeHtml(b.data)}" alt="">`;
        default:
          ((_: never) => "")(b);
      }
    })
    .join("");
}

export function renderMessage(m: RenderedMessage): string {
  switch (m.kind) {
    case "system":
      return `<div class="msg system">${escapeHtml(m.text ?? "")}</div>`;
    case "user":
      return `<div class="msg user">${renderBlocks(m.content ?? [], true)}</div>`;
    case "assistant":
      return `<div class="msg assistant${m.streaming ? " streaming" : ""}"><button class="copy-btn msg-copy-btn" aria-label="Copy message"><i class="ph ph-copy"></i></button>${renderBlocks(m.content ?? [])}</div>`;
    case "tool_use": {
      const view = parseFileEdit(m.tool ?? "", m.input);
      if (view) return `<div class="msg tool-use tool-use--file">${renderEditWindow(view)}</div>`;
      const summary = toolSummary(m.tool ?? "", m.input);
      return `<details class="msg tool-use tool-row"><summary class="tool-row-summary"><i class="ph ${escapeHtml(summary.icon)}"></i><span class="tool-row-name">${escapeHtml(summary.tool)}</span><span class="tool-row-target">${escapeHtml(summary.target)}</span></summary><div class="copyable-block"><pre>${escapeHtml(JSON.stringify(m.input ?? null, null, 2))}</pre><button class="copy-btn" aria-label="Copy"><i class="ph ph-copy"></i></button></div></details>`;
    }
    case "tool_result":
      return `<details class="msg tool-result tool-row${m.is_error ? " error" : ""}"><summary class="tool-row-summary"><i class="ph ph-arrow-bend-down-right"></i><span class="tool-row-name">result</span></summary>${m.output ? renderBlocks([m.output]) : ""}</details>`;
    case "notification":
      return `<div class="msg notification">${escapeHtml(m.text ?? "")}</div>`;
    default:
      return "";
  }
}

function renderMarkdown(text: string, breaks = false): string {
  return highlightSlashMentions((breaks ? mdBreaks : md).render(text));
}

// Claude Code wraps slash-command prompts with internal tags like
// `<command-name>`, `<command-message>`, `<command-args>`, and shells out
// stdout via `<local-command-stdout>`. These are session bookkeeping, not
// content the user wants to see in the chat.
//
// command-name/message/local-command-stdout: strip the ENTIRE block including
// content (the name "rate-it" or stdout output should not appear in the bubble).
// command-args: strip only the tags, keep content (it's the user's typed text).
const COMMAND_BLOCK_RE = /<(?:command-name|command-message|local-command-stdout)(?:\s[^>]*)?>[\s\S]*?<\/(?:command-name|command-message|local-command-stdout)>/gi;
const COMMAND_TAG_RE = /<\/?(?:command-name|command-message|command-args|local-command-stdout)(?:\s[^>]*)?>/gi;

// Normalize raw user-message text for display and cross-source dedup: removes
// the command scaffolding Claude Code adds when expanding slash commands, leaving
// only the user's typed text (which lives between the command-args tags).
export function normalizeUserMessageText(text: string): string {
  return text
    .replace(COMMAND_BLOCK_RE, "")
    .replace(COMMAND_TAG_RE, "")
    .replace(SKILL_BODY_RE, "")
    .replace(TASK_NOTIFICATION_RE, "")
    .trim();
}

// Background-task completion events the harness injects as synthetic
// user-role messages when `run_in_background: true` finishes. Multi-line
// XML-ish block; strip the whole thing including contents.
const TASK_NOTIFICATION_RE = /<task-notification[\s\S]*?<\/task-notification>/gi;

// When /compact runs, Claude Code injects the generated summary back into the
// conversation as a user message with this wrapper. The summary can be thousands
// of characters; rendering it as a normal user bubble is confusing and noisy.
// Detect the wrapper and replace with a compact system notice instead.
const COMPACT_COMMAND_RE = /<command-name>compact<\/command-name>/i;

export function isCompactUserMessage(blocks: ContentBlock[]): boolean {
  return blocks.some(b => b.type === "text" && COMPACT_COMMAND_RE.test(b.text));
}

// When the user invokes a skill, Claude Code appends the entire SKILL.md
// body to the same user message AFTER `</command-args>`, followed by an
// `ARGUMENTS: ...` line repeating what the user typed. Strip from the
// `Base directory for this skill:` marker through end-of-text so the chat
// shows just the user's input (which is already preserved inside the
// command-args block).
const SKILL_BODY_RE = /^Base directory for this skill:[\s\S]*$/m;

export function cleanUserBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      let stripped = normalizeUserMessageText(b.text);
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

export function highlightSlashMentions(html: string): string {
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

/**
 * Highlight known `/slash` tokens in RAW composer text (not markdown) for the
 * composer's highlight backdrop. Escapes HTML and wraps registered commands in
 * a COLOR-ONLY span; unknown names stay plain. The span must not change font,
 * padding, or border - the backdrop sits glyph-for-glyph behind a transparent
 * textarea, so any box change would knock the text out of alignment.
 */
export function highlightComposerInput(text: string): string {
  const escaped = escapeHtml(text);
  const withSpans = escaped.replace(SLASH_MENTION_RE, (_match, pre: string, raw: string) => {
    const hit = lookupSlash(raw);
    if (!hit) return `${pre}/${raw}`;
    return `${pre}<span class="cm-slash cm-slash-${slashKindClass(hit.source)}">/${raw}</span>`;
  });
  // pre-wrap drops a trailing newline; pad it so the backdrop height (and thus
  // scroll position) tracks the textarea exactly.
  return withSpans.endsWith("\n") ? withSpans + " " : withSpans;
}

export function eventToRenderedMessage(ev: ChatEvent): RenderedMessage | null {
  const ts = "timestamp" in ev ? Number((ev as { timestamp: bigint }).timestamp) : Date.now();
  switch (ev.type) {
    case "session_started":
      return { kind: "system", text: `Session started${ev.model ? ` (${ev.model})` : ""}`, ts };
    case "user_message": {
      if (isCompactUserMessage(ev.content)) {
        return { kind: "system", text: "Conversation compacted", ts };
      }
      const cleaned = cleanUserBlocks(ev.content);
      if (cleaned.length === 0) return null;
      return { kind: "user", content: cleaned, ts };
    }
    case "assistant_message":
      return { kind: "assistant", content: ev.content, streaming: ev.streaming, ts };
    case "tool_use":
      return { kind: "tool_use", tool: ev.tool_name, input: ev.input, id: ev.id, ts, parentToolUseId: ev.parent_tool_use_id ?? null };
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

export function wrapBlockquotes(container: HTMLElement): void {
  const quotes = Array.from(
    container.querySelectorAll<HTMLElement>(".msg.assistant blockquote:not([data-wrapped])"),
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
