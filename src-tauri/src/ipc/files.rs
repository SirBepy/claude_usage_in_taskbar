use std::path::PathBuf;

use crate::files;

#[tauri::command]
pub async fn list_project_files(project_dir: String) -> Result<Vec<String>, String> {
    let p = PathBuf::from(project_dir);
    tauri::async_runtime::spawn_blocking(move || files::scan(&p))
        .await
        .map_err(|e| e.to_string())?
}

/// Read a local file and return its contents as a base64 string so the
/// webview can embed it as a `data:` URL (img-src only allows data: and self).
/// Used by the PR preview modal to display local screenshots.
#[tauri::command]
pub async fn read_file_as_base64(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let bytes = std::fs::read(&path).map_err(|e| format!("{e}"))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}
