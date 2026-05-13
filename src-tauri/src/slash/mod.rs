use serde::Serialize;
use ts_rs::TS;

pub mod parse;
pub mod builtins;
pub mod enumerate;
pub mod watcher;

#[derive(Debug, Clone, Serialize, TS)]
pub struct SlashEntry {
    pub name: String,
    pub args: Option<String>,
    pub description: String,
    pub source: SlashSource,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SlashSource {
    Builtin,
    UserCommand,
    ProjectCommand,
    UserSkill,
    /// Skill defined under a project's `.claude/skills/`. `project` is the
    /// project directory's basename (used as the display tag in the UI).
    ProjectSkill { project: String },
    PluginSkill { plugin: String },
    PluginCommand { plugin: String },
}
