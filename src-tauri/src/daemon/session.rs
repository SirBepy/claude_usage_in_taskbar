//! Per-session state in the daemon. One `Session` per long-lived `claude -p`
//! subprocess. Owned by the SessionMap; accessed via Arc.

use crate::types::chat::ChatEvent;
use dashmap::DashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::ChildStdin;
use tokio::sync::{broadcast, Mutex};

pub const BROADCAST_CAPACITY: usize = 1024;

pub struct Session {
    pub session_id: String,
    pub cwd: PathBuf,
    pub model: String,
    pub effort: String,
    pub pid: u32,
    pub stdin: Mutex<ChildStdin>,
    pub events: broadcast::Sender<ChatEvent>,
    /// Path to the per-session .mcp.json file. Removed on session end /
    /// pump exit. None if write_mcp_config failed (degrades to no
    /// permission-prompt tool, which is OK for v1).
    pub mcp_config_path: Option<PathBuf>,
    /// Path to the per-session hook-settings .settings.json file (registers
    /// the AskUserQuestion PreToolUse hook). Removed on session end / pump
    /// exit, mirroring `mcp_config_path`. None if write_hook_settings failed
    /// (degrades to AskUserQuestion being unanswerable this session).
    pub hook_settings_path: Option<PathBuf>,
    /// The registry account id this session was spawned under (resolved at
    /// spawn time - see `daemon::lifecycle::spawn_session`). Always set: a
    /// chat requires a registry account, there is no no-account spawn path.
    pub account_id: String,
}

impl Session {
    pub fn new(
        session_id: String,
        cwd: PathBuf,
        model: String,
        effort: String,
        pid: u32,
        stdin: ChildStdin,
        mcp_config_path: Option<PathBuf>,
        hook_settings_path: Option<PathBuf>,
        account_id: String,
    ) -> Arc<Self> {
        let (tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);
        Arc::new(Self {
            session_id,
            cwd,
            model,
            effort,
            pid,
            stdin: Mutex::new(stdin),
            events: tx,
            mcp_config_path,
            hook_settings_path,
            account_id,
        })
    }
}

pub type SessionMap = Arc<DashMap<String, Arc<Session>>>;

pub fn new_session_map() -> SessionMap {
    Arc::new(DashMap::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_session_map_is_empty() {
        let m = new_session_map();
        assert_eq!(m.len(), 0);
    }

    #[test]
    fn broadcast_capacity_constant() {
        assert!(BROADCAST_CAPACITY >= 256);
    }
}
