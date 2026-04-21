# Per-project notifications + sound packs implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add downloadable character-themed sound packs and let each project override notification config per event.

**Architecture:** Extend existing `NotificationRule` with a `sound_pack` field. Introduce a new `projectNotifOverrides` settings map keyed by cwd. Add a pure `resolve_notif_config(cwd_key, event) -> NotificationRule` in the Rust backend; notification callsites pass cwd through. Sound packs live in `<app-data>/sound-packs/<id>/`, downloaded on demand via a new Tauri command. Default pack uses the existing bundled `assets/sounds/`. Frontend uses a two-step Pack+Sound picker in the Notifications subpage and mirrors the same picker under a per-event "Override?" toggle on each project's detail page.

**Tech Stack:** Rust (Tauri 2), vanilla JS frontend (no bundler), vitest for JS tests, `cargo test` for Rust.

---

## File structure

**Rust backend (all in `tauri/src/`):**

| File | Responsibility | Action |
|---|---|---|
| `icon_settings.rs` | `NotificationRule` shape + per-event parser | Modify: add `sound_pack: String` |
| `project_overrides.rs` | New: types + parser for `projectNotifOverrides` | Create |
| `notifications.rs` | `fire()` + new `resolve_notif_config()` resolver | Modify |
| `soundpacks.rs` | Pack catalog, install, path resolution | Create |
| `paths.rs` | Add `sound_packs_dir()` | Modify |
| `audio.rs` | Pack-aware file resolution | Modify |
| `ipc.rs` | Register new Tauri commands | Modify |
| `lib.rs` | Wire new module into `invoke_handler` | Modify |
| `hook_server.rs` | Pass cwd into `fire()` | Modify |
| `scheduler.rs` | Pass cwd into `fire()` (can be `None` for global) | Modify |

**Frontend (all in `tauri/dist/`):**

| File | Responsibility | Action |
|---|---|---|
| `modules/sound-packs.js` | Pack catalog + dropdown population helpers | Create |
| `modules/settings.js` | Two-step picker wiring, sound pack install flow | Modify |
| `modules/stats.js` | Project detail page: render overrides section | Modify |
| `dashboard.html` | Markup for Pack+Sound picker + project overrides block | Modify |
| `dashboard.css` | Minor styles for install button / override block | Modify |
| `electron-api-shim.js` | Expose new Tauri commands to renderer | Modify |

**Tests:**

| File | Action |
|---|---|
| `tauri/src/notifications.rs` (inline `#[cfg(test)]`) | Resolver tests |
| `tauri/src/project_overrides.rs` (inline) | Parser tests |
| `tauri/src/soundpacks.rs` (inline) | Catalog + install idempotency tests |
| `tauri/tests/sound_packs_install.rs` | Integration test using `tempdir` |
| `tauri/tests/settings_overrides_parse.test.mjs` | JS: settings round-trip preserves overrides |
| `tauri/tests/notif_picker.test.mjs` | JS: two-step picker + override toggle |

---

## Task 1: Extend `NotificationRule` with `sound_pack`

**Files:**
- Modify: `tauri/src/icon_settings.rs`

- [ ] **Step 1: Add the field to the struct**

Edit `tauri/src/icon_settings.rs`, update `NotificationRule`:

```rust
#[derive(Clone, Debug, PartialEq)]
pub struct NotificationRule {
    pub enabled: bool,
    pub mode: NotifMode,
    pub sound_pack: String,
    pub sound_file: String,
    pub voice_name: Option<String>,
    pub template: String,
}
```

- [ ] **Step 2: Update `NotificationsConfig::default()` to set `sound_pack: "default"` on all 3 rules**

In the same file, replace the entire body of `NotificationsConfig::default()`:

```rust
impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            work_finished: NotificationRule {
                enabled: true, mode: NotifMode::Sound,
                sound_pack: "default".into(),
                sound_file: "sound1.mp3".into(), voice_name: None,
                template: "{name} is done".into(),
            },
            question_asked: NotificationRule {
                enabled: true, mode: NotifMode::Sound,
                sound_pack: "default".into(),
                sound_file: "sound3.mp3".into(), voice_name: None,
                template: "{name} is waiting".into(),
            },
            threshold_crossed: NotificationRule {
                enabled: true, mode: NotifMode::Sound,
                sound_pack: "default".into(),
                sound_file: "sound6.mp3".into(), voice_name: None,
                template: "{percent} threshold reached".into(),
            },
        }
    }
}
```

- [ ] **Step 3: Update `rule_from` parser to read `soundPack` with legacy fallback**

Replace the body of `rule_from`:

```rust
fn rule_from(m: &serde_json::Map<String, Value>, defaults: NotificationRule) -> NotificationRule {
    NotificationRule {
        enabled: val_bool(m.get("enabled")).unwrap_or(defaults.enabled),
        mode: parse_enum(m.get("mode"), &[
            ("sound", NotifMode::Sound),
            ("voice", NotifMode::Voice),
        ]),
        sound_pack: val_str(m.get("soundPack"))
            .map(String::from)
            .unwrap_or_else(|| "default".into()), // migrates legacy rules
        sound_file: val_str(m.get("soundFile")).map(String::from).unwrap_or(defaults.sound_file),
        voice_name: val_str(m.get("voiceName")).map(String::from),
        template: val_str(m.get("template")).map(String::from).unwrap_or(defaults.template),
    }
}
```

- [ ] **Step 4: Add a test for legacy migration**

Append to the existing `#[cfg(test)] mod tests` in `icon_settings.rs`:

```rust
#[test]
fn notif_rule_legacy_without_sound_pack_maps_to_default() {
    let s = settings_with(json!({
        "notifications": {
            "workFinished": { "enabled": true, "mode": "sound", "soundFile": "sound1.mp3" }
        }
    }));
    let cfg = NotificationsConfig::try_from(&s).unwrap();
    assert_eq!(cfg.work_finished.sound_pack, "default");
    assert_eq!(cfg.work_finished.sound_file, "sound1.mp3");
}

#[test]
fn notif_rule_reads_explicit_sound_pack() {
    let s = settings_with(json!({
        "notifications": {
            "workFinished": { "mode": "sound", "soundPack": "peon", "soundFile": "work-work.mp3" }
        }
    }));
    let cfg = NotificationsConfig::try_from(&s).unwrap();
    assert_eq!(cfg.work_finished.sound_pack, "peon");
    assert_eq!(cfg.work_finished.sound_file, "work-work.mp3");
}
```

- [ ] **Step 5: Run tests**

Run: `cargo test --manifest-path tauri/Cargo.toml icon_settings::tests`
Expected: all tests pass (including the two new ones)

- [ ] **Step 6: Commit**

```bash
git add tauri/src/icon_settings.rs
git commit -m "FEAT: add sound_pack field to NotificationRule with legacy-default fallback"
```

---

## Task 2: `paths::sound_packs_dir()`

**Files:**
- Modify: `tauri/src/paths.rs`

- [ ] **Step 1: Add function**

Append to `tauri/src/paths.rs`:

```rust
pub fn sound_packs_dir() -> anyhow::Result<std::path::PathBuf> {
    let d = ensure_data_dir()?;
    let p = d.join("sound-packs");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}
```

- [ ] **Step 2: Commit**

```bash
git add tauri/src/paths.rs
git commit -m "FEAT: add sound_packs_dir path helper"
```

---

## Task 3: Sound pack catalog + install (Rust)

**Files:**
- Create: `tauri/src/soundpacks.rs`

- [ ] **Step 1: Write failing tests first**

Create `tauri/src/soundpacks.rs`:

```rust
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
                PackSound { id: "work-work.mp3".into(),     label: "Work work".into() },
                PackSound { id: "ready.mp3".into(),         label: "Ready to work".into() },
                PackSound { id: "yes.mp3".into(),           label: "Yes?".into() },
                PackSound { id: "pissed.mp3".into(),        label: "Me busy. Leave me alone!".into() },
                PackSound { id: "not-that-kind.mp3".into(), label: "Me not that kind of orc!".into() },
                PackSound { id: "complete.mp3".into(),      label: "Work complete".into() },
            ],
            installed: false,
        },
        // peasant, acolyte, wisp are placeholders - add when clips are finalised
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
    // Installed = directory exists and has at least one file
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
```

- [ ] **Step 2: Add zip dependency**

Edit `tauri/Cargo.toml`, add under `[dependencies]`:

```toml
zip = { version = "2", default-features = false, features = ["deflate"] }
```

- [ ] **Step 3: Register module in lib.rs**

Edit `tauri/src/lib.rs`, add in the `mod` declarations (near `mod notifications;`):

```rust
mod soundpacks;
```

- [ ] **Step 4: Run tests to verify the unit tests pass**

Run: `cargo test --manifest-path tauri/Cargo.toml soundpacks`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tauri/src/soundpacks.rs tauri/src/lib.rs tauri/Cargo.toml tauri/Cargo.lock
git commit -m "FEAT: add sound pack catalog with install and path resolution"
```

---

## Task 4: Integration test for pack install

**Files:**
- Create: `tauri/tests/sound_packs_install.rs`

- [ ] **Step 1: Write the test**

Create `tauri/tests/sound_packs_install.rs`:

```rust
//! Idempotency of install() using a pre-populated sound-packs dir.
//! We don't hit the network; we simulate "already installed" by creating
//! the expected dir+file and confirm install() is a no-op.

use claude_usage_tauri::{paths, soundpacks};
use std::fs;

#[test]
fn install_skips_when_already_installed() {
    // Prepare: ensure peon dir exists with one file.
    let dir = paths::sound_packs_dir().expect("sound packs dir");
    let pack_dir = dir.join("peon");
    fs::create_dir_all(&pack_dir).unwrap();
    fs::write(pack_dir.join("work-work.mp3"), b"fake").unwrap();
    assert!(soundpacks::is_installed("peon"));

    // install() must not fail or touch the directory.
    let before = fs::metadata(&pack_dir).unwrap().modified().ok();
    tauri::async_runtime::block_on(soundpacks::install("peon")).unwrap();
    let after = fs::metadata(&pack_dir).unwrap().modified().ok();
    assert_eq!(before, after);

    // Cleanup
    fs::remove_dir_all(&pack_dir).ok();
}
```

- [ ] **Step 2: Expose crate name / items**

Verify the crate name in `tauri/Cargo.toml` — the `[lib]` section's `name` is what integration tests import. If it's `claude_usage_tauri`, the test above is correct. If different, adjust.

Run: `grep -E '^name ?=' tauri/Cargo.toml`

- [ ] **Step 3: Run the test**

Run: `cargo test --manifest-path tauri/Cargo.toml --test sound_packs_install`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add tauri/tests/sound_packs_install.rs
git commit -m "TEST: sound pack install is idempotent"
```

---

## Task 5: Project overrides type + parser

**Files:**
- Create: `tauri/src/project_overrides.rs`

- [ ] **Step 1: Write module + tests**

Create `tauri/src/project_overrides.rs`:

```rust
//! Typed view over `Settings.extra["projectNotifOverrides"]`.
//!
//! Shape (keyed by normalised cwd):
//! {
//!   "<cwdKey>": {
//!     "workFinished":     { enabled, mode, soundPack, soundFile, voiceName, template },
//!     "questionAsked":    { ... },
//!     "thresholdCrossed": { ... }
//!   }
//! }
//!
//! The individual rule parser is shared with `icon_settings::rule_from`, but
//! override rules differ in one way: their `enabled` field means "this
//! override is active", not "the notification itself fires". When `enabled`
//! is false, we treat the whole rule as absent (inherit default).

use crate::icon_settings::NotificationRule;
use crate::types::Settings;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectOverrides {
    pub work_finished:     Option<NotificationRule>,
    pub question_asked:    Option<NotificationRule>,
    pub threshold_crossed: Option<NotificationRule>,
}

fn parse_rule(v: &Value, defaults: NotificationRule) -> Option<NotificationRule> {
    let m = v.as_object()?;
    // Override rule must be explicitly enabled, else treat as absent.
    let enabled = m.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false);
    if !enabled { return None; }
    let rule = crate::icon_settings::rule_from_public(m, defaults);
    Some(rule)
}

pub fn parse(s: &Settings) -> HashMap<String, ProjectOverrides> {
    let defaults = crate::icon_settings::NotificationsConfig::default();
    let Some(obj) = s.extra.get("projectNotifOverrides").and_then(|v| v.as_object()) else {
        return HashMap::new();
    };
    obj.iter().filter_map(|(key, val)| {
        let m = val.as_object()?;
        Some((key.clone(), ProjectOverrides {
            work_finished:     m.get("workFinished")
                .and_then(|v| parse_rule(v, defaults.work_finished.clone())),
            question_asked:    m.get("questionAsked")
                .and_then(|v| parse_rule(v, defaults.question_asked.clone())),
            threshold_crossed: m.get("thresholdCrossed")
                .and_then(|v| parse_rule(v, defaults.threshold_crossed.clone())),
        }))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings_with(extra: serde_json::Value) -> Settings {
        let mut s = Settings::default();
        s.extra = extra.as_object().unwrap().clone();
        s
    }

    #[test]
    fn absent_field_returns_empty_map() {
        let s = Settings::default();
        assert!(parse(&s).is_empty());
    }

    #[test]
    fn override_with_enabled_false_is_ignored() {
        let s = settings_with(json!({
            "projectNotifOverrides": {
                "C:/proj": {
                    "workFinished": { "enabled": false, "mode": "sound", "soundPack": "peon", "soundFile": "x.mp3" }
                }
            }
        }));
        let map = parse(&s);
        assert!(map.get("C:/proj").unwrap().work_finished.is_none());
    }

    #[test]
    fn override_with_enabled_true_parses_pack_and_file() {
        let s = settings_with(json!({
            "projectNotifOverrides": {
                "C:/proj": {
                    "thresholdCrossed": {
                        "enabled": true, "mode": "sound",
                        "soundPack": "peon", "soundFile": "work-work.mp3"
                    }
                }
            }
        }));
        let map = parse(&s);
        let rule = map.get("C:/proj").unwrap().threshold_crossed.as_ref().unwrap();
        assert_eq!(rule.sound_pack, "peon");
        assert_eq!(rule.sound_file, "work-work.mp3");
    }
}
```

- [ ] **Step 2: Expose `rule_from` as `rule_from_public`**

In `tauri/src/icon_settings.rs`, below the existing `rule_from`, add:

```rust
pub fn rule_from_public(m: &serde_json::Map<String, Value>, defaults: NotificationRule) -> NotificationRule {
    rule_from(m, defaults)
}
```

- [ ] **Step 3: Wire module in `lib.rs`**

Edit `tauri/src/lib.rs`, add:

```rust
mod project_overrides;
```

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path tauri/Cargo.toml project_overrides`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tauri/src/project_overrides.rs tauri/src/icon_settings.rs tauri/src/lib.rs
git commit -m "FEAT: add project_overrides parser with enabled-gated override rules"
```

---

## Task 6: Resolver in `notifications.rs`

**Files:**
- Modify: `tauri/src/notifications.rs`

- [ ] **Step 1: Add resolver + test**

Edit `tauri/src/notifications.rs`. At the top, add an import:

```rust
use crate::project_overrides::{self, ProjectOverrides};
```

Add a helper under `project_name_from_cwd`:

```rust
/// Resolves the active notification rule for this event + project.
/// Returns the project-specific override if one is enabled, else the global default.
pub fn resolve_notif_config(
    cfg: &crate::icon_settings::NotificationsConfig,
    overrides: &std::collections::HashMap<String, ProjectOverrides>,
    kind: NotifKind,
    cwd_key: Option<&str>,
) -> crate::icon_settings::NotificationRule {
    let default_rule = match kind {
        NotifKind::WorkFinished     => cfg.work_finished.clone(),
        NotifKind::QuestionAsked    => cfg.question_asked.clone(),
        NotifKind::ThresholdCrossed => cfg.threshold_crossed.clone(),
    };
    let Some(key) = cwd_key else { return default_rule; };
    let Some(po) = overrides.get(key) else { return default_rule; };
    let override_rule = match kind {
        NotifKind::WorkFinished     => po.work_finished.clone(),
        NotifKind::QuestionAsked    => po.question_asked.clone(),
        NotifKind::ThresholdCrossed => po.threshold_crossed.clone(),
    };
    override_rule.unwrap_or(default_rule)
}
```

Add tests at the bottom of the `#[cfg(test)] mod tests`:

