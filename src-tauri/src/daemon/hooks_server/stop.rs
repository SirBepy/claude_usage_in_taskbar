//! Stop endpoint: `/hooks/stop`. Parses the transcript for skill-usage events
//! and records them on a background task.

use super::HookCtx;
use crate::settings::paths;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Deserialize, Debug, Default)]
pub(super) struct StopPayload {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub transcript_path: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// True when this Stop fires because a previous Stop hook already blocked
    /// this same turn - the CLI's loop guard. Never block when set.
    #[serde(default)]
    pub stop_hook_active: Option<bool>,
    /// Final assistant text of the turn. `None` on CLI versions that don't
    /// send the field - enforcement must then stay off (blocking on an absent
    /// field would block every turn forever).
    #[serde(default)]
    pub last_assistant_message: Option<String>,
    /// Background tasks still live at turn end - ground truth for the
    /// "working" status, unlike the self-reported marker.
    #[serde(default)]
    pub background_tasks: Option<Vec<serde_json::Value>>,
}

pub(super) async fn on_stop(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<StopPayload>,
) -> impl IntoResponse {
    log::info!(
        "hook /hooks/stop: session={} cwd={} transcript={}",
        payload.session_id.as_deref().unwrap_or("-"),
        payload.cwd.as_deref().unwrap_or("-"),
        payload.transcript_path.as_deref().unwrap_or("-"),
    );

    let Some(transcript_path) = payload.transcript_path.clone() else {
        return (StatusCode::OK, Json(json!({"ok": true, "reason": "no transcript"})));
    };
    let Some(session_id) = payload.session_id.clone() else {
        return (StatusCode::OK, Json(json!({"ok": true, "reason": "no session_id"})));
    };

    // Daemon-hosted chats only: this global hook also fires for the dev's own
    // terminal sessions, which must never be status-tracked or blocked.
    if ctx.state.sessions.contains_key(&session_id) {
        // Record the CLI's live background-task count BEFORE returning: the
        // CLI holds the `result` line until this hook responds, so the pump's
        // result-line handler always reads a fresh count (see
        // `daemon::lifecycle`'s awaiting override).
        let bg_count = payload.background_tasks.as_ref().map(Vec::len).unwrap_or(0);
        ctx.state.registry.set_background_tasks(&session_id, bg_count);

        // Marker enforcement: a turn that ends without a parseable
        // <cc-status:..> marker is blocked once so the model re-emits it -
        // the retry loop the marker channel never had. Guards: the CLI's
        // `stop_hook_active` loop flag caps it at one retry, and enforcement
        // stays off entirely when the CLI doesn't send the final text.
        if payload.stop_hook_active != Some(true) {
            if let Some(msg) = payload.last_assistant_message.as_deref() {
                if crate::chat::parser::detect_awaiting(msg).is_none() {
                    log::info!("hook /hooks/stop: blocking {session_id} - no status marker in final text");
                    return (
                        StatusCode::OK,
                        Json(json!({
                            "decision": "block",
                            "reason": "End your response with the two required bare marker lines: <cc-title:3-6 word topic summary> then <cc-status:done|question|waiting|working> (colon form, e.g. <cc-status:done>).",
                        })),
                    );
                }
            }
        }
    }

    let state = ctx.state.clone();
    tokio::spawn(async move {
        let dir = match paths::skill_usage_dir() {
            Ok(d) => d,
            Err(e) => {
                log::warn!("skill_usage_dir failed: {e}");
                return;
            }
        };
        let transcript = PathBuf::from(transcript_path);
        let events = tokio::task::spawn_blocking(move || {
            crate::skill_usage::parser::parse_transcript(&transcript)
        })
        .await
        .unwrap_or_default();

        // mark_session stays file-based: it's a per-session/per-day dedup marker
        // (records that a session ran AT ALL, even with zero skill events) that
        // feeds `total_sessions`. The SQLite store has no per-session marker
        // table, so preserving it here keeps that count correct. Skill EVENTS
        // now go to the DB instead of the per-day events-*.jsonl files.
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        if let Err(e) = crate::skill_usage::store::mark_session(&dir, &session_id, &today) {
            log::warn!("mark_session failed: {e}");
        }
        if !events.is_empty() {
            if let Some(db) = state.db.clone() {
                let _ = tokio::task::spawn_blocking(move || {
                    let mgr = db.lock().unwrap_or_else(|p| p.into_inner());
                    let conn = mgr.conn();
                    for event in &events {
                        if let Err(e) = crate::storage::skill_store::insert_skill_event(conn, event) {
                            log::warn!("daemon: insert_skill_event failed: {e:#}");
                        }
                    }
                })
                .await;
            } else {
                log::warn!("daemon: companion.db unavailable; dropping {} skill event(s)", events.len());
            }
        }
        state.notifier.publish("skill_usage_changed", json!({}));
    });

    (StatusCode::OK, Json(json!({"ok": true})))
}
