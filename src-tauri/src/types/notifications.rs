use serde::{Deserialize, Serialize};
use super::project::{ProjectConfig, ProjectsSortBy};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum DisplayMode {
    Rings,
    Bars,
    Digits,
}

/// How the app reacts to new releases.
///
/// Custom `Deserialize` accepts the new string form
/// (`"never" | "onStartup" | "immediate"`) and the legacy bool form
/// (`true` → Immediate, `false` → Never) so settings written by older builds
/// still load. Done as a manual impl instead of `deserialize_with` so ts-rs
/// can parse the surrounding serde attributes without warnings.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum AutoUpdateMode {
    Never,
    OnStartup,
    Immediate,
}

impl Default for AutoUpdateMode {
    fn default() -> Self { Self::Immediate }
}

impl<'de> Deserialize<'de> for AutoUpdateMode {
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where D: serde::Deserializer<'de>,
    {
        use serde::de::Error;
        let v = serde_json::Value::deserialize(d)?;
        match v {
            serde_json::Value::Bool(true) => Ok(AutoUpdateMode::Immediate),
            serde_json::Value::Bool(false) => Ok(AutoUpdateMode::Never),
            serde_json::Value::String(s) => match s.as_str() {
                "never" => Ok(AutoUpdateMode::Never),
                "onStartup" => Ok(AutoUpdateMode::OnStartup),
                "immediate" => Ok(AutoUpdateMode::Immediate),
                other => Err(D::Error::custom(format!("unknown autoUpdate value: {other}"))),
            },
            serde_json::Value::Null => Ok(AutoUpdateMode::default()),
            _ => Err(D::Error::custom("autoUpdate must be bool or string")),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AudioOutputDevice {
    pub name: String,
    pub is_default: bool,
}

/// User-configurable app settings.
///
/// The dashboard owns a LOT of UI state (theme, project aliases + blacklist,
/// color thresholds, notification config, ...) that the Rust side has no
/// reason to inspect. `extra` catches every field the dashboard sends that
/// isn't named below, so a save→load round-trip preserves them verbatim.
/// Without this, each `saveSettings` would silently drop ~25 fields.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[serde(default)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct Settings {
    pub poll_interval_secs: u64,
    pub display_mode: DisplayMode,
    pub threshold_warn: f64,
    pub threshold_crit: f64,
    pub autostart: bool,
    #[serde(rename = "autoUpdate")]
    pub auto_update: AutoUpdateMode,
    pub hook_port: Option<u16>,
    pub projects: Vec<ProjectConfig>,
    pub projects_sort_by: ProjectsSortBy,
    pub hooks_registered: bool,
    pub hook_registration_declined: bool,
    /// Bumped whenever the shape of the hook entry we write into
    /// `~/.claude/settings.json` changes. On startup, if `hooks_registered`
    /// is true but this is behind `hook_installer::CURRENT_INSTALL_VERSION`,
    /// we re-run `install()` to heal existing users in place.
    pub hook_install_version: u32,
    pub legacy_obsidian_import_handled: bool,
    #[serde(rename = "audioOutputDevice", default)]
    pub audio_output_device: Option<String>,
    /// Everything the dashboard persists that Rust doesn't need to read —
    /// project aliases, blacklist, colour thresholds, themes, etc. Stored
    /// verbatim so renames / hides / theme changes actually stick.
    #[serde(flatten, default)]
    #[ts(skip)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            poll_interval_secs: 600,
            display_mode: DisplayMode::Rings,
            threshold_warn: 50.0,
            threshold_crit: 80.0,
            autostart: true,
            auto_update: AutoUpdateMode::default(),
            hook_port: None,
            projects: Vec::new(),
            projects_sort_by: ProjectsSortBy::Recent,
            hooks_registered: false,
            hook_registration_declined: false,
            hook_install_version: 0,
            legacy_obsidian_import_handled: false,
            audio_output_device: None,
            extra: serde_json::Map::new(),
        }
    }
}

impl Settings {
    pub fn mute_all(&self) -> bool { self.bool_extra("muteAll") }
    pub fn mute_sounds(&self) -> bool { self.bool_extra("muteSounds") }
    pub fn mute_system_notifications(&self) -> bool { self.bool_extra("muteSystemNotifications") }