```rust
#[test]
fn resolver_returns_default_when_no_cwd() {
    use crate::icon_settings::NotificationsConfig;
    use std::collections::HashMap;
    let cfg = NotificationsConfig::default();
    let rule = resolve_notif_config(&cfg, &HashMap::new(), NotifKind::WorkFinished, None);
    assert_eq!(rule.sound_file, "sound1.mp3");
    assert_eq!(rule.sound_pack, "default");
}

#[test]
fn resolver_returns_default_when_project_has_no_override() {
    use crate::icon_settings::NotificationsConfig;
    use std::collections::HashMap;
    let cfg = NotificationsConfig::default();
    let rule = resolve_notif_config(&cfg, &HashMap::new(), NotifKind::WorkFinished, Some("C:/x"));
    assert_eq!(rule.sound_file, "sound1.mp3");
}

#[test]
fn resolver_returns_override_when_enabled() {
    use crate::icon_settings::{NotificationsConfig, NotifMode, NotificationRule};
    use crate::project_overrides::ProjectOverrides;
    use std::collections::HashMap;
    let cfg = NotificationsConfig::default();
    let mut map = HashMap::new();
    map.insert("C:/proj".into(), ProjectOverrides {
        work_finished: Some(NotificationRule {
            enabled: true, mode: NotifMode::Sound,
            sound_pack: "peon".into(), sound_file: "work-work.mp3".into(),
            voice_name: None, template: "".into(),
        }),
        ..Default::default()
    });
    let rule = resolve_notif_config(&cfg, &map, NotifKind::WorkFinished, Some("C:/proj"));
    assert_eq!(rule.sound_pack, "peon");
    assert_eq!(rule.sound_file, "work-work.mp3");
}
```

- [ ] **Step 2: Update `fire()` to take cwd and use resolver**

Replace the current `fire()` body:

```rust
pub fn fire(app: &AppHandle, kind: NotifKind, ctx: NotifContext, cwd_key: Option<&str>) {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    let cfg: crate::icon_settings::NotificationsConfig = (&settings).try_into().unwrap_or_default();
    let overrides = project_overrides::parse(&settings);
    let rule = resolve_notif_config(&cfg, &overrides, kind, cwd_key);
    if !rule.enabled { return; }
    match rule.mode {
        NotifMode::Sound => audio::play_pack_sound(app, &rule.sound_pack, &rule.sound_file),
        NotifMode::Voice => {
            let text = render_template(&rule.template, &ctx);
            if text.is_empty() { return; }
            speak(app, &text, rule.voice_name.as_deref());
        }
    }
}
```

Note the signature change: added `cwd_key: Option<&str>`. Note the audio call is renamed to `play_pack_sound` — Task 7 implements it.

