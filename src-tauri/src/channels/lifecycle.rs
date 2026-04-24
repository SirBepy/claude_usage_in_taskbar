use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager as _};
use crate::types::ChannelStatus;
use super::manager::ChannelSnapshot;
use super::watchdog::{RestartDecision, RestartState, next_restart_delay};
use super::spawn::{spawn_child, SpawnInput};
use super::window_chrome::{resolve_console_hwnd, strip_console_chrome, hide_hwnd};
use super::kill::kill_tree;

// -------- Per-project restart state --------

static RESTART_STATES: once_cell::sync::Lazy<Mutex<HashMap<String, RestartState>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

fn suppress_restart_for(project_id: &str) {
    let mut g = RESTART_STATES.lock().unwrap();
    g.entry(project_id.to_string()).or_default().suppress_restart = true;
}

fn clear_suppress_for(project_id: &str) {
    let mut g = RESTART_STATES.lock().unwrap();
    g.entry(project_id.to_string()).or_default().suppress_restart = false;
}

fn next_decision_for(project_id: &str, runtime: Duration) -> RestartDecision {
    let mut guard = RESTART_STATES.lock().unwrap();
    let st = guard.entry(project_id.to_string()).or_default();
    next_restart_delay(st, runtime)
}

// -------- Lifecycle API --------

pub(crate) fn emit_changed(app: &AppHandle) {
    let state = app.state::<crate::state::AppState>();
    let snaps: Vec<_> = state.channels.list().into_iter().map(|s| serde_json::json!({
        "project_id": s.project_id,
        "pid": s.pid,
        "status": match s.status {
            ChannelStatus::Starting => "starting",
            ChannelStatus::Running  => "running",
            ChannelStatus::Stopped  => "stopped",
            ChannelStatus::Crashed  => "crashed",
        },
        "hwnd": s.hwnd,
    })).collect();
    let _ = app.emit("channels-changed", snaps);
}

pub fn start_channel(
    app: AppHandle,
    project_id: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
    Box::pin(async move {
    let (cwd, prefix, continue_flag) = {
        let state = app.state::<crate::state::AppState>();
        let guard = state.settings.lock().unwrap();
        let Some(p) = guard.projects.iter().find(|p| p.id == project_id) else {
            return Err(format!("project {project_id} not found"));
        };
        let auto = p.automation.as_ref().ok_or("project has no automation")?;
        let prefix = auto.session_name_prefix.clone().unwrap_or_else(|| p.name.clone());
        (p.path.clone(), prefix, auto.continue_flag)
    };

    {
        let state = app.state::<crate::state::AppState>();
        state.channels.put(ChannelSnapshot {
            project_id: project_id.clone(),
            pid: None,
            status: ChannelStatus::Starting,
            hwnd: None,
        });
    }
    emit_changed(&app);

    let spawn_out = spawn_child(SpawnInput {
        project_id: project_id.clone(),
        cwd,
        session_name_prefix: prefix,
        continue_flag,
    })
    .map_err(|e| e.to_string())?;

    let pid = spawn_out.pid;
    {
        let state = app.state::<crate::state::AppState>();
        state.channels.patch(&project_id, |s| {
            s.pid = Some(pid);
            s.status = ChannelStatus::Running;
        });
    }

    {
        let app_h = app.clone();
        let proj_h = project_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(hwnd) = resolve_console_hwnd(pid).await {
                strip_console_chrome(hwnd);
                hide_hwnd(hwnd);
                let s = app_h.state::<crate::state::AppState>();
                s.channels.patch(&proj_h, |s| s.hwnd = Some(hwnd));
                emit_changed(&app_h);
            }
        });
    }

    {
        let app_w = app.clone();
        let proj_w = project_id.clone();
        let handle = spawn_out.process_handle;
        let pid_for_wait = spawn_out.pid;
        tauri::async_runtime::spawn(async move {
            let started_at = std::time::Instant::now();
            super::spawn::wait_for_child_exit(handle, pid_for_wait).await;
            let runtime = started_at.elapsed();

            let state = app_w.state::<crate::state::AppState>();
            let decision = next_decision_for(&proj_w, runtime);

            match decision {
                RestartDecision::DoNotRestart => {
                    state.channels.patch(&proj_w, |s| {
                        s.status = ChannelStatus::Stopped;
                        s.pid = None;
                        s.hwnd = None;
                    });
                    emit_changed(&app_w);
                }
                RestartDecision::GiveUp => {
                    state.channels.patch(&proj_w, |s| {
                        s.status = ChannelStatus::Crashed;
                        s.pid = None;
                        s.hwnd = None;
                    });
                    emit_changed(&app_w);
                }
                RestartDecision::RestartAfter(delay) => {
                    state.channels.patch(&proj_w, |s| {
                        s.status = ChannelStatus::Stopped;
                        s.pid = None;
                        s.hwnd = None;
                    });
                    emit_changed(&app_w);
                    tokio::time::sleep(delay).await;
                    tauri::async_runtime::spawn(async move {
                        let _ = start_channel(app_w, proj_w).await;
                    });
                }
            }
        });
    }

    Ok(())
    })
}

pub fn stop_channel(app: &AppHandle, project_id: &str) -> Result<(), String> {
    let state = app.state::<crate::state::AppState>();
    let (pid, hwnd) = match state.channels.snapshot(project_id) {
        Some(s) => (s.pid, s.hwnd),
        None => return Ok(()),
    };
    suppress_restart_for(project_id);
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
    emit_changed(app);
    Ok(())
}

pub async fn restart_channel(app: AppHandle, project_id: String) -> Result<(), String> {
    stop_channel(&app, &project_id)?;
    clear_suppress_for(&project_id);
    start_channel(app, project_id).await
}

pub async fn autostart_all(app: AppHandle) {
    let to_start: Vec<String> = {
        let state = app.state::<crate::state::AppState>();
        let guard = state.settings.lock().unwrap();
        let ids: Vec<String> = guard
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
        ids
    };
    for id in to_start {
        if let Err(e) = start_channel(app.clone(), id.clone()).await {
            log::warn!("autostart failed for {id}: {e}");
        }
    }
}
