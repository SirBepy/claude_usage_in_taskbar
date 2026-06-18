//! App-process IPC for the phone remote-access feature: an on/off toggle that
//! runs `tailscale serve` itself (no manual command), plus QR pairing.
//!
//! The daemon owns the actual HTTP server (binds 127.0.0.1:27183) and validates
//! every request against the SHA-256 hash stored in `<app-data>/remote-access.json`.
//! It re-reads that file per request (see `daemon::remote_server::stored_token_hash`),
//! so regenerating the token here takes effect live with no daemon restart.
//!
//! Persistence note (a deliberate security trade-off the user accepted): the
//! plaintext token is also stored in `remote-access.json` under a `"token"`
//! field so the QR can be shown anytime. The daemon keeps validating against the
//! `"hash"` field, which we always write in lockstep.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::settings::{self, paths};
use crate::state::AppState;

// ── Token storage (mirrors daemon::remote_server, plaintext added) ────────────

fn token_file() -> Result<PathBuf, String> {
    Ok(paths::data_dir().map_err(|e| e.to_string())?.join("remote-access.json"))
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Mint a fresh 32-byte hex token. Same scheme as the daemon's `ensure_token`.
fn mint_token() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Write both the hash (what the daemon validates) and the plaintext token (so
/// the QR is reproducible) to `remote-access.json`.
fn write_token(path: &Path, token: &str) -> Result<(), String> {
    let body = serde_json::json!({ "hash": sha256_hex(token), "token": token });
    std::fs::write(path, serde_json::to_string_pretty(&body).unwrap_or_default())
        .map_err(|e| e.to_string())
}

/// Read the current plaintext token from `remote-access.json`, if present.
/// Returns None when remote access has never been provisioned, or when the file
/// predates plaintext persistence (only a hash is stored).
fn read_plaintext_token(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("token").and_then(|t| t.as_str()).map(str::to_string)
}

// ── Tailscale process helpers ─────────────────────────────────────────────────

/// Resolve the tailscale executable: prefer PATH, fall back to the default
/// Windows install location.
fn tailscale_exe() -> PathBuf {
    if let Ok(p) = which::which("tailscale") {
        return p;
    }
    PathBuf::from("C:\\Program Files\\Tailscale\\tailscale.exe")
}

/// Run a tailscale subcommand with output captured, console window suppressed.
/// Returns (stdout, stderr, success).
fn run_tailscale(args: &[&str]) -> Result<(String, String, bool), String> {
    let mut cmd = Command::new(tailscale_exe());
    cmd.args(args);
    crate::util::process::hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("could not run tailscale (is it installed?): {e}"))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.success(),
    ))
}

/// The tailscale-serve enable command. Reverse-proxies the daemon's local
/// remote-access port over the tailnet with Tailscale-managed HTTPS.
const SERVE_TARGET: &str = "http://127.0.0.1:27183";

fn serve_enable() -> Result<(), String> {
    let (_out, err, ok) = run_tailscale(&["serve", "--bg", "--https=443", SERVE_TARGET])?;
    if ok {
        Ok(())
    } else {
        Err(if err.trim().is_empty() {
            "tailscale serve failed (is tailscale connected? try `tailscale up`)".into()
        } else {
            err.trim().to_string()
        })
    }
}

fn serve_disable() -> Result<(), String> {
    // `tailscale serve --https=443 off` removes the 443 proxy. Best-effort: a
    // non-zero exit (e.g. nothing was being served) is not fatal for "turn off".
    let _ = run_tailscale(&["serve", "--https=443", "off"]);
    Ok(())
}

/// The tailnet DNS name for this machine, trailing dot stripped, or None if
/// tailscale is not up / not logged in.
fn tailscale_dnsname() -> Option<String> {
    let (out, _err, ok) = run_tailscale(&["status", "--json"]).ok()?;
    if !ok {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&out).ok()?;
    let name = v.get("Self")?.get("DNSName")?.as_str()?;
    let trimmed = name.trim_end_matches('.');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Best-effort: whether `tailscale serve status` mentions our local target.
fn serve_running() -> bool {
    match run_tailscale(&["serve", "status"]) {
        Ok((out, _err, _ok)) => out.contains(SERVE_TARGET),
        Err(_) => false,
    }
}

// ── Settings persistence ──────────────────────────────────────────────────────

fn persist_enabled(enabled: bool, state: &State<AppState>, app: &AppHandle) {
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        s.remote_access_enabled = enabled;
        s.clone()
    };
    if let Ok(path) = paths::settings_file() {
        let _ = settings::save(&path, &snapshot);
    }
    let _ = app.emit("settings-changed", &snapshot);
}

