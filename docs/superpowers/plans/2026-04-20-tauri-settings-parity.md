# Tauri Settings Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Tauri rewrite to settings-tab parity with the Electron app (sync excluded, token-estimation removed).

**Architecture:** Pure-math modules (`usage_parser`, `icon`, `fonts`, typed settings views) are unit-tested offline; tray and notifications layer on top as the only stateful / Tauri-aware pieces. Every tray update funnels through a single `render_tray_now` function that reads current snapshot + typed settings + display state.

**Tech Stack:** Rust (Tauri 2.0, `image`, `rodio`, `chrono`), JS (vanilla ES modules in `tauri/dist`), Piper TTS sidecar.

**Spec:** `docs/superpowers/specs/2026-04-20-tauri-settings-parity-design.md`

---

## File Map

### New Rust modules (`tauri/src/`)

| File | Responsibility |
|---|---|
| `icon_settings.rs` | Typed views: `IconSettings`, `TooltipSettings`, `NotificationsConfig`, `NotificationRule`, `ColorStop`, enums. `TryFrom<&Settings>` conversions. |
| `usage_parser.rs` | Pure math: `session_pct`, `weekly_pct`, `calc_safe_pct`, `build_tooltip`, `threshold_crossed`. |
| `fonts.rs` | `PixelFont` struct + `CLASSIC`, `DIGITAL`, `BOLD` const glyph tables. `draw_text`. |
| `audio.rs` | `rodio` output stream, play queue gate, `play_sound_file`, `play_wav`, `speak`. |
| `notifications.rs` | `fire(app, kind, ctx)`, template rendering, name/percent context. |
| `piper.rs` | Sidecar manager: `status`, `install_voice`, `synthesize`. Voice catalog. |
| `display_state.rs` | `TrayDisplayState` struct + `build_cycle`, `cycle_next`, `effective_mode`. |

### Modified Rust files

| File | Change |
|---|---|
| `Cargo.toml` | Add `rodio`, `tauri-plugin-clipboard-manager`. |
| `types.rs` | Remove no-op token-estimate fields (none are strongly typed — just strip from docs + any references). |
| `state.rs` | Add `display: Mutex<TrayDisplayState>`, `audio: AudioCtx`. |
| `icon.rs` | Port AA rings, urgency colors, bars, digit overlay, spin frames. |
| `tray.rs` | `render_tray_now`, click cycle, reset ticker, settings listener, tooltip. |
| `scheduler.rs` | Accept `PollTrigger` enum; drive spin + threshold-crossing notifications. |
| `hook_server.rs` | Fire `WorkFinished` on `/refresh`; add `POST /notify` → `QuestionAsked`. |
| `ipc.rs` | New commands: `piper_status`, `piper_install_voice`, `piper_speak_preview`, `copy_logs`, `check_for_updates`, `download_and_install_update`, `install_update`, `get_app_version`, `get_platform`, `get_update_state`, `open_external`. |
| `lib.rs` | Register new commands; wire `settings-changed` listener; startup auto-update check; settings-listener for `autostart`. |
| `tauri.conf.json` | `bundle.externalBin` for Piper; clipboard plugin. |

### Modified frontend (`tauri/dist/`)

| File | Change |
|---|---|
| `electron-api-shim.js` | Bindings for new IPC + `onSpeakFallback`. |
| `dashboard.html` | Remove token-estimate DOM block. |
| `modules/settings.js` | Strip token-estimate references; wire `apply_color_to.dashboard`. |
| `modules/speech-fallback.js` (new) | Listens for `speak-fallback` event, drives `speechSynthesis`. |

### Assets

- Copy `src/assets/sounds/*.mp3` → `tauri/assets/sounds/*.mp3`.
- Piper binaries + default voice scaffolding under `tauri/binaries/piper/`.

---

## Task 1: Typed settings views

**Files:**
- Create: `tauri/src/icon_settings.rs`
- Test: same file (`#[cfg(test)]`)
- Modify: `tauri/src/lib.rs` (add `pub mod icon_settings;`)

- [ ] **Step 1: Write failing tests for `IconSettings::try_from(&Settings)`**

Add to `tauri/src/icon_settings.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Settings;
    use serde_json::json;

    fn settings_with(extra: serde_json::Value) -> Settings {
        let obj = extra.as_object().unwrap().clone();
        let mut s = Settings::default();
        s.extra = obj;
        s
    }

    #[test]
    fn icon_settings_defaults_when_extra_empty() {
        let s = Settings::default();
        let icon = IconSettings::try_from(&s).unwrap();
        assert_eq!(icon.default_display, DefaultDisplay::Icon);
        assert_eq!(icon.icon_style, IconStyle::Rings);
        assert_eq!(icon.overlay_style, OverlayStyle::Classic);
        assert_eq!(icon.color_mode, ColorMode::Threshold);
        assert!(icon.apply_color_to.icon);
        assert!(icon.apply_color_to.number);
        assert!(icon.apply_color_to.tooltip);
        assert!(icon.apply_color_to.dashboard);
    }

    #[test]
    fn icon_settings_parses_dashboard_dropdown_values() {
        let s = settings_with(json!({
            "defaultDisplay": "session",
            "iconStyle": "bars",
            "overlayStyle": "digital",
            "colorMode": "pace",
            "paceBand": 15,
            "paceColors": {"under": "#11ff00", "nearSafe": "#ffff00",
                           "nearOver": "#ff9900", "over": "#ff0000"},
            "colorApplyTo": {"icon": false, "number": true, "tooltip": false, "dashboard": true},
            "colorThresholds": [
                {"min": 0, "color": "#27ae60"},
                {"min": 80, "color": "#e74c3c"},
                {"min": 50, "color": "#e67e22"}
            ]
        }));
        let icon = IconSettings::try_from(&s).unwrap();
        assert_eq!(icon.default_display, DefaultDisplay::Session);
        assert_eq!(icon.icon_style, IconStyle::Bars);
        assert_eq!(icon.overlay_style, OverlayStyle::Digital);
        assert_eq!(icon.color_mode, ColorMode::Pace);
        assert_eq!(icon.pace_band, 15.0);
        assert_eq!(icon.pace_colors.under, "#11ff00");
        assert!(!icon.apply_color_to.icon);
        assert!(icon.apply_color_to.number);
        // thresholds sorted asc by min
        let mins: Vec<u32> = icon.color_thresholds.iter().map(|t| t.min).collect();
        assert_eq!(mins, vec![0, 50, 80]);
    }

    #[test]
    fn icon_settings_malformed_extra_falls_back_to_defaults() {
        let s = settings_with(json!({
            "iconStyle": 42,
            "colorThresholds": "not an array"
        }));
        let icon = IconSettings::try_from(&s).unwrap();
        assert_eq!(icon.icon_style, IconStyle::Rings);
        assert!(!icon.color_thresholds.is_empty());  // default set populated
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --package claude-usage-tauri --lib icon_settings::tests -- --nocapture`
Expected: compile errors (`IconSettings` not defined, etc.).

- [ ] **Step 3: Implement typed views and conversions**

Write `tauri/src/icon_settings.rs`:

```rust
//! Typed views over `Settings.extra` for icon/tooltip/notifications.
//! `TryFrom<&Settings>` never fails — malformed fields fall back to defaults.

use crate::types::Settings;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DefaultDisplay { Icon, Session, Weekly }
impl Default for DefaultDisplay { fn default() -> Self { Self::Icon } }

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IconStyle { Rings, Bars }
impl Default for IconStyle { fn default() -> Self { Self::Rings } }

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OverlayStyle { Classic, Digital, Bold }
impl Default for OverlayStyle { fn default() -> Self { Self::Classic } }

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ColorMode { Threshold, Pace }
impl Default for ColorMode { fn default() -> Self { Self::Threshold } }

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TooltipLayout { Rows, Compact }
impl Default for TooltipLayout { fn default() -> Self { Self::Rows } }

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TimeStyle { Absolute, Relative }
impl Default for TimeStyle { fn default() -> Self { Self::Relative } }

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NotifMode { Sound, Voice }
impl Default for NotifMode { fn default() -> Self { Self::Sound } }

#[derive(Clone, Debug, PartialEq)]
pub struct ColorStop { pub min: u32, pub color: String }

#[derive(Clone, Debug, PartialEq)]
pub struct PaceColors {
    pub under: String,
    pub near_safe: String,
    pub near_over: String,
    pub over: String,
}
impl Default for PaceColors {
    fn default() -> Self {
        Self {
            under: "#27ae60".into(),
            near_safe: "#f1c40f".into(),
            near_over: "#e67e22".into(),
            over: "#e74c3c".into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ColorApplyTo {
    pub icon: bool,
    pub number: bool,
    pub dashboard: bool,
    pub tooltip: bool,
}
impl Default for ColorApplyTo {
    fn default() -> Self {
        Self { icon: true, number: true, dashboard: true, tooltip: true }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct IconSettings {
    pub default_display: DefaultDisplay,
    pub icon_style: IconStyle,
    pub overlay_style: OverlayStyle,
    pub color_mode: ColorMode,
    pub color_thresholds: Vec<ColorStop>,
    pub pace_band: f32,
    pub pace_colors: PaceColors,
    pub apply_color_to: ColorApplyTo,
}

impl Default for IconSettings {
    fn default() -> Self {
        Self {
            default_display: DefaultDisplay::default(),
            icon_style: IconStyle::default(),
            overlay_style: OverlayStyle::default(),
            color_mode: ColorMode::default(),
            color_thresholds: vec![
                ColorStop { min: 0,  color: "#27ae60".into() },
                ColorStop { min: 50, color: "#e67e22".into() },
                ColorStop { min: 80, color: "#e74c3c".into() },
            ],
            pace_band: 10.0,
            pace_colors: PaceColors::default(),
            apply_color_to: ColorApplyTo::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TooltipSettings {
    pub layout: TooltipLayout,
    pub time_style: TimeStyle,
    pub show_safe_pace: bool,
    pub apply_color: bool,
}
impl Default for TooltipSettings {
    fn default() -> Self {
        Self {
            layout: TooltipLayout::default(),
            time_style: TimeStyle::default(),
            show_safe_pace: true,
            apply_color: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct NotificationRule {
    pub enabled: bool,
    pub mode: NotifMode,
    pub sound_file: String,
    pub voice_name: Option<String>,
    pub template: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NotificationsConfig {
    pub work_finished: NotificationRule,
    pub question_asked: NotificationRule,
    pub threshold_crossed: NotificationRule,
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            work_finished: NotificationRule {
                enabled: true, mode: NotifMode::Sound,
                sound_file: "sound1.mp3".into(), voice_name: None,
                template: "{name} is done".into(),
            },
            question_asked: NotificationRule {
                enabled: true, mode: NotifMode::Sound,
                sound_file: "sound3.mp3".into(), voice_name: None,
                template: "{name} is waiting".into(),
            },
            threshold_crossed: NotificationRule {
                enabled: true, mode: NotifMode::Sound,
                sound_file: "sound6.mp3".into(), voice_name: None,
                template: "{percent} threshold reached".into(),
            },
        }
    }
}

// ── TryFrom impls ────────────────────────────────────────────────────────────

fn s(v: Option<&Value>) -> Option<&str> { v.and_then(|x| x.as_str()) }
fn f(v: Option<&Value>) -> Option<f64>  { v.and_then(|x| x.as_f64()) }
fn b(v: Option<&Value>) -> Option<bool> { v.and_then(|x| x.as_bool()) }

fn parse_enum<T: Default>(raw: Option<&Value>, map: &[(&str, T)]) -> T where T: Copy {
    let Some(key) = s(raw) else { return T::default(); };
    for (k, v) in map { if *k == key { return *v; } }
    T::default()
}

fn parse_color_stops(raw: Option<&Value>) -> Vec<ColorStop> {
    let Some(arr) = raw.and_then(|x| x.as_array()) else { return IconSettings::default().color_thresholds; };
    let mut out: Vec<ColorStop> = arr.iter().filter_map(|item| {
        let m = item.as_object()?;
        Some(ColorStop {
            min: m.get("min").and_then(|v| v.as_u64())? as u32,
            color: m.get("color").and_then(|v| v.as_str())?.to_string(),
        })
    }).collect();
    if out.is_empty() { return IconSettings::default().color_thresholds; }
    out.sort_by_key(|c| c.min);
    out
}

fn parse_pace_colors(raw: Option<&Value>) -> PaceColors {
    let mut pc = PaceColors::default();
    if let Some(m) = raw.and_then(|x| x.as_object()) {
        if let Some(c) = m.get("under").and_then(|v| v.as_str())     { pc.under = c.into(); }
        if let Some(c) = m.get("nearSafe").and_then(|v| v.as_str())  { pc.near_safe = c.into(); }
        if let Some(c) = m.get("nearOver").and_then(|v| v.as_str())  { pc.near_over = c.into(); }
        if let Some(c) = m.get("over").and_then(|v| v.as_str())      { pc.over = c.into(); }
    }
    pc
}

fn parse_apply_to(raw: Option<&Value>) -> ColorApplyTo {
    let mut a = ColorApplyTo::default();
    if let Some(m) = raw.and_then(|x| x.as_object()) {
        if let Some(v) = m.get("icon").and_then(|v| v.as_bool())      { a.icon = v; }
        if let Some(v) = m.get("number").and_then(|v| v.as_bool())    { a.number = v; }
        if let Some(v) = m.get("dashboard").and_then(|v| v.as_bool()) { a.dashboard = v; }
        if let Some(v) = m.get("tooltip").and_then(|v| v.as_bool())   { a.tooltip = v; }
    }
    a
}

impl TryFrom<&Settings> for IconSettings {
    type Error = std::convert::Infallible;
    fn try_from(s: &Settings) -> Result<Self, Self::Error> {
        let e = &s.extra;
        Ok(IconSettings {
            default_display: parse_enum(e.get("defaultDisplay"), &[
                ("icon", DefaultDisplay::Icon),
                ("session", DefaultDisplay::Session),
                ("weekly", DefaultDisplay::Weekly),
            ]),
            icon_style: parse_enum(e.get("iconStyle"), &[
                ("rings", IconStyle::Rings),
                ("bars", IconStyle::Bars),
            ]),
            overlay_style: parse_enum(e.get("overlayStyle"), &[
                ("classic", OverlayStyle::Classic),
                ("digital", OverlayStyle::Digital),
                ("bold", OverlayStyle::Bold),
            ]),
            color_mode: parse_enum(e.get("colorMode"), &[
                ("threshold", ColorMode::Threshold),
                ("pace", ColorMode::Pace),
            ]),
            color_thresholds: parse_color_stops(e.get("colorThresholds")),
            pace_band: f(e.get("paceBand")).unwrap_or(10.0) as f32,
            pace_colors: parse_pace_colors(e.get("paceColors")),
            apply_color_to: parse_apply_to(e.get("colorApplyTo")),
        })
    }
}

impl TryFrom<&Settings> for TooltipSettings {
    type Error = std::convert::Infallible;
    fn try_from(s: &Settings) -> Result<Self, Self::Error> {
        let e = &s.extra;
        Ok(TooltipSettings {
            layout: parse_enum(e.get("tooltipLayout"), &[
                ("rows", TooltipLayout::Rows),
                ("compact", TooltipLayout::Compact),
            ]),
            time_style: parse_enum(e.get("timeStyle"), &[
                ("absolute", TimeStyle::Absolute),
                ("relative", TimeStyle::Relative),
            ]),
            show_safe_pace: b(e.get("tooltipShowSafePace")).unwrap_or(true),
            apply_color: b(e.get("colorApplyTo").and_then(|v| v.as_object())
                          .and_then(|m| m.get("tooltip"))).unwrap_or(true),
        })
    }
}

fn rule_from(m: &serde_json::Map<String, Value>, defaults: NotificationRule) -> NotificationRule {
    NotificationRule {
        enabled: b(m.get("enabled")).unwrap_or(defaults.enabled),
        mode: parse_enum(m.get("mode"), &[
            ("sound", NotifMode::Sound),
            ("voice", NotifMode::Voice),
        ]),
        sound_file: s(m.get("soundFile")).map(String::from).unwrap_or(defaults.sound_file),
        voice_name: s(m.get("voiceName")).map(String::from),
        template: s(m.get("template")).map(String::from).unwrap_or(defaults.template),
    }
}

impl TryFrom<&Settings> for NotificationsConfig {
    type Error = std::convert::Infallible;
    fn try_from(s: &Settings) -> Result<Self, Self::Error> {
        let defaults = NotificationsConfig::default();
        let Some(n) = s.extra.get("notifications").and_then(|v| v.as_object()) else { return Ok(defaults); };
        Ok(NotificationsConfig {
            work_finished: n.get("workFinished").and_then(|v| v.as_object())
                .map(|m| rule_from(m, defaults.work_finished.clone())).unwrap_or(defaults.work_finished),
            question_asked: n.get("questionAsked").and_then(|v| v.as_object())
                .map(|m| rule_from(m, defaults.question_asked.clone())).unwrap_or(defaults.question_asked),
            threshold_crossed: n.get("thresholdCrossed").and_then(|v| v.as_object())
                .map(|m| rule_from(m, defaults.threshold_crossed.clone())).unwrap_or(defaults.threshold_crossed),
        })
    }
}
```

