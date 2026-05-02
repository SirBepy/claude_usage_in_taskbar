use claude_usage_tauri_lib::tray::icon_render as icon;
use claude_usage_tauri_lib::tray::icon_render::{DisplayMode, IconCtx};
use claude_usage_tauri_lib::tray::threshold::{IconSettings, IconStyle};

#[test]
fn switching_icon_style_changes_rendered_bytes() {
    let mut s = IconSettings::default();
    let rings = icon::render(Some(50.0), Some(50.0), &IconCtx {
        settings: &s, display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None, updating: false,
    });
    s.icon_style = IconStyle::Bars;
    let bars = icon::render(Some(50.0), Some(50.0), &IconCtx {
        settings: &s, display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None, updating: false,
    });
    assert_ne!(rings, bars, "bars and rings must produce different pixel bytes");
}
