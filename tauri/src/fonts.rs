//! TTF-based text rasterizer. Uses Inter SemiBold bundled at compile time.
//! Composites anti-aliased glyphs into an existing RgbaImage via source-over.

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use image::{Rgba, RgbaImage};
use std::sync::OnceLock;

const FONT_BYTES: &[u8] = include_bytes!("../assets/Inter-SemiBold.ttf");

fn font() -> &'static FontRef<'static> {
    static FONT: OnceLock<FontRef<'static>> = OnceLock::new();
    FONT.get_or_init(|| FontRef::try_from_slice(FONT_BYTES).expect("embedded font is valid TTF"))
}

/// Rasterize `text` at `size_px` with top-left at (x, y). `color` is RGB; each
/// glyph pixel's alpha comes from ab_glyph coverage.
pub fn draw_text(img: &mut RgbaImage, text: &str, x: i32, y: i32, color: [u8; 3], size_px: f32) {
    if text.is_empty() { return; }
    let font = font();
    let scaled = font.as_scaled(PxScale::from(size_px));
    let ascent = scaled.ascent();

    let mut pen_x = x as f32;
    let mut prev: Option<ab_glyph::GlyphId> = None;
    for c in text.chars() {
        let gid = scaled.glyph_id(c);
        if let Some(p) = prev { pen_x += scaled.kern(p, gid); }
        let glyph = gid.with_scale_and_position(PxScale::from(size_px), ab_glyph::point(pen_x, y as f32 + ascent));
        if let Some(outlined) = font.outline_glyph(glyph) {
            let bb = outlined.px_bounds();
            outlined.draw(|dx, dy, coverage| {
                let px = bb.min.x as i32 + dx as i32;
                let py = bb.min.y as i32 + dy as i32;
                if px < 0 || py < 0 { return; }
                let (px, py) = (px as u32, py as u32);
                if px >= img.width() || py >= img.height() { return; }
                blend_pixel(img, px, py, color, coverage);
            });
        }
        pen_x += scaled.h_advance(gid);
        prev = Some(gid);
    }
}

/// Measure the rendered pixel bounding box of `text` at `size_px`.
/// Returns (width, height). Returns (0, 0) for empty input.
pub fn measure_text(text: &str, size_px: f32) -> (u32, u32) {
    if text.is_empty() { return (0, 0); }
    let font = font();
    let scaled = font.as_scaled(PxScale::from(size_px));
    let mut pen_x = 0.0f32;
    let mut min_y = f32::MAX;
    let mut max_y = f32::MIN;
    let mut max_x = 0.0f32;
    let mut prev: Option<ab_glyph::GlyphId> = None;
    for c in text.chars() {
        let gid = scaled.glyph_id(c);
        if let Some(p) = prev { pen_x += scaled.kern(p, gid); }
        let glyph = gid.with_scale_and_position(PxScale::from(size_px), ab_glyph::point(pen_x, scaled.ascent()));
        if let Some(outlined) = font.outline_glyph(glyph) {
            let bb = outlined.px_bounds();
            min_y = min_y.min(bb.min.y);
            max_y = max_y.max(bb.max.y);
            max_x = max_x.max(bb.max.x);
        }
        pen_x += scaled.h_advance(gid);
        prev = Some(gid);
    }
    if min_y > max_y { return (0, 0); }
    let w = max_x.ceil().max(0.0) as u32;
    let h = (max_y - min_y).ceil().max(0.0) as u32;
    (w, h)
}

fn blend_pixel(img: &mut RgbaImage, x: u32, y: u32, color: [u8; 3], coverage: f32) {
    let c = coverage.clamp(0.0, 1.0);
    if c <= 0.0 { return; }
    let cur = img.get_pixel(x, y).0;
    let src_a = c;
    let dst_a = cur[3] as f32 / 255.0;
    let out_a = src_a + dst_a * (1.0 - src_a);
    if out_a < 0.004 { return; }
    let blend = |dst: u8, src: u8| -> u8 {
        let d = dst as f32;
        let s = src as f32;
        ((s * src_a + d * dst_a * (1.0 - src_a)) / out_a).round() as u8
    };
    img.put_pixel(x, y, Rgba([
        blend(cur[0], color[0]),
        blend(cur[1], color[1]),
        blend(cur[2], color[2]),
        (out_a * 255.0).round() as u8,
    ]));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draw_text_empty_string_paints_nothing() {
        let mut img = RgbaImage::new(22, 22);
        draw_text(&mut img, "", 0, 0, [255, 255, 255], 12.0);
        let painted = img.pixels().filter(|p| p.0[3] > 0).count();
        assert_eq!(painted, 0);
    }

    #[test]
    fn draw_text_paints_some_pixels_for_digits() {
        let mut img = RgbaImage::new(22, 22);
        draw_text(&mut img, "42", 2, 4, [255, 255, 255], 12.0);
        let painted = img.pixels().filter(|p| p.0[3] > 0).count();
        assert!(painted > 10, "expected >10 painted pixels, got {painted}");
    }

    #[test]
    fn draw_text_respects_image_bounds() {
        // y far below image bottom — must not panic, must paint nothing.
        let mut img = RgbaImage::new(22, 22);
        draw_text(&mut img, "99", 0, 1000, [255, 255, 255], 12.0);
        let painted = img.pixels().filter(|p| p.0[3] > 0).count();
        assert_eq!(painted, 0);
    }

    #[test]
    fn measure_text_empty_returns_zero() {
        assert_eq!(measure_text("", 12.0), (0, 0));
    }

    #[test]
    fn measure_text_returns_nonzero_for_digits() {
        let (w, h) = measure_text("42", 12.0);
        assert!(w > 0 && h > 0, "expected nonzero w/h, got ({w}, {h})");
        assert!(w < 22 && h < 22, "expected to fit in 22x22, got ({w}, {h})");
    }

    #[test]
    fn measure_text_three_digits_wider_than_two() {
        let (w2, _) = measure_text("42", 12.0);
        let (w3, _) = measure_text("100", 12.0);
        assert!(w3 > w2);
    }
}
