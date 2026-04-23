use serde::{Deserialize, Serialize};
use super::automation::{AutomationConfig, InstanceKind, EndReason};

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
