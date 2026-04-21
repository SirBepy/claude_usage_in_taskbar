# Plan A — UI Shell Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the dashboard into a sidemenu-driven navigation with four top-level views (Home / Statistics / Projects / Settings), introduce the Rust data model for projects that later plans will populate, and add the Projects grid/list UI with avatar support and a Project detail shell. No instance detection or process spawning — that lands in Plan B and Plan C.

**Architecture:** Pure refactor of `dist/dashboard.{html,css,js}` plus additive changes to `src/types.rs` and `src/ipc.rs`. The existing `showView(name)` + `.view/.hidden` navigation pattern is preserved. The sidemenu is a new overlay that opens on top of the active view. `view-stats` is renamed to `view-projects` and `view-stats-project` to `view-project-detail`; the existing token-history-derived project list stays as the data source, with `settings.projects` layered on top as a customization overlay (avatar, display name).

**Tech Stack:** Rust 2021 (tauri 2, serde, tempfile), vanilla JavaScript in `dist/`, vitest for frontend tests, Phosphor Icons via CDN.

---

## Spec reference

Implements the UI-redesign sections of `docs/superpowers/specs/2026-04-21-channel-management-integration-design.md`. Everything detection-related (hooks, instances, detector) and everything spawn-related (channels, console show/hide, migration) is out of scope for this plan.

## File structure

**Rust, modified:**
- `src/types.rs` — add `ProjectConfig`, `Avatar`, `AutomationConfig`, `ViewMode` types; add `projects`, `projects_view_mode`, `hooks_registered`, `hook_registration_declined` fields to `Settings`.
- `src/ipc.rs` — add `list_projects`, `get_project`, `update_project`, `delete_project`, `set_projects_view_mode` commands.
- `src/lib.rs` — register the new commands in `generate_handler![...]`.

**Frontend, modified:**
- `dist/dashboard.html` — replace the gear + stats buttons with a single burger button; rename `view-stats` to `view-projects`, `view-stats-project` to `view-project-detail`; add `view-statistics`; add sidemenu overlay; add grid/list toggle header on Projects; running-instances section shell in Project detail.
- `dist/dashboard.js` — update the `VIEWS` array, add sidemenu open/close, wire sidemenu nav items, update event handlers for renamed views, call new IPC commands.
- `dist/dashboard.css` — sidemenu + overlay + burger + nav item styles; grid/list toggle button styles; home card enlargement.

**Tests, created:**
- `tests/projects_ipc.rs` — Rust integration tests for project CRUD commands.
- `tests/sidemenu_nav.test.mjs` — vitest coverage for sidemenu DOM + wiring.
- `tests/projects_view.test.mjs` — vitest for grid/list toggle rendering.

**Tests, modified:**
- `tests/dashboard_wiring.test.mjs` — update the `VIEWS` constant if it's referenced; add assertions for the new views.

All tasks MUST be committed separately. Use the `/commit` skill or follow the project's `PREFIX: lowercase sentence` commit convention.

---

### Task 1: Add project types to `src/types.rs`

**Files:**
- Modify: `src/types.rs`
- Test: `src/types.rs` (inline `#[cfg(test)]` module — follow existing pattern)

- [ ] **Step 1: Write the failing test**

Append to the existing `#[cfg(test)] mod tests` block in `src/types.rs`:

```rust
#[test]
fn project_config_roundtrips_json() {
    let p = ProjectConfig {
        id: "abc".into(),
        path: std::path::PathBuf::from("C:/x/y"),
        name: "YProject".into(),
        avatar: Avatar::Emoji("🪶".into()),
        automation: None,
        created_at: "2026-04-21T00:00:00Z".into(),
        last_active_at: None,
    };
    let raw = serde_json::to_string(&p).unwrap();
    let back: ProjectConfig = serde_json::from_str(&raw).unwrap();
    assert_eq!(p, back);
}

#[test]
fn settings_defaults_expose_new_fields() {
    let s = Settings::default();
    assert!(s.projects.is_empty());
    assert_eq!(s.projects_view_mode, ViewMode::Grid);
    assert!(!s.hooks_registered);
    assert!(!s.hook_registration_declined);
}

#[test]
fn avatar_serializes_as_tagged_enum() {
    let a = Avatar::Emoji("🦊".into());
    let raw = serde_json::to_string(&a).unwrap();
    assert_eq!(raw, r#"{"kind":"emoji","value":"🦊"}"#);
    let back: Avatar = serde_json::from_str(&raw).unwrap();
    assert_eq!(a, back);
}
```

- [ ] **Step 2: Run the tests — expect failure**

Run: `cargo test --lib types::tests`

