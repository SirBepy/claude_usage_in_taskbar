// Unified-git-diff parsing + rendering for the file surface (ai_todo 247),
// split out of file-surface.ts: a self-contained subsystem with no
// dependency on the surface's state beyond the parsed hunks it returns.

import { escapeHtml } from "../escape-html";

export type DiffRowKind = "add" | "del" | "ctx" | "hunk";
export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

// Parse a unified git diff (for a single file) into rows. Header noise before
// the first hunk ("diff --git", "index ...", "--- a/...", "+++ b/...") is
// skipped; everything else is read off the "@@ -a,b +c,d @@" hunk headers.
export function parseUnifiedDiff(diffText: string): DiffRow[] {
  const rawLines = diffText.split(/\r?\n/);
  if (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const rows: DiffRow[] = [];
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of rawLines) {
    const m = hunkRe.exec(raw);
    if (m) {
      oldLine = parseInt(m[1] ?? "0", 10);
      newLine = parseInt(m[2] ?? "0", 10);
      inHunk = true;
      rows.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", text: raw.slice(1), newLine });
      newLine++;
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "del", text: raw.slice(1), oldLine });
      oldLine++;
    } else {
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      rows.push({ kind: "ctx", text, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }
  return rows;
}

export function renderUnifiedDiffHtml(rows: DiffRow[]): string {
  const trs = rows
    .map((r) => {
      if (r.kind === "hunk") {
        return `<tr class="fs-hunk"><td colspan="4">${escapeHtml(r.text)}</td></tr>`;
      }
      const sign = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
      const oldCell = r.oldLine !== undefined ? String(r.oldLine) : "";
      const newCell = r.newLine !== undefined ? String(r.newLine) : "";
      const codeText = r.text.length ? escapeHtml(r.text) : "&#8203;";
      return (
        `<tr class="fs-${r.kind}">` +
        `<td class="fs-ln" data-no-search="1">${oldCell}</td>` +
        `<td class="fs-ln" data-no-search="1">${newCell}</td>` +
        `<td class="fs-sign" data-no-search="1">${sign}</td>` +
        `<td class="fs-code">${codeText}</td></tr>`
      );
    })
    .join("");
  return `<table class="fs-udiff">${trs}</table>`;
}

export function renderSplitDiffHtml(rows: DiffRow[]): string {
  const left: string[] = [];
  const right: string[] = [];
  const rowDiv = (line: number | undefined, text: string, cls: string): string =>
    `<div class="fs-srow ${cls}"><span class="fs-ln" data-no-search="1">${line ?? ""}</span>` +
    `<span class="fs-code">${text.length ? escapeHtml(text) : "&#8203;"}</span></div>`;
  const padDiv = (): string =>
    `<div class="fs-srow fs-pad"><span class="fs-ln" data-no-search="1"></span><span class="fs-code"></span></div>`;
  for (const r of rows) {
    if (r.kind === "hunk") {
      left.push(`<div class="fs-hunk">${escapeHtml(r.text)}</div>`);
      right.push(`<div class="fs-hunk">&nbsp;</div>`);
      continue;
    }
    if (r.kind === "ctx") {
      left.push(rowDiv(r.oldLine, r.text, ""));
      right.push(rowDiv(r.newLine, r.text, ""));
    } else if (r.kind === "del") {
      left.push(rowDiv(r.oldLine, r.text, "fs-del"));
      right.push(padDiv());
    } else {
      left.push(padDiv());
      right.push(rowDiv(r.newLine, r.text, "fs-add"));
    }
  }
  return `<div class="fs-sdiff"><div class="fs-side">${left.join("")}</div><div class="fs-side">${right.join("")}</div></div>`;
}
