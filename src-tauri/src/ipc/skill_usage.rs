use crate::settings::paths;
use crate::skill_usage::store;
use crate::skill_usage::types::{InstalledSkill, SkillDetail, SkillUsageWeek};
use crate::slash::{enumerate, SlashSource};

fn today_utc() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

#[tauri::command]
pub async fn get_skill_usage_week() -> Result<SkillUsageWeek, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = paths::skill_usage_dir().map_err(|e| e.to_string())?;
        Ok(store::get_week(&dir, &today_utc()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_skill_usage_detail(skill: String) -> Result<SkillDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = paths::skill_usage_dir().map_err(|e| e.to_string())?;
        Ok(store::get_detail(&dir, &today_utc(), &skill))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lists every skill installed on disk under `~/.claude/skills/` plus
/// `~/.claude/plugins/cache/<plugin>/<version>/skills/`. Plugin skills
/// get keyed as `<plugin>:<skill>` to match what the Skill tool emits.
#[tauri::command]
pub async fn list_installed_skills() -> Result<Vec<InstalledSkill>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let entries = enumerate::scan_all(None);
        let mut out: Vec<InstalledSkill> = entries
            .into_iter()
            .filter_map(|e| match e.source {
                SlashSource::UserSkill => Some(InstalledSkill {
                    skill: e.name,
                    description: e.description,
                    plugin: None,
                }),
                SlashSource::PluginSkill { plugin } => Some(InstalledSkill {
                    skill: format!("{plugin}:{}", e.name),
                    description: e.description,
                    plugin: Some(plugin),
                }),
                _ => None,
            })
            .collect();
        out.sort_by(|a, b| a.skill.to_lowercase().cmp(&b.skill.to_lowercase()));
        Ok::<Vec<InstalledSkill>, String>(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
