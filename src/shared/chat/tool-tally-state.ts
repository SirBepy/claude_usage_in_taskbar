import { tallyDetail, canonicalTool, type ToolTally, type TallyItem } from "./tool-meta";

/**
 * Cumulative by-type tool tally for a chat session - the state behind the
 * statusline tally (`Read x4 · Grep x3 · ...`). Extracted verbatim from
 * ChatRenderer. Dedups by tool_use id so re-delivery / pagination can't
 * double-count. Maps preserve first-seen insertion order, which the public
 * ToolTally clone reflects.
 */
export class ToolTallyState {
  private tools = new Map<string, { count: number; items: Map<string, TallyItem> }>();
  private talliedIds = new Set<string>();

  /** Clone of the by-type tally (no internal refs leaked). */
  build(): ToolTally {
    return {
      byType: [...this.tools].map(([tool, e]) => ({
        tool,
        count: e.count,
        items: [...e.items.values()].map((it) => ({ ...it })),
      })),
    };
  }

  reset(): void {
    this.tools.clear();
    this.talliedIds.clear();
  }

  /**
   * Counts a tool_use exactly once (dedup by id), records its target. Returns
   * the updated tally when it counted, or null when the id was a duplicate so
   * the caller can skip firing its callback - preserving ChatRenderer's
   * original fire-only-when-counted behavior.
   */
  tallyToolUse(tool: string, input: unknown, id: string | undefined): ToolTally | null {
    if (id !== undefined) {
      if (this.talliedIds.has(id)) return null;
      this.talliedIds.add(id);
    }
    // Bucket under the canonical tool (PowerShell -> Bash, edit family -> Edit)
    // so the chip/tally shows one count per concept; the raw tool still drives
    // target classification below.
    const key = canonicalTool(tool);
    let entry = this.tools.get(key);
    if (!entry) {
      entry = { count: 0, items: new Map() };
      this.tools.set(key, entry);
    }
    entry.count += 1;
    const d = tallyDetail(tool, input);
    if (d) {
      const existing = entry.items.get(d.key);
      if (existing) {
        existing.count += 1;
      } else {
        entry.items.set(d.key, { label: d.label, kind: d.kind, path: d.path, filename: d.filename, count: 1 });
      }
    }
    return this.build();
  }
}
