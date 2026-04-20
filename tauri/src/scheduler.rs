//! Background task that polls usage on an interval and broadcasts results.

use crate::auth;
use crate::scraper::{fetch_usage, ScrapeError};
use crate::state::AppState;
use crate::types::{AuthState, UsageSnapshot};
use crate::{history, paths, session};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug)]
pub enum PollTrigger { Scheduled, Manual, Hook }

const BASE_URL: &str = "https://claude.ai";
const FAIL_STREAK_BEFORE_RELOGIN: u32 = 3;
const RETRY_AFTER_LOGIN_SECS: u64 = 5;

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut fail_streak: u32 = 0;
        loop {
            let interval_secs = interval_for(&app);

            match poll_once(&app, PollTrigger::Scheduled).await {
                Ok(snap) => {
                    fail_streak = 0;
                    log::info!(
                        "poll ok: 5h={:.1}% 7d={:.1}%",
                        snap.five_hour.utilization,
                        snap.seven_day.utilization,
                    );
                    let _ = app.emit("usage-updated", snap);
                    tokio::time::sleep(Duration::from_secs(interval_secs)).await;
                }
                Err(PollErr::NoSession) => {
                    log::info!("no session on disk - triggering login flow");
                    let _ = app.emit(
                        "poll-failed",
                        serde_json::json!({"reason": "no-session"}),
                    );
                    trigger_login(&app).await;
                    log::info!("login flow returned; retrying poll in {}s", RETRY_AFTER_LOGIN_SECS);
                    tokio::time::sleep(Duration::from_secs(RETRY_AFTER_LOGIN_SECS)).await;
                }
                Err(PollErr::NeedsLogin) => {
                    fail_streak += 1;
                    log::warn!("poll unauthorized (streak={fail_streak}/{FAIL_STREAK_BEFORE_RELOGIN})");
                    let _ = app.emit(
                        "poll-failed",
                        serde_json::json!({"reason": "unauthorized"}),
                    );
                    if fail_streak >= FAIL_STREAK_BEFORE_RELOGIN {
                        log::info!("auth failure streak reached - triggering login flow");
                        fail_streak = 0;
                        trigger_login(&app).await;
                        tokio::time::sleep(Duration::from_secs(RETRY_AFTER_LOGIN_SECS)).await;
                    } else {
                        tokio::time::sleep(Duration::from_secs(interval_secs)).await;
                    }
                }
                Err(PollErr::Other(msg)) => {
                    log::warn!("poll failed (network or other): {msg}");
                    let _ = app.emit(
                        "poll-failed",
                        serde_json::json!({"reason": msg}),
                    );
                    tokio::time::sleep(Duration::from_secs(interval_secs)).await;
                }
            }
        }
    });
}

/// Runs the Chrome-CDP login flow, guarding against concurrent invocations
/// by checking `AuthState::InProgress`.
async fn trigger_login(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut guard = state.auth_state.lock().unwrap();
        if matches!(*guard, AuthState::InProgress) {
            return; // another trigger already handling it
        }
        *guard = AuthState::InProgress;
    }
    let _ = app.emit("auth-progress", serde_json::json!({"stage": "starting"}));
    match auth::run(app.clone()).await {
        Ok(()) => {
            *app.state::<AppState>().auth_state.lock().unwrap() = AuthState::LoggedIn;
        }
        Err(e) => {
            log::error!("auto-login failed: {e}");
            *app.state::<AppState>().auth_state.lock().unwrap() = AuthState::NeedsLogin;
        }
    }
}

fn interval_for(app: &AppHandle) -> u64 {
    let state = app.state::<AppState>();
    let s = state.settings.lock().unwrap();
    s.poll_interval_secs.max(60) // floor 60s to avoid accidental hammering
}

#[derive(Debug)]
pub enum PollErr {
    NoSession,
    NeedsLogin,
    Other(String),
}

pub async fn poll_once(app: &AppHandle, trigger: PollTrigger) -> Result<UsageSnapshot, PollErr> {
    let spinning = matches!(trigger, PollTrigger::Manual | PollTrigger::Hook);
    let spin_task = if spinning { Some(start_spin(app.clone())) } else { None };

    let result = do_poll(app).await;

    if let Some(handle) = spin_task { handle.abort(); }
    {
        let st = app.state::<crate::state::AppState>();
        st.display.lock().unwrap().spin_frame = None;
    }
    crate::tray::render_tray_now(app);
    result
}

async fn do_poll(app: &AppHandle) -> Result<UsageSnapshot, PollErr> {
    let prev_snap = app.state::<crate::state::AppState>().current_usage.lock().unwrap().clone();

    let session_path = paths::session_file()
        .map_err(|e| PollErr::Other(format!("{e:#}")))?;
    let Some(session_key) = session::load(&session_path) else {
        return Err(PollErr::NoSession);
    };

    let snap = match fetch_usage(BASE_URL, &session_key).await {
        Ok(s) => s,
        Err(ScrapeError::Unauthorized) => return Err(PollErr::NeedsLogin),
        Err(ScrapeError::Forbidden) => return Err(PollErr::NeedsLogin),
        Err(e) => return Err(PollErr::Other(format!("{e:#}"))),
    };

    // Persist into in-memory + on-disk history
    {
        let state = app.state::<AppState>();
        *state.current_usage.lock().unwrap() = Some(snap.clone());
        *state.auth_state.lock().unwrap() = AuthState::LoggedIn;
    }

    // Check for threshold crossings and emit event if any occurred.
    {
        let new_snap = app.state::<crate::state::AppState>().current_usage.lock().unwrap().clone();
        if let (Some(prev), Some(new)) = (prev_snap.as_ref(), new_snap.as_ref()) {
            let icon_s = crate::icon_settings::IconSettings::try_from(
                &*app.state::<crate::state::AppState>().settings.lock().unwrap()
            ).unwrap_or_default();
            let prev_sess = Some(crate::usage_parser::session_pct(prev));
            let new_sess = Some(crate::usage_parser::session_pct(new));
            let prev_wk = Some(crate::usage_parser::weekly_pct(prev));
            let new_wk = Some(crate::usage_parser::weekly_pct(new));
            let crossed =
                crate::usage_parser::threshold_crossed(prev_sess, new_sess, &icon_s.color_thresholds) ||
                crate::usage_parser::threshold_crossed(prev_wk, new_wk, &icon_s.color_thresholds);
            if crossed {
                let pct = new_sess.unwrap_or(0.0).max(new_wk.unwrap_or(0.0)).round() as u32;
                // Task 11 replaces this with notifications::fire(...).
                let _ = app.emit("threshold-crossed", serde_json::json!({ "percent": pct }));
            }
        }
    }

    let hpath = paths::history_file()
        .map_err(|e| PollErr::Other(format!("{e:#}")))?;
    history::append(&hpath, &snap)
        .map_err(|e| PollErr::Other(format!("{e:#}")))?;
    // Opportunistic prune once per poll (fast when nothing to prune).
    let _ = history::prune(&hpath);

    Ok(snap)
}

fn start_spin(app: AppHandle) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut frame: u32 = 0;
        loop {
            {
                let st = app.state::<crate::state::AppState>();
                st.display.lock().unwrap().spin_frame = Some(frame);
            }
            crate::tray::render_tray_now(&app);
            frame = frame.wrapping_add(1);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
}
