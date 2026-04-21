# Plan B — Instance Detection + Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Plan A (`docs/superpowers/plans/2026-04-21-plan-a-ui-shell-redesign.md`) is merged. The Projects view, Project detail shell, and `ProjectConfig` data model must exist.

**Goal:** Make the app live-aware of every Claude Code instance running on the machine, scoped to projects. Populate the Running Instances section in Project detail, add live-instance count badges on project cards, and register hooks globally in `~/.claude/settings.json` so external instances (VSCode terminals, ad-hoc shells) report themselves. No process spawning — that stays in Plan C.

**Architecture:** Layered detection — Claude Code hooks (`SessionStart`, `SessionEnd`) as the primary signal, a 5-second ps-poll reconciler as a safety net, and `~/.claude/sessions/<pid>.json` enrichment for the `bridgeSessionId` that powers phone links. Hooks land on `hook_server.rs` (existing axum server) at new routes and funnel into a new in-memory `instances.rs` registry. The registry emits `instances-changed` Tauri events; the webview subscribes and re-renders. A one-time global hook installer merges our endpoints into `~/.claude/settings.json` on first launch with user consent.

**Tech Stack:** Rust 2021 (axum, serde, tokio, sysinfo for process enumeration, tempfile for tests, chrono), vanilla JavaScript, vitest.

---

## Spec reference

Implements the detection-related sections of `docs/superpowers/specs/2026-04-21-channel-management-integration-design.md` — specifically "Data flow — instance starts / ends", the `instances.rs` / `detector.rs` / `hook_installer.rs` / `session_files.rs` module specs, and the Running Instances UI on Project detail. Channel spawning and the migration/retire flow are deferred to Plan C.

## File structure

**Rust, created:**
- `src/instances.rs` — in-memory instance registry, lazy project upsert, Tauri event emission.
- `src/detector.rs` — 5s tokio loop that reconciles the registry against the live process list.
- `src/hook_installer.rs` — merges our hook entries into `~/.claude/settings.json`.
- `src/session_files.rs` — reads `~/.claude/sessions/<pid>.json` to resolve `bridgeSessionId`.

**Rust, modified:**
- `src/types.rs` — add `Instance`, `InstanceKind`, `EndReason`, `InstanceSummary`.
- `src/state.rs` — add `instances: Arc<instances::Registry>` and `hook_registration_pending: Mutex<bool>`.
- `src/hook_server.rs` — add `/hooks/session-start` and `/hooks/session-end` routes that dispatch into `instances.rs`.
- `src/settings.rs` — add `upsert_project_for_cwd()` helper.
- `src/ipc.rs` — add `list_instances`, `list_instances_for_project`, `phone_link`, `register_hooks_globally`, `skip_hook_registration`, `get_hook_registration_state`.
- `src/lib.rs` — register the new IPC commands; start detector; trigger hook installer first-run prompt.
- `Cargo.toml` — add `sysinfo` dependency.

**Frontend, modified:**
- `dist/dashboard.html` — add the first-run hook-registration modal.
- `dist/dashboard.js` — listen for `instances-changed`, render running-instances rows, populate project-card badges, handle the hook-registration modal.
- `dist/dashboard.css` — instance row, status dot, tags, hook modal.
- `dist/electron-api-shim.js` — add method wrappers for the new IPC commands; add `onInstancesChanged` listener.

**Tests, created:**
- `tests/instances_registry.rs` — unit tests for register / mark_ended / list / by_project.
- `tests/hook_installer_merge.rs` — unit tests for safe-merge into `~/.claude/settings.json`.
- `tests/session_files_parse.rs` — unit tests for `bridgeSessionId` extraction.
- `tests/detector_reconcile.rs` — unit tests for the 2-tick-dead rule.
- `tests/hook_server_instances.rs` — integration test: POST to `/hooks/session-start`, assert registry populated.
- `tests/running_instances_view.test.mjs` — vitest for the rendering of the Running Instances list.

All tasks MUST be committed separately. Follow the project's `PREFIX: lowercase sentence` commit convention.

---

### Task 1: Add instance types

**Files:**
- Modify: `src/types.rs`

- [ ] **Step 1: Append failing tests**

Append inside the existing `#[cfg(test)] mod tests` in `src/types.rs`:

```rust
#[test]
fn instance_kind_serializes_lowercase() {
    let a = InstanceKind::Automated;
    let e = InstanceKind::External;
    assert_eq!(serde_json::to_string(&a).unwrap(), "\"automated\"");
    assert_eq!(serde_json::to_string(&e).unwrap(), "\"external\"");
}

#[test]
fn end_reason_serializes_kebab_case() {
    let cases: Vec<(EndReason, &str)> = vec![
        (EndReason::HookSessionEnd, "\"hook-session-end\""),
        (EndReason::ProcessGone, "\"process-gone\""),
        (EndReason::ChildExit, "\"child-exit\""),
        (EndReason::Manual, "\"manual\""),
    ];
    for (r, expected) in cases {
        assert_eq!(serde_json::to_string(&r).unwrap(), expected);
    }
}

#[test]
fn instance_roundtrips_json() {
    let i = Instance {
        session_id: "s1".into(),
        pid: 1234,
        cwd: std::path::PathBuf::from("C:/x"),
        project_id: "proj-a".into(),
        kind: InstanceKind::External,
        is_remote: false,
        started_at: "2026-04-21T10:00:00Z".into(),
        transcript_path: Some(std::path::PathBuf::from("C:/t/abc.jsonl")),
        bridge_session_id: None,
        ended_at: None,
        end_reason: None,
    };
    let raw = serde_json::to_string(&i).unwrap();
    let back: Instance = serde_json::from_str(&raw).unwrap();
    assert_eq!(i, back);
}
```

- [ ] **Step 2: Add the types**

Insert before the `#[cfg(test)]` block:

```rust
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstanceKind {
    Automated,
    External,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EndReason {
    HookSessionEnd,
    ProcessGone,
    ChildExit,
    Manual,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Instance {
    pub session_id: String,
    pub pid: u32,
    pub cwd: std::path::PathBuf,
    pub project_id: String,
    pub kind: InstanceKind,
    #[serde(default)]
    pub is_remote: bool,
    pub started_at: String,
    #[serde(default)]
    pub transcript_path: Option<std::path::PathBuf>,
    #[serde(default)]
    pub bridge_session_id: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub end_reason: Option<EndReason>,
}

/// Shape served to the webview. Same as `Instance` for now; kept as a
/// distinct type so future payload tweaks don't require a registry-wide
/// schema change.
pub type InstanceSummary = Instance;
```

- [ ] **Step 3: Run tests — expect pass**

Run: `cargo test --lib types::tests`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/types.rs
git commit -m "FEAT: add Instance types (kind, end reason, shape)"
```

---

### Task 2: Add `upsert_project_for_cwd` helper to `src/settings.rs`

**Files:**
- Modify: `src/settings.rs`

- [ ] **Step 1: Append failing tests**

In `src/settings.rs` tests module:

```rust
#[test]
fn upsert_creates_when_absent() {
    let mut s = Settings::default();
    let (id, created) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/new"), "now");
    assert!(created);
    assert_eq!(s.projects.len(), 1);
    assert_eq!(s.projects[0].id, id);
    assert_eq!(s.projects[0].path, std::path::PathBuf::from("C:/new"));
    assert_eq!(s.projects[0].name, "new");
}

