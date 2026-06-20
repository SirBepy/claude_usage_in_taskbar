//! IPC layer for the token-drain feature. Wraps `tokens::drain` + `tokens::quota`:
//! `chat_drain` is the per-chat popover (lifetime + per-message breakdown + pcts),
//! `chat_drains` is the leaderboard (many chats, no per-message detail) that also
//! recalibrates the self-tuning $/quota estimate from the latest usage snapshot.

use crate::settings::paths;
use crate::state::AppState;
use crate::tokens::{self, drain as drain_engine, quota, ChatDrain, MessageDrain};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::State;

/// Resolves `(cwd, main_transcript)` for a session id the way
/// `instance_token_stats` / `context_status` do: the live instance cache first,
/// then a scan of `~/.claude/projects/*/<id>.jsonl` for history-only sessions.
/// The directory name is decoded back to a real cwd so the drain engine can find
/// the matching `subagents/` dir. Returns `None` when nothing resolves.
fn resolve_session(session_id: &str, state: &AppState) -> Option<(PathBuf, PathBuf)> {
    // 1. Live instance cache.
    if let Some(inst) = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .find(|i| i.session_id == session_id)
        .cloned()
    {
        let transcript = match inst.transcript_path.as_ref() {
            Some(p) if p.exists() => Some(p.clone()),
            _ => tokens::transcript_for_session(&inst.cwd, session_id)
                .or_else(|| tokens::latest_transcript_for_cwd(&inst.cwd)),
        };
        if let Some(t) = transcript {
            return Some((inst.cwd.clone(), t));
        }
    }

    // 2. History-only fallback: scan every project dir for <session_id>.jsonl and
    //    decode the dir name back to the real cwd.
    let projects = tokens::claude_projects_dir()?;
    let target = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(&projects).ok()?.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let candidate = dir.join(&target);
        if candidate.exists() {
            let cwd = dir
                .file_name()
                .and_then(|n| n.to_str())
                .map(|name| PathBuf::from(tokens::decode_cwd(name)))
                .unwrap_or_else(|| dir.clone());
            return Some((cwd, candidate));
        }
    }
    None
}

/// Builds a `ChatDrain` (lifetime + pcts) for one session, with the supplied
/// `messages` (empty for the leaderboard, full for the popover). Percentages use
/// the persisted quota; a zero/unknown quota yields 0%. `lifetime` is passed in
/// so callers that already computed it (the leaderboard) don't re-parse.
fn build_chat_drain(
    session_id: &str,
    main_transcript: &Path,
    quota: &quota::SessionQuota,
    lifetime: f64,
    messages: Vec<MessageDrain>,
) -> ChatDrain {
    let totals = tokens::parse_transcript(main_transcript);
    let tokens_sum = totals.input_tokens
        + totals.output_tokens
        + totals.cache_read_tokens
        + totals.cache_creation_tokens;

    let pct = |q: f64| if q > 0.0 { lifetime / q * 100.0 } else { 0.0 };
    ChatDrain {
        session_id: session_id.to_string(),
        lifetime_drain_usd: lifetime,
        tokens: tokens_sum,
        five_hour_pct: pct(quota.quota_5h_usd),
        weekly_pct: pct(quota.quota_weekly_usd),
        quota_5h_usd: quota.quota_5h_usd,
        quota_weekly_usd: quota.quota_weekly_usd,
        messages,
    }
}

