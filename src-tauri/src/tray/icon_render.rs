//! Renders the 22x22 tray icon as RGBA PNG bytes.
//!
//! Ports the AA blend model from `src/core/icon.js` — every pixel in the
//! icon range gets a soft alpha based on distance from the ring's boundary,
//! then blended over whatever is already in the buffer (pre-multiplied).

use crate::tray::threshold::{ColorMode, IconSettings, IconStyle};
use image::{ImageBuffer, ImageEncoder, Rgba, RgbaImage};

pub const SIZE: u32 = 22;
const CX: f32 = SIZE as f32 / 2.0;
const CY: f32 = SIZE as f32 / 2.0;

const OUTER_R_OUT: f32 = 10.5;
const OUTER_R_IN:  f32 = 7.5;
const INNER_R_OUT: f32 = 5.5;
const INNER_R_IN:  f32 = 3.5;

const TRACK: [u8; 3] = [60, 60, 60];
const SAFE_PACE_COLOR: [u8; 3] = [100, 150, 220];
const TRACK_ALPHA: u8 = 80;
const LOADING: [u8; 3] = [74, 144, 226];
const NEUTRAL_GRAY: [u8; 3] = [200, 200, 200];
const IDLE_GRAY:    [u8; 3] = [120, 120, 120];
const FALLBACK_COLOR: [u8; 3] = [74, 144, 226];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayMode {
    Icon,
    NumberSession,
    NumberWeekly,
}

pub struct IconCtx<'a> {
    pub settings: &'a IconSettings,
    pub display_mode: DisplayMode,
    pub session_safe: Option<f32>,
    pub weekly_safe: Option<f32>,
    pub updating: bool,
}

/// Paints a small filled circle in the bottom-right corner so users can see at
/// a glance that an update is downloading or staged.
fn paint_update_badge(img: &mut RgbaImage) {
    const BADGE_COLOR: [u8; 3] = [74, 144, 226];
    let cx = SIZE as f32 - 4.0;
    let cy = SIZE as f32 - 4.0;
    let r = 3.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - cx + 0.5;
            let dy = y as f32 - cy + 0.5;
            let d = (dx * dx + dy * dy).sqrt();
            if d <= r + 0.5 {
                let alpha = if d <= r - 0.5 { 255.0 } else { 255.0 * (r + 0.5 - d) };
                let a = alpha.clamp(0.0, 255.0) as u8;
                img.put_pixel(x, y, Rgba([BADGE_COLOR[0], BADGE_COLOR[1], BADGE_COLOR[2], a]));
            }
        }
    }
}

pub fn render(sess: Option<f32>, weekly: Option<f32>, ctx: &IconCtx) -> Vec<u8> {
    let mut img: RgbaImage = ImageBuffer::from_pixel(SIZE, SIZE, Rgba([0, 0, 0, 0]));
    let idle = sess.is_none() && weekly.is_none();

    match ctx.display_mode {
        DisplayMode::Icon => {
            if idle {
                draw_ring_arc(&mut img, Some(100.0), OUTER_R_OUT, OUTER_R_IN, IDLE_GRAY);
                draw_ring_arc(&mut img, Some(100.0), INNER_R_OUT, INNER_R_IN, IDLE_GRAY);
            } else if ctx.settings.icon_style == IconStyle::Bars {
                draw_bars(&mut img, sess, weekly, ctx);
            } else if ctx.settings.icon_style == IconStyle::FourBars {
                draw_four_bars(&mut img, sess, weekly, ctx);
            } else {
                draw_ring_arc(&mut img, sess,    OUTER_R_OUT, OUTER_R_IN, color_for(sess,   ctx, ctx.session_safe, true));
                draw_ring_arc(&mut img, weekly,  INNER_R_OUT, INNER_R_IN, color_for(weekly, ctx, ctx.weekly_safe,  true));
            }
        }
        DisplayMode::NumberSession | DisplayMode::NumberWeekly => {
            let (pct, safe) = match ctx.display_mode {
                DisplayMode::NumberSession => (sess, ctx.session_safe),
                DisplayMode::NumberWeekly  => (weekly, ctx.weekly_safe),
                _ => unreachable!(),
            };
            let Some(pct) = pct else {
                // no data — draw dim rings like idle state
                draw_ring_arc(&mut img, Some(100.0), OUTER_R_OUT, OUTER_R_IN, IDLE_GRAY);
                return encode_png(&img);
            };
            let val = (pct.round() as i32).clamp(0, 99) as u32;
            let text = val.to_string();
            let size_px = overlay_size_px(&text);
            let (tw, th) = crate::tray::fonts::measure_text(&text, size_px);
            let x = ((SIZE as i32 - tw as i32) / 2).max(0);
            let y = ((SIZE as i32 - th as i32) / 2).max(0);
            let color = color_for(Some(pct), ctx, safe, /*is_icon=*/false);
            crate::tray::fonts::draw_text(&mut img, &text, x, y, color, size_px);
        }
    }
    if ctx.updating { paint_update_badge(&mut img); }
    encode_png(&img)
}

