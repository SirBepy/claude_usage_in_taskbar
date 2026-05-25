use std::io::{BufRead, BufReader};
use std::path::Path;

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

/// Scans a transcript for the first real user prompt and returns it
/// as a short label suitable for showing as the instance "name" in
/// the dashboard. Skips meta entries (`isMeta:true`), the
/// local-command-caveat preamble Claude injects, and slash-command
/// markup. Returns up to `max_chars` of the prompt with trailing
/// whitespace collapsed and "…" appended if it was truncated.
///
/// Returns None if the file is missing/malformed or no real user
/// prompt has been written yet (fresh session).
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
        let label = command_label(trimmed).map(std::borrow::Cow::Owned)
            .unwrap_or(std::borrow::Cow::Borrowed(trimmed));
        if let Some(title) = normalise_and_truncate(&label, max_chars) {
            return Some(title);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn first_user_prompt_uses_plain_text() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, r#"{"type":"user","message":{"role":"user","content":"build me a thing"}}"#).unwrap();
        assert_eq!(first_user_prompt(&path, 60).as_deref(), Some("build me a thing"));
    }

    #[test]
    fn first_user_prompt_renders_slash_command_as_name_plus_args() {
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
}
