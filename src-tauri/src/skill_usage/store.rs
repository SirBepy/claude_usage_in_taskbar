use crate::skill_usage::types::{SkillDetail, SkillUsageEvent, SkillUsageWeek};
use std::path::Path;

pub fn append_events(_dir: &Path, _events: &[SkillUsageEvent]) -> std::io::Result<()> {
    Ok(())
}
pub fn mark_session(_dir: &Path, _session_id: &str, _day: &str) -> std::io::Result<()> {
    Ok(())
}
pub fn get_week(_dir: &Path, _today: &str) -> SkillUsageWeek {
    SkillUsageWeek { entries: vec![], total_sessions: 0 }
}
pub fn get_detail(_dir: &Path, _today: &str, skill: &str) -> SkillDetail {
    SkillDetail {
        skill: skill.to_string(),
        invocations: Default::default(),
        events: vec![],
    }
}