fn color_for(pct: Option<f32>, ctx: &IconCtx, safe: Option<f32>, is_icon: bool) -> [u8; 3] {
    if is_icon && !ctx.settings.apply_color_to.icon { return NEUTRAL_GRAY; }
    if !is_icon && !ctx.settings.apply_color_to.number { return NEUTRAL_GRAY; }
    urgency_rgb(pct, ctx.settings, safe)
}

fn overlay_size_px(text: &str) -> f32 {
    match text.chars().count() {
        0 | 1 => 24.0,
        2 => 22.0,
        _ => 16.0,
    }
}

pub fn urgency_rgb(pct: Option<f32>, s: &IconSettings, safe: Option<f32>) -> [u8; 3] {
    let Some(pct) = pct else { return LOADING; };
    if s.color_mode == ColorMode::Pace {
        if let Some(safe) = safe {
            let b = s.pace_band;
            let hex = if pct < safe - b { &s.pace_colors.under }
                      else if pct < safe { &s.pace_colors.near_safe }
                      else if pct < safe + b { &s.pace_colors.near_over }
                      else { &s.pace_colors.over };
            return hex_to_rgb(hex).unwrap_or(FALLBACK_COLOR);
        }
    }
    let mut color = s.color_thresholds.first().map(|t| t.color.as_str()).unwrap_or("#4a90e2");
    for stop in &s.color_thresholds {
        if pct >= stop.min as f32 { color = &stop.color; } else { break; }
    }
    hex_to_rgb(color).unwrap_or(FALLBACK_COLOR)
}

fn hex_to_rgb(hex: &str) -> Option<[u8; 3]> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 { return None; }
    Some([
        u8::from_str_radix(&h[0..2], 16).ok()?,
        u8::from_str_radix(&h[2..4], 16).ok()?,
        u8::from_str_radix(&h[4..6], 16).ok()?,
    ])
}

fn draw_ring_arc(img: &mut RgbaImage, pct: Option<f32>, r_out: f32, r_in: f32, fg: [u8; 3]) {
    let filled_angle = pct.map(|p| (p.min(100.0) / 100.0) * std::f32::consts::TAU).unwrap_or(0.0);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - CX + 0.5;
            let dy = y as f32 - CY + 0.5;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist < r_in - 1.0 || dist > r_out + 1.0 { continue; }

            let edge_alpha = ((dist - (r_in - 1.0)).min(1.0)) * ((r_out + 1.0 - dist).min(1.0));
            if edge_alpha <= 0.0 { continue; }

            let mut angle = dx.atan2(-dy);
            if angle < 0.0 { angle += std::f32::consts::TAU; }
            let in_filled = angle <= filled_angle;

            let cur = img.get_pixel(x, y).0;
            let src_a = cur[3] as f32 / 255.0;
            let dst_a = if in_filled { edge_alpha } else { (TRACK_ALPHA as f32 / 255.0) * edge_alpha };
            let out_a = dst_a + src_a * (1.0 - dst_a);
            if out_a < 0.004 { continue; }

            let (fr, fg_c, fb) = if in_filled { (fg[0], fg[1], fg[2]) } else { (TRACK[0], TRACK[1], TRACK[2]) };
            let blend = |dst: u8, src: u8| -> u8 {
                let d = dst as f32;
                let s = src as f32;
                ((s * dst_a + d * src_a * (1.0 - dst_a)) / out_a).round() as u8
            };
            img.put_pixel(x, y, Rgba([
                blend(cur[0], fr),
                blend(cur[1], fg_c),
                blend(cur[2], fb),
                (out_a * 255.0).round() as u8,
            ]));
        }
    }
}

