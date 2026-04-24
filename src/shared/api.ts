// Typed bridge to the Rust backend. Replaces the deleted
// src/electron-api-shim.js. Every method here wraps a Tauri `invoke`
// call (via shared/ipc.ts) or an event subscription.
//
// Methods backing dropped MVP features (sync, piper-install, no-op update
// callbacks) are kept as stubs so callers don't crash.

import { invoke } from "./ipc";
import type { TokenRecord, AliasMap } from "./tokens";
import type { SettingsShape } from "./state";

// ── Backend snapshot shape ────────────────────────────────────────────────

interface UsageWindow {
  utilization: number;
  resets_at?: string | null;
}
interface ExtraUsage {
  is_enabled?: boolean;
  used_credits?: number;
  monthly_limit?: number;
}
interface UsageSnapshot {
  captured_at: string;
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  extra_usage?: ExtraUsage | null;
}

// Renderer-facing legacy shape (kept until views consume UsageSnapshot directly).
export interface UsageRecord {
  hour: string;
  session_pct: number | null;
  weekly_pct: number | null;
  session_resets_at: string | null;
  weekly_resets_at: string | null;
  extra_usage: ExtraUsage | null;
  [k: string]: unknown;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }

function toUsageRecord(snap: UsageSnapshot | null | undefined): UsageRecord | null {
  if (!snap || !snap.five_hour || !snap.seven_day) return null;
  const d = new Date(snap.captured_at);
  const hour = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
  return {
    hour,
    session_pct: Math.round(snap.five_hour.utilization),
    weekly_pct: Math.round(snap.seven_day.utilization),
    session_resets_at: snap.five_hour.resets_at || null,
    weekly_resets_at: snap.seven_day.resets_at || null,
    extra_usage: snap.extra_usage || null,
  };
}

async function fetchHistoryLegacy(): Promise<UsageRecord[]> {
  const raw = await invoke<UsageSnapshot[]>("get_history", { limit: null });
  return (raw || []).map(toUsageRecord).filter((r): r is UsageRecord => r !== null);
}

// ── Event subscription helper ─────────────────────────────────────────────

type Unlisten = () => void;

function listenEvent<T>(name: string, cb: (payload: T) => void): Unlisten {
  const ev = window.__TAURI__?.event;
  if (!ev?.listen) return () => { /* no runtime */ };
  const p = ev.listen<T>(name, (e) => cb(e.payload));
  return () => { void p.then((u) => u()); };
}

// ── Typed payloads ────────────────────────────────────────────────────────

export interface UpdateState {
  state: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error" | string;
  version?: string;
  [k: string]: unknown;
}

export interface HookRegistrationState {
  registered?: boolean;
  declined?: boolean;
  port?: number | null;
}

export interface BackfillResult {
  processed: number;
  skipped: number;
  subProcessed: number;
  subSkipped: number;
}

export interface InstanceTokenStats {
  tokens: number;
  turns: number;
  prompts?: number;
}

export interface SoundPack { id: string; [k: string]: unknown; }
export interface PiperStatus { [k: string]: unknown; }
export interface ProjectConfig { id: string; path: string; [k: string]: unknown; }
export interface InstanceInfo { [k: string]: unknown; }
export interface AuthStatus { state?: string; [k: string]: unknown; }

// ── Public API ────────────────────────────────────────────────────────────

