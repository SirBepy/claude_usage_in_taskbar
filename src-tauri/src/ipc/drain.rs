//! IPC layer for the token-drain feature. Wraps `tokens::drain`:
//! `chat_drain` is the per-chat popover (raw tokens + per-message breakdown +
//! window shares), `chat_drains` is the leaderboard (many chats, no per-message
//! detail). Both apportion the CURRENT window utilization across the chats that
//! were active in the window, weighting by each chat's internal cost-drain. No
//! dollar figure is ever produced or surfaced (the user is subscription-based).

use crate::state::AppState;
use crate::tokens::{self, drain as drain_engine, ChatDrain, MessageDrain};
use std::collections::HashMap;
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

/// The live 5h / weekly utilization PERCENTAGES from the latest usage snapshot
/// (the real Anthropic-reported numbers). `None` when no snapshot exists yet, so
/// the UI can show "no data" rather than a bogus 0%.
fn util_from_state(state: &AppState) -> (Option<f64>, Option<f64>) {
    let snap = state.current_usage.lock().unwrap();
    match snap.as_ref() {
        Some(s) => (Some(s.five_hour.utilization), Some(s.seven_day.utilization)),
        None => (None, None),
    }
}

/// Per-session windowed cost-drain + the visible totals. For each resolved
/// session we take its lifetime drain units (the proxy Joe accepted) and count
/// them toward a window only if the transcript was touched within that window.
/// Returns `(per_session (units_5h, units_weekly), total_5h, total_weekly)`.
fn windowed_drains(
    resolved: &[(String, PathBuf, PathBuf)],
) -> (HashMap<String, (f64, f64)>, f64, f64) {
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

    let mut map = HashMap::new();
    let mut total_5h = 0.0;
    let mut total_weekly = 0.0;
    for (id, cwd, transcript) in resolved {
        let units = drain_engine::drain_units_for_session(cwd, id);
        let u5 = if within(transcript, five_h) { units } else { 0.0 };
        let uw = if within(transcript, seven_d) { units } else { 0.0 };
        total_5h += u5;
        total_weekly += uw;
        map.insert(id.clone(), (u5, uw));
    }
    (map, total_5h, total_weekly)
}

/// This chat's slice of a window's utilization: `util * (part / total)`. `None`
/// when there's no snapshot (unknowable); a real `0.0` when the chat was idle in
/// the window (it contributed nothing to the current usage).
fn share(util: Option<f64>, part: f64, total: f64) -> Option<f64> {
    match util {
        Some(u) if total > 0.0 => Some(u * part / total),
        Some(_) => Some(0.0),
        None => None,
    }
}

/// Builds a `ChatDrain` for one session: raw token total + the supplied window
/// shares + per-message `messages` (empty for the leaderboard, full for the
/// popover).
fn build_chat_drain(
    session_id: &str,
    main_transcript: &Path,
    five_hour_pct: Option<f64>,
    weekly_pct: Option<f64>,
    messages: Vec<MessageDrain>,
) -> ChatDrain {
    let totals = tokens::parse_transcript(main_transcript);
    let tokens_sum = totals.input_tokens
        + totals.output_tokens
        + totals.cache_read_tokens
        + totals.cache_creation_tokens;
    ChatDrain {
        session_id: session_id.to_string(),
        tokens: tokens_sum,
        five_hour_pct,
        weekly_pct,
        messages,
    }
}

/// Full rundown for ONE chat (the popover): raw tokens + per-message breakdown +
/// window shares. The share denominator is every currently-visible chat, so the
/// popover is self-sufficient and no longer depends on the sidebar's drain sort
/// having run.
#[tauri::command]
pub async fn chat_drain(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ChatDrain>, String> {
    let Some((_cwd, main_transcript)) = resolve_session(&session_id, &state) else {
        return Ok(None);
    };

    // Visible set = every live instance, plus the target itself (it may be a
    // history-only session not in the cache). Collect ids first so the cache lock
    // isn't held across the per-id resolve.
    let mut ids: Vec<String> = state
        .cached_instances
        .lock()
        .unwrap()
        .iter()
        .map(|i| i.session_id.clone())
        .collect();
    if !ids.iter().any(|i| i == &session_id) {
        ids.push(session_id.clone());
    }
    let mut resolved: Vec<(String, PathBuf, PathBuf)> = Vec::new();
    for id in &ids {
        if let Some((cwd, transcript)) = resolve_session(id, &state) {
            resolved.push((id.clone(), cwd, transcript));
        }
    }

    let (util_5h, util_weekly) = util_from_state(&state);
    let target = session_id.clone();

    // Heavy file parsing off the async runtime.
    let result = tokio::task::spawn_blocking(move || {
        let (per_session, total_5h, total_weekly) = windowed_drains(&resolved);
        let (part_5h, part_weekly) = per_session.get(&target).copied().unwrap_or((0.0, 0.0));
        let five = share(util_5h, part_5h, total_5h);
        let weekly = share(util_weekly, part_weekly, total_weekly);
        let messages = drain_engine::message_drains(&main_transcript);
        build_chat_drain(&target, &main_transcript, five, weekly, messages)
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(Some(result))
}

/// Leaderboard payload: per-session window shares, messages omitted (cheap).
#[derive(serde::Serialize, Clone, Debug, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
#[serde(rename_all = "camelCase")]
pub struct DrainBoard {
    pub chats: HashMap<String, ChatDrain>, // per session: tokens + shares, messages EMPTY
}

/// Leaderboard payload for MANY chats. messages omitted (empty) for the cheap path.
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

    let (util_5h, util_weekly) = util_from_state(&state);

    let board = tokio::task::spawn_blocking(move || {
        let (per_session, total_5h, total_weekly) = windowed_drains(&resolved);
        let mut chats = HashMap::new();
        for (id, _cwd, transcript) in &resolved {
            let (part_5h, part_weekly) = per_session.get(id).copied().unwrap_or((0.0, 0.0));
            let five = share(util_5h, part_5h, total_5h);
            let weekly = share(util_weekly, part_weekly, total_weekly);
            let cd = build_chat_drain(id, transcript, five, weekly, Vec::new());
            chats.insert(id.clone(), cd);
        }
        DrainBoard { chats }
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(board)
}