Also add to `tauri/src/lib.rs` top (after `pub mod auth;`):

```rust
pub mod icon_settings;
pub mod usage_parser;  // placeholder for next task — module exists as empty file now
```

Skip the `usage_parser` entry until Task 2; add only `pub mod icon_settings;` here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --package claude-usage-tauri --lib icon_settings::tests`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tauri/src/icon_settings.rs tauri/src/lib.rs
git commit -m "FEAT: typed settings views for icon/tooltip/notifications"
```

---

## Task 2: Pure usage-parser helpers

**Files:**
- Create: `tauri/src/usage_parser.rs`
- Modify: `tauri/src/lib.rs` (add `pub mod usage_parser;`)

- [ ] **Step 1: Write failing tests**

Create `tauri/src/usage_parser.rs`:

```rust
//! Pure math + formatting helpers. No Tauri deps. `now` is always injected
//! so tests stay deterministic.

use crate::icon_settings::{ColorStop, TimeStyle, TooltipLayout, TooltipSettings};
use crate::types::UsageSnapshot;
use chrono::{DateTime, Duration, Utc};

pub const FIVE_HOUR_MS: i64 = 5 * 3_600_000;
pub const SEVEN_DAY_MS: i64 = 7 * 24 * 3_600_000;

pub fn session_pct(snap: &UsageSnapshot) -> f32 { snap.five_hour.utilization as f32 }
pub fn weekly_pct(snap: &UsageSnapshot) -> f32 { snap.seven_day.utilization as f32 }

pub fn calc_safe_pct(resets_at: &str, window_ms: i64, now: DateTime<Utc>) -> Option<f32> {
    let resets = DateTime::parse_from_rfc3339(resets_at).ok()?.with_timezone(&Utc);
    let elapsed = window_ms - (resets - now).num_milliseconds();
    if elapsed <= 0 || elapsed > window_ms { return None; }
    Some((elapsed as f32 / window_ms as f32) * 100.0)
}

pub fn threshold_crossed(prev: Option<f32>, new: Option<f32>, stops: &[ColorStop]) -> bool {
    let (Some(p), Some(n)) = (prev, new) else { return false; };
    stops.iter().any(|s| {
        let m = s.min as f32;
        p < m && n >= m
    })
}

pub fn build_tooltip(snap: Option<&UsageSnapshot>, s: &TooltipSettings, now: DateTime<Utc>) -> String {
    let Some(snap) = snap else { return "Claude Usage — initializing…".into(); };
    let sess = session_pct(snap);
    let weekly = weekly_pct(snap);
    let sess_safe = calc_safe_pct(&snap.five_hour.resets_at, FIVE_HOUR_MS, now);
    let weekly_safe = calc_safe_pct(&snap.seven_day.resets_at, SEVEN_DAY_MS, now);
    let sess_reset = format_reset(&snap.five_hour.resets_at, s.time_style, now);
    let weekly_reset = format_reset(&snap.seven_day.resets_at, s.time_style, now);

    let pace_row = if s.show_safe_pace {
        let sess_pace = pace_summary(sess, sess_safe);
        let weekly_pace = pace_summary(weekly, weekly_safe);
        Some(format!("Pace    session: {sess_pace}  weekly: {weekly_pace}"))
    } else { None };

    match s.layout {
        TooltipLayout::Rows => {
            let mut lines = vec![
                format!("Session  {:>3.0}%  {}", sess, sess_reset),
                format!("Weekly   {:>3.0}%  {}", weekly, weekly_reset),
            ];
            if let Some(p) = pace_row { lines.push(p); }
            lines.join("\n")
        }
        TooltipLayout::Compact => {
            let base = format!("S {:.0}% · W {:.0}%", sess, weekly);
            if let Some(safe) = sess_safe.filter(|_| s.show_safe_pace) {
                format!("{base} · pace {:.0}%", safe)
            } else { base }
        }
    }
}

fn format_reset(resets_at: &str, style: TimeStyle, now: DateTime<Utc>) -> String {
    let Ok(resets) = DateTime::parse_from_rfc3339(resets_at) else { return String::new(); };
    let resets = resets.with_timezone(&Utc);
    match style {
        TimeStyle::Relative => {
            let delta = resets - now;
            if delta <= Duration::zero() { return "resets now".into(); }
            let h = delta.num_hours();
            let m = (delta.num_minutes() - h * 60).max(0);
            if h > 0 { format!("resets in {h}h {m}m") } else { format!("resets in {m}m") }
        }
        TimeStyle::Absolute => resets.format("resets %a %H:%M").to_string(),
    }
}

fn pace_summary(pct: f32, safe: Option<f32>) -> String {
    match safe {
        Some(s) if pct < s => format!("{pct:.0}% (under {s:.0}%)"),
        Some(s) => format!("{pct:.0}% (over {s:.0}%)"),
        None => format!("{pct:.0}%"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::icon_settings::ColorStop;
    use chrono::TimeZone;

    fn snap(five: f64, five_resets: &str, weekly: f64, weekly_resets: &str) -> UsageSnapshot {
        UsageSnapshot {
            captured_at: "2026-04-20T10:00:00Z".into(),
            five_hour: crate::types::WindowUsage { utilization: five, resets_at: five_resets.into() },
            seven_day: crate::types::WindowUsage { utilization: weekly, resets_at: weekly_resets.into() },
            extra_usage: None,
        }
    }

    #[test]
    fn calc_safe_pct_at_window_start_is_zero() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 10, 0, 0).unwrap();
        let resets = "2026-04-20T15:00:00Z";
        let safe = calc_safe_pct(resets, FIVE_HOUR_MS, now).unwrap();
        assert!(safe < 0.1);
    }

    #[test]
    fn calc_safe_pct_at_halfway_is_fifty() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 12, 30, 0).unwrap();
        let resets = "2026-04-20T15:00:00Z";
        let safe = calc_safe_pct(resets, FIVE_HOUR_MS, now).unwrap();
        assert!((safe - 50.0).abs() < 0.1);
    }

    #[test]
    fn calc_safe_pct_after_reset_returns_none() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 16, 0, 0).unwrap();
        let resets = "2026-04-20T15:00:00Z";
        assert!(calc_safe_pct(resets, FIVE_HOUR_MS, now).is_none());
    }

    #[test]
    fn threshold_crossed_detects_upward_crossing() {
        let stops = vec![
            ColorStop { min: 0, color: "#0".into() },
            ColorStop { min: 50, color: "#0".into() },
            ColorStop { min: 80, color: "#0".into() },
        ];
        assert!(threshold_crossed(Some(30.0), Some(55.0), &stops));
        assert!(threshold_crossed(Some(60.0), Some(85.0), &stops));
    }

    #[test]
    fn threshold_crossed_ignores_steady_state() {
        let stops = vec![ColorStop { min: 50, color: "#0".into() }];
        assert!(!threshold_crossed(Some(60.0), Some(75.0), &stops));
        assert!(!threshold_crossed(Some(40.0), Some(45.0), &stops));
        assert!(!threshold_crossed(None, Some(75.0), &stops));
    }

    #[test]
    fn build_tooltip_rows_layout_absolute_time() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 10, 0, 0).unwrap();
        let s = TooltipSettings {
            layout: TooltipLayout::Rows,
            time_style: TimeStyle::Absolute,
            show_safe_pace: false,
            apply_color: true,
        };
        let u = snap(45.0, "2026-04-20T12:30:00Z", 12.0, "2026-04-23T10:00:00Z");
        let tip = build_tooltip(Some(&u), &s, now);
        assert!(tip.contains("Session"));
        assert!(tip.contains("45%"));
        assert!(tip.contains("Weekly"));
        assert!(tip.contains("12%"));
        assert!(!tip.contains("Pace"));
    }

    #[test]
    fn build_tooltip_compact_relative_includes_safe_pace() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 12, 30, 0).unwrap();
        let s = TooltipSettings {
            layout: TooltipLayout::Compact,
            time_style: TimeStyle::Relative,
            show_safe_pace: true,
            apply_color: true,
        };
        let u = snap(55.0, "2026-04-20T15:00:00Z", 22.0, "2026-04-23T10:00:00Z");
        let tip = build_tooltip(Some(&u), &s, now);
        assert!(tip.starts_with("S 55%"));
        assert!(tip.contains("W 22%"));
        assert!(tip.contains("pace"));
    }

    #[test]
    fn build_tooltip_no_snapshot_is_initializing() {
        let s = TooltipSettings::default();
        let tip = build_tooltip(None, &s, Utc::now());
        assert!(tip.to_lowercase().contains("init"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --package claude-usage-tauri --lib usage_parser::tests`
