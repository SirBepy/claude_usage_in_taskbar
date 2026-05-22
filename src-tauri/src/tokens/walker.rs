use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use super::record::TokenTotals;

pub(crate) fn claude_projects_dir() -> Option<PathBuf> {
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

/// Resolves the transcript file named after a specific session id.
/// Returns `Some(path)` only if the file actually exists. Use this
/// in preference to `latest_transcript_for_cwd` when a session_id is
/// known: two concurrent sessions share a cwd, so the "latest"
/// helper would return the same file for both and the dashboard
/// would show identical stats.
pub fn transcript_for_session(cwd: &Path, session_id: &str) -> Option<PathBuf> {
    let projects = claude_projects_dir()?;
    let path = projects
        .join(encode_cwd_as_project_dir(cwd))
        .join(format!("{session_id}.jsonl"));
    if path.exists() { Some(path) } else { None }
}

/// Resolves the transcript Claude CLI is writing *right now* for a
/// given cwd. A single CLI process can rotate through multiple
/// transcripts when the user runs `/compact` or `/clear`, and
/// `~/.claude/sessions/<pid>.json` keeps the stale initial sessionId,
/// so we cannot rely on sessionId to locate the file. Instead we read
/// `~/.claude/projects/<encoded-cwd>/` and return the most recently
/// modified `.jsonl` - that's the live transcript by construction.
///
/// WARNING: this returns the same path for every session that shares
/// `cwd`. Only safe when the caller has a single session in mind.
/// Use `transcript_for_session` when you have a session_id.
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

/// Scans a transcript for the first real user prompt and returns it
/// as a short label suitable for showing as the instance "name" in
/// the dashboard. Skips meta entries (`isMeta:true`), the
/// local-command-caveat preamble Claude injects, and slash-command
/// markup. Returns up to `max_chars` of the prompt with trailing
/// whitespace collapsed and "…" appended if it was truncated.
///
/// Returns None if the file is missing/malformed or no real user
/// prompt has been written yet (fresh session).
/// Extracts the inner text of `<tag>…</tag>` from `s`, if present.
fn tag_inner<'a>(s: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = s.find(&open)? + open.len();
    let end = s[start..].find(&close)? + start;
    Some(s[start..end].trim())
}

/// If `s` is a slash-command invocation (`<command-name>…</command-name>`),
/// renders it as the user typed it: the command name followed by its args
/// (e.g. `/rate-it 2 the new skill`). Returns None for a plain message.
fn command_label(s: &str) -> Option<String> {
    let name = tag_inner(s, "command-name")?;
    match tag_inner(s, "command-args") {
        Some(args) if !args.is_empty() => Some(format!("{name} {args}")),
        _ => Some(name.to_string()),
    }
}

/// Collapses control chars + whitespace runs to single spaces, trims, and
/// truncates to `max_chars` with a trailing `…`. Returns None if the result
/// is empty. Shared by `first_user_prompt` and `last_override_title` so titles
/// from either source look identical.
fn normalise_and_truncate(s: &str, max_chars: usize) -> Option<String> {
    let normalised: String = s
        .chars()
        .map(|c| if c.is_control() || c == '\n' || c == '\r' || c == '\t' { ' ' } else { c })
        .collect();
    let collapsed = normalised.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() { return None; }
    if collapsed.chars().count() <= max_chars {
        return Some(collapsed);
    }
    let cut: String = collapsed.chars().take(max_chars).collect();
    Some(format!("{cut}…"))
}

/// Reads up to the last 64KB of a transcript and returns the most recent
/// non-blank `custom-title` / `agent-name` override (written by /close's
/// rename-session script, which appends them at EOF). Scans backward so the
/// latest rename wins, discarding a partial first line from the tail window
/// and skipping any line that doesn't parse. Returns None when no override
/// has been written — callers then fall back to the first user prompt.
pub fn last_override_title(path: &Path, max_chars: usize) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 64 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    // If we started mid-file, the first line is likely partial — drop it.
    let mut lines: Vec<&str> = buf.lines().collect();
    if start > 0 && lines.len() > 1 {
        lines.remove(0);
    }
    for line in lines.into_iter().rev() {
        if line.trim().is_empty() { continue }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let value = match v.get("type").and_then(|t| t.as_str()) {
            Some("custom-title") => v.get("customTitle").and_then(|s| s.as_str()),
            Some("agent-name") => v.get("agentName").and_then(|s| s.as_str()),
            _ => None,
        };
        let Some(value) = value else { continue };
        if value.trim().is_empty() { continue }
        if let Some(title) = normalise_and_truncate(value, max_chars) {
            return Some(title);
        }
    }
    None
}

/// Resolves a session's display title: a curated override (from /close's
/// rename) wins, otherwise the first user prompt. This is what the sidebar /
/// history / restore paths use.
pub fn session_title(path: &Path, max_chars: usize) -> Option<String> {
    last_override_title(path, max_chars).or_else(|| first_user_prompt(path, max_chars))
}

