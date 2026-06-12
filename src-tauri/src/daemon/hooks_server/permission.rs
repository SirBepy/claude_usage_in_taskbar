//! Permission/question endpoints: `/permissions/request` + `/questions/request`.
//! Each inserts a oneshot into `state.pending`, emits a notifier event, and
//! blocks the HTTP response until the app responds (via the daemon-side RPC
//! `respond_*` in methods.rs) or the prompt timeout fires.

use super::HookCtx;
use axum::{extract::State as AxState, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// How long a permission/question prompt waits for the user before giving up.
/// Generous (1h) because the user is often AFK and answers later, sometimes
/// from their phone. Until it fires the turn just blocks, harmlessly.
const PROMPT_TIMEOUT_SECS: u64 = 3600;

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
    let payload = json!({
        "id": body.id,
        "tool_name": body.tool_name,
        "input": body.input,
        "session_id": body.session_id,
    });
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    ctx.state.pending.lock().await.insert(body.id.clone(), tx);
    ctx.state.add_prompt(&body.id, "permission-requested", payload.clone()).await;
    let subs = ctx.state.notifier.publish("permission_request", payload);
    log::info!(
        "[perm-relay] published permission_request id={} tool={} session={:?} -> {} subscriber(s)",
        body.id, body.tool_name, body.session_id, subs
    );
    let result = match tokio::time::timeout(Duration::from_secs(PROMPT_TIMEOUT_SECS), rx).await {
        Ok(Ok(val)) => (StatusCode::OK, Json(val)),
        _ => {
            ctx.state.pending.lock().await.remove(&body.id);
            (
                StatusCode::OK,
                Json(json!({"behavior": "deny", "message": "user did not respond in time"})),
            )
        }
    };
    ctx.state.remove_prompt(&body.id).await;
    result
}

pub(super) async fn on_question_request(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<QuestRequestBody>,
) -> impl IntoResponse {
    let payload = json!({
        "id": body.id,
        "questions": body.questions,
        "session_id": body.session_id,
    });
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    ctx.state.pending.lock().await.insert(body.id.clone(), tx);
    // Reliable delivery: record the prompt so the app's poll surfaces it even if
    // the lossy notifier broadcast drops the frame.
    ctx.state.add_prompt(&body.id, "question-requested", payload.clone()).await;
    let subs = ctx.state.notifier.publish("question_request", payload);
    log::info!(
        "[perm-relay] published question_request id={} session={:?} -> {} subscriber(s)",
        body.id, body.session_id, subs
    );
    let result = match tokio::time::timeout(Duration::from_secs(PROMPT_TIMEOUT_SECS), rx).await {
        Ok(Ok(val)) => (StatusCode::OK, Json(val)),
        _ => {
            ctx.state.pending.lock().await.remove(&body.id);
            (StatusCode::OK, Json(json!({"answers": {}})))
        }
    };
    ctx.state.remove_prompt(&body.id).await;
    result
}

/// PreToolUse-hook endpoint for the builtin `AskUserQuestion` tool. The in-app
/// `claude -p` session gets a per-session PreToolUse hook (see
/// `daemon::lifecycle::write_hook_settings`) whose command `curl`s the raw hook
/// payload here. We surface the questions through the same relay the MCP
/// `ask_user_question` tool uses (`question_request` -> the chat's question
/// card -> `respond_question`), wait for the answer, and return a PreToolUse
/// `deny` whose reason carries that answer. `claude` reads the reason as
/// feedback and continues. This is the channel that replaced the dead permission
/// relay: current `claude` no longer routes `AskUserQuestion` through
/// `--permission-prompt-tool`, but a `PreToolUse` hook still fires for it.
///
/// The response body IS the hook's stdout, so it must be exactly the
/// `hookSpecificOutput` decision claude expects - nothing else.
pub(super) async fn on_ask_question_hook(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    (StatusCode::OK, Json(ask_question_decision(&ctx, body).await))
}

