import MarkdownIt from "markdown-it";
import type { ContentBlock } from "../../types/ipc.generated";
import { escapeHtml } from "../escape-html";
import { lookupSlash, skillDetailTarget, slashKindClass } from "./slash-registry";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});

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
}

export function renderBlocks(blocks: ContentBlock[]): string {
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

export function renderMessage(m: RenderedMessage): string {
  switch (m.kind) {
    case "system":
      return `<div class="msg system">${escapeHtml(m.text ?? "")}</div>`;
    case "user":
      return `<div class="msg user">${renderBlocks(m.content ?? [])}</div>`;
    case "assistant":
      return `<div class="msg assistant${m.streaming ? " streaming" : ""}"><button class="copy-btn msg-copy-btn" aria-label="Copy message"><i class="ph ph-copy"></i></button>${renderBlocks(m.content ?? [])}</div>`;
    case "tool_use":
      return `<div class="msg tool-use"><b>${escapeHtml(m.tool ?? "")}</b><div class="copyable-block"><pre>${escapeHtml(JSON.stringify(m.input ?? null, null, 2))}</pre><button class="copy-btn" aria-label="Copy"><i class="ph ph-copy"></i></button></div></div>`;
    case "tool_result":
      return `<div class="msg tool-result${m.is_error ? " error" : ""}">${m.output ? renderBlocks([m.output]) : ""}</div>`;
    case "notification":
      return `<div class="msg notification">${escapeHtml(m.text ?? "")}</div>`;
    default:
      return "";
  }
}

function renderMarkdown(text: string): string {
  return highlightSlashMentions(md.render(text));
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

export function cleanUserBlocks(blocks: ContentBlock[]): ContentBlock[] {
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