#[test]
fn upsert_returns_existing_when_path_matches() {
    let mut s = Settings::default();
    let (id1, _) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/same"), "now");
    let (id2, created) = upsert_project_for_cwd(&mut s, std::path::Path::new("C:/same"), "later");
    assert!(!created);
    assert_eq!(id1, id2);
    assert_eq!(s.projects.len(), 1);
    assert_eq!(s.projects[0].last_active_at.as_deref(), Some("later"));
}
```

- [ ] **Step 2: Implement the helper**

Add to `src/settings.rs` (after `save`):

```rust
/// Finds or creates a `ProjectConfig` for this cwd. Returns `(id, created_new)`.
///
/// If the project already exists, updates `last_active_at`. If created,
/// populates `id` (uuid v4), `name` (basename), `avatar` (None), and
/// timestamps (`now` comes from the caller so tests can inject).
pub fn upsert_project_for_cwd(
    settings: &mut crate::types::Settings,
    cwd: &std::path::Path,
    now: &str,
) -> (String, bool) {
    if let Some(p) = settings.projects.iter_mut().find(|p| p.path == cwd) {
        p.last_active_at = Some(now.to_string());
        return (p.id.clone(), false);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let name = cwd
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("(unknown)")
        .to_string();
    settings.projects.push(crate::types::ProjectConfig {
        id: id.clone(),
        path: cwd.to_path_buf(),
        name,
        avatar: crate::types::Avatar::None,
        automation: None,
        created_at: now.to_string(),
        last_active_at: Some(now.to_string()),
    });
    (id, true)
}
```

- [ ] **Step 3: Add `uuid` to `Cargo.toml` if absent**

Check: `grep uuid Cargo.toml`

If absent, add to `[dependencies]`:

```toml
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cargo test --lib settings::tests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.rs Cargo.toml Cargo.lock
git commit -m "FEAT: upsert_project_for_cwd helper for lazy project creation"
```

---

### Task 3: Create `src/instances.rs` (registry)

**Files:**
- Create: `src/instances.rs`
- Create: `tests/instances_registry.rs`
- Modify: `src/lib.rs` (add `pub mod instances;`)

- [ ] **Step 1: Write failing integration tests**

Create `tests/instances_registry.rs`:

```rust
use claude_usage_tauri_lib::instances::{Registry, RegisterInput};
use claude_usage_tauri_lib::types::{EndReason, Instance, InstanceKind, Settings};
use std::path::PathBuf;
use std::sync::Mutex;

fn reg() -> Registry { Registry::new() }

fn input(session_id: &str, cwd: &str, pid: u32) -> RegisterInput {
    RegisterInput {
        session_id: session_id.into(),
        cwd: PathBuf::from(cwd),
        pid,
        kind: InstanceKind::External,
        is_remote: false,
        transcript_path: None,
        started_at: "2026-04-21T00:00:00Z".into(),
    }
}

#[test]
fn register_inserts_and_assigns_project_id() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    let (id, _) = r.register(input("s1", "C:/a", 100), &settings, "now");
    let got = r.list();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].session_id, "s1");
    assert_eq!(got[0].project_id, id);
    assert_eq!(settings.lock().unwrap().projects.len(), 1);
}

#[test]
fn register_is_idempotent_on_session_id() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    r.register(input("s1", "C:/a", 100), &settings, "now");
    r.register(input("s1", "C:/a", 100), &settings, "now");
    assert_eq!(r.list().len(), 1);
}

#[test]
fn mark_ended_sets_end_reason_idempotently() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    r.register(input("s1", "C:/a", 100), &settings, "now");
    assert!(r.mark_ended("s1", EndReason::HookSessionEnd, "ended-at"));
    let got = &r.list()[0];
    assert_eq!(got.end_reason, Some(EndReason::HookSessionEnd));
    assert_eq!(got.ended_at.as_deref(), Some("ended-at"));
    // Second mark_ended is a no-op (returns false, keeps first reason).
    assert!(!r.mark_ended("s1", EndReason::ProcessGone, "later"));
    let got2 = &r.list()[0];
    assert_eq!(got2.end_reason, Some(EndReason::HookSessionEnd));
}

#[test]
fn prune_removes_ended_older_than_ttl() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    r.register(input("s1", "C:/a", 100), &settings, "now");
    r.mark_ended("s1", EndReason::Manual, "2026-04-21T00:00:00Z");
    r.prune_ended_before("2026-04-21T00:01:30Z"); // 90s later
    assert!(r.list().is_empty());
}

#[test]
fn by_project_filters_by_project_id() {
    let r = reg();
    let settings = Mutex::new(Settings::default());
    let (proj_a, _) = r.register(input("s1", "C:/a", 100), &settings, "now");
    let (proj_b, _) = r.register(input("s2", "C:/b", 200), &settings, "now");
    let a = r.by_project(&proj_a);
    let b = r.by_project(&proj_b);
    assert_eq!(a.len(), 1);
    assert_eq!(a[0].cwd, PathBuf::from("C:/a"));
    assert_eq!(b[0].cwd, PathBuf::from("C:/b"));
}
```

- [ ] **Step 2: Run tests — expect compile failure**

Run: `cargo test --test instances_registry`

Expected: fails — `instances` module doesn't exist.

- [ ] **Step 3: Create `src/instances.rs`**

```rust
//! In-memory instance registry.
//!
//! Keyed by `session_id`. The canonical source for "what Claude Code
//! processes are currently alive across the machine". Populated by
//! `hook_server.rs` (SessionStart hook), `detector.rs` (ps reconcile),
//! and `channels.rs` (future, Plan C). Any mutation emits an
//! `instances-changed` Tauri event so the webview refreshes.

use crate::settings;
use crate::types::{EndReason, Instance, InstanceKind, Settings};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug)]
pub struct RegisterInput {
    pub session_id: String,
    pub cwd: PathBuf,
    pub pid: u32,
    pub kind: InstanceKind,
    pub is_remote: bool,
    pub transcript_path: Option<PathBuf>,
    pub started_at: String,
}

pub struct Registry {
    inner: Mutex<HashMap<String, Instance>>,
}

impl Registry {
    pub fn new() -> Self { Self { inner: Mutex::new(HashMap::new()) } }

