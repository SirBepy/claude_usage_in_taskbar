// Pure diff-row model: align a hunk's oldText/newText into unified
// (interleaved) rows via jsdiff. Consumed by diff-enhancer.ts, which lays
// shiki tokens over the rows. Kept DOM-free so it unit-tests in plain node.

import { diffLines } from "diff";

export type DiffRowKind = "ctx" | "add" | "del";

export interface DiffRow {
  kind: DiffRowKind;
  /** Line content without trailing newline (CRLF already normalised away). */
  text: string;
  /** 0-based line index into the side this row came from: old side for
   * "del", new side for "ctx" and "add". Used to pick the matching shiki
   * token line. */
  srcLine: number;
}

/** Bail-out bound: diffs larger than this render as the plain fallback. */
const MAX_EDIT_LENGTH = 2000;

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Returns unified diff rows, or null when the diff exceeds MAX_EDIT_LENGTH
 * (caller keeps the un-enhanced markup). Inputs must already be
 * EOL-normalised so row indices line up with tokenisation of the same text.
 */
export function buildDiffRows(oldText: string, newText: string): DiffRow[] | null {
  const parts = diffLines(oldText, newText, {
    ignoreNewlineAtEof: true,
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (!parts) return null;

  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const p of parts) {
    // p.count is the authoritative line count; p.value.split("\n") carries a
    // phantom trailing "" when the run ends with a newline.
    const count = p.count ?? 0;
    const lines = p.value.split("\n");
    const kind: DiffRowKind = p.added ? "add" : p.removed ? "del" : "ctx";
    for (let i = 0; i < count; i++) {
      const text = lines[i] ?? "";
      if (kind === "del") {
        rows.push({ kind, text, srcLine: oldLine });
        oldLine++;
      } else if (kind === "add") {
        rows.push({ kind, text, srcLine: newLine });
        newLine++;
      } else {
        rows.push({ kind, text, srcLine: newLine });
        oldLine++;
        newLine++;
      }
    }
  }
  return rows;
}
