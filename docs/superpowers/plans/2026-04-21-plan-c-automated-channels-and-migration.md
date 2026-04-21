# Plan C — Automated Channels + Migration + Retire Old App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Plan A and Plan B merged. The Projects view, instance registry, hook endpoints, detector, and first-run hook installer must be in place.

**Goal:** Let the app spawn and manage one automated `claude --remote-control` process per project, with hidden consoles the user can summon on demand. Auto-start configured automations on boot, auto-restart on crash, kill all on quit. Ship a one-click import from `obsidian_claude_remote`'s config, then retire that app: final README pass marking it discontinued, archive the GitHub repo, delete the local clone.

**Architecture:** A new `src/channels.rs` module owns `tokio::process::Child` handles plus per-channel Windows `HWND`s for console show/hide. Spawning uses `cmd /C claude --remote-control …` with `CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP` to match the working pattern from `obsidian_claude_remote`. A per-channel watchdog task awaits `Child::wait()`, registers the instance with the existing Plan B `instances::Registry` (as `Automated`), and triggers exponential-backoff restart when the child dies early. `src/vault_detector.rs` reads Obsidian's vault registry for the import flow. Shutdown kills every child's process tree via `taskkill /T /F`. The old `obsidian_claude_remote` repo gets a discontinuation banner + archived on GitHub before the local clone is deleted.

**Tech Stack:** Rust 2021 (`tokio::process`, `windows` crate with `Win32_UI_WindowsAndMessaging` + `Win32_Foundation`), vanilla JavaScript, vitest.

---

## Spec reference

Implements the channel-lifecycle and migration sections of `docs/superpowers/specs/2026-04-21-channel-management-integration-design.md` — specifically "Automated channel spawn", "Console hwnd resolution + show/hide", "Automated channel crash handling", "App shutdown", "Migration from obsidian_claude_remote", and "Retiring the old app".

## File structure

**Rust, created:**
- `src/channels.rs` — owns automated channels: spawn, kill, restart, show/hide console, autostart_all, kill_all.
- `src/vault_detector.rs` — parses `%APPDATA%\Obsidian\obsidian.json` for auto-detect.

**Rust, modified:**
- `src/types.rs` — add `ChannelStatus` enum.
- `src/state.rs` — expose `channels: Arc<channels::Manager>`.
- `src/ipc.rs` — add `spawn_channel`, `stop_channel`, `restart_channel`, `show_terminal`, `hide_terminal`, `detect_obsidian_vaults`, `import_legacy_obsidian_config`.
- `src/lib.rs` — register new commands; call `channels::autostart_all` at startup after auth; register shutdown hook for `kill_all`.
- `src/hook_server.rs` — when `SessionStart` fires with a pid that matches one of our spawned channels, set `kind = Automated` + `is_remote = true` (instead of default External).
- `Cargo.toml` — add `windows` crate features.

**Frontend, modified:**
- `dist/dashboard.html` — AutomationConfig form + Import legacy modal.
- `dist/dashboard.js` — wire action buttons (show-terminal, restart, stop), AutomationConfig form, legacy import modal.
- `dist/dashboard.css` — AutomationConfig form styles.
- `dist/electron-api-shim.js` — channel methods.

**Tests, created:**
- `tests/channels_restart_policy.rs` — pure-function tests for the exponential-backoff decision logic.
- `tests/vault_detector_parse.rs` — unit tests for Obsidian JSON parsing.
- `tests/legacy_import_parse.rs` — unit tests for the legacy config shape.

**Meta:**
- Subagent pass on `C:/Users/tecno/Desktop/Projects/obsidian_claude_remote` — adds discontinuation banner, commits, pushes, archives on GitHub, deletes local clone.

All tasks committed separately.

---

### Task 1: Add Windows dependency + `ChannelStatus` type

**Files:**
- Modify: `Cargo.toml`
- Modify: `src/types.rs`

- [ ] **Step 1: Add `windows` to `Cargo.toml`**

In `[dependencies]`:

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
    "Win32_Foundation",
    "Win32_UI_WindowsAndMessaging",
    "Win32_System_Threading",
] }
```

- [ ] **Step 2: Add `ChannelStatus` type**

Append to `src/types.rs` (before `#[cfg(test)]`):

```rust
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChannelStatus {
    /// Starting but no child or hwnd yet.
    Starting,
    /// Running with a live child.
    Running,
    /// Exited recently; restart policy may re-spawn.
    Stopped,
    /// Crashed and backoff has exhausted; no automatic restart.
    Crashed,
}
```

- [ ] **Step 3: Append test**

```rust
#[test]
fn channel_status_serializes_lowercase() {
    assert_eq!(
        serde_json::to_string(&ChannelStatus::Running).unwrap(),
        "\"running\""
    );
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test --lib types::tests`

Expected: PASS.

- [ ] **Step 5: Build**

Run: `cargo build`

Expected: clean build with the `windows` crate downloaded.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock src/types.rs
git commit -m "CHORE: add windows crate and ChannelStatus type for channels"
```

---

### Task 2: Scaffold `src/channels.rs` (struct + state, no spawn yet)

**Files:**
- Create: `src/channels.rs`
- Create: `tests/channels_restart_policy.rs`
- Modify: `src/lib.rs` (`pub mod channels;`)

- [ ] **Step 1: Write the restart-policy tests**

Create `tests/channels_restart_policy.rs`:

```rust
use claude_usage_tauri_lib::channels::{next_restart_delay, RestartDecision, RestartState};
use std::time::Duration;

#[test]
fn no_restart_when_user_stopped() {
    let mut st = RestartState::default();
    st.suppress_restart = true;
    let d = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d, RestartDecision::DoNotRestart);
}

#[test]
fn single_immediate_restart_after_stable_run() {
    let mut st = RestartState::default();
    let d = next_restart_delay(&mut st, Duration::from_secs(30));
    assert_eq!(d, RestartDecision::RestartAfter(Duration::from_secs(0)));
}

#[test]
fn exponential_backoff_when_failing_early() {
    let mut st = RestartState::default();
    // First early-exit triggers a 2s delay.
    let d1 = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d1, RestartDecision::RestartAfter(Duration::from_secs(2)));
    // Second early-exit: 4s.
    let d2 = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d2, RestartDecision::RestartAfter(Duration::from_secs(4)));
    // Third: 8s.
    let d3 = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d3, RestartDecision::RestartAfter(Duration::from_secs(8)));
    // Fourth: 16s.
    let d4 = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d4, RestartDecision::RestartAfter(Duration::from_secs(16)));
    // Fifth: 16s cap (no higher).
    let d5 = next_restart_delay(&mut st, Duration::from_secs(1));
    assert_eq!(d5, RestartDecision::RestartAfter(Duration::from_secs(16)));
}

