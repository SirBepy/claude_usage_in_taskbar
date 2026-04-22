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

// Build the command line string fed to CreateProcessW. First token is the
// executable (cmd.exe); rest are args. Quoting rule: wrap any arg containing
// whitespace or quotes and escape embedded quotes per MSDN.
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

#[cfg(not(windows))]
pub fn spawn_child(_input: SpawnInput) -> Result<SpawnOutput, SpawnError> {
    Err(SpawnError::NonWindows)
}

// Keep async wrapper for back-compat with any callers that await it.
pub async fn spawn(input: SpawnInput) -> Result<SpawnOutput, SpawnError> {
    spawn_child(input)
}

/// Block until the child exits. Closes the handle. Returns instantly on
/// non-windows (handle is 0).
#[cfg(windows)]
async fn wait_for_child_exit(process_handle: isize) {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    let _ = tokio::task::spawn_blocking(move || unsafe {
        let h = HANDLE(process_handle as *mut std::ffi::c_void);
        let _ = WaitForSingleObject(h, INFINITE);
        let _ = CloseHandle(h);
    })
    .await;
}

#[cfg(not(windows))]
async fn wait_for_child_exit(_process_handle: isize) {}

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

/// Strip title bar, borders, and system menu so the console comes up
/// frameless. User can't click X to kill the process (there's no X);
/// hide/stop/restart must come from the dashboard UI.
#[cfg(windows)]
pub fn strip_console_chrome(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_MAXIMIZEBOX,
        WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
    };
    unsafe {
        let h = HWND(hwnd as *mut std::ffi::c_void);
        let style = GetWindowLongPtrW(h, GWL_STYLE);
        let remove = (WS_CAPTION.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0
            | WS_THICKFRAME.0) as isize;
        let new_style = style & !remove;
        let _ = SetWindowLongPtrW(h, GWL_STYLE, new_style);
        let _ = SetWindowPos(
            h,
            HWND::default(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
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
#[cfg(not(windows))]
pub fn strip_console_chrome(_hwnd: isize) {}

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

    fn put(&self, snap: ChannelSnapshot) {
        let mut g = self.channels.lock().unwrap();
        g.insert(snap.project_id.clone(), snap);
    }

    #[allow(dead_code)]
    fn remove(&self, project_id: &str) {
        self.channels.lock().unwrap().remove(project_id);
    }

    fn patch<F: FnOnce(&mut ChannelSnapshot)>(&self, project_id: &str, f: F) {
        if let Some(s) = self.channels.lock().unwrap().get_mut(project_id) {
            f(s);
        }
    }
}

// -------- Per-project restart state (module-level static) --------

static RESTART_STATES: once_cell::sync::Lazy<Mutex<HashMap<String, RestartState>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

fn suppress_restart_for(project_id: &str) {
    let mut g = RESTART_STATES.lock().unwrap();
    g.entry(project_id.to_string()).or_default().suppress_restart = true;
}

fn clear_suppress_for(project_id: &str) {
    let mut g = RESTART_STATES.lock().unwrap();
    g.entry(project_id.to_string()).or_default().suppress_restart = false;
}

/// Pulls or creates a per-project RestartState and computes the next decision.
fn next_decision_for(project_id: &str, runtime: Duration) -> RestartDecision {
    let mut guard = RESTART_STATES.lock().unwrap();
    let st = guard.entry(project_id.to_string()).or_default();
    next_restart_delay(st, runtime)
}

// -------- Lifecycle API --------

use tauri::{AppHandle, Emitter, Manager as _};

/// Fired when a channel lifecycle event happens so the webview can refresh.
fn emit_changed(app: &AppHandle) {
    let state = app.state::<crate::state::AppState>();
    let snaps: Vec<_> = state.channels.list().into_iter().map(|s| serde_json::json!({
        "project_id": s.project_id,
        "pid": s.pid,
        "status": match s.status {
            ChannelStatus::Starting => "starting",
            ChannelStatus::Running  => "running",
            ChannelStatus::Stopped  => "stopped",
            ChannelStatus::Crashed  => "crashed",
        },
        "hwnd": s.hwnd,
    })).collect();
    let _ = app.emit("channels-changed", snaps);
}

/// Spawns (or re-spawns) the channel for a configured project.
///
/// Returned as a `Pin<Box<dyn Future + Send>>` so callers can pass it to
/// `tauri::async_runtime::spawn` without ambiguous-Send errors that arise from
/// opaque `async fn` return types in this module.
pub fn start_channel(
    app: AppHandle,
    project_id: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
    Box::pin(async move {
    let (cwd, prefix, continue_flag) = {
        let state = app.state::<crate::state::AppState>();
        let guard = state.settings.lock().unwrap();
        let Some(p) = guard.projects.iter().find(|p| p.id == project_id) else {
            return Err(format!("project {project_id} not found"));
        };
        let auto = p.automation.as_ref().ok_or("project has no automation")?;
        let prefix = auto.session_name_prefix.clone().unwrap_or_else(|| p.name.clone());
        (p.path.clone(), prefix, auto.continue_flag)
    };

    {
        let state = app.state::<crate::state::AppState>();
        state.channels.put(ChannelSnapshot {
            project_id: project_id.clone(),
            pid: None,
            status: ChannelStatus::Starting,
            hwnd: None,
        });
    }
    emit_changed(&app);

    let spawn_out = spawn_child(SpawnInput {
        project_id: project_id.clone(),
        cwd,
        session_name_prefix: prefix,
        continue_flag,
    })
    .map_err(|e| e.to_string())?;

    let pid = spawn_out.pid;
    {
        let state = app.state::<crate::state::AppState>();
        state.channels.patch(&project_id, |s| {
            s.pid = Some(pid);
            s.status = ChannelStatus::Running;
        });
    }

    // Resolve hwnd async, strip chrome, keep hidden. Process was spawned
    // with SW_HIDE so it's already invisible; stripping chrome just prepares
    // the window for when the user clicks Show.
    {
        let app_h = app.clone();
        let proj_h = project_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(hwnd) = resolve_console_hwnd(pid).await {
                strip_console_chrome(hwnd);
                hide_hwnd(hwnd);
                let s = app_h.state::<crate::state::AppState>();
                s.channels.patch(&proj_h, |s| s.hwnd = Some(hwnd));
                emit_changed(&app_h);
            }
        });
    }

    // Watchdog: await child exit, apply restart policy, recurse if asked.
    {
        let app_w = app.clone();
        let proj_w = project_id.clone();
        let handle = spawn_out.process_handle;
        tauri::async_runtime::spawn(async move {
            let started_at = std::time::Instant::now();
            wait_for_child_exit(handle).await;
            let runtime = started_at.elapsed();

            let state = app_w.state::<crate::state::AppState>();
            let decision = next_decision_for(&proj_w, runtime);

            match decision {
                RestartDecision::DoNotRestart => {
                    state.channels.patch(&proj_w, |s| {
                        s.status = ChannelStatus::Stopped;
                        s.pid = None;
                        s.hwnd = None;
                    });
                    emit_changed(&app_w);
                }
                RestartDecision::GiveUp => {
                    state.channels.patch(&proj_w, |s| {
                        s.status = ChannelStatus::Crashed;
                        s.pid = None;
                        s.hwnd = None;
                    });
                    emit_changed(&app_w);
                }
                RestartDecision::RestartAfter(delay) => {
                    state.channels.patch(&proj_w, |s| {
                        s.status = ChannelStatus::Stopped;
                        s.pid = None;
                        s.hwnd = None;
                    });
                    emit_changed(&app_w);
                    tokio::time::sleep(delay).await;
                    // Spawn a new independent task for the restart so we don't
                    // hold the current watchdog stack alive.
                    tauri::async_runtime::spawn(async move {
                        let _ = start_channel(app_w, proj_w).await;
                    });
                }
            }
        });
    }

    Ok(())
    }) // end Box::pin(async move { ... })
}

