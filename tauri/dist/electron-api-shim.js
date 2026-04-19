// Tauri compatibility shim: rebuilds window.electronAPI on top of Tauri IPC.
// MVP-scoped. Methods backing dropped features (sync, piper, token stats,
// update-state IPC) are no-op stubs that return sensible defaults.

(function () {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const listen = T.event.listen;

  const bridge = {
    // --- Usage + history ---
    getUsageHistory: () => invoke('get_history', { limit: null }),

    // --- Settings ---
    getSettings: () => invoke('get_settings'),
    saveSettings: async (settings) => {
      try { await invoke('save_settings', { updated: settings }); }
      catch (e) { console.error('save_settings failed', e); }
    },
    logout: () => invoke('logout'),

    // --- Login (new in Tauri; dashboard must call this) ---
    startLogin: () => invoke('start_login'),
    authStatus: () => invoke('auth_status'),

    // --- Update state: plugin owns this; stubs return a safe default ---
    getUpdateState: async () => {
      try { return { state: 'idle', version: await T.app.getVersion() }; }
      catch { return { state: 'idle', version: null }; }
    },
    downloadUpdate: () => {},
    downloadAndInstall: () => {},
    installUpdate: () => {},
    checkForUpdates: () => {},
    copyLogs: () => {},
    getAppVersion: async () => {
      const meta = await T.app.getVersion();
      return meta;
    },
    getPlatform: async () => 'win32',
    openExternal: (url) => T.shell?.open?.(url),

    onUpdateStateChange: (_cb) => () => {},
    onHistoryUpdated: (cb) => {
      const unlisten = listen('usage-updated', async () => {
        try { cb(await invoke('get_history', { limit: null })); }
        catch (e) { console.error('onHistoryUpdated refetch failed', e); }
      });
      return () => unlisten.then((u) => u());
    },

    // --- File system (dashboard stats tabs may call this) ---
    checkPathsExist: async (_paths) => ({}),

    // --- Open in explorer / VS Code (optional niceties) ---
    openInExplorer: (p) => T.shell?.open?.(p),
    openInVSCode: (_p) => {},

    // --- Sync (cut from MVP — stubs) ---
    syncRegister: async () => { throw new Error('sync disabled in MVP'); },
    syncLink: async () => { throw new Error('sync disabled in MVP'); },
    syncGenerateLinkCode: async () => { throw new Error('sync disabled in MVP'); },
    syncListDevices: async () => [],
    syncPull: async () => null,
    syncPush: async () => null,

    // --- Token stats (deferred to v2 — stubs) ---
    getTokenHistory: async () => [],
    getActiveSessions: async () => [],
    backfillTranscripts: async () => ({ processed: 0 }),

    // --- Piper TTS (deferred to v2 — stubs) ---
    speakPreview: (_t) => {},
    piperStatus: async () => ({ installed: false }),
    piperInstallBinary: async () => ({ ok: false, reason: 'disabled in MVP' }),
    piperInstallVoice: async () => ({ ok: false, reason: 'disabled in MVP' }),
    onPiperProgress: (_cb) => () => {},
    onTokenHistoryUpdated: (_cb) => () => {},
  };

  window.electronAPI = bridge;
})();
