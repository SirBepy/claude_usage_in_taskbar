// Tauri compatibility shim: rebuilds window.electronAPI on top of Tauri IPC.
// MVP-scoped. Methods backing dropped features (sync, piper, token stats,
// update-state IPC) are no-op stubs that return sensible defaults.

(function () {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const listen = T.event.listen;

  // The Tauri backend returns UsageSnapshot { captured_at, five_hour, seven_day,
  // extra_usage }, but dashboard.js/chart.js still read the legacy Electron
  // shape { hour, session_pct, weekly_pct, session_resets_at, weekly_resets_at }.
  // Translate here until the renderer is ported to the new names.
  function toLegacyRecord(snap) {
    if (!snap || !snap.five_hour || !snap.seven_day) return null;
    const d = new Date(snap.captured_at);
    // `hourToMs` in formatters.js parses "YYYY-MM-DDTHH[:MM]" as LOCAL time.
    // Emit a local-time hour bucket so the two sides round-trip cleanly.
    const pad = (n) => String(n).padStart(2, "0");
    const hour =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
    return {
      hour,
      session_pct: Math.round(snap.five_hour.utilization),
      weekly_pct: Math.round(snap.seven_day.utilization),
      session_resets_at: snap.five_hour.resets_at || null,
      weekly_resets_at: snap.seven_day.resets_at || null,
      extra_usage: snap.extra_usage || null,
    };
  }

  async function fetchHistoryLegacy() {
    const raw = await invoke('get_history', { limit: null });
    return (raw || []).map(toLegacyRecord).filter(Boolean);
  }

  const bridge = {
    // --- Usage + history ---
    getUsageHistory: fetchHistoryLegacy,
    pollNow: () => invoke('poll_now'),

    // --- Settings ---
    getSettings: () => invoke('get_settings'),
    saveSettings: async (settings) => {
      try { await invoke('save_settings', { updated: settings }); }
      catch (e) { console.error('save_settings failed', e); throw e; }
    },
    logout: () => invoke('logout'),

    // --- Login (new in Tauri; dashboard must call this) ---
    startLogin: () => invoke('start_login'),
    authStatus: () => invoke('auth_status'),

    // --- Update state ---
    getUpdateState: () => invoke('get_update_state'),
    downloadUpdate: () => {},
    downloadAndInstall: () => invoke('download_and_install_update'),
    installUpdate: () => invoke('install_update'),
    checkForUpdates: () => invoke('check_for_updates'),
    copyLogs: () => invoke('copy_logs'),
    getAppVersion: () => invoke('get_app_version'),
    getPlatform: () => invoke('get_platform'),
    openExternal: (url) => invoke('open_external', { url }),

    onUpdateStateChange: (cb) => {
      T.event.listen('update-state', (e) => cb(e.payload));
    },
    onHistoryUpdated: (cb) => {
      const unlisten = listen('usage-updated', async () => {
        try { cb(await fetchHistoryLegacy()); }
        catch (e) { console.error('onHistoryUpdated refetch failed', e); }
      });
      return () => unlisten.then((u) => u());
    },

    // --- File system (dashboard stats tabs may call this) ---
    checkPathsExist: async (paths) => {
      try { return (await invoke('check_paths_exist', { paths })) || {}; }
      catch (e) { console.error('check_paths_exist failed', e); return {}; }
    },

    // --- Open in explorer / VS Code ---
    openInExplorer: async (p) => {
      try { await invoke('open_in_explorer', { path: p }); }
      catch (e) { console.error('open_in_explorer failed', e); }
    },
    openInVSCode: async (p) => {
      try { await invoke('open_in_vscode', { path: p }); }
      catch (e) { console.error('open_in_vscode failed', e); }
    },

    // --- Sync (cut from MVP — stubs) ---
    syncRegister: async () => { throw new Error('sync disabled in MVP'); },
    syncLink: async () => { throw new Error('sync disabled in MVP'); },
    syncGenerateLinkCode: async () => { throw new Error('sync disabled in MVP'); },
    syncListDevices: async () => [],
    syncPull: async () => null,
    syncPush: async () => null,

    // --- Token stats ---
    getTokenHistory: async () => {
      try { return (await invoke('get_token_history')) || []; }
      catch (e) { console.error('get_token_history failed', e); return []; }
    },
    getActiveSessions: async () => {
      try { return (await invoke('get_active_sessions')) || []; }
      catch (e) { console.error('get_active_sessions failed', e); return []; }
    },
    backfillTranscripts: async () => {
      try { return await invoke('backfill_transcripts'); }
      catch (e) {
        console.error('backfill_transcripts failed', e);
        return { processed: 0, skipped: 0, subProcessed: 0, subSkipped: 0 };
      }
    },

    // --- Sound packs ---
    listSoundPacks: () => invoke('list_sound_packs'),
    installSoundPack: (packId) => invoke('install_sound_pack', { packId }),
    soundPackFileUrl: (pack, sound) =>
      window.__TAURI__.core.invoke("sound_pack_file_url", { pack, sound }),

    // --- Piper TTS ---
    piperStatus: () => invoke('piper_status'),
    piperInstallVoice: (id) => invoke('piper_install_voice', { id }),
    speakPreview: ({ text, voiceName }) => invoke('piper_speak_preview', { text, voiceName }),
    playSoundPreview: (filename) => invoke('play_sound_preview', { filename }),
    playPackSoundPreview: (pack, sound) => invoke('play_pack_sound_preview', { pack, sound }),
    piperInstallBinary: async () => ({ ok: false, reason: 'disabled in MVP' }),
    onPiperProgress: (_cb) => () => {},
    onTokenHistoryUpdated: (cb) => {
      const unlisten = listen('token-history-updated', (e) => {
        try { cb(e?.payload || []); }
        catch (err) { console.error('onTokenHistoryUpdated handler threw', err); }
      });
      return () => unlisten.then((u) => u());
    },

    // --- Projects (Plan A shell; populated by Plan B) ---
    listProjects: () => invoke('list_projects'),
    getProject: (id) => invoke('get_project', { id }),
    updateProject: async (id, patch) => {
      try { await invoke('update_project', { id, patch }); }
      catch (e) { console.error('update_project failed', e); throw e; }
    },
    deleteProject: async (id) => {
      try { await invoke('delete_project', { id }); }
      catch (e) { console.error('delete_project failed', e); throw e; }
    },
    setProjectsViewMode: async (mode) => {
      try { await invoke('set_projects_view_mode', { mode }); }
      catch (e) { console.error('set_projects_view_mode failed', e); throw e; }
    },

    // --- Channels (Plan C) ---
    spawnChannel: async (projectId) => {
      try { await invoke('spawn_channel', { projectId }); }
      catch (e) { console.error('spawn_channel failed', e); throw e; }
    },
    stopChannel: async (projectId) => {
      try { await invoke('stop_channel', { projectId }); }
      catch (e) { console.error('stop_channel failed', e); throw e; }
    },
    restartChannel: async (projectId) => {
      try { await invoke('restart_channel', { projectId }); }
      catch (e) { console.error('restart_channel failed', e); throw e; }
    },
    showTerminal: async (projectId) => {
      try { await invoke('show_terminal', { projectId }); }
      catch (e) { console.error('show_terminal failed', e); throw e; }
    },
    hideTerminal: async (projectId) => {
      try { await invoke('hide_terminal', { projectId }); }
      catch (e) { console.error('hide_terminal failed', e); throw e; }
    },
    listChannels: () => invoke('list_channels'),
    detectObsidianVaults: () => invoke('detect_obsidian_vaults'),
    importLegacyObsidianConfig: () => invoke('import_legacy_obsidian_config'),
    confirmLegacyObsidianImport: (accept) => invoke('confirm_legacy_obsidian_import', { accept }),
    onChannelsChanged: (cb) => {
      const unlisten = T.event.listen('channels-changed', (e) => cb(e.payload));
      return () => unlisten.then((u) => u());
    },

    // --- Instances (Plan B) ---
    listInstances: async () => {
      try { return (await invoke('list_instances')) || []; }
      catch (e) { console.error('list_instances failed', e); return []; }
    },
    listInstancesForProject: async (projectId) => {
      try { return (await invoke('list_instances_for_project', { projectId })) || []; }
      catch (e) { console.error('list_instances_for_project failed', e); return []; }
    },
    phoneLink: async (sessionId) => {
      try { return await invoke('phone_link', { sessionId }); }
      catch (e) { console.error('phone_link failed', e); return null; }
    },
    onInstancesChanged: (cb) => {
      const unlisten = listen('instances-changed', (e) => {
        try { cb(e?.payload || []); }
        catch (err) { console.error('onInstancesChanged handler threw', err); }
      });
      return () => unlisten.then((u) => u());
    },

    // --- Hook registration (Plan B) ---
    getHookRegistrationState: async () => {
      try { return await invoke('get_hook_registration_state'); }
      catch (e) { console.error('get_hook_registration_state failed', e); return { registered: false, declined: false, port: null }; }
    },
    registerHooksGlobally: async () => {
      try { await invoke('register_hooks_globally'); }
      catch (e) { console.error('register_hooks_globally failed', e); throw e; }
    },
    skipHookRegistration: async () => {
      try { await invoke('skip_hook_registration'); }
      catch (e) { console.error('skip_hook_registration failed', e); throw e; }
    },
  };

  window.electronAPI = bridge;
})();
