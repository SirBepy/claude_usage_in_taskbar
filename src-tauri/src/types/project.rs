use serde::{Deserialize, Serialize};
use super::automation::{AutomationConfig, EndReason};
use crate::sessions::kinds::InstanceKind;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum Avatar {
    None,
    Emoji(String),
    Image(std::path::PathBuf),
    Character(String),
}

impl Default for Avatar {
    fn default() -> Self { Avatar::None }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum ProjectsSortBy {
    Recent,
    Live,
    Name,
    Tokens,
}

impl Default for ProjectsSortBy {
    fn default() -> Self { ProjectsSortBy::Recent }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
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
    /// Short label derived from the transcript's first user prompt
    /// (truncated). Mirrors what `/resume` shows so the user can tell
    /// concurrent sessions apart at a glance. None until the prompt
    /// is resolved (sessions start before the user types anything).
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub end_reason: Option<EndReason>,
}

/// Shape served to the webview. Same as `Instance` for now; kept as a
/// distinct type so future payload tweaks don't require a registry-wide
/// schema change.
pub type InstanceSummary = Instance;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ProjectGroup {
    pub id: Option<String>,
    pub path: String,
    pub name: String,
    pub parent_segment: Option<String>,
    pub avatar: Avatar,
    pub automation_enabled: bool,
    pub tokens_7d: u64,
    pub live: u32,
    pub any_remote: bool,
    pub any_automated: bool,
    pub last_active_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn avatar_serializes_as_tagged_enum() {
        let a = Avatar::Emoji("🦊".into());
        let raw = serde_json::to_string(&a).unwrap();
        assert_eq!(raw, r#"{"kind":"emoji","value":"🦊"}"#);
        let back: Avatar = serde_json::from_str(&raw).unwrap();
        assert_eq!(a, back);
    }

    #[test]
    fn avatar_character_serializes_as_tagged_enum() {
        let a = Avatar::Character("peon".into());
        let raw = serde_json::to_string(&a).unwrap();
        assert_eq!(raw, r#"{"kind":"character","value":"peon"}"#);
        let back: Avatar = serde_json::from_str(&raw).unwrap();
        assert_eq!(a, back);
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
            name: None,
            ended_at: None,
            end_reason: None,
        };
        let raw = serde_json::to_string(&i).unwrap();
        let back: Instance = serde_json::from_str(&raw).unwrap();
        assert_eq!(i, back);
    }
}
