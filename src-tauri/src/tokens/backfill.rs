use anyhow::Result;
use chrono::{DateTime, SecondsFormat, Utc};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use super::record::{BackfillResult, TokenRecord};
use super::aggregate::{load_history, save_history};
use super::walker::{claude_projects_dir, decode_cwd, parse_transcript, walk_jsonl};

fn iso_date(t: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(t).format("%Y-%m-%d").to_string()
}

fn iso(t: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn file_stamps(path: &Path) -> (String, String, String) {
    if let Ok(meta) = std::fs::metadata(path) {
        let modified = meta.modified().unwrap_or_else(|_| std::time::SystemTime::now());
        let created = meta.created().unwrap_or(modified);
        return (iso_date(modified), iso(created), iso(modified));
    }
    let now = Utc::now();
    let iso_now = now.to_rfc3339_opts(SecondsFormat::Secs, true);
    (now.format("%Y-%m-%d").to_string(), iso_now.clone(), iso_now)
}

/// Walk the Claude projects dir and append any session not yet recorded.
/// Subagent transcripts (files under a `subagents/` subdir) get summed into
/// their parent session record instead of getting their own.
pub fn backfill_all(history_path: &Path) -> Result<BackfillResult> {
    let Some(projects_dir) = claude_projects_dir() else {
        return Ok(BackfillResult::default());
    };
    let files = walk_jsonl(&projects_dir);

    let mut regular: Vec<PathBuf> = Vec::new();
    let mut subagent: Vec<PathBuf> = Vec::new();
    for p in files {
        let in_subagents = p
            .parent()
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            == Some("subagents");
        if in_subagents { subagent.push(p) } else { regular.push(p) }
    }

    let mut history = load_history(history_path);
    let mut known_ids: HashSet<String> =
        history.iter().map(|r| r.session_id.clone()).collect();

    let mut result = BackfillResult::default();

    for file in &regular {
        let Some(session_id) = file.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        if known_ids.contains(&session_id) { result.skipped += 1; continue }

        let project_dir_name = file
            .parent()
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let cwd = decode_cwd(&project_dir_name);
        let (date, started_at, last_active_at) = file_stamps(file);
        let totals = parse_transcript(file);
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);

        history.push(TokenRecord {
            session_id: session_id.clone(),
            cwd: Some(cwd),
            date,
            input_tokens: totals.input_tokens,
            output_tokens: totals.output_tokens,
            cache_read_tokens: totals.cache_read_tokens,
            cache_creation_tokens: totals.cache_creation_tokens,
            turns: totals.turns,
            started_at,
            last_active_at,
            recorded_at: now,
            live: None,
            merged_subagents: None,
        });
        known_ids.insert(session_id);
        result.processed += 1;
    }

    let mut merged_agent_ids: HashSet<String> = HashSet::new();
    for r in &history {
        if let Some(list) = &r.merged_subagents {
            for id in list { merged_agent_ids.insert(id.clone()); }
        }
    }

    for file in &subagent {
        let Some(agent_id) = file.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        if merged_agent_ids.contains(&agent_id) { result.sub_skipped += 1; continue }

        let parent_session_id = file
            .parent()
            .and_then(|d| d.parent())
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let encoded_project_dir = file
            .parent()
            .and_then(|d| d.parent())
            .and_then(|d| d.parent())
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let cwd = decode_cwd(&encoded_project_dir);
        let (date, started_at, last_active_at) = file_stamps(file);
        let totals = parse_transcript(file);

        let idx = history.iter().position(|r| r.session_id == parent_session_id);
        let parent_idx = match idx {
            Some(i) => i,
            None => {
                let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
                history.push(TokenRecord {
                    session_id: parent_session_id.clone(),
                    cwd: Some(cwd),
                    date: date.clone(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    turns: 0,
                    started_at: started_at.clone(),
                    last_active_at: last_active_at.clone(),
                    recorded_at: now,
                    live: None,
                    merged_subagents: Some(Vec::new()),
                });
                history.len() - 1
            }
        };

        let p = &mut history[parent_idx];
        p.input_tokens += totals.input_tokens;
        p.output_tokens += totals.output_tokens;
        p.cache_read_tokens += totals.cache_read_tokens;
        p.cache_creation_tokens += totals.cache_creation_tokens;
        p.turns += totals.turns;
        if started_at < p.started_at || p.started_at.is_empty() {
            p.started_at = started_at;
        }
        if last_active_at > p.last_active_at {
            p.last_active_at = last_active_at;
        }
        let list = p.merged_subagents.get_or_insert_with(Vec::new);
        list.push(agent_id.clone());
        merged_agent_ids.insert(agent_id);
        result.sub_processed += 1;
    }

    save_history(history_path, &history)?;
    Ok(result)
}
