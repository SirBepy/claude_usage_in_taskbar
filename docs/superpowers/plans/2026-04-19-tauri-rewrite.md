# Tauri Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Claude Usage Taskbar Tool from Electron to Tauri 2.x on Windows, delivering an MVP with tray icon, hourly polling, login flow, hook server, dashboard, autostart, and auto-update.

**Architecture:** Balanced split. Rust backend owns business logic (poll scheduling, history, settings, auth, hook server). Webview hosts the existing HTML/CSS/JS dashboard as a passive view that calls Rust via `invoke()` and reacts to emitted events. All new code lives in a sibling `tauri/` folder; the existing Electron app is untouched.

**Tech Stack:** Tauri 2.x, Rust (edition 2021), tokio, reqwest (cookies+json), tokio-tungstenite, axum, serde + serde_json, chrono, dirs, anyhow, image, mockito (tests). Tauri plugins: autostart, updater, log.

**Prerequisites (one-time, before Task 1):**

1. Install Rust: `https://rustup.rs/` → run `rustup-init.exe`, accept defaults, restart shell.
2. Verify: `rustc --version` should print `1.80+` and `cargo --version` should work.
3. Install Tauri CLI: `cargo install tauri-cli --version "^2.0"` (takes ~5 min first time).
4. Install `@tauri-apps/cli` is NOT needed — we use the pure-Rust `cargo tauri` CLI.
5. Verify: `cargo tauri --version` should print `2.x`.
6. Optional but useful: `rustup component add clippy rustfmt`.

**Conventions:**
- All paths are relative to repo root: `C:\Users\tecno\Desktop\Projects\claude_usage_in_taskbar`.
- Git commands use `git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar <cmd>` on Windows bash.
- `cargo` commands run from inside `tauri/` unless noted.
- Commit prefix `FEAT:` for new features, `TEST:` for tests, `CHORE:` for scaffolding.

---

## Task 1: Scaffold Tauri project with a blank tray-launched window

**Files:**
- Create: `tauri/Cargo.toml`
- Create: `tauri/tauri.conf.json`
- Create: `tauri/build.rs`
- Create: `tauri/src/main.rs`
- Create: `tauri/src/lib.rs`
- Create: `tauri/dist/index.html`
- Create: `tauri/.gitignore`
- Create: `tauri/README.md`

- [ ] **Step 1: Create directory skeleton**

```bash
mkdir -p tauri/src tauri/dist
```

- [ ] **Step 2: Write `tauri/Cargo.toml`**

```toml
[package]
name = "claude-usage-tauri"
version = "0.1.0"
edition = "2021"
rust-version = "1.80"

[lib]
name = "claude_usage_tauri_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2.0", features = [] }

[dependencies]
tauri = { version = "2.0", features = ["tray-icon"] }
tauri-plugin-log = "2.0"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
thiserror = "1"

[dev-dependencies]
tempfile = "3"

[profile.release]
codegen-units = 1
lto = true
opt-level = "s"
strip = true
panic = "abort"
```

- [ ] **Step 3: Write `tauri/build.rs`**

```rust
fn main() {
    tauri_build::build();
}
```

- [ ] **Step 4: Write `tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Claude Usage",
  "version": "0.1.0",
  "identifier": "com.aiusage.taskbar.tauri",
  "build": {
    "frontendDist": "./dist",
    "devUrl": null,
    "beforeDevCommand": null,
    "beforeBuildCommand": null
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "label": "main",
        "title": "Claude Usage",
        "url": "index.html",
        "width": 900,
        "height": 640,
        "resizable": true,
        "visible": false,
        "decorations": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/icon.png"],
    "publisher": "SirBepy",
    "category": "Utility",
    "shortDescription": "Claude AI usage in your taskbar",
    "longDescription": "Tray app that monitors Claude AI usage and shows it as progress rings in the system tray."
  }
}
```

- [ ] **Step 5: Write `tauri/src/lib.rs`**

```rust
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .setup(|app| {
            log::info!("claude-usage-tauri starting");
            // Window is hidden by default; dashboard shown on user request.
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 6: Write `tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    claude_usage_tauri_lib::run();
}
```

- [ ] **Step 7: Write `tauri/dist/index.html`**

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Claude Usage</title></head>
<body>
  <h1>Claude Usage — scaffolding</h1>
  <p>If you see this, Tauri is running.</p>
</body>
</html>
```

- [ ] **Step 8: Write `tauri/.gitignore`**

```
target/
Cargo.lock
gen/
icons/
```

(`Cargo.lock` is gitignored during MVP scaffolding to keep commits small. Will be un-ignored and committed before first release — Task 16.)

- [ ] **Step 9: Write `tauri/README.md`**

```markdown
# claude-usage-tauri

Tauri 2.x rewrite of the Claude Usage Taskbar Tool. Windows MVP.

## Dev

    cargo tauri dev

## Build

    cargo tauri build

Produces an NSIS installer in `target/release/bundle/nsis/`.
```

- [ ] **Step 10: Generate a placeholder icon**

Tauri requires an icon at `tauri/icons/icon.png`. Copy the existing Electron icon as a placeholder:

```bash
mkdir -p tauri/icons
cp src/assets/icon.png tauri/icons/icon.png
```

Also generate the platform-specific sizes Tauri needs:

```bash
cd tauri
cargo tauri icon icons/icon.png
cd ..
```

Expected: creates `tauri/icons/32x32.png`, `128x128.png`, `icon.ico`, etc.

- [ ] **Step 11: First build to verify everything compiles**

```bash
cd tauri
cargo build
cd ..
```

Expected: compiles (takes 3-10 min on first run — this is Rust downloading and compiling all deps).

- [ ] **Step 12: Run the dev app to verify the window opens manually**

For scaffolding only, temporarily flip `"visible": false` → `"visible": true` in `tauri.conf.json`, then:

```bash
cd tauri
cargo tauri dev
cd ..
```

Expected: a window opens showing "Claude Usage — scaffolding". Close it. Revert `"visible"` back to `false`.

- [ ] **Step 13: Commit the scaffold**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "CHORE: scaffold empty Tauri app"
```

---

## Task 2: Core types (UsageSnapshot, Settings, AuthState)

**Files:**
- Create: `tauri/src/types.rs`
- Modify: `tauri/src/lib.rs` (add `mod types;`)

- [ ] **Step 1: Write `tauri/src/types.rs`**

```rust
use serde::{Deserialize, Serialize};

/// A single usage poll result, captured at a point in time.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct UsageSnapshot {
    pub captured_at: String,           // RFC3339 / ISO8601
    pub five_hour: WindowUsage,
    pub seven_day: WindowUsage,
    #[serde(default)]
    pub extra_usage: Option<ExtraUsage>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WindowUsage {
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ExtraUsage {
    pub is_enabled: bool,
    pub monthly_limit: u32,
    pub used_credits: u32,
    pub utilization: f64,
    pub currency: String,
}

/// User-configurable app settings.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Settings {
    pub poll_interval_secs: u64,
    pub display_mode: DisplayMode,
    pub threshold_warn: f64,
    pub threshold_crit: f64,
    pub autostart: bool,
    #[serde(default)]
    pub hook_port: Option<u16>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            poll_interval_secs: 3600,
            display_mode: DisplayMode::Rings,
            threshold_warn: 50.0,
            threshold_crit: 80.0,
            autostart: true,
            hook_port: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DisplayMode {
    Rings,
    Bars,
    Digits,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthState {
    LoggedIn,
    NeedsLogin,
    InProgress,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_defaults_roundtrip_json() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn usage_snapshot_parses_real_api_shape() {
        // Shape verified against real API response (see .direct-api-test-output.json).
        let raw = r#"{
            "captured_at": "2026-04-19T10:00:00Z",
            "five_hour": { "utilization": 7.0, "resets_at": "2026-04-19T15:00:00Z" },
            "seven_day": { "utilization": 4.0, "resets_at": "2026-04-23T23:00:00Z" },
            "extra_usage": {
                "is_enabled": true, "monthly_limit": 8500,
                "used_credits": 329, "utilization": 3.87, "currency": "EUR"
            }
        }"#;
        let parsed: UsageSnapshot = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.five_hour.utilization, 7.0);
        assert_eq!(parsed.extra_usage.as_ref().unwrap().monthly_limit, 8500);
    }
}
```

- [ ] **Step 2: Register module in `tauri/src/lib.rs`**

Add at the very top, above `use tauri::Manager;`:

```rust
pub mod types;
```

- [ ] **Step 3: Run tests to confirm green**

```bash
cd tauri
cargo test --lib types::
```

Expected: `running 2 tests ... test result: ok. 2 passed`.

- [ ] **Step 4: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/src/types.rs tauri/src/lib.rs
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: add core types with serde round-trip tests"
```