    /// Inserts or updates an instance. Returns `(project_id, created_new)`.
    /// `project_id` is resolved via `settings::upsert_project_for_cwd`.
    /// If the session is already registered, the existing project id is
    /// kept and `created_new` is `false`.
    pub fn register(
        &self,
        input: RegisterInput,
        settings: &Mutex<Settings>,
        now: &str,
    ) -> (String, bool) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(existing) = guard.get(&input.session_id) {
            return (existing.project_id.clone(), false);
        }
        let (project_id, _) = {
            let mut s = settings.lock().unwrap();
            settings::upsert_project_for_cwd(&mut s, &input.cwd, now)
        };
        let instance = Instance {
            session_id: input.session_id.clone(),
            pid: input.pid,
            cwd: input.cwd,
            project_id: project_id.clone(),
            kind: input.kind,
            is_remote: input.is_remote,
            started_at: input.started_at,
            transcript_path: input.transcript_path,
            bridge_session_id: None,
            ended_at: None,
            end_reason: None,
        };
        guard.insert(input.session_id, instance);
        (project_id, true)
    }

    /// Marks an instance as ended. Idempotent: returns `true` only the
    /// first time (when `end_reason` flips from None to Some).
    pub fn mark_ended(&self, session_id: &str, reason: EndReason, when: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        let Some(inst) = guard.get_mut(session_id) else { return false };
        if inst.end_reason.is_some() { return false; }
        inst.end_reason = Some(reason);
        inst.ended_at = Some(when.to_string());
        true
    }

    pub fn set_bridge_session_id(&self, session_id: &str, bridge_id: String) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(i) = guard.get_mut(session_id) {
            i.bridge_session_id = Some(bridge_id);
        }
    }

    /// Remove ended instances whose `ended_at` is strictly before `cutoff`.
    /// Cutoff is an RFC3339 string; lexicographic comparison works on
    /// `Z`-suffix timestamps.
    pub fn prune_ended_before(&self, cutoff: &str) {
        let mut guard = self.inner.lock().unwrap();
        guard.retain(|_, i| match i.ended_at.as_deref() {
            None => true,
            Some(t) => t >= cutoff,
        });
    }

    pub fn list(&self) -> Vec<Instance> {
        self.inner.lock().unwrap().values().cloned().collect()
    }

    pub fn by_cwd(&self, cwd: &std::path::Path) -> Vec<Instance> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|i| i.cwd == cwd)
            .cloned()
            .collect()
    }

    pub fn by_project(&self, project_id: &str) -> Vec<Instance> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|i| i.project_id == project_id)
            .cloned()
            .collect()
    }

    pub fn get(&self, session_id: &str) -> Option<Instance> {
        self.inner.lock().unwrap().get(session_id).cloned()
    }

    pub fn known_session_ids(&self) -> Vec<String> {
        self.inner.lock().unwrap().keys().cloned().collect()
    }
}
```

- [ ] **Step 4: Expose module in `src/lib.rs`**

Add near other `pub mod ...` lines:

```rust
pub mod instances;
```

- [ ] **Step 5: Run tests — expect pass**

Run: `cargo test --test instances_registry`

Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/instances.rs src/lib.rs tests/instances_registry.rs
git commit -m "FEAT: instances registry with register/mark_ended/prune"
```

---

### Task 4: Wire `Registry` into `AppState`

**Files:**
- Modify: `src/state.rs`
- Modify: `src/lib.rs` (construction site)

- [ ] **Step 1: Extend `AppState`**

In `src/state.rs`:

```rust
use crate::instances::Registry;
use std::sync::Arc;

pub struct AppState {
    pub current_usage: Mutex<Option<UsageSnapshot>>,
    pub settings: Mutex<Settings>,
    pub auth_state: Mutex<AuthState>,
    pub display: Mutex<TrayDisplayState>,
    pub audio: crate::audio::AudioCtx,
    pub instances: Arc<Registry>,
    /// Becomes `true` once the first-run hook-registration prompt is
    /// shown but before the user accepts or declines. Guards the modal
    /// so it doesn't re-trigger on every setting refresh.
    pub hook_registration_pending: Mutex<bool>,
}

impl AppState {
    pub fn new(settings: Settings, auth_state: AuthState) -> Self {
        Self {
            current_usage: Mutex::new(None),
            settings: Mutex::new(settings),
            auth_state: Mutex::new(auth_state),
            display: Mutex::new(TrayDisplayState::default()),
            audio: crate::audio::AudioCtx::new(),
            instances: Arc::new(Registry::new()),
            hook_registration_pending: Mutex::new(false),
        }
    }
}
```

- [ ] **Step 2: Build**

Run: `cargo build`

Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/state.rs
git commit -m "CHORE: expose instances Registry on AppState"
```

---

### Task 5: Add `SessionStart` / `SessionEnd` routes to `hook_server.rs`

**Files:**
- Modify: `src/hook_server.rs`
- Create: `tests/hook_server_instances.rs`

- [ ] **Step 1: Define the payload types**

Near the top of `src/hook_server.rs`, below `RefreshPayload`, add:

```rust
/// Payload shape for Claude Code's SessionStart / SessionEnd hooks.
/// See claude-code docs — fields surveyed from the CLI's hook emission.
#[derive(Deserialize, Debug, Default)]
struct SessionStartPayload {
    pub session_id: String,
    #[serde(default)] pub cwd: Option<String>,
    #[serde(default)] pub transcript_path: Option<String>,
    #[serde(default)] pub pid: Option<u32>,
    /// "startup" | "resume" | "clear" | "compact" — ignored for v1.
    #[serde(default)] pub source: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
struct SessionEndPayload {
    pub session_id: String,
    #[serde(default)] pub reason: Option<String>,
}
```

- [ ] **Step 2: Add the handlers**

Below `on_quit`, add:

```rust
async fn on_session_start(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<SessionStartPayload>,
) -> impl IntoResponse {
    log::info!(
        "hook /hooks/session-start: session={} cwd={} pid={:?} source={:?}",
        payload.session_id,
        payload.cwd.as_deref().unwrap_or("-"),
        payload.pid,
        payload.source,
    );

    let Some(cwd) = payload.cwd.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "missing cwd"})));
    };

    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let state = ctx.app.state::<AppState>();
    let registry = state.instances.clone();

    // Heuristic kind: if we spawned it, it's Automated. Plan B has no
    // channels yet, so everything is External; Plan C will set kind
    // explicitly when registering its own child.
    let input = crate::instances::RegisterInput {
        session_id: payload.session_id.clone(),
        cwd: std::path::PathBuf::from(cwd),
        pid: payload.pid.unwrap_or(0),
        kind: crate::types::InstanceKind::External,
        is_remote: false, // refined once bridgeSessionId resolves
        transcript_path: payload.transcript_path.map(std::path::PathBuf::from),
        started_at: now.clone(),
    };

    let (_project_id, created_new) =
        registry.register(input.clone(), &state.settings, &now);

    if created_new {
        // New project auto-created: persist settings to disk.
        let snapshot = state.settings.lock().unwrap().clone();
        if let Ok(path) = paths::settings_file() {
            let _ = settings::save(&path, &snapshot);
        }
        let _ = ctx.app.emit("settings-changed", &snapshot);
    }

    // Enrich with bridgeSessionId in the background.
    let h = ctx.app.clone();
    let sid = payload.session_id.clone();
    let pid_opt = payload.pid;
    tauri::async_runtime::spawn(async move {
        let Some(pid) = pid_opt else { return };
        if let Some(bridge) = crate::session_files::resolve_bridge_session_id(pid).await {
            let s = h.state::<AppState>();
            s.instances.set_bridge_session_id(&sid, bridge);
            let _ = h.emit("instances-changed", s.instances.list());
        }
    });

    let _ = ctx.app.emit("instances-changed", registry.list());

    (StatusCode::NO_CONTENT, Json(json!({})))
}

async fn on_session_end(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<SessionEndPayload>,
) -> impl IntoResponse {
    log::info!(
        "hook /hooks/session-end: session={} reason={}",
        payload.session_id,
        payload.reason.as_deref().unwrap_or("-"),
    );
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let state = ctx.app.state::<AppState>();
    if state.instances.mark_ended(&payload.session_id, crate::types::EndReason::HookSessionEnd, &now) {
        let _ = ctx.app.emit("instances-changed", state.instances.list());
    }
    StatusCode::NO_CONTENT
}
```

- [ ] **Step 3: Add routes to the router**

In `spawn`, extend the `Router::new()` block:

```rust
let router = Router::new()
    .route("/refresh", post(on_refresh))
    .route("/notify", post(on_notify))
    .route("/quit", post(on_quit))
    .route("/hooks/session-start", post(on_session_start))
    .route("/hooks/session-end", post(on_session_end))
    .with_state(ctx);
