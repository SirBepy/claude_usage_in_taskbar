// Classification and detection helpers for chat messages. No DOM or HTML
// concerns — pure data transforms over ContentBlock[] and strings.
// Rendering functions live in chat-transforms.ts.

import type { ContentBlock } from "../../types/ipc.generated";

// Turn-status marker injected via `--append-system-prompt` (see
// daemon/lifecycle.rs). Claude ends each reply with `<cc-status:done>`,
// `<cc-status:question>`, or `<cc-status:waiting>` (parked on an external
// process it will resume on). The app reads it for the sidebar state and must
// never display it. STATUS_TOKEN_RE matches a complete marker anywhere;
// STATUS_TAIL_RE matches an incomplete trailing fragment (a streamed prefix of
// the marker) so the token never flashes mid-stream. The tail pattern is the
// literal "<cc-status:done|question|waiting>" with every position optional,
// anchored to end-of-text, with a mandatory leading "<c" to avoid eating a lone
// trailing "<".
const STATUS_TOKEN_RE = /<cc-status:(?:done|question|waiting)>/gi;
const STATUS_TAIL_RE = /<c(?:c(?:-(?:s(?:t(?:a(?:t(?:u(?:s(?::(?:d(?:o(?:n(?:e)?)?)?|q(?:u(?:e(?:s(?:t(?:i(?:o(?:n)?)?)?)?)?)?)?|w(?:a(?:i(?:t(?:i(?:n(?:g)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?>?\s*$/i;

// Autopilot marker emitted by the /autopilot skill to signal on/off state.
// The app reads it to toggle the sidebar badge; it must never display in chat.
const AUTOPILOT_TOKEN_RE = /<cc-autopilot:(?:on|off)>/gi;
// Matches an incomplete trailing <cc-autopilot:... fragment so it never flashes.
const AUTOPILOT_TAIL_RE = /<cc-autopilot(?::[^>]*)?\s*$/i;

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
    .replace(AUTOPILOT_TOKEN_RE, "")
    .replace(STATUS_TAIL_RE, "")
    .replace(TITLE_TAIL_RE, "")
    .replace(TITLE_XML_TAIL_RE, "")
    .replace(AUTOPILOT_TAIL_RE, "")
    .replace(/\s+$/, "");
}

/** Last status marker in `text`, or null if none. */
export function detectStatusToken(text: string): "done" | "question" | "waiting" | null {
  const matches = [...text.matchAll(/<cc-status:(done|question|waiting)>/gi)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1]![1]!.toLowerCase() as "done" | "question" | "waiting";
}

export interface RenderedMessage {
  kind: "system" | "user" | "assistant" | "tool_use" | "tool_result" | "notification" | "question";
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
  /** True for system messages that originated from noiseAssistantLabel (e.g.
   *  "Request interrupted by user"). Used to position the chips footer BEFORE
   *  these labels rather than after them. */
  noiseLabel?: boolean;
  /** Ordinal of this compaction event within the session (1-based). Present
   *  only on system messages that represent a compaction boundary. */
  compactionN?: number;
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
  return m.kind === "user" || (m.kind === "system" && m.compactionN != null);
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

// When /compact runs, Claude Code injects the generated summary back into the
// conversation as a user message with this wrapper. The summary can be thousands
// of characters; rendering it as a normal user bubble is confusing and noisy.
// Detect the wrapper and replace with a compact system notice instead.
const COMPACT_COMMAND_RE = /<command-name>compact<\/command-name>/i;

// Background-task completion events the harness injects as synthetic
// user-role messages when `run_in_background: true` finishes. Multi-line
// XML-ish block; strip the whole thing including contents.
const TASK_NOTIFICATION_RE = /<task-notification[\s\S]*?<\/task-notification>/gi;

// When the user invokes a skill, Claude Code appends the entire SKILL.md
// body to the same user message AFTER `</command-args>`, followed by an
// `ARGUMENTS: ...` line repeating what the user typed. Strip from the
// `Base directory for this skill:` marker through end-of-text so the chat
// shows just the user's input (which is already preserved inside the
// command-args block).
const SKILL_BODY_RE = /^Base directory for this skill:[\s\S]*$/m;

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

export function isCompactUserMessage(blocks: ContentBlock[]): boolean {
  return blocks.some(b => b.type === "text" && COMPACT_COMMAND_RE.test(b.text));
}

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

// Single-word "continue" messages sent by the rate-limit auto-continue system.
// These are internal plumbing and should not render as user bubbles.
export function isSilentSystemUserMessage(cleaned: ContentBlock[]): boolean {
  const first = cleaned[0];
  if (cleaned.length !== 1 || !first || first.type !== "text") return false;
  return (first as { type: "text"; text: string }).text.trim().toLowerCase() === "continue";
}

// The resume system injects "Continue from where you left off." as a user turn
// when a chat is continued (e.g. after a restart). The user never typed it, so
// it must not render as a user bubble - drop it entirely; the assistant's
// "Continuing chat" notice is the visible resume marker.
export function isResumeContinuationUserMessage(cleaned: ContentBlock[]): boolean {
  const first = cleaned[0];
  if (cleaned.length !== 1 || !first || first.type !== "text") return false;
  return /^continue from where you left off\.?$/i.test(
    (first as { type: "text"; text: string }).text.trim(),
  );
}

// Assistant messages that are internal CLI noise. Returns a display label for
// the system notice, or null if the text is real assistant content.
const NOISE_PATTERNS: [RegExp, string][] = [
  // Emitted when a session is resumed with nothing new to do (e.g. continuing a
  // chat after a restart). Shown as "Continuing chat" rather than the raw
  // "No response requested." so it reads as the resume marker, not an error.
  [/^no response requested\.?$/i, "Continuing chat"],
  [/^\[request interrupted( by user)?\]$/i, "Request interrupted by user"],
];
export function noiseAssistantLabel(text: string): string | null {
  const t = text.trim();
  for (const [re, label] of NOISE_PATTERNS) {
    if (re.test(t)) return label;
  }
  return null;
}
export function isNoiseAssistantText(text: string): boolean {
  return noiseAssistantLabel(text) !== null;
}
