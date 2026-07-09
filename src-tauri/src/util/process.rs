#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Convert a UTF-8 string to a null-terminated UTF-16 buffer for Windows APIs.
#[cfg(windows)]
pub(crate) fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

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

/// Strip the inherit flag from a bound TCP listener's socket so it does NOT
/// leak into daemon-spawned children. The daemon spawns children with piped
/// stdio, which on Windows forces `bInheritHandles=TRUE`: every inheritable
/// handle in this process is copied into every child (chat `claude -p`
/// processes, pty channels, and their MCP grandchildren). If a listen socket
/// leaks, killing the daemon leaves the port bound by its surviving children
/// and no new daemon can ever rebind it (the 2026-06-12 port-hostage incident).
/// Call this right after binding, before any child is spawned. No-op off Windows.
pub fn mark_listener_non_inheritable(listener: &tokio::net::TcpListener) {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        use windows::Win32::Foundation::{
            SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT,
        };
        // SAFETY: the raw socket is owned by `listener`, which outlives the call.
        let _ = unsafe {
            SetHandleInformation(
                HANDLE(listener.as_raw_socket() as _),
                HANDLE_FLAG_INHERIT.0,
                HANDLE_FLAGS(0),
            )
        };
    }
    #[cfg(not(windows))]
    {
        let _ = listener;
    }
}

/// Process-wide shared `System`, so repeated live-pid checks (lockfile
/// startup, the detector's 5s tick, the channel-adopt exit watcher's 5s poll)
/// refresh the same process table in place instead of each allocating and
/// tearing down a fresh one. Lazily built on first use.
fn shared_system() -> &'static std::sync::Mutex<sysinfo::System> {
    static SYSTEM: std::sync::OnceLock<std::sync::Mutex<sysinfo::System>> = std::sync::OnceLock::new();
    SYSTEM.get_or_init(|| std::sync::Mutex::new(sysinfo::System::new()))
}

/// Whether a process with `pid` is currently alive. Centralizes the sysinfo
/// dance so the `refresh_processes` / `Pid::from_u32` contract lives in one
/// place. Used by the daemon lockfile's stale-vs-live reclaim.
pub fn pid_is_live(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate};
    let mut s = shared_system().lock().unwrap();
    s.refresh_processes(ProcessesToUpdate::All);
    s.process(Pid::from_u32(pid)).is_some()
}

/// Snapshot of every currently-live pid. Used by the detector's reconcile loop
/// to mark instances whose process has gone away.
pub fn live_pids() -> Vec<u32> {
    use sysinfo::ProcessesToUpdate;
    let mut s = shared_system().lock().unwrap();
    s.refresh_processes(ProcessesToUpdate::All);
    s.processes().keys().map(|p| p.as_u32()).collect()
}