---

## Task 3: Settings persistence (load + save JSON)

**Files:**
- Create: `tauri/src/settings.rs`
- Create: `tauri/src/paths.rs`
- Modify: `tauri/Cargo.toml` (add `dirs`)
- Modify: `tauri/src/lib.rs` (add `mod settings; mod paths;`)

- [ ] **Step 1: Add `dirs` crate**

In `tauri/Cargo.toml`, under `[dependencies]`:

```toml
dirs = "5"
```

- [ ] **Step 2: Write `tauri/src/paths.rs`**

```rust
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

/// Ensures the data directory exists. Idempotent.
pub fn ensure_data_dir() -> Result<PathBuf> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
```

- [ ] **Step 3: Write `tauri/src/settings.rs` with tests first**

Write the test module first (TDD), then the impl. Full file:

```rust
//! Load and save user settings to disk.

use crate::types::Settings;
use anyhow::{Context, Result};
use std::path::Path;

/// Loads settings from disk. If the file is missing or corrupt, returns defaults
/// (and does NOT rewrite the file automatically — the caller decides when to save).
pub fn load(path: &Path) -> Settings {
    match std::fs::read_to_string(path) {
        Err(_) => Settings::default(),
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
    }
}

/// Saves settings to disk, creating parent dirs if needed.
pub fn save(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating parent dir {parent:?}"))?;
    }
    let raw = serde_json::to_string_pretty(settings)
        .context("serializing settings")?;
    std::fs::write(path, raw)
        .with_context(|| format!("writing settings to {path:?}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DisplayMode, Settings};
    use tempfile::tempdir;

    #[test]
    fn load_missing_file_returns_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope.json");
        let s = load(&path);
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn load_corrupt_file_returns_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ not valid json").unwrap();
        let s = load(&path);
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sub").join("settings.json");
        let mut s = Settings::default();
        s.threshold_warn = 42.0;
        s.display_mode = DisplayMode::Bars;
        save(&path, &s).unwrap();
        let back = load(&path);
        assert_eq!(s, back);
    }
}
```

- [ ] **Step 4: Register modules in `tauri/src/lib.rs`**

Add near the top:

```rust
pub mod paths;
pub mod settings;
pub mod types;
```

- [ ] **Step 5: Run tests**

```bash
cd tauri
cargo test --lib settings::
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: add settings and path resolution with tests"
```

---

## Task 4: Session file (sessionKey cookie on disk)

**Files:**
- Create: `tauri/src/session.rs`
- Modify: `tauri/src/lib.rs` (`mod session;`)

- [ ] **Step 1: Write `tauri/src/session.rs`**

```rust
//! Reads and writes the single sessionKey cookie value.

use anyhow::{Context, Result};
use std::path::Path;

/// Returns the current sessionKey, or `None` if no session has been saved.
pub fn load(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

/// Saves the sessionKey, creating parent dirs as needed.
pub fn save(path: &Path, session_key: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating parent dir {parent:?}"))?;
    }
    std::fs::write(path, session_key.trim())
        .with_context(|| format!("writing session to {path:?}"))?;
    Ok(())
}

/// Deletes the session file. Used on explicit logout or after repeated 401s.
pub fn clear(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_session_file_returns_none() {
        let dir = tempdir().unwrap();
        assert_eq!(load(&dir.path().join("nope.txt")), None);
    }

    #[test]
    fn empty_session_file_returns_none() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("s.txt");
        std::fs::write(&p, "   \n").unwrap();
        assert_eq!(load(&p), None);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("s.txt");
        save(&p, "sk-ant-abc123").unwrap();
        assert_eq!(load(&p).as_deref(), Some("sk-ant-abc123"));
    }

    #[test]
    fn clear_removes_file() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("s.txt");
        save(&p, "x").unwrap();
        clear(&p).unwrap();
        assert_eq!(load(&p), None);
    }

    #[test]
    fn clear_is_idempotent_when_missing() {
        let dir = tempdir().unwrap();
        clear(&dir.path().join("never.txt")).unwrap();
    }
}
```

- [ ] **Step 2: Register module** in `tauri/src/lib.rs`:

```rust
pub mod session;
```

- [ ] **Step 3: Run tests**

```bash
cd tauri
cargo test --lib session::
```

Expected: 5 passed.

- [ ] **Step 4: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: add session file load/save/clear with tests"
```

---

## Task 5: History persistence (JSONL append + load + prune)

**Files:**
- Create: `tauri/src/history.rs`
- Modify: `tauri/Cargo.toml` (add `chrono`)
- Modify: `tauri/src/lib.rs` (`mod history;`)

- [ ] **Step 1: Add `chrono` to `tauri/Cargo.toml`**

```toml
chrono = { version = "0.4", features = ["serde"] }
```

- [ ] **Step 2: Write `tauri/src/history.rs`**

```rust
//! Append-only JSONL history of usage snapshots, with age-based pruning.

use crate::types::UsageSnapshot;
use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

const MAX_AGE_DAYS: i64 = 90;

/// Append a snapshot as a single JSON line.
pub fn append(path: &Path, snapshot: &UsageSnapshot) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {parent:?}"))?;
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("opening {path:?}"))?;
    let line = serde_json::to_string(snapshot).context("serializing snapshot")?;
    writeln!(f, "{line}").context("writing snapshot line")?;
    Ok(())
}

/// Load all snapshots from disk, skipping any lines that fail to parse
/// (with a log warning). Returns oldest first.
pub fn load_all(path: &Path) -> Result<Vec<UsageSnapshot>> {
    let f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e).context("opening history file"),
    };
    let mut out = Vec::new();
    for (idx, line) in BufReader::new(f).lines().enumerate() {
        let raw = line.with_context(|| format!("reading line {idx}"))?;
        if raw.trim().is_empty() { continue; }
        match serde_json::from_str::<UsageSnapshot>(&raw) {
            Ok(snap) => out.push(snap),
            Err(e) => log::warn!("history line {idx} skipped: {e}"),
        }
    }
    Ok(out)
}

/// Delete snapshots older than MAX_AGE_DAYS by rewriting the file.
pub fn prune(path: &Path) -> Result<()> {
    let snapshots = load_all(path)?;
    let cutoff = Utc::now() - Duration::days(MAX_AGE_DAYS);
    let kept: Vec<_> = snapshots
        .into_iter()
        .filter(|s| {
            match DateTime::parse_from_rfc3339(&s.captured_at) {
                Ok(ts) => ts.with_timezone(&Utc) > cutoff,
                Err(_) => true, // keep unparseable rather than lose data
            }
        })
        .collect();
    let raw: String = kept
        .iter()
        .map(|s| serde_json::to_string(s).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    let raw = if raw.is_empty() { String::new() } else { format!("{raw}\n") };
    std::fs::write(path, raw).context("rewriting history after prune")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{UsageSnapshot, WindowUsage};
    use tempfile::tempdir;

    fn snap(captured_at: &str) -> UsageSnapshot {
        UsageSnapshot {
            captured_at: captured_at.into(),
            five_hour: WindowUsage { utilization: 1.0, resets_at: "x".into() },
            seven_day: WindowUsage { utilization: 2.0, resets_at: "y".into() },
            extra_usage: None,
        }
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let dir = tempdir().unwrap();
        assert!(load_all(&dir.path().join("nope.jsonl")).unwrap().is_empty());
    }

    #[test]
    fn append_then_load_roundtrips() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("h.jsonl");
        append(&p, &snap("2026-04-19T10:00:00Z")).unwrap();
        append(&p, &snap("2026-04-19T11:00:00Z")).unwrap();
        let back = load_all(&p).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].captured_at, "2026-04-19T10:00:00Z");
    }

    #[test]
    fn load_skips_corrupt_lines() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("h.jsonl");
        let good = serde_json::to_string(&snap("2026-04-19T10:00:00Z")).unwrap();
        std::fs::write(&p, format!("{good}\n{{not json\n{good}\n")).unwrap();
        let back = load_all(&p).unwrap();
        assert_eq!(back.len(), 2);
    }

    #[test]
    fn prune_drops_old_snapshots() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("h.jsonl");
        let old = (Utc::now() - Duration::days(120)).to_rfc3339();
        let recent = Utc::now().to_rfc3339();
        append(&p, &snap(&old)).unwrap();
        append(&p, &snap(&recent)).unwrap();
        prune(&p).unwrap();
        let back = load_all(&p).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].captured_at, recent);
    }
}
```

- [ ] **Step 3: Register module** in `tauri/src/lib.rs`:

```rust
pub mod history;
```

- [ ] **Step 4: Run tests**

```bash
cd tauri
cargo test --lib history::
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: add JSONL history append/load/prune with tests"
```

---

## Task 6: HTTP scraper (reqwest GET with sessionKey cookie)

**Files:**
- Create: `tauri/src/scraper.rs`
- Modify: `tauri/Cargo.toml` (add `reqwest`, `tokio`, `mockito` as dev-dep)
- Modify: `tauri/src/lib.rs` (`mod scraper;`)

- [ ] **Step 1: Add deps to `tauri/Cargo.toml`**

Under `[dependencies]`:

```toml
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "cookies"] }
```

Under `[dev-dependencies]`:

```toml
mockito = "1"
```

- [ ] **Step 2: Write `tauri/src/scraper.rs`**

```rust
//! Fetches usage JSON from claude.ai using a stored sessionKey cookie.

