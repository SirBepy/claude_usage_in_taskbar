import type { RenderedMessage } from "./chat-transforms";
import { toolSummary, canonicalTool, toolLabel } from "./tool-meta";
import { escapeHtml } from "../escape-html";
import { basename } from "../path-utils";

// Canonical tool keys whose chip panel renders a CUSTOM aggregated view built
// from the turn's message data, instead of the generic stack of raw tool rows.
// Read/Edit collapse repeated targets into one row-per-file; Skill lists the
// skills used; AskUserQuestion pairs each question with the answer given.
const CUSTOM_VIEW_TOOLS = new Set(["Read", "Edit", "Skill", "AskUserQuestion"]);

/** Per-tool-type state for one turn's strip. */
export interface ToolGroup {
  chip: HTMLElement;
  bucket: HTMLElement;
  strip: HTMLElement;
  panel: HTMLElement;
}

// ---------------------------------------------------------------------------
// DOM helpers shared by main-strip and nested-strip creation
// ---------------------------------------------------------------------------

/** Create a tool-chip button (without appending anywhere). */
function makeChip(key: string, opts?: { label?: string; icon?: string; agent?: boolean }): HTMLElement {
  const icon = opts?.icon ?? toolSummary(key, {}).icon;
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = opts?.agent ? "tool-chip tool-chip--agent" : "tool-chip";
  chip.dataset.tool = key;
  chip.dataset.count = "0";
  const iconEl = document.createElement("i");
  iconEl.className = `ph ${icon}`;
  const labelEl = document.createElement("span");
  labelEl.className = "tool-chip-label";
  labelEl.textContent = opts?.label ?? toolLabel(key);
  const countEl = document.createElement("span");
  countEl.className = "tool-chip-count";
  countEl.textContent = "x0";
  chip.appendChild(iconEl);
  chip.appendChild(labelEl);
  chip.appendChild(countEl);
  return chip;
}

/**
 * Create a tool-strip + tool-strip-panel pair. When `host` is given (the
 * turn's footer) the pair is APPENDED there - after the meta chips row, so
 * the strip is the footer's second row. Without a host it falls back to the
 * legacy placement before `anchorEl` (first tool row).
 */
function makeStripPair(anchorEl: HTMLElement, host?: HTMLElement | null): { strip: HTMLElement; panel: HTMLElement } {
  const strip = document.createElement("div");
  strip.className = "tool-strip";
  const panel = document.createElement("div");
  panel.className = "tool-strip-panel";
  panel.hidden = true;
  if (host) {
    host.appendChild(strip);
    host.appendChild(panel);
  } else {
    anchorEl.parentElement?.insertBefore(strip, anchorEl);
    strip.after(panel);
  }
  return { strip, panel };
}

/** Append a new ToolGroup (chip + bucket) to an existing strip/panel pair. */
function addGroupToStrip(
  key: string,
  strip: HTMLElement,
  panel: HTMLElement,
  opts?: { label?: string; icon?: string; agent?: boolean },
): ToolGroup {
  const chip = makeChip(key, opts);
  strip.appendChild(chip);

  const bucket = document.createElement("div");
  bucket.className = "tool-strip-group";
  bucket.dataset.tool = key;
  bucket.hidden = true;
  panel.appendChild(bucket);

  return { chip, bucket, strip, panel };
}

/** Increment a chip's displayed count and flash highlight. */
function bumpChip(chip: HTMLElement): void {
  const n = Number(chip.dataset.count ?? "0") + 1;
  chip.dataset.count = String(n);
  const countEl = chip.querySelector(".tool-chip-count");
  if (countEl) countEl.textContent = `x${n}`;
  chip.classList.remove("tool-chip--highlight");
  void (chip as HTMLElement & { offsetWidth: number }).offsetWidth;
  chip.classList.add("tool-chip--highlight");
}

/**
 * Elements that fold into a chip bucket. Compact tool rows (.tool-row) AND
 * rich file-edit cards (.tool-use--file): the edit card keeps its inline diff
 * view, it just lives inside the Edit/Write chip's panel instead of loose in
 * the chat flow (so a turn that touched 8 files shows one "Edited x8" chip,
 * not 8 stacked diff cards).
 */
function isFoldableToolEl(el: HTMLElement): boolean {
  return el.classList.contains("tool-row") || el.classList.contains("tool-use--file");
}

