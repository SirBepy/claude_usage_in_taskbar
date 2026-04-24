use std::path::PathBuf;

#[derive(Debug)]
pub enum SpawnError {
    Io(std::io::Error),
    NonWindows,
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpawnError::Io(e) => write!(f, "io: {e}"),
            SpawnError::NonWindows => write!(f, "channel spawning is Windows-only"),
        }
    }
}

impl std::error::Error for SpawnError {}

pub struct SpawnInput {
    pub project_id: String,
    pub cwd: PathBuf,
    pub session_name_prefix: String,
    pub continue_flag: bool,
}

pub struct SpawnOutput {
    pub pid: u32,
    /// Raw Windows process HANDLE (as isize). Zero on non-windows stubs.
    /// Ownership: caller must CloseHandle once after WaitForSingleObject.
    pub process_handle: isize,
}

fn build_cmdline(input: &SpawnInput) -> String {
    fn quote(arg: &str) -> String {
        if !arg.is_empty()
            && !arg.contains(|c: char| c.is_whitespace() || c == '"')
        {
            return arg.to_string();
        }
        let escaped = arg.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\"")
    }
    let mut parts: Vec<String> = vec![
        "cmd.exe".into(),
        "/C".into(),
        "claude".into(),
        "--remote-control".into(),
        "--remote-control-session-name-prefix".into(),
        quote(&input.session_name_prefix),
    ];
    if input.continue_flag {
        parts.push("--continue".into());
    }
    parts.join(" ")
}

#[cfg(windows)]
pub fn spawn_child(input: SpawnInput) -> Result<SpawnOutput, SpawnError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        CreateProcessW, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
        STARTUPINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    const CREATE_NEW_CONSOLE: u32 = 0x00000010;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

    let cmdline = build_cmdline(&input);
    let mut cmdline_w: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();
    let cwd_w: Vec<u16> = input
        .cwd
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut si = STARTUPINFOW::default();
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE.0 as u16;
    let mut pi = PROCESS_INFORMATION::default();

    let flags = PROCESS_CREATION_FLAGS(CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP);

    let result = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            PWSTR(cmdline_w.as_mut_ptr()),
            None,
            None,
            false,
            flags,
            None,
            PCWSTR(cwd_w.as_ptr()),
            &si,
            &mut pi,
        )
    };
    if let Err(e) = result {
        return Err(SpawnError::Io(std::io::Error::from_raw_os_error(
            e.code().0,
        )));
    }

    unsafe {
        let _ = CloseHandle(pi.hThread);
    }

    Ok(SpawnOutput {
        pid: pi.dwProcessId,
        process_handle: pi.hProcess.0 as isize,
    })
}

#[cfg(target_os = "macos")]
pub fn spawn_child(input: SpawnInput) -> Result<SpawnOutput, SpawnError> {
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    let mut cmd = Command::new("claude");
    cmd.arg("--remote-control")
        .arg("--remote-control-session-name-prefix")
        .arg(&input.session_name_prefix);
    if input.continue_flag {
        cmd.arg("--continue");
    }
    cmd.current_dir(&input.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    // Put the child in a new session + process group so killpg() can
    // tree-kill it plus every node subprocess it spawns.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let child = cmd.spawn().map_err(SpawnError::Io)?;
    let pid = child.id();
    // Drop `child`: `Child::drop` on Unix does not kill or reap; it only
    // closes stdio FDs (null stdio => nothing to close). The watchdog
    // reaps via `waitpid` exactly once (see wait_for_child_exit).
    drop(child);

    Ok(SpawnOutput {
        pid,
        process_handle: 0,
    })
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn spawn_child(_input: SpawnInput) -> Result<SpawnOutput, SpawnError> {
    Err(SpawnError::NonWindows)
}

pub async fn spawn(input: SpawnInput) -> Result<SpawnOutput, SpawnError> {
    spawn_child(input)
}

/// Block until the child exits. On Windows, waits on the HANDLE and closes
/// it. On macOS, reaps via waitpid. Returns instantly on other unix.
#[cfg(windows)]
pub(super) async fn wait_for_child_exit(process_handle: isize, _pid: u32) {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    let _ = tokio::task::spawn_blocking(move || unsafe {
        let h = HANDLE(process_handle as *mut std::ffi::c_void);
        let _ = WaitForSingleObject(h, INFINITE);
        let _ = CloseHandle(h);
    })
    .await;
}

#[cfg(target_os = "macos")]
pub(super) async fn wait_for_child_exit(_process_handle: isize, pid: u32) {
    let _ = tokio::task::spawn_blocking(move || unsafe {
        let mut status: libc::c_int = 0;
        libc::waitpid(pid as libc::pid_t, &mut status, 0);
    })
    .await;
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(super) async fn wait_for_child_exit(_process_handle: isize, _pid: u32) {}
