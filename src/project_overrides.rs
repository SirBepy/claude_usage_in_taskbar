//! Typed view over `Settings.extra["projectNotifOverrides"]`.
//!
//! Shape (keyed by normalised cwd):
//! {
//!   "<cwdKey>": {
//!     "workFinished":     { enabled, mode, soundPack, soundFile, voiceName, template },
//!     "questionAsked":    { ... },
//!     "thresholdCrossed": { ... }
//!   }
//! }
//!
//! The individual rule parser is shared with `icon_settings::rule_from`, but
//! override rules differ in one way: their `enabled` field means "this
//! override is active", not "the notification itself fires". When `enabled`
//! is false, we treat the whole rule as absent (inherit default).

use crate::icon_settings::NotificationRule;
use crate::types::Settings;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectOverrides {
    pub work_finished:     Option<NotificationRule>,
    pub question_asked:    Option<NotificationRule>,
    pub threshold_crossed: Option<NotificationRule>,
}

fn parse_rule(v: &Value, defaults: NotificationRule) -> Option<NotificationRule> {
    let m = v.as_object()?;
    let enabled = m.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false);
    if !enabled { return None; }
    let rule = crate::icon_settings::rule_from_public(m, defaults);
    Some(rule)
}

pub fn parse(s: &Settings) -> HashMap<String, ProjectOverrides> {
    let defaults = crate::icon_settings::NotificationsConfig::default();
    let Some(obj) = s.extra.get("projectNotifOverrides").and_then(|v| v.as_object()) else {
        return HashMap::new();
    };
    obj.iter().filter_map(|(key, val)| {
        let m = val.as_object()?;
        Some((key.clone(), ProjectOverrides {
            work_finished:     m.get("workFinished")
                .and_then(|v| parse_rule(v, defaults.work_finished.clone())),
            question_asked:    m.get("questionAsked")
                .and_then(|v| parse_rule(v, defaults.question_asked.clone())),
            threshold_crossed: m.get("thresholdCrossed")
                .and_then(|v| parse_rule(v, defaults.threshold_crossed.clone())),
        }))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings_with(extra: serde_json::Value) -> Settings {
        let mut s = Settings::default();
        s.extra = extra.as_object().unwrap().clone();
        s
    }

    #[test]
    fn absent_field_returns_empty_map() {
        let s = Settings::default();
        assert!(parse(&s).is_empty());
    }

    #[test]
    fn override_with_enabled_false_is_ignored() {
        let s = settings_with(json!({
            "projectNotifOverrides": {
                "C:/proj": {
                    "workFinished": { "enabled": false, "mode": "sound", "soundPack": "peon", "soundFile": "x.mp3" }
                }
            }
        }));
        let map = parse(&s);
        assert!(map.get("C:/proj").unwrap().work_finished.is_none());
    }

    #[test]
    fn override_with_enabled_true_parses_pack_and_file() {
        let s = settings_with(json!({
            "projectNotifOverrides": {
                "C:/proj": {
                    "thresholdCrossed": {
                        "enabled": true, "mode": "sound",
                        "soundPack": "peon", "soundFile": "work-work.mp3"
                    }
                }
            }
        }));
        let map = parse(&s);
        let rule = map.get("C:/proj").unwrap().threshold_crossed.as_ref().unwrap();
        assert_eq!(rule.sound_pack, "peon");
        assert_eq!(rule.sound_file, "work-work.mp3");
    }
}
