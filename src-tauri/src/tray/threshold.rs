//! Typed views over `Settings.extra` for icon color/notifications.
//! `TryFrom<&Settings>` never fails — malformed fields fall back to defaults.

use crate::types::Settings;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NotifMode { Sound, Voice }
impl Default for NotifMode { fn default() -> Self { Self::Sound } }

#[derive(Clone, Debug, PartialEq)]
pub struct ColorStop { pub min: u32, pub color: String }

#[derive(Clone, Debug, PartialEq)]
pub struct IconSettings {
    pub color_thresholds: Vec<ColorStop>,
}

impl Default for IconSettings {
    fn default() -> Self {
        Self {
            color_thresholds: vec![
                ColorStop { min: 0,  color: "#27ae60".into() },
                ColorStop { min: 50, color: "#e67e22".into() },
                ColorStop { min: 80, color: "#e74c3c".into() },
            ],
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
fn val_bool(v: Option<&Value>) -> Option<bool> { v.and_then(|x| x.as_bool()) }

fn parse_enum<T: Default>(raw: Option<&Value>, map: &[(&str, T)]) -> T where T: Copy {
    let Some(key) = val_str(raw) else { return T::default(); };
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

impl TryFrom<&Settings> for IconSettings {
    type Error = std::convert::Infallible;
    fn try_from(s: &Settings) -> Result<Self, Self::Error> {
        let e = &s.extra;
        Ok(IconSettings {
            color_thresholds: parse_color_stops(e.get("colorThresholds")),
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
        assert_eq!(icon.color_thresholds, IconSettings::default().color_thresholds);
    }

    #[test]
    fn icon_settings_parses_and_sorts_color_thresholds() {
        let s = settings_with(json!({
            "colorThresholds": [
                {"min": 0, "color": "#27ae60"},
                {"min": 80, "color": "#e74c3c"},
                {"min": 50, "color": "#e67e22"}
            ]
        }));
        let icon = IconSettings::try_from(&s).unwrap();
        // thresholds sorted asc by min
        let mins: Vec<u32> = icon.color_thresholds.iter().map(|t| t.min).collect();
        assert_eq!(mins, vec![0, 50, 80]);
    }

    #[test]
    fn icon_settings_malformed_extra_falls_back_to_defaults() {
        let s = settings_with(json!({
            "colorThresholds": "not an array"
        }));
        let icon = IconSettings::try_from(&s).unwrap();
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