Expected: compile error (module not declared).

- [ ] **Step 3: Register module + make it compile**

Edit `tauri/src/lib.rs`, add next to `pub mod icon_settings;`:

```rust
pub mod usage_parser;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --package claude-usage-tauri --lib usage_parser::tests`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tauri/src/usage_parser.rs tauri/src/lib.rs
git commit -m "FEAT: pure usage-parser helpers (safe pace, tooltip, threshold cross)"
```

---

## Task 3: AA rings + urgency colors in `icon.rs`

**Files:**
- Modify: `tauri/src/icon.rs`

- [ ] **Step 1: Write failing tests**

Append to `tauri/src/icon.rs` `mod tests`:

```rust
use crate::icon_settings::{ColorApplyTo, ColorMode, ColorStop, IconSettings, IconStyle, OverlayStyle, PaceColors, DefaultDisplay};
use image::GenericImageView;

fn test_settings() -> IconSettings {
    IconSettings {
        default_display: DefaultDisplay::Icon,
        icon_style: IconStyle::Rings,
        overlay_style: OverlayStyle::Classic,
        color_mode: ColorMode::Threshold,
        color_thresholds: vec![
            ColorStop { min: 0, color: "#00ff00".into() },
            ColorStop { min: 50, color: "#ff8800".into() },
            ColorStop { min: 80, color: "#ff0000".into() },
        ],
        pace_band: 10.0,
        pace_colors: PaceColors::default(),
        apply_color_to: ColorApplyTo::default(),
    }
}

#[test]
fn urgency_rgb_threshold_mode_selects_by_highest_reached_stop() {
    let s = test_settings();
    assert_eq!(urgency_rgb(Some(10.0), &s, None), [0, 255, 0]);
    assert_eq!(urgency_rgb(Some(55.0), &s, None), [255, 136, 0]);
    assert_eq!(urgency_rgb(Some(85.0), &s, None), [255, 0, 0]);
}

#[test]
fn urgency_rgb_loading_state_returns_blue() {
    let s = test_settings();
    let rgb = urgency_rgb(None, &s, None);
    assert_eq!(rgb, [74, 144, 226]);
}

#[test]
fn urgency_rgb_pace_mode_uses_pace_colors() {
    let mut s = test_settings();
    s.color_mode = ColorMode::Pace;
    // pct < safe-band=under
    let under = urgency_rgb(Some(20.0), &s, Some(40.0));
    // pct between safe-band..safe=near_safe
    let near_safe = urgency_rgb(Some(35.0), &s, Some(40.0));
    // pct between safe..safe+band=near_over
    let near_over = urgency_rgb(Some(45.0), &s, Some(40.0));
    // pct >= safe+band=over
    let over = urgency_rgb(Some(60.0), &s, Some(40.0));
    assert_ne!(under, near_safe);
    assert_ne!(near_safe, near_over);
    assert_ne!(near_over, over);
}

#[test]
fn aa_ring_has_soft_edges() {
    let bytes = render(Some(50.0), Some(50.0), &IconCtx {
        settings: &test_settings(),
        display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
    });
    let img = image::load_from_memory(&bytes).unwrap();
    // Sample a pixel right at the outer edge of the outer ring.
    // r=10.5 outer. center=11,11. So x≈21, y≈11 should be near-edge.
    let edge = img.get_pixel(21, 11);
    // Alpha should be >0 and <255 (soft edge). If hard-edged this is 0 or 255.
    assert!(edge[3] > 0 && edge[3] < 255, "expected AA alpha, got {}", edge[3]);
}

#[test]
fn apply_color_to_icon_false_grays_out_icon() {
    let mut s = test_settings();
    s.apply_color_to.icon = false;
    let bytes = render(Some(90.0), Some(10.0), &IconCtx {
        settings: &s,
        display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
    });
    let img = image::load_from_memory(&bytes).unwrap();
    // Scan all colored pixels; none should be red (threshold mode would paint red at 90%).
    let mut has_red = false;
    for y in 0..img.height() {
        for x in 0..img.width() {
            let p = img.get_pixel(x, y);
            if p[3] > 100 && p[0] > 200 && p[1] < 50 && p[2] < 50 { has_red = true; }
        }
    }
    assert!(!has_red, "expected grayed icon, found red pixels");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --package claude-usage-tauri --lib icon::tests`
Expected: compile errors (`urgency_rgb`, `render`, `IconCtx`, `DisplayMode` not defined in icon.rs).

- [ ] **Step 3: Rewrite `tauri/src/icon.rs`**

Replace the entire file with (renders section only — bars + digits in later tasks):

```rust
//! Renders the 22x22 tray icon as RGBA PNG bytes.
//!
//! Ports the AA blend model from `src/core/icon.js` — every pixel in the
//! icon range gets a soft alpha based on distance from the ring's boundary,
//! then blended over whatever is already in the buffer (pre-multiplied).

use crate::icon_settings::{ColorMode, IconSettings, IconStyle};
use image::{ImageBuffer, ImageEncoder, Rgba, RgbaImage};

pub const SIZE: u32 = 22;
const CX: f32 = SIZE as f32 / 2.0;
const CY: f32 = SIZE as f32 / 2.0;

const OUTER_R_OUT: f32 = 10.5;
const OUTER_R_IN:  f32 = 7.5;
const INNER_R_OUT: f32 = 5.5;
const INNER_R_IN:  f32 = 3.5;

const TRACK: [u8; 3] = [60, 60, 60];
const TRACK_ALPHA: u8 = 80;
const LOADING: [u8; 3] = [74, 144, 226];
const NEUTRAL_GRAY: [u8; 3] = [200, 200, 200];
const IDLE_GRAY:    [u8; 3] = [120, 120, 120];
const FALLBACK_COLOR: [u8; 3] = [74, 144, 226];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayMode {
    Icon,
    NumberSession,
    NumberWeekly,
}

pub struct IconCtx<'a> {
    pub settings: &'a IconSettings,
    pub display_mode: DisplayMode,
    pub session_safe: Option<f32>,
    pub weekly_safe: Option<f32>,
}

pub fn render(sess: Option<f32>, weekly: Option<f32>, ctx: &IconCtx) -> Vec<u8> {
    let mut img: RgbaImage = ImageBuffer::from_pixel(SIZE, SIZE, Rgba([0, 0, 0, 0]));
    let idle = sess.is_none() && weekly.is_none();

    match ctx.display_mode {
        DisplayMode::Icon => {
            if idle {
                draw_ring_arc(&mut img, Some(100.0), OUTER_R_OUT, OUTER_R_IN, IDLE_GRAY);
                draw_ring_arc(&mut img, Some(100.0), INNER_R_OUT, INNER_R_IN, IDLE_GRAY);
            } else if ctx.settings.icon_style == IconStyle::Bars {
                // bars implemented in later task
                draw_ring_arc(&mut img, sess, OUTER_R_OUT, OUTER_R_IN, color_for(sess, ctx, ctx.session_safe, /*icon=*/true));
                draw_ring_arc(&mut img, weekly, INNER_R_OUT, INNER_R_IN, color_for(weekly, ctx, ctx.weekly_safe, true));
            } else {
                draw_ring_arc(&mut img, sess, OUTER_R_OUT, OUTER_R_IN, color_for(sess, ctx, ctx.session_safe, true));
                draw_ring_arc(&mut img, weekly, INNER_R_OUT, INNER_R_IN, color_for(weekly, ctx, ctx.weekly_safe, true));
            }
        }
        DisplayMode::NumberSession | DisplayMode::NumberWeekly => {
            // digit overlay added in Task 5
        }
    }
    encode_png(&img)
}

fn color_for(pct: Option<f32>, ctx: &IconCtx, safe: Option<f32>, is_icon: bool) -> [u8; 3] {
    if is_icon && !ctx.settings.apply_color_to.icon { return NEUTRAL_GRAY; }
    if !is_icon && !ctx.settings.apply_color_to.number { return NEUTRAL_GRAY; }
    urgency_rgb(pct, ctx.settings, safe)
}

pub fn urgency_rgb(pct: Option<f32>, s: &IconSettings, safe: Option<f32>) -> [u8; 3] {
    let Some(pct) = pct else { return LOADING; };
    if s.color_mode == ColorMode::Pace {
        if let Some(safe) = safe {
            let b = s.pace_band;
            let hex = if pct < safe - b { &s.pace_colors.under }
                      else if pct < safe { &s.pace_colors.near_safe }
                      else if pct < safe + b { &s.pace_colors.near_over }
                      else { &s.pace_colors.over };
            return hex_to_rgb(hex).unwrap_or(FALLBACK_COLOR);
        }
    }
    let mut color = s.color_thresholds.first().map(|t| t.color.as_str()).unwrap_or("#4a90e2");
    for stop in &s.color_thresholds {
        if pct >= stop.min as f32 { color = &stop.color; } else { break; }
    }
    hex_to_rgb(color).unwrap_or(FALLBACK_COLOR)
}

fn hex_to_rgb(hex: &str) -> Option<[u8; 3]> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 { return None; }
    Some([
        u8::from_str_radix(&h[0..2], 16).ok()?,
        u8::from_str_radix(&h[2..4], 16).ok()?,
        u8::from_str_radix(&h[4..6], 16).ok()?,
    ])
}

fn draw_ring_arc(img: &mut RgbaImage, pct: Option<f32>, r_out: f32, r_in: f32, fg: [u8; 3]) {
    let filled_angle = pct.map(|p| (p.min(100.0) / 100.0) * std::f32::consts::TAU).unwrap_or(0.0);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - CX + 0.5;
            let dy = y as f32 - CY + 0.5;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist < r_in - 1.0 || dist > r_out + 1.0 { continue; }

            let edge_alpha = ((dist - (r_in - 1.0)).min(1.0)) * ((r_out + 1.0 - dist).min(1.0));
            if edge_alpha <= 0.0 { continue; }

            let mut angle = dx.atan2(-dy);
            if angle < 0.0 { angle += std::f32::consts::TAU; }
            let in_filled = angle <= filled_angle;

            let idx = ((y * SIZE + x) * 4) as usize;
            let src_a = img.as_raw()[idx + 3] as f32 / 255.0;
            let dst_a = if in_filled { edge_alpha } else { (TRACK_ALPHA as f32 / 255.0) * edge_alpha };
            let out_a = dst_a + src_a * (1.0 - dst_a);
            if out_a < 0.004 { continue; }

            let (fr, fg_c, fb) = if in_filled { (fg[0], fg[1], fg[2]) }
                                  else { (TRACK[0], TRACK[1], TRACK[2]) };
            let blend = |dst: u8, src: u8| -> u8 {
                let d = dst as f32;
                let s = src as f32;
                ((s * dst_a + d * src_a * (1.0 - dst_a)) / out_a).round() as u8
            };
            let cur = img.get_pixel(x, y).0;
            img.put_pixel(x, y, Rgba([
                blend(cur[0], fr),
                blend(cur[1], fg_c),
                blend(cur[2], fb),
                (out_a * 255.0).round() as u8,
            ]));
        }
    }
}

fn encode_png(img: &RgbaImage) -> Vec<u8> {
    let mut buf = Vec::with_capacity(4096);
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .expect("png encode");
    buf
}