#[test]
fn long_runtime_resets_backoff() {
    let mut st = RestartState::default();
    next_restart_delay(&mut st, Duration::from_secs(1));
    next_restart_delay(&mut st, Duration::from_secs(1));
    // 30s runtime resets counter.
    let d = next_restart_delay(&mut st, Duration::from_secs(30));
    assert_eq!(d, RestartDecision::RestartAfter(Duration::from_secs(0)));
}

#[test]
fn after_cap_and_still_failing_marks_crashed() {
    let mut st = RestartState::default();
    for _ in 0..4 { next_restart_delay(&mut st, Duration::from_secs(1)); }
    // Simulate 5 more cap-delay attempts all failing early → give up.
    for _ in 0..5 {
        let d = next_restart_delay(&mut st, Duration::from_secs(1));
        match d {
            RestartDecision::RestartAfter(_) => continue,
            RestartDecision::GiveUp => return,
            _ => panic!("unexpected: {:?}", d),
        }
    }
    panic!("expected GiveUp after repeated cap-bucket failures");
}
```

- [ ] **Step 2: Create `src/channels.rs` with the policy + skeleton manager**

```rust
//! Owns automated Claude Code channels. One `Channel` per project
//! that has `automation.enabled`. Spawn, kill, restart with
//! exponential backoff on early failure, and Windows console
//! show/hide via HWND manipulation.

use std::time::Duration;

// -------- Restart policy (pure logic — testable without processes) --------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    DoNotRestart,
    RestartAfter(Duration),
    GiveUp,
}

#[derive(Debug, Default, Clone)]
pub struct RestartState {
    pub early_exits_in_a_row: u32,
    pub cap_failures: u32,
    pub suppress_restart: bool,
}

const STABLE_THRESHOLD_SECS: u64 = 5;
const BACKOFFS_SECS: [u64; 4] = [2, 4, 8, 16];
const MAX_CAP_FAILURES: u32 = 5;

pub fn next_restart_delay(state: &mut RestartState, last_runtime: Duration) -> RestartDecision {
    if state.suppress_restart { return RestartDecision::DoNotRestart; }

    if last_runtime.as_secs() >= STABLE_THRESHOLD_SECS {
        // Stable runtime: reset counters, restart immediately.
        state.early_exits_in_a_row = 0;
        state.cap_failures = 0;
        return RestartDecision::RestartAfter(Duration::from_secs(0));
    }

    // Early exit: either step up the backoff ladder or count cap failures.
    if (state.early_exits_in_a_row as usize) < BACKOFFS_SECS.len() {
        let delay = BACKOFFS_SECS[state.early_exits_in_a_row as usize];
        state.early_exits_in_a_row += 1;
        return RestartDecision::RestartAfter(Duration::from_secs(delay));
    }
    state.cap_failures += 1;
    if state.cap_failures >= MAX_CAP_FAILURES {
        return RestartDecision::GiveUp;
    }
    RestartDecision::RestartAfter(Duration::from_secs(*BACKOFFS_SECS.last().unwrap()))
}

// -------- Manager skeleton (spawning arrives in Task 3) --------

use crate::types::ChannelStatus;
use std::collections::HashMap;
use std::sync::Mutex;

pub struct ChannelSnapshot {
    pub project_id: String,
    pub pid: Option<u32>,
    pub status: ChannelStatus,
    pub hwnd: Option<isize>,
}

pub struct Manager {
    channels: Mutex<HashMap<String, ChannelSnapshot>>, // keyed by project_id
}

impl Manager {
    pub fn new() -> Self { Self { channels: Mutex::new(HashMap::new()) } }
    pub fn snapshot(&self, project_id: &str) -> Option<ChannelSnapshot> {
        self.channels.lock().unwrap().get(project_id).map(|s| ChannelSnapshot {
            project_id: s.project_id.clone(),
            pid: s.pid,
            status: s.status,
            hwnd: s.hwnd,
        })
    }
    pub fn list(&self) -> Vec<ChannelSnapshot> {
        self.channels.lock().unwrap().values().map(|s| ChannelSnapshot {
            project_id: s.project_id.clone(),
            pid: s.pid,
            status: s.status,
            hwnd: s.hwnd,
        }).collect()
    }
}
```

- [ ] **Step 3: Expose module**

In `src/lib.rs`: `pub mod channels;`

- [ ] **Step 4: Run tests**

Run: `cargo test --test channels_restart_policy`

Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels.rs src/lib.rs tests/channels_restart_policy.rs
git commit -m "FEAT: channels module skeleton with restart-policy tests"
```

---

### Task 3: Implement `channels::spawn` + hwnd resolution + hide-on-start

**Files:**
- Modify: `src/channels.rs`
- Modify: `src/state.rs` (plumb Manager)

- [ ] **Step 1: Implement spawn**

Extend `src/channels.rs`:

```rust
use crate::types::AutomationConfig;
use std::path::PathBuf;
use tokio::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x00000010;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

#[derive(Debug)]
pub enum SpawnError {
    Io(std::io::Error),
    NonWindows,
}
impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpawnError::Io(e) => write!(f, "io: {e}"),
            SpawnError::NonWindows => write!(f, "channel spawning is Windows-only"),
        }
    }
}
impl std::error::Error for SpawnError {}

pub struct SpawnInput {
    pub project_id: String,
    pub cwd: PathBuf,
    pub session_name_prefix: String,
    pub continue_flag: bool,
}

pub struct SpawnOutput {
    pub pid: u32,
    pub child: tokio::process::Child,
}

#[cfg(windows)]
pub async fn spawn(input: &SpawnInput) -> Result<SpawnOutput, SpawnError> {
    let mut cmd = Command::new("cmd");
    let mut args: Vec<String> = vec![
        "/C".into(),
        "claude".into(),
        "--remote-control".into(),
        "--remote-control-session-name-prefix".into(),
        input.session_name_prefix.clone(),
    ];
    if input.continue_flag { args.push("--continue".into()); }
    cmd.args(&args)
        .current_dir(&input.cwd)
        .creation_flags(CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP);
    let child = cmd.spawn().map_err(SpawnError::Io)?;
    let pid = child.id().unwrap_or(0);
    Ok(SpawnOutput { pid, child })
}

#[cfg(not(windows))]
pub async fn spawn(_input: &SpawnInput) -> Result<SpawnOutput, SpawnError> {
    Err(SpawnError::NonWindows)
}
```

- [ ] **Step 2: Implement hwnd resolution**

Append to `src/channels.rs`:

```rust
#[cfg(windows)]
pub fn find_hwnd_for_pid(pid: u32) -> Option<isize> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId};

    struct Ctx { want_pid: u32, found: isize }
    let mut ctx = Ctx { want_pid: pid, found: 0 };

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
        let mut wpid: u32 = 0;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut wpid));
        if wpid == ctx.want_pid {
            ctx.found = hwnd.0 as isize;
            return BOOL(0); // stop
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut ctx as *mut _ as isize));
    }
    if ctx.found == 0 { None } else { Some(ctx.found) }
}

#[cfg(windows)]
pub fn show_hwnd(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_SHOW};
    unsafe {
        let h = HWND(hwnd as *mut std::ffi::c_void);
        let _ = ShowWindow(h, SW_SHOW);
        let _ = SetForegroundWindow(h);
    }
}

#[cfg(windows)]
pub fn hide_hwnd(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    unsafe {
        let h = HWND(hwnd as *mut std::ffi::c_void);
        let _ = ShowWindow(h, SW_HIDE);
    }
}

#[cfg(not(windows))]
pub fn find_hwnd_for_pid(_pid: u32) -> Option<isize> { None }
#[cfg(not(windows))]
pub fn show_hwnd(_hwnd: isize) {}
#[cfg(not(windows))]
pub fn hide_hwnd(_hwnd: isize) {}

/// Polls up to 20 × 50ms for the main console hwnd to appear after spawn.
pub async fn resolve_console_hwnd(pid: u32) -> Option<isize> {
    for _ in 0..20 {
        if let Some(h) = find_hwnd_for_pid(pid) { return Some(h); }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}
```

- [ ] **Step 3: Plumb `channels::Manager` into `AppState`**

In `src/state.rs`:

```rust
use crate::channels::Manager as ChannelsManager;
// ... existing fields + Arc<Registry> ...
pub channels: Arc<ChannelsManager>,
```

Update `AppState::new()` accordingly:

```rust
channels: Arc::new(ChannelsManager::new()),
```

- [ ] **Step 4: Build**

Run: `cargo build`

Expected: compiles cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/channels.rs src/state.rs
git commit -m "FEAT: channels::spawn plus hwnd resolution and show/hide helpers"
```

---

### Task 4: Implement `start_channel` + watchdog + `kill_channel`

**Files:**
- Modify: `src/channels.rs`

- [ ] **Step 1: Add public start/stop methods**

Append to `src/channels.rs`:

```rust
use tauri::{AppHandle, Emitter, Manager as _};

impl Manager {
    fn put(&self, snap: ChannelSnapshot) {
        let mut g = self.channels.lock().unwrap();
        g.insert(snap.project_id.clone(), snap);
    }
    fn remove(&self, project_id: &str) {
        self.channels.lock().unwrap().remove(project_id);
    }
    fn patch<F: FnOnce(&mut ChannelSnapshot)>(&self, project_id: &str, f: F) {
        if let Some(s) = self.channels.lock().unwrap().get_mut(project_id) { f(s); }
    }
}

/// Fired when a channel lifecycle event happens so the webview can
/// refresh. Payload = `channels::Manager::list()`.
fn emit_changed(app: &AppHandle) {
    let state = app.state::<crate::state::AppState>();
    let snaps: Vec<_> = state.channels.list().into_iter().map(|s| serde_json::json!({
        "project_id": s.project_id,
        "pid": s.pid,
        "status": match s.status {
            ChannelStatus::Starting => "starting",
            ChannelStatus::Running => "running",
            ChannelStatus::Stopped => "stopped",
            ChannelStatus::Crashed => "crashed",
        },
        "hwnd": s.hwnd,
    })).collect();
    let _ = app.emit("channels-changed", snaps);
}

/// Spawns (or re-spawns) the channel for a configured project. Fails
/// if the project does not exist or has no automation configured.
pub async fn start_channel(app: AppHandle, project_id: String) -> Result<(), String> {
    let (cwd, prefix, continue_flag) = {
        let state = app.state::<crate::state::AppState>();
        let guard = state.settings.lock().unwrap();
        let Some(p) = guard.projects.iter().find(|p| p.id == project_id) else {
            return Err(format!("project {project_id} not found"));
        };
        let auto = p.automation.as_ref().ok_or("project has no automation")?;
        let prefix = auto.session_name_prefix.clone().unwrap_or_else(|| p.name.clone());
        (p.path.clone(), prefix, auto.continue_flag)
    };

    let state = app.state::<crate::state::AppState>();
    state.channels.put(ChannelSnapshot { project_id: project_id.clone(), pid: None, status: ChannelStatus::Starting, hwnd: None });
    emit_changed(&app);

    let spawn_out = spawn(&SpawnInput {
        project_id: project_id.clone(),
        cwd,
        session_name_prefix: prefix,
        continue_flag,
    }).await.map_err(|e| e.to_string())?;

    let pid = spawn_out.pid;
    state.channels.patch(&project_id, |s| { s.pid = Some(pid); s.status = ChannelStatus::Running; });

    // Resolve and hide hwnd async.
    let app_h = app.clone();
    let pid_h = pid;
    let proj_h = project_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(hwnd) = resolve_console_hwnd(pid_h).await {
            hide_hwnd(hwnd);
            let s = app_h.state::<crate::state::AppState>();
            s.channels.patch(&proj_h, |s| s.hwnd = Some(hwnd));
            emit_changed(&app_h);
        }
    });

    // Watchdog: await child exit, apply restart policy, recurse if asked.
    let app_w = app.clone();
    let proj_w = project_id.clone();
    tauri::async_runtime::spawn(async move {
        let started_at = std::time::Instant::now();
        let mut child = spawn_out.child;
        let _ = child.wait().await; // ignore exit code; we react to runtime length
        let runtime = started_at.elapsed();

        let state = app_w.state::<crate::state::AppState>();
        let decision = {
            // Get restart state; we stash it on the Snapshot via a parallel map.
            // For simplicity, fetch from a per-project static cache.
            next_decision_for(&state.channels, &proj_w, runtime)
        };

        match decision {
            RestartDecision::DoNotRestart => {
                state.channels.patch(&proj_w, |s| { s.status = ChannelStatus::Stopped; s.pid = None; s.hwnd = None; });
                emit_changed(&app_w);
            }
            RestartDecision::GiveUp => {
                state.channels.patch(&proj_w, |s| { s.status = ChannelStatus::Crashed; s.pid = None; s.hwnd = None; });
                emit_changed(&app_w);
            }
            RestartDecision::RestartAfter(delay) => {
                state.channels.patch(&proj_w, |s| { s.status = ChannelStatus::Stopped; s.pid = None; s.hwnd = None; });
                emit_changed(&app_w);
                tokio::time::sleep(delay).await;
                let _ = Box::pin(start_channel(app_w, proj_w)).await;
            }
        }
    });

    Ok(())
}

/// Pulls or creates a per-project RestartState and computes the next decision.
fn next_decision_for(
    _mgr: &Manager,
    _project_id: &str,
    runtime: std::time::Duration,
) -> RestartDecision {
    static STATE: once_cell::sync::Lazy<std::sync::Mutex<HashMap<String, RestartState>>> =
        once_cell::sync::Lazy::new(|| std::sync::Mutex::new(HashMap::new()));
    let mut guard = STATE.lock().unwrap();
    let st = guard.entry(_project_id.to_string()).or_default();
    next_restart_delay(st, runtime)
}

