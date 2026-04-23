//! Token usage statistics: walks `~/.claude/projects/**/*.jsonl`, parses
//! Claude Code transcript files, and keeps a per-session aggregate on disk
//! at `<app-data>/token-history.json` that the dashboard reads.
//!
//! Ported from `src/core/token-stats.rs` (Electron) and preserves the JSON
//! field names the renderer expects: camelCase (`sessionId`, `inputTokens`,
//! `lastActiveAt`, ...). Do NOT rename without updating dist/modules/stats.js.

use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// One session's aggregated token counts, as persisted and returned to the UI.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenRecord {
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    /// ISO date (YYYY-MM-DD) the session happened on.
    pub date: String,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_creation_tokens: u64,
    #[serde(default)]
    pub turns: u64,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub last_active_at: String,
    #[serde(default)]
    pub recorded_at: String,
    /// Set on records produced by `active_sessions()` — the renderer uses
    /// this to style in-progress sessions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
    /// Agent IDs whose subagent transcripts have been merged into this record.
    /// Kept for idempotency of repeated backfills.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_subagents: Option<Vec<String>>,
}

/// Summed token usage from a single transcript file.
#[derive(Clone, Debug, Default)]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// Count of model invocations (every line with a `usage` block).
    /// Includes each tool-call round-trip, so a single user prompt can
    /// produce many turns.
    pub turns: u64,
    /// Count of `"type":"last-prompt"` lines, i.e. distinct user-typed
    /// prompts sent to the model. A better proxy for "messages sent by
    /// me" than `turns`, which inflates with tool-call chatter.
    pub user_prompts: u64,
}

/// Result of a `backfill_all()` run — reported back to the renderer so it can
/// render "Done — X new, Y skipped".
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackfillResult {
    pub processed: u32,
    pub skipped: u32,
    pub sub_processed: u32,
    pub sub_skipped: u32,
}

// ── path helpers ─────────────────────────────────────────────────────────────

fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Claude CLI names its per-project transcript dir by replacing every
/// non-alphanumeric character in the absolute cwd with `-`. Verified
/// against real directories on disk (e.g. `c:\Users\tecno\Desktop\...\
/// claude_usage_in_taskbar` → `c--Users-tecno-Desktop-...-claude-usage-
/// in-taskbar`, `C:\Users\tecno\.claude` → `C--Users-tecno--claude`).
pub fn encode_cwd_as_project_dir(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Resolves the transcript Claude CLI is writing *right now* for a
/// given cwd. A single CLI process can rotate through multiple
/// transcripts when the user runs `/compact` or `/clear`, and
/// `~/.claude/sessions/<pid>.json` keeps the stale initial sessionId,
/// so we cannot rely on sessionId to locate the file. Instead we read
/// `~/.claude/projects/<encoded-cwd>/` and return the most recently
/// modified `.jsonl` - that's the live transcript by construction.
pub fn latest_transcript_for_cwd(cwd: &Path) -> Option<PathBuf> {
    let projects = claude_projects_dir()?;
    let dir = projects.join(encode_cwd_as_project_dir(cwd));
    let entries = std::fs::read_dir(&dir).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        match &best {
            Some((t, _)) if *t >= mtime => {}
            _ => best = Some((mtime, path)),
        }
    }
    best.map(|(_, p)| p)
}

/// Recursively collect every `.jsonl` file under `dir`. Unreadable subdirs
/// are skipped silently — matches the Electron implementation's `try/catch`
/// around `fs.readdirSync`.
pub fn walk_jsonl(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk_jsonl(&path));
        } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
    out
}

// ── cwd decoder ──────────────────────────────────────────────────────────────

