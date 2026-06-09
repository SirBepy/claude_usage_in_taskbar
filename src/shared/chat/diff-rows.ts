// Pure diff-row model: align a hunk's oldText/newText into unified
// (interleaved) rows via jsdiff. Consumed by diff-enhancer.ts, which lays
// shiki tokens over the rows. Kept DOM-free so it unit-tests in plain node.

import { diffLines, diffWordsWithSpace } from "diff";

export type DiffRowKind = "ctx" | "add" | "del";

export interface DiffRow {
  kind: DiffRowKind;
  /** Line content without trailing newline (CRLF already normalised away). */
  text: string;
  /** 0-based line index into the side this row came from: old side for
   * "del", new side for "ctx" and "add". Used to pick the matching shiki
   * token line. */
  srcLine: number;
  /** Char ranges [start, end) within `text` to emphasise (word-level diff
   * vs the paired line on the other side). Only on del/add rows from
   * adjacent runs. */
  emph?: [number, number][];
}

/** Bail-out bound: diffs larger than this render as the plain fallback. */
const MAX_EDIT_LENGTH = 2000;

/** Word-level pairing is noise on huge runs; skip beyond this many lines. */
const MAX_EMPH_RUN_LINES = 20;

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
  // Row index spans per part, so adjacent del/add runs can be paired for
  // word-level emphasis after the rows exist.
  const runSpans: { kind: DiffRowKind; start: number; len: number }[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const p of parts) {
    // p.count is the authoritative line count; p.value.split("\n") carries a
    // phantom trailing "" when the run ends with a newline.
    const count = p.count ?? 0;
    const lines = p.value.split("\n");
    const kind: DiffRowKind = p.added ? "add" : p.removed ? "del" : "ctx";
    runSpans.push({ kind, start: rows.length, len: count });
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
  applyWordEmphasis(rows, runSpans);
  return rows;
}

/**
 * For each adjacent del-run/add-run pair (a replacement), line i of the del
 * run pairs with line i of the add run; diffWordsWithSpace marks what
 * changed within the pair. Skipped for runs over MAX_EMPH_RUN_LINES and for
 * line pairs with nothing in common (the line tint already says it all).
 */
function applyWordEmphasis(
  rows: DiffRow[],
  runSpans: { kind: DiffRowKind; start: number; len: number }[],
): void {
  for (let i = 0; i + 1 < runSpans.length; i++) {
    const del = runSpans[i]!;
    const add = runSpans[i + 1]!;
    if (del.kind !== "del" || add.kind !== "add") continue;
    if (del.len > MAX_EMPH_RUN_LINES || add.len > MAX_EMPH_RUN_LINES) continue;
    const pairs = Math.min(del.len, add.len);
    for (let j = 0; j < pairs; j++) {
      const delRow = rows[del.start + j]!;
      const addRow = rows[add.start + j]!;
      const parts = diffWordsWithSpace(delRow.text, addRow.text);
      // "Fully different" guard: if the only common content is whitespace,
      // the pair shares nothing real - emphasis would just repaint the whole
      // line the tint already covers.
      const sharesContent = parts.some(
        (p) => !p.added && !p.removed && /\S/.test(p.value),
      );
      if (!sharesContent) continue;
      const delRanges: [number, number][] = [];
      const addRanges: [number, number][] = [];
      let o = 0;
      let n = 0;
      for (const p of parts) {
        const len = p.value.length;
        if (p.added) {
          addRanges.push([n, n + len]);
          n += len;
        } else if (p.removed) {
          delRanges.push([o, o + len]);
          o += len;
        } else {
          o += len;
          n += len;
        }
      }
      if (delRanges.length) delRow.emph = delRanges;
      if (addRanges.length) addRow.emph = addRanges;
    }
  }
}
