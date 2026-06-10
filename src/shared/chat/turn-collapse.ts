import type { RenderedMessage } from "./chat-transforms";
import { toolSummary, canonicalTool, toolLabel } from "./tool-meta";

/** Per-tool-type state for one turn's strip. */
export interface ToolGroup {
  chip: HTMLElement;
  bucket: HTMLElement;
  strip: HTMLElement;
  panel: HTMLElement;
}

/**
 * Fold a turn's compact tool rows into ONE inline strip of chips (one chip per
 * tool type). Clicking a chip opens an accordion panel with that type's rows.
 *
 * Structure inserted into the container:
 *   <div class="tool-strip">
 *     <button class="tool-chip" data-tool="Bash">…Ran x3</button>
 *     …
 *   </div>
 *   <div class="tool-strip-panel" hidden>
 *     <div class="tool-strip-group" data-tool="Bash" hidden>…rows…</div>
 *     …
 *   </div>
 *
 * Idempotent: rows already moved into a bucket carry `data-tool-grouped` and
 * are skipped, so the live path can call this every flush to grow the count.
 * Rich inline edit cards (.tool-use--file) stay where they are.
 *
 * The `groups` map (keyed by canonical tool name) persists for the active turn;
 * pass a fresh map for closed ranges.
 */
export function groupToolRange(
  messages: RenderedMessage[],
  messageEls: HTMLElement[],
  start: number,
  end: number,
  groups: Map<string, ToolGroup>,
): void {
  if (end <= start) return;

  // Build id -> tool name map so tool_result rows land in their tool's bucket.
  const idTool = new Map<string, string>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    const el = messageEls[i];
    if (!m || !el) continue;
    if (m.kind === "tool_use" && m.id && el.classList.contains("tool-row")) {
      idTool.set(m.id, m.tool ?? "");
    }
  }

  // If groups already has entries, recover strip/panel from the first entry.
  let strip: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  if (groups.size > 0) {
    const first = groups.values().next().value!;
    strip = first.strip;
    panel = first.panel;
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

    const key = canonicalTool(tool);

    // Create strip and panel before the first tool row, once per turn.
    if (!strip) {
      strip = document.createElement("div");
      strip.className = "tool-strip";
      panel = document.createElement("div");
      panel.className = "tool-strip-panel";
      panel.hidden = true;
      el.parentElement?.insertBefore(strip, el);
      strip.after(panel);
    }

    let group = groups.get(key);
    if (!group) {
      const { icon } = toolSummary(key, {});
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tool-chip";
      chip.dataset.tool = key;
      chip.dataset.count = "0";
      const iconEl = document.createElement("i");
      iconEl.className = `ph ${icon}`;
      const labelEl = document.createElement("span");
      labelEl.className = "tool-chip-label";
      labelEl.textContent = toolLabel(key);
      const countEl = document.createElement("span");
      countEl.className = "tool-chip-count";
      countEl.textContent = "x0";
      chip.appendChild(iconEl);
      chip.appendChild(labelEl);
      chip.appendChild(countEl);
      strip.appendChild(chip);

      const bucket = document.createElement("div");
      bucket.className = "tool-strip-group";
      bucket.dataset.tool = key;
      bucket.hidden = true;
      panel!.appendChild(bucket);

      group = { chip, bucket, strip: strip!, panel: panel! };
      groups.set(key, group);
    }

    group.bucket.appendChild(el);
    el.dataset.toolGrouped = "1";

    if (isUse) {
      const n = Number(group.chip.dataset.count ?? "0") + 1;
      group.chip.dataset.count = String(n);
      const countEl = group.chip.querySelector(".tool-chip-count");
      if (countEl) countEl.textContent = `x${n}`;

      // Briefly highlight the chip whose count just incremented.
      group.chip.classList.remove("tool-chip--highlight");
      void (group.chip as HTMLElement & { offsetWidth: number }).offsetWidth;
      group.chip.classList.add("tool-chip--highlight");
    }
  }
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

  groupToolRange(messages, messageEls, start, end, new Map<string, ToolGroup>());
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
