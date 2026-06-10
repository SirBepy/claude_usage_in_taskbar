import type { RenderedMessage } from "./chat-transforms";
import { toolSummary } from "./tool-meta";

/**
 * Fold a turn's compact tool rows (Read/Grep/Bash/...) into one collapsible
 * group per tool type, so a turn that ran the same tool many times shows a
 * single "Grep x5" element instead of five separate rows. Rich inline edit
 * cards (`.tool-use--file`) and assistant text stay where they are.
 *
 * Idempotent: rows already moved into a group carry `data-tool-grouped` and are
 * skipped, so the live path can call this every flush to grow the count. The
 * `groups` map (keyed by tool name) holds the group element per type; pass a
 * persistent map for the active turn and a fresh one for a closed range.
 */
export function groupToolRange(
  messages: RenderedMessage[],
  messageEls: HTMLElement[],
  start: number,
  end: number,
  groups: Map<string, HTMLElement>,
): void {
  if (end <= start) return;

  // Compact tool_use id -> tool name, so a tool_result lands in its tool's group.
  const idTool = new Map<string, string>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    const el = messageEls[i];
    if (!m || !el) continue;
    if (m.kind === "tool_use" && m.id && el.classList.contains("tool-row")) {
      idTool.set(m.id, m.tool ?? "");
    }
  }

  for (let i = start; i < end; i++) {
    const m = messages[i];
    const el = messageEls[i];
    if (!m || !el) continue;
    if (el.dataset.toolGrouped === "1") continue;
    // Only compact rows fold; the rich edit cards (.tool-use--file) stay inline.
    if (!el.classList.contains("tool-row")) continue;

    let tool: string | null = null;
    let isUse = false;
    if (m.kind === "tool_use") {
      tool = m.tool ?? "";
      isUse = true;
    } else if (m.kind === "tool_result") {
      tool = (m.tool_use_id && idTool.get(m.tool_use_id)) ?? null;
    }
    if (!tool) continue;

    let group = groups.get(tool);
    if (!group) {
      group = createToolGroup(tool);
      groups.set(tool, group);
      // Anchor the group where this type first appeared; later rows jump up into it.
      el.parentElement?.insertBefore(group, el);
    }
    group.appendChild(el);
    el.dataset.toolGrouped = "1";

    if (isUse) {
      const n = Number(group.dataset.count ?? "0") + 1;
      group.dataset.count = String(n);
      const countEl = group.querySelector(".tool-group-count");
      if (countEl) countEl.textContent = `x${n}`;
    }
  }
}

function createToolGroup(tool: string): HTMLElement {
  const { icon } = toolSummary(tool, {});
  const details = document.createElement("details");
  details.className = "tool-group";
  details.dataset.tool = tool;
  details.dataset.count = "0";
  const summary = document.createElement("summary");
  summary.className = "tool-group-summary";
  summary.innerHTML = `<i class="ph ${icon}"></i><span class="tool-group-name"></span><span class="tool-group-count">x0</span>`;
  // textContent for the name keeps arbitrary tool ids (mcp__server__tool) inert.
  const nameEl = summary.querySelector(".tool-group-name");
  if (nameEl) nameEl.textContent = tool;
  details.appendChild(summary);
  return details;
}

/**
 * Finalize a closed turn: drop the working shimmer from its final answer and
 * fold any not-yet-grouped tool rows (covers bulk replay where multiple turns
 * close inside one render flush). A fresh map scopes groups to this turn.
 */
export function applyTurnCollapse(
  messages: RenderedMessage[],
  messageEls: HTMLElement[],
  start: number,
  end: number,
): void {
  if (end <= start) return;

  for (let i = end - 1; i >= start; i--) {
    if (messages[i]?.kind === "assistant") {
      messageEls[i]?.classList.remove("msg--working");
      break;
    }
  }

  groupToolRange(messages, messageEls, start, end, new Map());
}

/** Clamp over-long user messages behind a "Show more" toggle. Idempotent via data-clamp-checked. */
export function clampUserMessages(messages: RenderedMessage[], messageEls: HTMLElement[]): void {
  const MAX_PX = 220;
  for (let i = 0; i < messageEls.length; i++) {
    if (messages[i]?.kind !== "user") continue;
    const el = messageEls[i];
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
