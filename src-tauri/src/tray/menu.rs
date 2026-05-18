//! Builds the tray icon and its context menu; owns the render funnel.

use crate::tray::display_mode::effective_mode;
use crate::tray::icon_render::{self as icon, DisplayMode, IconCtx};
use crate::tray::threshold::{IconSettings, TooltipSettings};
use crate::state::AppState;
use crate::types::{AuthState, UsageSnapshot};
use crate::scraping::{self as usage_parser, FIVE_HOUR_MS, SEVEN_DAY_MS};
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
    let initial_update = app.state::<AppState>().update_state.lock().unwrap().clone();
    let menu = build_menu(app, initial_mute, &initial_update)?;

    let idle_bytes = {
        let s = IconSettings::default();
        icon::render(None, None, &IconCtx {
            settings: &s, display_mode: DisplayMode::Icon,
            session_safe: None, weekly_safe: None,
            updating: false,
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
                "open-chats" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::ipc::open_chats_window(h);
                    });
                }
                "refresh" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::scheduler::poll_once(&h, crate::scheduler::PollTrigger::Manual).await;
                    });
                }
                "quit" => {
                    // Kill any in-flight runner children so we don't leak
                    // claude.exe orphans. Drains ChatState.running before exit.
                    crate::ipc::chat::cancel_all_inflight_turns(app);
                    app.exit(0);
                }
                "mute-all" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        toggle_mute_all(h);
                    });
                }
                "update-install" => {
                    crate::ipc::install_update(app.clone());
                }
                "update-download" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::ipc::download_and_install_update(h).await;
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
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || {
                {
                    let st = h2.state::<AppState>();
                    st.display.lock().unwrap().invalidate_cycle();
                }
                let mute = h2.state::<AppState>().settings.lock().unwrap().mute_all();
                let update = h2.state::<AppState>().update_state.lock().unwrap().clone();
                if let Ok(new_menu) = build_menu(&h2, mute, &update) {
                    if let Some(tray) = h2.tray_by_id(TRAY_ID) {
                        let _ = tray.set_menu(Some(new_menu));
                    }
                }
                render_tray_now(&h2);
            });
        });
    }

    // Listener: usage-updated -> re-render.
    {
        let h = app.clone();
        app.listen("usage-updated", move |_| {
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || render_tray_now(&h2));
        });
    }

    // Listener: update-state -> rebuild menu (badge label/items) + re-render badge.
    {
        let h = app.clone();
        app.listen("update-state", move |_| {
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || {
                let mute = h2.state::<AppState>().settings.lock().unwrap().mute_all();
                let update = h2.state::<AppState>().update_state.lock().unwrap().clone();
                if let Ok(new_menu) = build_menu(&h2, mute, &update) {
                    if let Some(tray) = h2.tray_by_id(TRAY_ID) {
                        let _ = tray.set_menu(Some(new_menu));
                    }
                }
                render_tray_now(&h2);
            });
        });
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
            if changed {
                let h = reset_handle.clone();
                let _ = reset_handle.run_on_main_thread(move || render_tray_now(&h));
            }
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
    let h = app.clone();
    let _ = app.run_on_main_thread(move || render_tray_now(&h));
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

    let updating = {
        let s = state.update_state.lock().unwrap();
        matches!(s.get("state").and_then(|v| v.as_str()), Some("downloading") | Some("downloaded"))
    };
    let ctx = IconCtx { settings: &icon_s, display_mode: mode, session_safe: sess_safe, weekly_safe, updating };

    let bytes = match spin {
        Some(f) => icon::render_spin(f, weekly, &ctx),
        None => icon::render(sess, weekly, &ctx),
    };
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return; };
    if let Ok(img) = Image::from_bytes(&bytes) {
        let _ = tray.set_icon(Some(img));
        #[cfg(target_os = "macos")]
        let _ = tray.set_icon_as_template(false);
    }
    let _ = tray.set_tooltip(Some(usage_parser::build_tooltip(snap.as_ref(), &tip_s, &icon_s, now)));
}

fn build_menu(app: &AppHandle, mute_all: bool, update: &serde_json::Value) -> Result<Menu<tauri::Wry>> {
    let mute = CheckMenuItemBuilder::with_id("mute-all", "Mute Notifications")
        .checked(mute_all)
        .build(app)?;
    let mut builder = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "Open Dashboard").build(app)?)
        .item(&MenuItemBuilder::with_id("open-chats", "Open Chats").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("refresh", "Refresh Now").build(app)?)
        .item(&mute);

    let state = update.get("state").and_then(|v| v.as_str()).unwrap_or("");
    let version = update.get("version").and_then(|v| v.as_str()).unwrap_or("");
    match state {
        "downloading" => {
            builder = builder.separator().item(
                &MenuItemBuilder::with_id("update-downloading", format!("Downloading update v{version}..."))
                    .enabled(false)
                    .build(app)?,
            );
        }
        "downloaded" => {
            builder = builder.separator().item(
                &MenuItemBuilder::with_id("update-install", format!("Install update v{version}"))
                    .build(app)?,
            );
        }
        "available" => {
            builder = builder.separator().item(
                &MenuItemBuilder::with_id("update-download", format!("Download update v{version}"))
                    .build(app)?,
            );
        }
        "error" => {
            builder = builder.separator().item(
                &MenuItemBuilder::with_id("update-error", "Update failed")
                    .enabled(false)
                    .build(app)?,
            );
        }
        _ => {}
    }

    let menu = builder
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;
    Ok(menu)
}

fn toggle_mute_all(app: AppHandle) {
    use crate::settings::paths;
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
