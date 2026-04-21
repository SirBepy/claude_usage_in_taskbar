# Mute Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three notification mute switches (global, sounds, system-notifications) persisted in settings, with the global switch also reachable as a checkable item in the tray right-click menu.

**Architecture:** Store three booleans in `Settings.extra` (camelCase, owned by dashboard). Add pure helper `should_suppress(&Settings, NotifMode) -> bool` used by `notifications::fire`. Tray menu gains a checkable `Mute Notifications` item that toggles `muteAll` via the same `save_settings` IPC path so the dashboard stays in sync. System-notifications flag is persisted and UI-exposed but left dormant until OS toasts land (TODO marker in Rust, disabled switch + "coming soon" label in UI).

**Tech Stack:** Rust (Tauri 2.x, `tauri::menu::CheckMenuItemBuilder`), vanilla JS (dashboard single-file SPA), no new dependencies.

**Spec:** [docs/superpowers/specs/2026-04-20-mute-notifications-design.md](../specs/2026-04-20-mute-notifications-design.md)

---

## File Map

- **Create:** none.
- **Modify:**
  - `tauri/src/types.rs` — add three accessors on `Settings`, unit tests.
  - `tauri/src/notifications.rs` — add `should_suppress` helper + unit tests; call it from `fire`; add TODO for toast channel.
  - `tauri/src/tray.rs` — add checkable `Mute Notifications` item, handle click, keep it in sync on `settings-changed`.
  - `tauri/dist/dashboard.html` — add Mute section at top of Notifications subpage.
  - `tauri/dist/modules/settings.js` — load/save the three flags, dim child rows when `muteAll` is on.
  - `tauri/dist/dashboard.css` — styling for the `.is-muted-disabled` visual state.

---

### Task 1: `Settings` accessors for the three mute flags

**Files:**
- Modify: `tauri/src/types.rs`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `#[cfg(test)] mod tests { ... }` block in `tauri/src/types.rs`:

```rust
#[test]
fn mute_flags_default_false_when_keys_missing() {
    let s = Settings::default();
    assert!(!s.mute_all());
    assert!(!s.mute_sounds());
    assert!(!s.mute_system_notifications());
}

#[test]
fn mute_flags_read_from_extra_camel_case() {
    let raw = r#"{
        "muteAll": true,
        "muteSounds": false,
        "muteSystemNotifications": true
    }"#;
    let s: Settings = serde_json::from_str(raw).unwrap();
    assert!(s.mute_all());
    assert!(!s.mute_sounds());
    assert!(s.mute_system_notifications());
}

#[test]
fn mute_flags_treat_wrong_type_as_false() {
    let raw = r#"{ "muteAll": "yes", "muteSounds": 1 }"#;
    let s: Settings = serde_json::from_str(raw).unwrap();
    assert!(!s.mute_all());
    assert!(!s.mute_sounds());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from repo root):
```
(cd tauri && cargo test --lib types::tests::mute_flags)
```
Expected: compile error, `no method named mute_all found for struct Settings`.

- [ ] **Step 3: Add accessor methods**

After the existing `impl Default for Settings { ... }` block in `tauri/src/types.rs`, add:

```rust
impl Settings {
    pub fn mute_all(&self) -> bool { self.bool_extra("muteAll") }
    pub fn mute_sounds(&self) -> bool { self.bool_extra("muteSounds") }
    pub fn mute_system_notifications(&self) -> bool { self.bool_extra("muteSystemNotifications") }

