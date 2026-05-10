use crate::state::AppState;
use crate::types::UsageSnapshot;
use crate::{history, paths};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_current_usage(state: State<AppState>) -> Option<UsageSnapshot> {
    state.current_usage.lock().unwrap().clone()
}

#[tauri::command]
pub async fn get_history(limit: Option<u32>) -> Vec<UsageSnapshot> {
    let path = match paths::history_file() { Ok(p) => p, Err(_) => return vec![] };
    tauri::async_runtime::spawn_blocking(move || {
        let mut all = history::load_all(&path).unwrap_or_default();
        if let Some(n) = limit {
            let start = all.len().saturating_sub(n as usize);
            all = all.split_off(start);
        }
        all
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn poll_now(app: AppHandle) -> Result<UsageSnapshot, String> {
    match crate::scheduler::poll_once(&app, crate::scheduler::PollTrigger::Manual).await {
        Ok(snap) => Ok(snap),
        Err(e) => Err(format!("{e:?}")),
    }
}
