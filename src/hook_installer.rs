//! One-time global Claude Code hook registration.
//!
//! Merges our SessionStart + SessionEnd entries into
//! `~/.claude/settings.json`. Preserves every unrelated field and any
//! hook entries other apps have installed. Idempotent: re-running with
//! the same port is a no-op; re-running with a new port updates our
//! single entry in place.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::PathBuf;

/// Fixed matcher identifier so re-runs replace our own entry.
const MATCHER: &str = "aiusage-taskbar";

#[derive(Debug, Clone, Copy)]
pub struct HookConfig {
    pub port: u16,
}

/// Pure merge helper. Takes the current settings JSON and returns a
/// new JSON with our hooks present. Never mutates input.
pub fn merge_hooks(existing: &Value, cfg: &HookConfig) -> Value {
    let mut out = existing.clone();
    if !out.is_object() {
        out = json!({});
    }
    let obj = out.as_object_mut().unwrap();

    let hooks = obj.entry("hooks".to_string()).or_insert_with(|| json!({}));
    if !hooks.is_object() { *hooks = json!({}); }

    for (event, endpoint) in [("SessionStart", "session-start"), ("SessionEnd", "session-end")] {
        let entry = json!({
            "matcher": MATCHER,
            "hooks": [{
                "type": "command",
                "command": curl_command(cfg.port, endpoint),
            }]
        });
        let arr = hooks
            .as_object_mut()
            .unwrap()
            .entry(event.to_string())
            .or_insert_with(|| json!([]));
        if !arr.is_array() { *arr = json!([]); }
        let vec = arr.as_array_mut().unwrap();
        // Remove any prior `aiusage-taskbar` entry so the new one is authoritative.
        vec.retain(|v| v.get("matcher").and_then(|m| m.as_str()) != Some(MATCHER));
        vec.push(entry);
    }

    out
}

fn curl_command(port: u16, endpoint: &str) -> String {
    // Claude Code hooks run the command with the full JSON payload on
    // stdin. `curl --data-binary @-` streams stdin into the body.
    format!(
        "curl -sS -X POST --data-binary @- -H 'Content-Type: application/json' http://127.0.0.1:{port}/hooks/{endpoint}"
    )
}

pub fn global_settings_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home dir")?;
    Ok(home.join(".claude").join("settings.json"))
}

/// Reads the global settings file, merges our hooks, writes atomically.
/// Returns `Ok(())` on success or if the file is malformed (surfaces an
/// error the caller can show to the user — does NOT overwrite).
pub fn install(cfg: HookConfig) -> Result<()> {
    let path = global_settings_path()?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "{}".to_string(),
        Err(e) => return Err(e).context(format!("reading {path:?}")),
    };
    let existing: Value = serde_json::from_str(&raw)
        .with_context(|| format!("parsing {path:?} as JSON — not modifying"))?;
    let merged = merge_hooks(&existing, &cfg);
    let out = serde_json::to_string_pretty(&merged)?;
    // Atomic write: temp file + rename.
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).ok(); }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, out)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
