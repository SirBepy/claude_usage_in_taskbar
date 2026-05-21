//! Spawn the daemon as a detached child of the app: `<current_exe> --daemon`.
//! Detached so closing the app does NOT take the daemon down. The daemon's
//! lockfile guards against a duplicate spawn if two app instances race here.

#[derive(Debug)]
pub enum SpawnSelfError {
    Io(std::io::Error),
    NoExe(std::io::Error),
    NonWindows,
}

impl std::fmt::Display for SpawnSelfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpawnSelfError::Io(e) => write!(f, "spawn daemon: {e}"),
            SpawnSelfError::NoExe(e) => write!(f, "resolve current exe: {e}"),
            SpawnSelfError::NonWindows => write!(f, "daemon self-spawn is Windows-only"),
        }
    }
}
impl std::error::Error for SpawnSelfError {}

/// Spawn `<current_exe> --daemon` fully detached. Returns the new pid.
#[cfg(windows)]
pub fn spawn_detached_daemon() -> Result<u32, SpawnSelfError> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        CreateProcessW, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, STARTUPINFOW,
    };

    // DETACHED_PROCESS: no console. NEW_PROCESS_GROUP + BREAKAWAY_FROM_JOB:
    // not reaped when the app (or its job object) exits.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

    let exe = std::env::current_exe().map_err(SpawnSelfError::NoExe)?;
    let cmdline = format!("\"{}\" --daemon", exe.to_string_lossy());
    let mut cmdline_w: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();

    let mut si = STARTUPINFOW::default();
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut pi = PROCESS_INFORMATION::default();
    let flags = PROCESS_CREATION_FLAGS(
        DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
    );

    let result = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            PWSTR(cmdline_w.as_mut_ptr()),
            None,
            None,
            false,
            flags,
            None,
            PCWSTR::null(),
            &si,
            &mut pi,
        )
    };
    if let Err(e) = result {
        return Err(SpawnSelfError::Io(std::io::Error::from_raw_os_error(e.code().0)));
    }
    unsafe {
        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(pi.hProcess);
    }
    Ok(pi.dwProcessId)
}

#[cfg(not(windows))]
pub fn spawn_detached_daemon() -> Result<u32, SpawnSelfError> {
    Err(SpawnSelfError::NonWindows)
}
