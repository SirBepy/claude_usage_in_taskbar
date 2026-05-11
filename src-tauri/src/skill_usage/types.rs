use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "lowercase")]
pub enum InvocationSource {
    Manual,
    Skill,
    Auto,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../src/types/")]
pub struct TokenBreakdown {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
}

impl TokenBreakdown {
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_create
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../src/types/")]
pub struct SkillUsageEvent {
    pub ts: String,
    pub skill: String,
    pub session_id: String,
    pub project: String,
    pub source: InvocationSource,
    pub tokens: TokenBreakdown,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../src/types/")]
pub struct InvocationCounts {
    pub total: u32,
    pub manual: u32,
    pub skill: u32,
    pub auto: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../src/types/")]
pub struct SkillUsageEntry {
    pub skill: String,
    pub invocations: InvocationCounts,
    pub chats: u32,
    pub tokens: TokenBreakdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../src/types/")]
pub struct SkillUsageWeek {
    pub entries: Vec<SkillUsageEntry>,
    pub total_sessions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../src/types/")]
pub struct SkillDetail {
    pub skill: String,
    pub invocations: InvocationCounts,
    pub events: Vec<SkillUsageEvent>,
}