```

(Keep the existing `.route(...)` calls; this is additive. Remove the `.with_state(ctx)` call from its current location if it's there already and leave just one.)

- [ ] **Step 4: Write an integration test**

Create `tests/hook_server_instances.rs`:

```rust
//! Boot the hook_server inline, POST real payloads, assert registry state.
//! Requires a Tauri test harness. The existing `settings_roundtrip_renders.rs`
//! test doesn't boot Tauri; integration-testing a tauri::command is out of
//! scope. This test talks to the raw Registry through a minimal mock.

use claude_usage_tauri_lib::instances::{Registry, RegisterInput};
use claude_usage_tauri_lib::types::{EndReason, InstanceKind, Settings};
use std::path::PathBuf;
use std::sync::Mutex;

/// A simple validation that the SessionStart → register → mark_ended
/// flow behaves end-to-end on the registry. The HTTP layer is a thin
/// axum wrapper around `register` and `mark_ended`; unit-testing those
/// covers the critical path.
#[test]
fn session_start_then_end_flow() {
    let reg = Registry::new();
    let settings = Mutex::new(Settings::default());
    let (_proj, created) = reg.register(
        RegisterInput {
            session_id: "s1".into(),
            cwd: PathBuf::from("C:/a"),
            pid: 111,
            kind: InstanceKind::External,
            is_remote: false,
            transcript_path: None,
            started_at: "2026-04-21T00:00:00Z".into(),
        },
        &settings,
        "2026-04-21T00:00:00Z",
    );
    assert!(created);
    assert_eq!(reg.list().len(), 1);

    assert!(reg.mark_ended("s1", EndReason::HookSessionEnd, "2026-04-21T00:05:00Z"));
    assert_eq!(reg.list()[0].end_reason, Some(EndReason::HookSessionEnd));
}
```

- [ ] **Step 5: Run the test — expect pass**

Run: `cargo test --test hook_server_instances`

Expected: PASS.

- [ ] **Step 6: Build full workspace**

Run: `cargo build`

Expected: compiles. If `session_files::resolve_bridge_session_id` is not yet defined (Task 6 adds it), temporarily stub it as `async fn resolve_bridge_session_id(_pid: u32) -> Option<String> { None }` and Task 6 will replace the stub.

- [ ] **Step 7: Commit**

```bash
git add src/hook_server.rs tests/hook_server_instances.rs
git commit -m "FEAT: SessionStart and SessionEnd routes feed the instances registry"
```

---

### Task 6: Create `src/session_files.rs`

**Files:**
- Create: `src/session_files.rs`
- Create: `tests/session_files_parse.rs`
- Modify: `src/lib.rs` (`pub mod session_files;`)

- [ ] **Step 1: Write failing tests**

Create `tests/session_files_parse.rs`:

```rust
use claude_usage_tauri_lib::session_files;
use std::io::Write;

#[test]
fn parses_bridge_session_id_from_fixture() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("123.json");
    let mut f = std::fs::File::create(&path).unwrap();
    writeln!(f, r#"{{"bridgeSessionId":"abc-123","other":"field"}}"#).unwrap();
    let out = session_files::read_bridge_session_id(&path).unwrap();
    assert_eq!(out, Some("abc-123".to_string()));
}

#[test]
fn returns_none_when_field_missing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("123.json");
    std::fs::write(&path, "{}").unwrap();
    assert!(session_files::read_bridge_session_id(&path).unwrap().is_none());
}

#[test]
fn returns_none_when_file_missing() {
    let path = std::path::PathBuf::from("C:/does/not/exist/123.json");
    assert!(session_files::read_bridge_session_id(&path).unwrap().is_none());
}
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cargo test --test session_files_parse`

Expected: fails — module doesn't exist.

- [ ] **Step 3: Create `src/session_files.rs`**

```rust
//! Reads `~/.claude/sessions/<pid>.json` to resolve the
//! `bridgeSessionId` that's needed for remote-control phone links.
//!
//! Claude Code writes this file async after starting. We poll up to
//! 15 × 500ms = ~7.5s before giving up.

use anyhow::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

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
```

- [ ] **Step 4: Expose in `src/lib.rs`**

```rust
pub mod session_files;
```

Replace any stub `resolve_bridge_session_id` that Task 5 temporarily added.

- [ ] **Step 5: Run tests — expect pass**

Run: `cargo test --test session_files_parse`

Expected: 3/3 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/session_files.rs src/lib.rs tests/session_files_parse.rs
git commit -m "FEAT: session_files reader for bridgeSessionId resolution"
```

---

### Task 7: Create `src/detector.rs`

**Files:**
- Create: `src/detector.rs`
- Create: `tests/detector_reconcile.rs`
- Modify: `src/lib.rs` (`pub mod detector;`)
- Modify: `Cargo.toml` (add `sysinfo`)

- [ ] **Step 1: Add `sysinfo` to `Cargo.toml`**

In `[dependencies]`:

```toml
sysinfo = "0.31"
```

- [ ] **Step 2: Write failing tests**

Create `tests/detector_reconcile.rs`:

```rust
use claude_usage_tauri_lib::detector::{ReconcileInput, reconcile};
use claude_usage_tauri_lib::instances::{Registry, RegisterInput};
use claude_usage_tauri_lib::types::{EndReason, InstanceKind, Settings};
use std::path::PathBuf;
use std::sync::Mutex;

fn seed(sid: &str, pid: u32) -> RegisterInput {
    RegisterInput {
        session_id: sid.into(),
        cwd: PathBuf::from("C:/x"),
        pid,
        kind: InstanceKind::External,
        is_remote: false,
        transcript_path: None,
        started_at: "2026-04-21T00:00:00Z".into(),
    }
}

#[test]
fn single_missing_tick_does_not_mark_dead() {
    let r = Registry::new();
    let settings = Mutex::new(Settings::default());
    r.register(seed("s1", 111), &settings, "2026-04-21T00:00:00Z");
    // First tick: pid not present
    let ended = reconcile(&r, ReconcileInput {
        live_pids: vec![], // empty
        now: "2026-04-21T00:00:10Z",
        absent_strikes: &mut std::collections::HashMap::new(),
        grace_period_secs: 0,
    });
    assert!(ended.is_empty());
}

#[test]
fn two_consecutive_missing_ticks_mark_dead() {
    let r = Registry::new();
    let settings = Mutex::new(Settings::default());
    r.register(seed("s1", 111), &settings, "2026-04-21T00:00:00Z");
    let mut strikes = std::collections::HashMap::new();
    reconcile(&r, ReconcileInput {
        live_pids: vec![],
        now: "2026-04-21T00:00:10Z",
        absent_strikes: &mut strikes,
        grace_period_secs: 0,
    });
    let ended = reconcile(&r, ReconcileInput {
        live_pids: vec![],
        now: "2026-04-21T00:00:15Z",
        absent_strikes: &mut strikes,
        grace_period_secs: 0,
    });
    assert_eq!(ended, vec!["s1".to_string()]);
    let got = &r.list()[0];
    assert_eq!(got.end_reason, Some(EndReason::ProcessGone));
}

#[test]
fn live_pid_resets_strike_count() {
    let r = Registry::new();
    let settings = Mutex::new(Settings::default());
    r.register(seed("s1", 111), &settings, "2026-04-21T00:00:00Z");
    let mut strikes = std::collections::HashMap::new();
    reconcile(&r, ReconcileInput { live_pids: vec![], now: "t1", absent_strikes: &mut strikes, grace_period_secs: 0 });
    reconcile(&r, ReconcileInput { live_pids: vec![111], now: "t2", absent_strikes: &mut strikes, grace_period_secs: 0 });
    let ended = reconcile(&r, ReconcileInput {
        live_pids: vec![], now: "t3",
        absent_strikes: &mut strikes, grace_period_secs: 0,
    });
    assert!(ended.is_empty());
}
```

