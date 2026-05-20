//! Daemon-side automated-channel lifecycle. Owns the channel processes so
//! they survive app close. Mirrors the app-side `channels/lifecycle.rs` but
//! is driven by `Arc<DaemonState>` (settings cache for project resolution,
//! notifier for `channels_changed`) instead of a Tauri `AppHandle`.
//!
//! No auto-restart on exit (matches the original obsidian_claude_remote
//! behaviour; respawning registers a fresh remote-control bridge each time,
//! piling up duplicate Claude desktop sidebar entries). See memory
//! `project_remote_control_bridge_id.md`.

use std::sync::Arc;

use crate::channels::kill::kill_tree;
use crate::channels::manager::{channel_snapshot_to_json, ChannelSnapshot};
use crate::channels::spawn::{spawn_child, wait_for_child_exit, SpawnInput};
use crate::channels::window_chrome::{hide_hwnd, resolve_console_hwnd, strip_console_chrome};
use crate::daemon::state::DaemonState;
use crate::types::ChannelStatus;

/// Broadcasts the current channel list to all global subscribers.
fn emit_changed(state: &Arc<DaemonState>) {
    let snaps: Vec<_> = state.channels.list().iter().map(channel_snapshot_to_json).collect();
    state.notifier.publish("channels_changed", serde_json::json!(snaps));
}

/// Resolve (cwd, prefix, continue_flag) for a project from the settings cache.
fn resolve_project(state: &Arc<DaemonState>, project_id: &str) -> Result<(std::path::PathBuf, String, bool), String> {
    let settings = state.settings.snapshot();
    let p = settings
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project {project_id} not found"))?;
    let auto = p.automation.as_ref().ok_or("project has no automation")?;
    let prefix = auto.session_name_prefix.clone().unwrap_or_else(|| p.name.clone());
    Ok((p.path.clone(), prefix, auto.continue_flag))
}

pub fn start_channel(state: Arc<DaemonState>, project_id: String) -> Result<(), String> {
    let (cwd, prefix, continue_flag) = resolve_project(&state, &project_id)?;

    state.channels.put(ChannelSnapshot {
        project_id: project_id.clone(),
        pid: None,
        status: ChannelStatus::Starting,
        hwnd: None,
    });
    emit_changed(&state);

    let spawn_out = spawn_child(SpawnInput {
        project_id: project_id.clone(),
        cwd,
        session_name_prefix: prefix,
        continue_flag,
    })
    .map_err(|e| e.to_string())?;

    let pid = spawn_out.pid;
    state.channels.patch(&project_id, |s| {
        s.pid = Some(pid);
        s.status = ChannelStatus::Running;
    });
    emit_changed(&state);

    // Resolve + strip + hide the console window once it exists (Windows).
    {
        let state_h = state.clone();
        let proj_h = project_id.clone();
        tokio::spawn(async move {
            if let Some(hwnd) = resolve_console_hwnd(pid).await {
                strip_console_chrome(hwnd);
                hide_hwnd(hwnd);
                state_h.channels.patch(&proj_h, |s| s.hwnd = Some(hwnd));
                emit_changed(&state_h);
            }
        });
    }

    // Watch for exit; mark stopped. NO auto-restart.
    {
        let state_w = state.clone();
        let proj_w = project_id.clone();
        let handle = spawn_out.process_handle;
        let pid_for_wait = spawn_out.pid;
        tokio::spawn(async move {
            wait_for_child_exit(handle, pid_for_wait).await;
            state_w.channels.patch(&proj_w, |s| {
                s.status = ChannelStatus::Stopped;
                s.pid = None;
                s.hwnd = None;
            });
            emit_changed(&state_w);
        });
    }

    Ok(())
}

pub fn stop_channel(state: &Arc<DaemonState>, project_id: &str) -> Result<(), String> {
    let (pid, hwnd) = match state.channels.snapshot(project_id) {
        Some(s) => (s.pid, s.hwnd),
        None => return Ok(()),
    };
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    if let Some(h) = hwnd {
        hide_hwnd(h);
    }
    state.channels.patch(project_id, |s| {
        s.status = ChannelStatus::Stopped;
        s.pid = None;
        s.hwnd = None;
    });
    emit_changed(state);
    Ok(())
}

pub fn restart_channel(state: Arc<DaemonState>, project_id: String) -> Result<(), String> {
    stop_channel(&state, &project_id)?;
    start_channel(state, project_id)
}

pub fn show_channel(state: &Arc<DaemonState>, project_id: &str) -> Result<(), String> {
    let snap = state.channels.snapshot(project_id).ok_or("no channel for that project")?;
    let hwnd = snap.hwnd.ok_or("console not resolved yet")?;
    crate::channels::window_chrome::show_hwnd(hwnd);
    Ok(())
}

pub fn hide_channel(state: &Arc<DaemonState>, project_id: &str) -> Result<(), String> {
    let snap = state.channels.snapshot(project_id).ok_or("no channel for that project")?;
    let hwnd = snap.hwnd.ok_or("console not resolved yet")?;
    hide_hwnd(hwnd);
    Ok(())
}

pub fn list_channels(state: &Arc<DaemonState>) -> Vec<serde_json::Value> {
    state.channels.list().iter().map(channel_snapshot_to_json).collect()
}

/// Spawn every project whose automation is enabled + autostart_on_boot.
/// Called once at daemon startup.
pub fn autostart_all(state: Arc<DaemonState>) {
    let settings = state.settings.snapshot();
    let ids: Vec<String> = settings
        .projects
        .iter()
        .filter(|p| {
            p.automation
                .as_ref()
                .map(|a| a.enabled && a.autostart_on_boot)
                .unwrap_or(false)
        })
        .map(|p| p.id.clone())
        .collect();
    for id in ids {
        if let Err(e) = start_channel(state.clone(), id.clone()) {
            log::warn!("channel autostart failed for {id}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::types::Settings;

    #[tokio::test]
    async fn stop_unknown_channel_is_ok() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        assert!(stop_channel(&st, "ghost").is_ok());
        assert_eq!(list_channels(&st).len(), 0);
    }

    #[tokio::test]
    async fn start_unknown_project_errors() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let err = start_channel(st, "no-such-project".to_string()).unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[tokio::test]
    async fn show_channel_without_hwnd_errors() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        st.channels.put(ChannelSnapshot {
            project_id: "p1".into(),
            pid: Some(123),
            status: ChannelStatus::Running,
            hwnd: None,
        });
        let err = show_channel(&st, "p1").unwrap_err();
        assert!(err.contains("not resolved"), "got: {err}");
    }
}
