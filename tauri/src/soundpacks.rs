//! Sound pack catalog + install/resolution.
//!
//! The static catalog is the source of truth for pack ids and their sounds.
//! Non-bundled packs install to `paths::sound_packs_dir()/<id>/*.mp3`.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PackSound {
    pub id: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SoundPack {
    pub id: String,
    pub label: String,
    pub bundled: bool,
    pub download_url: Option<String>,
    pub sounds: Vec<PackSound>,
    #[serde(default)]
    pub installed: bool,
}

pub fn catalog() -> Vec<SoundPack> {
    vec![
        SoundPack {
            id: "default".into(),
            label: "Default".into(),
            bundled: true,
            download_url: None,
            sounds: (1..=6)
                .map(|n| PackSound { id: format!("sound{n}.mp3"), label: format!("Sound {n}") })
                .collect(),
            installed: true,
        },
        SoundPack {
            id: "peon".into(),
            label: "Peon (Orc)".into(),
            bundled: false,
            download_url: Some(
                "https://github.com/SirBepy/claude_usage_in_taskbar/releases/download/sound-packs-v1/peon.zip".into(),
            ),
            sounds: vec![
                PackSound { id: "work-work.wav".into(),     label: "Work work".into() },
                PackSound { id: "ready.wav".into(),         label: "Ready to work".into() },
                PackSound { id: "yes.wav".into(),           label: "Yes?".into() },
                PackSound { id: "pissed.wav".into(),        label: "Me busy. Leave me alone!".into() },
                PackSound { id: "not-that-kind.wav".into(), label: "Me not that kind of orc!".into() },
                PackSound { id: "complete.wav".into(),      label: "Work complete".into() },
            ],
            installed: false,
        },
    ]
}

/// Resolves the on-disk path for a given (pack, sound), regardless of whether
/// the pack is bundled (default) or downloaded. Returns None if the pack id
/// is unknown.
pub fn sound_path(pack_id: &str, sound_id: &str) -> Option<PathBuf> {
    if pack_id == "default" {
        return crate::paths::sounds_dir().ok().map(|d| d.join(sound_id));
    }
    let catalog = catalog();
    catalog.iter().find(|p| p.id == pack_id)?;
    crate::paths::sound_packs_dir().ok().map(|d| d.join(pack_id).join(sound_id))
}

pub fn is_installed(pack_id: &str) -> bool {
    if pack_id == "default" { return true; }
    let Ok(dir) = crate::paths::sound_packs_dir() else { return false; };
    let p = dir.join(pack_id);
    p.is_dir() && std::fs::read_dir(&p).map(|mut i| i.next().is_some()).unwrap_or(false)
}

pub fn list_with_installed_state() -> Vec<SoundPack> {
    catalog().into_iter().map(|mut p| {
        p.installed = is_installed(&p.id);
        p
    }).collect()
}

/// Download + unzip a pack into `sound_packs_dir/<id>/`. Idempotent: if the
/// pack is already installed, returns Ok without re-downloading.
pub async fn install(pack_id: &str) -> Result<()> {
    if is_installed(pack_id) { return Ok(()); }
    let pack = catalog().into_iter().find(|p| p.id == pack_id)
        .ok_or_else(|| anyhow!("unknown pack id: {pack_id}"))?;
    let url = pack.download_url.ok_or_else(|| anyhow!("pack {pack_id} has no download_url"))?;
    let dest = crate::paths::sound_packs_dir()?.join(pack_id);
    std::fs::create_dir_all(&dest).context("create pack dir")?;
    let bytes = reqwest::get(&url).await?.error_for_status()?.bytes().await?;
    let cursor = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor).context("open zip")?;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        let name = file.enclosed_name()
            .ok_or_else(|| anyhow!("zip entry with invalid path"))?
            .to_owned();
        if file.is_dir() { continue; }
        let out = dest.join(name.file_name().ok_or_else(|| anyhow!("zip entry had no filename"))?);
        let mut w = std::fs::File::create(&out).context("create pack file")?;
        std::io::copy(&mut file, &mut w).context("write pack file")?;
    }
    Ok(())
}

/// Returns a data URL the frontend `<audio>` tag can play, or None if
/// unknown/missing. Uses base64 to avoid configuring the asset protocol.
pub fn file_data_url(pack: &str, sound: &str) -> Option<String> {
    let path = sound_path(pack, sound)?;
    if !path.exists() { return None; }
    let bytes = std::fs::read(&path).ok()?;
    let mime = mime_from_filename(sound);
    let b64 = base64_encode(&bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

fn mime_from_filename(name: &str) -> &'static str {
    if name.ends_with(".mp3") { "audio/mpeg" }
    else if name.ends_with(".wav") { "audio/wav" }
    else if name.ends_with(".ogg") { "audio/ogg" }
    else if name.ends_with(".flac") { "audio/flac" }
    else { "application/octet-stream" }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_contains_default_pack() {
        let c = catalog();
        let def = c.iter().find(|p| p.id == "default").unwrap();
        assert!(def.bundled);
        assert_eq!(def.sounds.len(), 6);
    }

    #[test]
    fn catalog_contains_peon_pack_not_bundled() {
        let peon = catalog().into_iter().find(|p| p.id == "peon").unwrap();
        assert!(!peon.bundled);
        assert!(peon.download_url.is_some());
        assert!(!peon.sounds.is_empty());
    }

    #[test]
    fn sound_path_for_unknown_pack_returns_none() {
        assert!(sound_path("bogus", "x.mp3").is_none());
    }

    #[test]
    fn sound_path_for_default_pack_points_to_bundled_sounds() {
        let p = sound_path("default", "sound1.mp3").unwrap();
        assert!(p.to_string_lossy().ends_with("sound1.mp3"));
    }
}