/// Core of the AskUserQuestion hook: surface the questions through the question
/// relay (`question_request` -> the chat's card -> `respond_question`), wait for
/// the answer, and return the PreToolUse decision. Split out from the axum
/// handler so it can be unit-tested without an HTTP round-trip.
pub(super) async fn ask_question_decision(ctx: &Arc<HookCtx>, body: Value) -> Value {
    let questions = body
        .get("tool_input")
        .and_then(|t| t.get("questions"))
        .cloned()
        .unwrap_or(Value::Null);
    if !questions.is_array() {
        return deny_decision("No questions found in the AskUserQuestion call.");
    }
    let session_id = body
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let id = uuid::Uuid::new_v4().to_string();
    let payload = json!({ "id": id, "questions": questions, "session_id": session_id });
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    ctx.state.pending.lock().await.insert(id.clone(), tx);
    // Reliable delivery: record the prompt so the app's poll surfaces it even if
    // the lossy notifier broadcast drops the frame.
    ctx.state.add_prompt(&id, "question-requested", payload.clone()).await;
    ctx.state.notifier.publish("question_request", payload);

    let answers = match tokio::time::timeout(Duration::from_secs(PROMPT_TIMEOUT_SECS), rx).await {
        Ok(Ok(val)) => val.get("answers").cloned().unwrap_or(Value::Null),
        _ => {
            ctx.state.pending.lock().await.remove(&id);
            Value::Null
        }
    };
    ctx.state.remove_prompt(&id).await;
    deny_decision(&format_answers(&questions, &answers))
}

/// Wrap a reason in the PreToolUse decision claude reads off the hook's stdout.
/// We always `deny` AskUserQuestion (claude must not execute it in headless
/// mode) and hand the user's answer back as the reason.
fn deny_decision(reason: &str) -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    })
}

/// Render the structured `{question: answer}` map as plain-text feedback.
/// Mirrors the frontend `formatAnswersAsMessage`.
fn format_answers(questions: &Value, answers: &Value) -> String {
    let empty = answers.as_object().map(|o| o.is_empty()).unwrap_or(true);
    if empty {
        return "The user dismissed the question without answering. Ask again in plain text if you still need an answer.".to_string();
    }
    let mut lines = vec!["The user answered the question(s):".to_string()];
    if let Some(arr) = questions.as_array() {
        for q in arr {
            let qtext = q.get("question").and_then(|v| v.as_str()).unwrap_or("");
            let formatted = match answers.get(qtext) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(items)) => items
                    .iter()
                    .filter_map(|i| i.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                _ => continue,
            };
            lines.push(format!("Q: {qtext}"));
            lines.push(format!("A: {formatted}"));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::{ask_question_decision, HookCtx};
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use serde_json::json;
    use std::sync::Arc;

    /// The AskUserQuestion hook publishes a `question_request`, waits for the
    /// answer that the chat card posts back via `respond_question`, and returns
    /// a PreToolUse `deny` carrying that answer. This drives the daemon side of
    /// the relay end to end with a synthetic answerer in place of the frontend.
    #[tokio::test]
    async fn ask_question_relay_round_trips_answer() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state: state.clone() });

        // Stand in for the chat UI: catch the published question and answer it.
        let mut rx = state.notifier.subscribe();
        let answerer = {
            let state = state.clone();
            tokio::spawn(async move {
                let frame = rx.recv().await.expect("question_request published");
                assert_eq!(frame["method"], "question_request");
                assert_eq!(frame["params"]["session_id"], "s1");
                let id = frame["params"]["id"].as_str().unwrap().to_string();
                let tx = state
                    .pending
                    .lock()
                    .await
                    .remove(&id)
                    .expect("pending oneshot for the published id");
                let _ = tx.send(json!({ "answers": { "Tabs or spaces?": "Tabs" } }));
            })
        };

        let body = json!({
            "session_id": "s1",
            "tool_input": { "questions": [
                { "question": "Tabs or spaces?", "options": [ {"label": "Tabs"}, {"label": "Spaces"} ] }
            ] }
        });
        let decision = ask_question_decision(&ctx, body).await;
        answerer.await.unwrap();

        let hso = &decision["hookSpecificOutput"];
        assert_eq!(hso["hookEventName"], "PreToolUse");
        assert_eq!(hso["permissionDecision"], "deny");
        let reason = hso["permissionDecisionReason"].as_str().unwrap();
        assert!(reason.contains("Tabs"), "answer not in reason: {reason}");
    }

    #[tokio::test]
    async fn ask_question_with_no_questions_denies_without_blocking() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let decision = ask_question_decision(&ctx, json!({ "tool_input": {} })).await;
        assert_eq!(decision["hookSpecificOutput"]["permissionDecision"], "deny");
    }
}
