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
