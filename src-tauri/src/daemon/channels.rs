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
use crate::channels::spawn::{resolve_claude_pid, spawn_child, wait_for_child_exit, SpawnInput};
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
    // In-session dedup guard: if there is already a Starting or Running channel
    // with a live pid, skip the spawn entirely. This prevents repeated Apply
    // calls or autostart+Apply from accumulating duplicate bridge trees.
    if let Some(existing) = state.channels.snapshot(&project_id) {
        let is_active = matches!(existing.status, ChannelStatus::Starting | ChannelStatus::Running);
        let has_pid = existing.pid.is_some();
        if is_active && has_pid {
            log::info!(
                "channel {project_id}: already {:?} (pid {:?}), skipping duplicate spawn",
                existing.status,
                existing.pid
            );
            return Ok(());
        }
    }

    let (cwd, prefix, continue_flag) = resolve_project(&state, &project_id)?;

    state.channels.put(ChannelSnapshot {
        project_id: project_id.clone(),
        pid: None,
        claude_pid: None,
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

    // Resolve the inner `claude` pid so the hook path can correlate this
    // channel as Automated. On Windows the spawned pid is the `cmd.exe`
    // wrapper; the SessionStart hook reports claude's (child) pid. Poll for the
    // child, then re-tag any session the hook already registered as External
    // (closes the spawn-vs-hook race: SessionStart often arrives first).
    {
        let state_c = state.clone();
        let proj_c = project_id.clone();
        tokio::spawn(async move {
            let mut claude_pid = None;
            for _ in 0..20 {
                if let Some(cp) = resolve_claude_pid(pid) {
                    claude_pid = Some(cp);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            if let Some(cp) = claude_pid {
                log::info!("channel {proj_c}: resolved claude_pid={cp} (launcher pid={pid})");
                state_c.channels.patch(&proj_c, |s| s.claude_pid = Some(cp));
                let retagged = state_c.registry.retag_pid_as_automated(cp);
                log::info!("channel {proj_c}: retag_pid_as_automated({cp}) -> {retagged}");
                if retagged {
                    state_c.notifier.publish(
                        "instances_changed",
                        serde_json::json!({"instances": state_c.registry.list()}),
                    );
                }
                emit_changed(&state_c);
            } else {
                log::warn!("channel {proj_c}: failed to resolve claude_pid for launcher pid={pid}");
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
                s.claude_pid = None;
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
        s.claude_pid = None;
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

/// Scan the live process list for already-running `claude --remote-control`
/// bridges and adopt them into the channel manager so the daemon knows about
/// them without spawning duplicates.
///
/// Called on daemon boot BEFORE `autostart_all`. Projects that get an adopted
/// channel are then skipped by `autostart_all` via the in-session dedup guard
/// in `start_channel`.
///
/// ## Process matching (Windows-centric)
///
/// On Windows the channel is launched as `cmd.exe /C claude --remote-control
/// --remote-control-session-name-prefix <prefix> [--continue]`. So there are
/// two relevant processes per channel: the `cmd.exe` launcher and the `claude`
/// child. We scan for `--remote-control` in any process's argv to find both.
///
/// - If the matching process is a `cmd.exe` (or any non-claude process): treat
///   its pid as the launcher pid. Then run `resolve_claude_pid` to find the
///   claude child, storing it as `claude_pid`.
/// - If the matching process is `claude` (or `node`): it is likely the already-
///   resolved child. Use its parent as the launcher pid (or the pid itself if
///   no parent). Either way `claude_pid` is set to this pid.
///
/// On macOS the `claude` process itself is the launcher, so the scanned pid is
/// both launcher and claude_pid.
///
/// The prefix match is exact-string against each project's resolved prefix
/// (`auto.session_name_prefix` or the project name as fallback), the same
/// logic as `resolve_project`.
pub fn adopt_running_channels(state: Arc<DaemonState>) {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All);

    let settings = state.settings.snapshot();

    for proc_ in sys.processes().values() {
        let args: Vec<String> = proc_.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();

        // Only consider processes that have --remote-control in their argv.
        if !args.iter().any(|a| a == "--remote-control") {
            continue;
        }

        // Extract the prefix from --remote-control-session-name-prefix <value>.
        let prefix_in_proc = args.windows(2).find_map(|w| {
            if w[0] == "--remote-control-session-name-prefix" {
                Some(w[1].clone())
            } else {
                None
            }
        });
        let Some(found_prefix) = prefix_in_proc else { continue };

        // Match this prefix against a known project.
        let matched_project = settings.projects.iter().find(|p| {
            let auto = match p.automation.as_ref() {
                Some(a) if a.enabled => a,
                _ => return false,
            };
            let expected = auto.session_name_prefix.clone().unwrap_or_else(|| p.name.clone());
            expected == found_prefix
        });
        let Some(project) = matched_project else {
            log::debug!("adopt_running_channels: --remote-control prefix {:?} matches no project", found_prefix);
            continue;
        };

        // Skip projects that already have a live channel in the manager
        // (handles the case where adopt is called twice or after a start).
        if let Some(existing) = state.channels.snapshot(&project.id) {
            if matches!(existing.status, ChannelStatus::Starting | ChannelStatus::Running)
                && existing.pid.is_some()
            {
                log::debug!(
                    "adopt_running_channels: project {} already has an active channel, skipping",
                    project.id
                );
                continue;
            }
        }

        let proc_pid = proc_.pid().as_u32();
        let proc_name = proc_.name().to_string_lossy().to_ascii_lowercase();

        // Determine launcher vs. claude pid.
        // - If the name contains "claude" or "node": the scanned process IS
        //   the claude/node child. Try its parent as the launcher.
        // - Otherwise (e.g. cmd.exe, sh): treat it as the launcher and resolve
        //   the claude child.
        let (launcher_pid, resolved_claude_pid) = if proc_name.contains("claude") || proc_name.contains("node") {
            let launcher = proc_
                .parent()
                .map(|p: Pid| p.as_u32())
                .unwrap_or(proc_pid);
            (launcher, Some(proc_pid))
        } else {
            // launcher is the scanned process; resolve its claude child.
            let claude_child = resolve_claude_pid(proc_pid);
            (proc_pid, claude_child)
        };

        log::info!(
            "adopt_running_channels: adopting project {} (prefix {:?}) launcher_pid={} claude_pid={:?}",
            project.id, found_prefix, launcher_pid, resolved_claude_pid
        );

        state.channels.put(ChannelSnapshot {
            project_id: project.id.clone(),
            pid: Some(launcher_pid),
            claude_pid: resolved_claude_pid,
            status: ChannelStatus::Running,
            hwnd: None,
        });
        emit_changed(&state);

        // Spawn watchers for the adopted channel: retag + exit watcher.
        // These mirror what start_channel does post-spawn.
        if let Some(cp) = resolved_claude_pid {
            let state_r = state.clone();
            tokio::spawn(async move {
                let retagged = state_r.registry.retag_pid_as_automated(cp);
                log::info!("adopt_running_channels: retag_pid_as_automated({cp}) -> {retagged}");
                if retagged {
                    state_r.notifier.publish(
                        "instances_changed",
                        serde_json::json!({"instances": state_r.registry.list()}),
                    );
                }
            });
        }

        // Exit watcher: wait for the launcher to exit then clear the snapshot.
        // On non-Windows / non-macOS this is a no-op (wait_for_child_exit
        // returns immediately), leaving the snapshot as Running. Acceptable:
        // the daemon's dedup guard will still block a re-spawn until the
        // snapshot is cleared by a future call or restart.
        {
            let state_w = state.clone();
            let proj_w = project.id.clone();
            // Windows-only: we don't own the launcher's HANDLE (it's an adopted
            // process), so poll sysinfo until its pid disappears, then clear the
            // snapshot. On non-Windows the daemon isn't shipped yet (Phase 6),
            // so we don't spawn a watcher at all - leaving the adopted channel
            // Running is correct (the dedup guard prevents a respawn); marking
            // it Stopped immediately would be wrong.
            #[cfg(windows)]
            {
                let pid_for_wait = launcher_pid;
                tokio::spawn(async move {
                    use sysinfo::{Pid as SPid, ProcessesToUpdate as PU, System as Sys};
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        let mut s = Sys::new();
                        s.refresh_processes(PU::All);
                        if s.process(SPid::from_u32(pid_for_wait)).is_none() {
                            break;
                        }
                    }
                    state_w.channels.patch(&proj_w, |s| {
                        s.status = ChannelStatus::Stopped;
                        s.pid = None;
                        s.claude_pid = None;
                        s.hwnd = None;
                    });
                    emit_changed(&state_w);
                });
            }
            #[cfg(not(windows))]
            {
                let _ = (&state_w, &proj_w, launcher_pid);
            }
        }
    }
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
            claude_pid: None,
            status: ChannelStatus::Running,
            hwnd: None,
        });
        let err = show_channel(&st, "p1").unwrap_err();
        assert!(err.contains("not resolved"), "got: {err}");
    }

    /// Seeding a Running snapshot with a live pid and then calling start_channel
    /// for the same project must be a no-op: start_channel returns Ok, the
    /// snapshot's pid remains unchanged (no new spawn happened), and the channel
    /// count stays at 1.
    ///
    /// Note: we cannot assert "no spawn occurred" in a unit test without
    /// injecting a fake spawner, but we CAN assert that start_channel did NOT
    /// overwrite the existing snapshot - the pid stays at the sentinel value we
    /// seeded. The call would also error on resolve_project (no matching project
    /// in default Settings), so we verify it returns Ok(()) - not an error -
    /// because the dedup guard fires before resolve_project.
    #[tokio::test]
    async fn start_channel_dedup_skips_when_running_with_pid() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        // Seed a Running snapshot with a pid (sentinel value).
        let sentinel_pid: u32 = 99999;
        st.channels.put(ChannelSnapshot {
            project_id: "proj-a".into(),
            pid: Some(sentinel_pid),
            claude_pid: None,
            status: ChannelStatus::Running,
            hwnd: None,
        });

        // start_channel must return Ok without spawning or erroring.
        let result = start_channel(st.clone(), "proj-a".to_string());
        assert!(result.is_ok(), "expected Ok(()), got: {:?}", result);

        // The snapshot must be unchanged: still 1 channel, pid still sentinel.
        let channels = list_channels(&st);
        assert_eq!(channels.len(), 1, "channel count must stay 1");
        let snap = st.channels.snapshot("proj-a").expect("snapshot must exist");
        assert_eq!(snap.pid, Some(sentinel_pid), "pid must not have changed");
        assert!(
            matches!(snap.status, ChannelStatus::Running),
            "status must still be Running"
        );
    }

    /// Dedup guard does NOT block when status is Starting but pid is None
    /// (spawn in-progress but nothing resolved yet). In that case start_channel
    /// should fall through to resolve_project and fail as normal (no project
    /// configured in default Settings).
    #[tokio::test]
    async fn start_channel_dedup_allows_starting_without_pid() {
        let st = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        st.channels.put(ChannelSnapshot {
            project_id: "proj-b".into(),
            pid: None, // no pid yet
            claude_pid: None,
            status: ChannelStatus::Starting,
            hwnd: None,
        });

        // Should fall through the dedup guard (pid is None) and fail at
        // resolve_project because default Settings has no projects.
        let result = start_channel(st.clone(), "proj-b".to_string());
        assert!(result.is_err(), "expected Err from resolve_project, got Ok");
    }
}
