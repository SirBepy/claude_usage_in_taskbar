//! Piper TTS sidecar manager.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct VoiceEntry {
    pub id: String,
    pub label: String,
    pub installed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct PiperStatus {
    pub installed: bool,
    pub voices: Vec<VoiceEntry>,
}

/// Voice catalog ported from `src/core/piper.js`.
/// (id, label, onnx_url, config_url)
const CATALOG: &[(&str, &str, &str, &str)] = &[
    (
        "en_US-amy-medium",
        "Amy (US Female)",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json",
    ),
    (
        "en_US-ryan-medium",
        "Ryan (US Male)",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium/en_US-ryan-medium.onnx",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium/en_US-ryan-medium.onnx.json",
    ),
    (
        "en_GB-alba-medium",
        "Alba (UK Female)",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx.json",
    ),
    (
        "en_US-lessac-high",
        "Lessac (US, HQ)",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high/en_US-lessac-high.onnx",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high/en_US-lessac-high.onnx.json",
    ),
];

pub fn scan_voices(voices_dir: &Path) -> Vec<VoiceEntry> {
    CATALOG.iter().map(|(id, label, _, _)| {
        let dir = voices_dir.join(id);
        let installed = dir.join("model.onnx").exists() && dir.join("model.onnx.json").exists();
        VoiceEntry { id: (*id).into(), label: (*label).into(), installed }
    }).collect()
}

pub fn piper_binary_exists() -> bool {
    which::which("piper").is_ok()
        || crate::settings::paths::piper_binary_path().ok().map(|p| p.exists()).unwrap_or(false)
}

pub fn status() -> PiperStatus {
    let Ok(voices_dir) = crate::settings::paths::piper_voices_dir() else {
        return PiperStatus { installed: false, voices: vec![] };
    };
    PiperStatus {
        installed: piper_binary_exists(),
        voices: scan_voices(&voices_dir),
    }
}

pub async fn install_voice(id: &str) -> Result<()> {
    let entry = CATALOG.iter().find(|(i, _, _, _)| *i == id)
        .context("unknown voice id")?;
    let dir = crate::settings::paths::piper_voices_dir()?.join(id);
    std::fs::create_dir_all(&dir).context("create voice dir")?;
    download_to(entry.2, &dir.join("model.onnx")).await?;
    download_to(entry.3, &dir.join("model.onnx.json")).await?;
    Ok(())
}

async fn download_to(url: &str, path: &Path) -> Result<()> {
    let bytes = reqwest::get(url).await?.error_for_status()?.bytes().await?;
    std::fs::write(path, &bytes).context("write file")?;
    Ok(())
}

pub async fn synthesize(text: &str, voice_id: &str) -> Result<PathBuf> {
    let voices_dir = crate::settings::paths::piper_voices_dir()?;
    let model = voices_dir.join(voice_id).join("model.onnx");
    if !model.exists() { anyhow::bail!("voice not installed: {voice_id}"); }
    let out = std::env::temp_dir().join(format!("piper-{}.wav", rand::random::<u64>()));
    let binary = crate::settings::paths::piper_binary_path()?;
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new(binary)
        .args(["--model", model.to_str().unwrap(),
               "--output_file", out.to_str().unwrap()])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .context("spawn piper")?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes()).await?;
        stdin.shutdown().await?;
    }
    let status = child.wait().await?;
    if !status.success() { anyhow::bail!("piper exited {status}"); }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn scan_empty_dir_returns_catalog_with_installed_false() {
        let dir = tempdir().unwrap();
        let voices = scan_voices(dir.path());
        assert!(!voices.is_empty());
        assert!(voices.iter().all(|v| !v.installed));
    }

    #[test]
    fn scan_populated_dir_marks_installed_true() {
        let dir = tempdir().unwrap();
        let id = CATALOG[0].0;
        let vd = dir.path().join(id);
        std::fs::create_dir_all(&vd).unwrap();
        std::fs::write(vd.join("model.onnx"), b"x").unwrap();
        std::fs::write(vd.join("model.onnx.json"), b"{}").unwrap();
        let voices = scan_voices(dir.path());
        assert!(voices.iter().find(|v| v.id == id).unwrap().installed);
    }
}
