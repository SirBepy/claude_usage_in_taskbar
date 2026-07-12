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

/// Legacy matcher string we used to tag our entry. SessionStart/SessionEnd
/// treat `matcher` as a source filter (startup|resume|clear|compact), so a
/// literal app name here silently suppressed every hook firing. Kept only
/// to recognise and strip old entries during migration.
const LEGACY_MATCHER: &str = "aiusage-taskbar";

/// Bump this when the shape of the entry we emit changes. Paired with
/// `Settings::hook_install_version` so existing users get re-installed
/// once on the next launch after an upgrade.
pub const CURRENT_INSTALL_VERSION: u32 = 4;

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

    for (event, endpoint) in [
        ("SessionStart", "session-start"),
        ("SessionEnd", "session-end"),
        ("Stop", "stop"),
    ] {
        let command = curl_command(cfg.port, endpoint);
        let entry = json!({
            "hooks": [{
                "type": "command",
                "command": command,
            }]
        });
        let arr = hooks
            .as_object_mut()
            .unwrap()
            .entry(event.to_string())
            .or_insert_with(|| json!([]));
        if !arr.is_array() { *arr = json!([]); }
        let vec = arr.as_array_mut().unwrap();
        vec.retain(|v| !is_ours(v, endpoint));
        vec.push(entry);
    }

    out
}

/// Identifies one of our entries, both the current shape (matcher-less,
/// command contains `/hooks/<endpoint>`) and the legacy shape
/// (`matcher == "aiusage-taskbar"`). Used to strip prior copies before
/// pushing the fresh entry.
fn is_ours(entry: &Value, endpoint: &str) -> bool {
    if entry.get("matcher").and_then(|m| m.as_str()) == Some(LEGACY_MATCHER) {
        return true;
    }
    let Some(hooks) = entry.get("hooks").and_then(|h| h.as_array()) else { return false };
    let needle = format!("/hooks/{endpoint}");
    hooks.iter().any(|h| {
        h.get("command")
            .and_then(|c| c.as_str())
            .map(|c| c.contains(&needle))
            .unwrap_or(false)
    })
}

fn curl_command(port: u16, endpoint: &str) -> String {
    // Claude Code hooks run the command with the full JSON payload on
    // stdin. `curl --data-binary @-` streams stdin into the body.
    // `--connect-timeout 2 --max-time 4` bounds the call so a wedged daemon
    // can never hang every `claude` session on the machine at turn end, and
    // `|| exit 0` keeps a daemon-down failure non-blocking. Response body is
    // printed to stdout, so a `{"decision":"block",...}` answer from the
    // daemon (Stop marker enforcement) is honored by the CLI.
    format!(
        "curl -s --connect-timeout 2 --max-time 4 -X POST --data-binary @- -H 'Content-Type: application/json' http://127.0.0.1:{port}/hooks/{endpoint} || exit 0"
    )
}

// multi-account audit: stays valid, and per-profile hook install is free -
// every profile symlinks `settings.json` back to this one file, so installing
// the SessionStart/SessionEnd hooks here covers every account's spawns too.
pub fn global_settings_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home dir")?;
    Ok(home.join(".claude").join("settings.json"))
}

/// Returns true if `~/.claude/settings.json` already contains our
/// SessionStart + SessionEnd entries. Used to self-heal the local
/// `hooks_registered` flag when app-data was wiped (reinstall, etc.)
/// but the global hook is still in place — otherwise the consent
/// modal would re-prompt forever.
pub fn is_installed_globally() -> bool {
    let Ok(path) = global_settings_path() else { return false };
    let Ok(raw) = std::fs::read_to_string(&path) else { return false };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else { return false };
    let Some(hooks) = json.get("hooks").and_then(|h| h.as_object()) else { return false };
    for (event, endpoint) in [("SessionStart", "session-start"), ("SessionEnd", "session-end")] {
        let Some(arr) = hooks.get(event).and_then(|a| a.as_array()) else { return false };
        if !arr.iter().any(|e| is_ours(e, endpoint)) { return false; }
    }
    true
}

/// Reads the global settings file, merges our hooks, writes atomically.
/// Returns `Ok(())` on success or if the file is malformed (surfaces an
/// error the caller can show to the user, does NOT overwrite).
pub fn install(cfg: HookConfig) -> Result<()> {
    let path = global_settings_path()?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "{}".to_string(),
        Err(e) => return Err(e).context(format!("reading {path:?}")),
    };
    let existing: Value = serde_json::from_str(&raw)
        .with_context(|| format!("parsing {path:?} as JSON, not modifying"))?;
    let merged = merge_hooks(&existing, &cfg);
    let out = serde_json::to_string_pretty(&merged)?;
    crate::util::write_json_atomic(&path, &out)?;
    Ok(())
}