pub fn first_user_prompt(path: &Path, max_chars: usize) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(|r| r.ok()) {
        if line.trim().is_empty() { continue }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") { continue }
        if v.get("isMeta").and_then(|b| b.as_bool()) == Some(true) { continue }
        let Some(msg) = v.get("message") else { continue };
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") { continue }
        let text = match msg.get("content") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(items)) => {
                let mut acc = String::new();
                for it in items {
                    if it.get("type").and_then(|t| t.as_str()) != Some("text") { continue }
                    if let Some(t) = it.get("text").and_then(|t| t.as_str()) {
                        if !acc.is_empty() { acc.push(' '); }
                        acc.push_str(t);
                    }
                }
                acc
            }
            _ => continue,
        };
        let trimmed = text.trim();
        if trimmed.is_empty() { continue }
        if trimmed.starts_with("<local-command-caveat>") { continue }
        // A slash-command invocation is stored as command-message / command-name
        // / command-args tags. Render it as the user typed it ("/rate-it 2 the
        // new skill") instead of leaking the raw markup as the title.
        let label = command_label(trimmed).map(std::borrow::Cow::Owned)
            .unwrap_or(std::borrow::Cow::Borrowed(trimmed));
        if let Some(title) = normalise_and_truncate(&label, max_chars) {
            return Some(title);
        }
    }
    None
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
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
            r#""#,
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
    fn first_user_prompt_uses_plain_text() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, r#"{"type":"user","message":{"role":"user","content":"build me a thing"}}"#).unwrap();
        assert_eq!(first_user_prompt(&path, 60).as_deref(), Some("build me a thing"));
    }

    #[test]
    fn first_user_prompt_renders_slash_command_as_name_plus_args() {
        // A slash-command invocation is stored with command-message /
        // command-name / command-args tags. The title should read like what
        // the user typed: "/rate-it 2 the new skill we made", not raw markup.
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, r#"{"type":"user","message":{"role":"user","content":"<command-message>rate-it</command-message>\n<command-name>/rate-it</command-name>\n<command-args>2 the new skill we made</command-args>"}}"#).unwrap();
        assert_eq!(
            first_user_prompt(&path, 60).as_deref(),
            Some("/rate-it 2 the new skill we made"),
        );
    }

    #[test]
    fn first_user_prompt_slash_command_without_args() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, r#"{"type":"user","message":{"role":"user","content":"<command-message>close</command-message>\n<command-name>/close</command-name>\n<command-args></command-args>"}}"#).unwrap();
        assert_eq!(first_user_prompt(&path, 60).as_deref(), Some("/close"));
    }

    fn user_line(text: &str) -> String {
        serde_json::json!({"type":"user","message":{"role":"user","content":text}}).to_string()
    }
    fn override_line(kind: &str, value: &str) -> String {
        // kind is "custom-title" or "agent-name"
        let field = if kind == "custom-title" { "customTitle" } else { "agentName" };
        serde_json::json!({"type":kind, field:value, "sessionId":"s1"}).to_string()
    }

    #[test]
    fn session_title_override_wins_over_first_prompt() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let body = [user_line("first prompt text"), override_line("custom-title", "Curated Name")].join("\n");
        std::fs::write(&path, body).unwrap();
        assert_eq!(session_title(&path, 60).as_deref(), Some("Curated Name"));
    }

    #[test]
    fn session_title_last_override_wins() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let body = [
            user_line("first prompt text"),
            override_line("custom-title", "Old Name"),
            override_line("agent-name", "New Name"),
        ].join("\n");
        std::fs::write(&path, body).unwrap();
        assert_eq!(session_title(&path, 60).as_deref(), Some("New Name"));
    }

    #[test]
    fn session_title_blank_override_falls_through_to_first_prompt() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let body = [user_line("first prompt text"), override_line("custom-title", "   ")].join("\n");
        std::fs::write(&path, body).unwrap();
        assert_eq!(session_title(&path, 60).as_deref(), Some("first prompt text"));
    }

    #[test]
    fn session_title_no_override_equals_first_user_prompt() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, user_line("just a plain prompt")).unwrap();
        assert_eq!(session_title(&path, 60), first_user_prompt(&path, 60));
        assert_eq!(session_title(&path, 60).as_deref(), Some("just a plain prompt"));
    }

    #[test]
    fn last_override_title_reads_tail_past_large_filler() {
        // Override sits after a big block of (some malformed) early lines.
        // Tail-read must still find it without depending on a full parse.
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let mut lines = vec![user_line("first prompt text")];
        for i in 0..4000 {
            lines.push(format!("not even json line {i} ############################"));
        }
        lines.push(override_line("custom-title", "Tail Name"));
        std::fs::write(&path, lines.join("\n")).unwrap();
        assert_eq!(last_override_title(&path, 60).as_deref(), Some("Tail Name"));
        assert_eq!(session_title(&path, 60).as_deref(), Some("Tail Name"));
    }

    #[test]
    fn last_override_title_none_when_absent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, user_line("hi")).unwrap();
        assert_eq!(last_override_title(&path, 60), None);
    }

    #[test]
    fn parse_transcript_missing_file_returns_zero() {
        let totals = parse_transcript(Path::new("definitely-not-a-real-file.jsonl"));
        assert_eq!(totals.turns, 0);
        assert_eq!(totals.input_tokens, 0);
    }

    #[test]
    fn decode_cwd_returns_original_when_no_drive_marker_on_windows() {
        if cfg!(windows) {
            assert_eq!(decode_cwd("just-some-name"), "just-some-name");
        }
    }
}