fn draw_four_bars(img: &mut RgbaImage, sess: Option<f32>, weekly: Option<f32>, ctx: &IconCtx) {
    let sess_color = color_for(sess, ctx, ctx.session_safe, true);
    let weekly_color = color_for(weekly, ctx, ctx.weekly_safe, true);
    // session actual | session safe pace | weekly actual | weekly safe pace
    draw_column(img, 1, 4, sess.unwrap_or(0.0), sess_color);
    draw_column(img, 6, 9, ctx.session_safe.unwrap_or(0.0), SAFE_PACE_COLOR);
    draw_column(img, 12, 15, weekly.unwrap_or(0.0), weekly_color);
    draw_column(img, 17, 20, ctx.weekly_safe.unwrap_or(0.0), SAFE_PACE_COLOR);
}

fn draw_bars(img: &mut RgbaImage, sess: Option<f32>, weekly: Option<f32>, ctx: &IconCtx) {
    let sess_color = color_for(sess, ctx, ctx.session_safe, /*is_icon=*/true);
    let weekly_color = color_for(weekly, ctx, ctx.weekly_safe, true);
    draw_column(img, 3, 8, sess.unwrap_or(0.0), sess_color);
    draw_column(img, 13, 18, weekly.unwrap_or(0.0), weekly_color);
}

fn draw_column(img: &mut RgbaImage, x0: u32, x1: u32, pct: f32, fg: [u8; 3]) {
    let fill_h = (pct.clamp(0.0, 100.0) / 100.0) * 18.0;
    for y in 2..=20u32 {
        let filled = (20 - y) as f32 <= fill_h;
        let (r, g, b, a) = if filled {
            (fg[0], fg[1], fg[2], 255)
        } else {
            (TRACK[0], TRACK[1], TRACK[2], 80)
        };
        for x in x0..=x1 {
            img.put_pixel(x, y, Rgba([r, g, b, a]));
        }
    }
}

fn encode_png(img: &RgbaImage) -> Vec<u8> {
    let mut buf = Vec::with_capacity(4096);
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .expect("png encode");
    buf
}

pub fn render_spin(frame: u32, weekly: Option<f32>, ctx: &IconCtx) -> Vec<u8> {
    let mut img: RgbaImage = ImageBuffer::from_pixel(SIZE, SIZE, Rgba([0, 0, 0, 0]));
    let arc_len = std::f32::consts::PI * 0.6;
    let start = (frame as f32 * 0.28) % std::f32::consts::TAU;

    if ctx.settings.icon_style == IconStyle::Bars {
        // bars: pulse session column blue, weekly steady.
        let blue = [74u8, 144, 226];
        let pulse = ((frame as f32 * 0.2).sin()).abs();
        let alpha = (150.0 + pulse * 105.0).round() as u8;
        for y in 2..=20 {
            for x in 3..=8 {
                img.put_pixel(x, y, Rgba([blue[0], blue[1], blue[2], alpha]));
            }
        }
        draw_column(&mut img, 13, 18, weekly.unwrap_or(0.0),
                    color_for(weekly, ctx, ctx.weekly_safe, /*is_icon=*/true));
    } else if ctx.settings.icon_style == IconStyle::FourBars {
        // four-bars: pulse both session columns (actual + safe), weekly steady.
        let blue = [74u8, 144, 226];
        let pulse = ((frame as f32 * 0.2).sin()).abs();
        let alpha = (150.0 + pulse * 105.0).round() as u8;
        for y in 2..=20 {
            for x in 1..=4 { img.put_pixel(x, y, Rgba([blue[0], blue[1], blue[2], alpha])); }
            for x in 6..=9 { img.put_pixel(x, y, Rgba([blue[0], blue[1], blue[2], alpha])); }
        }
        draw_column(&mut img, 12, 15, weekly.unwrap_or(0.0),
                    color_for(weekly, ctx, ctx.weekly_safe, true));
        draw_column(&mut img, 17, 20, ctx.weekly_safe.unwrap_or(0.0), SAFE_PACE_COLOR);
    } else {
        draw_spin_arc(&mut img, start, arc_len, OUTER_R_OUT, OUTER_R_IN, LOADING);
        draw_ring_arc(&mut img, weekly, INNER_R_OUT, INNER_R_IN,
                      color_for(weekly, ctx, ctx.weekly_safe, true));
    }
    if ctx.updating { paint_update_badge(&mut img); }
    encode_png(&img)
}