- [ ] **Step 3: Create `src/detector.rs`**

```rust
//! Periodic reconciliation between the instance registry and the
//! live process list. Catches instances that died without firing a
//! `SessionEnd` hook (force-kill, crash, window-close with dirty
//! state).

use crate::instances::Registry;
use crate::types::EndReason;
use std::collections::HashMap;
use std::time::Duration;
use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager};

/// Pure reconciliation step for testability.
pub struct ReconcileInput<'a> {
    pub live_pids: Vec<u32>,
    pub now: &'a str,
    pub absent_strikes: &'a mut HashMap<String, u8>,
    pub grace_period_secs: u64, // not applied here; plumbed for parity w/ design
}

/// Applies the 2-strikes-and-you're-out rule. Returns the session IDs
/// that were newly marked as ended this tick.
pub fn reconcile(registry: &Registry, mut input: ReconcileInput) -> Vec<String> {
    let instances = registry.list();
    let live: std::collections::HashSet<u32> = input.live_pids.into_iter().collect();
    let mut ended_now = Vec::new();

    for i in instances {
        // Skip already-ended instances.
        if i.end_reason.is_some() { continue; }
        // Skip unknown PIDs (pid = 0 when the hook didn't include it).
        if i.pid == 0 { continue; }
        if live.contains(&i.pid) {
            input.absent_strikes.remove(&i.session_id);
            continue;
        }
        let strikes = input.absent_strikes.entry(i.session_id.clone()).or_insert(0);
        *strikes += 1;
        if *strikes >= 2 {
            if registry.mark_ended(&i.session_id, EndReason::ProcessGone, input.now) {
                ended_now.push(i.session_id.clone());
            }
            input.absent_strikes.remove(&i.session_id);
        }
    }
    ended_now
}

/// Background task that runs the reconciliation every 5s and prunes
/// long-ended instances every 60s.
pub async fn run(app: AppHandle) {
    let mut strikes: HashMap<String, u8> = HashMap::new();
    let mut last_prune = tokio::time::Instant::now();
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let mut sys = System::new();
        sys.refresh_processes();
        let live_pids: Vec<u32> = sys.processes().keys().map(|p| p.as_u32()).collect();
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

        let state = app.state::<crate::state::AppState>();
        let registry = state.instances.clone();
        let ended_now = reconcile(&registry, ReconcileInput {
            live_pids,
            now: &now,
            absent_strikes: &mut strikes,
            grace_period_secs: 30,
        });
        if !ended_now.is_empty() {
            let _ = app.emit("instances-changed", registry.list());
        }

        if last_prune.elapsed().as_secs() >= 60 {
            let cutoff = (chrono::Utc::now() - chrono::Duration::seconds(60))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            registry.prune_ended_before(&cutoff);
            last_prune = tokio::time::Instant::now();
            let _ = app.emit("instances-changed", registry.list());
        }
    }
}
```

- [ ] **Step 4: Expose in `src/lib.rs`**

```rust
pub mod detector;
```

- [ ] **Step 5: Start the detector task**

In `src/lib.rs`, inside `.setup(|app| { ... })` after auth setup, spawn:

```rust
{
    let h = app.handle().clone();
    tauri::async_runtime::spawn(async move { crate::detector::run(h).await });
}
```

- [ ] **Step 6: Run tests — expect pass**

Run: `cargo test --test detector_reconcile`

Expected: 3/3 PASS.

Run: `cargo build`

Expected: compiles.

- [ ] **Step 7: Commit**

```bash
git add src/detector.rs src/lib.rs tests/detector_reconcile.rs Cargo.toml Cargo.lock
git commit -m "FEAT: detector task reconciles instance registry against live pids"
```

---

### Task 8: Create `src/hook_installer.rs`

**Files:**
- Create: `src/hook_installer.rs`
- Create: `tests/hook_installer_merge.rs`
- Modify: `src/lib.rs` (`pub mod hook_installer;`)

- [ ] **Step 1: Write failing tests**

Create `tests/hook_installer_merge.rs`:

```rust
use claude_usage_tauri_lib::hook_installer::{merge_hooks, HookConfig};

#[test]
fn merges_into_empty_settings() {
    let existing = serde_json::json!({});
    let out = merge_hooks(&existing, &HookConfig { port: 27182 });
    assert_eq!(out["hooks"]["SessionStart"][0]["hooks"][0]["type"], "command");
    assert!(out["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .contains("27182"));
}

#[test]
fn preserves_existing_unrelated_fields() {
    let existing = serde_json::json!({
        "theme": "dark",
        "unrelated": { "key": "value" }
    });
    let out = merge_hooks(&existing, &HookConfig { port: 27182 });
    assert_eq!(out["theme"], "dark");
    assert_eq!(out["unrelated"]["key"], "value");
}

#[test]
fn preserves_existing_hooks_from_other_apps() {
    let existing = serde_json::json!({
        "hooks": {
            "SessionStart": [
                { "matcher": "other-app", "hooks": [{ "type": "command", "command": "other --run" }] }
            ]
        }
    });
    let out = merge_hooks(&existing, &HookConfig { port: 27182 });
    let arr = out["hooks"]["SessionStart"].as_array().unwrap();
    // Must keep the other-app entry, append ours.
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["matcher"], "other-app");
    assert_eq!(arr[1]["matcher"], "aiusage-taskbar");
}

#[test]
fn idempotent_when_our_entry_already_present() {
    let existing = serde_json::json!({});
    let once = merge_hooks(&existing, &HookConfig { port: 27182 });
    let twice = merge_hooks(&once, &HookConfig { port: 27182 });
    assert_eq!(once, twice);
}

#[test]
fn refreshes_our_command_when_port_changes() {
    let existing = serde_json::json!({});
    let v1 = merge_hooks(&existing, &HookConfig { port: 27182 });
    let v2 = merge_hooks(&v1, &HookConfig { port: 27200 });
    let arr = v2["hooks"]["SessionStart"].as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert!(arr[0]["hooks"][0]["command"].as_str().unwrap().contains("27200"));
}
```

- [ ] **Step 2: Create `src/hook_installer.rs`**

```rust
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
```

- [ ] **Step 3: Expose in `src/lib.rs`**

```rust
pub mod hook_installer;
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cargo test --test hook_installer_merge`

Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hook_installer.rs src/lib.rs tests/hook_installer_merge.rs
git commit -m "FEAT: hook_installer merges SessionStart/SessionEnd into ~/.claude/settings.json"
```

---

### Task 9: Add instance + hook IPC commands

**Files:**
- Modify: `src/ipc.rs`
- Modify: `src/lib.rs` (register commands)
- Modify: `dist/electron-api-shim.js`

- [ ] **Step 1: Extend `src/ipc.rs`**

Add near the project commands:

```rust
#[tauri::command]
pub fn list_instances(state: State<AppState>) -> Vec<crate::types::Instance> {
    state.instances.list()
}