/// Stop without auto-restart. Kills the tree on Windows via taskkill.
pub fn stop_channel(app: &AppHandle, project_id: &str) -> Result<(), String> {
    let state = app.state::<crate::state::AppState>();
    let (pid, hwnd) = match state.channels.snapshot(project_id) {
        Some(s) => (s.pid, s.hwnd),
        None => return Ok(()),
    };
    // Mark suppress so the watchdog's restart path takes DoNotRestart.
    {
        static STATE: once_cell::sync::Lazy<std::sync::Mutex<HashMap<String, RestartState>>> =
            once_cell::sync::Lazy::new(|| std::sync::Mutex::new(HashMap::new()));
        let mut g = STATE.lock().unwrap();
        g.entry(project_id.to_string()).or_default().suppress_restart = true;
    }
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    if let Some(h) = hwnd { hide_hwnd(h); }
    state.channels.patch(project_id, |s| { s.status = ChannelStatus::Stopped; s.pid = None; s.hwnd = None; });
    emit_changed(app);
    Ok(())
}

pub async fn restart_channel(app: AppHandle, project_id: String) -> Result<(), String> {
    stop_channel(&app, &project_id)?;
    // Clear suppress so next spawn's watchdog restores default policy.
    {
        static STATE: once_cell::sync::Lazy<std::sync::Mutex<HashMap<String, RestartState>>> =
            once_cell::sync::Lazy::new(|| std::sync::Mutex::new(HashMap::new()));
        let mut g = STATE.lock().unwrap();
        g.entry(project_id.clone()).or_default().suppress_restart = false;
    }
    start_channel(app, project_id).await
}

fn kill_tree(pid: u32) {
    // taskkill /T /F /PID <pid> — kills the entire process tree.
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .output();
}

/// Called on app shutdown. Fire-and-forget tree kills for every channel.
pub fn kill_all(app: &AppHandle) {
    let state = app.state::<crate::state::AppState>();
    for snap in state.channels.list() {
        if let Some(pid) = snap.pid { kill_tree(pid); }
    }
}

pub async fn autostart_all(app: AppHandle) {
    let state = app.state::<crate::state::AppState>();
    let to_start: Vec<String> = state
        .settings
        .lock()
        .unwrap()
        .projects
        .iter()
        .filter(|p| p.automation.as_ref().map(|a| a.enabled && a.autostart_on_boot).unwrap_or(false))
        .map(|p| p.id.clone())
        .collect();
    for id in to_start {
        if let Err(e) = start_channel(app.clone(), id.clone()).await {
            log::warn!("autostart failed for {id}: {e}");
        }
    }
}
```

- [ ] **Step 2: Add `once_cell` dep if missing**

Check: `grep once_cell Cargo.toml`

If absent, add `once_cell = "1"` to `[dependencies]`.

- [ ] **Step 3: Expose `channels` public API surface**

Re-exports aren't needed since all items are `pub` and in `src/channels.rs` already.

- [ ] **Step 4: Build**

Run: `cargo build`

Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add src/channels.rs Cargo.toml Cargo.lock
git commit -m "FEAT: channel start/stop/restart/autostart with watchdog + tree-kill"
```

---

### Task 5: Integrate spawn PID into hook dispatch (`kind = Automated`)

**Files:**
- Modify: `src/hook_server.rs`

- [ ] **Step 1: Cross-reference channel manager on SessionStart**

In `src/hook_server.rs::on_session_start`, replace:

```rust
kind: crate::types::InstanceKind::External,
is_remote: false,
```

with:

```rust
// If the PID belongs to one of our spawned channels, treat as Automated + remote.
let (kind, is_remote) = {
    let pid = payload.pid.unwrap_or(0);
    let state2 = ctx.app.state::<AppState>();
    let is_ours = state2.channels.list().iter().any(|c| c.pid == Some(pid));
    if is_ours {
        (crate::types::InstanceKind::Automated, true)
    } else {
        (crate::types::InstanceKind::External, false)
    }
};
// ... then use `kind` and `is_remote` in the RegisterInput.
```

And update the `RegisterInput` construction to use `kind` and `is_remote`.

- [ ] **Step 2: Build**

Run: `cargo build`

Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/hook_server.rs
git commit -m "FEAT: hook server tags spawned-channel instances as Automated + remote"
```

---

### Task 6: Add channel IPC commands + shim methods

**Files:**
- Modify: `src/ipc.rs`
- Modify: `src/lib.rs`
- Modify: `dist/electron-api-shim.js`

- [ ] **Step 1: Add commands to `src/ipc.rs`**

```rust
#[tauri::command]
pub async fn spawn_channel(project_id: String, app: AppHandle) -> Result<(), String> {
    crate::channels::start_channel(app, project_id).await
}

#[tauri::command]
pub fn stop_channel(project_id: String, app: AppHandle) -> Result<(), String> {
    crate::channels::stop_channel(&app, &project_id)
}

#[tauri::command]
pub async fn restart_channel(project_id: String, app: AppHandle) -> Result<(), String> {
    crate::channels::restart_channel(app, project_id).await
}

#[tauri::command]
pub fn show_terminal(project_id: String, state: State<AppState>) -> Result<(), String> {
    let snap = state.channels.snapshot(&project_id)
        .ok_or("no channel for that project")?;
    let hwnd = snap.hwnd.ok_or("console not resolved yet")?;
    crate::channels::show_hwnd(hwnd);
    Ok(())
}

#[tauri::command]
pub fn hide_terminal(project_id: String, state: State<AppState>) -> Result<(), String> {
    let snap = state.channels.snapshot(&project_id)
        .ok_or("no channel for that project")?;
    let hwnd = snap.hwnd.ok_or("console not resolved yet")?;
    crate::channels::hide_hwnd(hwnd);
    Ok(())
}

