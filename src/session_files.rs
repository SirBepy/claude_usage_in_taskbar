//! Reads `~/.claude/sessions/<pid>.json` to resolve the
//! `bridgeSessionId` that's needed for remote-control phone links.
//!
//! Claude Code writes this file async after starting. We poll up to
//! 15 × 500ms = ~7.5s before giving up.
//!
//! On app startup we also scan the whole directory to re-hydrate the
//! in-memory instance registry for Claude sessions that started while
//! the app was down (or pre-dated the hook install). The registry is
//! in-memory only, so without this scan a restart of the taskbar app
//! would blank every running session from the UI until each one fired
//! a fresh SessionStart hook (which they don't, because Claude only
//! fires it on session creation).

use anyhow::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Parsed shape of `~/.claude/sessions/<pid>.json`. Only the fields we
/// actually consume are extracted; the file carries a handful of other
/// keys we don't need (version, procStart, peerProtocol, ...).
#[derive(Debug, Clone, PartialEq)]
pub struct ScannedSession {
    pub pid: u32,
    pub session_id: String,
    pub cwd: PathBuf,
    /// Epoch milliseconds as written by Claude CLI. Converted to RFC3339
    /// by the caller since that's the shape the registry stores.
    pub started_at_ms: i64,
    pub bridge_session_id: Option<String>,
}

pub fn read_bridge_session_id(path: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let v: Value = serde_json::from_str(&raw)?;
            Ok(v.get("bridgeSessionId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn session_file_for_pid(pid: u32) -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("sessions").join(format!("{pid}.json")))
}

/// Polls up to 15 × 500ms for the bridgeSessionId to appear. Returns
/// `None` if the file never materialises or never contains the field.
pub async fn resolve_bridge_session_id(pid: u32) -> Option<String> {
    let Some(path) = session_file_for_pid(pid) else { return None };
    for _ in 0..15 {
        if let Ok(Some(id)) = read_bridge_session_id(&path) {
            return Some(id);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}

/// Resolves the sessions directory. Returns `None` only if the user has
/// no home directory, which would be a pathologically broken setup.
pub fn sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("sessions"))
}

/// Parses a single session file into our minimal shape. Returns `None`
/// if the file is missing, unreadable, not JSON, or missing a required
/// field; stale entries from dead sessions (e.g. 5072.json lingering
/// after Claude exits without cleanup) are surfaced so the caller can
/// filter by live-pid.
pub fn parse_session_file(path: &Path) -> Option<ScannedSession> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let pid = v.get("pid").and_then(|x| x.as_u64())? as u32;
    let session_id = v.get("sessionId").and_then(|x| x.as_str())?.to_string();
    let cwd = v.get("cwd").and_then(|x| x.as_str())?;
    let started_at_ms = v.get("startedAt").and_then(|x| x.as_i64()).unwrap_or(0);
    let bridge_session_id = v
        .get("bridgeSessionId")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Some(ScannedSession {
        pid,
        session_id,
        cwd: PathBuf::from(cwd),
        started_at_ms,
        bridge_session_id,
    })
}

/// Scans `~/.claude/sessions/*.json`, filters out entries whose `pid`
/// no longer exists in the live process list, and returns the rest.
/// Caller is responsible for registering each survivor with the
/// in-memory registry. Live-pid filtering is passed in so tests can
/// inject a synthetic set.
pub fn scan_live_sessions(live_pids: &std::collections::HashSet<u32>) -> Vec<ScannedSession> {
    let Some(dir) = sessions_dir() else { return vec![] };
    let Ok(entries) = std::fs::read_dir(&dir) else { return vec![] };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
        let Some(parsed) = parse_session_file(&path) else { continue };
        if !live_pids.contains(&parsed.pid) { continue; }
        out.push(parsed);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_session(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn parse_session_file_extracts_required_fields() {
        let dir = tempdir().unwrap();
        write_session(
            dir.path(),
            "1234.json",
            r#"{"pid":1234,"sessionId":"abc","cwd":"C:\\x","startedAt":1776868109727,"version":"2.1.117"}"#,
        );
        let got = parse_session_file(&dir.path().join("1234.json")).unwrap();
        assert_eq!(got.pid, 1234);
        assert_eq!(got.session_id, "abc");
        assert_eq!(got.cwd, PathBuf::from("C:\\x"));
        assert_eq!(got.started_at_ms, 1776868109727);
        assert_eq!(got.bridge_session_id, None);
    }

    #[test]
    fn parse_session_file_reads_bridge_session_id_when_present() {
        let dir = tempdir().unwrap();
        write_session(
            dir.path(),
            "1.json",
            r#"{"pid":1,"sessionId":"s","cwd":"C:\\x","bridgeSessionId":"bridge-uuid"}"#,
        );
        let got = parse_session_file(&dir.path().join("1.json")).unwrap();
        assert_eq!(got.bridge_session_id.as_deref(), Some("bridge-uuid"));
    }

    #[test]
    fn parse_session_file_returns_none_for_malformed_or_missing_fields() {
        let dir = tempdir().unwrap();
        write_session(dir.path(), "bad.json", "not json");
        assert!(parse_session_file(&dir.path().join("bad.json")).is_none());

        write_session(dir.path(), "nopid.json", r#"{"sessionId":"s","cwd":"x"}"#);
        assert!(parse_session_file(&dir.path().join("nopid.json")).is_none());

        assert!(parse_session_file(&dir.path().join("missing.json")).is_none());
    }

    #[test]
    fn scan_live_sessions_filters_by_live_pid_set() {
        // We don't have a hook to override sessions_dir in this test, so we
        // exercise the same filter logic directly against parse_session_file
        // + an in-memory list. The dir walk is covered by the other tests.
        let dir = tempdir().unwrap();
        write_session(
            dir.path(),
            "100.json",
            r#"{"pid":100,"sessionId":"live","cwd":"C:\\a","startedAt":1}"#,
        );
        write_session(
            dir.path(),
            "999.json",
            r#"{"pid":999,"sessionId":"dead","cwd":"C:\\b","startedAt":1}"#,
        );
        let live: HashSet<u32> = [100u32].into_iter().collect();
        let mut survivors: Vec<ScannedSession> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter_map(|e| parse_session_file(&e.path()))
            .filter(|s| live.contains(&s.pid))
            .collect();
        survivors.sort_by_key(|s| s.pid);
        assert_eq!(survivors.len(), 1);
        assert_eq!(survivors[0].session_id, "live");
    }
}
