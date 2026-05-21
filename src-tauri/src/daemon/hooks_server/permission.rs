//! Permission/question endpoints: `/permissions/request` + `/questions/request`.
//! Each inserts a oneshot into `state.pending`, emits a notifier event, and
//! blocks the HTTP response until the app responds (via the daemon-side RPC
//! `respond_*` in methods.rs) or a 5-minute timeout fires.

use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

#[derive(Deserialize)]
pub(super) struct PermRequestBody {
    id: String,
    tool_name: String,
    input: Value,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct QuestRequestBody {
    id: String,
    questions: Value,
    #[serde(default)]
    session_id: Option<String>,
}

pub(super) async fn on_permission_request(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<PermRequestBody>,
) -> impl IntoResponse {
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    ctx.state.pending.lock().await.insert(body.id.clone(), tx);
    ctx.state.notifier.publish(
        "permission_request",
        json!({
            "id": body.id,
            "tool_name": body.tool_name,
            "input": body.input,
            "session_id": body.session_id,
        }),
    );
    match tokio::time::timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(val)) => (StatusCode::OK, Json(val)),
        _ => {
            ctx.state.pending.lock().await.remove(&body.id);
            (
                StatusCode::OK,
                Json(json!({"behavior": "deny", "message": "user did not respond in time"})),
            )
        }
    }
}

pub(super) async fn on_question_request(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<QuestRequestBody>,
) -> impl IntoResponse {
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    ctx.state.pending.lock().await.insert(body.id.clone(), tx);
    ctx.state.notifier.publish(
        "question_request",
        json!({
            "id": body.id,
            "questions": body.questions,
            "session_id": body.session_id,
        }),
    );
    match tokio::time::timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(val)) => (StatusCode::OK, Json(val)),
        _ => {
            ctx.state.pending.lock().await.remove(&body.id);
            (StatusCode::OK, Json(json!({"answers": {}})))
        }
    }
}
