//! TTF-based text rasterizer. Uses Inter SemiBold bundled at compile time.
//! Composites anti-aliased glyphs into an existing RgbaImage via source-over.

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use image::{Rgba, RgbaImage};
use std::sync::OnceLock;

const FONT_BYTES: &[u8] = include_bytes!("../../assets/Inter-SemiBold.ttf");

fn font() -> &'static FontRef<'static> {
    static FONT: OnceLock<FontRef<'static>> = OnceLock::new();
    FONT.get_or_init(|| FontRef::try_from_slice(FONT_BYTES).expect("embedded font is valid TTF"))
}

/// Rasterize `text` at `size_px` with the drawn pixel bbox top-left at (x, y).
/// This matches `measure_text` semantics, so centering with `(SIZE - w) / 2`
/// works correctly. `color` is RGB; each glyph pixel's alpha comes from
/// ab_glyph coverage.
pub fn draw_text(img: &mut RgbaImage, text: &str, x: i32, y: i32, color: [u8; 3], size_px: f32) {
    if text.is_empty() { return; }
    debug_assert!(size_px > 0.0, "size_px must be positive");
    let font = font();
    let scaled = font.as_scaled(PxScale::from(size_px));
    let ascent = scaled.ascent();

    // Pass 1: compute the drawn bbox's minimum x/y at a reference origin so we
    // can shift the actual draw to land the bbox top-left exactly at (x, y).
    let mut pen_x = 0.0f32;
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut prev: Option<ab_glyph::GlyphId> = None;
    for c in text.chars() {
        let gid = scaled.glyph_id(c);
        if let Some(p) = prev { pen_x += scaled.kern(p, gid); }
        let glyph = gid.with_scale_and_position(PxScale::from(size_px), ab_glyph::point(pen_x, ascent));
        if let Some(outlined) = font.outline_glyph(glyph) {
            let bb = outlined.px_bounds();
            min_x = min_x.min(bb.min.x);
            min_y = min_y.min(bb.min.y);
        }
        pen_x += scaled.h_advance(gid);
        prev = Some(gid);
    }
    if min_x == f32::MAX { return; }

    // Shift so the glyph bbox top-left lands at (x, y). For y we add `ascent`
    // because min_y from pass 1 is measured in pixel space (baseline positioned
    // at y=ascent), so the glyph top relative to a baseline-at-0 is
    // (min_y - ascent). Solving `baseline + (min_y - ascent) = y` gives this.
    let shift_x = x as f32 - min_x;
    let shift_y = y as f32 - min_y + ascent;

    let mut pen_x = shift_x;
    let mut prev: Option<ab_glyph::GlyphId> = None;
    for c in text.chars() {
        let gid = scaled.glyph_id(c);
        if let Some(p) = prev { pen_x += scaled.kern(p, gid); }
        let glyph = gid.with_scale_and_position(PxScale::from(size_px), ab_glyph::point(pen_x, shift_y));
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
    debug_assert!(size_px > 0.0, "size_px must be positive");
    let font = font();
    let scaled = font.as_scaled(PxScale::from(size_px));
    let mut pen_x = 0.0f32;
    let mut min_x = f32::MAX;
    let mut max_x = f32::MIN;
    let mut min_y = f32::MAX;
    let mut max_y = f32::MIN;
    let mut prev: Option<ab_glyph::GlyphId> = None;
    for c in text.chars() {
        let gid = scaled.glyph_id(c);
        if let Some(p) = prev { pen_x += scaled.kern(p, gid); }
        let glyph = gid.with_scale_and_position(PxScale::from(size_px), ab_glyph::point(pen_x, scaled.ascent()));
        if let Some(outlined) = font.outline_glyph(glyph) {
            let bb = outlined.px_bounds();
            min_x = min_x.min(bb.min.x);
            max_x = max_x.max(bb.max.x);
            min_y = min_y.min(bb.min.y);
            max_y = max_y.max(bb.max.y);
        }
        pen_x += scaled.h_advance(gid);
        prev = Some(gid);
    }
    if min_y > max_y || min_x > max_x { return (0, 0); }
    let w = (max_x - min_x).ceil().max(0.0) as u32;
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
    fn draw_text_lands_at_passed_top_left() {
        // Regression: draw_text must place the painted bbox top-left at (x, y),
        // matching measure_text. Previously a missing `ascent` term in the
        // y-shift caused glyphs to render ~ascent pixels above the image.
        let mut img = RgbaImage::new(22, 22);
        let size = 20.0;
        let (tw, th) = measure_text("9", size);
        let x = ((22 - tw as i32) / 2).max(0);
        let y = ((22 - th as i32) / 2).max(0);
        draw_text(&mut img, "9", x, y, [255, 255, 255], size);

        let mut min_py = u32::MAX;
        let mut max_py = 0u32;
        for (px, py, pix) in img.enumerate_pixels() {
            if pix.0[3] > 0 {
                let _ = px;
                min_py = min_py.min(py);
                max_py = max_py.max(py);
            }
        }
        assert!(min_py != u32::MAX, "expected painted pixels");
        // Top of painted region should be at or just past y. Allow 1px slack
        // for AA fringe.
        assert!(
            (min_py as i32 - y).abs() <= 1,
            "expected painted top near y={y}, got {min_py}"
        );
        let painted_h = (max_py - min_py + 1) as u32;
        assert!(
            painted_h.abs_diff(th) <= 1,
            "painted height {painted_h} should match measured {th}"
        );
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
