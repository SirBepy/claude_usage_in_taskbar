//! Platform-gated PC power control: sleep + shutdown. Used by the
//! "do-X-when-all-sessions-idle" protocol (see `when_done`). Each function
//! spawns the OS-native command and returns immediately; on Windows the spawn
//! sets CREATE_NO_WINDOW so no console window flashes (mirrors
//! `crate::util::process::hide_console`).

use std::process::Command;

/// Put the machine to sleep (suspend).
pub fn sleep_pc() -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("rundll32.exe");
        cmd.args(["powrprof.dll,SetSuspendState", "0,1,0"]);
        crate::util::process::hide_console(&mut cmd);
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("sleep_pc rundll32 spawn failed: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("pmset")
            .arg("sleepnow")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("sleep_pc pmset spawn failed: {e}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("systemctl")
            .arg("suspend")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("sleep_pc systemctl spawn failed: {e}"))
    }
}

/// Shut the machine down immediately (forced, no delay).
pub fn shutdown_pc() -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("shutdown");
        cmd.args(["/s", "/f", "/t", "0"]);
        crate::util::process::hide_console(&mut cmd);
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("shutdown_pc spawn failed: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("osascript")
            .args(["-e", "tell app \"System Events\" to shut down"])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("shutdown_pc osascript spawn failed: {e}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("systemctl")
            .arg("poweroff")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("shutdown_pc systemctl spawn failed: {e}"))
    }
}