/// Full rundown for ONE chat (the popover): lifetime drain + per-message breakdown + pcts.
#[tauri::command]
pub async fn chat_drain(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ChatDrain>, String> {
    let Some((cwd, main_transcript)) = resolve_session(&session_id, &state) else {
        return Ok(None);
    };
    let quota_path = paths::session_quota_file().map_err(|e| e.to_string())?;

    // Heavy file parsing off the async runtime.
    let result = tokio::task::spawn_blocking(move || {
        let quota = quota::load_quota(&quota_path);
        let lifetime = drain_engine::drain_for_session(&cwd, &session_id);
        let messages = drain_engine::message_drains(&main_transcript);
        build_chat_drain(&session_id, &main_transcript, &quota, lifetime, messages)
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(Some(result))
}

/// Leaderboard payload for many chats + the recalibrated quota.
#[derive(serde::Serialize, Clone, Debug, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
#[serde(rename_all = "camelCase")]
pub struct DrainBoard {
    pub chats: std::collections::HashMap<String, ChatDrain>, // per session: lifetime + pcts, messages EMPTY
    pub visible_drain_5h_usd: f64, // sum of lifetime drain over sessions active in last 5h (for the "used elsewhere" sliver)
    pub visible_drain_weekly_usd: f64,
    pub util_5h_pct: f64, // from the snapshot (0 if none)
    pub util_weekly_pct: f64,
    pub quota_5h_usd: f64, // post-calibration
    pub quota_weekly_usd: f64,
}

/// Leaderboard payload for MANY chats + recalibrates the quota. messages omitted (cheap).
#[tauri::command]
pub async fn chat_drains(
    session_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<DrainBoard, String> {
    // Resolve everything against the instance cache up front (the cache lock is
    // sync + must not be held across `.await`), then hand the resolved paths to
    // the blocking parse stage.
    let mut resolved: Vec<(String, PathBuf, PathBuf)> = Vec::new();
    for id in &session_ids {
        if let Some((cwd, transcript)) = resolve_session(id, &state) {
            resolved.push((id.clone(), cwd, transcript));
        }
    }

    // Util from the latest usage snapshot (utilization is already a percent).
    let (util_5h, util_weekly) = {
        let snap = state.current_usage.lock().unwrap();
        match snap.as_ref() {
            Some(s) => (s.five_hour.utilization, s.seven_day.utilization),
            None => (0.0, 0.0),
        }
    };

    let quota_path = paths::session_quota_file().map_err(|e| e.to_string())?;

    let board = tokio::task::spawn_blocking(move || {
        let now = SystemTime::now();
        let within = |path: &Path, window: Duration| -> bool {
            std::fs::metadata(path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|mtime| now.duration_since(mtime).ok())
                .map(|age| age <= window)
                .unwrap_or(false)
        };
        let five_h = Duration::from_secs(5 * 60 * 60);
        let seven_d = Duration::from_secs(7 * 24 * 60 * 60);

        let prev = quota::load_quota(&quota_path);

        // First pass: per-session lifetime drain (drives both calibration and the
        // returned chats), and which sessions are active in each window.
        let mut lifetimes: Vec<(String, PathBuf, PathBuf, f64, bool, bool)> = Vec::new();
        let mut visible_5h = 0.0;
        let mut visible_weekly = 0.0;
        for (id, cwd, transcript) in &resolved {
            let lifetime = drain_engine::drain_for_session(cwd, id);
            // approx: lifetime as windowed proxy
            let active_5h = within(transcript, five_h);
            let active_weekly = within(transcript, seven_d);
            if active_5h {
                visible_5h += lifetime;
            }
            if active_weekly {
                visible_weekly += lifetime;
            }
            lifetimes.push((
                id.clone(),
                cwd.clone(),
                transcript.clone(),
                lifetime,
                active_5h,
                active_weekly,
            ));
        }

        // Recalibrate + persist the quota from this observation.
        let q = quota::calibrate(&prev, visible_5h, util_5h, visible_weekly, util_weekly);
        quota::save_quota(&quota_path, &q)?;

        // Second pass: build each ChatDrain with pcts from the POST-calibration
        // quota; messages are omitted (empty) for the cheap leaderboard.
        let mut chats = std::collections::HashMap::new();
        for (id, _cwd, transcript, lifetime, ..) in &lifetimes {
            let cd = build_chat_drain(id, transcript, &q, *lifetime, Vec::new());
            chats.insert(id.clone(), cd);
        }

        Ok::<DrainBoard, std::io::Error>(DrainBoard {
            chats,
            visible_drain_5h_usd: visible_5h,
            visible_drain_weekly_usd: visible_weekly,
            util_5h_pct: util_5h,
            util_weekly_pct: util_weekly,
            quota_5h_usd: q.quota_5h_usd,
            quota_weekly_usd: q.quota_weekly_usd,
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    Ok(board)
}