/** Human label for a subagent chip: its Task description (or subagent_type), capped. */
function descOf(input: unknown): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const d = typeof obj.description === "string" ? obj.description : "";
  const t = typeof obj.subagent_type === "string" ? obj.subagent_type : "";
  const label = (d || t || "Subagent").trim();
  return label.length > 60 ? label.slice(0, 60) + "…" : label;
}

// ---------------------------------------------------------------------------
// Custom chip-panel views (Read / File Changes / Skills / Questions)
// ---------------------------------------------------------------------------

function asObj(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

/** Edit/Write/MultiEdit/NotebookEdit + Read all target a single path. */
function filePathOf(input: unknown): string {
  const o = asObj(input);
  return strField(o, "file_path") || strField(o, "notebook_path");
}

/** Parent-directory tail of a path (everything before the basename), or "". */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

/**
 * Aggregate this turn's Read or File-Changes calls into one row per file,
 * first-seen order, with a repeat-count badge. Rows open the file in the
 * editor on click (delegated handler in chat-renderer). `kind` selects the
 * badge wording: "read N×" vs "N changes".
 */
function renderFilesView(
  messages: RenderedMessage[],
  start: number,
  end: number,
  kind: "Read" | "Edit",
): string {
  const byPath = new Map<string, number>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!m || m.kind !== "tool_use" || m.parentToolUseId) continue;
    if (canonicalTool(m.tool ?? "") !== kind) continue;
    const path = filePathOf(m.input);
    if (!path) continue;
    byPath.set(path, (byPath.get(path) ?? 0) + 1);
  }
  if (byPath.size === 0) return "";
  return [...byPath].map(([path, n]) => {
    const pathEsc = escapeHtml(path);
    const nameEsc = escapeHtml(basename(path));
    const dirEsc = escapeHtml(dirOf(path));
    const badge = kind === "Read"
      ? (n > 1 ? `<span class="tool-file-count">${n}×</span>` : "")
      : `<span class="tool-file-count">${n} ${n === 1 ? "change" : "changes"}</span>`;
    return `<button type="button" class="tool-file-row" data-path="${pathEsc}" title="${pathEsc}"><i class="ph ph-file"></i><span class="tool-file-name">${nameEsc}</span><span class="tool-file-path">${dirEsc}</span>${badge}</button>`;
  }).join("");
}

/** One clean row per skill used this turn, with a repeat-count badge. */
function renderSkillsView(messages: RenderedMessage[], start: number, end: number): string {
  const bySkill = new Map<string, number>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!m || m.kind !== "tool_use" || m.parentToolUseId || m.tool !== "Skill") continue;
    const name = strField(asObj(m.input), "skill") || "(skill)";
    bySkill.set(name, (bySkill.get(name) ?? 0) + 1);
  }
  if (bySkill.size === 0) return "";
  return [...bySkill].map(([name, n]) => {
    const badge = n > 1 ? `<span class="tool-file-count">x${n}</span>` : "";
    return `<div class="tool-skill-row"><i class="ph ph-sparkle"></i><span class="tool-skill-name">${escapeHtml(name)}</span>${badge}</div>`;
  }).join("");
}

/** Pull plain text out of a tool_result output block (else ""). */
function resultText(m: RenderedMessage): string {
  const out = m.output;
  if (out && out.type === "text" && typeof out.text === "string") return out.text;
  return "";
}

/**
 * Parse the answer message the app feeds back to claude (built by
 * permission-modal/question-ui::formatAnswersAsMessage) into a question->answer
 * map. Shape: "User answered the question(s):\nQ: <q>\nA: <a>\n...".
 */
function parseAnswers(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let pendingQ: string | null = null;
  for (const line of lines) {
    if (line.startsWith("Q: ")) pendingQ = line.slice(3).trim();
    else if (line.startsWith("A: ") && pendingQ !== null) {
      map.set(pendingQ, line.slice(3).trim());
      pendingQ = null;
    }
  }
  return map;
}

interface AskQuestion { question: string; header?: string }

function extractAskQuestions(input: unknown): AskQuestion[] {
  const raw = asObj(input).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const it of raw) {
    const q = asObj(it);
    const question = strField(q, "question");
    if (!question) continue;
    out.push({ question, header: strField(q, "header") || undefined });
  }
  return out;
}