#[tauri::command]
pub fn list_channels(state: State<AppState>) -> Vec<serde_json::Value> {
    state.channels.list().into_iter().map(|s| serde_json::json!({
        "project_id": s.project_id,
        "pid": s.pid,
        "status": match s.status {
            crate::types::ChannelStatus::Starting => "starting",
            crate::types::ChannelStatus::Running => "running",
            crate::types::ChannelStatus::Stopped => "stopped",
            crate::types::ChannelStatus::Crashed => "crashed",
        },
        "has_hwnd": s.hwnd.is_some(),
    })).collect()
}
```

- [ ] **Step 2: Register in `src/lib.rs`**

Inside `generate_handler![...]`:

```rust
ipc::spawn_channel,
ipc::stop_channel,
ipc::restart_channel,
ipc::show_terminal,
ipc::hide_terminal,
ipc::list_channels,
```

- [ ] **Step 3: Extend the shim**

In `dist/electron-api-shim.js`:

```javascript
// --- Channels ---
spawnChannel: async (projectId) => {
  try { await invoke('spawn_channel', { projectId }); }
  catch (e) { console.error('spawn_channel failed', e); throw e; }
},
stopChannel: async (projectId) => {
  try { await invoke('stop_channel', { projectId }); }
  catch (e) { console.error('stop_channel failed', e); throw e; }
},
restartChannel: async (projectId) => {
  try { await invoke('restart_channel', { projectId }); }
  catch (e) { console.error('restart_channel failed', e); throw e; }
},
showTerminal: async (projectId) => {
  try { await invoke('show_terminal', { projectId }); }
  catch (e) { console.error('show_terminal failed', e); throw e; }
},
hideTerminal: async (projectId) => {
  try { await invoke('hide_terminal', { projectId }); }
  catch (e) { console.error('hide_terminal failed', e); throw e; }
},
listChannels: () => invoke('list_channels'),
onChannelsChanged: (cb) => {
  const unlisten = T.event.listen('channels-changed', (e) => cb(e.payload));
  return () => unlisten.then((u) => u());
},
```

- [ ] **Step 4: Build**

Run: `cargo build`

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/ipc.rs src/lib.rs dist/electron-api-shim.js
git commit -m "FEAT: IPC + shim methods for channel spawn/stop/restart/terminal"
```

---

### Task 7: Wire autostart at app boot + kill_all on shutdown

**Files:**
- Modify: `src/lib.rs`

- [ ] **Step 1: Call `autostart_all` after auth completes**

Inside `setup(|app| { ... })` in `src/lib.rs`, after the detector spawn (added in Plan B Task 7) and after auth/hook-server setup, add:

```rust
{
    let h = app.handle().clone();
    tauri::async_runtime::spawn(async move { crate::channels::autostart_all(h).await });
}
```

- [ ] **Step 2: Register shutdown hook**

Find the `.run(...)` block or the `.build()` chain and add a Tauri `on_window_event` or app `on_exit` listener. In Tauri 2, the simplest way is at the end of `setup`:

```rust
{
    use tauri::RunEvent;
    let h = app.handle().clone();
    let _ = h; // capture
}
```

Instead, move the kill-all into the `app.run(move |app, event| { ... })` site:

Locate the call to `.run(tauri::generate_context!())` or similar in `lib.rs`. If the existing code uses `.run()` terminal form, switch it to `.run(move |h, event| { ... })` and handle:

```rust
.build(tauri::generate_context!())
.expect("error building tauri application")
.run(|app_handle, event| {
    if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
        crate::channels::kill_all(app_handle);
    }
});
```

- [ ] **Step 3: Build**

Run: `cargo build`

Expected: clean. Test by running `cargo tauri dev`, launching a claude terminal via an automation (Task 8+ wires the UI; temporarily invoke `spawn_channel` from the browser console to test).

- [ ] **Step 4: Commit**

```bash
git add src/lib.rs
git commit -m "FEAT: autostart automations at boot and kill tree on app exit"
```

---

### Task 8: AutomationConfig form in Project detail

**Files:**
- Modify: `dist/dashboard.html`
- Modify: `dist/dashboard.css`
- Modify: `dist/dashboard.js`

- [ ] **Step 1: Add the form markup**

In `view-project-detail` body, below the Running Instances section and above the existing detail content, add:

```html
<section class="automation-section" id="automationSection">
    <div class="section-title">Automation</div>
    <div id="automationEmpty" class="no-data">
        No automation configured. Click <b>+ Automate channel</b> to have this project's Claude Code session start at boot and stay alive.
    </div>
    <div id="automationForm" style="display:none">
        <div class="option">
            <span class="option-label">Enabled</span>
            <label class="switch"><input type="checkbox" id="automationEnabled"><span class="slider"></span></label>
        </div>
        <div class="option">
            <span class="option-label">Start on boot</span>
            <label class="switch"><input type="checkbox" id="automationAutostart"><span class="slider"></span></label>
        </div>
        <div class="option">
            <span class="option-label">Continue previous session (<code>--continue</code>)</span>
            <label class="switch"><input type="checkbox" id="automationContinue"><span class="slider"></span></label>
        </div>
        <div class="option">
            <span class="option-label">Session name prefix</span>
            <input type="text" id="automationPrefix" class="inline-input" placeholder="(uses project name)">
        </div>
        <div style="display:flex;gap:6px;margin-top:8px">
            <button class="btn-secondary" id="automationRemoveBtn">Remove automation</button>
            <div style="flex:1"></div>
            <button class="btn-primary" id="automationApplyBtn">Apply</button>
        </div>
    </div>
</section>
```

- [ ] **Step 2: Minor CSS**

Append:

```css
.automation-section { margin-top: 16px; }
.automation-section .inline-input {
  background: var(--bg-sunken, #15151e);
  border: 1px solid var(--border, #2a2a3a);
  color: var(--text, #e4e4ee);
  padding: 5px 8px;
  border-radius: 5px;
  font-size: 0.78rem;
  width: 160px;
}
```

- [ ] **Step 3: Wire the form in `dist/dashboard.js`**

```javascript
async function renderAutomationForm() {
  if (!projectDetailState.cwd) return;
  const projects = await window.electronAPI.listProjects();
  const proj = projects.find((p) => p.path === projectDetailState.cwd);
  const empty = document.getElementById("automationEmpty");
  const form = document.getElementById("automationForm");
  if (!proj || !proj.automation) {
    empty.style.display = "block"; form.style.display = "none";
    return;
  }
  empty.style.display = "none"; form.style.display = "block";
  document.getElementById("automationEnabled").checked = !!proj.automation.enabled;
  document.getElementById("automationAutostart").checked = !!proj.automation.autostart_on_boot;
  document.getElementById("automationContinue").checked = !!proj.automation.continue_flag;
  document.getElementById("automationPrefix").value = proj.automation.session_name_prefix || "";
  form.dataset.projectId = proj.id;
}

document.getElementById("automateChannelBtn").onclick = async () => {
  // Override the Plan A toast placeholder with real creation.
  if (!projectDetailState.cwd) return;
  const projects = await window.electronAPI.listProjects();
  const proj = projects.find((p) => p.path === projectDetailState.cwd);
  if (!proj) return showToast("Project not found.");
  await window.electronAPI.updateProject(proj.id, {
    automation: {
      enabled: false,
      autostart_on_boot: true,
      session_name_prefix: null,
      continue_flag: true,
    },
  });
  await renderAutomationForm();
  showToast("Automation added. Flip Enabled to start it.");
};

document.getElementById("automationApplyBtn").onclick = async () => {
  const projectId = document.getElementById("automationForm").dataset.projectId;
  const enabled = document.getElementById("automationEnabled").checked;
  const autostart = document.getElementById("automationAutostart").checked;
  const cont = document.getElementById("automationContinue").checked;
  const prefix = document.getElementById("automationPrefix").value.trim() || null;
  await window.electronAPI.updateProject(projectId, {
    automation: {
      enabled, autostart_on_boot: autostart,
      session_name_prefix: prefix, continue_flag: cont,
    },
  });
  if (enabled) {
    try { await window.electronAPI.spawnChannel(projectId); }
    catch (e) { showToast(`Spawn failed: ${e}`); }
  } else {
    try { await window.electronAPI.stopChannel(projectId); } catch {}
  }
  showToast("Automation updated.");
};

document.getElementById("automationRemoveBtn").onclick = async () => {
  const projectId = document.getElementById("automationForm").dataset.projectId;
  try { await window.electronAPI.stopChannel(projectId); } catch {}
  await window.electronAPI.updateProject(projectId, { automation: null });
  await renderAutomationForm();
  showToast("Automation removed.");
};

// Call after opening detail view.
const _prevOpen = openProjectDetail;
openProjectDetail = function(cwd) {
  _prevOpen(cwd);
  renderAutomationForm();
};
```

