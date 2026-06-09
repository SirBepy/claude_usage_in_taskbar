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
      default:
        return { icon: "ph-wrench", target: "" };
    }
  })();
  return { icon, tool, target: capTarget(target) };
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

export interface ToolTally {
  /** insertion order = first-seen order */
  byType: { tool: string; count: number }[];
  /** non-image Read/Edit/Write/MultiEdit/NotebookEdit targets, distinct, with repeat counts */
  files: { path: string; count: number }[];
  /** image-extension targets, distinct, with repeat counts */
  images: { path: string; filename: string; count: number }[];
}
