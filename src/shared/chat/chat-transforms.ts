import type { ContentBlock } from "../../types/ipc.generated";
import { escapeHtml } from "../escape-html";
import { lookupSlash, skillDetailTarget, slashKindClass } from "./slash-registry";

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
