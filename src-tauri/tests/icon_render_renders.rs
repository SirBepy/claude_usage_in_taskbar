use claude_conductor_lib::tray::icon_render::{render, render_spin, urgency_rgb, DisplayMode, IconCtx, SIZE};
use claude_conductor_lib::tray::threshold::{
    ColorApplyTo, ColorMode, ColorStop, DefaultDisplay, IconSettings, IconStyle, PaceColors,
    SafePaceColorMode,
};
use image::GenericImageView;

fn test_settings() -> IconSettings {
    IconSettings {
        default_display: DefaultDisplay::Icon,
        icon_style: IconStyle::Rings,
        color_mode: ColorMode::Threshold,
        color_thresholds: vec![
            ColorStop { min: 0, color: "#00ff00".into() },
            ColorStop { min: 50, color: "#ff8800".into() },
            ColorStop { min: 80, color: "#ff0000".into() },
        ],
        pace_band: 10.0,
        pace_colors: PaceColors::default(),
        apply_color_to: ColorApplyTo::default(),
        safe_sess_color: SafePaceColorMode::Default,
        safe_weekly_color: SafePaceColorMode::Default,
    }
}

#[test]
fn png_header_correct() {
    let bytes = render(Some(40.0), Some(80.0), &IconCtx {
        settings: &test_settings(),
        display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
        updating: false,
    });
    assert_eq!(&bytes[0..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
}

#[test]
fn decoded_dimensions_are_32x32() {
    let bytes = render(Some(40.0), Some(80.0), &IconCtx {
        settings: &test_settings(),
        display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
        updating: false,
    });
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.width(), SIZE);
    assert_eq!(decoded.height(), SIZE);
}

#[test]
fn loading_state_renders_without_panicking() {
    let _ = render(None, None, &IconCtx {
        settings: &test_settings(),
        display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
        updating: false,
    });
}

#[test]
fn urgency_rgb_threshold_mode_selects_by_highest_reached_stop() {
    let s = test_settings();
    assert_eq!(urgency_rgb(Some(10.0), &s, None), [0, 255, 0]);
    assert_eq!(urgency_rgb(Some(55.0), &s, None), [255, 136, 0]);
    assert_eq!(urgency_rgb(Some(85.0), &s, None), [255, 0, 0]);
}

#[test]
fn urgency_rgb_loading_state_returns_blue() {
    let s = test_settings();
    let rgb = urgency_rgb(None, &s, None);
    assert_eq!(rgb, [74, 144, 226]);
}

#[test]
fn urgency_rgb_pace_mode_uses_pace_colors() {
    let mut s = test_settings();
    s.color_mode = ColorMode::Pace;
    let under = urgency_rgb(Some(20.0), &s, Some(40.0));
    let near_safe = urgency_rgb(Some(35.0), &s, Some(40.0));
    let near_over = urgency_rgb(Some(45.0), &s, Some(40.0));
    let over = urgency_rgb(Some(60.0), &s, Some(40.0));
    assert_ne!(under, near_safe);
    assert_ne!(near_safe, near_over);
    assert_ne!(near_over, over);
}

#[test]
fn aa_ring_has_soft_edges() {
    let bytes = render(Some(50.0), Some(50.0), &IconCtx {
        settings: &test_settings(),
        display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
        updating: false,
    });
    let img = image::load_from_memory(&bytes).unwrap();
    let edge = img.get_pixel(31, 16);
    assert!(edge[3] > 0 && edge[3] < 255, "expected AA alpha, got {}", edge[3]);
}

#[test]
fn apply_color_to_icon_false_grays_out_icon() {
    let mut s = test_settings();
    s.apply_color_to.icon = false;
    let bytes = render(Some(90.0), Some(10.0), &IconCtx {
        settings: &s,
        display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
        updating: false,
    });
    let img = image::load_from_memory(&bytes).unwrap();
    let mut has_red = false;
    for y in 0..img.height() {
        for x in 0..img.width() {
            let p = img.get_pixel(x, y);
            if p[3] > 100 && p[0] > 200 && p[1] < 50 && p[2] < 50 { has_red = true; }
        }
    }
    assert!(!has_red, "expected grayed icon, found red pixels");
}

#[test]
fn number_session_mode_renders_digits_centered() {
    let s = test_settings();
    let bytes = render(Some(45.0), Some(12.0), &IconCtx {
        settings: &s,
        display_mode: DisplayMode::NumberSession,
        session_safe: None, weekly_safe: None,
        updating: false,
    });
    let img = image::load_from_memory(&bytes).unwrap();
    let mut lit_center = 0;
    for y in 10..22 {
        for x in 0..32 {
            if img.get_pixel(x, y)[3] > 100 { lit_center += 1; }
        }
    }
    assert!(lit_center > 10, "expected '45' digits, found {lit_center} lit pixels");
}

#[test]
fn number_weekly_mode_does_not_panic_on_large_pct() {
    let s = test_settings();
    let _ = render(Some(10.0), Some(150.0), &IconCtx {
        settings: &s,
        display_mode: DisplayMode::NumberWeekly,
        session_safe: None, weekly_safe: None,
        updating: false,
    });
}

#[test]
fn render_spin_differs_from_static_render() {
    let s = test_settings();
    let ctx = IconCtx {
        settings: &s, display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
        updating: false,
    };
    let a = render(Some(50.0), Some(50.0), &ctx);
    let b = render_spin(0, Some(50.0), &ctx);
    assert_ne!(a, b, "spin frame should produce different bytes than static render");
}

#[test]
fn render_spin_frames_differ_from_each_other() {
    let s = test_settings();
    let ctx = IconCtx {
        settings: &s, display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
        updating: false,
    };
    let f0 = render_spin(0, Some(50.0), &ctx);
    let f5 = render_spin(5, Some(50.0), &ctx);
    assert_ne!(f0, f5);
}