    fn bool_extra(&self, key: &str) -> bool {
        self.extra.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::project::ProjectsSortBy;

    #[test]
    fn settings_defaults_roundtrip_json() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn settings_round_trip_preserves_extra_fields_from_dashboard() {
        let raw = r#"{
            "poll_interval_secs": 600,
            "display_mode": "rings",
            "threshold_warn": 50.0,
            "threshold_crit": 80.0,
            "autostart": true,
            "theme": "void",
            "projectAliases": { "C:/a": { "name": "Alpha" } },
            "projectBlacklist": ["C:/dead"],
            "notifications": { "workFinished": { "enabled": true } }
        }"#;
        let parsed: Settings = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_value(&parsed).unwrap();

        assert_eq!(out["theme"], "void");
        assert_eq!(out["projectAliases"]["C:/a"]["name"], "Alpha");
        assert_eq!(out["projectBlacklist"][0], "C:/dead");
        assert_eq!(out["notifications"]["workFinished"]["enabled"], true);
    }

    #[test]
    fn settings_from_dashboard_payload_without_snake_case_fields() {
        let raw = r#"{
            "theme": "void",
            "defaultDisplay": "session",
            "iconStyle": "bars",
            "colorMode": "pace",
            "launchAtLogin": true,
            "autoUpdate": true,
            "colorThresholds": [],
            "notifications": {}
        }"#;
        let parsed: Settings = serde_json::from_str(raw).expect("must not fail");
        assert_eq!(parsed.extra["iconStyle"], "bars");
        assert_eq!(parsed.extra["defaultDisplay"], "session");
        assert_eq!(parsed.poll_interval_secs, 600);
        assert!(parsed.autostart);
        assert_eq!(parsed.auto_update, AutoUpdateMode::Immediate);
    }

    #[test]
    fn auto_update_legacy_bool_true_maps_to_immediate() {
        let raw = r#"{ "autoUpdate": true }"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.auto_update, AutoUpdateMode::Immediate);
    }

    #[test]
    fn auto_update_legacy_bool_false_maps_to_never() {
        let raw = r#"{ "autoUpdate": false }"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.auto_update, AutoUpdateMode::Never);
    }

    #[test]
    fn auto_update_string_variants_parse() {
        let s: Settings = serde_json::from_str(r#"{ "autoUpdate": "never" }"#).unwrap();
        assert_eq!(s.auto_update, AutoUpdateMode::Never);
        let s: Settings = serde_json::from_str(r#"{ "autoUpdate": "onStartup" }"#).unwrap();
        assert_eq!(s.auto_update, AutoUpdateMode::OnStartup);
        let s: Settings = serde_json::from_str(r#"{ "autoUpdate": "immediate" }"#).unwrap();
        assert_eq!(s.auto_update, AutoUpdateMode::Immediate);
    }

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

    #[test]
    fn settings_defaults_expose_new_fields() {
        let s = Settings::default();
        assert!(s.projects.is_empty());
        assert_eq!(s.projects_sort_by, ProjectsSortBy::Recent);
        assert!(!s.hooks_registered);
        assert!(!s.hook_registration_declined);
        assert_eq!(s.hook_install_version, 0);
    }

    #[test]
    fn audio_output_device_field_roundtrips() {
        let raw = r#"{ "audioOutputDevice": "Speakers (Realtek Audio)" }"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert_eq!(s.audio_output_device.as_deref(), Some("Speakers (Realtek Audio)"));
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.audio_output_device.as_deref(), Some("Speakers (Realtek Audio)"));
    }

    #[test]
    fn audio_output_device_defaults_to_none() {
        let s = Settings::default();
        assert_eq!(s.audio_output_device, None);
        let parsed: Settings = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(parsed.audio_output_device, None);
    }

    #[test]
    fn legacy_use_daemon_key_lands_in_extra_and_does_not_break_deserialize() {
        // Phase 7 removed the `useDaemon` typed field. Existing settings.json
        // files still carry the key; it must fall through to `extra` (the
        // flattened passthrough) and not break deserialization.
        let v = serde_json::json!({
            "useDaemon": true,
            "autostart": true,
            "muteAll": false,
        });
        let s: Settings = serde_json::from_value(v).expect("must deserialize with legacy useDaemon key");
        assert_eq!(s.extra.get("useDaemon"), Some(&serde_json::json!(true)));
    }
}
