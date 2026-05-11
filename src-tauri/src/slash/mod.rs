use serde::Serialize;
use ts_rs::TS;

pub mod parse;

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
    PluginSkill { plugin: String },
    PluginCommand { plugin: String },
}