use crate::types::UsageSnapshot;
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

#[derive(Deserialize)]
struct OrgListEntry { uuid: String }

/// Errors that callers may want to react to distinctly.
#[derive(thiserror::Error, Debug)]
pub enum ScrapeError {
    #[error("unauthorized (session expired)")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("no organizations returned")]
    NoOrgs,
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Fetches current usage. `base_url` is injected for tests; production passes
/// `"https://claude.ai"`.
pub async fn fetch_usage(base_url: &str, session_key: &str)
    -> Result<UsageSnapshot, ScrapeError>
{
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .context("building http client")
        .map_err(ScrapeError::Other)?;

    let cookie_header = format!("sessionKey={session_key}");

    // 1. Get organizations
    let orgs_url = format!("{base_url}/api/organizations");
    let orgs_resp = client.get(&orgs_url)
        .header("cookie", &cookie_header)
        .header("accept", "application/json")
        .header("referer", format!("{base_url}/settings/usage"))
        .send().await
        .context("GET /api/organizations")
        .map_err(ScrapeError::Other)?;

    let status = orgs_resp.status();
    if status.as_u16() == 401 { return Err(ScrapeError::Unauthorized); }
    if status.as_u16() == 403 { return Err(ScrapeError::Forbidden); }
    if !status.is_success() {
        return Err(ScrapeError::Other(anyhow!(
            "organizations HTTP {}",
            status.as_u16()
        )));
    }

    let orgs: Vec<OrgListEntry> = orgs_resp.json().await
        .context("parsing org list").map_err(ScrapeError::Other)?;
    let org_id = orgs.first().ok_or(ScrapeError::NoOrgs)?.uuid.clone();

    // 2. Get usage
    let usage_url = format!("{base_url}/api/organizations/{org_id}/usage");
    let usage_resp = client.get(&usage_url)
        .header("cookie", &cookie_header)
        .header("accept", "application/json")
        .header("referer", format!("{base_url}/settings/usage"))
        .send().await
        .context("GET usage").map_err(ScrapeError::Other)?;

    let status = usage_resp.status();
    if status.as_u16() == 401 { return Err(ScrapeError::Unauthorized); }
    if status.as_u16() == 403 { return Err(ScrapeError::Forbidden); }
    if !status.is_success() {
        return Err(ScrapeError::Other(anyhow!(
            "usage HTTP {}",
            status.as_u16()
        )));
    }

    // The API returns { five_hour, seven_day, extra_usage } without a
    // captured_at field; we stamp that ourselves.
    #[derive(Deserialize)]
    struct RawUsage {
        five_hour: crate::types::WindowUsage,
        seven_day: crate::types::WindowUsage,
        #[serde(default)]
        extra_usage: Option<crate::types::ExtraUsage>,
    }
    let raw: RawUsage = usage_resp.json().await
        .context("parsing usage").map_err(ScrapeError::Other)?;

    Ok(UsageSnapshot {
        captured_at: chrono::Utc::now().to_rfc3339(),
        five_hour: raw.five_hour,
        seven_day: raw.seven_day,
        extra_usage: raw.extra_usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn happy_path_returns_snapshot() {
        let mut server = mockito::Server::new_async().await;
        let _m1 = server.mock("GET", "/api/organizations")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[{"uuid":"ORG-1"}]"#)
            .create_async().await;
        let _m2 = server.mock("GET", "/api/organizations/ORG-1/usage")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{
                "five_hour": {"utilization": 10.0, "resets_at": "x"},
                "seven_day": {"utilization": 5.0, "resets_at": "y"}
            }"#)
            .create_async().await;

        let snap = fetch_usage(&server.url(), "sk-abc").await.unwrap();
        assert_eq!(snap.five_hour.utilization, 10.0);
        assert_eq!(snap.seven_day.utilization, 5.0);
    }

    #[tokio::test]
    async fn unauthorized_on_401() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/organizations")
            .with_status(401).create_async().await;
        let err = fetch_usage(&server.url(), "sk-bad").await.unwrap_err();
        assert!(matches!(err, ScrapeError::Unauthorized));
    }

    #[tokio::test]
    async fn no_orgs_returns_no_orgs_error() {
        let mut server = mockito::Server::new_async().await;
        let _m = server.mock("GET", "/api/organizations")
            .with_status(200).with_body("[]")
            .create_async().await;
        let err = fetch_usage(&server.url(), "sk").await.unwrap_err();
        assert!(matches!(err, ScrapeError::NoOrgs));
    }
}
```

- [ ] **Step 3: Register module** in `tauri/src/lib.rs`:

```rust
pub mod scraper;
```

- [ ] **Step 4: Run tests**

```bash
cd tauri
cargo test --lib scraper::
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: add usage scraper with mock HTTP tests"
```

---

## Task 7: Icon rendering (dual ring PNG bytes)

**Files:**
- Create: `tauri/src/icon.rs`
- Modify: `tauri/Cargo.toml` (add `image`)
- Modify: `tauri/src/lib.rs` (`mod icon;`)

Context: Port of `src/core/icon.js` + `src/core/png-utils.js`. We render a 22x22 RGBA PNG with two concentric rings (outer = 5h, inner = 7d). Colors by urgency: blue (no data) → green (<50) → orange (50-80) → red (>80). Unfilled portion in dim grey.

- [ ] **Step 1: Add `image` crate to `tauri/Cargo.toml`**

```toml
image = { version = "0.25", default-features = false, features = ["png"] }
```

- [ ] **Step 2: Write `tauri/src/icon.rs`**

```rust
//! Renders the tray icon as an RGBA PNG byte buffer.

use image::{ImageBuffer, Rgba, RgbaImage};

const SIZE: u32 = 22;
const CENTER: f32 = (SIZE as f32) / 2.0;

const OUTER_R_OUT: f32 = 10.5;
const OUTER_R_IN: f32  = 7.5;
const INNER_R_OUT: f32 = 5.5;
const INNER_R_IN:  f32 = 3.5;

const TRACK: Rgba<u8>   = Rgba([60, 60, 60, 255]);
const LOADING: Rgba<u8> = Rgba([64, 128, 220, 255]); // blue
const GREEN: Rgba<u8>   = Rgba([60, 180, 75, 255]);
const ORANGE: Rgba<u8>  = Rgba([240, 150, 40, 255]);
const RED: Rgba<u8>     = Rgba([220, 60, 60, 255]);

fn color_for(pct: f32) -> Rgba<u8> {
    if pct >= 80.0 { RED }
    else if pct >= 50.0 { ORANGE }
    else { GREEN }
}

/// Returns RGBA png bytes (as a `Vec<u8>`) for a tray icon showing the two rings.
/// `five_hour_pct` and `seven_day_pct` are 0..=100. Pass `None` to render the
/// "loading" state for that ring.
pub fn render_rings(five_hour_pct: Option<f32>, seven_day_pct: Option<f32>) -> Vec<u8> {
    let mut img: RgbaImage = ImageBuffer::from_pixel(SIZE, SIZE, Rgba([0, 0, 0, 0]));
    draw_ring(&mut img, OUTER_R_OUT, OUTER_R_IN, TRACK);
    draw_ring(&mut img, INNER_R_OUT, INNER_R_IN, TRACK);
    if let Some(p) = five_hour_pct {
        draw_ring_arc(&mut img, OUTER_R_OUT, OUTER_R_IN, p, color_for(p));
    } else {
        draw_ring_arc(&mut img, OUTER_R_OUT, OUTER_R_IN, 100.0, LOADING);
    }
    if let Some(p) = seven_day_pct {
        draw_ring_arc(&mut img, INNER_R_OUT, INNER_R_IN, p, color_for(p));
    } else {
        draw_ring_arc(&mut img, INNER_R_OUT, INNER_R_IN, 100.0, LOADING);
    }
    encode_png(&img)
}

fn draw_ring(img: &mut RgbaImage, r_out: f32, r_in: f32, color: Rgba<u8>) {
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 + 0.5 - CENTER;
            let dy = y as f32 + 0.5 - CENTER;
            let d = (dx * dx + dy * dy).sqrt();
            if d <= r_out && d >= r_in {
                img.put_pixel(x, y, color);
            }
        }
    }
}