/// Best-effort decode of a Claude project directory name back to its real
/// filesystem path. Claude encodes all of `/ \ _ space :` as `-`, so the
/// reverse direction has to probe the actual filesystem to find which `-`
/// was which separator.
///
/// Ported from `src/core/path-decoder.js`. Strategy: at each level, read the
/// real directory, then greedy-match the most remaining dashed segments.
pub fn decode_cwd(encoded: &str) -> String {
    let sep: char = if cfg!(windows) { '\\' } else { '/' };
    let (mut current_path, raw_parts): (String, Vec<&str>) = if cfg!(windows) {
        // Windows paths are encoded with the drive letter followed by "--".
        // Example: "c--Users-tecno-My-Project" → "c:\Users\tecno\My Project".
        if let Some(drive_sep) = encoded.find("--") {
            let drive = &encoded[..drive_sep];
            let rest = &encoded[drive_sep + 2..];
            (format!("{drive}:{sep}"), rest.split('-').collect())
        } else {
            return encoded.to_string();
        }
    } else {
        ("/".to_string(), encoded.split('-').collect())
    };

    // Collapse empty segments from "--" inside the path. Claude encodes a
    // leading "." (hidden dir like .claude) as "-", so after splitting on "-"
    // we get an empty slot followed by the real name. Reassemble as ".name".
    let mut parts: Vec<String> = Vec::with_capacity(raw_parts.len());
    let mut i = 0;
    while i < raw_parts.len() {
        if raw_parts[i].is_empty() && i + 1 < raw_parts.len() {
            parts.push(format!(".{}", raw_parts[i + 1]));
            i += 2;
        } else {
            parts.push(raw_parts[i].to_string());
            i += 1;
        }
    }

    let norm = |s: &str| -> String {
        s.chars()
            .flat_map(|c| c.to_lowercase())
            .map(|c| match c {
                '-' | '_' | ' ' => '\0',
                other => other,
            })
            .collect()
    };

    let mut i = 0;
    while i < parts.len() {
        let mut matched = false;
        // Read the current real directory and greedy-match from longest
        // multi-segment candidate down to a single segment.
        if let Ok(entries) = std::fs::read_dir(&current_path) {
            let entry_map: std::collections::HashMap<String, String> = entries
                .flatten()
                .filter_map(|e| {
                    e.file_name().to_str().map(|s| (norm(s), s.to_string()))
                })
                .collect();
            let remaining = parts.len() - i;
            for n in (1..=remaining).rev() {
                let candidate = norm(&parts[i..i + n].join("-"));
                if let Some(real) = entry_map.get(&candidate) {
                    if !current_path.ends_with(sep) {
                        current_path.push(sep);
                    }
                    current_path.push_str(real);
                    i += n;
                    matched = true;
                    break;
                }
            }
        }
        if !matched {
            if !current_path.ends_with(sep) {
                current_path.push(sep);
            }
            current_path.push_str(&parts[i]);
            i += 1;
        }
    }

    current_path
}

// ── transcript parser ────────────────────────────────────────────────────────

/// Sum assistant-turn token counts from a Claude Code transcript.
/// Malformed or missing files yield a zero-filled record (never panic).
pub fn parse_transcript(path: &Path) -> TokenTotals {
    let mut acc = TokenTotals::default();
    let Ok(file) = std::fs::File::open(path) else { return acc };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(|r| r.ok()) {
        if line.trim().is_empty() { continue }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("last-prompt") => {
                acc.user_prompts += 1;
                continue;
            }
            Some("assistant") => {
                // Usage may live under `message.usage` or directly under `usage`.
                let usage = v.get("message").and_then(|m| m.get("usage")).or_else(|| v.get("usage"));
                let Some(usage) = usage else { continue };
                let get = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
                acc.input_tokens += get("input_tokens");
                acc.output_tokens += get("output_tokens");
                acc.cache_read_tokens += get("cache_read_input_tokens");
                acc.cache_creation_tokens += get("cache_creation_input_tokens");
                acc.turns += 1;
            }
            _ => {}
        }
    }
    acc
}

// ── on-disk store ────────────────────────────────────────────────────────────

pub fn load_history(path: &Path) -> Vec<TokenRecord> {
    let Ok(raw) = std::fs::read_to_string(path) else { return vec![] };
    if raw.trim().is_empty() { return vec![] }
    let Ok(parsed) = serde_json::from_str::<Vec<TokenRecord>>(&raw) else { return vec![] };
    parsed.into_iter().filter(|r| !r.session_id.is_empty()).collect()
}

