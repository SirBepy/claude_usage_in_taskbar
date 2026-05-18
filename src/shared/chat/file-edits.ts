// Pure data layer: turn an Edit/Write/MultiEdit/NotebookEdit tool_use input
// into a normalised FileEditView. Consumed by edit-window.ts (inline render)
// and changes-panel.ts (right-rail aggregator). Returns null for any other
// tool, so the caller can fall back to the generic <pre>{json}</pre>.

export type FileEditKind = "edit" | "write" | "multi" | "notebook";

export interface FileEditHunk {
  oldText: string;
  newText: string;
  oldStartLine?: number;
  label?: string;
}

export interface FileEditView {
  path: string;
  basename: string;
  kind: FileEditKind;
  hunks: FileEditHunk[];
  addedLines: number;
  removedLines: number;
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function countLines(s: string): number {
  if (s === "") return 0;
  return s.split("\n").length;
}

function aggregate(hunks: FileEditHunk[]): { addedLines: number; removedLines: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    const oldN = countLines(h.oldText);
    const newN = countLines(h.newText);
    added += Math.max(0, newN - oldN);
    removed += Math.max(0, oldN - newN);
  }
  return { addedLines: added, removedLines: removed };
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === "object") return input as Record<string, unknown>;
  return null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function parseFileEdit(tool: string, input: unknown): FileEditView | null {
  const obj = asRecord(input);
  if (!obj) return null;

  switch (tool) {
    case "Edit": {
      const path = asString(obj.file_path);
      if (!path) return null;
      const hunks: FileEditHunk[] = [{
        oldText: asString(obj.old_string),
        newText: asString(obj.new_string),
      }];
      return { path, basename: basenameOf(path), kind: "edit", hunks, ...aggregate(hunks) };
    }
    case "Write": {
      const path = asString(obj.file_path);
      if (!path) return null;
      const hunks: FileEditHunk[] = [{
        oldText: "",
        newText: asString(obj.content),
      }];
      return { path, basename: basenameOf(path), kind: "write", hunks, ...aggregate(hunks) };
    }
    case "MultiEdit": {
      const path = asString(obj.file_path);
      const editsRaw = Array.isArray(obj.edits) ? obj.edits : [];
      if (!path || editsRaw.length === 0) return null;
      const hunks: FileEditHunk[] = editsRaw.map((e, i) => {
        const er = asRecord(e) ?? {};
        return {
          oldText: asString(er.old_string),
          newText: asString(er.new_string),
          label: `edit ${i + 1} of ${editsRaw.length}`,
        };
      });
      return { path, basename: basenameOf(path), kind: "multi", hunks, ...aggregate(hunks) };
    }
    case "NotebookEdit": {
      const path = asString(obj.notebook_path) || asString(obj.file_path);
      if (!path) return null;
      const cellId = asString(obj.cell_id);
      const hunks: FileEditHunk[] = [{
        oldText: asString(obj.old_source),
        newText: asString(obj.new_source),
        label: cellId ? `cell ${cellId}` : "cell",
      }];
      return { path, basename: basenameOf(path), kind: "notebook", hunks, ...aggregate(hunks) };
    }
    default:
      return null;
  }
}