- [ ] **Step 3: Run tests (they'll fail on play_pack_sound — expected until Task 7)**

Run: `cargo test --manifest-path tauri/Cargo.toml notifications`
Expected: tests for resolver pass; build fails or test excludes the audio call. If build fails, that's expected — move to Task 7 before committing.

- [ ] **Step 4: Proceed to Task 7, then commit both together.**

---

## Task 7: Audio pack-aware resolution

**Files:**
- Modify: `tauri/src/audio.rs`

- [ ] **Step 1: Add `play_pack_sound`**

Read the existing `play_sound_file` in `tauri/src/audio.rs` (the method signature and how it reads from `sounds_dir`). Then add below it:

```rust
/// Play a sound from a named pack. Pack "default" uses the bundled
/// `sounds_dir()`, all others use `sound_packs_dir()/<pack>/`.
/// Falls back silently if the file is missing (pack uninstalled).
pub fn play_pack_sound(app: &tauri::AppHandle, pack: &str, file: &str) {
    let Some(path) = crate::soundpacks::sound_path(pack, file) else {
        log::warn!("play_pack_sound: unknown pack {pack}");
        return;
    };
    if !path.exists() {
        log::warn!("play_pack_sound: missing file {path:?} (pack {pack} not installed?)");
        return;
    }
    play_file(app, &path);
}
```

If `play_sound_file` takes a filename (not a path), factor out a `play_file(app, path: &Path)` helper that both use. If it already takes a path, just delegate.

- [ ] **Step 2: Build + test**

Run: `cargo build --manifest-path tauri/Cargo.toml`
Expected: compiles.

Run: `cargo test --manifest-path tauri/Cargo.toml notifications`
Expected: the 3 new resolver tests pass.

- [ ] **Step 3: Commit Task 6 + 7 together**

```bash
git add tauri/src/notifications.rs tauri/src/audio.rs
git commit -m "FEAT: resolve per-project notif overrides and play pack sounds"
```

---

## Task 8: Pipe cwd into `fire()` call sites

**Files:**
- Modify: `tauri/src/hook_server.rs`
- Modify: `tauri/src/scheduler.rs`

- [ ] **Step 1: Update `hook_server.rs` on_refresh call**

Find the `fire` call in `on_refresh` around line 57. Change:

```rust
crate::notifications::fire(
    &ctx.app,
    crate::notifications::NotifKind::WorkFinished,
    crate::notifications::NotifContext { name, percent: None },
    payload.cwd.as_deref(),
);
```

- [ ] **Step 2: Update `hook_server.rs` on_notify call**

Around line 116:

```rust
crate::notifications::fire(
    &ctx.app,
    crate::notifications::NotifKind::QuestionAsked,
    crate::notifications::NotifContext { name, percent: None },
    payload.cwd.as_deref(),
);
```

- [ ] **Step 3: Update `scheduler.rs` threshold call**

Around line 164. Threshold events have no project context — pass `None`:

```rust
crate::notifications::fire(
    &ctx.app,
    crate::notifications::NotifKind::ThresholdCrossed,
    crate::notifications::NotifContext { percent: Some(pct), name: None },
    None,
);
```

- [ ] **Step 4: Build to verify**

Run: `cargo build --manifest-path tauri/Cargo.toml`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add tauri/src/hook_server.rs tauri/src/scheduler.rs
git commit -m "FEAT: pass cwd into notification fire for per-project override lookup"
```

---

## Task 9: Tauri commands for sound pack list + install

**Files:**
- Modify: `tauri/src/ipc.rs`
- Modify: `tauri/src/lib.rs`

- [ ] **Step 1: Add commands in `ipc.rs`**

Read `tauri/src/ipc.rs` first to understand the command pattern. Add at the bottom of the file:

```rust
#[tauri::command]
pub fn list_sound_packs() -> Vec<crate::soundpacks::SoundPack> {
    crate::soundpacks::list_with_installed_state()
}

#[tauri::command]
pub async fn install_sound_pack(pack_id: String) -> Result<(), String> {
    crate::soundpacks::install(&pack_id).await.map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register in `lib.rs` invoke_handler**

Locate the `generate_handler!` macro call in `tauri/src/lib.rs`. Add both commands:

```rust
// inside tauri::generate_handler![ ... ]
ipc::list_sound_packs,
ipc::install_sound_pack,
```

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path tauri/Cargo.toml`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add tauri/src/ipc.rs tauri/src/lib.rs
git commit -m "FEAT: expose list_sound_packs and install_sound_pack commands"
```

---

## Task 10: Frontend sound pack catalog module

**Files:**
- Create: `tauri/dist/modules/sound-packs.js`

- [ ] **Step 1: Create module**

Create `tauri/dist/modules/sound-packs.js`:

```javascript
// Sound pack UI helpers. The authoritative catalog lives in Rust
// (soundpacks::catalog). We fetch it lazily and cache.

let packCache = null;

export async function loadPacks() {
  if (packCache) return packCache;
  try {
    packCache = await window.electronAPI.listSoundPacks();
  } catch (e) {
    console.error("[sound-packs] list failed", e);
    packCache = [];
  }
  return packCache;
}

export function invalidateCache() { packCache = null; }

export function findPack(packs, id) {
  return packs.find(p => p.id === id) || null;
}

export function findSound(pack, soundId) {
  return pack?.sounds.find(s => s.id === soundId) || null;
}

export function populatePackSelect(selectEl, packs, currentPackId) {
  selectEl.innerHTML = packs.map(p => {
    const label = p.installed ? p.label : `${p.label} (not installed)`;
    const sel = p.id === currentPackId ? " selected" : "";
    return `<option value="${p.id}"${sel}>${label}</option>`;
  }).join("");
}

export function populateSoundSelect(selectEl, pack, currentSoundId) {
  if (!pack || !pack.sounds) { selectEl.innerHTML = ""; return; }
  selectEl.innerHTML = pack.sounds.map(s => {
    const sel = s.id === currentSoundId ? " selected" : "";
    return `<option value="${s.id}"${sel}>${s.label}</option>`;
  }).join("");
}

export async function installPack(packId) {
  await window.electronAPI.installSoundPack(packId);
  invalidateCache();
  return loadPacks();
}
```

- [ ] **Step 2: Expose commands in the Tauri shim**

Read `tauri/dist/electron-api-shim.js`. Add to the shim:

```javascript
listSoundPacks: () => window.__TAURI__.core.invoke("list_sound_packs"),
installSoundPack: (packId) => window.__TAURI__.core.invoke("install_sound_pack", { packId }),
```

- [ ] **Step 3: Commit**

```bash
git add tauri/dist/modules/sound-packs.js tauri/dist/electron-api-shim.js
git commit -m "FEAT: frontend sound-packs module and Tauri shim commands"
```

---

## Task 11: Two-step picker in defaults (Notifications subpage)

**Files:**
- Modify: `tauri/dist/dashboard.html`
- Modify: `tauri/dist/modules/settings.js`

- [ ] **Step 1: Update the notif card template**

In `tauri/dist/dashboard.html`, find the `<template id="notifCardTemplate">` block. Replace the `.notif-sound-row` div (around line 352):

```html
<div class="option notif-sound-row" style="display:none">
    <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Sound</span>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
        <select class="notif-sound-pack"></select>
        <select class="notif-sound-file"></select>
        <button class="btn-secondary notif-pack-install" style="display:none;padding:3px 10px;font-size:0.8rem">Install</button>
        <button class="btn-secondary notif-sound-preview" style="padding:3px 10px;font-size:0.8rem">▶</button>
    </div>
</div>
```

Note: removed the hardcoded `<option>` elements from `.notif-sound-file` and added `.notif-sound-pack` and `.notif-pack-install` siblings.

- [ ] **Step 2: Wire in `settings.js`**

Edit `tauri/dist/modules/settings.js`. At the top, add:

```javascript
import {
  loadPacks, findPack, populatePackSelect, populateSoundSelect, installPack
} from "./sound-packs.js";
```

(If the module isn't using ES modules, use a global on `window` instead — check the file's existing pattern.)

In `buildNotifCards`, inside the per-card setup loop, add to the `notifCards[t.key] = { ... }` object:

```javascript
soundPack: node.querySelector(".notif-sound-pack"),
packInstall: node.querySelector(".notif-pack-install"),
```

Replace the body of `renderNotifCard`:

```javascript
async function renderNotifCard(type, cfg) {
  const c = notifCards[type];
  if (!c) return;
  const def = NOTIF_TYPES.find(n => n.key === type);
  c.enabled.checked = cfg.enabled !== false;
  const mode = cfg.mode === "voice" ? "voice" : "sound";
  c.modes.forEach(r => { r.checked = r.value === mode; });

  const packs = await loadPacks();
  const currentPack = cfg.soundPack || "default";
  const currentSound = cfg.soundFile || def.defaultSound;
  populatePackSelect(c.soundPack, packs, currentPack);
  const pack = findPack(packs, currentPack);
  populateSoundSelect(c.soundFile, pack, currentSound);
  c.packInstall.style.display = (pack && !pack.installed) ? "inline-block" : "none";

  c.template.value = cfg.template || def.defaultTemplate;
  if (cfg.voiceName) c.voiceSelect.dataset.desired = cfg.voiceName;
  populateVoiceSelect(c.voiceSelect, cfg.voiceName || null);
  applyNotifCardVisibility(type);
}
```

In `wireNotifCard`, add handlers for the new selects and install button:

```javascript
c.soundPack.addEventListener("change", async () => {
  const packs = await loadPacks();
  const pack = findPack(packs, c.soundPack.value);
  populateSoundSelect(c.soundFile, pack, pack?.sounds[0]?.id);
  c.packInstall.style.display = (pack && !pack.installed) ? "inline-block" : "none";
  saveSettings();
});
c.packInstall.addEventListener("click", async () => {
  c.packInstall.disabled = true;
  c.packInstall.textContent = "Installing...";
  try {
    const packs = await installPack(c.soundPack.value);
    const pack = findPack(packs, c.soundPack.value);
    populatePackSelect(c.soundPack, packs, c.soundPack.value);
    populateSoundSelect(c.soundFile, pack, c.soundFile.value);
    c.packInstall.style.display = "none";
  } catch (e) {
    console.error("[pack install] failed", e);
    alert("Sound pack install failed. See console.");
  } finally {
    c.packInstall.disabled = false;
    c.packInstall.textContent = "Install";
  }
});
```

Update `gatherNotifSettings` to include `soundPack`:

```javascript
out[t.key] = {
  enabled: c.enabled.checked,
  mode,
  soundPack: c.soundPack.value || "default",
  soundFile: c.soundFile.value,
  voiceName: c.voiceSelect.value || c.voiceSelect.dataset.desired || null,
  template: c.template.value || def.defaultTemplate,
};
```

Update the sound-preview click to use the pack-aware URL (see Task 14 for URL resolution — for now just play from the default pack path if pack=default, else compute `<app-data>/sound-packs/<pack>/<file>` via a new `soundPackUrl` shim command). Simplest fix for now:

```javascript
c.soundPreview.onclick = async () => {
  const url = await window.electronAPI.soundPackFileUrl(c.soundPack.value, c.soundFile.value);
  if (url) new Audio(url).play().catch(() => {});
};
```

- [ ] **Step 3: Manual test**

Run: `npm --prefix tauri run tauri dev` (or equivalent dev command)
Verify: Notifications subpage renders two dropdowns. Default pack shows 6 sounds. Peon pack shows "not installed" + Install button.

- [ ] **Step 4: Commit**

```bash
git add tauri/dist/dashboard.html tauri/dist/modules/settings.js
git commit -m "FEAT: two-step pack+sound picker in default notifications UI"
```

---

## Task 12: `sound_pack_file_url` command

**Files:**
- Modify: `tauri/src/soundpacks.rs`
- Modify: `tauri/src/ipc.rs`
- Modify: `tauri/src/lib.rs`
- Modify: `tauri/dist/electron-api-shim.js`

- [ ] **Step 1: Add helper in `soundpacks.rs`**

Append:

```rust
/// Returns a URL the frontend `<audio>` tag can play, or None if unknown/missing.
/// Uses the Tauri asset protocol so we never expose raw file paths.
pub fn file_url(app: &tauri::AppHandle, pack: &str, sound: &str) -> Option<String> {
    let path = sound_path(pack, sound)?;
    if !path.exists() { return None; }
    use tauri::Manager;
    app.asset_protocol_scope().allow_file(&path).ok()?;
    Some(format!("asset://localhost/{}", urlencoding::encode(&path.to_string_lossy())))
}
```

Add `urlencoding = "2"` to `tauri/Cargo.toml` dependencies.

- [ ] **Step 2: Add command**

In `tauri/src/ipc.rs`:

```rust
#[tauri::command]
pub fn sound_pack_file_url(app: tauri::AppHandle, pack: String, sound: String) -> Option<String> {
    crate::soundpacks::file_url(&app, &pack, &sound)
}
```

Register in `lib.rs` inside `generate_handler![...]`:

```rust
ipc::sound_pack_file_url,
```

- [ ] **Step 3: Shim**

In `tauri/dist/electron-api-shim.js`:

```javascript
soundPackFileUrl: (pack, sound) =>
  window.__TAURI__.core.invoke("sound_pack_file_url", { pack, sound }),
```

- [ ] **Step 4: Build + smoke test**

Run: `cargo build --manifest-path tauri/Cargo.toml`
Expected: compiles. Launch app, click ▶ preview — default sound plays.

- [ ] **Step 5: Commit**

```bash
git add tauri/src/soundpacks.rs tauri/src/ipc.rs tauri/src/lib.rs tauri/dist/electron-api-shim.js tauri/Cargo.toml tauri/Cargo.lock
git commit -m "FEAT: sound_pack_file_url command for frontend audio preview"
```

---

## Task 13: Project detail page — overrides section (HTML)

**Files:**
- Modify: `tauri/dist/dashboard.html`

- [ ] **Step 1: Append section to project detail view**

Find the `<div id="view-project-detail">` block (around line 497). Inside the `.view-body`, before the closing `</div>` (after the `hideProjectBtn`), insert:

```html
<div class="section" id="projectNotifOverridesSection" style="margin-top:12px">
    <div class="section-title">Notification overrides</div>
    <template id="projectOverrideRowTemplate">
        <div class="project-override">
            <div class="option">
                <span class="option-label override-title"></span>
                <label class="switch">
                    <input type="checkbox" class="override-enabled">
                    <span class="slider"></span>
                </label>
            </div>
            <div class="override-body" style="display:none;padding-left:8px">
                <div class="option">
                    <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Type</span>
                    <div style="display:flex;gap:10px">
                        <label style="display:flex;align-items:center;gap:4px;font-size:0.85rem"><input type="radio" class="override-mode" value="sound"> Sound</label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:0.85rem"><input type="radio" class="override-mode" value="voice"> Voice</label>
                    </div>
                </div>
                <div class="option override-sound-row" style="display:none">
                    <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Sound</span>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
                        <select class="override-sound-pack"></select>
                        <select class="override-sound-file"></select>
                        <button class="btn-secondary override-pack-install" style="display:none;padding:3px 10px;font-size:0.8rem">Install</button>
                        <button class="btn-secondary override-sound-preview" style="padding:3px 10px;font-size:0.8rem">▶</button>
                    </div>
                </div>
                <div class="override-voice-rows" style="display:none;flex-direction:column;gap:6px;padding:6px 0">
                    <div class="option" style="border:none;padding:0">
                        <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Voice</span>
                        <select class="override-voice-select" style="flex:1;max-width:220px"></select>
                    </div>
                    <div class="option" style="border:none;padding:0;flex-direction:column;align-items:stretch;gap:4px">
                        <span class="option-label" style="font-size:0.82rem;color:var(--text-dim)">Message</span>
                        <input type="text" class="override-template" style="padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:0.85rem">
                    </div>
                </div>
            </div>
        </div>
    </template>
    <div id="projectOverrideRows"></div>
</div>
```

- [ ] **Step 2: Commit (markup only)**

```bash
git add tauri/dist/dashboard.html
git commit -m "FEAT: add notification overrides section markup to project detail view"
```

---

## Task 14: Project detail overrides — JS wiring

**Files:**
- Modify: `tauri/dist/modules/stats.js` (or whichever module owns project detail rendering)

- [ ] **Step 1: Find where project detail renders**

Run: `grep -n "projectDetailTitle\|project-merged-paths\|hideProjectBtn" tauri/dist/modules/*.js`

Identify the function that populates the detail view. Call it `renderProjectDetail(project)`.

- [ ] **Step 2: Add renderer for override rows**

Import helpers at the top (same import pattern as the file already uses):

```javascript
import { loadPacks, findPack, populatePackSelect, populateSoundSelect, installPack } from "./sound-packs.js";
```

Add a constant mirroring `NOTIF_TYPES` (3 events). To avoid duplication, export it from `settings.js` or redefine here:

```javascript
const OVERRIDE_EVENTS = [
  { key: "workFinished",     title: "Done (Work Finished)" },
  { key: "questionAsked",    title: "Waiting (Question Asked)" },
  { key: "thresholdCrossed", title: "Threshold Reached" },
];
```

Add a new function `renderProjectOverrides(cwdKey)`:

```javascript
async function renderProjectOverrides(cwdKey) {
  const root = document.getElementById("projectOverrideRows");
  const tpl = document.getElementById("projectOverrideRowTemplate");
  if (!root || !tpl) return;
  root.innerHTML = "";
  const settings = window.currentSettings || {};
  const overrides = (settings.projectNotifOverrides || {})[cwdKey] || {};
  const packs = await loadPacks();

  for (const ev of OVERRIDE_EVENTS) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const rule = overrides[ev.key] || {};
    node.querySelector(".override-title").textContent = ev.title;
    const enabledBox = node.querySelector(".override-enabled");
    const body = node.querySelector(".override-body");
    const modes = node.querySelectorAll(".override-mode");
    const soundRow = node.querySelector(".override-sound-row");
    const voiceRows = node.querySelector(".override-voice-rows");
    const packSel = node.querySelector(".override-sound-pack");
    const soundSel = node.querySelector(".override-sound-file");
    const installBtn = node.querySelector(".override-pack-install");
    const previewBtn = node.querySelector(".override-sound-preview");
    const voiceSel = node.querySelector(".override-voice-select");
    const templateInput = node.querySelector(".override-template");

    enabledBox.checked = !!rule.enabled;
    const mode = rule.mode === "voice" ? "voice" : "sound";
    modes.forEach(r => { r.checked = r.value === mode; r.name = `override-mode-${ev.key}-${cwdKey}`; });
    const currentPack = rule.soundPack || "default";
    const currentSound = rule.soundFile || "sound1.mp3";
    populatePackSelect(packSel, packs, currentPack);
    const pack = findPack(packs, currentPack);
    populateSoundSelect(soundSel, pack, currentSound);
    installBtn.style.display = (pack && !pack.installed) ? "inline-block" : "none";
    templateInput.value = rule.template || "";

    const applyVis = () => {
      body.style.display = enabledBox.checked ? "block" : "none";
      const m = Array.from(modes).find(r => r.checked)?.value || "sound";
      soundRow.style.display = (enabledBox.checked && m === "sound") ? "flex" : "none";
      voiceRows.style.display = (enabledBox.checked && m === "voice") ? "flex" : "none";
    };
    applyVis();

    const save = () => {
      settings.projectNotifOverrides = settings.projectNotifOverrides || {};
      const perProject = settings.projectNotifOverrides[cwdKey] = settings.projectNotifOverrides[cwdKey] || {};
      perProject[ev.key] = {
        enabled: enabledBox.checked,
        mode: Array.from(modes).find(r => r.checked)?.value || "sound",
        soundPack: packSel.value || "default",
        soundFile: soundSel.value,
        voiceName: voiceSel.value || null,
        template: templateInput.value || "",
      };
      window.electronAPI.saveSettings(settings);
    };

    enabledBox.addEventListener("change", () => { applyVis(); save(); });
    modes.forEach(r => r.addEventListener("change", () => { applyVis(); save(); }));
    packSel.addEventListener("change", async () => {
      const p = findPack(await loadPacks(), packSel.value);
      populateSoundSelect(soundSel, p, p?.sounds[0]?.id);
      installBtn.style.display = (p && !p.installed) ? "inline-block" : "none";
      save();
    });
    soundSel.addEventListener("change", save);
    templateInput.addEventListener("input", save);
    voiceSel.addEventListener("change", save);
    installBtn.addEventListener("click", async () => {
      installBtn.disabled = true; installBtn.textContent = "Installing...";
      try {
        const refreshed = await installPack(packSel.value);
        const p = findPack(refreshed, packSel.value);
        populatePackSelect(packSel, refreshed, packSel.value);
        populateSoundSelect(soundSel, p, soundSel.value);
        installBtn.style.display = "none";
      } catch (e) { alert("Pack install failed."); }
      finally { installBtn.disabled = false; installBtn.textContent = "Install"; }
    });
    previewBtn.addEventListener("click", async () => {
      const url = await window.electronAPI.soundPackFileUrl(packSel.value, soundSel.value);
      if (url) new Audio(url).play().catch(() => {});
    });

    root.appendChild(node);
  }
}
```

Call `renderProjectOverrides(project.cwdKey)` from the existing `renderProjectDetail` function, passing the same normalised cwd key used for aliases/blacklist.

- [ ] **Step 3: Manual test**

Run the app. Open a project detail page. Verify:
- 3 override rows (Done, Waiting, Threshold Reached)
- Each row toggles show/hide the body
- Switching Sound/Voice mode swaps the visible fields
- Changing pack repopulates the sound dropdown
- Settings file shows `projectNotifOverrides` entries after saving

- [ ] **Step 4: Commit**

```bash
git add tauri/dist/modules/stats.js
git commit -m "FEAT: per-project notification override UI on project detail page"
```

---

## Task 15: Vitest for two-step picker + override toggle

**Files:**
- Create: `tauri/tests/notif_picker.test.mjs`

- [ ] **Step 1: Write tests**

Create `tauri/tests/notif_picker.test.mjs`:

```javascript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";

const loadPacksMock = vi.fn();
vi.mock("../dist/modules/sound-packs.js", () => ({
  loadPacks: loadPacksMock,
  findPack: (packs, id) => packs.find(p => p.id === id) || null,
  populatePackSelect: (sel, packs, current) => {
    sel.innerHTML = packs.map(p => `<option value="${p.id}">${p.label}</option>`).join("");
    sel.value = current;
  },
  populateSoundSelect: (sel, pack, current) => {
    if (!pack) { sel.innerHTML = ""; return; }
    sel.innerHTML = pack.sounds.map(s => `<option value="${s.id}">${s.label}</option>`).join("");
    sel.value = current;
  },
  installPack: vi.fn(),
}));

describe("notif picker", () => {
  beforeEach(() => {
    const dom = new JSDOM(`
      <select id="pack"></select>
      <select id="sound"></select>
    `);
    global.document = dom.window.document;
    loadPacksMock.mockResolvedValue([
      { id: "default", label: "Default", installed: true,
        sounds: [{ id: "s1.mp3", label: "S1" }] },
      { id: "peon", label: "Peon", installed: false,
        sounds: [{ id: "work.mp3", label: "Work work" }] },
    ]);
  });

  it("changing pack swaps sound options", async () => {
    const { findPack, populateSoundSelect, populatePackSelect, loadPacks } =
      await import("../dist/modules/sound-packs.js");
    const packs = await loadPacks();
    const packSel = document.getElementById("pack");
    const soundSel = document.getElementById("sound");
    populatePackSelect(packSel, packs, "default");
    populateSoundSelect(soundSel, findPack(packs, "default"), "s1.mp3");
    expect(soundSel.value).toBe("s1.mp3");

    // Simulate user switching to peon
    packSel.value = "peon";
    populateSoundSelect(soundSel, findPack(packs, packSel.value), null);
    expect(soundSel.innerHTML).toContain("Work work");
    expect(soundSel.innerHTML).not.toContain("S1");
  });
});
```

- [ ] **Step 2: Run**

Run: `npm --prefix tauri test -- notif_picker`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add tauri/tests/notif_picker.test.mjs
git commit -m "TEST: two-step notification picker swaps sounds when pack changes"
```

---

## Task 16: README + CLAUDE.md updates

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: CLAUDE.md**

Add a new row to the architecture table:

```
| `src/core/sound-packs.js` / `tauri/src/soundpacks.rs` | Sound pack catalog, install, path resolution |
```

Add a new subsection under "Notifications" (or create one if absent):

```markdown
## Sound packs

Notifications can play any sound from the bundled **default** pack or any
**downloaded pack** (`peon`, `peasant`, `acolyte`, `wisp`). Packs install
on demand via `install_sound_pack` and land in
`<app-data>/sound-packs/<packId>/`. Per-project overrides live under
`settings.projectNotifOverrides[cwdKey][eventKey]`, gated by an `enabled`
flag; when off the event falls back to the default rule. Resolver lives
in `notifications::resolve_notif_config`.
```

- [ ] **Step 2: README.md**

Add a short user-facing note under the features list:

```markdown
- Per-project notification overrides: pick a different sound per project
  (e.g., a WC3 peon "Work work" clip for one repo, a beep for another).
  Sound packs download on demand from the release assets.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "DOCS: document sound packs and per-project notification overrides"
```

---

## Task 17: End-to-end smoke test checklist

- [ ] **Step 1: Manual verification**

Run the app. Verify:

1. **Defaults:** Notifications subpage shows Pack + Sound dropdowns. Default pack lists 6 sounds. ▶ plays.
2. **Pack install:** Select peon → "not installed" shown → Install button appears → click → spinner → after success, peon sounds populate, button hides.
3. **Override off:** Project detail page shows 3 override rows, all toggled off. Firing the event (hook) plays the default sound.
4. **Override on (sound):** Toggle Done override on, pick peon / work-work.mp3. Save. Fire a hook for that project → "Work work" plays.
5. **Override on (voice):** Toggle Threshold override on, switch to Voice, pick a voice, set template "{percent} reached". Trigger threshold → voice speaks.
6. **Different project:** Confirm Project A uses override, Project B uses default.
7. **Migration:** Delete `settings.json` projectNotifOverrides key, reload → no crash, overrides start empty.
8. **Uninstall pack:** Delete `<app-data>/sound-packs/peon/` while app runs → next preview falls back silently, log warns.

- [ ] **Step 2: Mark plan complete**

If all above pass, this plan is done. Commit any stray fixes, then merge the branch.

---

## Out of scope (confirmed)

- User-uploaded custom packs
- Voice cloning / arbitrary peon TTS
- Uninstall/update pack UI
- Pack sample-clip bundling (spec open item)