#[tauri::command]
pub fn list_instances_for_project(project_id: String, state: State<AppState>)
    -> Vec<crate::types::Instance>
{
    state.instances.by_project(&project_id)
}

#[tauri::command]
pub fn phone_link(session_id: String, state: State<AppState>) -> Option<String> {
    let inst = state.instances.get(&session_id)?;
    let bridge = inst.bridge_session_id?;
    Some(format!("https://claude.ai/code/{bridge}"))
}

#[tauri::command]
pub fn get_hook_registration_state(state: State<AppState>)
    -> serde_json::Value
{
    let s = state.settings.lock().unwrap();
    serde_json::json!({
        "registered": s.hooks_registered,
        "declined": s.hook_registration_declined,
        "port": s.hook_port,
    })
}

#[tauri::command]
pub fn register_hooks_globally(state: State<AppState>, app: AppHandle)
    -> Result<(), String>
{
    let port = {
        let s = state.settings.lock().unwrap();
        s.hook_port.ok_or_else(|| "hook server not started yet".to_string())?
    };
    crate::hook_installer::install(crate::hook_installer::HookConfig { port })
        .map_err(|e| e.to_string())?;
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hooks_registered = true;
        g.hook_registration_declined = false;
        g.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn skip_hook_registration(state: State<AppState>, app: AppHandle)
    -> Result<(), String>
{
    let snapshot = {
        let mut g = state.settings.lock().unwrap();
        g.hook_registration_declined = true;
        g.clone()
    };
    let path = paths::settings_file().map_err(|e| e.to_string())?;
    settings::save(&path, &snapshot).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}
```

- [ ] **Step 2: Register in `src/lib.rs`**

Inside the `generate_handler![...]` macro:

```rust
ipc::list_instances,
ipc::list_instances_for_project,
ipc::phone_link,
ipc::get_hook_registration_state,
ipc::register_hooks_globally,
ipc::skip_hook_registration,
```

- [ ] **Step 3: Extend `dist/electron-api-shim.js`**

Inside the `bridge = { ... }`:

```javascript
// --- Instances ---
listInstances: () => invoke('list_instances'),
listInstancesForProject: (projectId) => invoke('list_instances_for_project', { projectId }),
phoneLink: (sessionId) => invoke('phone_link', { sessionId }),

// --- Hook registration ---
getHookRegistrationState: () => invoke('get_hook_registration_state'),
registerHooksGlobally: async () => {
  try { await invoke('register_hooks_globally'); }
  catch (e) { console.error('register_hooks_globally failed', e); throw e; }
},
skipHookRegistration: async () => {
  try { await invoke('skip_hook_registration'); }
  catch (e) { console.error('skip_hook_registration failed', e); throw e; }
},

// --- Event listener ---
onInstancesChanged: (cb) => {
  const unlisten = T.event.listen('instances-changed', (e) => cb(e.payload));
  return () => unlisten.then((u) => u());
},
```

- [ ] **Step 4: Build**

Run: `cargo build`

Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add src/ipc.rs src/lib.rs dist/electron-api-shim.js
git commit -m "FEAT: IPC commands for instances, phone link, hook registration"
```

---

### Task 10: First-run hook-registration modal

**Files:**
- Modify: `dist/dashboard.html` (new modal element)
- Modify: `dist/dashboard.css` (modal styles)
- Modify: `dist/dashboard.js` (trigger + wiring)

- [ ] **Step 1: Add modal HTML**

At the end of `<body>` in `dist/dashboard.html` (after all views, before scripts):

```html
<!-- ══════════════════════════════════════════════════════════════════════
     First-run: hook registration consent modal
═══════════════════════════════════════════════════════════════════════ -->
<div class="modal-backdrop" id="hookModalBackdrop" style="display:none"></div>
<div class="modal" id="hookModal" style="display:none">
    <div class="modal-header">
        <i class="ph ph-plug"></i>
        <h3>Enable live instance tracking?</h3>
    </div>
    <div class="modal-body">
        <p>We can register a small hook in <code>~/.claude/settings.json</code> so this app sees when any Claude Code session starts or ends, anywhere on your machine — automated channels, VSCode terminals, ad-hoc shells.</p>
        <p class="muted">Your existing hooks (from other apps) are preserved. Only our entries are added.</p>
        <div class="modal-preview" id="hookModalPreview">Loading…</div>
    </div>
    <div class="modal-actions">
        <button class="btn-secondary" id="hookModalSkip">Not now</button>
        <button class="btn-danger" id="hookModalNever">Never</button>
        <button class="btn-primary" id="hookModalAccept">Enable</button>
    </div>
</div>
```

- [ ] **Step 2: Add modal CSS**

Append to `dist/dashboard.css`:

```css
.modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 2500;
}
.modal {
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    background: var(--bg-elevated, #1f1f2c);
    border: 1px solid var(--border, #2e2e40);
    border-radius: 10px;
    width: calc(100% - 48px);
    max-width: 460px;
    z-index: 2600;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
}
.modal-header {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border, #2e2e40);
}
.modal-header h3 {
    margin: 0; font-size: 0.92rem; font-weight: 600;
}
.modal-header i { font-size: 1.2rem; color: var(--accent, #4c9eff); }
.modal-body { padding: 14px 16px; font-size: 0.82rem; line-height: 1.45; }
.modal-body p { margin: 0 0 8px; }
.modal-body .muted { color: var(--text-dim, #8a8aa0); font-size: 0.75rem; }
.modal-preview {
    margin-top: 10px;
    background: var(--bg-sunken, #15151e);
    border: 1px solid var(--border, #2a2a3a);
    border-radius: 5px;
    padding: 8px 10px;
    font-family: 'Fira Code', monospace;
    font-size: 0.68rem;
    color: var(--text-dim, #9a9ab0);
    white-space: pre-wrap;
    max-height: 140px;
    overflow: auto;
}
.modal-actions {
    display: flex; justify-content: flex-end; gap: 6px;
    padding: 10px 16px;
    border-top: 1px solid var(--border, #2e2e40);
}
.modal-actions button {
    padding: 6px 12px;
    border-radius: 5px;
    font-size: 0.78rem;
    cursor: pointer;
    border: 0;
}
.btn-primary { background: var(--accent, #2c5fd6); color: #fff; }
.btn-secondary { background: var(--bg-active, #2a2a3a); color: var(--text, #e4e4ee); }
.btn-danger { background: transparent; color: var(--danger, #e74c3c); }
```

- [ ] **Step 3: JS — show on first run, wire buttons**

In `dist/dashboard.js`:

```javascript
async function maybeShowHookModal() {
  const state = await window.electronAPI.getHookRegistrationState();
  if (state.registered || state.declined) return;
  showHookModal();
}

function showHookModal() {
  const backdrop = document.getElementById("hookModalBackdrop");
  const modal = document.getElementById("hookModal");
  backdrop.style.display = "block";
  modal.style.display = "block";
  renderHookModalPreview();
}
function hideHookModal() {
  document.getElementById("hookModalBackdrop").style.display = "none";
  document.getElementById("hookModal").style.display = "none";
}

async function renderHookModalPreview() {
  const state = await window.electronAPI.getHookRegistrationState();
  const port = state.port || "?";
  const preview = [
    `"hooks": {`,
    `  "SessionStart": [{`,
    `    "matcher": "aiusage-taskbar",`,
    `    "hooks": [{ "type": "command",`,
    `      "command": "curl -sS -X POST … :${port}/hooks/session-start" }]`,
    `  }],`,
    `  "SessionEnd": [{ ... similarly … }]`,
    `}`,
  ].join("\n");
  document.getElementById("hookModalPreview").textContent = preview;
}

document.getElementById("hookModalAccept").onclick = async () => {
  try {
    await window.electronAPI.registerHooksGlobally();
    hideHookModal();
    showToast("Hooks enabled. Running instances will now show up.");
  } catch (e) {
    showToast(`Hook install failed: ${e}`);
  }
};
document.getElementById("hookModalSkip").onclick = () => {
  hideHookModal();
  // Will re-offer on next launch.
};
document.getElementById("hookModalNever").onclick = async () => {
  await window.electronAPI.skipHookRegistration();
  hideHookModal();
};

// Call after settings are loaded and the app is ready.
maybeShowHookModal();
```

- [ ] **Step 4: Sanity run**

Run: `cargo tauri dev`

Expected: on a fresh install (no `hooks_registered` in settings), the modal appears. Click "Enable" — verify `~/.claude/settings.json` contains our SessionStart + SessionEnd entries. Click "Never" — verify `hook_registration_declined: true` in app settings.

- [ ] **Step 5: Commit**

```bash
git add dist/dashboard.html dist/dashboard.css dist/dashboard.js
git commit -m "FEAT: first-run hook-registration consent modal"
```

---

### Task 11: Render running instances in Project detail

**Files:**
- Modify: `dist/dashboard.js`
- Modify: `dist/dashboard.css`
- Create: `tests/running_instances_view.test.mjs`

- [ ] **Step 1: Write failing vitest**

Create `tests/running_instances_view.test.mjs`:

```javascript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");
const html = readFileSync(join(distDir, "dashboard.html"), "utf8");
const js = readFileSync(join(distDir, "dashboard.js"), "utf8");

describe("running instances shell", () => {
  it("has runningInstancesList container", () => {
    expect(html).toMatch(/id="runningInstancesList"/);
    expect(html).toMatch(/id="runningInstancesEmpty"/);
    expect(html).toMatch(/id="runningInstancesCount"/);
  });

  it("JS subscribes to instances-changed", () => {
    expect(js).toMatch(/onInstancesChanged/);
  });

  it("JS renders instance rows with status dot and action buttons", () => {
    expect(js).toMatch(/renderRunningInstances/);
    expect(js).toMatch(/instance-row/);
    expect(js).toMatch(/phone-link-btn/);
  });
});
```

- [ ] **Step 2: Append CSS for instance rows**

In `dist/dashboard.css`:

```css
.instance-row {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-elevated, #1f1f2c);
  border: 1px solid var(--border, #2e2e40);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.instance-row .status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--status-ok, #6ad98a);
  flex-shrink: 0;
}
.instance-row.external .status-dot { background: var(--accent, #8a9eff); }
.instance-row.ending .status-dot { background: var(--text-dim, #8a8aa0); }
.instance-row .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.instance-row .meta .top {
  display: flex; align-items: center; gap: 6px;
  font-size: 0.78rem; font-weight: 500;
}
.instance-row .meta .sub {
  font-size: 0.68rem; color: var(--text-dim, #8a8aa0);
  font-family: 'Fira Code', monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.instance-row .tag {
  background: var(--bg-active, #2a2a3a);
  padding: 1px 6px; border-radius: 3px;
  font-size: 0.64rem; font-weight: 500;
  color: var(--text-dim, #8a8aa0);
}
.instance-row .tag.automated { background: #3a2a1d; color: #f2b457; }
.instance-row .tag.remote { background: #2a2845; color: #8a9eff; }
.instance-row .actions { display: flex; gap: 4px; }
.instance-row .actions .act-btn {
  padding: 4px 8px; font-size: 0.7rem;
  background: var(--bg-active, #2a2a3a);
  border: 0; border-radius: 4px;
  color: var(--text, #c5c5d6);
  cursor: pointer;
}
.instance-row .actions .act-btn:disabled {
  opacity: 0.4; cursor: not-allowed;
}
```

- [ ] **Step 3: Add render function in `dist/dashboard.js`**

```javascript
async function renderRunningInstances() {
  if (!projectDetailState.cwd) return;

  // Find project id for the current cwd.
  const projects = await window.electronAPI.listProjects();
  const proj = projects.find((p) => p.path === projectDetailState.cwd);
  if (!proj) {
    setRunningInstancesEmpty(0);
    return;
  }
  const instances = (await window.electronAPI.listInstancesForProject(proj.id))
    .filter((i) => !i.end_reason);
  const count = instances.length;

  document.getElementById("runningInstancesCount").textContent = count;
  const listEl = document.getElementById("runningInstancesList");
  const emptyEl = document.getElementById("runningInstancesEmpty");
  if (count === 0) {
    listEl.style.display = "none";
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";
  listEl.style.display = "block";

  listEl.innerHTML = instances.map((i) => instanceRowHtml(i)).join("");
  listEl.querySelectorAll(".phone-link-btn").forEach((btn) => {
    btn.onclick = async () => {
      const url = await window.electronAPI.phoneLink(btn.dataset.sessionId);
      if (!url) return showToast("Phone link not available yet.");
      await navigator.clipboard.writeText(url);
      showToast(`Copied: ${url}`);
    };
  });
}

function setRunningInstancesEmpty(count) {
  document.getElementById("runningInstancesCount").textContent = count;
  document.getElementById("runningInstancesList").style.display = "none";
  document.getElementById("runningInstancesEmpty").style.display = "block";
}

function instanceRowHtml(i) {
  const uptime = uptimeFrom(i.started_at);
  const kindClass = i.kind === "external" ? "external" : "";
  const kindTag = i.kind === "automated" ? "Automated" : "External";
  const kindTagClass = i.kind === "automated" ? "automated" : "";
  const remoteTag = i.is_remote ? `<span class="tag remote">📱</span>` : "";
  const phoneDisabled = i.bridge_session_id ? "" : "disabled";
  const automatedOnlyDisabled = i.kind === "automated" ? "" : "disabled";
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
        <button class="act-btn" title="Show terminal" ${automatedOnlyDisabled}>term</button>
        <button class="act-btn phone-link-btn" title="Copy phone link" data-session-id="${i.session_id}" ${phoneDisabled}>phone</button>
        <button class="act-btn" title="Restart" ${automatedOnlyDisabled}>restart</button>
        <button class="act-btn" title="Stop" ${automatedOnlyDisabled}>stop</button>
      </div>
    </div>
  `;
}

