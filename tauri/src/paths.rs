//! Resolves on-disk paths for app data (settings, history, session).

use anyhow::{anyhow, Result};
use std::path::PathBuf;

/// Returns the directory where we store everything: settings, history, session.
/// On Windows this is `%APPDATA%\claude-usage-tauri`.
pub fn data_dir() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| anyhow!("could not resolve user config dir"))?;
    Ok(base.join("claude-usage-tauri"))
}

pub fn settings_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("settings.json"))
}

pub fn history_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("history.jsonl"))
}

pub fn session_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("session.txt"))
}

pub fn token_history_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("token-history.json"))
}

pub fn sounds_dir() -> anyhow::Result<std::path::PathBuf> {
    // In dev: tauri/assets/sounds. In bundle: resource dir beside the exe.
    let exe = std::env::current_exe()?;
    let bundled = exe.parent().map(|p| p.join("resources").join("assets").join("sounds"));
    if let Some(p) = bundled.filter(|p| p.exists()) { return Ok(p); }
    // Dev fallback:
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    Ok(manifest.join("assets").join("sounds"))
}

/// Ensures the data directory exists. Idempotent.
pub fn ensure_data_dir() -> Result<PathBuf> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn piper_voices_dir() -> anyhow::Result<std::path::PathBuf> {
    let d = ensure_data_dir()?;
    let p = d.join("piper").join("voices");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn log_file() -> anyhow::Result<std::path::PathBuf> {
    let d = ensure_data_dir()?;
    let p = d.join("logs");
    std::fs::create_dir_all(&p).ok();
    Ok(p.join("claude-usage-tauri.log"))
}

/// Target-triple suffix Tauri appends to sidecar binaries at build and bundle
/// time. Matches the `externalBin` convention in `tauri.conf.json`, where
/// `binaries/piper/piper` expands to `piper-<triple><ext>` on disk both in
/// `target/<profile>/` (dev) and next to the app exe (release bundle).
fn piper_sidecar_name() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "piper-x86_64-pc-windows-msvc.exe"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "piper-aarch64-pc-windows-msvc.exe"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "piper-x86_64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "piper-aarch64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "piper-x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "piper-aarch64-unknown-linux-gnu"
    } else if cfg!(windows) {
        "piper.exe"
    } else {
        "piper"
    }
}

pub fn piper_binary_path() -> anyhow::Result<std::path::PathBuf> {
    let exe = std::env::current_exe()?;
    let parent = exe.parent().ok_or_else(|| anyhow::anyhow!("no exe parent"))?;
    Ok(parent.join(piper_sidecar_name()))
}
