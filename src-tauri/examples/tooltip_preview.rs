//! Standalone tooltip screenshot harness.
//!
//! Creates a tooltips_class32 control, shows it at a known position with a
//! given string, screenshots it to `target/tooltip-preview.png`. Lets us
//! verify tray-tooltip rendering tweaks without dev-side hover screenshots.
//!
//! Usage (from src-tauri/):
//!   cargo run --example tooltip_preview -- "Session\tWeekly\r\n70%\t90%"
//!
//! `\t` and `\r\n` in argv are interpreted literally (we substitute below)
//! so multi-line / column-aligned strings can be passed from any shell.

#[cfg(not(windows))]
fn main() {
    println!("tooltip_preview is windows-only");
}

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Controls::{
        InitCommonControlsEx, ICC_BAR_CLASSES, ICC_STANDARD_CLASSES, INITCOMMONCONTROLSEX,
        TTTOOLINFOW, TTF_IDISHWND, TTF_TRACK, TTM_ADDTOOLW, TTM_TRACKACTIVATE, TTM_TRACKPOSITION,
        TTS_ALWAYSTIP, TTS_NOPREFIX,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, GetWindowRect, PeekMessageW,
        SendMessageW, SetWindowPos, TranslateMessage, HWND_TOPMOST, MSG, PM_REMOVE, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, WINDOW_STYLE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    fn wide(s: &str) -> Vec<u16> { OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect() }

    let raw = std::env::args().nth(1).unwrap_or_else(||
        "Session\tWeekly\r\n70%\t90%\r\n\r\nMon\tMon\r\n3:20PM\t10:00AM".to_string()
    );
    // Allow literal "\t" / "\r\n" / "\n" sequences from argv.
    let text = raw.replace("\\r\\n", "\r\n").replace("\\n", "\n").replace("\\t", "\t");
    println!("tooltip text:\n{text}");

    // Common-controls init helps register the tooltips_class32 class on
    // older shells. Return value isn't reliable across builds, so we ignore it.
    unsafe {
        let icc = INITCOMMONCONTROLSEX {
            dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
            dwICC: ICC_BAR_CLASSES | ICC_STANDARD_CLASSES,
        };
        let _ = InitCommonControlsEx(&icc);
    }

    let h_instance = unsafe { GetModuleHandleW(PCWSTR::null())? };
    let class_static = wide("STATIC");
    // Unique-enough host name so concurrent runs don't fight.
    let host_title = wide(&format!("tooltip_preview_host_{}", std::process::id()));
    let class_tooltip = wide("tooltips_class32");
    let null_hwnd = HWND(std::ptr::null_mut());

    // Hidden host window (STATIC is a built-in window class so no RegisterClass needed).
    let host = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            PCWSTR(class_static.as_ptr()),
            PCWSTR(host_title.as_ptr()),
            WS_POPUP,
            0, 0, 1, 1,
            null_hwnd,
            None,
            h_instance,
            None,
        )?
    };

    // Tooltip control. TTS_ALWAYSTIP -> show even when host inactive.
    // TTS_NOPREFIX -> '&' is literal (we don't want accelerator parsing).
    let tooltip_style = WINDOW_STYLE(WS_POPUP.0 | TTS_ALWAYSTIP | TTS_NOPREFIX);
    let tooltip = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST,
            PCWSTR(class_tooltip.as_ptr()),
            PCWSTR::null(),
            tooltip_style,
            0, 0, 0, 0,
            host,
            None,
            h_instance,
            None,
        )?
    };

    // Topmost so the tooltip lands above any other window during capture.
    unsafe {
        SetWindowPos(tooltip, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)?;
    }

    let text_w = wide(&text);
    // Use the V3 cbSize that excludes lpReserved - matches what comctl32
    // expects when no manifest pins v6. The struct in windows-rs is the
    // v6 layout; we compute the v3 size by subtracting lpReserved (1 ptr).
    let cb_size_v3 = (std::mem::size_of::<TTTOOLINFOW>()
        - std::mem::size_of::<*mut core::ffi::c_void>()) as u32;
    let mut ti = TTTOOLINFOW {
        cbSize: cb_size_v3,
        uFlags: TTF_IDISHWND | TTF_TRACK,
        hwnd: host,
        uId: host.0 as usize,
        rect: RECT::default(),
        hinst: h_instance.into(),
        lpszText: windows::core::PWSTR(text_w.as_ptr() as *mut _),
        lParam: LPARAM(0),
        lpReserved: std::ptr::null_mut(),
    };

    // TTM_SETMAXTIPWIDTH with non-negative -> enables \n line wrapping.
    // Without it, multi-line tooltips render as a single truncated line.
    const TTM_SETMAXTIPWIDTH: u32 = 0x0400 + 24;
    unsafe {
        let added = SendMessageW(tooltip, TTM_ADDTOOLW, WPARAM(0),
            LPARAM(&mut ti as *mut _ as isize));
        if added.0 == 0 { return Err("TTM_ADDTOOLW failed".into()); }
        SendMessageW(tooltip, TTM_SETMAXTIPWIDTH, WPARAM(0), LPARAM(600));
        // Activate first, then position - matches MSDN tracking sample.
        SendMessageW(tooltip, TTM_TRACKACTIVATE, WPARAM(1),
            LPARAM(&ti as *const _ as isize));
        // Position tooltip top-left at (200, 200) so it lands fully on-screen.
        let pos = ((200i32 & 0xFFFF) | (200i32 << 16)) as isize;
        SendMessageW(tooltip, TTM_TRACKPOSITION, WPARAM(0), LPARAM(pos));
    }

    // Pump messages briefly so the tooltip control lays itself out / paints.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
    while std::time::Instant::now() < deadline {
        let mut msg = MSG::default();
        unsafe {
            while PeekMessageW(&mut msg, null_hwnd, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    // Capture the tooltip's window rect via BitBlt(screen DC -> mem DC).
    let mut rect = RECT::default();
    unsafe { GetWindowRect(tooltip, &mut rect)?; }
    let w = (rect.right - rect.left).max(1);
    let h = (rect.bottom - rect.top).max(1);
    println!("tooltip rect: {}x{} at ({}, {})", w, h, rect.left, rect.top);

    let png_bytes = unsafe {
        let screen_dc = GetDC(null_hwnd);
        let mem_dc = CreateCompatibleDC(screen_dc);
        let bmp = CreateCompatibleBitmap(screen_dc, w, h);
        let prev = SelectObject(mem_dc, bmp);
        BitBlt(mem_dc, 0, 0, w, h, screen_dc, rect.left, rect.top, SRCCOPY)?;

        // Pull pixels out via GetDIBits (top-down, 32bpp BGRA).
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // negative -> top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let got = GetDIBits(mem_dc, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _),
            &mut bi, DIB_RGB_COLORS);
        if got == 0 { return Err("GetDIBits returned 0".into()); }

        SelectObject(mem_dc, prev);
        let _ = DeleteObject(bmp);
        let _ = DeleteDC(mem_dc);
        ReleaseDC(null_hwnd, screen_dc);

        // BGRA -> RGBA
        for px in buf.chunks_exact_mut(4) { px.swap(0, 2); px[3] = 255; }
        buf
    };

    // Cleanup HWNDs before saving so a save error still doesn't leak windows.
    unsafe {
        SendMessageW(tooltip, TTM_TRACKACTIVATE, WPARAM(0),
            LPARAM(&ti as *const _ as isize));
        let _ = DestroyWindow(tooltip);
        let _ = DestroyWindow(host);
    }

    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("tooltip-preview.png");
    if let Some(parent) = out.parent() { std::fs::create_dir_all(parent)?; }
    let img = image::RgbaImage::from_raw(w as u32, h as u32, png_bytes)
        .ok_or("RgbaImage::from_raw failed (size mismatch)")?;
    img.save(&out)?;
    println!("wrote {}", out.display());
    Ok(())
}
