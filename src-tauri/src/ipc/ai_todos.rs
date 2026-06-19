//! AI-todos IPC: count/list the `.md` task files under `<cwd>/.for_bepy/ai_todos/`.
//! Split out of `misc.rs` so each module keeps a single responsibility.

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct AiTodoEntry {
    pub name: String,
    pub path: String,
}

fn ai_todos_dir(cwd: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(cwd).join(".for_bepy").join("ai_todos")
}

/// Count .md files in `<cwd>/.for_bepy/ai_todos/`. Returns 0 if the directory
/// does not exist.
#[tauri::command]
pub fn count_ai_todos(cwd: String) -> usize {
    let dir = ai_todos_dir(&cwd);
    std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
                .count()
        })
        .unwrap_or(0)
}

/// List .md files in `<cwd>/.for_bepy/ai_todos/`, sorted by name. Returns an
/// empty vec if the directory does not exist.
#[tauri::command]
pub fn list_ai_todos(cwd: String) -> Vec<AiTodoEntry> {
    let dir = ai_todos_dir(&cwd);
    let mut entries: Vec<AiTodoEntry> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
                .map(|e| {
                    let path = e.path();
                    let name = path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                    let full_path = path.to_string_lossy().into_owned();
                    AiTodoEntry { name, path: full_path }
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}
