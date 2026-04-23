use serde::{Deserialize, Serialize};

/// A single usage poll result, captured at a point in time.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct UsageSnapshot {
    pub captured_at: String,           // RFC3339 / ISO8601
    pub five_hour: WindowUsage,
    pub seven_day: WindowUsage,
    #[serde(default)]
    pub extra_usage: Option<ExtraUsage>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WindowUsage {
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ExtraUsage {
    pub is_enabled: bool,
    pub monthly_limit: f64,
    pub used_credits: f64,
    pub utilization: f64,
    pub currency: String,
}

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
pub enum ProjectsSortBy {
    Recent,
    Live,
    Name,
    Tokens,
}

impl Default for ProjectsSortBy {
    fn default() -> Self { ProjectsSortBy::Recent }
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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstanceKind {
    Automated,
    External,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EndReason {
    HookSessionEnd,
    ProcessGone,
    ChildExit,
    Manual,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Instance {
    pub session_id: String,
    pub pid: u32,
    pub cwd: std::path::PathBuf,
    pub project_id: String,
    pub kind: InstanceKind,
    #[serde(default)]
    pub is_remote: bool,
    pub started_at: String,
    #[serde(default)]
    pub transcript_path: Option<std::path::PathBuf>,
    #[serde(default)]
    pub bridge_session_id: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub end_reason: Option<EndReason>,
}

/// Shape served to the webview. Same as `Instance` for now; kept as a
/// distinct type so future payload tweaks don't require a registry-wide
/// schema change.
pub type InstanceSummary = Instance;

/// User-configurable app settings.
///
/// The dashboard owns a LOT of UI state (theme, project aliases + blacklist,
/// color thresholds, notification config, ...) that the Rust side has no
/// reason to inspect. `extra` catches every field the dashboard sends that
/// isn't named below, so a save→load round-trip preserves them verbatim.
/// Without this, each `saveSettings` would silently drop ~25 fields.
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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DisplayMode {
    Rings,
    Bars,
    Digits,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthState {
    LoggedIn,
    NeedsLogin,
    InProgress,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChannelStatus {
    /// Starting but no child or hwnd yet.
    Starting,
    /// Running with a live child.
    Running,
    /// Exited recently; restart policy may re-spawn.
    Stopped,
    /// Crashed and backoff has exhausted; no automatic restart.
    Crashed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_defaults_roundtrip_json() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn settings_round_trip_preserves_extra_fields_from_dashboard() {
        // The dashboard sends every UI-owned field (theme, projectAliases,
        // projectBlacklist, notifications, ...) via saveSettings(). Before
        // the `extra` catch-all, these got silently dropped. Regression
        // guard: after deserialise → serialise, every unknown field we
        // sent in must still be there.
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
        // The dashboard sends ONLY camelCase keys; it doesn't know about
        // poll_interval_secs, display_mode, threshold_warn, threshold_crit,
        // autostart, auto_update, hook_port. Before #[serde(default)] on the
        // struct, missing keys caused deserialization to fail silently in
        // save_settings, and changing dropdowns did nothing.
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
        // Missing snake_case fields took their defaults:
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
    fn usage_snapshot_parses_real_api_shape() {
        // Shape verified against real API response (see .direct-api-test-output.json).
        let raw = r#"{
            "captured_at": "2026-04-19T10:00:00Z",
            "five_hour": { "utilization": 7.0, "resets_at": "2026-04-19T15:00:00Z" },
            "seven_day": { "utilization": 4.0, "resets_at": "2026-04-23T23:00:00Z" },
            "extra_usage": {
                "is_enabled": true, "monthly_limit": 8500,
                "used_credits": 329, "utilization": 3.87, "currency": "EUR"
            }
        }"#;
        let parsed: UsageSnapshot = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.five_hour.utilization, 7.0);
        assert_eq!(parsed.extra_usage.as_ref().unwrap().monthly_limit, 8500.0);
    }

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
        assert_eq!(s.projects_sort_by, ProjectsSortBy::Recent);
        assert!(!s.hooks_registered);
        assert!(!s.hook_registration_declined);
        assert_eq!(s.hook_install_version, 0);
    }

    #[test]
    fn avatar_serializes_as_tagged_enum() {
        let a = Avatar::Emoji("🦊".into());
        let raw = serde_json::to_string(&a).unwrap();
        assert_eq!(raw, r#"{"kind":"emoji","value":"🦊"}"#);
        let back: Avatar = serde_json::from_str(&raw).unwrap();
        assert_eq!(a, back);
    }

    #[test]
    fn instance_kind_serializes_lowercase() {
        let a = InstanceKind::Automated;
        let e = InstanceKind::External;
        assert_eq!(serde_json::to_string(&a).unwrap(), "\"automated\"");
        assert_eq!(serde_json::to_string(&e).unwrap(), "\"external\"");
    }

    #[test]
    fn end_reason_serializes_kebab_case() {
        let cases: Vec<(EndReason, &str)> = vec![
            (EndReason::HookSessionEnd, "\"hook-session-end\""),
            (EndReason::ProcessGone, "\"process-gone\""),
            (EndReason::ChildExit, "\"child-exit\""),
            (EndReason::Manual, "\"manual\""),
        ];
        for (r, expected) in cases {
            assert_eq!(serde_json::to_string(&r).unwrap(), expected);
        }
    }

    #[test]
    fn instance_roundtrips_json() {
        let i = Instance {
            session_id: "s1".into(),
            pid: 1234,
            cwd: std::path::PathBuf::from("C:/x"),
            project_id: "proj-a".into(),
            kind: InstanceKind::External,
            is_remote: false,
            started_at: "2026-04-21T10:00:00Z".into(),
            transcript_path: Some(std::path::PathBuf::from("C:/t/abc.jsonl")),
            bridge_session_id: None,
            ended_at: None,
            end_reason: None,
        };
        let raw = serde_json::to_string(&i).unwrap();
        let back: Instance = serde_json::from_str(&raw).unwrap();
        assert_eq!(i, back);
    }

    #[test]
    fn channel_status_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&ChannelStatus::Running).unwrap(),
            "\"running\""
        );
    }
}