/**
 * For each AskUserQuestion call this turn, show every question (with its short
 * header) paired with the answer the user gave. Answers come from the matching
 * tool_result; while one is still pending the answer reads "awaiting answer".
 */
function renderQuestionsView(messages: RenderedMessage[], start: number, end: number): string {
  // tool_use id -> parsed answers, harvested from each call's tool_result.
  const answersById = new Map<string, Map<string, string>>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (m?.kind === "tool_result" && m.tool_use_id) {
      const t = resultText(m);
      if (t) answersById.set(m.tool_use_id, parseAnswers(t));
    }
  }
  const cards: string[] = [];
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!m || m.kind !== "tool_use" || m.parentToolUseId || m.tool !== "AskUserQuestion") continue;
    const questions = extractAskQuestions(m.input);
    const answers = (m.id && answersById.get(m.id)) || null;
    for (const q of questions) {
      const header = q.header ? `<div class="tool-qa-header">${escapeHtml(q.header)}</div>` : "";
      const ans = answers?.get(q.question);
      const answerHtml = ans
        ? `<div class="tool-qa-a"><i class="ph ph-arrow-bend-down-right"></i><span>${escapeHtml(ans)}</span></div>`
        : `<div class="tool-qa-a tool-qa-a--pending"><i class="ph ph-clock"></i><span>awaiting answer</span></div>`;
      cards.push(`<div class="tool-qa">${header}<div class="tool-qa-q">${escapeHtml(q.question)}</div>${answerHtml}</div>`);
    }
  }
  return cards.join("");
}