- [ ] **Step 4: Sanity run**

Run: `cargo tauri dev`

Test: open Projects → pick any card → click "+ Automate channel" → form appears → enable + apply. Verify `claude --remote-control` spawns in the project dir and the hidden terminal is there (confirm via Task Manager: a `conhost.exe` + `node.exe` under the app).

- [ ] **Step 5: Commit**

```bash
git add dist/dashboard.html dist/dashboard.css dist/dashboard.js
git commit -m "FEAT: Automation config form in Project detail with spawn wiring"
```

---

### Task 9: Wire action buttons on instance rows (terminal / restart / stop)

**Files:**
- Modify: `dist/dashboard.js`

- [ ] **Step 1: Update `instanceRowHtml` + handlers**

Extend the row renderer added in Plan B to include `data-project-id` on each button, and attach handlers:

```javascript
function instanceRowHtml(i) {
  const uptime = uptimeFrom(i.started_at);
  const kindClass = i.kind === "external" ? "external" : "";
  const kindTag = i.kind === "automated" ? "Automated" : "External";
  const kindTagClass = i.kind === "automated" ? "automated" : "";
  const remoteTag = i.is_remote ? `<span class="tag remote">📱</span>` : "";
  const phoneDisabled = i.bridge_session_id ? "" : "disabled";
  const automatedOnlyDisabled = i.kind === "automated" ? "" : "disabled";
  const pid = i.project_id; // reused for action attrs
  return `
    <div class="instance-row ${kindClass}">
      <div class="status-dot"></div>
      <div class="meta">
        <div class="top">
          <span class="tag ${kindTagClass}">${kindTag}</span>${remoteTag}
          <span>pid ${i.pid}</span>
        </div>
        <div class="sub">up ${uptime} · session ${i.session_id.slice(0, 8)}…</div>
      </div>
      <div class="actions">
        <button class="act-btn term-btn" data-project-id="${pid}" ${automatedOnlyDisabled} title="Show terminal">term</button>
        <button class="act-btn phone-link-btn" data-session-id="${i.session_id}" ${phoneDisabled} title="Copy phone link">phone</button>
        <button class="act-btn restart-btn" data-project-id="${pid}" ${automatedOnlyDisabled} title="Restart">restart</button>
        <button class="act-btn stop-btn" data-project-id="${pid}" ${automatedOnlyDisabled} title="Stop">stop</button>
      </div>
    </div>
  `;
}
```

Inside `renderRunningInstances`, after setting `innerHTML`, extend the wiring:

```javascript
listEl.querySelectorAll(".term-btn").forEach((btn) => {
  btn.onclick = async () => {
    try { await window.electronAPI.showTerminal(btn.dataset.projectId); }
    catch (e) { showToast(`Show terminal failed: ${e}`); }
  };
});
listEl.querySelectorAll(".restart-btn").forEach((btn) => {
  btn.onclick = async () => {
    try { await window.electronAPI.restartChannel(btn.dataset.projectId); showToast("Restarting…"); }
    catch (e) { showToast(`Restart failed: ${e}`); }
  };
});
listEl.querySelectorAll(".stop-btn").forEach((btn) => {
  btn.onclick = async () => {
    try { await window.electronAPI.stopChannel(btn.dataset.projectId); showToast("Stopped."); }
    catch (e) { showToast(`Stop failed: ${e}`); }
  };
});
```

- [ ] **Step 2: Sanity run**

Run: `cargo tauri dev`

Test: with an automated channel running, click `term` → the hidden console appears. Click `stop` → the row disappears within ~15s. Click `restart` (on a running row) → pid changes.

- [ ] **Step 3: Commit**

```bash
git add dist/dashboard.js
git commit -m "FEAT: wire show-terminal/restart/stop buttons on instance rows"
```

---

### Task 10: `src/vault_detector.rs` + IPC

**Files:**
- Create: `src/vault_detector.rs`
- Create: `tests/vault_detector_parse.rs`
- Modify: `src/ipc.rs`, `src/lib.rs`, `dist/electron-api-shim.js`

- [ ] **Step 1: Write failing tests**

Create `tests/vault_detector_parse.rs`:

```rust
use claude_usage_tauri_lib::vault_detector;

#[test]
fn parses_vault_paths_from_obsidian_json() {
    let raw = r#"{ "vaults": {
        "abc": { "path": "C:/Users/x/Obsidian/Vault1", "ts": 1 },
        "def": { "path": "C:/Users/x/Notes",           "ts": 2 }
    }}"#;
    let got = vault_detector::parse(raw).unwrap();
    let mut paths: Vec<_> = got.iter().map(|p| p.to_string_lossy().to_string()).collect();
    paths.sort();
    assert_eq!(paths, vec!["C:/Users/x/Notes", "C:/Users/x/Obsidian/Vault1"]);
}

#[test]
fn returns_empty_when_vaults_missing() {
    let got = vault_detector::parse("{}").unwrap();
    assert!(got.is_empty());
}

#[test]
fn tolerates_malformed_entries() {
    let raw = r#"{ "vaults": {
        "abc": { "path": "C:/x" },
        "def": "garbage",
        "ghi": {}
    }}"#;
    let got = vault_detector::parse(raw).unwrap();
    assert_eq!(got.len(), 1);
}
```

- [ ] **Step 2: Create `src/vault_detector.rs`**

```rust
//! Parses Obsidian's vault registry from `%APPDATA%\Obsidian\obsidian.json`.

use anyhow::Result;
use std::path::PathBuf;

pub fn parse(raw: &str) -> Result<Vec<PathBuf>> {
    let v: serde_json::Value = serde_json::from_str(raw)?;
    let Some(vaults) = v.get("vaults").and_then(|v| v.as_object()) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for (_, entry) in vaults {
        if let Some(p) = entry.get("path").and_then(|p| p.as_str()) {
            out.push(PathBuf::from(p));
        }
    }
    Ok(out)
}

pub fn detect() -> Result<Vec<PathBuf>> {
    let Some(appdata) = dirs::config_dir() else { return Ok(vec![]) };
    // On Windows `config_dir()` = %APPDATA%/Roaming.
    let path = appdata.join("Obsidian").join("obsidian.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    parse(&raw)
}
```

