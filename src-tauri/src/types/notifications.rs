use serde::{Deserialize, Serialize};
use super::project::{ProjectConfig, ProjectsSortBy};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
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
