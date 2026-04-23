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
    pub auto_update: bool,
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
            auto_update: true,
            hook_port: None,
            projects: Vec::new(),
            projects_sort_by: ProjectsSortBy::Recent,
            hooks_registered: false,
            hook_registration_declined: false,
            hook_install_version: 0,
            legacy_obsidian_import_handled: false,
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
        assert!(parsed.auto_update);
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
}
