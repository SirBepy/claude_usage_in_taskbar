use crate::skill_usage::types::{InvocationSource, SkillUsageEvent, TokenBreakdown};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::Path;

pub fn parse_transcript(path: &Path) -> Vec<SkillUsageEvent> {
    let Ok(file) = std::fs::File::open(path) else { return vec![] };
    let lines: Vec<Value> = BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
        .collect();

    let mut events = Vec::new();
    let mut last_user_text: Option<String> = None;
    let mut skill_seen_since_user: bool = false;
    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;

    for i in 0..lines.len() {
        let row = &lines[i];
        let row_type = row.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if session_id.is_none() {
            session_id = row
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
        if cwd.is_none() {
            cwd = row
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }

        match row_type {
            "user" => {
                if let Some(text) = first_user_text(row) {
                    last_user_text = Some(text);
                    skill_seen_since_user = false;
                }
            }
            "assistant" => {
                let Some(content) = row
                    .pointer("/message/content")
                    .and_then(|v| v.as_array())
                else {
                    continue;
                };
                let mut first_skill_in_turn: Option<String> = None;
                for c in content {
                    if c.get("type").and_then(|v| v.as_str()) == Some("tool_use")
                        && c.get("name").and_then(|v| v.as_str()) == Some("Skill")
                    {
                        let skill_name = c
                            .pointer("/input/skill")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if skill_name.is_empty() {
                            continue;
                        }
                        if first_skill_in_turn.is_none() {
                            first_skill_in_turn = Some(skill_name.to_string());
                        }
                    }
                }
                let Some(skill_name) = first_skill_in_turn else {
                    continue;
                };

                let source = classify_source(
                    &skill_name,
                    last_user_text.as_deref(),
                    skill_seen_since_user,
                );
                let tokens = next_assistant_usage(&lines, i);
                let project = cwd.as_deref().map(basename).unwrap_or_default();
                events.push(SkillUsageEvent {
                    ts: chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    skill: skill_name,
                    session_id: session_id.clone().unwrap_or_default(),
                    project,
                    source,
                    tokens,
                });
                skill_seen_since_user = true;
            }
            _ => {}
        }
    }

    events
}

fn first_user_text(row: &Value) -> Option<String> {
    let arr = row.pointer("/message/content")?.as_array()?;
    for c in arr {
        if c.get("type").and_then(|v| v.as_str()) == Some("text") {
            return c
                .get("text")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
    }
    None
}

fn classify_source(
    skill_name: &str,
    last_user_text: Option<&str>,
    skill_seen_since_user: bool,
) -> InvocationSource {
    if let Some(text) = last_user_text {
        let trimmed = text.trim_start();
        if let Some(rest) = trimmed.strip_prefix('/') {
            let short = skill_name.rsplit(':').next().unwrap_or(skill_name);
            let head = rest
                .split(|c: char| c.is_whitespace())
                .next()
                .unwrap_or("");
            if head == skill_name || head == short {
                return InvocationSource::Manual;
            }
        }
    }
    if skill_seen_since_user {
        return InvocationSource::Skill;
    }
    InvocationSource::Auto
}

fn next_assistant_usage(lines: &[Value], from_idx: usize) -> TokenBreakdown {
    for line in lines.iter().skip(from_idx + 1) {
        if line.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(usage) = line.pointer("/message/usage") else {
            continue;
        };
        return TokenBreakdown {
            input: usage
                .get("input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            output: usage
                .get("output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            cache_read: usage
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            cache_create: usage
                .get("cache_creation_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        };
    }
    TokenBreakdown::default()
}

fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(trimmed)
        .to_string()
}