- [ ] **Step 3: Expose + add IPC**

In `src/lib.rs`: `pub mod vault_detector;` and register:

```rust
ipc::detect_obsidian_vaults,
```

In `src/ipc.rs`:

```rust
#[tauri::command]
pub fn detect_obsidian_vaults() -> Vec<std::path::PathBuf> {
    crate::vault_detector::detect().unwrap_or_default()
}
```

In the shim:

```javascript
detectObsidianVaults: () => invoke('detect_obsidian_vaults'),
```

- [ ] **Step 4: Tests — expect pass**

Run: `cargo test --test vault_detector_parse`

Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault_detector.rs src/lib.rs src/ipc.rs dist/electron-api-shim.js tests/vault_detector_parse.rs
git commit -m "FEAT: Obsidian vault detector for automation picker"
```

---

### Task 11: Legacy import (`obsidian_claude_remote` config → automation)

**Files:**
- Modify: `src/ipc.rs`, `src/lib.rs`, `dist/electron-api-shim.js`
- Modify: `dist/dashboard.html`, `dist/dashboard.js`
- Create: `tests/legacy_import_parse.rs`

- [ ] **Step 1: Write failing tests**

Create `tests/legacy_import_parse.rs`:

```rust
use claude_usage_tauri_lib::ipc::legacy_import_test_helpers as h;
use claude_usage_tauri_lib::types::Settings;

#[test]
fn parses_old_config_into_project_with_automation() {
    let raw = r#"{ "vault_path": "C:/Users/x/Obsidian/Vault", "auto_registered_startup": true }"#;
    let mut s = Settings::default();
    let project = h::import_into(&mut s, raw, "now").unwrap();
    assert_eq!(s.projects.len(), 1);
    assert_eq!(s.projects[0].path, std::path::PathBuf::from("C:/Users/x/Obsidian/Vault"));
    assert!(s.projects[0].automation.as_ref().unwrap().autostart_on_boot);
    assert_eq!(project.id, s.projects[0].id);
}

#[test]
fn returns_none_when_vault_path_missing() {
    let raw = r#"{ "other": "field" }"#;
    let mut s = Settings::default();
    assert!(h::import_into(&mut s, raw, "now").is_none());
}

#[test]
fn idempotent_when_project_already_imported() {
    let raw = r#"{ "vault_path": "C:/x" }"#;
    let mut s = Settings::default();
    h::import_into(&mut s, raw, "now").unwrap();
    h::import_into(&mut s, raw, "later").unwrap();
    assert_eq!(s.projects.len(), 1);
}
```

- [ ] **Step 2: Implement**

In `src/ipc.rs`:

```rust
pub mod legacy_import_test_helpers {
    use crate::types::{AutomationConfig, ProjectConfig, Settings};

    pub fn import_into(
        settings: &mut Settings,
        legacy_raw: &str,
        now: &str,
    ) -> Option<ProjectConfig> {
        let v: serde_json::Value = serde_json::from_str(legacy_raw).ok()?;
        let vault = v.get("vault_path").and_then(|p| p.as_str())?;
        let (id, _) = crate::settings::upsert_project_for_cwd(settings, std::path::Path::new(vault), now);
        let p = settings.projects.iter_mut().find(|p| p.id == id).unwrap();
        if p.automation.is_none() {
            p.automation = Some(AutomationConfig {
                enabled: true,
                autostart_on_boot: true,
                session_name_prefix: None,
                continue_flag: true,
            });
        }
        Some(p.clone())
    }
}

