use std::path::PathBuf;

use crate::files;

#[tauri::command]
pub async fn list_project_files(project_dir: String) -> Result<Vec<String>, String> {
    let p = PathBuf::from(project_dir);
    tauri::async_runtime::spawn_blocking(move || files::scan(&p))
        .await
        .map_err(|e| e.to_string())?
}
