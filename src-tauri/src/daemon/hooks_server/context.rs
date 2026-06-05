//! `/context` endpoint: returns the daemon-computed ContextStatus for a
//! session (the single source of truth for "how full is the context window").
//! GET `/context?session_id=<id>`. Resolves the transcript via the daemon
//! registry (or a project-dir scan fallback), reads it, and returns the
//! ContextStatus as JSON, or 404 when it cannot be resolved.

use super::HookCtx;
use axum::{
    extract::{RawQuery, State as AxState},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::json;
use std::sync::Arc;

/// Pull `session_id` out of a raw `key=value&...` query string. The `query`
/// axum feature isn't enabled in this build, so we parse by hand rather than
/// pull in `extract::Query`. Returns None if the param is absent or empty.
fn session_id_from_raw(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    for pair in raw.split('&') {
        let mut it = pair.splitn(2, '=');
        let key = it.next()?;
        if key == "session_id" {
            let val = it.next().unwrap_or("");
            // Minimal percent-decode: session ids are UUIDs, but a path-style
            // fallback id could contain encoded chars. Handle the common ones.
            let decoded = val.replace('+', " ").replace("%2F", "/").replace("%5C", "\\");
            if decoded.is_empty() {
                return None;
            }
            return Some(decoded);
        }
    }
    None
}

pub(super) async fn on_context(
    AxState(ctx): AxState<Arc<HookCtx>>,
    RawQuery(raw): RawQuery,
) -> impl IntoResponse {
    let Some(session_id) = session_id_from_raw(raw.as_deref()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({}))).into_response();
    };
    let registry = ctx.state.registry.clone();

    // Transcript read is blocking file IO; keep it off the async runtime.
    let status = tokio::task::spawn_blocking(move || {
        crate::context_status::context_status_for_session(&registry, &session_id)
    })
    .await
    .ok()
    .flatten();

    match status {
        Some(s) => (StatusCode::OK, Json(json!(s))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({}))).into_response(),
    }
}