pub fn save_history(path: &Path, history: &[TokenRecord]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let json = serde_json::to_string_pretty(history).context("serialising token history")?;
    std::fs::write(path, json).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// Append a session to disk, idempotent on `session_id`. Returns the updated
/// list so callers can emit it to the webview.
pub fn append_session(path: &Path, mut record: TokenRecord) -> Result<Vec<TokenRecord>> {
    let mut history = load_history(path);
    if history.iter().any(|r| r.session_id == record.session_id) {
        return Ok(history);
    }
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    if record.started_at.is_empty() { record.started_at = now.clone() }
    if record.last_active_at.is_empty() { record.last_active_at = now.clone() }
    if record.recorded_at.is_empty() { record.recorded_at = now }
    history.push(record);
    save_history(path, &history)?;
    Ok(history)
}

// ── backfill ─────────────────────────────────────────────────────────────────

fn iso_date(t: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(t).format("%Y-%m-%d").to_string()
}

fn iso(t: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn file_stamps(path: &Path) -> (String, String, String) {
    // Returns (date, started_at, last_active_at). Falls back to "now" if the
    // file has no readable metadata.
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

    // ── regular sessions ───────────────────────────────────────────────────
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

    // ── subagent sessions ──────────────────────────────────────────────────
    // Collect agents already merged anywhere — prevents double-counting on
    // repeated backfills.
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

        // Path: <projects>/<encoded>/<parent_session>/subagents/<agent>.jsonl
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

        // Find or create the parent record.
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

// ── live/active sessions ─────────────────────────────────────────────────────

/// Find JSONL files modified in the last 12 hours whose session hasn't been
/// persisted yet — the dashboard uses this to surface in-progress work.
pub fn active_sessions(history_path: &Path) -> Vec<TokenRecord> {
    let history = load_history(history_path);
    let known_ids: HashSet<String> =
        history.iter().map(|r| r.session_id.clone()).collect();

    let Some(projects_dir) = claude_projects_dir() else { return vec![] };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(12 * 3600))
        .unwrap_or_else(std::time::SystemTime::now);

    let mut results = Vec::new();
    let Ok(project_entries) = std::fs::read_dir(&projects_dir) else { return vec![] };
    for proj_entry in project_entries.flatten() {
        if !proj_entry.path().is_dir() { continue }
        let proj_name = proj_entry.file_name().to_string_lossy().to_string();
        let Ok(entries) = std::fs::read_dir(proj_entry.path()) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue }
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue }
            let Some(session_id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            if known_ids.contains(&session_id) { continue }

            let Ok(meta) = entry.metadata() else { continue };
            let modified = meta.modified().unwrap_or_else(|_| std::time::SystemTime::now());
            if modified < cutoff { continue }
            let created = meta.created().unwrap_or(modified);
            let totals = parse_transcript(&path);
            results.push(TokenRecord {
                session_id,
                cwd: Some(decode_cwd(&proj_name)),
                date: iso_date(modified),
                input_tokens: totals.input_tokens,
                output_tokens: totals.output_tokens,
                cache_read_tokens: totals.cache_read_tokens,
                cache_creation_tokens: totals.cache_creation_tokens,
                turns: totals.turns,
                started_at: iso(created),
                last_active_at: iso(modified),
                recorded_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
                live: Some(true),
                merged_subagents: None,
            });
        }
    }
    results
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn walk_jsonl_finds_nested_files() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::write(dir.path().join("a/one.jsonl"), "").unwrap();
        std::fs::write(dir.path().join("a/b/two.jsonl"), "").unwrap();
        std::fs::write(dir.path().join("a/ignore.txt"), "").unwrap();
        let mut found = walk_jsonl(dir.path());
        found.sort();
        assert_eq!(found.len(), 2);
        assert!(found[0].ends_with("one.jsonl") || found[1].ends_with("one.jsonl"));
    }

    #[test]
    fn encode_cwd_matches_claude_cli_layout() {
        use std::path::Path;
        assert_eq!(
            encode_cwd_as_project_dir(Path::new("c:\\Users\\tecno\\Desktop\\Projects\\claude_usage_in_taskbar")),
            "c--Users-tecno-Desktop-Projects-claude-usage-in-taskbar",
        );
        assert_eq!(
            encode_cwd_as_project_dir(Path::new("C:\\Users\\tecno\\.claude")),
            "C--Users-tecno--claude",
        );
    }

    #[test]
    fn latest_transcript_for_cwd_returns_none_when_dir_missing() {
        use std::path::Path;
        let out = latest_transcript_for_cwd(Path::new("Z:\\does\\not\\exist"));
        assert!(out.is_none());
    }

    #[test]
    fn parse_transcript_sums_assistant_usages() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let content = [
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":3}}}"#,
            r#""#, // blank line tolerated
            r#"{"type":"assistant","usage":{"input_tokens":100,"output_tokens":50}}"#,
            r#"not json at all"#,
        ].join("\n");
        std::fs::write(&path, content).unwrap();
        let totals = parse_transcript(&path);
        assert_eq!(totals.input_tokens, 110);
        assert_eq!(totals.output_tokens, 70);
        assert_eq!(totals.cache_read_tokens, 5);
        assert_eq!(totals.cache_creation_tokens, 3);
        assert_eq!(totals.turns, 2);
    }

    #[test]
    fn parse_transcript_missing_file_returns_zero() {
        let totals = parse_transcript(Path::new("definitely-not-a-real-file.jsonl"));
        assert_eq!(totals.turns, 0);
        assert_eq!(totals.input_tokens, 0);
    }

    #[test]
    fn load_save_history_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("token-history.json");
        let rec = TokenRecord {
            session_id: "S1".into(),
            cwd: Some("C:\\proj".into()),
            date: "2026-04-20".into(),
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_creation_tokens: 4,
            turns: 5,
            started_at: "2026-04-20T10:00:00Z".into(),
            last_active_at: "2026-04-20T10:30:00Z".into(),
            recorded_at: "2026-04-20T10:31:00Z".into(),
            live: None,
            merged_subagents: None,
        };
        save_history(&path, std::slice::from_ref(&rec)).unwrap();
        let back = load_history(&path);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].session_id, "S1");
        assert_eq!(back[0].turns, 5);
    }

    #[test]
    fn load_history_returns_empty_for_missing_or_corrupt() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nope.json");
        assert!(load_history(&missing).is_empty());

        let corrupt = dir.path().join("c.json");
        std::fs::write(&corrupt, "{ this is not valid json").unwrap();
        assert!(load_history(&corrupt).is_empty());
    }

    #[test]
    fn append_session_is_idempotent_on_session_id() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("h.json");
        let rec = TokenRecord {
            session_id: "S1".into(),
            date: "2026-04-20".into(),
            input_tokens: 1,
            ..Default::default()
        };
        append_session(&path, rec.clone()).unwrap();
        append_session(&path, rec.clone()).unwrap();
        let h = load_history(&path);
        assert_eq!(h.len(), 1, "duplicate append should be a no-op");
    }

    /// A `backfill_all`-style helper that takes an explicit projects dir so
    /// we can unit-test the aggregation without reaching out to `~/.claude`.
    /// Mirrors the main flow; if either diverges, update both.
    fn backfill_from(projects_dir: &Path, history_path: &Path) -> BackfillResult {
        let files = walk_jsonl(projects_dir);
        let mut regular = Vec::new();
        let mut subagent = Vec::new();
        for p in files {
            let in_sub = p.parent().and_then(|d| d.file_name()).and_then(|n| n.to_str())
                == Some("subagents");
            if in_sub { subagent.push(p) } else { regular.push(p) }
        }

        let mut history = load_history(history_path);
        let mut known: HashSet<String> = history.iter().map(|r| r.session_id.clone()).collect();
        let mut result = BackfillResult::default();

        for file in &regular {
            let sid = file.file_stem().and_then(|s| s.to_str()).unwrap().to_string();
            if known.contains(&sid) { result.skipped += 1; continue }
            let totals = parse_transcript(file);
            history.push(TokenRecord {
                session_id: sid.clone(),
                cwd: Some("C:\\fake".into()),
                date: "2026-04-20".into(),
                input_tokens: totals.input_tokens,
                output_tokens: totals.output_tokens,
                cache_read_tokens: totals.cache_read_tokens,
                cache_creation_tokens: totals.cache_creation_tokens,
                turns: totals.turns,
                started_at: "2026-04-20T10:00:00Z".into(),
                last_active_at: "2026-04-20T10:30:00Z".into(),
                recorded_at: "2026-04-20T10:31:00Z".into(),
                live: None,
                merged_subagents: None,
            });
            known.insert(sid);
            result.processed += 1;
        }

        let mut merged_ids: HashSet<String> = HashSet::new();
        for r in &history {
            if let Some(l) = &r.merged_subagents { for id in l { merged_ids.insert(id.clone()); } }
        }
        for file in &subagent {
            let agent_id = file.file_stem().and_then(|s| s.to_str()).unwrap().to_string();
            if merged_ids.contains(&agent_id) { result.sub_skipped += 1; continue }
            let parent_sid = file
                .parent().and_then(|d| d.parent())
                .and_then(|d| d.file_name()).and_then(|n| n.to_str()).unwrap().to_string();
            let totals = parse_transcript(file);
            let idx = history.iter().position(|r| r.session_id == parent_sid);
            let idx = idx.unwrap_or_else(|| {
                history.push(TokenRecord {
                    session_id: parent_sid.clone(),
                    cwd: Some("C:\\fake".into()),
                    date: "2026-04-20".into(),
                    started_at: "2026-04-20T09:00:00Z".into(),
                    last_active_at: "2026-04-20T09:00:00Z".into(),
                    recorded_at: "2026-04-20T09:00:00Z".into(),
                    merged_subagents: Some(Vec::new()),
                    ..Default::default()
                });
                history.len() - 1
            });
            let p = &mut history[idx];
            p.input_tokens += totals.input_tokens;
            p.output_tokens += totals.output_tokens;
            p.cache_read_tokens += totals.cache_read_tokens;
            p.cache_creation_tokens += totals.cache_creation_tokens;
            p.turns += totals.turns;
            p.merged_subagents.get_or_insert_with(Vec::new).push(agent_id.clone());
            merged_ids.insert(agent_id);
            result.sub_processed += 1;
        }

        save_history(history_path, &history).unwrap();
        result
    }

    #[test]
    fn backfill_aggregates_and_merges_subagents() {
        let dir = tempdir().unwrap();
        let projects = dir.path().join("projects");
        let history_path = dir.path().join("token-history.json");

        // projects/proj-a/SESSION-1.jsonl
        let proj_a = projects.join("proj-a");
        std::fs::create_dir_all(&proj_a).unwrap();
        std::fs::write(
            proj_a.join("SESSION-1.jsonl"),
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":20}}}"#,
        ).unwrap();

        // projects/proj-a/SESSION-1/subagents/AGENT-X.jsonl
        let sub_dir = proj_a.join("SESSION-1").join("subagents");
        std::fs::create_dir_all(&sub_dir).unwrap();
        std::fs::write(
            sub_dir.join("AGENT-X.jsonl"),
            r#"{"type":"assistant","message":{"usage":{"input_tokens":5,"output_tokens":1}}}"#,
        ).unwrap();

        let r = backfill_from(&projects, &history_path);
        assert_eq!(r.processed, 1);
        assert_eq!(r.sub_processed, 1);

        let history = load_history(&history_path);
        assert_eq!(history.len(), 1, "subagent should be merged into parent");
        let s1 = history.iter().find(|r| r.session_id == "SESSION-1").unwrap();
        assert_eq!(s1.input_tokens, 15, "10 (main) + 5 (sub) input tokens");
        assert_eq!(s1.output_tokens, 21, "20 (main) + 1 (sub) output tokens");
        assert_eq!(s1.merged_subagents.as_ref().unwrap(), &vec!["AGENT-X".to_string()]);

        // Idempotency: running backfill again yields zero new processed.
        let r2 = backfill_from(&projects, &history_path);
        assert_eq!(r2.processed, 0);
        assert_eq!(r2.skipped, 1);
        assert_eq!(r2.sub_processed, 0);
        assert_eq!(r2.sub_skipped, 1);
        let history2 = load_history(&history_path);
        assert_eq!(history2.len(), 1, "re-backfill must not duplicate");
        let s1b = history2.iter().find(|r| r.session_id == "SESSION-1").unwrap();
        assert_eq!(s1b.input_tokens, 15, "tokens stable across re-backfill");
    }

    #[test]
    fn decode_cwd_returns_original_when_no_drive_marker_on_windows() {
        // Input without "--" on Windows should be returned unchanged (matches
        // the JS reference behaviour, which has no fallback on that branch).
        if cfg!(windows) {
            assert_eq!(decode_cwd("just-some-name"), "just-some-name");
        }
    }
}
