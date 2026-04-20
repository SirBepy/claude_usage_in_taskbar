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

// -- TryFrom impls ------------------------------------------------------------

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
