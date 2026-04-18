//! Builds the tray icon and context menu.

use crate::icon::render_rings;
use crate::state::AppState;
use crate::types::UsageSnapshot;
use anyhow::Result;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri::{AppHandle, Manager, Listener};

pub const TRAY_ID: &str = "main-tray";

pub fn setup(app: &AppHandle) -> Result<()> {
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "Open Dashboard").build(app)?)
        .item(&MenuItemBuilder::with_id("refresh", "Refresh Now").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
        .build()?;

    let icon_bytes = render_rings(None, None);
    let icon = Image::from_bytes(&icon_bytes)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
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
                        let _ = crate::scheduler::poll_once(&h).await;
                    });
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let h = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::scheduler::poll_once(&h).await;
                });
            }
        })
        .build(app)?;

    // Listen for usage-updated to refresh icon bitmap.
    let app_clone = app.clone();
    app.listen("usage-updated", move |ev| {
        if let Ok(snap) = serde_json::from_str::<UsageSnapshot>(ev.payload()) {
            let bytes = render_rings(
                Some(snap.five_hour.utilization as f32),
                Some(snap.seven_day.utilization as f32),
            );
            if let Some(tray) = app_clone.tray_by_id(TRAY_ID) {
                if let Ok(img) = Image::from_bytes(&bytes) {
                    let _ = tray.set_icon(Some(img));
                }
            }
        }
    });

    // Update icon immediately from cached state if we have one.
    {
        let state = app.state::<AppState>();
        let cached = state.current_usage.lock().unwrap().clone();
        if let Some(snap) = cached {
            let bytes = render_rings(
                Some(snap.five_hour.utilization as f32),
                Some(snap.seven_day.utilization as f32),
            );
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                if let Ok(img) = Image::from_bytes(&bytes) {
                    let _ = tray.set_icon(Some(img));
                }
            }
        }
    }

    Ok(())
}