    fn bool_extra(&self, key: &str) -> bool {
        self.extra.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```
(cd tauri && cargo test --lib types::tests::mute_flags)
```
Expected: 3 tests pass.

- [ ] **Step 5: Full test suite sanity check**

Run:
```
(cd tauri && cargo test --lib)
```
Expected: all existing tests still pass (was 21, should now be 24).

- [ ] **Step 6: Commit**

```
git add tauri/src/types.rs
git commit -m "FEAT: add Settings accessors for mute flags"
```

---

### Task 2: `should_suppress` helper in `notifications.rs`

**Files:**
- Modify: `tauri/src/notifications.rs`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `#[cfg(test)] mod tests { ... }` block in `tauri/src/notifications.rs`:

```rust
use crate::icon_settings::NotifMode;
use crate::types::Settings;

fn settings_with(key: &str, val: bool) -> Settings {
    let mut s = Settings::default();
    s.extra.insert(key.into(), serde_json::Value::Bool(val));
    s
}

#[test]
fn should_suppress_returns_false_when_all_flags_off() {
    let s = Settings::default();
    assert!(!super::should_suppress(&s, NotifMode::Sound));
    assert!(!super::should_suppress(&s, NotifMode::Voice));
}

#[test]
fn should_suppress_returns_true_when_mute_all_regardless_of_mode() {
    let s = settings_with("muteAll", true);
    assert!(super::should_suppress(&s, NotifMode::Sound));
    assert!(super::should_suppress(&s, NotifMode::Voice));
}

#[test]
fn should_suppress_mutes_sound_and_voice_when_mute_sounds() {
    let s = settings_with("muteSounds", true);
    assert!(super::should_suppress(&s, NotifMode::Sound));
    assert!(super::should_suppress(&s, NotifMode::Voice));
}
```

- [ ] **Step 2: Run tests to verify they fail**

```
(cd tauri && cargo test --lib notifications::tests::should_suppress)
```
Expected: compile error, `cannot find function should_suppress`.

- [ ] **Step 3: Implement `should_suppress`**

Add near the top of `tauri/src/notifications.rs`, above `pub fn fire`:

```rust
use crate::icon_settings::NotifMode;
use crate::types::Settings;

/// Pure helper: decide whether a notification of `mode` must be dropped
/// given the current settings. Keeps `fire()` thin and testable without
/// a live Tauri app.
pub(crate) fn should_suppress(settings: &Settings, mode: NotifMode) -> bool {
    if settings.mute_all() { return true; }
    matches!(mode, NotifMode::Sound | NotifMode::Voice) && settings.mute_sounds()
}
```

If `NotifMode` / `Settings` are already imported at module level, drop the duplicate `use` lines from the helper block. Check the top of the file first and deduplicate.

- [ ] **Step 4: Run tests to verify they pass**

```
(cd tauri && cargo test --lib notifications::tests::should_suppress)
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```
git add tauri/src/notifications.rs
git commit -m "FEAT: add should_suppress helper for notification mutes"
```

---

### Task 3: Wire `should_suppress` into `fire()`

**Files:**
- Modify: `tauri/src/notifications.rs:17-34`

- [ ] **Step 1: Update `fire` to call `should_suppress`**

Replace the body of `pub fn fire(app: &AppHandle, kind: NotifKind, ctx: NotifContext)` so it reads:

```rust
pub fn fire(app: &AppHandle, kind: NotifKind, ctx: NotifContext) {
    let state = app.state::<AppState>();
    let settings_snapshot = state.settings.lock().unwrap().clone();

    let cfg: NotificationsConfig = (&settings_snapshot).try_into().unwrap_or_default();
    let rule = match kind {
        NotifKind::WorkFinished => cfg.work_finished,
        NotifKind::QuestionAsked => cfg.question_asked,
        NotifKind::ThresholdCrossed => cfg.threshold_crossed,
    };
    if !rule.enabled { return; }

    if should_suppress(&settings_snapshot, rule.mode) { return; }

    // TODO: when OS toast channel lands, add a `NotifMode::Toast` arm here
    //       and gate it on `settings_snapshot.mute_system_notifications()`.
    match rule.mode {
        NotifMode::Sound => audio::play_sound_file(app, &rule.sound_file),
        NotifMode::Voice => {
            let text = render_template(&rule.template, &ctx);
            if text.is_empty() { return; }
            speak(app, &text, rule.voice_name.as_deref());
        }
    }
}
```

Notes:
- We clone the `Settings` snapshot so we can read flags without holding the mutex across the rest of the call.
- `NotificationsConfig::try_from(&Settings)` still runs on the snapshot, preserving existing behaviour.

- [ ] **Step 2: Run full Rust test suite**

```
(cd tauri && cargo test --lib)
```
Expected: all tests pass.

- [ ] **Step 3: Commit**

```
git add tauri/src/notifications.rs
git commit -m "FEAT: short-circuit fire() when mute flags are set"
```

---

### Task 4: Tray menu — add checkable `Mute Notifications` item

**Files:**
- Modify: `tauri/src/tray.rs`

- [ ] **Step 1: Extract menu builder into a helper**

Replace the `let menu = MenuBuilder::new(app) ... .build()?;` block in `pub fn setup(app: &AppHandle) -> Result<()>` (around line 20) with a call to a new helper. Add this helper at the bottom of the file:

```rust
use tauri::menu::{CheckMenuItemBuilder, Menu};

fn build_menu(app: &AppHandle, mute_all: bool) -> Result<Menu<tauri::Wry>> {
    let mute = CheckMenuItemBuilder::with_id("mute-all", "Mute Notifications")
        .checked(mute_all)
        .build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "Open Dashboard").build(app)?)
        .item(&MenuItemBuilder::with_id("refresh", "Refresh Now").build(app)?)
        .separator()
        .item(&mute)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;
    Ok(menu)
}
```

In `setup`, replace the old menu block with:

```rust
let initial_mute = app.state::<AppState>().settings.lock().unwrap().mute_all();
let menu = build_menu(app, initial_mute)?;
```

- [ ] **Step 2: Add the `mute-all` branch to the existing `on_menu_event` handler**

In `setup`, inside the `.on_menu_event(|app, event| { match event.id.as_ref() { ... } })` block, add a new arm before `_ => {}`:

```rust
"mute-all" => {
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        toggle_mute_all(h);
    });
}
```

- [ ] **Step 3: Implement `toggle_mute_all`**

Add at the bottom of `tauri/src/tray.rs`:

```rust
fn toggle_mute_all(app: AppHandle) {
    use crate::paths;
    use tauri::Emitter;
    let state = app.state::<AppState>();
    let updated = {
        let mut s = state.settings.lock().unwrap();
        let current = s.mute_all();
        s.extra.insert("muteAll".into(), serde_json::Value::Bool(!current));
        s.clone()
    };
    if let Ok(path) = paths::settings_file() {
        if let Err(e) = crate::settings::save(&path, &updated) {
            log::warn!("persist mute toggle failed: {e}");
        }
    }
    let _ = app.emit("settings-changed", &updated);
}
```

- [ ] **Step 4: Build and run dev to smoke-test**

```
(cd tauri && cargo tauri dev)
```
Expected: app launches. Right-click tray → `Mute Notifications` appears, clicking toggles the check state (on next right-click open; step 5 handles live refresh of the check glyph via the existing `settings-changed` listener).

- [ ] **Step 5: Commit**

```
git add tauri/src/tray.rs
git commit -m "FEAT: add Mute Notifications checkable tray menu item"
```

---

### Task 5: Tray menu — keep check state in sync on `settings-changed`

**Files:**
- Modify: `tauri/src/tray.rs` (around the existing `app.listen("settings-changed", ...)` block, roughly lines 66-75)

- [ ] **Step 1: Rebuild the menu when settings change**

Replace the `app.listen("settings-changed", move |_| { ... })` block with:

```rust
{
    let h = app.clone();
    app.listen("settings-changed", move |_| {
        {
            let st = h.state::<AppState>();
            st.display.lock().unwrap().invalidate_cycle();
        }
        let mute = h.state::<AppState>().settings.lock().unwrap().mute_all();
        if let Ok(new_menu) = build_menu(&h, mute) {
            if let Some(tray) = h.tray_by_id(TRAY_ID) {
                let _ = tray.set_menu(Some(new_menu));
            }
        }
        render_tray_now(&h);
    });
}
```

- [ ] **Step 2: Build + smoke-test**

```
(cd tauri && cargo tauri dev)
```
Expected behaviour:
- Right-click tray, toggle `Mute Notifications` → reopen right-click menu → check mark reflects new state.
- Open Dashboard → Notifications page → flip Mute All switch (after Task 7) → reopen tray menu → check mark matches.

- [ ] **Step 3: Commit**

```
git add tauri/src/tray.rs
git commit -m "FEAT: refresh tray menu check state on settings-changed"
```

---

### Task 6: Dashboard HTML — Mute section at top of Notifications subpage

**Files:**
- Modify: `tauri/dist/dashboard.html` (inside `#view-settings-notifications` `.view-body`, immediately above the `<template id="notifCardTemplate">` element, around line 334)

