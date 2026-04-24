use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
pub fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .output();
}

#[cfg(target_os = "macos")]
pub fn kill_tree(pid: u32) {
    // The spawned claude was setsid'd, so its PGID equals its PID.
    // killpg reaps every descendant (node subprocesses etc.) in one call.
    unsafe {
        if libc::killpg(pid as libc::pid_t, libc::SIGKILL) != 0 {
            // ESRCH (group already gone): try a direct kill as a last resort.
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn kill_tree(_pid: u32) {}

/// Called on app shutdown. Fire-and-forget tree kills for every channel.
pub fn kill_all(app: &AppHandle) {
    let state = app.state::<crate::state::AppState>();
    for snap in state.channels.list() {
        if let Some(pid) = snap.pid {
            kill_tree(pid);
        }
    }
}