#[tauri::command]
pub fn import_legacy_obsidian_config(
    state: State<AppState>,
    app: AppHandle,
) -> Result<Option<crate::types::ProjectConfig>, String> {
    let Some(appdata) = dirs::config_dir() else { return Ok(None) };
    let path = appdata.join("obsidian_claude_remote").join("config.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut guard = state.settings.lock().unwrap();
    let imported = legacy_import_test_helpers::import_into(&mut guard, &raw, &now);
    if imported.is_some() {
        let snapshot = guard.clone();
        drop(guard);
        let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
        settings::save(&settings_path, &snapshot).map_err(|e| e.to_string())?;
        let _ = app.emit("settings-changed", snapshot);
    }
    Ok(imported)
}
```

Register in `src/lib.rs`:

```rust
ipc::import_legacy_obsidian_config,
```

Add shim method:

```javascript
importLegacyObsidianConfig: () => invoke('import_legacy_obsidian_config'),
```

- [ ] **Step 3: Add a first-run import banner in `dist/dashboard.html`**

After the hook-registration modal markup:

```html
<div class="banner" id="legacyImportBanner" style="display:none">
    <i class="ph ph-arrow-circle-down"></i>
    <span>Found an existing Obsidian channel from the old tray app. Import it here?</span>
    <button class="btn-primary" id="legacyImportAccept">Import</button>
    <button class="btn-secondary" id="legacyImportDismiss">No thanks</button>
</div>
```

CSS:

```css
.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bg-elevated, #1f1f2c);
  border: 1px solid var(--accent, #4c9eff);
  border-radius: 8px;
  margin: 10px 12px;
  font-size: 0.82rem;
}
.banner i { font-size: 1.2rem; color: var(--accent, #4c9eff); }
```

- [ ] **Step 4: JS**

```javascript
async function maybeOfferLegacyImport() {
  const imported = await window.electronAPI.importLegacyObsidianConfig().catch(() => null);
  const legacyPresent = imported !== null; // null on command error; Some=imported, None=no config
  if (legacyPresent === false) return;
  // If the import already happened (upsert is idempotent), no banner needed.
  // Surface banner only if we actually added a fresh automation.
  if (imported) {
    const banner = document.getElementById("legacyImportBanner");
    banner.style.display = "flex";
    document.getElementById("legacyImportAccept").onclick = () => {
      banner.style.display = "none";
      showToast("Imported. See Projects.");
    };
    document.getElementById("legacyImportDismiss").onclick = async () => {
      banner.style.display = "none";
      // Remove the auto-imported automation the user declined.
      if (imported?.id) {
        await window.electronAPI.updateProject(imported.id, { automation: null });
      }
    };
  }
}
maybeOfferLegacyImport();
```

- [ ] **Step 5: Tests**

Run: `cargo test --test legacy_import_parse`

Expected: 3/3 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ipc.rs src/lib.rs dist/dashboard.html dist/dashboard.css dist/dashboard.js dist/electron-api-shim.js tests/legacy_import_parse.rs
git commit -m "FEAT: import obsidian_claude_remote legacy config into a project automation"
```

---

### Task 12: Subagent final pass on `obsidian_claude_remote` repo

**Files:**
- External: `C:/Users/tecno/Desktop/Projects/obsidian_claude_remote/`

This task runs a subagent against the OLD repo. The subagent has its own git checkout and will commit and push from that directory.

- [ ] **Step 1: Dispatch the subagent**

Use the Agent tool with the `general-purpose` subagent type. Prompt:

```
Target repo: C:/Users/tecno/Desktop/Projects/obsidian_claude_remote

This Python tray app is being discontinued. Its functionality now lives in
C:/Users/tecno/Desktop/Projects/claude_usage_in_taskbar (a Rust Tauri app).

Do a final pass on the old repo:

1. Prepend README.md with a clear DISCONTINUED banner at the top:

   > ⚠ **DISCONTINUED** — This project has been merged into
   > [claude_usage_in_taskbar](https://github.com/SirBepy/claude_usage_in_taskbar).
   > Please migrate: install the new app and click **Import** on first launch.

   Keep the rest of the README intact, but add a "Migration" section right
   after the banner with concrete steps:
   - Download the latest claude_usage_in_taskbar release.
   - Run it; first launch offers to import the obsidian_claude_remote config.
   - Confirm the automated channel is running in the new app.
   - Uninstall obsidian_claude_remote: close tray, delete the .lnk from the
     Windows Startup folder, delete the exe.

2. Create DISCONTINUED.md at the repo root containing the same migration
   steps in more detail.

3. Update CLAUDE.md with a leading note: "Project discontinued on
   YYYY-MM-DD; see README and DISCONTINUED.md. Successor project is
   claude_usage_in_taskbar." Replace YYYY-MM-DD with today's date.

4. Commit everything with:
     chore: mark discontinued, superseded by claude_usage_in_taskbar
   Use the project's commit style (lowercase sentence after prefix).

5. Push to origin/main (or origin/master — check `git branch -vv`).

6. Archive the repo on GitHub via: gh repo archive SirBepy/obsidian_claude_remote
   Confirm with --yes if gh prompts.

Do NOT delete the local clone — I'll do that by hand. Report back with a
short summary of what you did, including commit SHA and whether the
archive succeeded.
```

- [ ] **Step 2: Verify the subagent's work**

After the subagent returns, inspect:
- `C:/Users/tecno/Desktop/Projects/obsidian_claude_remote/README.md` starts with the DISCONTINUED banner.
- `DISCONTINUED.md` exists.
- `CLAUDE.md` has the discontinuation note.
- `git log -1` shows the chore commit.
- `gh repo view SirBepy/obsidian_claude_remote --json isArchived` returns `{"isArchived": true}`.

- [ ] **Step 3: Delete the local clone (manual user step)**

Add a note to `WORKFLOWS_FOR_SIRBEPY.md` (create if absent) for this one-time task:

```
1. Confirm the retire subagent completed (README banner, archived on GitHub).
2. Close any open editors that have obsidian_claude_remote open.
3. Delete the local folder: rmdir /S /Q "C:/Users/tecno/Desktop/Projects/obsidian_claude_remote"
```

Per the global rule: don't actually delete it — the user will.

- [ ] **Step 4: Commit the workflow note**

```bash
git add WORKFLOWS_FOR_SIRBEPY.md
git commit -m "DOCS: workflow note to delete obsidian_claude_remote local clone"
```

---

### Task 13: Smoke + final QA + docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Full test pass**

Run: `cargo test`
Run: `npx vitest run`

Expected: all PASS.

- [ ] **Step 2: End-to-end manual QA**

Run: `cargo tauri dev`

- [ ] Fresh install: hook-registration modal appears; Accept.
- [ ] If the old app's config exists: legacy-import banner appears; Import.
- [ ] Projects view shows imported vault with `⚙` tag.
- [ ] Open Project detail: Automation form shows enabled + autostart + --continue defaults.
- [ ] Apply with Enabled on: a Claude Code session starts; it appears as Automated/📱 in Running instances within ~10s.
- [ ] Click `term`: the hidden console appears.
- [ ] Type into the console: claude responds.
- [ ] Click `phone`: URL copied to clipboard; open on phone → session loads.
- [ ] Close the app: the automated claude process tree is killed within ~5s (verify via Task Manager).
- [ ] Reopen the app: automation auto-spawns again on boot.
- [ ] Flip Enabled off: stopChannel fires; the row disappears.
- [ ] Add a second automated project; both run independently.
- [ ] External claude from VSCode terminal: appears as External row with greyed-out term/restart/stop.

- [ ] **Step 3: Update `CLAUDE.md`**

Append:

```markdown
## Channel management (Plan C)

- `src/channels.rs` owns automated channel lifecycle: spawn, kill tree, restart-with-backoff, show/hide console. Windows-only.
- Spawn uses `cmd /C claude --remote-control --remote-control-session-name-prefix … --continue` with `CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP` so the process gets its own console window (hidden immediately via `ShowWindow(SW_HIDE)`).
- hwnd resolved via `EnumWindows` filtering by owning pid; stored per-channel so show/hide always targets the right console.
- Watchdog `tokio::process::Child::wait()` drives the restart policy in `next_restart_delay` (stable >5s → immediate restart; early exit → 2/4/8/16s backoff; 5 cap-bucket failures → Crashed).
- Kill on shutdown uses `taskkill /T /F /PID <pid>` — claude spawns node subprocesses so tree-kill is required.
- `src/vault_detector.rs` reads `%APPDATA%\Obsidian\obsidian.json` for the automation picker.
- `ipc::import_legacy_obsidian_config` maps the old Python app's config.json into a new ProjectConfig with an auto-configured automation.
- The `obsidian_claude_remote` repo is archived on GitHub as of 2026-04-XX; see its README.
```

- [ ] **Step 4: Update `README.md`**

Append a "Channel management" section below the existing docs:

```markdown
## Channel management

Beyond tracking Claude Code usage, this app now also manages Claude Code
channels per project:

- See every running Claude Code instance on your machine, live.
- Configure "automated channels" per project that start at boot and stay
  alive. A hidden terminal is kept open for each — click **term** on its
  row to bring it to the foreground and type into it directly.
- Copy a phone link for any remote-control session to open it in the
  Claude mobile app.

Replaces the previous `obsidian_claude_remote` tray app (now discontinued
and archived).
```

- [ ] **Step 5: Commit docs**

```bash
git add CLAUDE.md README.md
git commit -m "DOCS: channel management section in CLAUDE.md and README"
```

- [ ] **Step 6: Summary**

Plan C is done. The app now:
- Tracks live Claude Code instances via hooks + detector.
- Spawns and supervises automated channels with hidden consoles.
- Imports `obsidian_claude_remote` config on first launch.
- Retires the old Python app (README banner, archived, local delete note).

Future work (NOT in this plan):
- Desktop sprite animations per project with wave-when-done.
- Avatar image upload UI.
- Multiple automations per project.
- VSCode integrated-terminal attach for external instances.
- QR code phone-link.
- macOS/Linux parity.
