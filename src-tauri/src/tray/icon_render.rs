//! Renders the 32x32 tray icon as RGBA PNG bytes.
//!
//! Ports the AA blend model from `src/core/icon.js` — every pixel in the
//! icon range gets a soft alpha based on distance from the ring's boundary,
//! then blended over whatever is already in the buffer (pre-multiplied).

use crate::tray::threshold::{ColorMode, IconSettings, IconStyle};
use crate::tray::bars;
use image::{ImageBuffer, ImageEncoder, Rgba, RgbaImage};

pub const SIZE: u32 = 32;
const CX: f32 = SIZE as f32 / 2.0;
const CY: f32 = SIZE as f32 / 2.0;

const OUTER_R_OUT: f32 = 15.0;
const OUTER_R_IN:  f32 = 11.0;
const INNER_R_OUT: f32 = 8.0;
const INNER_R_IN:  f32 = 5.0;

pub(super) const TRACK: [u8; 3] = [60, 60, 60];
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
    /// Multi-account milestone 06: `TrayContentMode::Nothing` — a plain,
    /// neutral icon face with no usage data drawn (reuses the existing
    /// idle-gray double ring rather than a bespoke logo asset).
    Plain,
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
    let cx = SIZE as f32 - 6.0;
    let cy = SIZE as f32 - 6.0;
    let r = 4.0;
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
        DisplayMode::Plain => {
            draw_ring_arc(&mut img, Some(100.0), OUTER_R_OUT, OUTER_R_IN, IDLE_GRAY);
            draw_ring_arc(&mut img, Some(100.0), INNER_R_OUT, INNER_R_IN, IDLE_GRAY);
        }
        DisplayMode::Icon => {
            if idle {
                draw_ring_arc(&mut img, Some(100.0), OUTER_R_OUT, OUTER_R_IN, IDLE_GRAY);
                draw_ring_arc(&mut img, Some(100.0), INNER_R_OUT, INNER_R_IN, IDLE_GRAY);
            } else if ctx.settings.icon_style == IconStyle::Bars {
                bars::draw_bars(&mut img, sess, weekly, ctx);
            } else if ctx.settings.icon_style == IconStyle::FourBars {
                bars::draw_four_bars(&mut img, sess, weekly, ctx);
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

pub(super) fn color_for(pct: Option<f32>, ctx: &IconCtx, safe: Option<f32>, is_icon: bool) -> [u8; 3] {
    if is_icon && !ctx.settings.apply_color_to.icon { return NEUTRAL_GRAY; }
    if !is_icon && !ctx.settings.apply_color_to.number { return NEUTRAL_GRAY; }
    urgency_rgb(pct, ctx.settings, safe)
}

fn overlay_size_px(text: &str) -> f32 {
    match text.chars().count() {
        0 | 1 => 34.0,
        2 => 32.0,
        _ => 23.0,
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
        bars::render_spin_bars(&mut img, frame, weekly, ctx);
    } else if ctx.settings.icon_style == IconStyle::FourBars {
        bars::render_spin_four_bars(&mut img, frame, weekly, ctx);
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