function uptimeFrom(iso) {
  const start = new Date(iso).getTime();
  const delta = Math.max(0, Date.now() - start);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Subscribe to live updates.
window.electronAPI.onInstancesChanged(() => {
  if (activeView === "project-detail") renderRunningInstances();
  if (activeView === "projects") renderProjectsList();
});

// Call when Project detail opens.
const _originalOpenProjectDetail = openProjectDetail;
openProjectDetail = function(cwd) {
  _originalOpenProjectDetail(cwd);
  renderRunningInstances();
};
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run tests/running_instances_view.test.mjs`

Expected: PASS.

- [ ] **Step 5: Sanity run with real Claude Code**

Run: `cargo tauri dev`

Open a separate terminal, run `claude` in any directory. Navigate in the app to that directory's Project detail page. Expect a row for the live instance. Exit claude, expect the row to disappear within ~15s (hooks or detector).

- [ ] **Step 6: Commit**

```bash
git add dist/dashboard.js dist/dashboard.css tests/running_instances_view.test.mjs
git commit -m "FEAT: render running instances live in Project detail"
```

---

### Task 12: Project card live-instance count badge + remote icon

**Files:**
- Modify: `dist/dashboard.js`

- [ ] **Step 1: Enhance `renderProjectsList`**

Update the function added in Plan A Task 12 to merge in live instances:

```javascript
async function renderProjectsList() {
  const tokenHistory = lastTokenHistory || (await window.electronAPI.getTokenHistory?.()) || [];
  const projects = await window.electronAPI.listProjects();
  const liveInstances = (await window.electronAPI.listInstances()).filter((i) => !i.end_reason);

  const byPath = new Map();
  for (const rec of tokenHistory) {
    const key = rec.cwd || "(unknown)";
    const bucket = byPath.get(key) || { cwd: key, tokens_7d: 0, live: 0, anyRemote: false, anyAutomated: false };
    bucket.tokens_7d += (rec.input_tokens || 0) + (rec.output_tokens || 0);
    byPath.set(key, bucket);
  }

  // Overlay ProjectConfig data.
  for (const p of projects) {
    const existing = byPath.get(p.path) || { cwd: p.path, tokens_7d: 0, live: 0, anyRemote: false, anyAutomated: false };
    existing.name = p.name;
    existing.avatar = p.avatar;
    existing.projectId = p.id;
    existing.anyAutomated = existing.anyAutomated || !!p.automation?.enabled;
    byPath.set(p.path, existing);
  }

  // Overlay live instances.
  for (const inst of liveInstances) {
    const key = inst.cwd;
    const existing = byPath.get(key) || { cwd: key, tokens_7d: 0, live: 0, anyRemote: false, anyAutomated: false };
    existing.live = (existing.live || 0) + 1;
    existing.anyRemote = existing.anyRemote || inst.is_remote;
    existing.anyAutomated = existing.anyAutomated || inst.kind === "automated";
    byPath.set(key, existing);
  }

  const entries = [...byPath.values()].sort((a, b) => {
    if ((b.live || 0) !== (a.live || 0)) return (b.live || 0) - (a.live || 0);
    return (b.tokens_7d || 0) - (a.tokens_7d || 0);
  });

  const container = document.getElementById("projects-list");
  const empty = document.getElementById("projects-empty");
  if (entries.length === 0) {
    container.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  const s = await window.electronAPI.getSettings();
  container.classList.toggle("grid-mode", (s.projects_view_mode || "grid") === "grid");
  container.classList.toggle("list-mode", (s.projects_view_mode || "grid") === "list");

  container.innerHTML = entries.map((e) => projectCardHtml(e)).join("");
  container.querySelectorAll(".project-card").forEach((el) => {
    el.onclick = () => openProjectDetail(el.dataset.cwd);
  });
}

function projectCardHtml(entry) {
  const displayName = entry.name || basename(entry.cwd);
  const avatar = renderAvatar(entry.avatar);
  const tokens = formatCompactTokens(entry.tokens_7d || 0);
  const tags = [
    entry.live ? `<span class="card-tag live">● ${entry.live}</span>` : "",
    entry.anyRemote ? `<span class="card-tag remote">📱</span>` : "",
    entry.anyAutomated ? `<span class="card-tag automated">⚙</span>` : "",
  ].filter(Boolean).join(" ");
  return `
    <div class="project-card" data-cwd="${escapeHtml(entry.cwd)}" data-project-id="${entry.projectId || ""}">
      <div class="avatar">${avatar}</div>
      <div class="body">
        <div class="name">${escapeHtml(displayName)} <span class="card-tags">${tags}</span></div>
        <div class="tokens">${tokens} tokens · last 7d</div>
      </div>
    </div>
  `;
}
```

- [ ] **Step 2: CSS for card tags**

Append to `dist/dashboard.css`:

```css
.card-tags { margin-left: 6px; }
.card-tag {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.62rem;
    font-weight: 500;
    margin-left: 2px;
}
.card-tag.live { background: #1d3a2a; color: #6ad98a; }
.card-tag.remote { background: #2a2845; color: #8a9eff; }
.card-tag.automated { background: #3a2a1d; color: #f2b457; }
```

- [ ] **Step 3: Sanity run**

Run: `cargo tauri dev`

Expected: Projects view shows cards with live-instance badges when any claude is running for that cwd.

- [ ] **Step 4: Commit**

```bash
git add dist/dashboard.js dist/dashboard.css
git commit -m "FEAT: project cards show live-instance count and remote/automated icons"
```

---

### Task 13: Smoke test + final QA + docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full test pass**

Run: `cargo test`
Run: `npx vitest run`

Expected: all PASS.

- [ ] **Step 2: Manual QA**

Run `cargo tauri dev` and step through:

- [ ] First-run modal appears on a clean install; Accept writes to `~/.claude/settings.json`.
- [ ] Declining (Never) persists and modal does not reappear.
- [ ] Starting a fresh `claude` in any folder: within a few seconds, the app's Projects view gains a card (or updates an existing one) with `● 1` and the Project detail shows a live row.
- [ ] `/exit` in the claude terminal: row disappears within ~15s.
- [ ] Force-closing the claude terminal window: row still disappears within ~15s via detector.
- [ ] Copy phone link: button is disabled until `bridgeSessionId` resolves (non-remote sessions: stays disabled forever, which is correct).
- [ ] External instance rows: term / restart / stop buttons are disabled with tooltips.

- [ ] **Step 3: Update `CLAUDE.md`**

Append:

```markdown
## Instance detection (Plan B)

- `src/instances.rs` — in-memory registry keyed by `session_id`. Emits `instances-changed` Tauri events on every mutation.
- `src/hook_server.rs` — `/hooks/session-start` and `/hooks/session-end` endpoints populate the registry.
- `src/detector.rs` — 5s reconciliation loop using `sysinfo`. Marks instances as ended after 2 consecutive missing-pid ticks.
- `src/session_files.rs` — resolves `bridgeSessionId` from `~/.claude/sessions/<pid>.json` for phone-link URLs.
- `src/hook_installer.rs` — merges our SessionStart/SessionEnd entries into `~/.claude/settings.json`. Preserves every unrelated field; idempotent.
- First-run modal in `dashboard.html` asks the user to allow the global hook install; "Never" button declines permanently.
- Project cards on the Projects view surface live-instance count and remote/automated tags.
- Running-instances list on the Project detail view shows per-instance actions. Terminal/restart/stop are automated-only; phone-link requires a resolved `bridgeSessionId`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "DOCS: summary of Plan B instance detection in CLAUDE.md"
```

- [ ] **Step 5: Summary**

Plan B is done. The app is now live-aware. Plan C adds the ability to spawn + manage automated channels, imports the legacy obsidian_claude_remote config, and retires the old Python app.
