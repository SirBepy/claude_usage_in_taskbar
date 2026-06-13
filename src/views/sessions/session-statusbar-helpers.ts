import { invoke } from "../../shared/ipc";
import type { SessionMeta } from "../../shared/chat/chat-renderer";
import type { GitInfo, ContextStatus } from "../../types/ipc.generated";
import { modelLabel } from "../../shared/model-name";

export const DEFAULT_STATUSLINE_FIELDS = ["model", "effort", "branch", "repo", "context", "thinking", "messages", "turns"];

export const ALL_STATUSLINE_FIELDS = [
  { key: "branch",   label: "Branch" },
  { key: "repo",     label: "Repo" },
  { key: "folder",   label: "Project Folder" },
  { key: "model",    label: "Model" },
  { key: "effort",   label: "Effort" },
  { key: "context",  label: "Context %" },
  { key: "thinking", label: "Thinking" },
  { key: "duration", label: "Duration" },
  { key: "messages", label: "Messages" },
  { key: "turns",    label: "Turns" },
];

export async function loadStatuslineFields(): Promise<string[]> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    const v = s["statuslineFields"];
    if (Array.isArray(v)) return v as string[];
  } catch { /* ignore */ }
  return [...DEFAULT_STATUSLINE_FIELDS];
}

export async function saveStatuslineFields(fields: string[]): Promise<void> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    await invoke("save_settings", { updated: { ...s, statuslineFields: fields } });
  } catch (e) {
    console.error("[statusbar] save fields failed", e);
  }
}

// Tool-activity chips the user can show/hide in the statusbar tally row. Keys are
// raw tool names (what the chips group by); a tool not listed here always shows.
// Keys are CANONICAL tool buckets (see canonicalTool): Edit covers the whole
// edit family (Edit/MultiEdit/NotebookEdit), Bash covers Bash + PowerShell.
export const TALLY_TOOL_OPTIONS = [
  { key: "Read",            label: "Read" },
  { key: "Edit",            label: "Edited" },
  { key: "Write",           label: "Wrote" },
  { key: "Grep",            label: "Grep" },
  { key: "Glob",            label: "Glob" },
  { key: "Bash",            label: "Ran (shell)" },
  { key: "Task",            label: "Subagent" },
  { key: "TodoWrite",       label: "Todo updates" },
  { key: "AskUserQuestion", label: "Ask-user questions" },
  { key: "WebFetch",        label: "Web fetch" },
  { key: "WebSearch",       label: "Web search" },
];

// Denylist (raw tool names) hidden from the tally row by default. Noise the user
// rarely cares to scan: question prompts and todo bookkeeping.
export const DEFAULT_TALLY_HIDDEN_TOOLS = ["AskUserQuestion", "TodoWrite"];

export async function loadTallyHiddenTools(): Promise<string[]> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    const v = s["tallyHiddenTools"];
    if (Array.isArray(v)) return v as string[];
  } catch { /* ignore */ }
  return [...DEFAULT_TALLY_HIDDEN_TOOLS];
}

export async function saveTallyHiddenTools(tools: string[]): Promise<void> {
  try {
    const s = await invoke<Record<string, unknown>>("get_settings");
    await invoke("save_settings", { updated: { ...s, tallyHiddenTools: tools } });
  } catch (e) {
    console.error("[statusbar] save tally tools failed", e);
  }
}

export function modelContextWindow(model: string | null): number {
  // claude-3-opus family is 200K; all other/future opus and all fable default to 1M.
  if (model && /claude-3[^0-9]*opus/i.test(model)) return 200_000;
  if (model && (model.includes("opus") || model.includes("fable"))) return 1_000_000;
  return 200_000;
}

export const shortModelName = modelLabel;

export function formatDuration(startedAt: string): string {
  const ms = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Switching between chats re-creates the statusbar each time. These caches
// avoid the visible "empty bar → chips pop in" flash by keeping the last
// known values around for re-use on the next mount, while still firing a
// background refresh (stale-while-revalidate for git).
export const gitInfoCache = new Map<string, GitInfo>();
const gitInflight = new Map<string, Promise<GitInfo>>();
export const metaCache = new Map<string, SessionMeta>();

/** messages (= user prompts sent) and agent turns, parsed from the session
 *  transcript by the `instance_token_stats` IPC - the SAME source Project
 *  Detail > Chats uses, so the numbers always match. */
export interface SessionCounts { prompts: number; turns: number; }
export const countsCache = new Map<string, SessionCounts>();

/** Last known daemon-computed context occupancy per session, fetched via the
 *  `context_status` IPC (the source of truth for the context chip). Cached so a
 *  re-mounted statusbar shows the last value instead of flashing the frontend
 *  fallback while the async refetch is in flight. */
export const ctxStatusCache = new Map<string, ContextStatus>();

export function fetchGitInfo(cwd: string): Promise<GitInfo> {
  let p = gitInflight.get(cwd);
  if (!p) {
    p = invoke<GitInfo>("get_git_info", { cwd })
      .then((info) => { gitInfoCache.set(cwd, info); gitInflight.delete(cwd); return info; })
      .catch((e) => { gitInflight.delete(cwd); throw e; });
    gitInflight.set(cwd, p);
  }
  return p;
}

export interface StatusbarOptions {
  cwd?: string | null;
  effort?: string;
  sessionId?: string | null;
  readOnly?: boolean;
  sessionModel?: string | null;
  /** Raw tool names hidden from the tally row (see loadTallyHiddenTools). */
  tallyHiddenTools?: string[];
}