fn draw_spin_arc(img: &mut RgbaImage, start: f32, arc_len: f32, r_out: f32, r_in: f32, fg: [u8; 3]) {
    let end = start + arc_len;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - CX + 0.5;
            let dy = y as f32 - CY + 0.5;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist < r_in - 1.0 || dist > r_out + 1.0 { continue; }
            let edge_alpha = ((dist - (r_in - 1.0)).min(1.0)) * ((r_out + 1.0 - dist).min(1.0));
            let mut angle = dx.atan2(-dy);
            if angle < 0.0 { angle += std::f32::consts::TAU; }
            let in_arc = if end > std::f32::consts::TAU {
                angle >= start || angle <= end - std::f32::consts::TAU
            } else {
                angle >= start && angle <= end
            };
            if !in_arc { continue; }
            let a = (edge_alpha * 255.0) as u8;
            img.put_pixel(x, y, Rgba([fg[0], fg[1], fg[2], a]));
        }
    }
}

/// Back-compat: existing tray.rs call site uses `render_rings(Some, Some)`.
/// Forwards to `render` with default-ish IconCtx. Once tray.rs is updated in a
/// later task this function can be removed.
pub fn render_rings(sess: Option<f32>, weekly: Option<f32>) -> Vec<u8> {
    let settings = IconSettings::default();
    render(sess, weekly, &IconCtx {
        settings: &settings,
        display_mode: DisplayMode::Icon,
        session_safe: None, weekly_safe: None,
        updating: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tray::threshold::{ColorApplyTo, ColorMode, ColorStop, IconSettings, IconStyle, PaceColors, DefaultDisplay};
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
    fn decoded_dimensions_are_22x22() {
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
        // pct < safe-band = under
        let under = urgency_rgb(Some(20.0), &s, Some(40.0));
        // pct in [safe-band, safe) = near_safe
        let near_safe = urgency_rgb(Some(35.0), &s, Some(40.0));
        // pct in [safe, safe+band) = near_over
        let near_over = urgency_rgb(Some(45.0), &s, Some(40.0));
        // pct >= safe+band = over
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
        // Sample a pixel near the outer ring's outer edge.
        // center=11,11; r_out=10.5. Pixel (21, 11) is right at the outer edge.
        let edge = img.get_pixel(21, 11);
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
        // Scan all colored pixels; none should be red (threshold mode at 90%).
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
        // Count lit pixels in the center band (rows 7-14)
        let mut lit_center = 0;
        for y in 7..15 {
            for x in 0..22 {
                if img.get_pixel(x, y)[3] > 100 { lit_center += 1; }
            }
        }
        assert!(lit_center > 10, "expected '45' digits, found {lit_center} lit pixels");
    }

    #[test]
    fn number_weekly_mode_does_not_panic_on_large_pct() {
        // If weekly=150 we should still render a max of 99 (no overflow).
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

    #[test]
    fn bars_mode_fills_left_column_for_session_pct() {
        let mut s = test_settings();
        s.icon_style = IconStyle::Bars;
        let bytes = render(Some(80.0), Some(20.0), &IconCtx {
            settings: &s,
            display_mode: DisplayMode::Icon,
            session_safe: None, weekly_safe: None,
            updating: false,
        });
        let img = image::load_from_memory(&bytes).unwrap();
        // Left bar x∈[3,8] — count fully-opaque pixels in that column range.
        let mut left_filled = 0;
        let mut right_filled = 0;
        for y in 2..=20 {
            for x in 3..=8 {
                if img.get_pixel(x, y)[3] == 255 { left_filled += 1; }
            }
            for x in 13..=18 {
                if img.get_pixel(x, y)[3] == 255 { right_filled += 1; }
            }
        }
        assert!(left_filled > right_filled, "session 80% should fill more than weekly 20%");
    }
}
