use crate::tray::threshold::SafePaceColorMode;
use image::{Rgba, RgbaImage};
use super::icon_render::{IconCtx, color_for, TRACK};

const SAFE_PACE_COLOR: [u8; 3] = [100, 150, 220];

pub(super) fn resolve_safe_color(mode: SafePaceColorMode, urgency: [u8; 3]) -> [u8; 3] {
    match mode {
        SafePaceColorMode::Default => SAFE_PACE_COLOR,
        SafePaceColorMode::Urgency => urgency,
        SafePaceColorMode::Fixed(rgb) => rgb,
    }
}

pub(super) fn draw_four_bars(img: &mut RgbaImage, sess: Option<f32>, weekly: Option<f32>, ctx: &IconCtx) {
    let sess_color = color_for(sess, ctx, ctx.session_safe, true);
    let weekly_color = color_for(weekly, ctx, ctx.weekly_safe, true);
    let sess_safe_color = resolve_safe_color(ctx.settings.safe_sess_color, sess_color);
    let weekly_safe_color = resolve_safe_color(ctx.settings.safe_weekly_color, weekly_color);
    // [sess-actual|sess-safe] 4px gap [weekly-actual|weekly-safe] — 7px each, no intra-group gap
    draw_column(img, 0, 6, sess.unwrap_or(0.0), sess_color);
    draw_column(img, 7, 13, ctx.session_safe.unwrap_or(0.0), sess_safe_color);
    draw_column(img, 18, 24, weekly.unwrap_or(0.0), weekly_color);
    draw_column(img, 25, 31, ctx.weekly_safe.unwrap_or(0.0), weekly_safe_color);
}

pub(super) fn draw_bars(img: &mut RgbaImage, sess: Option<f32>, weekly: Option<f32>, ctx: &IconCtx) {
    let sess_color = color_for(sess, ctx, ctx.session_safe, /*is_icon=*/true);
    let weekly_color = color_for(weekly, ctx, ctx.weekly_safe, true);
    draw_column(img, 4, 13, sess.unwrap_or(0.0), sess_color);
    draw_column(img, 18, 27, weekly.unwrap_or(0.0), weekly_color);
}

pub(super) fn render_spin_bars(img: &mut RgbaImage, frame: u32, weekly: Option<f32>, ctx: &IconCtx) {
    let blue = [74u8, 144, 226];
    let pulse = ((frame as f32 * 0.2).sin()).abs();
    let alpha = (150.0 + pulse * 105.0).round() as u8;
    for y in 2..=30 {
        for x in 4..=13 {
            img.put_pixel(x, y, Rgba([blue[0], blue[1], blue[2], alpha]));
        }
    }
    draw_column(img, 18, 27, weekly.unwrap_or(0.0),
                color_for(weekly, ctx, ctx.weekly_safe, /*is_icon=*/true));
}

pub(super) fn render_spin_four_bars(img: &mut RgbaImage, frame: u32, weekly: Option<f32>, ctx: &IconCtx) {
    let blue = [74u8, 144, 226];
    let pulse = ((frame as f32 * 0.2).sin()).abs();
    let alpha = (150.0 + pulse * 105.0).round() as u8;
    for y in 2..=30 {
        for x in 0..=6 { img.put_pixel(x, y, Rgba([blue[0], blue[1], blue[2], alpha])); }
        for x in 7..=13 { img.put_pixel(x, y, Rgba([blue[0], blue[1], blue[2], alpha])); }
    }
    let wc = color_for(weekly, ctx, ctx.weekly_safe, true);
    draw_column(img, 18, 24, weekly.unwrap_or(0.0), wc);
    draw_column(img, 25, 31, ctx.weekly_safe.unwrap_or(0.0),
                resolve_safe_color(ctx.settings.safe_weekly_color, wc));
}

pub(super) fn draw_column(img: &mut RgbaImage, x0: u32, x1: u32, pct: f32, fg: [u8; 3]) {
    let fill_h = (pct.clamp(0.0, 100.0) / 100.0) * 28.0;
    for y in 2..=30u32 {
        let filled = (30 - y) as f32 <= fill_h;
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

#[cfg(test)]
mod tests {
    use super::super::icon_render::{render, IconCtx, DisplayMode};
    use crate::tray::threshold::{IconSettings, IconStyle};
    use image::GenericImageView;

    #[test]
    fn bars_mode_fills_left_column_for_session_pct() {
        let mut s = IconSettings::default();
        s.icon_style = IconStyle::Bars;
        let bytes = render(Some(80.0), Some(20.0), &IconCtx {
            settings: &s,
            display_mode: DisplayMode::Icon,
            session_safe: None, weekly_safe: None,
            updating: false,
        });
        let img = image::load_from_memory(&bytes).unwrap();
        let mut left_filled = 0;
        let mut right_filled = 0;
        for y in 2..=30 {
            for x in 4..=13 {
                if img.get_pixel(x, y)[3] == 255 { left_filled += 1; }
            }
            for x in 18..=27 {
                if img.get_pixel(x, y)[3] == 255 { right_filled += 1; }
            }
        }
        assert!(left_filled > right_filled, "session 80% should fill more than weekly 20%");
    }
}
