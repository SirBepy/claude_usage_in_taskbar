import { basename } from "../path-utils";

export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];

/** Safely coerce an unknown tool input into a string-keyed record. */
function asObj(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

/** Lowercased file extension (including the dot), or "" if none. */
function extOf(path: string): string {
  const base = basename(path).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

/**
 * One-line summary for a tool_use: a Phosphor icon class, the display tool name,
 * and the primary target string. Defensive: `input` may be null/non-object.
 */
/** Max length for a tool summary target before it gets ellipsized. */
const TARGET_MAX = 100;

/** Cap a target at TARGET_MAX chars, appending a single ellipsis when truncated. */
function capTarget(target: string): string {
  return target.length > TARGET_MAX ? target.slice(0, TARGET_MAX) + "…" : target;
}

export function toolSummary(tool: string, input: unknown): { icon: string; tool: string; target: string } {
  const obj = asObj(input);
  const { icon, target } = ((): { icon: string; target: string } => {
    switch (tool) {
      case "Read":
        return { icon: "ph-file", target: basename(strField(obj, "file_path")) };
      case "Edit":
      case "MultiEdit":
        return { icon: "ph-pencil-simple", target: basename(strField(obj, "file_path")) };
      case "Write":
        return { icon: "ph-pencil-simple", target: basename(strField(obj, "file_path")) };
      case "NotebookEdit":
        return { icon: "ph-pencil-simple", target: basename(strField(obj, "notebook_path")) };
      case "Grep":
        return { icon: "ph-magnifying-glass", target: strField(obj, "pattern") };
      case "Glob":
        return { icon: "ph-folder", target: strField(obj, "pattern") };
      case "Bash":
      case "PowerShell": {
        const desc = strField(obj, "description");
        return { icon: "ph-terminal-window", target: desc || strField(obj, "command").slice(0, 48) };
      }
      case "Agent":
      case "Task":
        return { icon: "ph-robot", target: "starting subagent" };
      case "AskUserQuestion":
        return { icon: "ph-chats-circle", target: "" };
      case "Skill":
        return { icon: "ph-sparkle", target: typeof obj.skill === "string" ? obj.skill : "" };
      default:
        return { icon: "ph-wrench", target: "" };
    }
  })();
  return { icon, tool, target: capTarget(target) };
}

// Tools that fold into another tool's chip/tally so the user sees one bucket
// per concept, not per CLI variant: PowerShell and Bash are both "Ran"; the
// edit family (MultiEdit/NotebookEdit) AND Write fold into "Edit" - one
// "File Changes" bucket covers every file the turn created or modified.
const CANONICAL_TOOL: Record<string, string> = {
  PowerShell: "Bash",
  MultiEdit: "Edit",
  NotebookEdit: "Edit",
  Write: "Edit",
};

/** The bucket a tool groups under (Bash/PowerShell -> Bash, edit family -> Edit). */
export function canonicalTool(tool: string): string {
  return CANONICAL_TOOL[tool] ?? tool;
}

// Friendly verbs for a (canonical) tool, shown on tally + transcript chips.
const TOOL_LABELS: Record<string, string> = {
  Read: "Read",
  Edit: "File Changes",
  Grep: "Grep",
  Glob: "Glob",
  Bash: "Ran",
  Task: "Subagent",
  Agent: "Subagent",
  AskUserQuestion: "Questions",
  Skill: "Skills",
};

/** Friendly chip label for a tool, after canonicalizing (e.g. PowerShell -> "Ran"). */
export function toolLabel(tool: string): string {
  const c = canonicalTool(tool);
  return TOOL_LABELS[c] ?? c;
}

/** Classify a tool_use's target for the open-on-click popover. */
export function classifyTarget(
  tool: string,
  input: unknown,
): { kind: "file" | "image" | "none"; path?: string } {
  const obj = asObj(input);
  switch (tool) {
    case "Read": {
      const path = strField(obj, "file_path");
      if (!path) return { kind: "none" };
      if (IMAGE_EXTS.includes(extOf(path))) return { kind: "image", path };
      return { kind: "file", path };
    }
    case "Edit":
    case "Write":
    case "MultiEdit": {
      const path = strField(obj, "file_path");
      if (!path) return { kind: "none" };
      return { kind: "file", path };
    }
    case "NotebookEdit": {
      const path = strField(obj, "notebook_path");
      if (!path) return { kind: "none" };
      return { kind: "file", path };
    }
    default:
      return { kind: "none" };
  }
}

/** One distinct target behind a tool chip's drill-down popover. */
export interface TallyItem {
  /** display text: basename for files, pattern for Grep/Glob, desc/command for Bash */
  label: string;
  kind: "file" | "image" | "text";
  /** absolute path for openable file/image targets */
  path?: string;
  /** filename when kind === "image" */
  filename?: string;
  /** repeat count for identical targets */
  count: number;
}

export interface ToolTally {
  /** insertion order = first-seen order; each type carries its distinct targets */
  byType: { tool: string; count: number; items: TallyItem[] }[];
}

/**
 * Per-call detail for a tool chip's drill-down: what to show in the popover and,
 * for files/images, how to open it. `key` dedups identical targets. Returns null
 * for tools with nothing worth listing (e.g. unknown tools, Agent/Task).
 */
export function tallyDetail(
  tool: string,
  input: unknown,
): (Omit<TallyItem, "count"> & { key: string }) | null {
  const cls = classifyTarget(tool, input);
  if (cls.kind === "image" && cls.path) {
    return { key: cls.path, kind: "image", path: cls.path, filename: basename(cls.path), label: basename(cls.path) };
  }
  if (cls.kind === "file" && cls.path) {
    return { key: cls.path, kind: "file", path: cls.path, label: basename(cls.path) };
  }
  const obj = asObj(input);
  switch (tool) {
    case "Grep": {
      const p = strField(obj, "pattern");
      return p ? { key: "grep:" + p, kind: "text", label: capTarget(p) } : null;
    }
    case "Glob": {
      const p = strField(obj, "pattern");
      return p ? { key: "glob:" + p, kind: "text", label: capTarget(p) } : null;
    }
    case "Bash":
    case "PowerShell": {
      const label = strField(obj, "description") || strField(obj, "command");
      return label ? { key: "cmd:" + label, kind: "text", label: capTarget(label) } : null;
    }
    default:
      return null;
  }
}
