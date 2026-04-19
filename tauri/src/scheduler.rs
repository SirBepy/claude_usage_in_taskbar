//! Background task that polls usage on an interval and broadcasts results.

use crate::auth;
use crate::scraper::{fetch_usage, ScrapeError};
use crate::state::AppState;
use crate::types::{AuthState, UsageSnapshot};
use crate::{history, paths, session};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const BASE_URL: &str = "https://claude.ai";
const FAIL_STREAK_BEFORE_RELOGIN: u32 = 3;
const RETRY_AFTER_LOGIN_SECS: u64 = 5;

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut fail_streak: u32 = 0;
        loop {
            let interval_secs = interval_for(&app);

            match poll_once(&app).await {
                Ok(snap) => {
                    fail_streak = 0;
                    let _ = app.emit("usage-updated", snap);
                    tokio::time::sleep(Duration::from_secs(interval_secs)).await;
                }
                Err(PollErr::NoSession) => {
                    let _ = app.emit(
                        "poll-failed",
                        serde_json::json!({"reason": "no-session"}),
                    );
                    trigger_login(&app).await;
                    // After login completes (success or failure), retry soon.
                    tokio::time::sleep(Duration::from_secs(RETRY_AFTER_LOGIN_SECS)).await;
                }
                Err(PollErr::NeedsLogin) => {
                    fail_streak += 1;
                    let _ = app.emit(
                        "poll-failed",
                        serde_json::json!({"reason": "unauthorized"}),
                    );
                    if fail_streak >= FAIL_STREAK_BEFORE_RELOGIN {
                        fail_streak = 0;
                        trigger_login(&app).await;
                        tokio::time::sleep(Duration::from_secs(RETRY_AFTER_LOGIN_SECS)).await;
                    } else {
                        tokio::time::sleep(Duration::from_secs(interval_secs)).await;
                    }
                }
                Err(PollErr::Other(msg)) => {
                    // Network error, DNS failure, 5xx, etc. Do NOT touch auth state.
                    // Do NOT trigger login. Just retry on the normal interval.
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

pub async fn poll_once(app: &AppHandle) -> Result<UsageSnapshot, PollErr> {
    let session_path = paths::session_file()
        .map_err(|e| PollErr::Other(e.to_string()))?;
    let Some(session_key) = session::load(&session_path) else {
        return Err(PollErr::NoSession);
    };

    let snap = match fetch_usage(BASE_URL, &session_key).await {
        Ok(s) => s,
        Err(ScrapeError::Unauthorized) => return Err(PollErr::NeedsLogin),
        Err(ScrapeError::Forbidden) => return Err(PollErr::NeedsLogin),
        Err(e) => return Err(PollErr::Other(e.to_string())),
    };

    // Persist into in-memory + on-disk history
    {
        let state = app.state::<AppState>();
        *state.current_usage.lock().unwrap() = Some(snap.clone());
        *state.auth_state.lock().unwrap() = AuthState::LoggedIn;
    }
    let hpath = paths::history_file()
        .map_err(|e| PollErr::Other(e.to_string()))?;
    history::append(&hpath, &snap)
        .map_err(|e| PollErr::Other(e.to_string()))?;
    // Opportunistic prune once per poll (fast when nothing to prune).
    let _ = history::prune(&hpath);

    Ok(snap)
}
