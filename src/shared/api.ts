// Typed bridge to the Rust backend. Replaces the deleted
// src/electron-api-shim.js. Every method here wraps a Tauri `invoke`
// call (via shared/ipc.ts) or an event subscription.
//
// Methods backing dropped MVP features (sync, piper-install, no-op update
// callbacks) are kept as stubs so callers don't crash.

import { invoke } from "./ipc";
import type { TokenRecord, AliasMap } from "./tokens";
import type { SettingsShape } from "./state";
import type { CharacterWhitelist } from "../types/ipc.generated";

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

// Per-model availability, from the count_tokens probe (probe_models_availability).
// `message` carries the API's reason when a model is disabled (else null).
export interface ModelAvailability {
  id: string;
  available: boolean;
  message: string | null;
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

export interface AudioOutputDevice {
  name: string;
  is_default: boolean;
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

export type CharacterSlot =
  | "work_finished"
  | "question_asked"
  | "ready"
  | "select"
  | "annoyed"
  | "death";

export interface Character {
  id: string;
  label: string;
  version: number;
  icon: string;
  game?: string;
  game_label?: string;
  slots: { [key: string]: string[] };
}
export interface PiperStatus { [k: string]: unknown; }
export interface ProjectConfig { id: string; path: string; [k: string]: unknown; }
export interface ProjectGroup {
  id: string | null;
  path: string;
  name: string;
  parent_segment: string | null;
  avatar: { kind: string; value?: unknown };
  automation_enabled: boolean;
  tokens_7d: number;
  live: number;
  any_remote: boolean;
  any_automated: boolean;
  last_active_at: string | null;
}
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
  fetchAvailableModels: (): Promise<string[]> => invoke("fetch_available_models"),
  probeModelsAvailability: (models: string[]): Promise<ModelAvailability[]> =>
    invoke("probe_models_availability", { models }),

  // --- Audio ---
  listAudioOutputDevices: async (): Promise<AudioOutputDevice[]> => {
    try { return (await invoke<AudioOutputDevice[]>("list_audio_output_devices")) || []; }
    catch (e) { console.error("list_audio_output_devices failed", e); return []; }
  },

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
  getVersionInfo: (): Promise<{ version: string; build_date: string; installed_at: string | null }> =>
    invoke("get_version_info"),
  getPlatform: (): Promise<string> => invoke("get_platform"),
  openExternal: (url: string): Promise<unknown> => invoke("open_external", { url }),

  // --- Chats window ---
  openChatsForSession: async (sessionId: string, mode: "live" | "history"): Promise<void> => {
    try { await invoke("open_chats_for_session", { sessionId, mode }); }
    catch (e) { console.error("open_chats_for_session failed", e); throw e; }
  },
  takePendingChatOpen: async (): Promise<[string, string] | null> => {
    try { return (await invoke<[string, string] | null>("take_pending_chat_open")) ?? null; }
    catch (e) { console.error("take_pending_chat_open failed", e); return null; }
  },
  getSessionConfig: async (sessionId: string): Promise<{ model: string; effort: string } | null> => {
    try { return (await invoke<{ model: string; effort: string } | null>("get_session_config", { sessionId })) ?? null; }
    catch (e) { console.error("get_session_config failed", e); return null; }
  },

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

  // --- Characters ---
  listCharacters: (): Promise<Character[]> => invoke("list_characters"),
  assignCharacter: (projectId: string, characterId: string | null): Promise<void> =>
    invoke("assign_character", { projectId, characterId }),
  playCharacterSlot: (characterId: string, slot: CharacterSlot): Promise<void> =>
    invoke("play_character_slot", { characterId, slot }),
  characterAssetUrl: (characterId: string, file: string): Promise<string | null> =>
    invoke("character_asset_url", { characterId, file }),
  previewCharacterFile: (characterId: string, file: string): Promise<void> =>
    invoke("preview_character_file", { characterId, file }),
  stopCharacterPreview: (): Promise<void> => invoke("stop_character_preview"),
  onCharacterPreviewEnded: (cb: () => void): Unlisten =>
    listenEvent("character-preview-ended", cb),
  getCharactersDir: (): Promise<string> => invoke("get_characters_dir"),
  invalidateCharactersCache: (): Promise<void> => invoke("invalidate_characters_cache"),