// ── Public boot helper ────────────────────────────────────────────────────────

/// Re-apply `tailscale serve` on app boot when the persisted flag is on.
/// Best-effort: logs on failure, never panics. Called from `lib.rs` setup.
pub fn reapply_on_boot(enabled: bool) {
    if !enabled {
        return;
    }
    std::thread::spawn(|| match serve_enable() {
        Ok(()) => log::info!("remote-access: re-applied tailscale serve on boot"),
        Err(e) => log::warn!("remote-access: boot re-apply of tailscale serve failed: {e}"),
    });
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct RemoteAccessStatus {
    /// The persisted on/off flag from settings.
    pub enabled: bool,
    /// Whether tailscale is up + logged in (Self.DNSName non-empty).
    pub tailscale_up: bool,
    /// Best-effort: whether `tailscale serve` is proxying our local target.
    pub serve_running: bool,
    /// "https://<dnsname>/" (trailing dot stripped) or None if tailscale not up.
    pub url: Option<String>,
}

/// Toggle remote access. When enabling, runs `tailscale serve --bg --https=443
/// http://127.0.0.1:27183`; when disabling, runs `tailscale serve --https=443
/// off`. Persists the flag either way (even if the serve call fails, so the UI
/// reflects intent and a later boot/retry can re-apply).
#[tauri::command]
pub fn set_remote_access_enabled(
    enabled: bool,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    persist_enabled(enabled, &state, &app);
    if enabled {
        serve_enable()
    } else {
        serve_disable()
    }
}

/// Current remote-access status for the Settings UI.
#[tauri::command]
pub fn remote_access_status(state: State<AppState>) -> RemoteAccessStatus {
    let enabled = state.settings.lock().unwrap().remote_access_enabled;
    let dnsname = tailscale_dnsname();
    RemoteAccessStatus {
        enabled,
        tailscale_up: dnsname.is_some(),
        serve_running: serve_running(),
        url: dnsname.map(|d| format!("https://{d}/")),
    }
}

/// Mint a NEW token, overwriting both hash + plaintext in remote-access.json.
/// Old QRs/tokens stop working once the daemon re-reads the new hash (it reads
/// the file per request, so this is effectively immediate). Returns the new
/// plaintext token.
#[tauri::command]
pub fn regenerate_remote_token() -> Result<String, String> {
    let path = token_file()?;
    let token = mint_token();
    write_token(&path, &token)?;
    Ok(token)
}

/// Build "https://<dnsname>/?token=<plaintext>" and return it rendered as an SVG
/// QR code string. Errors if tailscale is not up or no token exists yet.
#[tauri::command]
pub fn remote_access_qr() -> Result<String, String> {
    use qrcode::render::svg;
    use qrcode::QrCode;

    let dnsname = tailscale_dnsname()
        .ok_or_else(|| "tailscale is not connected (run `tailscale up` first)".to_string())?;
    let path = token_file()?;
    let token = read_plaintext_token(&path)
        .ok_or_else(|| "no remote-access token yet (generate one first)".to_string())?;
    let url = format!("https://{dnsname}/?token={token}");
    let code = QrCode::new(url.as_bytes()).map_err(|e| format!("QR encode failed: {e}"))?;
    let svg = code
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .build();
    Ok(svg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_token_stores_both_hash_and_plaintext() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("remote-access.json");
        let token = "abc123";
        write_token(&path, token).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        // Daemon validates against this hash.
        assert_eq!(v["hash"].as_str().unwrap(), sha256_hex(token));
        // Plaintext persisted so the QR is reproducible.
        assert_eq!(v["token"].as_str().unwrap(), token);
        assert_eq!(read_plaintext_token(&path).unwrap(), token);
    }

    #[test]
    fn read_plaintext_token_none_for_hash_only_legacy_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("remote-access.json");
        // A daemon-written file from before plaintext persistence: hash only.
        std::fs::write(&path, r#"{"hash":"deadbeef"}"#).unwrap();
        assert!(read_plaintext_token(&path).is_none());
    }

    #[test]
    fn mint_token_is_64_hex_chars() {
        let t = mint_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