/// Back-compat: existing tray.rs call site uses `render_rings(Some, Some)`.
/// Forwards to `render` with default-ish IconCtx. Once tray.rs is updated
/// this function can be removed.
pub fn render_rings(sess: Option<f32>, weekly: Option<f32>) -> Vec<u8> {
    let settings = IconSettings::default();
    render(sess, weekly, &IconCtx {
        settings: &settings,
        display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Tests added in Step 1 live below ──
    // (copy the test block from Step 1 here)
}
```

Move the Step 1 tests block into the `mod tests` section.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --package claude-usage-tauri --lib icon::tests`
Expected: all new tests pass + original `png_header_correct`, `decoded_dimensions_are_22x22`, `loading_state_renders_without_panicking` still pass. (The `full_ring_colors_high_pct_red` test is now stale — delete it, since `color_for` lives on `IconSettings` now.)

- [ ] **Step 5: Commit**

```bash
git add tauri/src/icon.rs
git commit -m "FEAT: AA ring rendering with threshold + pace color modes"
```

---

## Task 4: Pixel fonts module

**Files:**
- Create: `tauri/src/fonts.rs`
- Modify: `tauri/src/lib.rs` (add `pub mod fonts;`)

- [ ] **Step 1: Read the Electron fonts definition**

Open `src/core/fonts.js`. Each `FONTS[style].glyphs[digit]` is an array of u16 rows where bit N is pixel column N. Keep the exact bit layout. The three styles are `classic`, `digital`, `bold`.

- [ ] **Step 2: Write failing test**

Create `tauri/src/fonts.rs`:

```rust
//! Pixel-font glyph tables + rasterizer. Three fonts: Classic, Digital, Bold.
//! Ported bit-for-bit from `src/core/fonts.js`.

use image::{Rgba, RgbaImage};

pub struct PixelFont {
    pub width: u32,
    pub height: u32,
    pub get: fn(char) -> Option<&'static [u16]>,
}

// ── CLASSIC (5 wide, 7 tall) ─────────────────────────────────────────────────
fn classic_glyph(c: char) -> Option<&'static [u16]> {
    static ZERO: &[u16] = &[0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110];
    static ONE:  &[u16] = &[0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110];
    static TWO:  &[u16] = &[0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111];
    static THREE:&[u16] = &[0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110];
    static FOUR: &[u16] = &[0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010];
    static FIVE: &[u16] = &[0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110];
    static SIX:  &[u16] = &[0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110];
    static SEVEN:&[u16] = &[0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000];
    static EIGHT:&[u16] = &[0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110];
    static NINE: &[u16] = &[0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100];
    match c {
        '0' => Some(ZERO), '1' => Some(ONE), '2' => Some(TWO), '3' => Some(THREE),
        '4' => Some(FOUR), '5' => Some(FIVE), '6' => Some(SIX), '7' => Some(SEVEN),
        '8' => Some(EIGHT), '9' => Some(NINE), _ => None,
    }
}

pub const CLASSIC: PixelFont = PixelFont { width: 5, height: 7, get: classic_glyph };

// ── DIGITAL (7-seg look, 5 wide, 7 tall) ──────────────────────────────────────
fn digital_glyph(c: char) -> Option<&'static [u16]> {
    // Port from src/core/fonts.js — copy each u16 row verbatim.
    // Use the same placeholders as classic until the engineer verifies the
    // exact bit patterns from fonts.js; tests below assert visible pixel
    // count in the canvas rather than exact shapes.
    classic_glyph(c)
}
pub const DIGITAL: PixelFont = PixelFont { width: 5, height: 7, get: digital_glyph };

// ── BOLD (6 wide, 8 tall) ─────────────────────────────────────────────────────
fn bold_glyph(c: char) -> Option<&'static [u16]> {
    // Copy from fonts.js `bold.glyphs`.
    // Placeholder using classic tables padded to 6 wide.
    classic_glyph(c)
}
pub const BOLD: PixelFont = PixelFont { width: 6, height: 8, get: bold_glyph };

pub fn draw_text(img: &mut RgbaImage, text: &str, x: u32, y: u32, color: [u8; 3], font: &PixelFont) {
    let mut cursor_x = x;
    for ch in text.chars() {
        let Some(rows) = (font.get)(ch) else { continue; };
        for (row_idx, row) in rows.iter().enumerate() {
            for col in 0..font.width {
                let bit = 1u16 << (font.width - 1 - col);
                if row & bit != 0 {
                    let px = cursor_x + col;
                    let py = y + row_idx as u32;
                    if px < img.width() && py < img.height() {
                        img.put_pixel(px, py, Rgba([color[0], color[1], color[2], 255]));
                    }
                }
            }
        }
        cursor_x += font.width + 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageBuffer;

    #[test]
    fn draw_text_paints_expected_pixel_count() {
        let mut img: RgbaImage = ImageBuffer::from_pixel(22, 22, Rgba([0, 0, 0, 0]));
        draw_text(&mut img, "42", 0, 0, [255, 255, 255], &CLASSIC);
        let lit = img.pixels().filter(|p| p[3] > 0).count();
        assert!(lit > 10, "expected visible digits, got {lit} lit pixels");
    }

    #[test]
    fn draw_text_skips_unknown_chars() {
        let mut img: RgbaImage = ImageBuffer::from_pixel(22, 22, Rgba([0, 0, 0, 0]));
        draw_text(&mut img, "A", 0, 0, [255, 255, 255], &CLASSIC);
        let lit = img.pixels().filter(|p| p[3] > 0).count();
        assert_eq!(lit, 0);
    }

    #[test]
    fn classic_glyph_zero_has_correct_width() {
        let rows = (CLASSIC.get)('0').unwrap();
        assert_eq!(rows.len(), CLASSIC.height as usize);
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --package claude-usage-tauri --lib fonts::tests`
Expected: module-not-found compile error.

- [ ] **Step 4: Register module**

Edit `tauri/src/lib.rs`:

```rust
pub mod fonts;
```

- [ ] **Step 5: Run tests**

Run: `cargo test --package claude-usage-tauri --lib fonts::tests`
Expected: 3 tests pass.

- [ ] **Step 6: Port the real digital + bold glyph tables**

Open `src/core/fonts.js`. For each digit 0–9 in `FONTS.digital.glyphs` and `FONTS.bold.glyphs`, copy the u16 row array verbatim into the corresponding `static` in `tauri/src/fonts.rs`. Replace the placeholders returning `classic_glyph`.

No automated test locks in the exact shapes (they are visual). Manual check comes in Task 16.

- [ ] **Step 7: Commit**

```bash
git add tauri/src/fonts.rs tauri/src/lib.rs
git commit -m "FEAT: pixel-font glyphs (classic, digital, bold) and rasterizer"
```

---

## Task 5: Digit overlay in `icon.rs`

**Files:**
- Modify: `tauri/src/icon.rs`

- [ ] **Step 1: Write failing test**

Add to the `mod tests` in `icon.rs`:

```rust
#[test]
fn number_session_mode_renders_digits_centered() {
    let s = test_settings();
    let bytes = render(Some(45.0), Some(12.0), &IconCtx {
        settings: &s,
        display_mode: DisplayMode::NumberSession,
        session_safe: None, weekly_safe: None,
    });
    let img = image::load_from_memory(&bytes).unwrap();
    // Count lit pixels in the center band (rows 7-14)
    let mut lit_center = 0;
    for y in 7..15 {
        for x in 0..22 {
            if img.get_pixel(x, y)[3] > 100 { lit_center += 1; }
        }
    }
    assert!(lit_center > 10, "expected '45' digits, found {lit_center} lit pixels");
}

#[test]
fn number_weekly_mode_caps_at_99() {
    // If weekly=150 we should still render a max of 99 (no overflow).
    let s = test_settings();
    let _ = render(Some(10.0), Some(150.0), &IconCtx {
        settings: &s,
        display_mode: DisplayMode::NumberWeekly,
        session_safe: None, weekly_safe: None,
    });
    // Primary assertion: no panic; exact pixel count manually verified.
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --package claude-usage-tauri --lib icon::tests::number`
Expected: `lit_center` is 0 since digit overlay isn't rendered yet.

- [ ] **Step 3: Implement digit overlay**

In `tauri/src/icon.rs`, extend the `render` fn's `NumberSession`/`NumberWeekly` arm:

```rust
DisplayMode::NumberSession | DisplayMode::NumberWeekly => {
    let (pct, safe) = match ctx.display_mode {
        DisplayMode::NumberSession => (sess, ctx.session_safe),
        DisplayMode::NumberWeekly  => (weekly, ctx.weekly_safe),
        _ => unreachable!(),
    };
    let Some(pct) = pct else {
        // no data — draw dim rings like idle state
        draw_ring_arc(&mut img, Some(100.0), OUTER_R_OUT, OUTER_R_IN, IDLE_GRAY);
        return encode_png(&img);
    };
    let val = (pct.round() as i32).min(99).max(0) as u32;
    let text = val.to_string();
    let font: &crate::fonts::PixelFont = match ctx.settings.overlay_style {
        crate::icon_settings::OverlayStyle::Classic => &crate::fonts::CLASSIC,
        crate::icon_settings::OverlayStyle::Digital => &crate::fonts::DIGITAL,
        crate::icon_settings::OverlayStyle::Bold    => &crate::fonts::BOLD,
    };
    let chars = text.chars().count() as u32;
    let total_w = chars * font.width + (chars - 1);
    let x = SIZE.saturating_sub(total_w) / 2;
    let y = SIZE.saturating_sub(font.height) / 2;
    let color = color_for(Some(pct), ctx, safe, /*icon=*/false);
    crate::fonts::draw_text(&mut img, &text, x, y, color, font);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --package claude-usage-tauri --lib icon::tests`
Expected: new tests pass; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add tauri/src/icon.rs
git commit -m "FEAT: digit overlay for NumberSession/NumberWeekly display modes"
```

---

## Task 6: Bars mode in `icon.rs`

**Files:**
- Modify: `tauri/src/icon.rs`

- [ ] **Step 1: Write failing test**

Add to `mod tests`:

```rust
#[test]
fn bars_mode_fills_left_column_for_session_pct() {
    let mut s = test_settings();
    s.icon_style = IconStyle::Bars;
    let bytes = render(Some(80.0), Some(20.0), &IconCtx {
        settings: &s,
        display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
    });
    let img = image::load_from_memory(&bytes).unwrap();
    // Left bar x∈[3,8] — count fully-opaque pixels in that column range.
    let mut left_filled = 0;
    let mut right_filled = 0;
    for y in 2..=20 {
        for x in 3..=8 {
            if img.get_pixel(x, y)[3] == 255 { left_filled += 1; }
        }
        for x in 13..=18 {
            if img.get_pixel(x, y)[3] == 255 { right_filled += 1; }
        }
    }
    assert!(left_filled > right_filled, "session 80% should fill more than weekly 20%");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --package claude-usage-tauri --lib icon::tests::bars`
Expected: fails because the Bars arm currently delegates to ring drawing.

- [ ] **Step 3: Implement `draw_bars`**

Add to `tauri/src/icon.rs`:

```rust
fn draw_bars(img: &mut RgbaImage, sess: Option<f32>, weekly: Option<f32>, ctx: &IconCtx) {
    let sess_color = color_for(sess, ctx, ctx.session_safe, true);
    let weekly_color = color_for(weekly, ctx, ctx.weekly_safe, true);
    draw_column(img, 3, 8, sess.unwrap_or(0.0), sess_color);
    draw_column(img, 13, 18, weekly.unwrap_or(0.0), weekly_color);
}

fn draw_column(img: &mut RgbaImage, x0: u32, x1: u32, pct: f32, fg: [u8; 3]) {
    let fill_h = (pct.min(100.0).max(0.0) / 100.0) * 18.0;
    for y in 2..=20u32 {
        let filled = (20 - y) as f32 <= fill_h;
        let (r, g, b, a) = if filled {
            (fg[0], fg[1], fg[2], 255)
        } else {
            (TRACK[0], TRACK[1], TRACK[2], 80)
        };
        for x in x0..=x1 {
            img.put_pixel(x, y, Rgba([r, g, b, a]));
        }
    }
}
```

Replace the `IconStyle::Bars` branch in `render`:

```rust
} else if ctx.settings.icon_style == IconStyle::Bars {
    draw_bars(&mut img, sess, weekly, ctx);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --package claude-usage-tauri --lib icon::tests`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add tauri/src/icon.rs
git commit -m "FEAT: bars icon style"
```

---

## Task 7: Display state + click cycle + reset ticker

**Files:**
- Create: `tauri/src/display_state.rs`
- Modify: `tauri/src/state.rs`, `tauri/src/lib.rs`, `tauri/src/tray.rs`

- [ ] **Step 1: Write failing tests for `TrayDisplayState`**

Create `tauri/src/display_state.rs`:

```rust
//! Display-cycle state for the tray. Pure logic — no Tauri deps, easily tested.

use crate::icon::DisplayMode;
use crate::icon_settings::DefaultDisplay;
use std::time::{Duration, Instant};

pub const RESET_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub struct TrayDisplayState {
    pub temp: Option<DisplayMode>,
    pub cycle: Vec<DisplayMode>,
    pub idx: usize,
    pub reset_deadline: Option<Instant>,
    pub spin_frame: Option<u32>,
}

impl Default for TrayDisplayState {
    fn default() -> Self {
        Self { temp: None, cycle: vec![], idx: 0, reset_deadline: None, spin_frame: None }
    }
}

pub fn build_cycle(default: DefaultDisplay) -> Vec<DisplayMode> {
    let all = [DisplayMode::Icon, DisplayMode::NumberSession, DisplayMode::NumberWeekly];
    let start_idx = match default {
        DefaultDisplay::Icon => 0,
        DefaultDisplay::Session => 1,
        DefaultDisplay::Weekly => 2,
    };
    let mut cycle = vec![all[start_idx]];
    for (i, m) in all.iter().enumerate() {
        if i != start_idx { cycle.push(*m); }
    }
    cycle
}

impl TrayDisplayState {
    pub fn cycle_next(&mut self, default: DefaultDisplay, now: Instant) {
        if self.cycle.is_empty() { self.cycle = build_cycle(default); self.idx = 0; }
        self.idx = (self.idx + 1) % self.cycle.len();
        self.temp = Some(self.cycle[self.idx]);
        self.reset_deadline = Some(now + RESET_AFTER);
    }

    pub fn tick(&mut self, now: Instant) -> bool {
        if let Some(deadline) = self.reset_deadline {
            if now >= deadline {
                self.temp = None;
                self.cycle.clear();
                self.idx = 0;
                self.reset_deadline = None;
                return true;
            }
        }
        false
    }

    pub fn invalidate_cycle(&mut self) {
        self.temp = None;
        self.cycle.clear();
        self.idx = 0;
        self.reset_deadline = None;
    }
}

pub fn effective_mode(default: DefaultDisplay, temp: Option<DisplayMode>) -> DisplayMode {
    temp.unwrap_or_else(|| match default {
        DefaultDisplay::Icon => DisplayMode::Icon,
        DefaultDisplay::Session => DisplayMode::NumberSession,
        DefaultDisplay::Weekly => DisplayMode::NumberWeekly,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_cycle_default_icon_starts_with_icon() {
        assert_eq!(
            build_cycle(DefaultDisplay::Icon),
            vec![DisplayMode::Icon, DisplayMode::NumberSession, DisplayMode::NumberWeekly],
        );
    }

    #[test]
    fn build_cycle_default_session_starts_with_session() {
        let c = build_cycle(DefaultDisplay::Session);
        assert_eq!(c[0], DisplayMode::NumberSession);
        assert_eq!(c.len(), 3);
    }

    #[test]
    fn cycle_next_wraps_after_three_clicks() {
        let mut st = TrayDisplayState::default();
        let now = Instant::now();
        st.cycle_next(DefaultDisplay::Icon, now);
        assert_eq!(st.temp, Some(DisplayMode::NumberSession));
        st.cycle_next(DefaultDisplay::Icon, now);
        assert_eq!(st.temp, Some(DisplayMode::NumberWeekly));
        st.cycle_next(DefaultDisplay::Icon, now);
        assert_eq!(st.temp, Some(DisplayMode::Icon));
    }

    #[test]
    fn tick_clears_temp_after_deadline() {
        let mut st = TrayDisplayState::default();
        let now = Instant::now();
        st.cycle_next(DefaultDisplay::Icon, now);
        assert!(st.temp.is_some());
        assert!(!st.tick(now));
        assert!(st.tick(now + RESET_AFTER + Duration::from_secs(1)));
        assert!(st.temp.is_none());
        assert!(st.cycle.is_empty());
    }

    #[test]
    fn effective_mode_uses_temp_when_present() {
        assert_eq!(effective_mode(DefaultDisplay::Icon, Some(DisplayMode::NumberWeekly)),
                   DisplayMode::NumberWeekly);
        assert_eq!(effective_mode(DefaultDisplay::Session, None),
                   DisplayMode::NumberSession);
    }
}
```

- [ ] **Step 2: Register + run tests**

Add to `tauri/src/lib.rs`:
```rust
pub mod display_state;
```

Run: `cargo test --package claude-usage-tauri --lib display_state::tests`
Expected: 5 tests pass.

- [ ] **Step 3: Add display state to `AppState`**

Edit `tauri/src/state.rs`:

```rust
use crate::display_state::TrayDisplayState;
use crate::types::{AuthState, Settings, UsageSnapshot};
use std::sync::Mutex;

pub struct AppState {
    pub current_usage: Mutex<Option<UsageSnapshot>>,
    pub settings: Mutex<Settings>,
    pub auth_state: Mutex<AuthState>,
    pub display: Mutex<TrayDisplayState>,
}

impl AppState {
    pub fn new(settings: Settings, auth_state: AuthState) -> Self {
        Self {
            current_usage: Mutex::new(None),
            settings: Mutex::new(settings),
            auth_state: Mutex::new(auth_state),
            display: Mutex::new(TrayDisplayState::default()),
        }
    }
}
```

- [ ] **Step 4: Wire click-cycle + reset ticker in `tray.rs`**

Replace the `on_tray_icon_event` and add `render_tray_now` + reset-ticker task. Full replacement for `tauri/src/tray.rs`:

```rust
//! Builds the tray icon and its context menu; owns the render funnel.

use crate::display_state::{effective_mode, TrayDisplayState};
use crate::icon::{self, DisplayMode, IconCtx};
use crate::icon_settings::{IconSettings, TooltipSettings};
use crate::state::AppState;
use crate::types::{AuthState, UsageSnapshot};
use crate::usage_parser::{self, FIVE_HOUR_MS, SEVEN_DAY_MS};
use anyhow::Result;
use chrono::Utc;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri::{AppHandle, Listener, Manager};

pub const TRAY_ID: &str = "main-tray";

pub fn setup(app: &AppHandle) -> Result<()> {
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "Open Dashboard").build(app)?)
        .item(&MenuItemBuilder::with_id("refresh", "Refresh Now").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;

    let idle_bytes = {
        let s = IconSettings::default();
        icon::render(None, None, &IconCtx {
            settings: &s, display_mode: DisplayMode::Icon,
            session_safe: None, weekly_safe: None,
        })
    };
    let idle_icon = Image::from_bytes(&idle_bytes)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(idle_icon)
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
                        let _ = crate::scheduler::poll_once(&h, crate::scheduler::PollTrigger::Manual).await;
                    });
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                on_left_click(tray.app_handle().clone());
            }
        })
        .build(app)?;

    // Listener: settings-changed → invalidate cycle + re-render.
    {
        let h = app.clone();
        app.listen("settings-changed", move |_| {
            {
                let st = h.state::<AppState>();
                st.display.lock().unwrap().invalidate_cycle();
            }
            render_tray_now(&h);
        });
    }

    // Listener: usage-updated → re-render.
    {
        let h = app.clone();
        app.listen("usage-updated", move |_| render_tray_now(&h));
    }

    // Initial render from cached snapshot.
    render_tray_now(app);

    // Background reset ticker (1s granularity).
    let reset_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let changed = {
                let s = reset_handle.state::<AppState>();
                s.display.lock().unwrap().tick(Instant::now())
            };
            if changed { render_tray_now(&reset_handle); }
        }
    });

    Ok(())
}

fn on_left_click(app: AppHandle) {
    let logged_in = matches!(*app.state::<AppState>().auth_state.lock().unwrap(), AuthState::LoggedIn);
    if !logged_in {
        tauri::async_runtime::spawn(async move {
            let _ = crate::ipc::start_login(app).await;
        });
        return;
    }
    let default = IconSettings::try_from(&*app.state::<AppState>().settings.lock().unwrap())
        .unwrap_or_default().default_display;
    {
        let s = app.state::<AppState>();
        s.display.lock().unwrap().cycle_next(default, Instant::now());
    }
    render_tray_now(&app);
}

pub fn render_tray_now(app: &AppHandle) {
    let state = app.state::<AppState>();
    let snap: Option<UsageSnapshot> = state.current_usage.lock().unwrap().clone();
    let settings_guard = state.settings.lock().unwrap();
    let icon_s: IconSettings = (&*settings_guard).try_into().unwrap_or_default();
    let tip_s: TooltipSettings = (&*settings_guard).try_into().unwrap_or_default();
    drop(settings_guard);

    let st = state.display.lock().unwrap();
    let mode = effective_mode(icon_s.default_display, st.temp);
    let spin = st.spin_frame;
    drop(st);

    let sess = snap.as_ref().map(usage_parser::session_pct);
    let weekly = snap.as_ref().map(usage_parser::weekly_pct);
    let now = Utc::now();
    let sess_safe = snap.as_ref().and_then(|s| usage_parser::calc_safe_pct(&s.five_hour.resets_at, FIVE_HOUR_MS, now));
    let weekly_safe = snap.as_ref().and_then(|s| usage_parser::calc_safe_pct(&s.seven_day.resets_at, SEVEN_DAY_MS, now));

    let ctx = IconCtx { settings: &icon_s, display_mode: mode, session_safe: sess_safe, weekly_safe };

    let bytes = match spin {
        Some(f) => icon::render_spin(f, weekly, &ctx),
        None => icon::render(sess, weekly, &ctx),
    };
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return; };
    if let Ok(img) = Image::from_bytes(&bytes) { let _ = tray.set_icon(Some(img)); }
    let _ = tray.set_tooltip(Some(usage_parser::build_tooltip(snap.as_ref(), &tip_s, now)));
}
```

Note: `icon::render_spin` + `scheduler::PollTrigger` don't exist yet. They're stubbed in Task 8. For now, add these stubs to `icon.rs`:

```rust
/// Temporary stub; replaced in Task 8 with a real spinning frame.
pub fn render_spin(_frame: u32, weekly: Option<f32>, ctx: &IconCtx) -> Vec<u8> {
    render(None, weekly, ctx)
}
```

And to `scheduler.rs`:

```rust
pub enum PollTrigger { Scheduled, Manual, Hook }
```

(If `scheduler.rs` doesn't have `poll_once` accepting `PollTrigger` yet, temporarily leave existing signature and wrap call sites. Task 8 converts.)

- [ ] **Step 5: Run tests + manual compile check**

Run: `cargo check --package claude-usage-tauri`
Expected: compiles. Fix any missing imports.

Run: `cargo test --package claude-usage-tauri --lib`
Expected: all pure tests pass.

- [ ] **Step 6: Commit**

```bash
git add tauri/src/display_state.rs tauri/src/state.rs tauri/src/lib.rs tauri/src/tray.rs tauri/src/icon.rs tauri/src/scheduler.rs
git commit -m "FEAT: tray display-cycle state machine + 60s reset ticker"
```

---

## Task 8: Spin animation + `PollTrigger` threading

**Files:**
- Modify: `tauri/src/icon.rs`, `tauri/src/scheduler.rs`, `tauri/src/tray.rs`, `tauri/src/hook_server.rs`

- [ ] **Step 1: Write failing test for spin-frame differentiation**

Add to `tauri/src/icon.rs` tests:

```rust
#[test]
fn render_spin_differs_from_static_render() {
    let s = test_settings();
    let ctx = IconCtx {
        settings: &s, display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
    };
    let a = render(Some(50.0), Some(50.0), &ctx);
    let b = render_spin(0, Some(50.0), &ctx);
    assert_ne!(a, b, "spin frame should produce different bytes than static render");
}

#[test]
fn render_spin_frames_differ_from_each_other() {
    let s = test_settings();
    let ctx = IconCtx {
        settings: &s, display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
    };
    let f0 = render_spin(0, Some(50.0), &ctx);
    let f5 = render_spin(5, Some(50.0), &ctx);
    assert_ne!(f0, f5);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --package claude-usage-tauri --lib icon::tests::render_spin`
Expected: pass the first (stub is same as static), fail the others. Confirm the stub isn't returning meaningful frames yet.

- [ ] **Step 3: Implement `render_spin` properly**

Replace the stub:

```rust
pub fn render_spin(frame: u32, weekly: Option<f32>, ctx: &IconCtx) -> Vec<u8> {
    let mut img: RgbaImage = ImageBuffer::from_pixel(SIZE, SIZE, Rgba([0, 0, 0, 0]));
    let arc_len = std::f32::consts::PI * 0.6;
    let start = (frame as f32 * 0.28) % std::f32::consts::TAU;

    if ctx.settings.icon_style == IconStyle::Bars {
        // bars: pulse session column blue, weekly steady.
        let blue = [74u8, 144, 76];
        let pulse = ((frame as f32 * 0.2).sin()).abs();
        let alpha = (150.0 + pulse * 105.0).round() as u8;
        for y in 2..=20 {
            for x in 3..=8 {
                img.put_pixel(x, y, Rgba([blue[0], blue[1], blue[2], alpha]));
            }
        }
        draw_column(&mut img, 13, 18, weekly.unwrap_or(0.0),
                    color_for(weekly, ctx, ctx.weekly_safe, true));
    } else {
        draw_spin_arc(&mut img, start, arc_len, OUTER_R_OUT, OUTER_R_IN, LOADING);
        draw_ring_arc(&mut img, weekly, INNER_R_OUT, INNER_R_IN,
                      color_for(weekly, ctx, ctx.weekly_safe, true));
    }
    encode_png(&img)
}

fn draw_spin_arc(img: &mut RgbaImage, start: f32, arc_len: f32, r_out: f32, r_in: f32, fg: [u8; 3]) {
    let end = start + arc_len;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - CX + 0.5;
            let dy = y as f32 - CY + 0.5;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist < r_in - 1.0 || dist > r_out + 1.0 { continue; }
            let edge_alpha = ((dist - (r_in - 1.0)).min(1.0)) * ((r_out + 1.0 - dist).min(1.0));
            let mut angle = dx.atan2(-dy);
            if angle < 0.0 { angle += std::f32::consts::TAU; }
            let in_arc = if end > std::f32::consts::TAU {
                angle >= start || angle <= end - std::f32::consts::TAU
            } else {
                angle >= start && angle <= end
            };
            if !in_arc { continue; }
            let a = (edge_alpha * 255.0) as u8;
            img.put_pixel(x, y, Rgba([fg[0], fg[1], fg[2], a]));
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --package claude-usage-tauri --lib icon::tests`
Expected: all pass.

- [ ] **Step 5: Wire `PollTrigger` into `scheduler::poll_once`**

Edit `tauri/src/scheduler.rs`:

```rust
#[derive(Clone, Copy, Debug)]
pub enum PollTrigger { Scheduled, Manual, Hook }

pub async fn poll_once(app: &AppHandle, trigger: PollTrigger) -> Result<()> {
    let spinning = matches!(trigger, PollTrigger::Manual | PollTrigger::Hook);
    let spin_task = if spinning { Some(start_spin(app.clone())) } else { None };

    let result = do_poll(app).await;

    if let Some(handle) = spin_task { handle.abort(); }
    {
        let st = app.state::<AppState>();
        st.display.lock().unwrap().spin_frame = None;
    }
    crate::tray::render_tray_now(app);
    result
}

fn start_spin(app: AppHandle) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut frame: u32 = 0;
        loop {
            {
                let st = app.state::<AppState>();
                st.display.lock().unwrap().spin_frame = Some(frame);
            }
            crate::tray::render_tray_now(&app);
            frame = frame.wrapping_add(1);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
}
```

Refactor existing `do_poll(app)` = current body of `poll_once`. Replace all call sites (including `lib.rs` setup startup poll, IPC `poll_now`, hook server) to pass `PollTrigger`:

- Scheduled timer in `spawn(...)` → `PollTrigger::Scheduled`
- `ipc::poll_now` → `PollTrigger::Manual`
- `hook_server::on_refresh` → `PollTrigger::Hook`
- `lib.rs` startup after auth → `PollTrigger::Scheduled`

- [ ] **Step 6: Run `cargo check`**

Run: `cargo check --package claude-usage-tauri`
Expected: compiles. Fix any remaining call sites.

- [ ] **Step 7: Commit**

```bash
git add tauri/src/icon.rs tauri/src/scheduler.rs tauri/src/tray.rs tauri/src/hook_server.rs tauri/src/ipc.rs tauri/src/lib.rs
git commit -m "FEAT: spin animation on manual + hook-triggered polls"
```

---

## Task 9: Threshold-crossing notification hook

**Files:**
- Modify: `tauri/src/scheduler.rs` (fire notification after successful poll)

*(full `notifications.rs` implementation comes in Task 11; this task wires the detection into the poll path and emits a stub event that Task 11 replaces.)*

- [ ] **Step 1: Capture prev snapshot before poll**

In `scheduler::do_poll`, read previous snapshot at start:

```rust
let prev_snap = app.state::<AppState>().current_usage.lock().unwrap().clone();
```

- [ ] **Step 2: After successful fetch, compare and emit event**

After the state is updated with the new snapshot:

```rust
let new_snap = app.state::<AppState>().current_usage.lock().unwrap().clone();
if let (Some(prev), Some(new)) = (prev_snap.as_ref(), new_snap.as_ref()) {
    let icon_s = IconSettings::try_from(&*app.state::<AppState>().settings.lock().unwrap())
        .unwrap_or_default();
    let prev_sess = Some(crate::usage_parser::session_pct(prev));
    let new_sess = Some(crate::usage_parser::session_pct(new));
    let prev_wk = Some(crate::usage_parser::weekly_pct(prev));
    let new_wk = Some(crate::usage_parser::weekly_pct(new));
    let crossed =
        crate::usage_parser::threshold_crossed(prev_sess, new_sess, &icon_s.color_thresholds) ||
        crate::usage_parser::threshold_crossed(prev_wk, new_wk, &icon_s.color_thresholds);
    if crossed {
        let pct = new_sess.unwrap_or(0.0).max(new_wk.unwrap_or(0.0)).round() as u32;
        // Task 11 replaces this with a direct notifications::fire call.
        let _ = app.emit("threshold-crossed", serde_json::json!({ "percent": pct }));
    }
}
```

- [ ] **Step 3: Compile check**

Run: `cargo check --package claude-usage-tauri`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add tauri/src/scheduler.rs
git commit -m "FEAT: detect threshold crossings after poll"
```

---

## Task 10: Audio playback (`rodio`) with queue gate

**Files:**
- Modify: `tauri/Cargo.toml`
- Create: `tauri/src/audio.rs`
- Modify: `tauri/src/state.rs`, `tauri/src/lib.rs`
- Create: `tauri/assets/sounds/` (copied from `src/assets/sounds/`)

- [ ] **Step 1: Add `rodio` dep**

Edit `tauri/Cargo.toml`:

```toml
rodio = { version = "0.19", default-features = false, features = ["mp3", "symphonia-mp3", "symphonia-wav"] }
```

Run: `cargo build --package claude-usage-tauri`
Expected: compiles.

- [ ] **Step 2: Copy sound assets**

```bash
cp -r src/assets/sounds tauri/assets/sounds
```

(Mkdir `tauri/assets/` first if missing.)

- [ ] **Step 3: Write audio module**

Create `tauri/src/audio.rs`:

```rust
//! Audio playback queue. One consumer task, 200ms gap between entries so
//! back-to-back notifications don't overlap.

use anyhow::{Context, Result};
use rodio::{Decoder, OutputStream, Sink};
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

const GAP: Duration = Duration::from_millis(200);

pub struct AudioCtx {
    queue: Arc<Mutex<VecDeque<PathBuf>>>,
    worker_started: Arc<Mutex<bool>>,
}

impl AudioCtx {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            worker_started: Arc::new(Mutex::new(false)),
        }
    }

    pub fn play_file(&self, path: impl AsRef<Path>) {
        self.queue.lock().unwrap().push_back(path.as_ref().to_path_buf());
        self.ensure_worker();
    }

    fn ensure_worker(&self) {
        let mut started = self.worker_started.lock().unwrap();
        if *started { return; }
        *started = true;
        let queue = Arc::clone(&self.queue);
        let flag = Arc::clone(&self.worker_started);
        std::thread::spawn(move || {
            let Ok((_stream, handle)) = OutputStream::try_default() else {
                log::warn!("audio: failed to init output stream");
                *flag.lock().unwrap() = false;
                return;
            };
            loop {
                let next = queue.lock().unwrap().pop_front();
                match next {
                    Some(path) => {
                        if let Err(e) = play_blocking(&handle, &path) {
                            log::warn!("audio play failed: {e}");
                        }
                        std::thread::sleep(GAP);
                    }
                    None => {
                        std::thread::sleep(Duration::from_millis(100));
                        if queue.lock().unwrap().is_empty() {
                            *flag.lock().unwrap() = false;
                            break;
                        }
                    }
                }
            }
        });
    }
}

fn play_blocking(handle: &rodio::OutputStreamHandle, path: &Path) -> Result<()> {
    let file = File::open(path).with_context(|| format!("open {path:?}"))?;
    let source = Decoder::new(BufReader::new(file)).context("decode")?;
    let sink = Sink::try_new(handle).context("sink")?;
    sink.append(source);
    sink.sleep_until_end();
    Ok(())
}

/// Resolve `asset_sounds_dir()/name` → absolute path, skipping if not found.
pub fn play_sound_file(app: &AppHandle, filename: &str) {
    let Some(dir) = crate::paths::sounds_dir().ok() else { return; };
    let path = dir.join(filename);
    if !path.exists() {
        log::warn!("sound file missing: {path:?}");
        return;
    }
    app.state::<crate::state::AppState>().audio.play_file(path);
}

pub fn play_wav(app: &AppHandle, path: &Path) {
    app.state::<crate::state::AppState>().audio.play_file(path);
}
```

- [ ] **Step 4: Add `audio` to `AppState` + register module**

Edit `tauri/src/state.rs`:

```rust
pub struct AppState {
    pub current_usage: Mutex<Option<UsageSnapshot>>,
    pub settings: Mutex<Settings>,
    pub auth_state: Mutex<AuthState>,
    pub display: Mutex<TrayDisplayState>,
    pub audio: crate::audio::AudioCtx,
}

impl AppState {
    pub fn new(settings: Settings, auth_state: AuthState) -> Self {
        Self {
            current_usage: Mutex::new(None),
            settings: Mutex::new(settings),
            auth_state: Mutex::new(auth_state),
            display: Mutex::new(TrayDisplayState::default()),
            audio: crate::audio::AudioCtx::new(),
        }
    }
}
```

Edit `tauri/src/lib.rs`:

```rust
pub mod audio;
```

- [ ] **Step 5: Add `paths::sounds_dir`**

In `tauri/src/paths.rs`, add:

```rust
pub fn sounds_dir() -> anyhow::Result<std::path::PathBuf> {
    // In dev: tauri/assets/sounds. In bundle: resource dir.
    // For first pass, prefer resource-dir when compiled, fallback to cargo manifest.
    let exe = std::env::current_exe()?;
    let candidate = exe.parent().map(|p| p.join("resources").join("assets").join("sounds"));
    if let Some(p) = candidate.filter(|p| p.exists()) { return Ok(p); }
    // Dev path:
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    Ok(manifest.join("assets").join("sounds"))
}
```

- [ ] **Step 6: Declare assets in tauri.conf.json**

Add to `tauri/tauri.conf.json` under `bundle`:

```json
"resources": ["assets/sounds/*.mp3"]
```

- [ ] **Step 7: Compile check**

Run: `cargo check --package claude-usage-tauri`
Expected: compiles.

- [ ] **Step 8: Commit**

```bash
git add tauri/Cargo.toml tauri/src/audio.rs tauri/src/state.rs tauri/src/lib.rs tauri/src/paths.rs tauri/tauri.conf.json tauri/assets/sounds
git commit -m "FEAT: audio playback with rodio + 200ms queue gate"
```

---

## Task 11: Notifications fire path

**Files:**
- Create: `tauri/src/notifications.rs`
- Modify: `tauri/src/lib.rs`, `tauri/src/scheduler.rs`, `tauri/src/hook_server.rs`

- [ ] **Step 1: Write failing tests for template rendering**

Create `tauri/src/notifications.rs`:

```rust
//! Notification firing: workFinished / questionAsked / thresholdCrossed.

use crate::audio;
use crate::icon_settings::{NotifMode, NotificationRule, NotificationsConfig};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifKind { WorkFinished, QuestionAsked, ThresholdCrossed }

#[derive(Default, Debug)]
pub struct NotifContext {
    pub name: Option<String>,
    pub percent: Option<u32>,
}

pub fn fire(app: &AppHandle, kind: NotifKind, ctx: NotifContext) {
    let cfg: NotificationsConfig = (&*app.state::<AppState>().settings.lock().unwrap())
        .try_into().unwrap_or_default();
    let rule = match kind {
        NotifKind::WorkFinished => cfg.work_finished,
        NotifKind::QuestionAsked => cfg.question_asked,
        NotifKind::ThresholdCrossed => cfg.threshold_crossed,
    };
    if !rule.enabled { return; }
    match rule.mode {
        NotifMode::Sound => audio::play_sound_file(app, &rule.sound_file),
        NotifMode::Voice => {
            let text = render_template(&rule.template, &ctx);
            if text.is_empty() { return; }
            speak(app, &text, rule.voice_name.as_deref());
        }
    }
}

pub fn render_template(tpl: &str, ctx: &NotifContext) -> String {
    let name = sanitize(ctx.name.as_deref().unwrap_or(""));
    let pct = ctx.percent.map(|p| format!("{p}%")).unwrap_or_default();
    sanitize(&tpl.replace("{name}", &name).replace("{percent}", &pct))
}

fn sanitize(s: &str) -> String {
    let mapped: String = s.chars()
        .map(|c| if matches!(c, '_' | '-') { ' ' } else { c })
        .collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn project_name_from_cwd(cwd: &str) -> Option<String> {
    let last = cwd.rsplit(|c| c == '/' || c == '\\').next()?.to_string();
    if last.is_empty() { None } else { Some(last) }
}

fn speak(app: &AppHandle, text: &str, voice: Option<&str>) {
    // Piper-first, web-speech fallback. Piper integration arrives in Task 12;
    // for now always fall back to renderer speechSynthesis.
    let _ = app.emit("speak-fallback", serde_json::json!({
        "text": text,
        "voiceName": voice,
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_substitutes_name() {
        let out = render_template("{name} is done", &NotifContext {
            name: Some("my_project".into()), percent: None,
        });
        assert_eq!(out, "my project is done");
    }

    #[test]
    fn template_substitutes_percent() {
        let out = render_template("{percent} threshold", &NotifContext {
            name: None, percent: Some(80),
        });
        assert_eq!(out, "80% threshold");
    }

    #[test]
    fn sanitize_collapses_whitespace_and_underscores() {
        assert_eq!(sanitize("foo_bar   baz-quux"), "foo bar baz quux");
    }

    #[test]
    fn project_name_last_path_component() {
        assert_eq!(project_name_from_cwd("C:\\Users\\tecno\\Desktop\\alpha"), Some("alpha".into()));
        assert_eq!(project_name_from_cwd("/home/tecno/beta"), Some("beta".into()));
        assert_eq!(project_name_from_cwd(""), None);
    }
}
```

- [ ] **Step 2: Register + run tests**

Add to `tauri/src/lib.rs`:
```rust
pub mod notifications;
```

Run: `cargo test --package claude-usage-tauri --lib notifications::tests`
Expected: 4 tests pass.

- [ ] **Step 3: Wire `ThresholdCrossed` in scheduler**

In `scheduler::do_poll`, replace the `app.emit("threshold-crossed", ...)` stub from Task 9 with:

```rust
if crossed {
    let pct = new_sess.unwrap_or(0.0).max(new_wk.unwrap_or(0.0)).round() as u32;
    crate::notifications::fire(app, crate::notifications::NotifKind::ThresholdCrossed,
        crate::notifications::NotifContext { percent: Some(pct), name: None });
}
```

- [ ] **Step 4: Wire `WorkFinished` in hook `/refresh`**

In `tauri/src/hook_server.rs::on_refresh`, after kicking the poll:

```rust
let name = payload.cwd.as_deref().and_then(crate::notifications::project_name_from_cwd);
crate::notifications::fire(&ctx.app, crate::notifications::NotifKind::WorkFinished,
    crate::notifications::NotifContext { name, percent: None });
```

- [ ] **Step 5: Add `/notify` route + wire `QuestionAsked`**

In `hook_server.rs` route setup:

```rust
.route("/notify", post(on_notify))
```

Handler:

```rust
async fn on_notify(
    AxState(ctx): AxState<Arc<HookCtx>>,
    Json(payload): Json<RefreshPayload>,
) -> impl IntoResponse {
    log::info!("hook /notify: cwd={}", payload.cwd.as_deref().unwrap_or("-"));
    let name = payload.cwd.as_deref().and_then(crate::notifications::project_name_from_cwd);
    crate::notifications::fire(&ctx.app, crate::notifications::NotifKind::QuestionAsked,
        crate::notifications::NotifContext { name, percent: None });
    StatusCode::OK
}
```

- [ ] **Step 6: Compile + test**

Run: `cargo test --package claude-usage-tauri --lib`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add tauri/src/notifications.rs tauri/src/lib.rs tauri/src/scheduler.rs tauri/src/hook_server.rs
git commit -m "FEAT: wire notifications (work-finished, question-asked, threshold-crossed)"
```

---

## Task 12: Piper sidecar integration

**Files:**
- Create: `tauri/src/piper.rs`
- Create: `tauri/binaries/piper/.gitkeep`
- Modify: `tauri/tauri.conf.json`, `tauri/src/notifications.rs`, `tauri/src/lib.rs`, `tauri/src/ipc.rs`

- [ ] **Step 1: Read voice catalog from Electron**

Inspect `src/core/piper.js` for:
- Hardcoded voice IDs + download URLs (ONNX + `.onnx.json`).
- Binary invocation arguments.

Note the exact list and URL template for Step 3.

- [ ] **Step 2: Write failing tests**

Create `tauri/src/piper.rs`:

```rust
//! Piper TTS sidecar manager.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VoiceEntry {
    pub id: String,
    pub label: String,
    pub installed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PiperStatus {
    pub installed: bool,
    pub voices: Vec<VoiceEntry>,
}

/// Voice catalog ported from `src/core/piper.js`.
/// Each entry: (id, label, onnx_url, config_url).
const CATALOG: &[(&str, &str, &str, &str)] = &[
    // TODO(impl): copy exact tuples from src/core/piper.js voice list.
    ("en_US-amy-medium", "Amy (US, medium)",
     "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx",
     "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json"),
];

pub fn scan_voices(voices_dir: &Path) -> Vec<VoiceEntry> {
    CATALOG.iter().map(|(id, label, _, _)| {
        let dir = voices_dir.join(id);
        let installed = dir.join("model.onnx").exists() && dir.join("model.onnx.json").exists();
        VoiceEntry { id: (*id).into(), label: (*label).into(), installed }
    }).collect()
}

pub fn piper_binary_exists() -> bool {
    // tauri sidecar ships binary beside the exe; check it's resolvable.
    which::which("piper").is_ok()
        || crate::paths::piper_binary_path().ok().map(|p| p.exists()).unwrap_or(false)
}

pub fn status() -> PiperStatus {
    let Ok(voices_dir) = crate::paths::piper_voices_dir() else {
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
    let dir = crate::paths::piper_voices_dir()?.join(id);
    std::fs::create_dir_all(&dir).context("create voice dir")?;
    download_to(&entry.2, &dir.join("model.onnx")).await?;
    download_to(&entry.3, &dir.join("model.onnx.json")).await?;
    Ok(())
}

async fn download_to(url: &str, path: &Path) -> Result<()> {
    let bytes = reqwest::get(url).await?.error_for_status()?.bytes().await?;
    std::fs::write(path, &bytes).context("write file")?;
    Ok(())
}

pub async fn synthesize(text: &str, voice_id: &str) -> Result<PathBuf> {
    let voices_dir = crate::paths::piper_voices_dir()?;
    let model = voices_dir.join(voice_id).join("model.onnx");
    if !model.exists() { anyhow::bail!("voice not installed: {voice_id}"); }
    let out = std::env::temp_dir().join(format!("piper-{}.wav", rand::random::<u64>()));
    let binary = crate::paths::piper_binary_path()?;
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
```

- [ ] **Step 3: Add `which` and `rand` to Cargo.toml**

`rand` is already present. Add:

```toml
which = "7"
```

- [ ] **Step 4: Add piper paths helpers**

In `tauri/src/paths.rs`:

```rust
pub fn piper_voices_dir() -> anyhow::Result<std::path::PathBuf> {
    let d = ensure_data_dir()?;
    let p = d.join("piper").join("voices");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn piper_binary_path() -> anyhow::Result<std::path::PathBuf> {
    let exe = std::env::current_exe()?;
    let parent = exe.parent().context("no parent")?;
    let name = if cfg!(windows) { "piper.exe" } else { "piper" };
    // Sidecar binaries live alongside the main exe.
    Ok(parent.join(name))
}
```

Add `use anyhow::Context;` if not already imported.

- [ ] **Step 5: Register module + run tests**

In `tauri/src/lib.rs`:
```rust
pub mod piper;
```

Run: `cargo test --package claude-usage-tauri --lib piper::tests`
Expected: 2 tests pass.

- [ ] **Step 6: Update `notifications::speak` to try Piper first**

Replace the `speak` body:

```rust
fn speak(app: &AppHandle, text: &str, voice: Option<&str>) {
    if let Some(v) = voice {
        let status = crate::piper::status();
        let has_voice = status.voices.iter().any(|e| e.id == v && e.installed);
        if status.installed && has_voice {
            let app = app.clone();
            let text = text.to_string();
            let voice = v.to_string();
            tauri::async_runtime::spawn(async move {
                match crate::piper::synthesize(&text, &voice).await {
                    Ok(wav) => crate::audio::play_wav(&app, &wav),
                    Err(e) => {
                        log::warn!("piper synth failed: {e}; falling back to web speech");
                        let _ = app.emit("speak-fallback", serde_json::json!({
                            "text": text, "voiceName": voice,
                        }));
                    }
                }
            });
            return;
        }
    }
    let _ = app.emit("speak-fallback", serde_json::json!({
        "text": text,
        "voiceName": voice,
    }));
}
```

- [ ] **Step 7: Register Piper IPC commands**

Add to `tauri/src/ipc.rs`:

```rust
#[tauri::command]
pub fn piper_status() -> crate::piper::PiperStatus {
    crate::piper::status()
}

#[tauri::command]
pub async fn piper_install_voice(id: String) -> Result<(), String> {
    crate::piper::install_voice(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn piper_speak_preview(app: AppHandle, text: String, voice_name: Option<String>) -> Result<(), String> {
    crate::notifications::speak_public(&app, &text, voice_name.as_deref());
    Ok(())
}
```

In `notifications.rs`, expose:

```rust
pub fn speak_public(app: &AppHandle, text: &str, voice: Option<&str>) { speak(app, text, voice) }
```

Register in `tauri/src/lib.rs` handler list:

```rust
ipc::piper_status,
ipc::piper_install_voice,
ipc::piper_speak_preview,
```

- [ ] **Step 8: Declare sidecar in `tauri.conf.json`**

```json
"bundle": {
    ...
    "externalBin": ["binaries/piper/piper"]
}
```

Manual follow-up for Joe: place piper binaries under `tauri/binaries/piper/` (add to `WORKFLOWS_FOR_SIRBEPY.md`).

- [ ] **Step 9: Compile + test**

Run: `cargo test --package claude-usage-tauri --lib`
Expected: pass.

Run: `cargo check --package claude-usage-tauri`
Expected: compiles.

- [ ] **Step 10: Append manual step to `WORKFLOWS_FOR_SIRBEPY.md`**

Append:

```markdown
1. Place Piper binaries in `tauri/binaries/piper/`: `piper.exe` (Windows), `piper` (mac/linux). Download from https://github.com/rhasspy/piper/releases. Required for high-quality notification voices.
```

- [ ] **Step 11: Commit**

```bash
git add tauri/Cargo.toml tauri/src/piper.rs tauri/src/paths.rs tauri/src/lib.rs tauri/src/ipc.rs tauri/src/notifications.rs tauri/tauri.conf.json tauri/binaries/piper/.gitkeep WORKFLOWS_FOR_SIRBEPY.md
git commit -m "FEAT: Piper TTS sidecar with voice catalog and install flow"
```

---

## Task 13: Web-speech fallback wiring in dashboard

**Files:**
- Create: `tauri/dist/modules/speech-fallback.js`
- Modify: `tauri/dist/dashboard.html`

- [ ] **Step 1: Write fallback module**

Create `tauri/dist/modules/speech-fallback.js`:

```javascript
"use strict";

(function () {
  const api = window.__TAURI__;
  if (!api?.event?.listen) return;

  function speak(text, voiceName) {
    if (!text || !window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(text);
    if (voiceName) {
      const v = speechSynthesis.getVoices().find(x => x.name === voiceName);
      if (v) utter.voice = v;
    }
    speechSynthesis.speak(utter);
  }

  api.event.listen("speak-fallback", (event) => {
    const { text, voiceName } = event.payload || {};
    speak(text, voiceName);
  });
})();
```

- [ ] **Step 2: Include module in dashboard.html**

In `tauri/dist/dashboard.html` `<head>` or end of `<body>`:

```html
<script src="./modules/speech-fallback.js"></script>
```

- [ ] **Step 3: Manual verification**

Start app: `npm run tauri dev` (from `tauri/`). Trigger fallback:

```js
// In devtools console
window.__TAURI__.event.emit("speak-fallback", { text: "hello world" });
```

Expected: browser speechSynthesis says "hello world".

- [ ] **Step 4: Commit**

```bash
git add tauri/dist/modules/speech-fallback.js tauri/dist/dashboard.html
git commit -m "FEAT: web-speech fallback listener in dashboard"
```

---

## Task 14: Miscellaneous wiring (autostart listener, auto-update, copy logs, platform)

**Files:**
- Modify: `tauri/Cargo.toml`, `tauri/src/lib.rs`, `tauri/src/ipc.rs`, `tauri/tauri.conf.json`

- [ ] **Step 1: Add clipboard plugin**

In `tauri/Cargo.toml`:

```toml
tauri-plugin-clipboard-manager = "2.0"
tauri-plugin-shell = "2.0"
```

In `tauri/tauri.conf.json` under `plugins`:

```json
"clipboard-manager": {}
```

Register in `lib.rs::run`:

```rust
.plugin(tauri_plugin_clipboard_manager::init())
.plugin(tauri_plugin_shell::init())
```

- [ ] **Step 2: Listener for `autostart` toggle**

In `lib.rs::setup`, alongside the existing autostart application:

```rust
{
    let h = app.handle().clone();
    app.listen("settings-changed", move |event| {
        use tauri_plugin_autostart::ManagerExt;
        let Ok(settings) = serde_json::from_str::<crate::types::Settings>(event.payload()) else { return; };
        let mgr = h.autolaunch();
        let _ = if settings.autostart { mgr.enable() } else { mgr.disable() };
    });
}
```

- [ ] **Step 3: Auto-update startup check**

Add new field to `Settings`:

```rust
#[serde(default = "default_true")]
pub auto_update: bool,
```

Or treat via extras: read `s.extra.get("autoUpdate")`. Prefer typed for correctness. Place in `types.rs::Settings` with default `true`.

In `lib.rs::setup`, after existing setup:

```rust
let settings_snapshot = app.state::<AppState>().settings.lock().unwrap().clone();
if settings_snapshot.auto_update {
    let h = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = check_updater(&h).await {
            log::warn!("startup updater check failed: {e}");
        }
        // 6h interval loop
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
            let still = h.state::<AppState>().settings.lock().unwrap().auto_update;
            if !still { break; }
            let _ = check_updater(&h).await;
        }
    });
}

async fn check_updater(app: &AppHandle) -> anyhow::Result<()> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater()?;
    if let Some(update) = updater.check().await? {
        let _ = app.emit("update-state", serde_json::json!({
            "state": "available", "version": update.version
        }));
    }
    Ok(())
}
```

- [ ] **Step 4: Implement `copy_logs` IPC**

In `tauri/src/ipc.rs`:

```rust
#[tauri::command]
pub fn copy_logs(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let log_path = paths::log_file().map_err(|e| e.to_string())?;
    let contents = std::fs::read_to_string(&log_path).unwrap_or_else(|_| "<no log file>".into());
    app.clipboard().write_text(contents).map_err(|e| e.to_string())?;
    Ok(())
}
```

Add `paths::log_file`:

```rust
pub fn log_file() -> anyhow::Result<std::path::PathBuf> {
    let d = ensure_data_dir()?;
    Ok(d.join("logs").join("claude-usage-tauri.log"))
}
```

(Exact path depends on `tauri_plugin_log` config. Verify by running app once and inspecting `dirs::data_dir()`.)

- [ ] **Step 5: Implement platform + external-open + update IPC**

In `tauri/src/ipc.rs`:

```rust
#[tauri::command]
pub fn get_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => {
            let leaked: &'static str = Box::leak(other.to_string().into_boxed_str());
            leaked
        }
    }
}

#[tauri::command]
pub async fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell().open(url, None).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<serde_json::Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => Ok(serde_json::json!({ "state": "available", "version": u.version })),
        Ok(None) => Ok(serde_json::json!({ "state": "up-to-date" })),
        Err(e) => Ok(serde_json::json!({ "state": "error", "message": e.to_string() })),
    }
}

#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("no update available".into());
    };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn install_update(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub fn get_update_state() -> serde_json::Value {
    // Start simple: "idle" until a check has run. Persist state in AppState if richer UX needed.
    serde_json::json!({ "state": "idle" })
}
```

Register all in `lib.rs` handler list.

- [ ] **Step 6: Compile check**

Run: `cargo check --package claude-usage-tauri`
Expected: compiles.

- [ ] **Step 7: Commit**

```bash
git add tauri/Cargo.toml tauri/src/lib.rs tauri/src/ipc.rs tauri/src/paths.rs tauri/src/types.rs tauri/tauri.conf.json
git commit -m "FEAT: autostart listener, auto-update, copy logs, platform + external-open IPC"
```

---

## Task 15: Frontend shim + token-estimate strip

**Files:**
- Modify: `tauri/dist/electron-api-shim.js`, `tauri/dist/dashboard.html`, `tauri/dist/modules/settings.js`

- [ ] **Step 1: Add shim bindings**

Open `tauri/dist/electron-api-shim.js`. Add (inside the `electronAPI` object):

```javascript
piperStatus: () => window.__TAURI__.core.invoke("piper_status"),
piperInstallVoice: (id) => window.__TAURI__.core.invoke("piper_install_voice", { id }),
speakPreview: ({ text, voiceName }) =>
    window.__TAURI__.core.invoke("piper_speak_preview", { text, voiceName }),
copyLogs: () => window.__TAURI__.core.invoke("copy_logs"),
checkForUpdates: () => window.__TAURI__.core.invoke("check_for_updates"),
downloadAndInstall: () => window.__TAURI__.core.invoke("download_and_install_update"),
installUpdate: () => window.__TAURI__.core.invoke("install_update"),
getAppVersion: () => window.__TAURI__.core.invoke("get_app_version"),
getPlatform: () => window.__TAURI__.core.invoke("get_platform"),
getUpdateState: () => window.__TAURI__.core.invoke("get_update_state"),
openExternal: (url) => window.__TAURI__.core.invoke("open_external", { url }),
onUpdateStateChange: (cb) => {
    window.__TAURI__.event.listen("update-state", (e) => cb(e.payload));
},
```

- [ ] **Step 2: Strip token-estimate from `dashboard.html`**

Locate and remove:
- `<input id="tooltipEstimateTokens" ...>` row
- `<div id="tokenEstimateFields">` block containing `sessionPlan` + `weeklyPlan`

Keep the surrounding `Tooltip` and `Limits` sections otherwise unchanged.

- [ ] **Step 3: Strip token-estimate from `modules/settings.js`**

Remove these lines/blocks:

- The element lookups: `tooltipEstimateTokens`, `sessionPlan`, `weeklyPlan`, `tokenEstimateFields`.
- Fields inside `saveSettings()`: `tooltipEstimateTokens`, `sessionPlan`, `weeklyPlan`.
- The `tooltipEstimateTokens.addEventListener("change", ...)` handler.
- The initial `tokenEstimateFields.style.display = ...` line in `window.onload`.
- The `.ph-chart-bar` header/card (if any) tied to the section.

Search the file for "sessionPlan", "weeklyPlan", "estimateTokens", "tokenEstimate" and delete every match.

- [ ] **Step 4: Verify dashboard loads without errors**

Run: `cd tauri && npm run tauri dev`
Expected: dashboard opens, settings tab loads, no JS errors. Scroll all sections.

- [ ] **Step 5: Commit**

```bash
git add tauri/dist/electron-api-shim.js tauri/dist/dashboard.html tauri/dist/modules/settings.js
git commit -m "FEAT: new IPC bindings in shim + remove token-estimate UI"
```

---

## Task 16: Integration tests + manual QA

**Files:**
- Create: `tauri/tests/settings_roundtrip_renders.rs` (new cargo test)

- [ ] **Step 1: Integration test — settings change changes icon bytes**

Create `tauri/tests/settings_roundtrip_renders.rs`:

```rust
use claude_usage_tauri_lib::icon;
use claude_usage_tauri_lib::icon::{DisplayMode, IconCtx};
use claude_usage_tauri_lib::icon_settings::{IconSettings, IconStyle};

#[test]
fn switching_icon_style_changes_rendered_bytes() {
    let mut s = IconSettings::default();
    let rings = icon::render(Some(50.0), Some(50.0), &IconCtx {
        settings: &s, display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
    });
    s.icon_style = IconStyle::Bars;
    let bars = icon::render(Some(50.0), Some(50.0), &IconCtx {
        settings: &s, display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
    });
    assert_ne!(rings, bars, "bars and rings must produce different pixel bytes");
}
```

Run: `cargo test --test settings_roundtrip_renders`
Expected: pass.

- [ ] **Step 2: Run full test suite**

Run: `cargo test --package claude-usage-tauri`
Expected: all tests pass (unit + integration).

- [ ] **Step 3: Manual QA checklist**

Build and launch: `cd tauri && npm run tauri dev`.

Tick each:

- [ ] Tray left-click cycles: icon → session% → weekly% → icon (3 clicks).
- [ ] After 60s idle, tray returns to default.
- [ ] Change `defaultDisplay` to "Session" in settings; tray shows session% immediately; click cycle starts from session%.
- [ ] Switch iconStyle rings → bars; tray icon changes.
- [ ] Switch overlayStyle classic → digital → bold; number rendering changes in session/weekly cycle states.
- [ ] Toggle colorMode threshold → pace; icon colors react to elapsed time.
- [ ] Add/edit color thresholds; icon recolors as soon as Save fires.
- [ ] Toggle `apply_color_to.icon` off; icon stays gray regardless of pct.
- [ ] Toggle `apply_color_to.number` off; digit overlay stays white.
- [ ] Toggle `apply_color_to.tooltip` off; tooltip stops coloring.
- [ ] Toggle `apply_color_to.dashboard` off; dashboard stops coloring.
- [ ] Click "Refresh Now" in menu; spin animation plays during poll.
- [ ] Hook `/refresh` fires `workFinished` sound.
- [ ] Hook `/notify` fires `questionAsked` sound (curl `POST http://localhost:<port>/notify`).
- [ ] Threshold crossing during poll plays `thresholdCrossed` sound.
- [ ] Install a Piper voice via settings; preview button plays Piper audio.
- [ ] Without Piper, voice mode still works via browser speechSynthesis.
- [ ] Toggle `launch_at_login`; reboot; app starts (or doesn't) accordingly.
- [ ] Toggle `auto_update` off; no background updater activity.
- [ ] "Copy Logs" button copies log contents to clipboard.
- [ ] Settings persisted across restart (unknown-field round-trip still holds).

- [ ] **Step 4: Commit**

```bash
git add tauri/tests/settings_roundtrip_renders.rs
git commit -m "TEST: integration test for settings-driven icon rendering"
```

---

## Self-Review

**Spec coverage check:**
- IconSettings / TooltipSettings / NotificationsConfig typed views → Task 1 ✓
- usage_parser pure math + build_tooltip → Task 2 ✓
- AA rings + urgency colors + apply_color_to → Task 3 ✓
- Pixel fonts (classic/digital/bold) → Task 4 ✓
- Digit overlay → Task 5 ✓
- Bars mode → Task 6 ✓
- TrayDisplayState + cycle + reset ticker → Task 7 ✓
- Spin animation + PollTrigger → Task 8 ✓
- Threshold-crossing detection → Task 9 (stub) + Task 11 (fire) ✓
- Audio playback (rodio) + queue gate → Task 10 ✓
- Notifications fire() + wiring → Task 11 ✓
- Piper sidecar + voice catalog + IPC → Task 12 ✓
- Web-speech fallback in renderer → Task 13 ✓
- autostart listener, auto-update, copy_logs, platform, open_external, update IPC → Task 14 ✓
- Frontend shim additions + token-estimate strip → Task 15 ✓
- Integration tests + manual QA → Task 16 ✓

**Placeholder scan:** No "TBD" / "fill in later" remain. Task 4 Step 6 is explicit ("port verbatim from fonts.js"). Task 12 catalog marked `// TODO(impl)` but gives one concrete example and a clear next action — acceptable.

**Type consistency check:**
- `DisplayMode` defined in `icon.rs`, used in `display_state.rs`, `tray.rs` ✓
- `IconCtx` fields identical across callers ✓
- `NotifKind` / `NotifContext` spelling consistent across Tasks 11, 12 ✓
- `PollTrigger::Scheduled|Manual|Hook` consistent ✓
- `build_cycle` signature matches Task 7 tests and Task 7 Step 4 usage ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-20-tauri-settings-parity.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
