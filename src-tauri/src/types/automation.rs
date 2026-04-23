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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn channel_status_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&ChannelStatus::Running).unwrap(),
            "\"running\""
        );
    }
}
