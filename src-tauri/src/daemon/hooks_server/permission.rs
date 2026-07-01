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

/// How long the daemon holds a permission/question prompt open waiting for the
/// user before giving up. The curl `--max-time` and the PreToolUse hook's
/// `timeout` field (both in `daemon::claude_config::write_hook_settings`) are set
/// to 3660s so they out-wait this by 60s - the daemon's response always lands
/// before the hook process is killed. Without this bound the `rx.await` blocks
/// until Claude Code's own PreToolUse ceiling (600s default) kills the hook,
/// silently truncating the intended window and dropping the answer.
pub(crate) const PROMPT_TIMEOUT: Duration = Duration::from_secs(3600);

/// Await the answer oneshot with an upper bound. `Some(val)` iff the user
/// responded; `None` if the wait elapsed OR the sender was dropped (daemon
/// restart / dismissal). Both map to the same "no answer" wire behavior, so
/// callers treat them identically.
async fn await_answer(rx: tokio::sync::oneshot::Receiver<Value>, timeout: Duration) -> Option<Value> {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(val)) => Some(val),
        _ => None,
    }
}

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
    // Push the phone if Joe is away (ai_todo 119): Claude is now blocked on him.
    ctx.state.fire_blocked_prompt(body.session_id.as_deref(), &body.id);
    let subs = ctx.state.notifier.publish("permission_request", payload);
    log::info!(
        "[perm-relay] published permission_request id={} tool={} session={:?} -> {} subscriber(s)",
        body.id, body.tool_name, body.session_id, subs
    );
    let result = match await_answer(rx, PROMPT_TIMEOUT).await {
        Some(val) => (StatusCode::OK, Json(val)),
        None => {
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
    ctx.state.fire_blocked_prompt(body.session_id.as_deref(), &body.id);
    let subs = ctx.state.notifier.publish("question_request", payload);
    // Character "asking" sound (see `ask_question_decision` for the rationale).
    ctx.state.notifier.publish(
        "turn_sound",
        json!({ "session_id": body.session_id, "awaiting": "question" }),
    );
    log::info!(
        "[perm-relay] published question_request id={} session={:?} -> {} subscriber(s)",
        body.id, body.session_id, subs
    );
    let result = match await_answer(rx, PROMPT_TIMEOUT).await {
        Some(val) => (StatusCode::OK, Json(val)),
        None => {
            ctx.state.pending.lock().await.remove(&body.id);
            ctx.state.notifier.publish(
                "question_expired",
                json!({ "session_id": body.session_id, "id": body.id }),
            );
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
    ask_question_decision_with_timeout(ctx, body, PROMPT_TIMEOUT).await
}

/// `ask_question_decision` with an injectable wait bound so tests can drive the
/// timeout branch without blocking for the full production window.
pub(super) async fn ask_question_decision_with_timeout(
    ctx: &Arc<HookCtx>,
    body: Value,
    timeout: Duration,
) -> Value {
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
    let payload = json!({ "id": id, "questions": questions, "session_id": session_id.clone() });
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    ctx.state.pending.lock().await.insert(id.clone(), tx);
    // Reliable delivery: record the prompt so the app's poll surfaces it even if
    // the lossy notifier broadcast drops the frame.
    ctx.state.add_prompt(&id, "question-requested", payload.clone()).await;
    ctx.state.fire_blocked_prompt(session_id.as_deref(), &id);
    // Durable "waiting on the user" state. An AskUserQuestion turn never emits an
    // `awaiting:question` result line (claude pauses on the deny-feedback and
    // resumes after the answer), so the turn-done path in `lifecycle.rs` never
    // records it. Without this the only signal is the frontend's in-memory
    // questionSessions set, which gets clobbered when the chat is reopened and
    // its transcript replayed - the row then falls out of "Input Needed" before
    // the user has answered. Recording it on the registry makes it survive a
    // reopen (the sidebar unions `awaiting === "question"` into its question set).
    if let Some(sid) = session_id.as_deref() {
        ctx.state.registry.set_awaiting(sid, Some("question".into()));
    }
    ctx.state.notifier.publish("question_request", payload);
    // Character "asking" sound. An AskUserQuestion turn does NOT end with an
    // `awaiting:question` result (claude continues after the deny-feedback), so
    // the turn-done path in `lifecycle.rs` never fires it; fire it here as the
    // card surfaces. The app maps this to `notifications::fire(QuestionAsked)`.
    ctx.state.notifier.publish(
        "turn_sound",
        json!({ "session_id": session_id, "awaiting": "question" }),
    );

    // `answers`: an object (possibly empty) iff the user actually responded;
    // Null if the sender was dropped (daemon restart etc.). The distinction
    // matters - format_answers tells the agent "no answer yet" vs "dismissed".
    let answers = match await_answer(rx, timeout).await {
        Some(val) => val.get("answers").cloned().unwrap_or(Value::Null),
        None => {
            ctx.state.pending.lock().await.remove(&id);
            ctx.state.notifier.publish(
                "question_expired",
                json!({ "session_id": session_id, "id": id }),
            );
            Value::Null
        }
    };
    ctx.state.remove_prompt(&id).await;
    // Answer in hand (or the prompt was dropped): clear the durable question
    // state so the resuming turn reads as "running" rather than staying parked
    // in "Input Needed". The turn's eventual `result` line overwrites this with
    // the real end-of-turn status (done / question / waiting).
    if let Some(sid) = session_id.as_deref() {
        ctx.state.registry.set_awaiting(sid, None);
    }
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
    // Null = timed out with no response (user likely away), NOT a refusal.
    if answers.is_null() {
        return "No answer yet - the question timed out without a response (the user may be away). Re-ask if you still need an answer; do not treat this as a refusal.".to_string();
    }
    // Empty object = the user actively dismissed/skipped the prompt.
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
    use super::{
        ask_question_decision, ask_question_decision_with_timeout, format_answers, HookCtx,
    };
    use crate::daemon::session::new_session_map;
    use crate::daemon::settings_cache::SettingsCache;
    use crate::daemon::state::DaemonState;
    use crate::types::Settings;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn format_answers_distinguishes_timeout_from_dismiss_from_answer() {
        let questions = json!([{ "question": "Tabs or spaces?" }]);

        // Null = timed out (no response). Must NOT read as a refusal.
        let timed_out = format_answers(&questions, &Value::Null);
        assert!(timed_out.contains("timed out"), "timeout message: {timed_out}");
        assert!(!timed_out.contains("dismissed"), "timeout must not say dismissed");

        // Empty object = the user actively skipped.
        let dismissed = format_answers(&questions, &json!({}));
        assert!(dismissed.contains("dismissed"), "dismiss message: {dismissed}");

        // Real answer = echoed back.
        let answered = format_answers(&questions, &json!({ "Tabs or spaces?": "Tabs" }));
        assert!(answered.contains("Tabs"), "answer echoed: {answered}");
    }

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

    /// When nobody answers within the wait window, the handler must fire the
    /// timeout branch (not block forever) and hand claude the "timed out - not a
    /// refusal" reason. Drives the injectable-timeout seam with a short duration
    /// so CI doesn't wait the full production hour.
    #[tokio::test]
    async fn ask_question_times_out_when_unanswered() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let body = json!({
            "session_id": "s1",
            "tool_input": { "questions": [ { "question": "Tabs or spaces?" } ] }
        });
        // No answerer: the oneshot is never sent on, so only the timeout can
        // resolve this.
        let decision =
            ask_question_decision_with_timeout(&ctx, body, Duration::from_millis(50)).await;
        let reason = decision["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap();
        assert!(reason.contains("timed out"), "expected timeout reason: {reason}");
        assert!(!reason.contains("dismissed"), "timeout must not read as dismiss");
    }

    #[tokio::test]
    async fn ask_question_with_no_questions_denies_without_blocking() {
        let state = DaemonState::new(new_session_map(), SettingsCache::new(Settings::default()));
        let ctx = Arc::new(HookCtx { state });
        let decision = ask_question_decision(&ctx, json!({ "tool_input": {} })).await;
        assert_eq!(decision["hookSpecificOutput"]["permissionDecision"], "deny");
    }
}