- [ ] **Step 1: Insert the Mute section**

Directly before the `<template id="notifCardTemplate">` line, add:

```html
<div class="section" id="muteSection">
    <div class="section-title">Mute</div>
    <div class="option">
        <span class="option-label">Mute all notifications</span>
        <label class="switch">
            <input type="checkbox" id="muteAllSwitch">
            <span class="slider"></span>
        </label>
    </div>
    <div class="option mute-child">
        <span class="option-label">Mute sounds</span>
        <label class="switch">
            <input type="checkbox" id="muteSoundsSwitch">
            <span class="slider"></span>
        </label>
    </div>
    <div class="option mute-child is-disabled" title="Coming soon — OS toasts aren't implemented yet">
        <span class="option-label">Mute system notifications <span style="color:var(--text-dim);font-size:0.75rem">(coming soon)</span></span>
        <label class="switch">
            <input type="checkbox" id="muteSystemSwitch" disabled>
            <span class="slider"></span>
        </label>
    </div>
</div>
```

- [ ] **Step 2: Manual visual sanity check**

With `cargo tauri dev` running, open Dashboard → Notifications. Expected: three new rows visible above the existing per-rule cards. Switches don't yet persist; that's Task 7.

- [ ] **Step 3: Commit**

```
git add tauri/dist/dashboard.html
git commit -m "FEAT: add Mute section to Notifications subpage"
```

