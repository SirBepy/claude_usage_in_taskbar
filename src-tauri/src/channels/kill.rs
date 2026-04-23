use tauri::{AppHandle, Manager};

pub fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .output();
}

/// Called on app shutdown. Fire-and-forget tree kills for every channel.
pub fn kill_all(app: &AppHandle) {
    let state = app.state::<crate::state::AppState>();
    for snap in state.channels.list() {
        if let Some(pid) = snap.pid {
            kill_tree(pid);
        }
    }
}
