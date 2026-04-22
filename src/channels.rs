//! Owns automated Claude Code channels. One `Channel` per project
//! that has `automation.enabled`. Spawn, kill, restart with
//! exponential backoff on early failure, and Windows console
//! show/hide via HWND manipulation.

use std::time::Duration;

// -------- Restart policy (pure logic -- testable without processes) --------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    DoNotRestart,
    RestartAfter(Duration),
    GiveUp,
}

#[derive(Debug, Default, Clone)]
pub struct RestartState {
    pub early_exits_in_a_row: u32,
    pub cap_failures: u32,
    pub suppress_restart: bool,
}

const STABLE_THRESHOLD_SECS: u64 = 5;
const BACKOFFS_SECS: [u64; 4] = [2, 4, 8, 16];
const MAX_CAP_FAILURES: u32 = 5;

pub fn next_restart_delay(state: &mut RestartState, last_runtime: Duration) -> RestartDecision {
    if state.suppress_restart {
        return RestartDecision::DoNotRestart;
    }

    if last_runtime.as_secs() >= STABLE_THRESHOLD_SECS {
        // Stable runtime: reset counters, restart immediately.
        state.early_exits_in_a_row = 0;
        state.cap_failures = 0;
        return RestartDecision::RestartAfter(Duration::from_secs(0));
    }

    // Early exit: either step up the backoff ladder or count cap failures.
    if (state.early_exits_in_a_row as usize) < BACKOFFS_SECS.len() {
        let delay = BACKOFFS_SECS[state.early_exits_in_a_row as usize];
        state.early_exits_in_a_row += 1;
        return RestartDecision::RestartAfter(Duration::from_secs(delay));
    }
    state.cap_failures += 1;
    if state.cap_failures >= MAX_CAP_FAILURES {
        return RestartDecision::GiveUp;
    }
    RestartDecision::RestartAfter(Duration::from_secs(*BACKOFFS_SECS.last().unwrap()))
}

// -------- Spawn --------

use std::path::PathBuf;
use tokio::process::Command;

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x00000010;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

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
    pub child: tokio::process::Child,
}

#[cfg(windows)]
pub async fn spawn(input: &SpawnInput) -> Result<SpawnOutput, SpawnError> {
    let mut cmd = Command::new("cmd");
    let mut args: Vec<String> = vec![
        "/C".into(),
        "claude".into(),
        "--remote-control".into(),
        "--remote-control-session-name-prefix".into(),
        input.session_name_prefix.clone(),
    ];
    if input.continue_flag {
        args.push("--continue".into());
    }
    cmd.args(&args)
        .current_dir(&input.cwd)
        .creation_flags(CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP);
    let child = cmd.spawn().map_err(SpawnError::Io)?;
    let pid = child.id().unwrap_or(0);
    Ok(SpawnOutput { pid, child })
}

#[cfg(not(windows))]
pub async fn spawn(_input: &SpawnInput) -> Result<SpawnOutput, SpawnError> {
    Err(SpawnError::NonWindows)
}

// -------- HWND helpers --------

#[cfg(windows)]
pub fn find_hwnd_for_pid(pid: u32) -> Option<isize> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId};

    struct Ctx {
        want_pid: u32,
        found: isize,
    }
    let mut ctx = Ctx { want_pid: pid, found: 0 };

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
        let mut wpid: u32 = 0;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut wpid));
        if wpid == ctx.want_pid {
            ctx.found = hwnd.0 as isize;
            return BOOL(0); // stop
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut ctx as *mut _ as isize));
    }
    if ctx.found == 0 { None } else { Some(ctx.found) }
}

#[cfg(windows)]
pub fn show_hwnd(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_SHOW};
    unsafe {
        let h = HWND(hwnd as *mut std::ffi::c_void);
        let _ = ShowWindow(h, SW_SHOW);
        let _ = SetForegroundWindow(h);
    }
}

#[cfg(windows)]
pub fn hide_hwnd(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    unsafe {
        let h = HWND(hwnd as *mut std::ffi::c_void);
        let _ = ShowWindow(h, SW_HIDE);
    }
}

#[cfg(not(windows))]
pub fn find_hwnd_for_pid(_pid: u32) -> Option<isize> {
    None
}
#[cfg(not(windows))]
pub fn show_hwnd(_hwnd: isize) {}
#[cfg(not(windows))]
pub fn hide_hwnd(_hwnd: isize) {}

/// Polls up to 20 x 50ms for the main console hwnd to appear after spawn.
pub async fn resolve_console_hwnd(pid: u32) -> Option<isize> {
    for _ in 0..20 {
        if let Some(h) = find_hwnd_for_pid(pid) {
            return Some(h);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

// -------- Manager skeleton --------

use crate::types::ChannelStatus;
use std::collections::HashMap;
use std::sync::Mutex;

pub struct ChannelSnapshot {
    pub project_id: String,
    pub pid: Option<u32>,
    pub status: ChannelStatus,
    pub hwnd: Option<isize>,
}

pub struct Manager {
    channels: Mutex<HashMap<String, ChannelSnapshot>>, // keyed by project_id
}

impl Manager {
    pub fn new() -> Self {
        Self {
            channels: Mutex::new(HashMap::new()),
        }
    }

    pub fn snapshot(&self, project_id: &str) -> Option<ChannelSnapshot> {
        self.channels.lock().unwrap().get(project_id).map(|s| ChannelSnapshot {
            project_id: s.project_id.clone(),
            pid: s.pid,
            status: s.status,
            hwnd: s.hwnd,
        })
    }

    pub fn list(&self) -> Vec<ChannelSnapshot> {
        self.channels
            .lock()
            .unwrap()
            .values()
            .map(|s| ChannelSnapshot {
                project_id: s.project_id.clone(),
                pid: s.pid,
                status: s.status,
                hwnd: s.hwnd,
            })
            .collect()
    }
}
