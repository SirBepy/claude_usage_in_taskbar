use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct AutomationConfig {
    pub enabled: bool,
    pub autostart_on_boot: bool,
    pub session_name_prefix: Option<String>,
    pub continue_flag: bool,
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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
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