/// Stop without auto-restart. Kills the tree on Windows via taskkill.
pub fn stop_channel(app: &AppHandle, project_id: &str) -> Result<(), String> {
    let state = app.state::<crate::state::AppState>();
    let (pid, hwnd) = match state.channels.snapshot(project_id) {
        Some(s) => (s.pid, s.hwnd),
        None => return Ok(()),
    };
    // Mark suppress so the watchdog's restart path takes DoNotRestart.
    suppress_restart_for(project_id);
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    if let Some(h) = hwnd {
        hide_hwnd(h);
    }
    state.channels.patch(project_id, |s| {
        s.status = ChannelStatus::Stopped;
        s.pid = None;
        s.hwnd = None;
    });
    emit_changed(app);
    Ok(())
}

pub async fn restart_channel(app: AppHandle, project_id: String) -> Result<(), String> {
    stop_channel(&app, &project_id)?;
    // Clear suppress so next spawn's watchdog restores default policy.
    clear_suppress_for(&project_id);
    start_channel(app, project_id).await
}

fn kill_tree(pid: u32) {
    // taskkill /T /F /PID <pid> -- kills the entire process tree.
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

pub async fn autostart_all(app: AppHandle) {
    let to_start: Vec<String> = {
        let state = app.state::<crate::state::AppState>();
        let guard = state.settings.lock().unwrap();
        let ids: Vec<String> = guard
            .projects
            .iter()
            .filter(|p| {
                p.automation
                    .as_ref()
                    .map(|a| a.enabled && a.autostart_on_boot)
                    .unwrap_or(false)
            })
            .map(|p| p.id.clone())
            .collect();
        ids
    }; // state + guard dropped before any await
    for id in to_start {
        if let Err(e) = start_channel(app.clone(), id.clone()).await {
            log::warn!("autostart failed for {id}: {e}");
        }
    }
}
