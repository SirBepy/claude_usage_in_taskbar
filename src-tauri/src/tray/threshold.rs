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
pub enum IconStyle { Rings, Bars, FourBars }
impl Default for IconStyle { fn default() -> Self { Self::Rings } }

/// Multi-account milestone 06: what the tray icon face shows. Evolves the
/// legacy `defaultDisplay` (icon/session/weekly) into a 3-way content
/// selector plus a chosen account (see `IconSettings.tray_account_id`).
/// `Glyph` = the existing rings/bars render; `Number` = a single % badge for
/// `tray_number_window`; `Nothing` = a plain neutral icon face (no data).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrayContentMode { Glyph, Number, Nothing }
impl Default for TrayContentMode { fn default() -> Self { Self::Glyph } }

/// Which usage window `TrayContentMode::Number` renders. Default 5h per
/// `docs/multi-account/00-overview.md`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrayNumberWindow { FiveHour, SevenDay }
impl Default for TrayNumberWindow { fn default() -> Self { Self::FiveHour } }

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SafePaceColorMode {
    Default,           // soft blue (#6496dc)
    Urgency,           // same as the actual urgency bar
    Fixed([u8; 3]),    // user-picked hex
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ColorMode { Threshold, Pace }
impl Default for ColorMode { fn default() -> Self { Self::Pace } }

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TooltipLayout { Rows, Columns }
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
    /// Multi-account milestone 07: colours the floating overlay window's
    /// usage numbers (`src/views/overlay/overlay.ts`, `valueColor(..,
    /// "overlay")`). The overlay itself is TS-rendered, so this field isn't
    /// consumed by any Rust render path today - it exists so the Rust and
    /// `formatters.ts` twins stay in lockstep (same convention as
    /// `dashboard`, which is also TS-only).
    pub overlay: bool,
}
impl Default for ColorApplyTo {
    fn default() -> Self {
        Self { icon: true, number: true, dashboard: true, tooltip: true, overlay: true }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct IconSettings {
    pub default_display: DefaultDisplay,
    pub icon_style: IconStyle,
    pub color_mode: ColorMode,
    pub color_thresholds: Vec<ColorStop>,
    pub pace_band: f32,
    pub pace_colors: PaceColors,
    pub apply_color_to: ColorApplyTo,
    pub safe_sess_color: SafePaceColorMode,
    pub safe_weekly_color: SafePaceColorMode,
    /// Multi-account milestone 06 tray content settings (see
    /// `TrayContentMode` doc comment). `tray_account_id` resolves to
    /// `Settings.default_account_id` when `trayAccountId` isn't set in
    /// `extra`, matching the locked "default = default account" decision.
    pub tray_content_mode: TrayContentMode,
    pub tray_account_id: Option<String>,
    pub tray_number_window: TrayNumberWindow,
}

impl Default for IconSettings {
    fn default() -> Self {
        Self {
            default_display: DefaultDisplay::default(),
            icon_style: IconStyle::default(),
            color_mode: ColorMode::default(),
            color_thresholds: vec![
                ColorStop { min: 0,  color: "#27ae60".into() },
                ColorStop { min: 50, color: "#e67e22".into() },
                ColorStop { min: 80, color: "#e74c3c".into() },
            ],
            pace_band: 10.0,
            pace_colors: PaceColors::default(),
            apply_color_to: ColorApplyTo::default(),
            safe_sess_color: SafePaceColorMode::Default,
            safe_weekly_color: SafePaceColorMode::Default,
            tray_content_mode: TrayContentMode::default(),
            tray_account_id: None,
            tray_number_window: TrayNumberWindow::default(),
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
    pub sound_pack: String,
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

// -- TryFrom impls ------------------------------------------------------------

fn val_str(v: Option<&Value>) -> Option<&str> { v.and_then(|x| x.as_str()) }
fn val_f64(v: Option<&Value>) -> Option<f64>  { v.and_then(|x| x.as_f64()) }
fn val_bool(v: Option<&Value>) -> Option<bool> { v.and_then(|x| x.as_bool()) }

fn parse_enum<T: Default>(raw: Option<&Value>, map: &[(&str, T)]) -> T where T: Copy {
    let Some(key) = val_str(raw) else { return T::default(); };
    for (k, v) in map { if *k == key { return *v; } }
    T::default()
}

fn parse_safe_color(raw: Option<&Value>) -> SafePaceColorMode {
    match val_str(raw) {
        None | Some("") => SafePaceColorMode::Default,
        Some("auto") => SafePaceColorMode::Urgency,
        Some(hex) => {
            let h = hex.trim_start_matches('#');
            if h.len() == 6 {
                if let (Ok(r), Ok(g), Ok(b)) = (
                    u8::from_str_radix(&h[0..2], 16),
                    u8::from_str_radix(&h[2..4], 16),
                    u8::from_str_radix(&h[4..6], 16),
                ) { return SafePaceColorMode::Fixed([r, g, b]); }
            }
            SafePaceColorMode::Default
        }
    }
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
        if let Some(v) = m.get("overlay").and_then(|v| v.as_bool())   { a.overlay = v; }
    }
    a
}

/// Migrates the legacy `defaultDisplay` (icon/session/weekly) forward into
/// the new `(TrayContentMode, TrayNumberWindow)` pair, for settings.json
/// files written before this milestone and users who haven't touched the
/// (not-yet-built, milestone 07) tray-content-mode UI. Icon stays a glyph;
/// Session/Weekly become a number badge on the matching window. Without
/// this, every existing user who'd set defaultDisplay to Session/Weekly
/// would silently revert to seeing rings on their next launch — the whole
/// point of "evolve defaultDisplay into ..." (docs/multi-account/06) is that
/// it carries the old choice forward, not that it's replaced by a new
/// default nobody asked for.
fn migrate_default_display(default_display: DefaultDisplay) -> (TrayContentMode, TrayNumberWindow) {
    match default_display {
        DefaultDisplay::Icon => (TrayContentMode::Glyph, TrayNumberWindow::FiveHour),
        DefaultDisplay::Session => (TrayContentMode::Number, TrayNumberWindow::FiveHour),
        DefaultDisplay::Weekly => (TrayContentMode::Number, TrayNumberWindow::SevenDay),
    }
}

impl TryFrom<&Settings> for IconSettings {
    type Error = std::convert::Infallible;
    fn try_from(s: &Settings) -> Result<Self, Self::Error> {
        let e = &s.extra;
        let default_display = parse_enum(e.get("defaultDisplay"), &[
            ("icon", DefaultDisplay::Icon),
            ("session", DefaultDisplay::Session),
            ("weekly", DefaultDisplay::Weekly),
        ]);
        let (migrated_mode, migrated_window) = migrate_default_display(default_display);
        Ok(IconSettings {
            default_display,
            icon_style: parse_enum(e.get("iconStyle"), &[
                ("rings", IconStyle::Rings),
                ("bars", IconStyle::Bars),
                ("fourbars", IconStyle::FourBars),
            ]),
            color_mode: parse_enum(e.get("colorMode"), &[
                ("threshold", ColorMode::Threshold),
                ("pace", ColorMode::Pace),
            ]),
            color_thresholds: parse_color_stops(e.get("colorThresholds")),
            pace_band: val_f64(e.get("paceBand")).unwrap_or(10.0) as f32,
            pace_colors: parse_pace_colors(e.get("paceColors")),
            apply_color_to: parse_apply_to(e.get("colorApplyTo")),
            safe_sess_color: parse_safe_color(e.get("fourBarsSessionSafeColor")),
            safe_weekly_color: parse_safe_color(e.get("fourBarsWeeklySafeColor")),
            tray_content_mode: match e.get("trayContentMode") {
                Some(_) => parse_enum(e.get("trayContentMode"), &[
                    ("glyph", TrayContentMode::Glyph),
                    ("number", TrayContentMode::Number),
                    ("nothing", TrayContentMode::Nothing),
                ]),
                None => migrated_mode,
            },
            tray_account_id: val_str(e.get("trayAccountId"))
                .map(String::from)
                .or_else(|| s.default_account_id.clone()),
            tray_number_window: match e.get("trayNumberWindow") {
                Some(_) => parse_enum(e.get("trayNumberWindow"), &[
                    ("5h", TrayNumberWindow::FiveHour),
                    ("7d", TrayNumberWindow::SevenDay),
                ]),
                None => migrated_window,
            },
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
                ("columns", TooltipLayout::Columns),
            ]),
            time_style: parse_enum(e.get("timeStyle"), &[
                ("absolute", TimeStyle::Absolute),
                ("relative", TimeStyle::Relative),
            ]),
            show_safe_pace: val_bool(e.get("tooltipShowSafePace")).unwrap_or(true),
            apply_color: parse_apply_to(e.get("colorApplyTo")).tooltip,
        })
    }
}

pub fn rule_from_public(m: &serde_json::Map<String, Value>, defaults: NotificationRule) -> NotificationRule {
    rule_from(m, defaults)
}

fn rule_from(m: &serde_json::Map<String, Value>, defaults: NotificationRule) -> NotificationRule {
    NotificationRule {
        enabled: val_bool(m.get("enabled")).unwrap_or(defaults.enabled),
        mode: parse_enum(m.get("mode"), &[
            ("sound", NotifMode::Sound),
            ("voice", NotifMode::Voice),
        ]),
        sound_pack: val_str(m.get("soundPack"))
            .map(String::from)
            .unwrap_or_else(|| "default".into()),
        sound_file: val_str(m.get("soundFile")).map(String::from).unwrap_or(defaults.sound_file),
        voice_name: val_str(m.get("voiceName")).map(String::from),
        template: val_str(m.get("template")).map(String::from).unwrap_or(defaults.template),
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
        assert_eq!(icon.color_mode, ColorMode::Pace);
        assert!(icon.apply_color_to.icon);
        assert!(icon.apply_color_to.number);
        assert!(icon.apply_color_to.tooltip);
        assert!(icon.apply_color_to.dashboard);
        assert!(icon.apply_color_to.overlay);
    }

    #[test]
    fn icon_settings_parses_dashboard_dropdown_values() {
        let s = settings_with(json!({
            "defaultDisplay": "session",
            "iconStyle": "bars",
            "colorMode": "pace",
            "paceBand": 15,
            "paceColors": {"under": "#11ff00", "nearSafe": "#ffff00",
                           "nearOver": "#ff9900", "over": "#ff0000"},
            "colorApplyTo": {"icon": false, "number": true, "tooltip": false, "dashboard": true, "overlay": false},
            "colorThresholds": [
                {"min": 0, "color": "#27ae60"},
                {"min": 80, "color": "#e74c3c"},
                {"min": 50, "color": "#e67e22"}
            ]
        }));
        let icon = IconSettings::try_from(&s).unwrap();
        assert_eq!(icon.default_display, DefaultDisplay::Session);
        assert_eq!(icon.icon_style, IconStyle::Bars);
        assert_eq!(icon.color_mode, ColorMode::Pace);
        assert_eq!(icon.pace_band, 15.0);
        assert_eq!(icon.pace_colors.under, "#11ff00");
        assert!(!icon.apply_color_to.icon);
        assert!(icon.apply_color_to.number);
        assert!(!icon.apply_color_to.overlay);
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
        assert_eq!(icon.color_thresholds, IconSettings::default().color_thresholds);
    }

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
    fn icon_settings_tray_content_defaults_to_glyph_and_default_account() {
        let mut s = Settings::default();
        s.default_account_id = Some("acct-work".into());
        let icon = IconSettings::try_from(&s).unwrap();
        assert_eq!(icon.tray_content_mode, TrayContentMode::Glyph);
        assert_eq!(icon.tray_number_window, TrayNumberWindow::FiveHour);
        assert_eq!(icon.tray_account_id.as_deref(), Some("acct-work"));
    }

    #[test]
    fn icon_settings_tray_content_migrates_from_legacy_default_display() {
        let session = settings_with(json!({ "defaultDisplay": "session" }));
        let icon = IconSettings::try_from(&session).unwrap();
        assert_eq!(icon.tray_content_mode, TrayContentMode::Number);
        assert_eq!(icon.tray_number_window, TrayNumberWindow::FiveHour);

        let weekly = settings_with(json!({ "defaultDisplay": "weekly" }));
        let icon = IconSettings::try_from(&weekly).unwrap();
        assert_eq!(icon.tray_content_mode, TrayContentMode::Number);
        assert_eq!(icon.tray_number_window, TrayNumberWindow::SevenDay);
    }

    #[test]
    fn icon_settings_tray_content_explicit_overrides_default_account() {
        let mut s = settings_with(json!({
            "trayContentMode": "number",
            "trayAccountId": "acct-personal",
            "trayNumberWindow": "7d",
        }));
        s.default_account_id = Some("acct-work".into());
        let icon = IconSettings::try_from(&s).unwrap();
        assert_eq!(icon.tray_content_mode, TrayContentMode::Number);
        assert_eq!(icon.tray_number_window, TrayNumberWindow::SevenDay);
        assert_eq!(icon.tray_account_id.as_deref(), Some("acct-personal"));
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
}