  // --- Session characters ---
  ensureSessionCharacter: (sessionId: string): Promise<string | null> =>
    invoke("ensure_session_character", { sessionId }),
  setSessionCharacter: (sessionId: string, characterId: string | null): Promise<void> =>
    invoke("set_session_character", { sessionId, characterId }),
  rerollSessionCharacter: (sessionId: string): Promise<string | null> =>
    invoke("reroll_session_character", { sessionId }),
  listSessionCharacters: (): Promise<Record<string, string>> =>
    invoke("list_session_characters"),

  // --- Whitelist ---
  getProjectWhitelist: (projectId: string): Promise<CharacterWhitelist> =>
    invoke("get_project_whitelist", { projectId }),
  setProjectWhitelist: (projectId: string, whitelist: CharacterWhitelist): Promise<void> =>
    invoke("set_project_whitelist", { projectId, whitelist }),
  getDefaultWhitelist: (): Promise<CharacterWhitelist> =>
    invoke("get_default_whitelist"),
  setDefaultWhitelist: (whitelist: CharacterWhitelist): Promise<void> =>
    invoke("set_default_whitelist", { whitelist }),
  resolveWhitelistCharacters: (projectId: string): Promise<Character[]> =>
    invoke("resolve_whitelist_characters", { projectId }),

  // --- Piper TTS ---
  piperStatus: (): Promise<PiperStatus> => invoke("piper_status"),
  piperInstallVoice: (id: string): Promise<unknown> =>
    invoke("piper_install_voice", { id }),
  speakPreview: ({ text, voiceName }: { text: string; voiceName: string | null }): Promise<unknown> =>
    invoke("piper_speak_preview", { text, voiceName }),
  playSoundPreview: (filename: string): Promise<unknown> =>
    invoke("play_sound_preview", { filename }),
  piperInstallBinary: async (): Promise<{ ok: boolean; reason: string }> =>
    ({ ok: false, reason: "disabled in MVP" }),
  onPiperProgress: (_cb: (p: unknown) => void): Unlisten => () => { /* no-op */ },

  // --- Projects ---
  listProjects: (): Promise<ProjectConfig[]> => invoke("list_projects"),
  listProjectGroups: (): Promise<ProjectGroup[]> => invoke("list_project_groups"),
  // Project-face fallback detection (ai_todo 99): a project's own icon file, or
  // its detected tech-stack key. Both fail soft (null) so the list never breaks.
  getProjectTech: (root: string): Promise<string | null> => invoke("get_project_tech", { root }),
  getProjectIcon: (root: string): Promise<{ mime: string; base64: string } | null> =>
    invoke("get_project_icon", { root }),
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

  // --- Skill usage ---
  getSkillUsageWeek: async (): Promise<import("../types/ipc.generated").SkillUsageWeek> => {
    try { return await invoke<import("../types/ipc.generated").SkillUsageWeek>("get_skill_usage_week"); }
    catch (e) { console.error("get_skill_usage_week failed", e); return { entries: [], total_sessions: 0 }; }
  },
  getSkillUsageDetail: async (
    skill: string,
  ): Promise<import("../types/ipc.generated").SkillDetail> => {
    try { return await invoke<import("../types/ipc.generated").SkillDetail>("get_skill_usage_detail", { skill }); }
    catch (e) {
      console.error("get_skill_usage_detail failed", e);
      return { skill, invocations: { total: 0, manual: 0, skill: 0, auto: 0 }, events: [] };
    }
  },
  listInstalledSkills: async (): Promise<import("../types/ipc.generated").InstalledSkill[]> => {
    try { return (await invoke<import("../types/ipc.generated").InstalledSkill[]>("list_installed_skills")) || []; }
    catch (e) { console.error("list_installed_skills failed", e); return []; }
  },
  onSkillUsageChanged: (cb: () => void): Unlisten =>
    listenEvent("skill-usage-changed", () => cb()),
  onDaemonStatus: (cb: (status: { connected: boolean }) => void): Unlisten =>
    listenEvent<{ connected: boolean }>("daemon-status-changed", cb),
};

export type Api = typeof api;

// Avoid `AliasMap` becoming a removed-import warning if a downstream view
// later imports it via re-export.
export type { AliasMap };
