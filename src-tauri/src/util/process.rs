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