---

### Task 7: Dashboard JS — load/save mute flags + dim disabled state

**Files:**
- Modify: `tauri/dist/modules/settings.js`

- [ ] **Step 1: Grab the new DOM nodes**

Near the top of `tauri/dist/modules/settings.js` where other DOM element references are grabbed (look for existing `const colorMode = document.getElementById(...)` block), add:

```javascript
const muteAllSwitch = document.getElementById("muteAllSwitch");
const muteSoundsSwitch = document.getElementById("muteSoundsSwitch");
const muteSystemSwitch = document.getElementById("muteSystemSwitch");
const muteSection = document.getElementById("muteSection");
```

If the file uses `querySelector`/destructuring for DOM refs instead, follow that pattern — the names above must match what later steps use.

- [ ] **Step 2: Load values into switches on settings load**

Find the function that applies settings to UI (look for the block near line 489 that reads `const notifs = settings.notifications || {};`). Immediately before that line, add:

```javascript
muteAllSwitch.checked = !!settings.muteAll;
muteSoundsSwitch.checked = !!settings.muteSounds;
muteSystemSwitch.checked = !!settings.muteSystemNotifications;
applyMuteAllVisual();
```

- [ ] **Step 3: Persist on change**

Below the DOM ref block from Step 1, add:

```javascript
function applyMuteAllVisual() {
    const dimmed = muteAllSwitch.checked;
    muteSection.classList.toggle("mute-all-on", dimmed);
}

muteAllSwitch.addEventListener("change", () => { applyMuteAllVisual(); saveSettings(); });
muteSoundsSwitch.addEventListener("change", saveSettings);
// system switch stays disabled; no listener.
```

- [ ] **Step 4: Include the three flags in the saveSettings payload**

In `saveSettings` (the function building the `settings` object that gets passed to `window.electronAPI?.saveSettings`, around line 316 where `notifications: gatherNotifSettings(),` lives), add three sibling keys:

```javascript
muteAll: muteAllSwitch.checked,
muteSounds: muteSoundsSwitch.checked,
muteSystemNotifications: muteSystemSwitch.checked,
```

- [ ] **Step 5: Add CSS for the dimmed + disabled states**

Append to `tauri/dist/dashboard.css`:

```css
.option.is-disabled {
    opacity: 0.5;
    pointer-events: none;
}

.mute-all-on .option.mute-child {
    opacity: 0.5;
    pointer-events: none;
}
```

- [ ] **Step 6: Smoke test end to end**

With `cargo tauri dev` running:

1. Dashboard → Notifications → flip `Mute all notifications`. The lower two rows dim; the system-notifications row stays permanently disabled.
2. Right-click tray → `Mute Notifications` is checked.
3. Uncheck it from the tray → reopen dashboard → the switch is now off.
4. Flip `Mute sounds` only, then trigger a notification (e.g. click `Refresh Now` and let a threshold-crossed fire, or temporarily lower thresholds). Expected: no audio, no voice.
5. With everything un-muted, same trigger plays sound/voice as before.

- [ ] **Step 7: Commit**

```
git add tauri/dist/modules/settings.js tauri/dist/dashboard.css
git commit -m "FEAT: wire Mute switches in Notifications subpage"
```

---

### Task 8: Final verification + PR prep

**Files:** none modified.

- [ ] **Step 1: Run full Rust test suite**

```
(cd tauri && cargo test --lib)
```
Expected: all tests pass (24 prior + 6 new = 30).

- [ ] **Step 2: Cargo check on release profile**

```
(cd tauri && cargo check --release)
```
Expected: clean, no warnings beyond pre-existing ones.

- [ ] **Step 3: Manual regression check**

With `cargo tauri dev`:
- Existing notification flows still fire when nothing is muted.
- Tray dual-ring icon still renders.
- Dashboard loads and saves other settings without regressing (change a theme or threshold, reload, value persists).

- [ ] **Step 4: Confirm no stray edits**

```
git status
```
Expected: clean working tree, all changes committed under the five commits above.

---

## Self-Review Notes

- Spec coverage: `muteAll` (Tasks 1, 3, 4, 5, 6, 7), `muteSounds` (Tasks 1, 2, 3, 6, 7), `muteSystemNotifications` (Tasks 1, 6, 7 — persisted + UI-disabled; Rust TODO marker in Task 3). Tray right-click access: Tasks 4, 5. Dashboard UI: Tasks 6, 7. Tests: Tasks 1, 2.
- No OS toast plugin work in scope; TODO markers are load-bearing for the follow-up spec.
- No placeholders; all code blocks contain the full snippet needed.