/** Rebuild a custom bucket's content from the turn's message data. */
function rebuildCustomBucket(
  bucket: HTMLElement,
  key: string,
  messages: RenderedMessage[],
  start: number,
  end: number,
): void {
  let html = "";
  switch (key) {
    case "Read": html = renderFilesView(messages, start, end, "Read"); break;
    case "Edit": html = renderFilesView(messages, start, end, "Edit"); break;
    case "Skill": html = renderSkillsView(messages, start, end); break;
    case "AskUserQuestion": html = renderQuestionsView(messages, start, end); break;
  }
  bucket.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Nested-strip helpers (child tool calls under a parent Agent/Task chip)
// ---------------------------------------------------------------------------

/**
 * Lazily get or create the nested strip pair that lives inside the Agent
 * chip's bucket element. The nested strip is a standard tool-strip /
 * tool-strip-panel pair so the existing delegated handleToolChipClick
 * toggles it identically to the main strip.
 *
 * Layout inside parentBucket:
 *   <div class="tool-strip-group" data-tool="Task"> <!-- parentBucket -->
 *     <div class="tool-strip">…nested chips…</div>
 *     <div class="tool-strip-panel" hidden>…nested buckets…</div>
 *     …child tool rows…
 *   </div>
 */
function getOrCreateNestedStripInBucket(
  parentBucket: HTMLElement,
  nestedGroups: Map<string, ToolGroup>,
): { nestedStrip: HTMLElement; nestedPanel: HTMLElement } {
  // If we already created the nested strip (recovery or prior flush), reuse it.
  const existing = parentBucket.querySelector<HTMLElement>(":scope > .tool-strip");
  if (existing) {
    const panel = existing.nextElementSibling as HTMLElement | null;
    if (panel?.classList.contains("tool-strip-panel")) {
      // Repopulate nestedGroups from DOM if caller passed empty map.
      if (nestedGroups.size === 0) {
        for (const chip of existing.querySelectorAll<HTMLElement>(".tool-chip[data-tool]")) {
          const k = chip.dataset.tool!;
          if (nestedGroups.has(k)) continue;
          const bkt = panel.querySelector<HTMLElement>(`.tool-strip-group[data-tool="${k}"]`);
          if (bkt) nestedGroups.set(k, { chip, bucket: bkt, strip: existing, panel });
        }
      }
      return { nestedStrip: existing, nestedPanel: panel };
    }
  }
  // Create fresh nested strip/panel at the TOP of parentBucket so rows appended
  // later naturally follow it.
  const nestedStrip = document.createElement("div");
  nestedStrip.className = "tool-strip";
  const nestedPanel = document.createElement("div");
  nestedPanel.className = "tool-strip-panel";
  nestedPanel.hidden = true;
  parentBucket.prepend(nestedPanel);
  parentBucket.prepend(nestedStrip);
  return { nestedStrip, nestedPanel };
}

// ---------------------------------------------------------------------------
// Main grouping function
// ---------------------------------------------------------------------------

/**
 * Fold a turn's compact tool rows into ONE inline strip of chips (one chip per
 * tool type). Clicking a chip opens an accordion panel with that type's rows.
 *
 * Main-strip structure inserted into the container:
 *   <div class="tool-strip">
 *     <button class="tool-chip" data-tool="Task">…Subagent x1</button>
 *     <button class="tool-chip" data-tool="Bash">…Ran x3</button>
 *     …
 *   </div>
 *   <div class="tool-strip-panel" hidden>
 *     <div class="tool-strip-group" data-tool="Task" hidden>
 *       <!-- nested strip for child calls -->
 *       <div class="tool-strip">…child chips…</div>
 *       <div class="tool-strip-panel" hidden>…child buckets…</div>
 *     </div>
 *     <div class="tool-strip-group" data-tool="Bash" hidden>…rows…</div>
 *     …
 *   </div>
 *
 * Child tool_use rows (parentToolUseId !== null) are routed into the nested
 * strip inside their parent Agent chip's bucket. Main-strip chip counts
 * EXCLUDE child calls; only the Subagent chip represents the subagent.
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
  stripHost?: HTMLElement | null,
): void {
  if (end <= start) return;

  // ------------------------------------------------------------------
  // Pass 1: build id -> tool name map AND id -> parentToolUseId map so
  // tool_result rows land in the right bucket (main or nested).
  // ------------------------------------------------------------------
  const idTool = new Map<string, string>();
  const idParent = new Map<string, string>(); // tool_use id -> parentToolUseId (if child)
  const idDescription = new Map<string, string>(); // agent tool_use id -> subagent label
  for (let i = start; i < end; i++) {
    const m = messages[i];
    const el = messageEls[i];
    if (!m || !el) continue;
    if (m.kind === "tool_use" && m.id && isFoldableToolEl(el)) {
      idTool.set(m.id, m.tool ?? "");
      if (m.parentToolUseId) idParent.set(m.id, m.parentToolUseId);
      if (m.tool === "Task" || m.tool === "Agent") idDescription.set(m.id, descOf(m.input));
    }
  }

  // Map from agent tool_use id -> the single main-strip Task/Agent ToolGroup
  // (the bucket that holds the per-subagent strip). Pre-populated from grouped
  // Task/Agent rows folded on a prior flush.
  const agentGroupById = new Map<string, ToolGroup>();
  for (let i = start; i < end; i++) {
    const m = messages[i];
    const el = messageEls[i];
    if (!m || !el || el.dataset.toolGrouped !== "1") continue;
    if (m.kind === "tool_use" && m.id && (m.tool === "Task" || m.tool === "Agent")) {
      const grp = groups.get(canonicalTool(m.tool));
      if (grp) agentGroupById.set(m.id, grp);
    }
  }

  // Level-1 (per-subagent) chip groups, keyed by agent tool_use id. All
  // subagents share ONE level-1 strip inside the single Task/Agent bucket.
  // Repopulated lazily from the DOM by getOrCreateNestedStripInBucket on the
  // first child routed this flush.
  const subagentGroups = new Map<string, ToolGroup>();
  // Level-2 (per-tool-type) chip groups, keyed by agent id -> canonical tool.
  const toolGroupsBySub = new Map<string, Map<string, ToolGroup>>();

  // If groups already has entries, recover strip/panel from the first entry.
  let strip: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  if (groups.size > 0) {
    const first = groups.values().next().value!;
    strip = first.strip;
    panel = first.panel;
  }

  // Custom-view buckets touched this flush (bucket -> canonical key), rebuilt
  // from message data after the fold loop instead of holding raw rows.
  const customBuckets = new Map<HTMLElement, string>();

  // ------------------------------------------------------------------
  // Pass 2: fold each ungrouped row
  // ------------------------------------------------------------------
  for (let i = start; i < end; i++) {
    const m = messages[i];
    const el = messageEls[i];
    if (!m || !el) continue;
    if (el.dataset.toolGrouped === "1") continue;
    // Compact rows AND rich file-edit cards fold; everything else stays inline.
    if (!isFoldableToolEl(el)) continue;

    let tool: string | null = null;
    let isUse = false;
    let parentId: string | null = null;

    if (m.kind === "tool_use") {
      tool = m.tool ?? "";
      isUse = true;
      parentId = m.parentToolUseId ?? null;
    } else if (m.kind === "tool_result") {
      const tid = m.tool_use_id ?? null;
      tool = (tid && idTool.get(tid)) ?? null;
      parentId = (tid && idParent.get(tid)) ?? null;
    }
    if (!tool) continue;

    const key = canonicalTool(tool);

    // ------------------------------------------------------------------
    // Ensure main strip exists (inside the turn footer when provided)
    // ------------------------------------------------------------------
    if (!strip) {
      const pair = makeStripPair(el, stripHost);
      strip = pair.strip;
      panel = pair.panel;
    }

    // ------------------------------------------------------------------
    // Route: child (parentId set AND parent agent is in range) vs. main
    // ------------------------------------------------------------------
    if (parentId) {
      // Look up the parent agent's main-strip ToolGroup.
      let agentGrp = agentGroupById.get(parentId);

      if (!agentGrp) {
        // Parent may not be folded yet (edge: parent appears later in range).
        // Try to resolve it from idTool; if it exists in range it will fold in
        // a later iteration and we'll update agentGroupById then. For now fall
        // back to main-strip treatment to avoid crashing.
        const parentTool = idTool.get(parentId);
        if (!parentTool) {
          // Parent outside range or unknown - fall through to main-strip.
          parentId = null;
        } else {
          // Parent is in range but not yet folded. Fold it into main strip now
          // so we can nest under it. Find the parent element.
          const parentMsgIdx = Array.from({ length: end - start }, (_, k) => start + k)
            .find(k => messages[k]?.kind === "tool_use" && messages[k]!.id === parentId);
          if (parentMsgIdx !== undefined) {
            const parentEl = messageEls[parentMsgIdx];
            if (parentEl && parentEl.dataset.toolGrouped !== "1" && parentEl.classList.contains("tool-row")) {
              const parentKey = canonicalTool(parentTool);
              let parentGrp = groups.get(parentKey);
              if (!parentGrp) {
                parentGrp = addGroupToStrip(parentKey, strip, panel!);
                groups.set(parentKey, parentGrp);
              }
              parentGrp.bucket.appendChild(parentEl);
              parentEl.dataset.toolGrouped = "1";
              // parent is a tool_use, bump its chip
              bumpChip(parentGrp.chip);
              agentGroupById.set(parentId, parentGrp);
              agentGrp = parentGrp;
            } else {
              // Parent already grouped or not a tool-row - use whatever group exists
              const parentKey = canonicalTool(parentTool);
              agentGrp = groups.get(parentKey) ?? null!;
              if (agentGrp) agentGroupById.set(parentId, agentGrp);
              else { parentId = null; } // give up, fold into main
            }
          } else {
            parentId = null; // parent not found in range
          }
        }
      }

      if (parentId && agentGrp) {
        // Level 1: per-subagent chip (labeled by description) inside the single
        // Task/Agent bucket. All subagents of the turn share this one strip.
        const { nestedStrip: subStrip, nestedPanel: subPanel } =
          getOrCreateNestedStripInBucket(agentGrp.bucket, subagentGroups);
        let subGrp = subagentGroups.get(parentId);
        if (!subGrp) {
          subGrp = addGroupToStrip(parentId, subStrip, subPanel, {
            label: idDescription.get(parentId) ?? "Subagent",
            icon: "ph-robot",
            agent: true,
          });
          subagentGroups.set(parentId, subGrp);
        }

        // Level 2: per-tool-type chip inside this subagent's bucket.
        let toolGroups = toolGroupsBySub.get(parentId);
        if (!toolGroups) {
          toolGroups = new Map();
          toolGroupsBySub.set(parentId, toolGroups);
        }
        const { nestedStrip: tStrip, nestedPanel: tPanel } =
          getOrCreateNestedStripInBucket(subGrp.bucket, toolGroups);
        let tGrp = toolGroups.get(key);
        if (!tGrp) {
          tGrp = addGroupToStrip(key, tStrip, tPanel);
          toolGroups.set(key, tGrp);
        }

        tGrp.bucket.appendChild(el);
        el.dataset.toolGrouped = "1";

        if (isUse) {
          bumpChip(tGrp.chip);   // tool-type count (Read x4)
          bumpChip(subGrp.chip); // subagent total-calls count
        }
        continue; // done with this child row
      }
      // Fallthrough: couldn't resolve parent -> fold into main strip below
    }

    // ------------------------------------------------------------------
    // Main-strip fold
    // ------------------------------------------------------------------
    let group = groups.get(key);
    if (!group) {
      group = addGroupToStrip(key, strip, panel!);
      groups.set(key, group);
    }

    // If this is an Agent/Task tool_use, register it so later children find it.
    if (isUse && (tool === "Task" || tool === "Agent") && m.kind === "tool_use" && m.id) {
      agentGroupById.set(m.id, group);
    }

    // Custom-view tools: don't stack raw rows in the bucket. Pull the row out
    // of the chat flow, count it on the chip, and flag the bucket for a rebuild
    // from message data below (one-row-per-file, skill list, Q&A pairs).
    if (CUSTOM_VIEW_TOOLS.has(key)) {
      group.bucket.dataset.customView = key;
      el.dataset.toolGrouped = "1";
      el.remove();
      if (isUse) bumpChip(group.chip);
      customBuckets.set(group.bucket, key);
      continue;
    }

    group.bucket.appendChild(el);
    el.dataset.toolGrouped = "1";

    if (isUse) {
      bumpChip(group.chip);
    }
  }

  // Rebuild every custom bucket touched this flush from the full turn range so
  // counts/answers stay correct as more calls stream in (idempotent: a full
  // innerHTML rewrite each time).
  for (const [bucket, key] of customBuckets) {
    rebuildCustomBucket(bucket, key, messages, start, end);
  }
}

/**
 * Rebuild the per-tool-type group map from a strip already present in the DOM
 * for this range. When a turn straddles a bulk-load flush boundary, its first
 * tool rows were grouped into a strip on the earlier flush; recovering that
 * strip here lets the close pass extend it instead of spawning a SECOND strip
 * for the same turn (the reload "chips split into rows" bug).
 *
 * Only recovers MAIN-strip groups (strips not inside a .tool-strip-group).
 * Nested strips inside Agent/Task buckets are recovered lazily by
 * getOrCreateNestedStripInBucket when groupToolRange processes children.
 */
function recoverGroupsFromDom(
  messageEls: HTMLElement[],
  start: number,
  end: number,
): Map<string, ToolGroup> {
  const groups = new Map<string, ToolGroup>();
  for (let i = start; i < end; i++) {
    const el = messageEls[i];
    if (!el || el.dataset.toolGrouped !== "1") continue;
    const bucket = el.closest<HTMLElement>(".tool-strip-group");
    const panel = bucket?.closest<HTMLElement>(".tool-strip-panel") ?? null;
    const strip = (panel?.previousElementSibling as HTMLElement | null) ?? null;
    const key = bucket?.dataset.tool;
    if (!bucket || !panel || !strip || !strip.classList.contains("tool-strip") || !key) continue;
    // Skip nested strips (those whose .tool-strip is itself inside a .tool-strip-group).
    if (strip.closest(".tool-strip-group")) continue;
    if (groups.has(key)) continue;
    const chip = strip.querySelector<HTMLElement>(`.tool-chip[data-tool="${key}"]`);
    if (!chip) continue;
    groups.set(key, { chip, bucket, strip, panel });
  }
  return groups;
}

/**
 * Finalize a closed turn: drop the working shimmer from its final answer and
 * fold any not-yet-grouped tool rows (covers bulk replay where multiple turns
 * close inside one render flush). Reuses an existing strip for this turn (if a
 * prior flush already started one) so a chunk-straddling turn stays ONE strip.
 */
export function applyTurnCollapse(
  messages: RenderedMessage[],
  messageEls: HTMLElement[],
  start: number,
  end: number,
  stripHost?: HTMLElement | null,
): void {
  if (end <= start) return;

  for (let i = end - 1; i >= start; i--) {
    if (messages[i]?.kind === "assistant") {
      messageEls[i]?.classList.remove("msg--working");
      break;
    }
  }

  groupToolRange(messages, messageEls, start, end, recoverGroupsFromDom(messageEls, start, end), stripHost);
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