fn draw_ring_arc(img: &mut RgbaImage, r_out: f32, r_in: f32, pct: f32, color: Rgba<u8>) {
    let pct = pct.clamp(0.0, 100.0);
    // Start at 12 o'clock, sweep clockwise, proportional to pct.
    let max_angle = pct / 100.0 * std::f32::consts::TAU;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 + 0.5 - CENTER;
            let dy = y as f32 + 0.5 - CENTER;
            let d = (dx * dx + dy * dy).sqrt();
            if d > r_out || d < r_in { continue; }
            // angle measured clockwise from 12 o'clock:
            let mut a = (-dy).atan2(dx) * -1.0 + std::f32::consts::FRAC_PI_2;
            if a < 0.0 { a += std::f32::consts::TAU; }
            if a <= max_angle {
                img.put_pixel(x, y, color);
            }
        }
    }
}

fn encode_png(img: &RgbaImage) -> Vec<u8> {
    let mut buf = Vec::with_capacity(4096);
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba8,
        )
        .expect("png encode");
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_header_correct() {
        let bytes = render_rings(Some(40.0), Some(80.0));
        // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
        assert_eq!(&bytes[0..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }

    #[test]
    fn decoded_dimensions_are_22x22() {
        let bytes = render_rings(Some(40.0), Some(80.0));
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.width(), SIZE);
        assert_eq!(decoded.height(), SIZE);
    }

    #[test]
    fn loading_state_renders_without_panicking() {
        let _ = render_rings(None, None);
    }

    #[test]
    fn full_ring_colors_high_pct_red() {
        assert_eq!(color_for(85.0), RED);
        assert_eq!(color_for(50.0), ORANGE);
        assert_eq!(color_for(10.0), GREEN);
    }
}
```

- [ ] **Step 3: Register module** in `tauri/src/lib.rs`:

```rust
pub mod icon;
```

- [ ] **Step 4: Run tests**

```bash
cd tauri
cargo test --lib icon::
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: render tray icon as 22x22 PNG with dual rings"
```

---

## Task 8: App state + IPC commands

**Files:**
- Create: `tauri/src/state.rs`
- Create: `tauri/src/ipc.rs`
- Modify: `tauri/src/lib.rs` (wire state, register commands)

- [ ] **Step 1: Write `tauri/src/state.rs`**

```rust
//! Runtime app state shared across Tauri commands and background tasks.

use crate::types::{AuthState, Settings, UsageSnapshot};
use std::sync::Mutex;

pub struct AppState {
    pub current_usage: Mutex<Option<UsageSnapshot>>,
    pub settings: Mutex<Settings>,
    pub auth_state: Mutex<AuthState>,
}

impl AppState {
    pub fn new(settings: Settings, auth_state: AuthState) -> Self {
        Self {
            current_usage: Mutex::new(None),
            settings: Mutex::new(settings),
            auth_state: Mutex::new(auth_state),
        }
    }
}
```

- [ ] **Step 2: Write `tauri/src/ipc.rs`**

```rust
//! IPC commands exposed to the webview via `invoke()`.

use crate::state::AppState;
use crate::types::{AuthState, Settings, UsageSnapshot};
use crate::{history, paths, session, settings};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub fn get_current_usage(state: State<AppState>) -> Option<UsageSnapshot> {
    state.current_usage.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_history(limit: Option<u32>) -> Vec<UsageSnapshot> {
    let path = match paths::history_file() { Ok(p) => p, Err(_) => return vec![] };
    let mut all = history::load_all(&path).unwrap_or_default();
    if let Some(n) = limit {
        let start = all.len().saturating_sub(n as usize);
        all = all.split_off(start);
    }
    all
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(updated: Settings, state: State<AppState>, app: AppHandle)
    -> Result<(), String>
{
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &updated).map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = updated.clone();
    let _ = app.emit("settings-changed", updated);
    Ok(())
}

#[tauri::command]
pub fn auth_status(state: State<AppState>) -> AuthState {
    *state.auth_state.lock().unwrap()
}

#[tauri::command]
pub fn open_dashboard(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

// Deferred to their own tasks:
//   poll_now     -> Task 9 (scheduler)
//   start_login  -> Task 13 (auth)

/// Convenience: clears the stored session.
#[tauri::command]
pub fn logout(state: State<AppState>, app: AppHandle) -> Result<(), String> {
    let path = paths::session_file().map_err(|e| e.to_string())?;
    session::clear(&path).map_err(|e| e.to_string())?;
    *state.auth_state.lock().unwrap() = AuthState::NeedsLogin;
    let _ = app.emit("auth-progress", serde_json::json!({"stage": "needs-login"}));
    Ok(())
}
```

- [ ] **Step 3: Update `tauri/src/lib.rs` to register state + commands**

Replace the existing `lib.rs` with:

```rust
pub mod history;
pub mod icon;
pub mod ipc;
pub mod paths;
pub mod scraper;
pub mod session;
pub mod settings;
pub mod state;
pub mod types;

use crate::state::AppState;
use crate::types::AuthState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = paths::ensure_data_dir();
    let settings_path = paths::settings_file().expect("settings path");
    let session_path = paths::session_file().expect("session path");
    let loaded_settings = settings::load(&settings_path);
    let auth = if session::load(&session_path).is_some() {
        AuthState::LoggedIn
    } else {
        AuthState::NeedsLogin
    };

    let state = AppState::new(loaded_settings, auth);

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            ipc::get_current_usage,
            ipc::get_history,
            ipc::get_settings,
            ipc::save_settings,
            ipc::auth_status,
            ipc::open_dashboard,
            ipc::quit_app,
            ipc::logout,
        ])
        .setup(|_app| {
            log::info!("claude-usage-tauri started");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Build to confirm**

```bash
cd tauri
cargo build
```

Expected: compiles clean.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: add app state and IPC command surface"
```

---

## Task 9: Scheduler (tokio interval, emits `usage-updated`)

**Files:**
- Create: `tauri/src/scheduler.rs`
- Modify: `tauri/src/ipc.rs` (add `poll_now`)
- Modify: `tauri/src/lib.rs` (spawn scheduler at startup)

- [ ] **Step 1: Write `tauri/src/scheduler.rs`**

```rust
//! Background task that polls usage on an interval and broadcasts results.

use crate::scraper::{fetch_usage, ScrapeError};
use crate::state::AppState;
use crate::types::{AuthState, UsageSnapshot};
use crate::{history, paths, session};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const BASE_URL: &str = "https://claude.ai";
const FAIL_STREAK_BEFORE_RELOGIN: u32 = 3;

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut fail_streak: u32 = 0;
        loop {
            let interval_secs = interval_for(&app);

            match poll_once(&app).await {
                Ok(snap) => {
                    fail_streak = 0;
                    let _ = app.emit("usage-updated", snap);
                }
                Err(PollErr::NeedsLogin) => {
                    fail_streak += 1;
                    let _ = app.emit(
                        "poll-failed",
                        serde_json::json!({"reason": "unauthorized"}),
                    );
                    if fail_streak >= FAIL_STREAK_BEFORE_RELOGIN {
                        let state = app.state::<AppState>();
                        *state.auth_state.lock().unwrap() = AuthState::NeedsLogin;
                        let _ = app.emit(
                            "auth-progress",
                            serde_json::json!({"stage": "needs-login"}),
                        );
                    }
                }
                Err(PollErr::NoSession) => {
                    let _ = app.emit(
                        "poll-failed",
                        serde_json::json!({"reason": "no-session"}),
                    );
                }
                Err(PollErr::Other(msg)) => {
                    let _ = app.emit(
                        "poll-failed",
                        serde_json::json!({"reason": msg}),
                    );
                }
            }

            tokio::time::sleep(Duration::from_secs(interval_secs)).await;
        }
    });
}

