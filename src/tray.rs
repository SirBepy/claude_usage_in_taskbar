//! Builds the tray icon and its context menu; owns the render funnel.

use crate::display_state::effective_mode;
use crate::icon::{self, DisplayMode, IconCtx};
use crate::icon_settings::{IconSettings, TooltipSettings};
use crate::state::AppState;
use crate::types::{AuthState, UsageSnapshot};
use crate::usage_parser::{self, FIVE_HOUR_MS, SEVEN_DAY_MS};
use anyhow::Result;
use chrono::Utc;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri::{AppHandle, Listener, Manager};

pub const TRAY_ID: &str = "main-tray";

pub fn setup(app: &AppHandle) -> Result<()> {
    let initial_mute = app.state::<AppState>().settings.lock().unwrap().mute_all();
    let menu = build_menu(app, initial_mute)?;

    let idle_bytes = {
        let s = IconSettings::default();
        icon::render(None, None, &IconCtx {
            settings: &s, display_mode: DisplayMode::Icon,
            session_safe: None, weekly_safe: None,
        })
    };
    let idle_icon = Image::from_bytes(&idle_bytes)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(idle_icon)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Claude Usage")
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "open" => crate::ipc::open_dashboard(app.clone()),
                "refresh" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::scheduler::poll_once(&h, crate::scheduler::PollTrigger::Manual).await;
                    });
                }
                "quit" => app.exit(0),
                "mute-all" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        toggle_mute_all(h);
                    });
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up, ..
            } = event {
                on_left_click(tray.app_handle().clone());
            }
        })
        .build(app)?;

    // Listener: settings-changed -> invalidate cycle + rebuild menu + re-render.
    {
        let h = app.clone();
        app.listen("settings-changed", move |_| {
            {
                let st = h.state::<AppState>();
                st.display.lock().unwrap().invalidate_cycle();
            }
            let mute = h.state::<AppState>().settings.lock().unwrap().mute_all();
            if let Ok(new_menu) = build_menu(&h, mute) {
                if let Some(tray) = h.tray_by_id(TRAY_ID) {
                    let _ = tray.set_menu(Some(new_menu));
                }
            }
            render_tray_now(&h);
        });
    }

    // Listener: usage-updated -> re-render.
    {
        let h = app.clone();
        app.listen("usage-updated", move |_| render_tray_now(&h));
    }

    // Initial render from cached snapshot.
    render_tray_now(app);

    // Background reset ticker (1s granularity).
    let reset_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let changed = {
                let s = reset_handle.state::<AppState>();
                let result = s.display.lock().unwrap().tick(Instant::now());
                result
            };
            if changed { render_tray_now(&reset_handle); }
        }
    });

    Ok(())
}

fn on_left_click(app: AppHandle) {
    let logged_in = matches!(
        *app.state::<AppState>().auth_state.lock().unwrap(),
        AuthState::LoggedIn
    );
    if !logged_in {
        // Not logged in — kick login. `start_login` exists in ipc.rs.
        tauri::async_runtime::spawn(async move {
            let _ = crate::ipc::start_login(app).await;
        });
        return;
    }
    let default = IconSettings::try_from(&*app.state::<AppState>().settings.lock().unwrap())
        .unwrap_or_default().default_display;
    {
        let s = app.state::<AppState>();
        s.display.lock().unwrap().cycle_next(default, Instant::now());
    }
    render_tray_now(&app);
}

pub fn render_tray_now(app: &AppHandle) {
    let state = app.state::<AppState>();
    let snap: Option<UsageSnapshot> = state.current_usage.lock().unwrap().clone();
    let settings_guard = state.settings.lock().unwrap();
    let icon_s: IconSettings = (&*settings_guard).try_into().unwrap_or_default();
    let tip_s: TooltipSettings = (&*settings_guard).try_into().unwrap_or_default();
    drop(settings_guard);

    let st = state.display.lock().unwrap();
    let mode = effective_mode(icon_s.default_display, st.temp);
    let spin = st.spin_frame;
    drop(st);

    let sess = snap.as_ref().map(usage_parser::session_pct);
    let weekly = snap.as_ref().map(usage_parser::weekly_pct);
    let now = Utc::now();
    let sess_safe = snap.as_ref().and_then(|s|
        usage_parser::calc_safe_pct(&s.five_hour.resets_at, FIVE_HOUR_MS, now));
    let weekly_safe = snap.as_ref().and_then(|s|
        usage_parser::calc_safe_pct(&s.seven_day.resets_at, SEVEN_DAY_MS, now));

    let ctx = IconCtx { settings: &icon_s, display_mode: mode, session_safe: sess_safe, weekly_safe };

    let bytes = match spin {
        Some(f) => icon::render_spin(f, weekly, &ctx),
        None => icon::render(sess, weekly, &ctx),
    };
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return; };
    if let Ok(img) = Image::from_bytes(&bytes) { let _ = tray.set_icon(Some(img)); }
    let _ = tray.set_tooltip(Some(usage_parser::build_tooltip(snap.as_ref(), &tip_s, &icon_s, now)));
}

fn build_menu(app: &AppHandle, mute_all: bool) -> Result<Menu<tauri::Wry>> {
    let mute = CheckMenuItemBuilder::with_id("mute-all", "Mute Notifications")
        .checked(mute_all)
        .build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "Open Dashboard").build(app)?)
        .item(&MenuItemBuilder::with_id("refresh", "Refresh Now").build(app)?)
        .separator()
        .item(&mute)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;
    Ok(menu)
}

fn toggle_mute_all(app: AppHandle) {
    use crate::paths;
    use tauri::Emitter;
    let state = app.state::<AppState>();
    let updated = {
        let mut s = state.settings.lock().unwrap();
        let current = s.mute_all();
        s.extra.insert("muteAll".into(), serde_json::Value::Bool(!current));
        s.clone()
    };
    if let Ok(path) = paths::settings_file() {
        if let Err(e) = crate::settings::save(&path, &updated) {
            log::warn!("persist mute toggle failed: {e}");
        }
    }
    let _ = app.emit("settings-changed", &updated);
}
