#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply Windows-only console-suppression flag so spawning a console-subsystem
/// binary (claude.exe, git.exe, ...) from a GUI Tauri app doesn't flash a black
/// console window. No-op on non-Windows platforms.
pub fn hide_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Same as `hide_console` but for `tokio::process::Command`. Tokio's Command
/// re-exports the Windows-only `creation_flags` extension.
pub fn hide_console_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Whether a process with `pid` is currently alive. Centralizes the sysinfo
/// dance so the `refresh_processes` / `Pid::from_u32` contract lives in one
/// place. Used by the daemon lockfile's stale-vs-live reclaim.
pub fn pid_is_live(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut s = System::new();
    s.refresh_processes(ProcessesToUpdate::All);
    s.process(Pid::from_u32(pid)).is_some()
}

/// Snapshot of every currently-live pid. Used by the detector's reconcile loop
/// to mark instances whose process has gone away.
pub fn live_pids() -> Vec<u32> {
    use sysinfo::{ProcessesToUpdate, System};
    let mut s = System::new();
    s.refresh_processes(ProcessesToUpdate::All);
    s.processes().keys().map(|p| p.as_u32()).collect()
}