Expected: compile error (types don't exist yet).

- [ ] **Step 3: Add the types to `src/types.rs`**

Add, BEFORE the existing `#[cfg(test)]` block:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub enum Avatar {
    None,
    Emoji(String),
    Image(std::path::PathBuf),
}

impl Default for Avatar {
    fn default() -> Self { Avatar::None }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    Grid,
    List,
}

impl Default for ViewMode {
    fn default() -> Self { ViewMode::Grid }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct AutomationConfig {
    pub enabled: bool,
    pub autostart_on_boot: bool,
    pub session_name_prefix: Option<String>,
    pub continue_flag: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProjectConfig {
    pub id: String,
    pub path: std::path::PathBuf,
    pub name: String,
    #[serde(default)]
    pub avatar: Avatar,
    #[serde(default)]
    pub automation: Option<AutomationConfig>,
    pub created_at: String,
    #[serde(default)]
    pub last_active_at: Option<String>,
}
```

- [ ] **Step 4: Extend the `Settings` struct**

In `src/types.rs`, replace the `Settings` struct definition with:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub poll_interval_secs: u64,
    pub display_mode: DisplayMode,
    pub threshold_warn: f64,
    pub threshold_crit: f64,
    pub autostart: bool,
    pub auto_update: bool,
    pub hook_port: Option<u16>,
    pub projects: Vec<ProjectConfig>,
    pub projects_view_mode: ViewMode,
    pub hooks_registered: bool,
    pub hook_registration_declined: bool,
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}
```

And update the `Default` impl to include the new fields:

```rust
impl Default for Settings {
    fn default() -> Self {
        Self {
            poll_interval_secs: 600,
            display_mode: DisplayMode::Rings,
            threshold_warn: 50.0,
            threshold_crit: 80.0,
            autostart: true,
            auto_update: true,
            hook_port: None,
            projects: Vec::new(),
            projects_view_mode: ViewMode::Grid,
            hooks_registered: false,
            hook_registration_declined: false,
            extra: serde_json::Map::new(),
        }
    }
}
```

- [ ] **Step 5: Run the tests — expect pass**

Run: `cargo test --lib types::tests`

Expected: PASS on all tests, including the new ones. The existing serde round-trip tests should still pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.rs
git commit -m "FEAT: add ProjectConfig, Avatar, ViewMode types to settings"
```

---

### Task 2: Add project CRUD IPC commands to `src/ipc.rs`

**Files:**
- Modify: `src/ipc.rs`
- Create: `tests/projects_ipc.rs`

- [ ] **Step 1: Write the failing Rust integration test**

Create `tests/projects_ipc.rs`:

```rust
//! Unit-level tests for the pure portion of the project IPC commands.
//!
//! The `#[tauri::command]` wrappers require the Tauri `State` and `AppHandle`
//! harness, so we test the extracted pure helpers directly. The wrappers are
//! thin glue around these.

use claude_usage_tauri_lib::ipc::projects_test_helpers as h;
use claude_usage_tauri_lib::types::{Avatar, ProjectConfig, Settings, ViewMode};

fn sample_project(id: &str, path: &str) -> ProjectConfig {
    ProjectConfig {
        id: id.into(),
        path: path.into(),
        name: id.into(),
        avatar: Avatar::None,
        automation: None,
        created_at: "2026-04-21T00:00:00Z".into(),
        last_active_at: None,
    }
}

#[test]
fn list_projects_returns_empty_on_defaults() {
    let s = Settings::default();
    assert!(h::list_from(&s).is_empty());
}

#[test]
fn get_project_finds_by_id() {
    let mut s = Settings::default();
    s.projects.push(sample_project("a", "C:/a"));
    s.projects.push(sample_project("b", "C:/b"));
    let got = h::get_from(&s, "b").unwrap();
    assert_eq!(got.path, std::path::PathBuf::from("C:/b"));
    assert!(h::get_from(&s, "missing").is_none());
}

#[test]
fn update_project_applies_patch_in_place() {
    let mut s = Settings::default();
    s.projects.push(sample_project("a", "C:/a"));
    let patch = serde_json::json!({ "name": "Alpha", "avatar": {"kind":"emoji","value":"🅰"} });
    let ok = h::update_in(&mut s, "a", patch);
    assert!(ok);
    assert_eq!(s.projects[0].name, "Alpha");
    assert_eq!(s.projects[0].avatar, Avatar::Emoji("🅰".into()));
}

#[test]
fn update_project_returns_false_for_missing_id() {
    let mut s = Settings::default();
    let ok = h::update_in(&mut s, "missing", serde_json::json!({ "name": "X" }));
    assert!(!ok);
}

#[test]
fn delete_project_removes_entry() {
    let mut s = Settings::default();
    s.projects.push(sample_project("a", "C:/a"));
    s.projects.push(sample_project("b", "C:/b"));
    let ok = h::delete_in(&mut s, "a");
    assert!(ok);
    assert_eq!(s.projects.len(), 1);
    assert_eq!(s.projects[0].id, "b");
}

#[test]
fn set_projects_view_mode_updates_field() {
    let mut s = Settings::default();
    h::set_view_mode(&mut s, ViewMode::List);
    assert_eq!(s.projects_view_mode, ViewMode::List);
    h::set_view_mode(&mut s, ViewMode::Grid);
    assert_eq!(s.projects_view_mode, ViewMode::Grid);
}
```

- [ ] **Step 2: Run the test — expect failure**

Run: `cargo test --test projects_ipc`

Expected: compile error — `projects_test_helpers` module does not exist.

- [ ] **Step 3: Add helper module + commands to `src/ipc.rs`**

At the top of `src/ipc.rs`, extend the `use` statements:

```rust
use crate::types::{AuthState, ProjectConfig, Settings, UsageSnapshot, ViewMode};
```

Near the end of the file (before `#[cfg(test)]`), add:

```rust
/// Pure helpers extracted from the Tauri command wrappers so they can be
/// unit-tested without standing up a full app handle.
pub mod projects_test_helpers {
    use crate::types::{ProjectConfig, Settings, ViewMode};

    pub fn list_from(s: &Settings) -> Vec<ProjectConfig> { s.projects.clone() }

    pub fn get_from(s: &Settings, id: &str) -> Option<ProjectConfig> {
        s.projects.iter().find(|p| p.id == id).cloned()
    }

    /// Applies a partial JSON patch in-place. Unknown keys are ignored.
    /// Returns `true` if the project existed.
    pub fn update_in(s: &mut Settings, id: &str, patch: serde_json::Value)
        -> bool
    {
        let Some(p) = s.projects.iter_mut().find(|p| p.id == id) else {
            return false;
        };
        // Round-trip the project through JSON, apply the patch, deserialize
        // back. This gives us a free partial update without per-field code.
        let mut obj = serde_json::to_value(&*p).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        if let Some(patch_obj) = patch.as_object() {
            for (k, v) in patch_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
        if let Ok(updated) = serde_json::from_value::<ProjectConfig>(serde_json::Value::Object(obj)) {
            *p = updated;
            true
        } else {
            false
        }
    }

    pub fn delete_in(s: &mut Settings, id: &str) -> bool {
        let before = s.projects.len();
        s.projects.retain(|p| p.id != id);
        s.projects.len() < before
    }

    pub fn set_view_mode(s: &mut Settings, mode: ViewMode) {
        s.projects_view_mode = mode;
    }
}
```

Then add the five Tauri command wrappers. Find a sensible location near the other settings-related commands:

```rust
#[tauri::command]
pub fn list_projects(state: State<AppState>) -> Vec<ProjectConfig> {
    projects_test_helpers::list_from(&state.settings.lock().unwrap())
}

#[tauri::command]
pub fn get_project(id: String, state: State<AppState>) -> Option<ProjectConfig> {
    projects_test_helpers::get_from(&state.settings.lock().unwrap(), &id)
}

#[tauri::command]
pub fn update_project(
    id: String,
    patch: serde_json::Value,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let mut guard = state.settings.lock().unwrap();
    if !projects_test_helpers::update_in(&mut guard, &id, patch) {
        return Err(format!("project {id} not found"));
    }
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn delete_project(
    id: String,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let mut guard = state.settings.lock().unwrap();
    if !projects_test_helpers::delete_in(&mut guard, &id) {
        return Err(format!("project {id} not found"));
    }
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

#[tauri::command]
pub fn set_projects_view_mode(
    mode: ViewMode,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let settings_path = paths::settings_file().map_err(|e| e.to_string())?;
    let mut guard = state.settings.lock().unwrap();
    projects_test_helpers::set_view_mode(&mut guard, mode);
    settings::save(&settings_path, &guard).map_err(|e| e.to_string())?;
    let snapshot = guard.clone();
    drop(guard);
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `cargo test --test projects_ipc`

Expected: all six tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ipc.rs tests/projects_ipc.rs
git commit -m "FEAT: project CRUD IPC commands (list/get/update/delete + view mode)"
```

---

### Task 3: Register new IPC commands + extend the electron-api shim

**Files:**
- Modify: `src/lib.rs` (around line 60-94, the `generate_handler![...]` block)
- Modify: `dist/electron-api-shim.js`

All frontend code calls `window.electronAPI.<method>()` via the shim in `dist/electron-api-shim.js`; it wraps Tauri's `invoke`. Adding shim methods keeps the calling pattern consistent across the app.

- [ ] **Step 1: Modify the invoke handler**

In `src/lib.rs`, inside `tauri::generate_handler![...]`, add the five new commands (any position inside the macro is fine; group near existing settings commands for readability):

```rust
ipc::list_projects,
ipc::get_project,
ipc::update_project,
ipc::delete_project,
ipc::set_projects_view_mode,
```

- [ ] **Step 2: Build — expect success**

Run: `cargo build`

Expected: compiles cleanly. If a warning fires about unused `use`, clean up.

- [ ] **Step 3: Add shim methods in `dist/electron-api-shim.js`**

Inside the `bridge = { ... }` object literal (keep alphabetically grouped or near the other settings-adjacent methods), add:

```javascript
// --- Projects (Plan A shell; populated by Plan B) ---
listProjects: () => invoke('list_projects'),
getProject: (id) => invoke('get_project', { id }),
updateProject: async (id, patch) => {
  try { await invoke('update_project', { id, patch }); }
  catch (e) { console.error('update_project failed', e); throw e; }
},
deleteProject: async (id) => {
  try { await invoke('delete_project', { id }); }
  catch (e) { console.error('delete_project failed', e); throw e; }
},
setProjectsViewMode: async (mode) => {
  try { await invoke('set_projects_view_mode', { mode }); }
  catch (e) { console.error('set_projects_view_mode failed', e); throw e; }
},
```

- [ ] **Step 4: Run vitest for shim shape coverage (if covered)**

Run: `npx vitest run tests/shim_shape_mapping.test.mjs`

Expected: PASS. If the shim tests enumerate methods, extend them to include the new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib.rs dist/electron-api-shim.js tests/shim_shape_mapping.test.mjs
git commit -m "CHORE: register project IPC commands and add shim wrappers"
```

---

### Task 4: Load Phosphor Icons CDN + base sidemenu CSS scaffolding

**Files:**
- Modify: `dist/dashboard.html` (head)
- Modify: `dist/dashboard.css`

- [ ] **Step 1: Add Phosphor CDN script to `dist/dashboard.html`**

Inside the `<head>`, above the existing DM Sans Google Fonts `<link>`, add:

```html
<script src="https://unpkg.com/@phosphor-icons/web@2.1.1"></script>
```

- [ ] **Step 2: Update the CSP `connect-src` / `script-src` if needed**

The existing CSP in `dashboard.html` contains:

```
script-src 'self' 'unsafe-inline';
```

Add `https://unpkg.com` to `script-src` so the Phosphor CDN script loads:

```
script-src 'self' 'unsafe-inline' https://unpkg.com;
```

Also update `tauri.conf.json`'s `app.security.csp` field to add `https://unpkg.com` to `script-src` to match — both CSPs apply.

- [ ] **Step 3: Add sidemenu CSS to `dist/dashboard.css`**

At the end of the file, append:

```css
/* ── Sidemenu ──────────────────────────────────────────────────────────── */
.sidemenu-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms ease;
  z-index: 900;
}
.sidemenu-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}

.sidemenu {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: 220px;
  background: var(--bg-elevated, #1b1b26);
  border-right: 1px solid var(--border, #2a2a3a);
  transform: translateX(-100%);
  transition: transform 200ms ease;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  padding: 12px 8px;
  box-sizing: border-box;
}
.sidemenu.open { transform: translateX(0); }

.sidemenu-header {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-dim, #9a9ab0);
  padding: 6px 10px 14px;
  font-weight: 600;
}

.sidemenu-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 6px;
  margin-bottom: 2px;
  font-size: 0.82rem;
  cursor: pointer;
  color: var(--text, #c5c5d6);
}
.sidemenu-nav-item:hover {
  background: var(--bg-hover, rgba(255,255,255,0.05));
}
.sidemenu-nav-item.active {
  background: var(--bg-active, #2a2a3a);
  color: var(--text-strong, #ffffff);
}
.sidemenu-nav-item i {
  font-size: 1.1rem;
  width: 20px;
  text-align: center;
}

.icon-btn.burger {
  font-size: 1.1rem;
}
```

- [ ] **Step 4: Commit**

```bash
git add dist/dashboard.html dist/dashboard.css tauri.conf.json
git commit -m "CHORE: load Phosphor Icons CDN + scaffold sidemenu CSS"
```

---

### Task 5: Add sidemenu HTML structure + burger button to every top-level view header

**Files:**
- Modify: `dist/dashboard.html`

- [ ] **Step 1: Insert the sidemenu overlay + sidebar markup**

Immediately after the opening `<body>` tag in `dist/dashboard.html`, add:

```html
<!-- ══════════════════════════════════════════════════════════════════════
     Sidemenu (overlay)
═══════════════════════════════════════════════════════════════════════ -->
<div class="sidemenu-backdrop" id="sidemenuBackdrop"></div>
<aside class="sidemenu" id="sidemenu" aria-label="Main navigation">
  <div class="sidemenu-header">Claude Usage</div>
  <div class="sidemenu-nav-item" data-view="dashboard" id="sm-home">
    <i class="ph ph-house"></i><span>Home</span>
  </div>
  <div class="sidemenu-nav-item" data-view="statistics" id="sm-statistics">
    <i class="ph ph-chart-line"></i><span>Statistics</span>
  </div>
  <div class="sidemenu-nav-item" data-view="projects" id="sm-projects">
    <i class="ph ph-folder"></i><span>Projects</span>
  </div>
  <div class="sidemenu-nav-item" data-view="settings" id="sm-settings">
    <i class="ph ph-gear"></i><span>Settings</span>
  </div>
</aside>
```

- [ ] **Step 2: Replace Home header buttons with a single burger**

Find the header inside `view-dashboard` (around line 41-46):

```html
<div class="view-header">
    <button class="icon-btn" id="statsBtn" title="Token Stats">≡</button>
    <h2>Claude Usage</h2>
    <button class="icon-btn" id="settingsBtn" title="Settings">⚙</button>
</div>
```

Replace with:

```html
<div class="view-header">
    <button class="icon-btn burger" id="burgerBtn-home" title="Menu" data-burger="true">
        <i class="ph ph-list"></i>
    </button>
    <h2>Claude Usage</h2>
    <div style="width:32px"></div>
</div>
```

- [ ] **Step 3: Do not touch the Settings view header yet**

The Settings view keeps its existing back button for now. We'll reconcile in Task 7.

- [ ] **Step 4: Commit**

```bash
git add dist/dashboard.html
git commit -m "FEAT: sidemenu overlay markup + burger button on Home"
```

---

### Task 6: Wire sidemenu open/close + nav item routing in `dist/dashboard.js`

**Files:**
- Modify: `dist/dashboard.js`
- Create: `tests/sidemenu_nav.test.mjs`

- [ ] **Step 1: Write the failing vitest**

Create `tests/sidemenu_nav.test.mjs`:

```javascript
// Static analysis + lightweight DOM checks for the sidemenu wiring.
// Verifies the sidemenu markup is present and the JS references the
// expected IDs. Full behavioural testing happens in the manual QA pass.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");
const html = readFileSync(join(distDir, "dashboard.html"), "utf8");
const js = readFileSync(join(distDir, "dashboard.js"), "utf8");

describe("sidemenu markup", () => {
  it("includes a backdrop and an aside element", () => {
    expect(html).toMatch(/id="sidemenuBackdrop"/);
    expect(html).toMatch(/<aside[^>]*id="sidemenu"/);
  });

  it("has all four top-level nav items with data-view attributes", () => {
    for (const view of ["dashboard", "statistics", "projects", "settings"]) {
      expect(html).toMatch(new RegExp(`data-view="${view}"`));
    }
  });

  it("has a burger button on the Home view", () => {
    expect(html).toMatch(/id="burgerBtn-home"/);
  });
});

describe("sidemenu wiring", () => {
  it("JS references sidemenu IDs and attaches a backdrop click handler", () => {
    expect(js).toMatch(/sidemenuBackdrop/);
    expect(js).toMatch(/sidemenu(?!Backdrop)/);
  });

  it("JS iterates over .sidemenu-nav-item elements", () => {
    expect(js).toMatch(/\.sidemenu-nav-item/);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npx vitest run tests/sidemenu_nav.test.mjs`

Expected: FAIL (sidemenu IDs not in JS yet; the markup tests should pass from Task 5).

- [ ] **Step 3: Add sidemenu JS to `dist/dashboard.js`**

Near the top of `dist/dashboard.js`, right after the `VIEWS` constant definition, insert:

```javascript
// ── Sidemenu ───────────────────────────────────────────────────────────────
function openSidemenu() {
  document.getElementById("sidemenu").classList.add("open");
  document.getElementById("sidemenuBackdrop").classList.add("open");
}
function closeSidemenu() {
  document.getElementById("sidemenu").classList.remove("open");
  document.getElementById("sidemenuBackdrop").classList.remove("open");
}
function updateSidemenuActive(viewName) {
  document.querySelectorAll(".sidemenu-nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === viewName);
  });
}

// Every burger button in the app opens the sidemenu.
document.querySelectorAll("[data-burger]").forEach((btn) => {
  btn.onclick = () => openSidemenu();
});

document.getElementById("sidemenuBackdrop").onclick = closeSidemenu;

// Nav item click → navigate + close.
document.querySelectorAll(".sidemenu-nav-item").forEach((item) => {
  item.onclick = () => {
    const view = item.dataset.view;
    showView(view);
    closeSidemenu();
  };
});
```

- [ ] **Step 4: Hook active-state tracking into `showView`**

Replace the existing `showView` function with:

```javascript
function showView(name) {
  previousView = activeView;
  activeView = name;
  for (const id of VIEWS) {
    document.getElementById(`view-${id}`).classList.toggle("hidden", id !== name);
  }
  updateSidemenuActive(name);
}
```

- [ ] **Step 5: Remove the dead `settingsBtn` click handler**

Delete the line:

```javascript
document.getElementById("settingsBtn").onclick = () => showView("settings");
```

(The button itself was removed in Task 5; this handler would throw.)

Also remove the `statsBtn` handler — we'll re-wire navigation via the sidemenu:

```javascript
document.getElementById("statsBtn").onclick = () => { ... };
```

- [ ] **Step 6: Run the tests — expect pass**

Run: `npx vitest run tests/sidemenu_nav.test.mjs`

Expected: all tests PASS.

- [ ] **Step 7: Sanity build + launch**

Run: `cargo tauri dev`

Expected:
- App launches without JS console errors.
- Burger on Home opens sidemenu. Click backdrop closes it.
- Tapping Home / Settings nav items navigates.
- Statistics + Projects items currently go nowhere (views don't exist yet) — expected, noted for Task 8+.

Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add dist/dashboard.js tests/sidemenu_nav.test.mjs
git commit -m "FEAT: sidemenu open/close + nav routing wiring"
```

---

### Task 7: Rename `view-stats` → `view-projects` and `view-stats-project` → `view-project-detail`

**Files:**
- Modify: `dist/dashboard.html`
- Modify: `dist/dashboard.js`
- Modify: `tests/dashboard_wiring.test.mjs` and `tests/dashboard_end_to_end.test.mjs` if they reference the old names

- [ ] **Step 1: Search for references**

Run: `grep -n "view-stats\|stats-project\|statsBackBtn\|projectDetailBackBtn" dist tests`

Note every hit — we'll replace each below.

- [ ] **Step 2: Rename in `dist/dashboard.html`**

Using a find-and-replace in the file:
- `view-stats-project` → `view-project-detail`
- `view-stats` → `view-projects`
- `statsBackBtn` → `projectsBackBtn`
- `projectDetailBackBtn` stays the same (it's semantically correct).
- `id="view-stats"` header element: change the `<h2>Token Stats</h2>` text to `<h2>Projects</h2>` and replace the back button icon-text `←` with `<i class="ph ph-arrow-left"></i>`.
- Replace the back button on Home's projects view with a burger (projects is a top-level view now). In the `view-projects` header, swap the back button for:

```html
<button class="icon-btn burger" id="burgerBtn-projects" title="Menu" data-burger="true">
    <i class="ph ph-list"></i>
</button>
```

and remove the `statsBackBtn` reference from JS.

- [ ] **Step 3: Rename in `dist/dashboard.js`**

Update the `VIEWS` array:

```javascript
const VIEWS = ["dashboard", "settings", "settings-visuals", "settings-themes", "settings-notifications", "settings-sync", "statistics", "projects", "project-detail", "graph-detail"];
```

Note the additions: `statistics` and the renames. `statistics` doesn't exist yet — Task 8 adds it. Adding it to `VIEWS` now causes `showView` to fail when it tries to query `view-statistics` if it doesn't exist. Defer the array change until Task 8 — for now, only rename:

```javascript
const VIEWS = ["dashboard", "settings", "settings-visuals", "settings-themes", "settings-notifications", "settings-sync", "projects", "project-detail", "graph-detail"];
```

Other JS changes:
- Remove the `statsBtn` line (it was removed in Task 6).
- Change `document.getElementById("statsBackBtn").onclick = ...` → delete this line; back navigation for Projects goes through the sidemenu/burger now.
- Update references:
  - `showView("stats")` → `showView("projects")`
  - `showView("stats-project")` → `showView("project-detail")`
  - The `projectDetailBackBtn` handler should go back to `projects`: `document.getElementById("projectDetailBackBtn").onclick = () => showView("projects");`

- [ ] **Step 4: Rename in tests**

In `tests/dashboard_wiring.test.mjs` and `tests/dashboard_end_to_end.test.mjs`, replace any literal strings `view-stats` with `view-projects`, `stats-project` with `project-detail`, etc. If none exist, skip.

- [ ] **Step 5: Run all tests — expect pass**

Run: `npx vitest run`

Expected: all tests PASS. Fix any straggler string references.

- [ ] **Step 6: Sanity build + launch**

Run: `cargo tauri dev`

Expected:
- Open sidemenu, tap Projects → lands on the renamed view (still shows Token Stats rendering under the hood).
- Tap a project row → Project detail loads.
- Back button on detail returns to Projects.

Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add dist/dashboard.html dist/dashboard.js tests/dashboard_wiring.test.mjs tests/dashboard_end_to_end.test.mjs
git commit -m "REFACTOR: rename view-stats to view-projects and view-stats-project to view-project-detail"
```

---

### Task 8: Add Statistics view (new)

**Files:**
- Modify: `dist/dashboard.html`
- Modify: `dist/dashboard.js`

- [ ] **Step 1: Add the new view div**

In `dist/dashboard.html`, after `view-dashboard` closes (after line ~50), insert:

```html
<!-- ══════════════════════════════════════════════════════════════════════
     View: Statistics
═══════════════════════════════════════════════════════════════════════ -->
<div id="view-statistics" class="view hidden">
    <div class="view-header">
        <button class="icon-btn burger" id="burgerBtn-statistics" title="Menu" data-burger="true">
            <i class="ph ph-list"></i>
        </button>
        <h2>Statistics</h2>
        <div style="width:32px"></div>
    </div>
    <div class="view-body">
        <div id="statistics-content"><div class="no-data">No data yet.</div></div>
    </div>
</div>
```

- [ ] **Step 2: Add `statistics` to the `VIEWS` array**

In `dist/dashboard.js`:

```javascript
const VIEWS = ["dashboard", "settings", "settings-visuals", "settings-themes", "settings-notifications", "settings-sync", "statistics", "projects", "project-detail", "graph-detail"];
```

- [ ] **Step 3: Verify the wiring**

The sidemenu nav item `data-view="statistics"` from Task 5 will now resolve.

- [ ] **Step 4: Sanity run**

Run: `cargo tauri dev`

Expected: tapping Statistics in the sidemenu lands on a blank view that says "No data yet." No console errors.

- [ ] **Step 5: Commit**

```bash
git add dist/dashboard.html dist/dashboard.js
git commit -m "FEAT: add Statistics view as a sidemenu-accessible placeholder"
```

---

### Task 9: Extract charts/widgets from Home into Statistics

**Files:**
- Modify: `dist/dashboard.html`
- Modify: `dist/dashboard.js`

Home currently loads `renderDashboardContent(...)` output into `#stats-content` inside `view-dashboard`. We want Home to show only the two big session + weekly cards, and move everything else into `#statistics-content` inside `view-statistics`.

Inspect the rendering path first:

- [ ] **Step 1: Locate the renderer that fills `#stats-content`**

Run: `grep -n 'stats-content' dist/dashboard.js dist/modules/*.js`

Note the function name (likely in `dist/modules/stats.js` or inlined). Call it `renderStatsContent` in the instructions below; substitute the actual name.

- [ ] **Step 2: Split the renderer**

If the current function renders both the big cards AND the other widgets into the same container, split it into two:

- `renderHomeCards(data)` — returns HTML for the two big cards only.
- `renderStatistics(data)` — returns HTML for everything else (pace charts, history, extra-usage, etc.).

Wire both callers:

```javascript
document.getElementById("stats-content").innerHTML = renderHomeCards(data);
document.getElementById("statistics-content").innerHTML = renderStatistics(data);
```

Call both whenever `lastHistory` or `lastUsage` updates (i.e., at whatever point `stats-content` currently gets refreshed).

If the existing code uses a single big template literal, extract the "two big cards" portion and leave everything else to the new function.

- [ ] **Step 3: Update selectors/IDs inside the moved content**

If any element IDs are referenced by other JS (e.g. for click handlers or chart updates), they keep working — the moved HTML just lives in a different parent. Only change if a selector assumed a specific parent.

- [ ] **Step 4: Test**

Run: `npx vitest run`

Expected: PASS. Existing wiring tests may reference ID selectors; verify they still hold.

Run: `cargo tauri dev`

Expected:
- Home shows only the two big cards.
- Statistics shows the pace charts, history chart, etc.
- Both refresh on new data.

- [ ] **Step 5: Commit**

```bash
git add dist/dashboard.html dist/dashboard.js dist/modules/*.js
git commit -m "REFACTOR: move analytics widgets out of Home into Statistics"
```

---

### Task 10: Enlarge Home cards

**Files:**
- Modify: `dist/dashboard.css`
- Possibly: the template portion of `renderHomeCards` if it sets inline sizes

- [ ] **Step 1: Add Home-specific card styles**

Append to `dist/dashboard.css`:

```css
/* ── Home (dashboard view): enlarged cards ────────────────────────────── */
#view-dashboard .view-body { padding: 20px 16px; }
#view-dashboard .home-card {
  background: var(--bg-elevated, #1f1f2c);
  border: 1px solid var(--border, #2e2e40);
  border-radius: 10px;
  padding: 22px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 14px;
  min-height: 170px;
}
#view-dashboard .home-card .label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim, #8a8aa0);
}
#view-dashboard .home-card .ring-wrap {
  align-self: center;
  margin: 4px 0;
}
#view-dashboard .home-card .pct {
  font-size: 1.75rem;
  font-weight: 600;
  align-self: center;
}
#view-dashboard .home-card .sub {
  font-size: 0.72rem;
  color: var(--text-dim, #8a8aa0);
  text-align: center;
}
```

- [ ] **Step 2: Update `renderHomeCards` to emit elements with class `home-card`**

Wrap each card in a `<div class="home-card">`. Add `.label`, `.ring-wrap`, `.pct`, `.sub` child classes to match the CSS. Keep the existing ring/pct content; wrap it in the new container.

- [ ] **Step 3: Visual check**

Run: `cargo tauri dev`

Expected: Home now shows two big cards taking most of the visible area, each ~170px tall.

- [ ] **Step 4: Commit**

```bash
git add dist/dashboard.css dist/dashboard.js dist/modules/*.js
git commit -m "STYLE: enlarge Home cards now that other widgets moved to Statistics"
```

---

### Task 11: Projects view header — grid/list toggle

**Files:**
- Modify: `dist/dashboard.html` (inside `view-projects` header)
- Modify: `dist/dashboard.css`
- Modify: `dist/dashboard.js`

- [ ] **Step 1: Replace the `view-projects` header**

Inside `view-projects`, replace the header with:

```html
<div class="view-header">
    <button class="icon-btn burger" id="burgerBtn-projects" title="Menu" data-burger="true">
        <i class="ph ph-list"></i>
    </button>
    <h2>Projects</h2>
    <div class="view-mode-toggle" id="projectsViewModeToggle">
        <button class="mode-btn active" data-mode="grid" title="Grid"><i class="ph ph-squares-four"></i></button>
        <button class="mode-btn" data-mode="list" title="List"><i class="ph ph-list-bullets"></i></button>
    </div>
</div>
```

- [ ] **Step 2: Add CSS**

Append to `dist/dashboard.css`:

```css
.view-mode-toggle {
  display: inline-flex;
  border: 1px solid var(--border, #2a2a3a);
  border-radius: 6px;
  overflow: hidden;
}
.view-mode-toggle .mode-btn {
  background: transparent;
  border: 0;
  padding: 5px 9px;
  color: var(--text-dim, #8a8aa0);
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
}
.view-mode-toggle .mode-btn.active {
  background: var(--bg-active, #2a2a3a);
  color: var(--text-strong, #ffffff);
}
```

- [ ] **Step 3: Wire the toggle in `dist/dashboard.js`**

Add near other per-view wiring:

```javascript
// Projects grid/list toggle
document.querySelectorAll("#projectsViewModeToggle .mode-btn").forEach((btn) => {
  btn.onclick = async () => {
    const mode = btn.dataset.mode;
    document.querySelectorAll("#projectsViewModeToggle .mode-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    await window.electronAPI.setProjectsViewMode(mode);
    renderProjectsList(); // defined in Task 12
  };
});

async function syncProjectsViewModeFromSettings() {
  const s = await window.electronAPI.getSettings();
  const mode = s.projects_view_mode || "grid";
  document.querySelectorAll("#projectsViewModeToggle .mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
}
```

Call `syncProjectsViewModeFromSettings()` once at startup, after the initial settings load.

- [ ] **Step 4: Sanity check**

Run: `cargo tauri dev`

Expected:
- Projects header shows two toggle buttons.
- Clicking one switches its active state.
- Settings JSON on disk should now contain `"projects_view_mode": "list"` or `"grid"` based on your choice.

- [ ] **Step 5: Commit**

```bash
git add dist/dashboard.html dist/dashboard.css dist/dashboard.js
git commit -m "FEAT: grid/list toggle on Projects header wired to set_projects_view_mode"
```

---

### Task 12: Render projects as grid or list cards

**Files:**
- Modify: `dist/dashboard.html` (Projects view body)
- Modify: `dist/dashboard.js`
- Modify: `dist/modules/stats.js` (where the existing project list gets rendered) — OR add a new module
- Modify: `dist/dashboard.css`
- Create: `tests/projects_view.test.mjs`

Plan A's Projects screen keeps the existing token-history-derived list as its *primary* source of projects, and layers `settings.projects` on top to override name + avatar.

- [ ] **Step 1: Write the failing vitest**

Create `tests/projects_view.test.mjs`:

```javascript
// Light static-analysis + DOM rendering test for the Projects view.
// Uses jsdom (default vitest env) to mount the Projects grid/list container
// and verifies class changes when mode flips.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");
const html = readFileSync(join(distDir, "dashboard.html"), "utf8");

describe("Projects view DOM", () => {
  it("has a projects-list container inside view-projects", () => {
    expect(html).toMatch(/id="projects-list"/);
  });

  it("includes a grid/list toggle with mode buttons", () => {
    expect(html).toMatch(/id="projectsViewModeToggle"/);
    expect(html).toMatch(/data-mode="grid"/);
    expect(html).toMatch(/data-mode="list"/);
  });

  it("has an empty-state element", () => {
    expect(html).toMatch(/id="projects-empty"/);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npx vitest run tests/projects_view.test.mjs`

Expected: FAIL — the IDs don't exist in the HTML yet.

- [ ] **Step 3: Update `view-projects` body in `dist/dashboard.html`**

Replace:

```html
<div class="view-body">
    <div id="stats-table-container"><div class="no-data">Loading...</div></div>
    ...
</div>
```

with:

```html
<div class="view-body">
    <div id="projects-empty" class="no-data" style="display:none">No projects yet.</div>
    <div id="projects-list" class="projects-list grid-mode"></div>
    <div style="margin-top:14px">
        <button class="btn-secondary" id="backfillBtn" style="width:100%;font-size:0.8rem">↺ Rebuild History</button>
        <div id="backfill-status" style="text-align:center;font-size:0.72rem;color:var(--text-dim);margin-top:6px;display:none"></div>
    </div>
</div>
```

- [ ] **Step 4: Add CSS for grid + list + card styles**

Append to `dist/dashboard.css`:

```css
.projects-list.grid-mode {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.projects-list.list-mode {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.project-card {
  background: var(--bg-elevated, #1f1f2c);
  border: 1px solid var(--border, #2e2e40);
  border-radius: 7px;
  padding: 10px 12px;
  display: flex;
  gap: 10px;
  cursor: pointer;
  transition: border-color 120ms;
}
.project-card:hover { border-color: var(--accent, #4c9eff); }

.project-card .avatar {
  width: 38px;
  height: 38px;
  border-radius: 7px;
  background: var(--bg-active, #3a3a52);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.2rem;
  flex-shrink: 0;
}
.project-card .body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.project-card .name {
  font-weight: 600;
  font-size: 0.86rem;
  color: var(--text, #e4e4ee);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-card .tags {
  display: flex;
  gap: 4px;
  align-items: center;
  font-size: 0.7rem;
  color: var(--text-dim, #8a8aa0);
}
.project-card .tokens {
  font-size: 0.72rem;
  color: var(--text-dim, #8a8aa0);
}

.projects-list.list-mode .project-card {
  padding: 8px 10px;
}
.projects-list.list-mode .project-card .avatar {
  width: 28px;
  height: 28px;
  font-size: 1rem;
}
```

- [ ] **Step 5: Add a rendering function in `dist/dashboard.js`**

Add (near other render functions):

```javascript
async function renderProjectsList() {
  const tokenHistory = lastTokenHistory || (await window.electronAPI.getTokenHistory?.()) || [];
  const projects = await window.electronAPI.listProjects();

  // Aggregate from token history by cwd.
  const byPath = new Map();
  for (const rec of tokenHistory) {
    const key = rec.cwd || "(unknown)";
    const bucket = byPath.get(key) || { cwd: key, tokens_7d: 0 };
    bucket.tokens_7d += (rec.input_tokens || 0) + (rec.output_tokens || 0);
    byPath.set(key, bucket);
  }

  // Overlay settings.projects for display name + avatar.
  for (const p of projects) {
    const existing = byPath.get(p.path) || { cwd: p.path, tokens_7d: 0 };
    existing.name = p.name;
    existing.avatar = p.avatar;
    existing.projectId = p.id;
    byPath.set(p.path, existing);
  }

  const entries = [...byPath.values()].sort((a, b) => (b.tokens_7d || 0) - (a.tokens_7d || 0));

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
    el.onclick = () => {
      openProjectDetail(el.dataset.cwd);
    };
  });
}

function projectCardHtml(entry) {
  const displayName = entry.name || basename(entry.cwd);
  const avatar = renderAvatar(entry.avatar);
  const tokens = formatCompactTokens(entry.tokens_7d || 0);
  return `
    <div class="project-card" data-cwd="${escapeHtml(entry.cwd)}" data-project-id="${entry.projectId || ""}">
      <div class="avatar">${avatar}</div>
      <div class="body">
        <div class="name">${escapeHtml(displayName)}</div>
        <div class="tokens">${tokens} tokens · last 7d</div>
      </div>
    </div>
  `;
}

function renderAvatar(avatar) {
  if (!avatar || avatar.kind === "none") return "?";
  if (avatar.kind === "emoji") return escapeHtml(avatar.value);
  if (avatar.kind === "image") {
    const src = `file:///${String(avatar.value).replaceAll("\\", "/")}`;
    return `<img src="${src}" style="width:100%;height:100%;object-fit:cover;border-radius:7px" alt="">`;
  }
  return "?";
}

function basename(p) {
  if (!p) return "(unknown)";
  const parts = String(p).split(/[\\/]/);
  return parts.filter(Boolean).pop() || "(unknown)";
}

function formatCompactTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"
  }[c]));
}
```

Call `renderProjectsList()`:
- When Projects view is shown (either intercept `showView("projects")` with an after-effect, or call it directly in the sidemenu click handler for Projects).
- After the grid/list toggle (see Task 11).
- After `list_projects` / `get_settings` emits a `settings-changed` event.

Example: extend the sidemenu nav-item click handler to:

```javascript
item.onclick = () => {
  const view = item.dataset.view;
  showView(view);
  closeSidemenu();
  if (view === "projects") renderProjectsList();
};
```

- [ ] **Step 6: Update `openProjectDetail(cwd)`**

If the existing code uses a function with a similar name driving the old detail view, reuse it (it takes a cwd and populates the detail view). If not, add a stub:

```javascript
function openProjectDetail(cwd) {
  projectDetailState.cwd = cwd;
  renderProjectDetail(); // existing function
  showView("project-detail");
}
```

- [ ] **Step 7: Run tests — expect pass**

Run: `npx vitest run`

Expected: all pass. `tests/projects_view.test.mjs` PASS.

Run: `cargo tauri dev`

Expected:
- Projects screen shows cards in grid or list based on persisted view mode.
- Cards are sortable by tokens desc.
- Clicking a card opens the detail view.
- Empty state shows "No projects yet." when there are no token history entries AND no configured projects.

- [ ] **Step 8: Commit**

```bash
git add dist/dashboard.html dist/dashboard.js dist/dashboard.css tests/projects_view.test.mjs
git commit -m "FEAT: Projects view renders cards in grid or list with settings.projects overlay"
```

---

### Task 13: Project detail header refactor (avatar + name + path + Automate button)

**Files:**
- Modify: `dist/dashboard.html`
- Modify: `dist/dashboard.css`
- Modify: `dist/dashboard.js`

- [ ] **Step 1: Replace the `view-project-detail` header**

Find the `view-project-detail` header block and replace with:

```html
<div class="view-header project-detail-header">
    <button class="icon-btn" id="projectDetailBackBtn" title="Back">
        <i class="ph ph-arrow-left"></i>
    </button>
    <div class="project-detail-heading">
        <div class="avatar-mini" id="projectDetailAvatar">?</div>
        <div class="project-detail-titles">
            <h2 id="projectDetailTitle" style="font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" title="Click to rename">Project</h2>
            <input id="projectDetailTitleInput" type="text" style="display:none;flex:1;font-weight:600;font-size:0.88rem">
            <div class="project-detail-path" id="projectDetailHeaderPath"></div>
        </div>
    </div>
    <button class="icon-btn" id="projectDetailMenuBtn" title="Project menu">
        <i class="ph ph-dots-three-vertical"></i>
    </button>
