use crate::settings::paths;
use crate::skill_usage::store;
use crate::skill_usage::types::{SkillDetail, SkillUsageWeek};

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
