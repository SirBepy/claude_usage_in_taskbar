//! System-wide user-idle detection for the push-notification gate. The phone is
//! only buzzed when Joe has stepped away from the PC, so we need "seconds since
//! the last input anywhere in the user's session" - not app focus.
//!
//! The daemon runs in the user's interactive session (spawned DETACHED with
//! CREATE_BREAKAWAY_FROM_JOB, see `spawn_self.rs`), so `GetLastInputInfo`
//! reports real session-wide idle from here. Off Windows there is no equivalent
//! we rely on, so we return 0 (never idle) - the gate then never opens, and push
//! stays a Windows-desktop-away feature.

/// Seconds since the last keyboard/mouse input anywhere in the user's session.
#[cfg(windows)]
pub fn idle_secs() -> u64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a correctly-sized LASTINPUTINFO with cbSize set;
    // GetLastInputInfo only writes dwTime and returns FALSE solely on a bad
    // cbSize, which we set correctly. Treat a FALSE return as "not idle" (0).
    let ok = unsafe { GetLastInputInfo(&mut info) };
    if !ok.as_bool() {
        return 0;
    }
    let now = unsafe { GetTickCount() };
    // Both are u32 millisecond tick counts from the same clock; wrapping_sub
    // handles the ~49.7-day GetTickCount rollover correctly.
    let idle_ms = now.wrapping_sub(info.dwTime);
    (idle_ms / 1000) as u64
}

#[cfg(not(windows))]
pub fn idle_secs() -> u64 {
    0
}