</div>
```

Keep the existing `projectDetailTitle` + input behaviour (the inline rename). Just reshape the surrounding layout.

- [ ] **Step 2: Append CSS**

```css
.project-detail-header { align-items: flex-start; padding: 10px 12px; }
.project-detail-heading {
  display: flex;
  gap: 10px;
  flex: 1;
  min-width: 0;
  align-items: center;
}
.project-detail-heading .avatar-mini {
  width: 32px; height: 32px;
  border-radius: 7px;
  background: var(--bg-active, #3a3a52);
  display: flex; align-items: center; justify-content: center;
  font-size: 1.05rem;
  flex-shrink: 0;
}
.project-detail-titles {
  display: flex; flex-direction: column; gap: 2px;
  min-width: 0; flex: 1;
}
.project-detail-path {
  font-size: 0.66rem;
  color: var(--text-dim, #8a8aa0);
  font-family: 'Fira Code', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Automate channel placeholder button */
.automate-cta {
  background: var(--accent, #2c5fd6);
  color: #fff;
  border: 0;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.78rem;
  cursor: pointer;
  font-weight: 500;
}
.automate-cta:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
```

- [ ] **Step 3: Update `renderProjectDetail` to populate the new header elements**

Find `renderProjectDetail` in `dist/dashboard.js` or its module. After computing project data, add:

```javascript
const avatarEl = document.getElementById("projectDetailAvatar");
const pathEl = document.getElementById("projectDetailHeaderPath");

const configuredProject = (currentSettings.projects || []).find((p) => p.path === projectDetailState.cwd);
avatarEl.innerHTML = renderAvatar(configuredProject?.avatar || { kind: "emoji", value: basename(projectDetailState.cwd).charAt(0) });
pathEl.textContent = projectDetailState.cwd || "";
```

- [ ] **Step 4: Add "+ Automate channel" CTA below the header**

In the `view-project-detail` body, prepend (ABOVE the running-instances shell from Task 14):

```html
<div style="padding: 8px 0 14px; display: flex; justify-content: flex-end;">
    <button class="automate-cta" id="automateChannelBtn">+ Automate channel</button>
</div>
```

Wire the click:

```javascript
document.getElementById("automateChannelBtn").onclick = () => {
  showToast("Channel automation ships in the next update.");
};
```

If `showToast` doesn't exist, add a minimal one:

```javascript
function showToast(msg) {
  let t = document.getElementById("__toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "__toast";
    t.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#2a2a3a;color:#fff;padding:8px 14px;border-radius:6px;font-size:0.8rem;z-index:2000;opacity:0;transition:opacity 160ms;";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t.__timer);
  t.__timer = setTimeout(() => { t.style.opacity = "0"; }, 2200);
}
```

- [ ] **Step 5: Sanity run**

Run: `cargo tauri dev`

Expected: detail view shows back button + avatar + name + path + menu on the right. Automate button shows a toast and no crash.

- [ ] **Step 6: Commit**

```bash
git add dist/dashboard.html dist/dashboard.css dist/dashboard.js dist/modules/*.js
git commit -m "FEAT: restructure Project detail header with avatar, path, automate CTA"
```

---

### Task 14: Running-instances section shell in Project detail

**Files:**
- Modify: `dist/dashboard.html`
- Modify: `dist/dashboard.css`

- [ ] **Step 1: Add the section to Project detail body**

In `view-project-detail` body, between the Automate CTA (Task 13) and the existing range-toggle row, insert:

```html
<section class="instances-section" id="runningInstancesSection">
    <div class="section-title">Running instances <span id="runningInstancesCount" class="count-pill">0</span></div>
    <div id="runningInstancesEmpty" class="no-data">No Claude Code instances running in this project.</div>
    <div id="runningInstancesList" style="display:none"></div>
</section>
```

- [ ] **Step 2: CSS**

Append to `dist/dashboard.css`:

```css
.instances-section {
  margin-bottom: 16px;
}
.instances-section .section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim, #9a9ab0);
  font-weight: 600;
  margin-bottom: 8px;
}
.count-pill {
  background: var(--bg-active, #2a2a3a);
  color: var(--text-dim, #9a9ab0);
  font-size: 0.66rem;
  padding: 1px 7px;
  border-radius: 10px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}
.instances-section .no-data {
  font-size: 0.78rem;
  color: var(--text-dim, #8a8aa0);
  padding: 10px 0;
}
```

- [ ] **Step 3: Sanity run**

Run: `cargo tauri dev`

Expected: detail view shows the section with "Running instances 0" title and "No Claude Code instances running in this project." empty-state text.

- [ ] **Step 4: Commit**

```bash
git add dist/dashboard.html dist/dashboard.css
git commit -m "FEAT: running-instances section shell in Project detail (empty-state only)"
```

---

### Task 15: Smoke test + docs pass + final cleanup

**Files:**
- Modify: `CLAUDE.md` (append a short note about the new sidemenu + Projects screen)

- [ ] **Step 1: Full test pass**

Run: `cargo test`
Run: `npx vitest run`

Expected: all PASS.

- [ ] **Step 2: Manual QA checklist**

Run `cargo tauri dev` and step through:

- [ ] Burger button appears on Home, Statistics, Projects.
- [ ] Burger opens sidemenu with four items; active view is highlighted.
- [ ] Clicking backdrop closes sidemenu.
- [ ] Home shows only the two big cards (no pace charts, no history table).
- [ ] Statistics shows the moved widgets.
- [ ] Projects shows the project cards; grid/list toggle flips layout and persists across restart.
- [ ] Tap a card → Project detail loads with avatar + name + path in header and empty Running Instances section.
- [ ] Back button on Project detail returns to Projects.
- [ ] Settings accessible via sidemenu; existing settings subviews still work via back buttons.

- [ ] **Step 3: Update `CLAUDE.md`**

Append a short section near the existing "## Architecture" block:

```markdown
## Navigation (updated)

The dashboard uses a sidemenu-driven navigation with four top-level views:

- **Home** (`view-dashboard`) — the two big session + weekly cards.
- **Statistics** (`view-statistics`) — pace charts, history chart, extra-usage.
- **Projects** (`view-projects`) — project cards (grid or list toggle), derived from token history layered with `settings.projects`. Click a card → `view-project-detail`.
- **Settings** (`view-settings`) — plus `-visuals` / `-themes` / `-notifications` subviews.

The sidemenu is a fixed overlay (`#sidemenu`) slid in via CSS transform; every top-level view has a burger button (`data-burger="true"`) that opens it. Backdrop click closes.
```

- [ ] **Step 4: Commit docs update**

```bash
git add CLAUDE.md
git commit -m "DOCS: note new sidemenu navigation + renamed views"
```

- [ ] **Step 5: Summary of Plan A done**

At this point, Plan A ships a complete UI shell:
- Sidemenu navigation.
- Home / Statistics / Projects / Settings.
- Projects grid/list toggle with cards.
- Project detail shell with empty Running Instances section.
- Rust types + IPC commands ready for Plan B to populate.

Plan B (instance detection + tracking) picks up from here.