fn interval_for(app: &AppHandle) -> u64 {
    let state = app.state::<AppState>();
    let s = state.settings.lock().unwrap();
    s.poll_interval_secs.max(60) // floor 60s to avoid accidental hammering
}

#[derive(Debug)]
pub enum PollErr {
    NoSession,
    NeedsLogin,
    Other(String),
}

pub async fn poll_once(app: &AppHandle) -> Result<UsageSnapshot, PollErr> {
    let session_path = paths::session_file()
        .map_err(|e| PollErr::Other(e.to_string()))?;
    let Some(session_key) = session::load(&session_path) else {
        return Err(PollErr::NoSession);
    };

    let snap = match fetch_usage(BASE_URL, &session_key).await {
        Ok(s) => s,
        Err(ScrapeError::Unauthorized) => return Err(PollErr::NeedsLogin),
        Err(ScrapeError::Forbidden) => return Err(PollErr::NeedsLogin),
        Err(e) => return Err(PollErr::Other(e.to_string())),
    };

    // Persist into in-memory + on-disk history
    {
        let state = app.state::<AppState>();
        *state.current_usage.lock().unwrap() = Some(snap.clone());
        *state.auth_state.lock().unwrap() = AuthState::LoggedIn;
    }
    let hpath = paths::history_file()
        .map_err(|e| PollErr::Other(e.to_string()))?;
    history::append(&hpath, &snap)
        .map_err(|e| PollErr::Other(e.to_string()))?;
    // Opportunistic prune once per poll (fast when nothing to prune).
    let _ = history::prune(&hpath);

    Ok(snap)
}
```

- [ ] **Step 2: Add `poll_now` command to `tauri/src/ipc.rs`**

Append to the end of `ipc.rs`:

```rust
#[tauri::command]
pub async fn poll_now(app: AppHandle) -> Result<UsageSnapshot, String> {
    match crate::scheduler::poll_once(&app).await {
        Ok(snap) => {
            let _ = app.emit("usage-updated", snap.clone());
            Ok(snap)
        }
        Err(e) => Err(format!("{e:?}")),
    }
}
```

- [ ] **Step 3: Update `tauri/src/lib.rs`**

Add `pub mod scheduler;` at the top. In the `tauri::Builder` chain, add `ipc::poll_now` to the `generate_handler!` list. Inside `.setup(|app| { ... })`, after the log line, spawn the scheduler:

```rust
.setup(|app| {
    log::info!("claude-usage-tauri started");
    crate::scheduler::spawn(app.handle().clone());
    Ok(())
})
```

Updated `generate_handler!` list:

```rust
.invoke_handler(tauri::generate_handler![
    ipc::get_current_usage,
    ipc::get_history,
    ipc::get_settings,
    ipc::save_settings,
    ipc::auth_status,
    ipc::open_dashboard,
    ipc::quit_app,
    ipc::logout,
    ipc::poll_now,
])
```

- [ ] **Step 4: Build**

```bash
cd tauri
cargo build
```

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: add polling scheduler with event emission"
```

---

## Task 10: Tray icon integration

**Files:**
- Create: `tauri/src/tray.rs`
- Modify: `tauri/src/lib.rs` (wire tray in `.setup`)
- Modify: `tauri/tauri.conf.json` (tray capability)

- [ ] **Step 1: Write `tauri/src/tray.rs`**

```rust
//! Builds the tray icon and context menu.

use crate::icon::render_rings;
use crate::state::AppState;
use crate::types::UsageSnapshot;
use anyhow::Result;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri::{AppHandle, Manager, Emitter};

pub const TRAY_ID: &str = "main-tray";

pub fn setup(app: &AppHandle) -> Result<()> {
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "Open Dashboard").build(app)?)
        .item(&MenuItemBuilder::with_id("refresh", "Refresh Now").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;

    let icon_bytes = render_rings(None, None);
    let icon = Image::from_bytes(&icon_bytes)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Claude Usage")
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "open" => crate::ipc::open_dashboard(app.clone()),
                "refresh" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::scheduler::poll_once(&h).await;
                        // event already emitted inside poll_once path
                    });
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let h = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::scheduler::poll_once(&h).await;
                });
            }
        })
        .build(app)?;

    // Listen for usage-updated to refresh icon bitmap.
    let app_clone = app.clone();
    app.listen("usage-updated", move |ev| {
        if let Ok(snap) = serde_json::from_str::<UsageSnapshot>(ev.payload()) {
            let bytes = render_rings(
                Some(snap.five_hour.utilization as f32),
                Some(snap.seven_day.utilization as f32),
            );
            if let Some(tray) = app_clone.tray_by_id(TRAY_ID) {
                if let Ok(img) = Image::from_bytes(&bytes) {
                    let _ = tray.set_icon(Some(img));
                }
            }
        }
    });

    // Update icon immediately from cached state if we have one.
    {
        let state = app.state::<AppState>();
        if let Some(snap) = state.current_usage.lock().unwrap().clone() {
            let bytes = render_rings(
                Some(snap.five_hour.utilization as f32),
                Some(snap.seven_day.utilization as f32),
            );
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                if let Ok(img) = Image::from_bytes(&bytes) {
                    let _ = tray.set_icon(Some(img));
                }
            }
        }
    }

    Ok(())
}
```

- [ ] **Step 2: Call `tray::setup` from `.setup(...)` in `lib.rs`**

Update the setup closure:

```rust
.setup(|app| {
    log::info!("claude-usage-tauri started");
    crate::tray::setup(app.handle())?;
    crate::scheduler::spawn(app.handle().clone());
    Ok(())
})
```

Also add `pub mod tray;` at the top of `lib.rs`.

- [ ] **Step 3: Build and smoke test**

```bash
cd tauri
cargo tauri dev
```

