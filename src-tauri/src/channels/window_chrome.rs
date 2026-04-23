use std::time::Duration;

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
            return BOOL(0);
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
pub fn find_hwnd_for_pid(_pid: u32) -> Option<isize> { None }
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