export const api = {
  // --- Usage + history ---
  getUsageHistory: (): Promise<UsageRecord[]> => fetchHistoryLegacy(),
  pollNow: (): Promise<unknown> => invoke("poll_now"),

  // --- Settings ---
  getSettings: (): Promise<SettingsShape | null> => invoke("get_settings"),
  saveSettings: (settings: SettingsShape): Promise<unknown> =>
    invoke("save_settings", { updated: settings }),

  // --- Auth ---
  logout: (): Promise<unknown> => invoke("logout"),
  startLogin: (): Promise<unknown> => invoke("start_login"),
  authStatus: (): Promise<AuthStatus> => invoke("auth_status"),

  // --- Update state ---
  getUpdateState: (): Promise<UpdateState> => invoke("get_update_state"),
  downloadUpdate: (): void => { /* no-op stub for legacy callers */ },
  downloadAndInstall: (): Promise<unknown> => invoke("download_and_install_update"),
  installUpdate: (): Promise<unknown> => invoke("install_update"),
  checkForUpdates: (): Promise<unknown> => invoke("check_for_updates"),
  copyLogs: (): Promise<unknown> => invoke("copy_logs"),
  getAppVersion: (): Promise<string> => invoke("get_app_version"),
  getPlatform: (): Promise<string> => invoke("get_platform"),
  openExternal: (url: string): Promise<unknown> => invoke("open_external", { url }),

  // --- File system ---
  checkPathsExist: async (paths: string[]): Promise<Record<string, boolean>> => {
    try { return (await invoke<Record<string, boolean>>("check_paths_exist", { paths })) || {}; }
    catch (e) { console.error("check_paths_exist failed", e); return {}; }
  },
  openInExplorer: async (p: string): Promise<void> => {
    try { await invoke("open_in_explorer", { path: p }); }
    catch (e) { console.error("open_in_explorer failed", e); }
  },
  openInVSCode: async (p: string): Promise<void> => {
    try { await invoke("open_in_vscode", { path: p }); }
    catch (e) { console.error("open_in_vscode failed", e); }
  },

  // --- Sync (cut from MVP — stubs) ---
  syncRegister: async (): Promise<never> => { throw new Error("sync disabled in MVP"); },
  syncLink: async (): Promise<never> => { throw new Error("sync disabled in MVP"); },
  syncGenerateLinkCode: async (): Promise<never> => { throw new Error("sync disabled in MVP"); },
  syncListDevices: async (): Promise<unknown[]> => [],
  syncPull: async (): Promise<null> => null,
  syncPush: async (): Promise<null> => null,

  // --- Token stats ---
  getTokenHistory: async (): Promise<TokenRecord[]> => {
    try { return (await invoke<TokenRecord[]>("get_token_history")) || []; }
    catch (e) { console.error("get_token_history failed", e); return []; }
  },
  getActiveSessions: async (): Promise<TokenRecord[]> => {
    try { return (await invoke<TokenRecord[]>("get_active_sessions")) || []; }
    catch (e) { console.error("get_active_sessions failed", e); return []; }
  },
  backfillTranscripts: async (): Promise<BackfillResult> => {
    try { return await invoke<BackfillResult>("backfill_transcripts"); }
    catch (e) {
      console.error("backfill_transcripts failed", e);
      return { processed: 0, skipped: 0, subProcessed: 0, subSkipped: 0 };
    }
  },

  // --- Sound packs ---
  listSoundPacks: (): Promise<SoundPack[]> => invoke("list_sound_packs"),
  installSoundPack: (packId: string): Promise<unknown> =>
    invoke("install_sound_pack", { packId }),
  soundPackFileUrl: (pack: string, sound: string): Promise<string | null> =>
    invoke("sound_pack_file_url", { pack, sound }),

  // --- Piper TTS ---
  piperStatus: (): Promise<PiperStatus> => invoke("piper_status"),
  piperInstallVoice: (id: string): Promise<unknown> =>
    invoke("piper_install_voice", { id }),
  speakPreview: ({ text, voiceName }: { text: string; voiceName: string | null }): Promise<unknown> =>
    invoke("piper_speak_preview", { text, voiceName }),
  playSoundPreview: (filename: string): Promise<unknown> =>
    invoke("play_sound_preview", { filename }),
  playPackSoundPreview: (pack: string, sound: string): Promise<unknown> =>
    invoke("play_pack_sound_preview", { pack, sound }),
  piperInstallBinary: async (): Promise<{ ok: boolean; reason: string }> =>
    ({ ok: false, reason: "disabled in MVP" }),
  onPiperProgress: (_cb: (p: unknown) => void): Unlisten => () => { /* no-op */ },

  // --- Projects ---
  listProjects: (): Promise<ProjectConfig[]> => invoke("list_projects"),
  getProject: (id: string): Promise<ProjectConfig | null> =>
    invoke("get_project", { id }),
  ensureProject: (cwd: string): Promise<ProjectConfig> =>
    invoke("ensure_project", { cwd }),
  updateProject: async (id: string, patch: Partial<ProjectConfig>): Promise<void> => {
    try { await invoke("update_project", { id, patch }); }
    catch (e) { console.error("update_project failed", e); throw e; }
  },
  deleteProject: async (id: string): Promise<void> => {
    try { await invoke("delete_project", { id }); }
    catch (e) { console.error("delete_project failed", e); throw e; }
  },
  setProjectsSortBy: async (sortBy: string): Promise<void> => {
    try { await invoke("set_projects_sort_by", { sortBy }); }
    catch (e) { console.error("set_projects_sort_by failed", e); throw e; }
  },

  // --- Channels ---
  spawnChannel: async (projectId: string): Promise<void> => {
    try { await invoke("spawn_channel", { projectId }); }
    catch (e) { console.error("spawn_channel failed", e); throw e; }
  },
  stopChannel: async (projectId: string): Promise<void> => {
    try { await invoke("stop_channel", { projectId }); }
    catch (e) { console.error("stop_channel failed", e); throw e; }
  },
  restartChannel: async (projectId: string): Promise<void> => {
    try { await invoke("restart_channel", { projectId }); }
    catch (e) { console.error("restart_channel failed", e); throw e; }
  },
  showTerminal: async (projectId: string): Promise<void> => {
    try { await invoke("show_terminal", { projectId }); }
    catch (e) { console.error("show_terminal failed", e); throw e; }
  },
  hideTerminal: async (projectId: string): Promise<void> => {
    try { await invoke("hide_terminal", { projectId }); }
    catch (e) { console.error("hide_terminal failed", e); throw e; }
  },
  listChannels: (): Promise<unknown[]> => invoke("list_channels"),
  detectObsidianVaults: (): Promise<string[]> => invoke("detect_obsidian_vaults"),
  importLegacyObsidianConfig: (): Promise<unknown> =>
    invoke("import_legacy_obsidian_config"),
  confirmLegacyObsidianImport: (accept: boolean): Promise<unknown> =>
    invoke("confirm_legacy_obsidian_import", { accept }),

  // --- Instances ---
  listInstances: async (): Promise<InstanceInfo[]> => {
    try { return (await invoke<InstanceInfo[]>("list_instances")) || []; }
    catch (e) { console.error("list_instances failed", e); return []; }
  },
  listInstancesForProject: async (projectId: string): Promise<InstanceInfo[]> => {
    try { return (await invoke<InstanceInfo[]>("list_instances_for_project", { projectId })) || []; }
    catch (e) { console.error("list_instances_for_project failed", e); return []; }
  },
  phoneLink: async (sessionId: string): Promise<string | null> => {
    try { return await invoke<string | null>("phone_link", { sessionId }); }
    catch (e) { console.error("phone_link failed", e); return null; }
  },
  instanceTokenStats: async (sessionId: string): Promise<InstanceTokenStats> => {
    try { return await invoke<InstanceTokenStats>("instance_token_stats", { sessionId }); }
    catch (e) { console.error("instance_token_stats failed", e); return { tokens: 0, turns: 0 }; }
  },

  // --- Hook registration ---
  getHookRegistrationState: async (): Promise<HookRegistrationState> => {
    try { return await invoke<HookRegistrationState>("get_hook_registration_state"); }
    catch (e) {
      console.error("get_hook_registration_state failed", e);
      return { registered: false, declined: false, port: null };
    }
  },
  registerHooksGlobally: async (): Promise<void> => {
    try { await invoke("register_hooks_globally"); }
    catch (e) { console.error("register_hooks_globally failed", e); throw e; }
  },
  skipHookRegistration: async (): Promise<void> => {
    try { await invoke("skip_hook_registration"); }
    catch (e) { console.error("skip_hook_registration failed", e); throw e; }
  },

  // --- Event subscriptions ---
  onUpdateStateChange: (cb: (s: UpdateState) => void): Unlisten =>
    listenEvent("update-state", cb),
  onHistoryUpdated: (cb: (h: UsageRecord[]) => void): Unlisten =>
    listenEvent("usage-updated", async () => {
      try { cb(await fetchHistoryLegacy()); }
      catch (e) { console.error("onHistoryUpdated refetch failed", e); }
    }),
  onTokenHistoryUpdated: (cb: (th: TokenRecord[]) => void): Unlisten =>
    listenEvent<TokenRecord[]>("token-history-updated", (payload) => {
      try { cb(payload || []); }
      catch (err) { console.error("onTokenHistoryUpdated handler threw", err); }
    }),
  onChannelsChanged: (cb: (payload: unknown) => void): Unlisten =>
    listenEvent("channels-changed", cb),
  onInstancesChanged: (cb: (list: unknown) => void): Unlisten =>
    listenEvent("instances-changed", (payload) => {
      try { cb(payload || []); }
      catch (err) { console.error("onInstancesChanged handler threw", err); }
    }),
};

export type Api = typeof api;

// Avoid `AliasMap` becoming a removed-import warning if a downstream view
// later imports it via re-export.
export type { AliasMap };
