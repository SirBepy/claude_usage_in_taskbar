use serde::{Deserialize, Serialize};
use super::automation::{AutomationConfig, EndReason};
use crate::sessions::kinds::InstanceKind;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(tag = "mode", rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum CharacterWhitelist {
    Default,
    All,
    Custom { games: Vec<String>, ids: Vec<String> },
}

impl Default for CharacterWhitelist {
    fn default() -> Self { CharacterWhitelist::Default }
}

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
    #[serde(default)]
    pub whitelist: CharacterWhitelist,
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
    /// Path C: marks an Interactive session as having a turn currently
    /// in flight (a `claude -p --resume` child is running). Sidebar
    /// renders this as "running" vs "idle/needs input". False at rest.
    #[serde(default)]
    pub busy: bool,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    /// Self-reported turn status from the last completed turn.
    /// `Some("question")` = Claude ended with a question; `Some("done")` = done normally.
    /// `None` until the first turn completes or after a new turn starts.
    #[serde(default)]
    pub awaiting: Option<String>,
    /// True while /autopilot is active in this session. Set via `<cc-autopilot:on>`
    /// marker, cleared by `<cc-autopilot:off>` or session end.
    #[serde(default)]
    pub autopilot: bool,
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
    pub path_exists: bool,
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
            whitelist: CharacterWhitelist::default(),
        };
        let raw = serde_json::to_string(&p).unwrap();
        let back: ProjectConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn character_whitelist_default_serializes() {
        let w = CharacterWhitelist::Default;
        let raw = serde_json::to_string(&w).unwrap();
        assert_eq!(raw, r#"{"mode":"default"}"#);
        let back: CharacterWhitelist = serde_json::from_str(&raw).unwrap();
        assert_eq!(w, back);
    }

    #[test]
    fn character_whitelist_all_serializes() {
        let w = CharacterWhitelist::All;
        let raw = serde_json::to_string(&w).unwrap();
        assert_eq!(raw, r#"{"mode":"all"}"#);
        let back: CharacterWhitelist = serde_json::from_str(&raw).unwrap();
        assert_eq!(w, back);
    }

    #[test]
    fn character_whitelist_custom_serializes() {
        let w = CharacterWhitelist::Custom {
            games: vec!["heroes-of-the-storm".to_string()],
            ids: vec!["abathur".to_string()],
        };
        let raw = serde_json::to_string(&w).unwrap();
        assert_eq!(raw, r#"{"mode":"custom","games":["heroes-of-the-storm"],"ids":["abathur"]}"#);
        let back: CharacterWhitelist = serde_json::from_str(&raw).unwrap();
        assert_eq!(w, back);
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
            busy: false,
            model: String::new(),
            effort: String::new(),
            awaiting: None,
        };
        let raw = serde_json::to_string(&i).unwrap();
        let back: Instance = serde_json::from_str(&raw).unwrap();
        assert_eq!(i, back);
    }
}
