# Mute Notifications — Design

Date: 2026-04-20
Branch: `tauri-rewrite`

## Goal

Give the user quick controls to silence the app's notifications. One master
"mute all" switch reachable from the tray right-click menu for fast access,
plus per-channel toggles in the dashboard Notifications subpage for finer
control (mute sounds, mute system notifications).

System notifications (OS toasts) are not implemented yet — the toggle is
wired and persisted but marked disabled in the UI and left as a TODO in
Rust, ready for when the toast channel lands.

## Data model

Three new boolean fields on `Settings`, stored in the `extra` catch-all so
the dashboard (camelCase convention) owns the source of truth:

| Key | Default | Effect |
|---|---|---|
| `muteAll` | `false` | Suppresses every notification channel |
| `muteSounds` | `false` | Suppresses audio (WAV) + voice (Piper/web-speech) |
| `muteSystemNotifications` | `false` | Reserved. No effect today — TODO until OS toasts exist |

No schema change to `Settings` struct required; `extra` already flattens
unknown keys on save/load. Rust reads these via helpers on `&Settings`.

## Rust changes

### `src/types.rs`
Add three small accessors on `Settings` that pull the bools out of `extra`
with sensible defaults:

```rust
impl Settings {
    pub fn mute_all(&self) -> bool { self.extra.get("muteAll").and_then(|v| v.as_bool()).unwrap_or(false) }
    pub fn mute_sounds(&self) -> bool { /* ... */ }
    pub fn mute_system_notifications(&self) -> bool { /* ... */ }
}
```

Helpers keep call sites tidy and mean the camelCase-key strings live in
exactly one place.

### `src/notifications.rs::fire()`
Guard early on the new flags:

1. Before reading the per-rule config, check `mute_all()` — return.
2. After resolving `rule.mode`, if `mute_sounds()` is true and mode is
   `Sound` or `Voice`, return.
3. Add a `// TODO: when OS toast channel lands, check settings.mute_system_notifications() here` comment near the match arms, where the toast arm will slot in.

### `src/tray.rs`
- Add a checkable menu item `"Mute Notifications"` between the Refresh and separator items. Id: `"mute-all"`.
- The menu needs rebuilding to reflect the current check state. The
  existing `settings-changed` listener already re-renders the tray icon;
  extend the setup so the menu is also rebuilt (small helper: `build_menu(app, mute_all: bool)` used both at initial setup and inside the listener).
- Menu click handler:
  1. Read current `muteAll`, flip it.
  2. Write back into `settings.extra`, call `settings::save`.
  3. Emit `settings-changed` (matches how the dashboard does it) so the
     dashboard UI stays in sync if the user has it open.

## Dashboard UI

### `dashboard.html` — Notifications subpage
Add a new `.section` block at the top of `#view-settings-notifications`
body (above `#notifCards`). Three rows using the existing `.option` +
`.switch` styling:

```
┌─ Mute ─────────────────────────────────────┐
│ Mute all notifications            [switch] │   ← when on, dims the rows below
│ Mute sounds                       [switch] │
│ Mute system notifications (soon)  [switch] │   ← permanently disabled + hint
└────────────────────────────────────────────┘
```

### `modules/settings.js`
- Read the three flags from `currentSettings` on load, set switch states.
- Write them through `saveSettings()` (top level of the settings object, so they flow into `extra`).
- When `muteAll` is on, add an `is-disabled` class to the lower two rows (CSS opacity 0.5, pointer-events: none) — the state on disk is unchanged, only the visual hint.
- The system-notifications switch is disabled (`disabled` attribute) and gets a small `"(coming soon)"` label.

## IPC

None. `save_settings` already accepts arbitrary fields via `extra`, and the tray uses Rust-side `settings::save` directly.

## Testing

`fire()` takes an `AppHandle`, so it isn't unit-testable without a Tauri
runtime — existing tests in `notifications.rs` only cover pure helpers.

To keep the mute logic testable, extract a small pure function:

```rust
pub(crate) fn should_suppress(s: &Settings, mode: NotifMode) -> bool {
    if s.mute_all() { return true; }
    matches!(mode, NotifMode::Sound | NotifMode::Voice) && s.mute_sounds()
}
```

`fire()` calls `should_suppress` and returns early when it's true. Cargo
tests cover:

1. `should_suppress_returns_true_when_mute_all` — both modes.
2. `should_suppress_mutes_sounds_when_mute_sounds` — Sound and Voice modes.
3. `should_suppress_allows_all_when_flags_false` — default settings.
4. Accessor helpers: `mute_all_defaults_false_when_key_missing` and variants.

Tray menu behaviour is UI-level; manual verification only.

## Out of scope

- Implementing the OS toast channel itself. Spec leaves TODO markers; a follow-up spec covers the toast plugin wiring, per-rule `toast` mode, and the actual `muteSystemNotifications` enforcement.
- Keyboard shortcut / global hotkey for mute toggle.
- Mute timer ("mute for 1 hour").