Expected:
- App launches, tray icon appears.
- Left-click triggers `poll_once` (will fail with no session — that's fine here).
- Right-click shows menu "Open Dashboard / Refresh Now / Quit".
- "Quit" terminates the app.

Close the app.

- [ ] **Step 4: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: mount tray icon with menu and click-to-refresh"
```

---

## Task 11: Port dashboard HTML/CSS/JS to `dist/`

**Files:**
- Copy (don't modify originals): all files from `src/renderer/*` to `tauri/dist/`
- Modify: `tauri/dist/dashboard.js` (replace `window.electron.*` with `invoke()`)
- Modify: `tauri/tauri.conf.json` (point `frontendDist` + main window URL to `dashboard.html`)
- Delete: `tauri/dist/index.html` (replaced by `dashboard.html`)

- [ ] **Step 1: Copy dashboard assets**

```bash
cp src/renderer/dashboard.html tauri/dist/dashboard.html
cp src/renderer/dashboard.css tauri/dist/dashboard.css
cp src/renderer/dashboard.js tauri/dist/dashboard.js
mkdir -p tauri/dist/modules
cp src/renderer/modules/formatters.js tauri/dist/modules/formatters.js
cp src/renderer/modules/chart.js tauri/dist/modules/chart.js
cp src/renderer/modules/stats.js tauri/dist/modules/stats.js
rm tauri/dist/index.html
```

(Skip `src/renderer/modules/sync-settings.js` and `src/renderer/modules/settings.js` for MVP; sync is cut, settings will be re-wired in Step 3.)

- [ ] **Step 2: Update `tauri.conf.json`**

Change the main window entry to point to `dashboard.html`:

```json
"windows": [
  {
    "label": "main",
    "title": "Claude Usage",
    "url": "dashboard.html",
    "width": 900,
    "height": 640,
    "resizable": true,
    "visible": false,
    "decorations": true
  }
]
```

- [ ] **Step 3: Create a compatibility shim exposing `window.electronAPI`**

The current dashboard binds to `window.electronAPI` (defined in
`src/renderer/preload.js`). Instead of rewriting every call site in
`dashboard.js`, we create a new file `tauri/dist/electron-api-shim.js` that
builds the same `window.electronAPI` object on top of Tauri IPC. This keeps
`dashboard.js` edits minimal.

Create `tauri/dist/electron-api-shim.js`:

```js
// Tauri compatibility shim: rebuilds window.electronAPI on top of Tauri IPC.
// MVP-scoped. Methods backing dropped features (sync, piper, token stats,
// update-state IPC) are no-op stubs that return sensible defaults.

(function () {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const listen = T.event.listen;

  const bridge = {
    // --- Usage + history ---
    getUsageHistory: () => invoke('get_history', { limit: null }),

    // --- Settings ---
    getSettings: () => invoke('get_settings'),
    saveSettings: async (settings) => {
      try { await invoke('save_settings', { updated: settings }); }
      catch (e) { console.error('save_settings failed', e); }
    },
    logout: () => invoke('logout'),

    // --- Login (new in Tauri; dashboard must call this) ---
    startLogin: () => invoke('start_login'),
    authStatus: () => invoke('auth_status'),

    // --- Update state: plugin owns this; stubs return a safe default ---
    getUpdateState: async () => ({ state: 'idle', version: await invoke('__noop_version').catch(() => null) }),
    downloadUpdate: () => {},
    downloadAndInstall: () => {},
    installUpdate: () => {},
    checkForUpdates: () => {},
    copyLogs: () => {},
    getAppVersion: async () => {
      const meta = await T.app.getVersion();
      return meta;
    },
    getPlatform: async () => 'win32',
    openExternal: (url) => T.shell?.open?.(url),

    onUpdateStateChange: (_cb) => () => {},
    onHistoryUpdated: (cb) => {
      const unlisten = listen('usage-updated', (e) => cb(e.payload));
      return () => unlisten.then((u) => u());
    },

    // --- File system (dashboard stats tabs may call this) ---
    checkPathsExist: async (_paths) => ({}),

    // --- Open in explorer / VS Code (optional niceties) ---
    openInExplorer: (p) => T.shell?.open?.(p),
    openInVSCode: (_p) => {},

    // --- Sync (cut from MVP — stubs) ---
    syncRegister: async () => { throw new Error('sync disabled in MVP'); },
    syncLink: async () => { throw new Error('sync disabled in MVP'); },
    syncGenerateLinkCode: async () => { throw new Error('sync disabled in MVP'); },
    syncListDevices: async () => [],
    syncPull: async () => null,
    syncPush: async () => null,

    // --- Token stats (deferred to v2 — stubs) ---
    getTokenHistory: async () => [],
    getActiveSessions: async () => [],
    backfillTranscripts: async () => ({ processed: 0 }),

    // --- Piper TTS (deferred to v2 — stubs) ---
    speakPreview: (_t) => {},
    piperStatus: async () => ({ installed: false }),
    piperInstallBinary: async () => ({ ok: false, reason: 'disabled in MVP' }),
    piperInstallVoice: async () => ({ ok: false, reason: 'disabled in MVP' }),
    onPiperProgress: (_cb) => () => {},
    onTokenHistoryUpdated: (_cb) => () => {},
  };

  window.electronAPI = bridge;
})();
```

- [ ] **Step 4: Load the shim before `dashboard.js`**

Edit `tauri/dist/dashboard.html`. Find the existing `<script src="dashboard.js">` line and add the shim BEFORE it:

```html
<script src="electron-api-shim.js"></script>
<script src="dashboard.js"></script>
```

- [ ] **Step 5: Remove cut-feature UI panels from dashboard.html + modules**

Hunt down and delete (or hide behind a disabled state) these sections of
`tauri/dist/dashboard.html`:
- Sync settings tab + all elements with `data-tab="sync"` / `id="sync-*"`
- Piper / TTS tab + all elements with `id="piper-*"` / `data-tab="piper"`
- Token history chart and related UI with `id="token-*"`

Remove any `<script src="modules/sync-settings.js">` and
`<script src="modules/settings.js">` lines (sync UI).

If deletion is risky, add a single `<style>body .sync-section, body .piper-section { display:none !important; }</style>` at the top and clean up later.

- [ ] **Step 6: Run the app**

```bash
cd tauri
cargo tauri dev
```

Expected: right-click tray → "Open Dashboard" → dashboard window appears with ported UI. If no session, UI prompts for login (start_login is wired in Task 13, so the button will error for now — that's expected).

- [ ] **Step 7: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: port dashboard to Tauri dist with IPC rewiring"
```

---

## Task 12: CDP WebSocket client

**Files:**
- Create: `tauri/src/cdp.rs`
- Modify: `tauri/Cargo.toml` (add `tokio-tungstenite`, `futures-util`, `url`, `rand`)
- Modify: `tauri/src/lib.rs` (`mod cdp;`)

- [ ] **Step 1: Add deps**

```toml
tokio-tungstenite = { version = "0.24", default-features = false, features = ["connect", "rustls-tls-webpki-roots"] }
futures-util = { version = "0.3", default-features = false }
url = "2"
rand = "0.8"
```

- [ ] **Step 2: Write `tauri/src/cdp.rs`**

```rust
//! Minimal Chrome DevTools Protocol client used only to pull cookies after
//! login. We speak one method at a time, reconnecting for each call to avoid
//! managing concurrency.

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// Calls a single CDP method and returns the `result` field.
/// `ws_url` must be the full `ws://127.0.0.1:<port>/devtools/browser/...` URL
/// returned by Chrome's `/json/version` endpoint.
pub async fn call(ws_url: &str, method: &str, params: Value, timeout: Duration)
    -> Result<Value>
{
    let id: u64 = rand::thread_rng().gen_range(1..1_000_000);
    let payload = json!({ "id": id, "method": method, "params": params });

    let (mut ws, _) = connect_async(ws_url).await
        .with_context(|| format!("connect CDP ws {ws_url}"))?;
    ws.send(Message::Text(payload.to_string())).await
        .context("send CDP request")?;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(anyhow!("CDP {method} timed out"));
        }
        let msg = match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(m))) => m,
            Ok(Some(Err(e))) => return Err(e).context("CDP ws recv"),
            Ok(None) => return Err(anyhow!("CDP ws closed before response")),
            Err(_) => return Err(anyhow!("CDP {method} timed out")),
        };
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => return Err(anyhow!("CDP ws closed")),
            _ => continue,
        };
        let v: Value = serde_json::from_str(&text).context("parse CDP msg")?;
        if v.get("id").and_then(|x| x.as_u64()) == Some(id) {
            if let Some(err) = v.get("error") {
                return Err(anyhow!("CDP error: {err}"));
            }
            let result = v.get("result").cloned().unwrap_or(Value::Null);
            let _ = ws.close(None).await;
            return Ok(result);
        }
        // else: some other event (e.g. target created), ignore
    }
}

/// Fetches the browser-level debugger websocket URL from Chrome's HTTP endpoint.
pub async fn browser_ws_url(http_endpoint: &str) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let resp = client.get(format!("{http_endpoint}/json/version")).send().await
        .context("fetch /json/version")?;
    let v: Value = resp.json().await.context("parse /json/version")?;
    v.get("webSocketDebuggerUrl").and_then(|x| x.as_str())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("no webSocketDebuggerUrl in /json/version"))
}
```

- [ ] **Step 3: Register module** in `tauri/src/lib.rs`:

```rust
pub mod cdp;
```

- [ ] **Step 4: Compile check (no tests — network required)**

```bash
cd tauri
cargo build
```

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: add minimal CDP WebSocket client"
```

---

## Task 13: Auth flow (Chrome spawn + sessionKey extraction)

**Files:**
- Create: `tauri/src/auth.rs`
- Modify: `tauri/src/ipc.rs` (add `start_login`)
- Modify: `tauri/src/lib.rs` (`mod auth;`, register command)

Ported from `scripts/test-direct-api-mvp.js` verified 2026-04-18.

- [ ] **Step 1: Write `tauri/src/auth.rs`**

```rust
//! One-time login flow: spawn Chrome, wait for user to log in, extract
//! sessionKey via CDP, kill Chrome.

use crate::cdp;
use crate::paths;
use crate::session;
use anyhow::{anyhow, Context, Result};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

const CDP_PORT: u16 = 9242; // avoid clashes with 9222
const LOGIN_TIMEOUT_SECS: u64 = 5 * 60;

fn find_browser() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let candidates = [
            std::env::var("ProgramFiles").ok().map(|p| format!("{p}/Google/Chrome/Application/chrome.exe")),
            std::env::var("ProgramFiles(x86)").ok().map(|p| format!("{p}/Google/Chrome/Application/chrome.exe")),
            std::env::var("LOCALAPPDATA").ok().map(|p| format!("{p}/Google/Chrome/Application/chrome.exe")),
            std::env::var("ProgramFiles(x86)").ok().map(|p| format!("{p}/Microsoft/Edge/Application/msedge.exe")),
            std::env::var("ProgramFiles").ok().map(|p| format!("{p}/Microsoft/Edge/Application/msedge.exe")),
        ];
        for c in candidates.into_iter().flatten() {
            let p = Path::new(&c);
            if p.exists() { return Some(p.to_path_buf()); }
        }
    }
    None
}

fn spawn_browser(bin: &Path, profile: &Path, port: u16) -> std::io::Result<Child> {
    Command::new(bin)
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--remote-debugging-port={port}"))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("https://claude.ai/login")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

fn kill_browser(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = child.kill(); }
}

pub async fn run(app: AppHandle) -> Result<()> {
    let _ = app.emit("auth-progress", json!({"stage": "waiting-for-browser"}));

    let bin = find_browser()
        .ok_or_else(|| anyhow!("Chrome/Edge not found in standard install locations"))?;
    log::info!("launching browser: {}", bin.display());

    let profile = std::env::temp_dir().join(format!(
        "claude-usage-tauri-login-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&profile).context("create temp profile dir")?;

    let mut child = spawn_browser(&bin, &profile, CDP_PORT)
        .context("spawn browser")?;

    // cleanup guard: make sure we always kill + rm profile
    let cleanup = scopeguard::guard(profile.clone(), |p| {
        let _ = std::fs::remove_dir_all(&p);
    });

    let result = run_inner(&app, &mut child).await;
    kill_browser(&mut child);
    drop(cleanup);

    match result {
        Ok(session_key) => {
            let session_path = paths::session_file()?;
            session::save(&session_path, &session_key)?;
            let _ = app.emit("auth-progress", json!({"stage": "done"}));
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                "auth-progress",
                json!({"stage": "error", "message": e.to_string()}),
            );
            Err(e)
        }
    }
}

async fn run_inner(app: &AppHandle, _child: &mut Child) -> Result<String> {
    // Wait for CDP HTTP to come up
    let http = format!("http://127.0.0.1:{CDP_PORT}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!("Chrome debugger never came up"));
        }
        if reqwest::get(format!("{http}/json/version")).await.is_ok() {
            break;
        }
        sleep(Duration::from_millis(400)).await;
    }

    let _ = app.emit("auth-progress", json!({"stage": "waiting-for-user"}));

    // Poll every ~1.5s for a claude.ai session until timeout
    let deadline = tokio::time::Instant::now()
        + Duration::from_secs(LOGIN_TIMEOUT_SECS);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(anyhow!("login timed out after 5 minutes"));
        }
        let ws_url = cdp::browser_ws_url(&http).await?;
        let cookies_result = cdp::call(
            &ws_url,
            "Storage.getCookies",
            json!({}),
            Duration::from_secs(5),
        ).await;
        if let Ok(result) = cookies_result {
            if let Some(cookies) = result.get("cookies").and_then(|x| x.as_array()) {
                for c in cookies {
                    let name = c.get("name").and_then(|x| x.as_str()).unwrap_or("");
                    let domain = c.get("domain").and_then(|x| x.as_str()).unwrap_or("");
                    if name == "sessionKey" && domain.ends_with("claude.ai") {
                        if let Some(v) = c.get("value").and_then(|x| x.as_str()) {
                            let _ = app.emit("auth-progress", json!({"stage": "extracting"}));
                            return Ok(v.to_string());
                        }
                    }
                }
            }
        }
        sleep(Duration::from_millis(1500)).await;
    }
}
```

- [ ] **Step 2: Add `scopeguard` to `tauri/Cargo.toml`**

```toml
scopeguard = "1"
```

- [ ] **Step 3: Add `start_login` command to `tauri/src/ipc.rs`**

Append:

```rust
#[tauri::command]
pub async fn start_login(app: AppHandle, state: State<'_, AppState>)
    -> Result<(), String>
{
    *state.auth_state.lock().unwrap() = AuthState::InProgress;
    let _ = app.emit("auth-progress", serde_json::json!({"stage": "starting"}));
    match crate::auth::run(app.clone()).await {
        Ok(()) => {
            *state.auth_state.lock().unwrap() = AuthState::LoggedIn;
            // Kick an immediate poll so the dashboard shows data right away.
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::scheduler::poll_once(&h).await;
            });
            Ok(())
        }
        Err(e) => {
            *state.auth_state.lock().unwrap() = AuthState::NeedsLogin;
            Err(e.to_string())
        }
    }
}
```

- [ ] **Step 4: Register in `lib.rs`**

Add `pub mod auth;` and append `ipc::start_login` to `generate_handler!`.

- [ ] **Step 5: Manual end-to-end test**

```bash
cd tauri
cargo tauri dev
```

From dashboard, click "Log in". Expected: Chrome opens with a blank profile on `claude.ai/login`. Log in with your real account. Within 1-2 seconds of reaching the main app, Chrome closes, the dashboard shows usage. Check that `%APPDATA%\claude-usage-tauri\session.txt` now contains the sessionKey.

- [ ] **Step 6: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: add Chrome-CDP login flow with session extraction"
```

---

## Task 14: Hook HTTP server (axum)

**Files:**
- Create: `tauri/src/hook_server.rs`
- Modify: `tauri/Cargo.toml` (add `axum`)
- Modify: `tauri/src/lib.rs` (spawn hook server in `.setup`)

Port of `src/core/hook-server.js`. Receives Claude Code CLI stop/notify pings.

- [ ] **Step 1: Add `axum` to `tauri/Cargo.toml`**

```toml
axum = { version = "0.7", default-features = false, features = ["http1", "json", "tokio"] }
```

- [ ] **Step 2: Write `tauri/src/hook_server.rs`**

```rust
//! Local HTTP server that accepts Claude Code CLI stop/notify hook pings.

use crate::paths;
use crate::settings;
use crate::state::AppState;
use crate::types::Settings;
use anyhow::Result;
use axum::{extract::State as AxState, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;

#[derive(Clone)]
struct HookCtx { app: AppHandle }

#[derive(Deserialize, Debug)]
struct HookPayload {
    #[serde(default)]
    event: String,
    #[serde(default)]
    project: String,
}

async fn on_hook(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<HookPayload>,
) -> Json<serde_json::Value> {
    log::info!("hook received: event={} project={}", payload.event, payload.project);
    let _ = ctx.app.emit(
        "hook-ping",
        json!({ "event": payload.event, "project": payload.project }),
    );
    Json(json!({"ok": true}))
}

pub async fn spawn(app: AppHandle) -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    log::info!("hook server listening on 127.0.0.1:{port}");

    // Persist port to settings for hook client discovery.
    {
        let state = app.state::<AppState>();
        let mut s: Settings = state.settings.lock().unwrap().clone();
        s.hook_port = Some(port);
        *state.settings.lock().unwrap() = s.clone();
        let path = paths::settings_file()?;
        let _ = settings::save(&path, &s);
        let _ = app.emit("settings-changed", s);
    }

    let ctx = Arc::new(HookCtx { app: app.clone() });
    let router = Router::new()
        .route("/hook", post(on_hook))
        .with_state(ctx);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        ).await {
            log::error!("hook server exited: {e}");
        }
    });

    Ok(port)
}
```

- [ ] **Step 3: Register module + spawn** in `tauri/src/lib.rs`

Add `pub mod hook_server;` at the top. Update the `.setup` to spawn it:

```rust
.setup(|app| {
    log::info!("claude-usage-tauri started");
    crate::tray::setup(app.handle())?;
    crate::scheduler::spawn(app.handle().clone());
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::hook_server::spawn(handle).await {
            log::error!("hook server spawn failed: {e}");
        }
    });
    Ok(())
})
```

- [ ] **Step 4: Build**

```bash
cd tauri
cargo build
```

- [ ] **Step 5: Smoke test the hook**

Start the app with `cargo tauri dev`. In another shell:

```bash
PORT=$(cat ~/AppData/Roaming/claude-usage-tauri/settings.json | grep hook_port | grep -o '[0-9]*')
curl -X POST http://127.0.0.1:$PORT/hook -H "Content-Type: application/json" -d '{"event":"stop","project":"test"}'
```

Expected: `{"ok":true}` response, `hook received: event=stop project=test` in the app's log.

- [ ] **Step 6: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: add axum hook server with ephemeral port"
```

---

## Task 15: Autostart + auto-update plugins

**Files:**
- Modify: `tauri/Cargo.toml` (add `tauri-plugin-autostart`, `tauri-plugin-updater`)
- Modify: `tauri/src/lib.rs` (register plugins)
- Modify: `tauri/tauri.conf.json` (updater config, signing key placeholder)

- [ ] **Step 1: Add plugins to `tauri/Cargo.toml`**

```toml
tauri-plugin-autostart = "2.0"
tauri-plugin-updater = "2.0"
```

- [ ] **Step 2: Register plugins in `tauri/src/lib.rs`**

Update the `tauri::Builder` chain, adding BEFORE `.manage(state)`:

```rust
.plugin(tauri_plugin_autostart::init(
    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
    Some(vec![]),
))
.plugin(tauri_plugin_updater::Builder::new().build())
```

- [ ] **Step 3: Apply autostart preference at startup**

In `.setup(...)`, after `tray::setup`, add:

```rust
use tauri_plugin_autostart::ManagerExt;
let autostart = app.autolaunch();
let state = app.state::<AppState>();
let desired = state.settings.lock().unwrap().autostart;
let _ = if desired {
    autostart.enable()
} else {
    autostart.disable()
};
```

- [ ] **Step 4: Generate updater signing keys (one-time)**

```bash
cd tauri
cargo tauri signer generate -w ~/.tauri/claude-usage.key
```

Expected: prints a public key. Save it — we'll paste it into `tauri.conf.json`.

- [ ] **Step 5: Update `tauri.conf.json` with updater config**

Add at the top level of `tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://github.com/SirBepy/claude_usage_in_taskbar/releases/latest/download/latest.json"
    ],
    "pubkey": "PASTE-PUBLIC-KEY-FROM-STEP-4-HERE",
    "dialog": true
  }
}
```

- [ ] **Step 6: Build**

```bash
cd tauri
cargo build
```

- [ ] **Step 7: Commit**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/Cargo.toml tauri/src/lib.rs tauri/tauri.conf.json
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "FEAT: wire autostart and auto-update plugins"
```

- [ ] **Step 8: Add the signing private key to the user's password manager**

Manual action for Joe (not checked in, not in git). Record in `WORKFLOWS_FOR_SIRBEPY.md` per CLAUDE.md rules.

Append to `WORKFLOWS_FOR_SIRBEPY.md` at repo root (create it if missing):

```markdown
1. Save `~/.tauri/claude-usage.key` and its `.pub` partner to a password manager. The private key must NEVER be committed. CI release builds need the private key injected as a GitHub Actions secret named `TAURI_SIGNING_PRIVATE_KEY`.
```

---

## Task 16: Build installer + release workflow

**Files:**
- Create: `.github/workflows/tauri-release.yml`
- Modify: `tauri/.gitignore` (un-ignore `Cargo.lock`)
- Create: `tauri/Cargo.lock` (commit it)

- [ ] **Step 1: Un-ignore and commit the lockfile**

Edit `tauri/.gitignore`. Delete the line `Cargo.lock`. The file should look like:

```
target/
gen/
icons/
```

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add tauri/.gitignore tauri/Cargo.lock
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "CHORE: commit Cargo.lock for reproducible builds"
```

- [ ] **Step 2: Local full build test**

```bash
cd tauri
cargo tauri build
```

Expected: produces `target/release/bundle/nsis/Claude Usage_0.1.0_x64-setup.exe`. Verify the installer is under 15 MB.

- [ ] **Step 3: Write `.github/workflows/tauri-release.yml`**

```yaml
name: Tauri Release

on:
  push:
    tags:
      - 'tauri-v*'

jobs:
  build:
    runs-on: windows-latest
    defaults:
      run:
        working-directory: ./tauri
    steps:
      - uses: actions/checkout@v4

      - uses: dtolnay/rust-toolchain@stable

      - name: Cache cargo
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: tauri

      - name: Install Tauri CLI
        run: cargo install tauri-cli --version "^2.0"

      - name: Build
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: cargo tauri build

      - name: Upload installer
        uses: softprops/action-gh-release@v2
        with:
          files: |
            tauri/target/release/bundle/nsis/*.exe
            tauri/target/release/bundle/nsis/*.nsis.zip
            tauri/target/release/bundle/nsis/latest.json
          tag_name: ${{ github.ref_name }}
          name: Tauri ${{ github.ref_name }}
          draft: true
```

- [ ] **Step 4: Commit workflow**

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar add .github/workflows/tauri-release.yml
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar commit -m "CHORE: add Tauri release GitHub Actions workflow"
```

- [ ] **Step 5: Record manual release steps**

Append to `WORKFLOWS_FOR_SIRBEPY.md`:

```markdown
2. Add GitHub repo secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with the values generated in Task 15 Step 4.
3. To cut a pre-release: `git tag tauri-v0.1.0 && git push origin tauri-v0.1.0`. Check the Actions tab for build progress; the release will land in the Drafts tab — promote it manually after smoke testing the installer.
```

- [ ] **Step 6: Run tests one last time**

```bash
cd tauri
cargo test --lib
```

Expected: all tests pass.

- [ ] **Step 7: Smoke test the installer**

Uninstall any existing Claude Usage from Control Panel. Run `Claude Usage_0.1.0_x64-setup.exe`. Verify:
- App installs without errors.
- Tray icon appears.
- Dashboard opens from tray menu.
- Login flow completes.
- Hourly poll updates the tray icon (accelerate by temporarily setting `poll_interval_secs: 60` in settings.json, restart app).
- Autostart enabled in Task Manager → Startup tab.

- [ ] **Step 8: Commit version bump for first release**

Update `tauri/Cargo.toml` and `tauri/tauri.conf.json` to `0.1.0` (already there). Tag:

```bash
git -C C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar tag tauri-v0.1.0
```

Do NOT `git push --tags` unless Joe explicitly says to — see CLAUDE.md.

---

## Done criteria

All of these must be true before declaring the MVP complete:

- `cargo tauri build` produces an NSIS installer < 15 MB.
- Installed app idles at < 80 MB RAM (verify in Task Manager).
- Tray icon renders dual rings, updates after each poll.
- Dashboard window opens from tray, shows usage + history chart.
- Login flow extracts sessionKey and stores it.
- Hourly poll runs for 7 days without intervention.
- Hook server accepts POSTs and emits `hook-ping` events.
- Autostart works after reboot.
- `cargo test --lib` passes 20+ tests.

---

## Spec-to-task coverage check

| Spec requirement | Covered by |
|---|---|
| Tray icon with dual rings | Tasks 7, 10 |
| Tray context menu (Open / Refresh / Quit) | Task 10 |
| Hourly background poll | Task 9 |
| Login flow (Chrome + CDP + sessionKey) | Tasks 12, 13 |
| Hook HTTP server | Task 14 |
| Dashboard window | Task 11 |
| Settings persistence | Task 3 |
| History persistence | Task 5 |
| Autostart | Task 15 |
| Auto-update | Tasks 15, 16 |
| NSIS installer | Task 16 |
| UsageSnapshot, Settings, AuthState types | Task 2 |
| IPC commands (9 total) | Tasks 8, 9, 13 |
| Events (usage-updated, poll-failed, auth-progress, settings-changed) | Tasks 8, 9, 13, 14 |
| Disk layout (settings.json, history.jsonl, session.txt) | Tasks 3, 4, 5 |
| Error handling: 3 consecutive 401s → NeedsLogin | Task 9 |
| Error handling: settings corruption → defaults | Task 3 |
| Error handling: history corruption → skip line | Task 5 |
| Error handling: hook port in use → pick different | Task 14 (port 0 binds to free port) |
| Tests: scraper, history, settings, icon unit tests | Tasks 3, 5, 6, 7 |
