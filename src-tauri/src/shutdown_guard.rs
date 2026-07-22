//! Windows session-end guard: a dedicated thread owning a hidden top-level
//! window with its own message pump, so the process answers Windows' shutdown
//! handshake even when Tauri's event loop is wedged.
//!
//! Why this exists. `tao` deliberately leaves `WM_QUERYENDSESSION` to
//! `DefSubclassProc` ("We don't process `WM_QUERYENDSESSION` yet", see tao's
//! `platform_impl/windows/event_loop.rs`) and only reacts to `WM_ENDSESSION` -
//! both on the main event-loop thread. That is fine while the loop is pumping.
//! It is not fine here: this machine's Windows Error Reporting log shows
//! repeated `AppHangB1` entries for `claude-conductor.exe` ("stopped
//! interacting with Windows and was closed"). A hung message loop cannot answer
//! the session-end messages, so Windows parks the shutdown behind a "this app
//! isn't responding" dialog the user has to dismiss by hand before the PC will
//! power off.
//!
//! No `RunEvent` handler can fix that, because those run on the same wedged
//! thread. This guard runs its own pump on its own thread instead, and stays
//! responsive regardless of what the main thread is doing. On
//! `WM_QUERYENDSESSION` it answers TRUE immediately (never veto a shutdown),
//! asks the app to exit the normal way, and arms a watchdog that force-exits
//! the process once the grace period expires.
//!
//! Deliberate tradeoff: the force-exit skips graceful teardown, so state not
//! already flushed to disk is lost at shutdown. Settings and chat config are
//! written on change rather than at exit, so in practice this costs at most the
//! main window's saved geometry.
//!
//! The detached daemon (`daemon::spawn_self`) is a separate process and is
//! unaffected; Windows reaps it on its own during shutdown.

/// How long the normal exit path gets before the watchdog kills the process.
/// Windows' own patience (`HungAppTimeout`) defaults to 5s, so this has to land
/// comfortably inside that to beat the dialog.
#[cfg(windows)]
const GRACE_MS: u64 = 1_500;

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::Manager;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage,
        RegisterClassW, TranslateMessage, HMENU, MSG, WINDOW_EX_STYLE, WM_DESTROY, WM_ENDSESSION,
        WM_QUERYENDSESSION, WNDCLASSW, WS_EX_TOOLWINDOW, WS_OVERLAPPED,
    };

    /// Handle used to ask for a normal exit once the session is ending.
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    /// Set once the shutdown handshake has started, so a second
    /// `WM_QUERYENDSESSION`/`WM_ENDSESSION` pair doesn't arm two watchdogs.
    static ENDING: AtomicBool = AtomicBool::new(false);
    /// Set if Windows tells us the shutdown was called off (`WM_ENDSESSION`
    /// with `wParam == FALSE`), which disarms the watchdog.
    static CANCELLED: AtomicBool = AtomicBool::new(false);

    pub fn arm(app: tauri::AppHandle) {
        if APP.set(app).is_err() {
            // Already armed; a second call would leak another pump thread.
            return;
        }
        std::thread::Builder::new()
            .name("shutdown-guard".into())
            .spawn(pump)
            .map(|_| ())
            .unwrap_or_else(|e| log::error!("shutdown guard: thread spawn failed: {e}"));
    }

    /// Create the hidden window and run its message loop. Never returns while
    /// the app lives.
    fn pump() {
        let class_name = crate::util::process::to_wide("CCShutdownGuard");
        let window_name = crate::util::process::to_wide("Claude Conductor shutdown guard");

        let hinstance: HINSTANCE = match unsafe { GetModuleHandleW(PCWSTR::null()) } {
            Ok(h) => h.into(),
            Err(e) => {
                log::error!("shutdown guard: GetModuleHandleW failed: {e}");
                return;
            }
        };

        let class = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinstance,
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        if unsafe { RegisterClassW(&class) } == 0 {
            log::error!(
                "shutdown guard: RegisterClassW failed: {}",
                std::io::Error::last_os_error()
            );
            return;
        }

        // A real top-level window, not `HWND_MESSAGE`: message-only windows are
        // skipped by the session-end broadcast, which would defeat the point.
        // Never shown, and `WS_EX_TOOLWINDOW` keeps it out of alt-tab.
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0),
                PCWSTR(class_name.as_ptr()),
                PCWSTR(window_name.as_ptr()),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                HWND::default(),
                HMENU::default(),
                hinstance,
                None,
            )
        };
        if let Err(e) = hwnd {
            log::error!("shutdown guard: CreateWindowExW failed: {e}");
            return;
        }
        log::info!("shutdown guard: armed");

        let mut msg = MSG::default();
        while unsafe { GetMessageW(&mut msg, HWND::default(), 0, 0) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            // Windows asking permission to end the session. Always say yes -
            // blocking a shutdown is the bug we're fixing, not a tool we use.
            WM_QUERYENDSESSION => {
                begin_session_end("WM_QUERYENDSESSION");
                LRESULT(1)
            }
            // wParam TRUE: the session really is ending. FALSE: some other app
            // vetoed it, so stand down.
            WM_ENDSESSION => {
                if wparam.0 == 0 {
                    CANCELLED.store(true, Ordering::SeqCst);
                    ENDING.store(false, Ordering::SeqCst);
                    log::info!("shutdown guard: session end cancelled; watchdog disarmed");
                } else {
                    begin_session_end("WM_ENDSESSION");
                }
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    /// Kick off the exit: ask the app to quit normally, and arm the watchdog
    /// that force-exits if that doesn't land in time. Idempotent.
    fn begin_session_end(source: &str) {
        if ENDING.swap(true, Ordering::SeqCst) {
            return;
        }
        CANCELLED.store(false, Ordering::SeqCst);
        log::info!("shutdown guard: session ending (via {source}); requesting normal exit");
        request_graceful_exit();
        arm_watchdog();
    }

    fn request_graceful_exit() {
        let Some(app) = APP.get() else { return };
        // Lets any `CloseRequested` handler fall through instead of
        // hide-to-tray (see `ipc::window::attach_hide_to_tray`).
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            state
                .should_quit
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        // Off-thread on purpose: the guard's pump must never block on the
        // health of the event loop it is compensating for.
        let app = app.clone();
        let _ = std::thread::Builder::new()
            .name("shutdown-guard-exit".into())
            .spawn(move || app.exit(0));
    }

    fn arm_watchdog() {
        let _ = std::thread::Builder::new()
            .name("shutdown-guard-watchdog".into())
            .spawn(|| {
                // Polled rather than one long sleep so a cancelled shutdown can
                // call it off partway through.
                let steps = super::GRACE_MS / 100;
                for _ in 0..steps {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    if CANCELLED.load(Ordering::SeqCst) {
                        return;
                    }
                }
                log::warn!(
                    "shutdown guard: normal exit did not complete within {}ms; forcing exit",
                    super::GRACE_MS
                );
                log::logger().flush();
                std::process::exit(0);
            });
    }
}

/// Start the session-end guard. Call once, from app setup. No-op off Windows,
/// where session end is not signalled this way.
#[cfg(windows)]
pub fn arm(app: tauri::AppHandle) {
    imp::arm(app);
}

#[cfg(not(windows))]
pub fn arm(_app: tauri::AppHandle) {}
