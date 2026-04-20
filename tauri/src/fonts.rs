//! Pixel-font glyph tables + rasterizer. Three fonts: Classic, Digital, Bold.
//! Ported bit-for-bit from `src/core/fonts.js`.

use image::{Rgba, RgbaImage};

pub struct PixelFont {
    pub width: u32,
    pub height: u32,
    pub get: fn(char) -> Option<&'static [u16]>,
}

// ── CLASSIC ───────────────────────────────────────────────────────────────────
// width=9, height=13. Glyphs ported verbatim from FONTS.classic.glyphs.
fn classic_glyph(c: char) -> Option<&'static [u16]> {
    static ZERO:  &[u16] = &[0x1fe, 0x1ff, 0x1e1, 0x1e1, 0x1e1, 0x1e1, 0x1e1, 0x1e1, 0x1e1, 0x1e1, 0x1e1, 0x1ff, 0x1fe];
    static ONE:   &[u16] = &[0x018, 0x018, 0x1f8, 0x1f8, 0x018, 0x018, 0x018, 0x018, 0x018, 0x018, 0x018, 0x1fc, 0x1fc];
    static TWO:   &[u16] = &[0x1fe, 0x1ff, 0x007, 0x007, 0x00f, 0x01f, 0x07e, 0x0f0, 0x1e0, 0x1c0, 0x1c0, 0x1ff, 0x1ff];
    static THREE: &[u16] = &[0x1fe, 0x1ff, 0x007, 0x007, 0x00f, 0x01e, 0x01e, 0x00f, 0x007, 0x007, 0x007, 0x1ff, 0x1fe];
    static FOUR:  &[u16] = &[0x01e, 0x01e, 0x03e, 0x07e, 0x0de, 0x19e, 0x13e, 0x1ff, 0x1ff, 0x01e, 0x01e, 0x01e, 0x01e];
    static FIVE:  &[u16] = &[0x1ff, 0x1ff, 0x180, 0x180, 0x1fe, 0x1ff, 0x007, 0x00f, 0x01e, 0x01e, 0x007, 0x1ff, 0x1fe];
    static SIX:   &[u16] = &[0x0fe, 0x1ff, 0x180, 0x180, 0x1fe, 0x1ff, 0x181, 0x181, 0x181, 0x181, 0x181, 0x1ff, 0x0fe];
    static SEVEN: &[u16] = &[0x1ff, 0x1ff, 0x007, 0x007, 0x00e, 0x01c, 0x038, 0x070, 0x0e0, 0x1c0, 0x1c0, 0x1c0, 0x1c0];
    static EIGHT: &[u16] = &[0x0fe, 0x1ff, 0x181, 0x181, 0x1ff, 0x1ff, 0x181, 0x181, 0x181, 0x181, 0x181, 0x1ff, 0x0fe];
    static NINE:  &[u16] = &[0x0fe, 0x1ff, 0x181, 0x181, 0x181, 0x181, 0x1ff, 0x07f, 0x001, 0x001, 0x001, 0x1ff, 0x0fe];
    match c {
        '0' => Some(ZERO),  '1' => Some(ONE),   '2' => Some(TWO),   '3' => Some(THREE),
        '4' => Some(FOUR),  '5' => Some(FIVE),  '6' => Some(SIX),   '7' => Some(SEVEN),
        '8' => Some(EIGHT), '9' => Some(NINE),  _ => None,
    }
}
pub const CLASSIC: PixelFont = PixelFont { width: 9, height: 13, get: classic_glyph };

// ── DIGITAL ───────────────────────────────────────────────────────────────────
// width=9, height=13 (JS height field says 14 but glyphs have 13 rows).
// Ported verbatim from FONTS.digital.glyphs.
fn digital_glyph(c: char) -> Option<&'static [u16]> {
    static ZERO:  &[u16] = &[0x1ff, 0x1ff, 0x183, 0x183, 0x183, 0x183, 0x183, 0x183, 0x183, 0x183, 0x183, 0x1ff, 0x1ff];
    static ONE:   &[u16] = &[0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003];
    static TWO:   &[u16] = &[0x1ff, 0x1ff, 0x003, 0x003, 0x003, 0x1ff, 0x1ff, 0x180, 0x180, 0x180, 0x180, 0x1ff, 0x1ff];
    static THREE: &[u16] = &[0x1ff, 0x1ff, 0x003, 0x003, 0x003, 0x1ff, 0x1ff, 0x003, 0x003, 0x003, 0x003, 0x1ff, 0x1ff];
    static FOUR:  &[u16] = &[0x183, 0x183, 0x183, 0x183, 0x183, 0x1ff, 0x1ff, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003];
    static FIVE:  &[u16] = &[0x1ff, 0x1ff, 0x180, 0x180, 0x180, 0x1ff, 0x1ff, 0x003, 0x003, 0x003, 0x003, 0x1ff, 0x1ff];
    static SIX:   &[u16] = &[0x1ff, 0x1ff, 0x180, 0x180, 0x180, 0x1ff, 0x1ff, 0x183, 0x183, 0x183, 0x183, 0x1ff, 0x1ff];
    static SEVEN: &[u16] = &[0x1ff, 0x1ff, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003];
    static EIGHT: &[u16] = &[0x1ff, 0x1ff, 0x183, 0x183, 0x183, 0x1ff, 0x1ff, 0x183, 0x183, 0x183, 0x183, 0x1ff, 0x1ff];
    static NINE:  &[u16] = &[0x1ff, 0x1ff, 0x183, 0x183, 0x183, 0x1ff, 0x1ff, 0x003, 0x003, 0x003, 0x003, 0x1ff, 0x1ff];
    match c {
        '0' => Some(ZERO),  '1' => Some(ONE),   '2' => Some(TWO),   '3' => Some(THREE),
        '4' => Some(FOUR),  '5' => Some(FIVE),  '6' => Some(SIX),   '7' => Some(SEVEN),
        '8' => Some(EIGHT), '9' => Some(NINE),  _ => None,
    }
}
// JS height field says 14 but actual glyph rows = 13. Use 13 to match glyph data.
pub const DIGITAL: PixelFont = PixelFont { width: 9, height: 13, get: digital_glyph };

// ── BOLD ──────────────────────────────────────────────────────────────────────
// width=10, height=14 (JS height field says 16 but glyphs have 14 rows).
// Ported verbatim from FONTS.bold.glyphs.
fn bold_glyph(c: char) -> Option<&'static [u16]> {
    static ZERO:  &[u16] = &[0x3ff, 0x3ff, 0x3ff, 0x303, 0x303, 0x303, 0x303, 0x303, 0x303, 0x303, 0x303, 0x3ff, 0x3ff, 0x3ff];
    static ONE:   &[u16] = &[0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030];
    static TWO:   &[u16] = &[0x3ff, 0x3ff, 0x003, 0x003, 0x003, 0x3ff, 0x3ff, 0x3ff, 0x300, 0x300, 0x300, 0x3ff, 0x3ff, 0x3ff];
    static THREE: &[u16] = &[0x3ff, 0x3ff, 0x003, 0x003, 0x003, 0x3ff, 0x3ff, 0x3ff, 0x003, 0x003, 0x003, 0x3ff, 0x3ff, 0x3ff];
    static FOUR:  &[u16] = &[0x303, 0x303, 0x303, 0x303, 0x303, 0x3ff, 0x3ff, 0x3ff, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003];
    static FIVE:  &[u16] = &[0x3ff, 0x3ff, 0x300, 0x300, 0x300, 0x3ff, 0x3ff, 0x3ff, 0x003, 0x003, 0x003, 0x3ff, 0x3ff, 0x3ff];
    static SIX:   &[u16] = &[0x3ff, 0x3ff, 0x300, 0x300, 0x300, 0x3ff, 0x3ff, 0x3ff, 0x303, 0x303, 0x303, 0x3ff, 0x3ff, 0x3ff];
    static SEVEN: &[u16] = &[0x3ff, 0x3ff, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003];
    static EIGHT: &[u16] = &[0x3ff, 0x3ff, 0x303, 0x303, 0x303, 0x3ff, 0x3ff, 0x3ff, 0x303, 0x303, 0x303, 0x3ff, 0x3ff, 0x3ff];
    static NINE:  &[u16] = &[0x3ff, 0x3ff, 0x303, 0x303, 0x303, 0x3ff, 0x3ff, 0x3ff, 0x003, 0x003, 0x003, 0x3ff, 0x3ff, 0x3ff];
    match c {
        '0' => Some(ZERO),  '1' => Some(ONE),   '2' => Some(TWO),   '3' => Some(THREE),
        '4' => Some(FOUR),  '5' => Some(FIVE),  '6' => Some(SIX),   '7' => Some(SEVEN),
        '8' => Some(EIGHT), '9' => Some(NINE),  _ => None,
    }
}
// JS height field says 16 but actual glyph rows = 14. Use 14 to match glyph data.
pub const BOLD: PixelFont = PixelFont { width: 10, height: 14, get: bold_glyph };

pub fn draw_text(img: &mut RgbaImage, text: &str, x: u32, y: u32, color: [u8; 3], font: &PixelFont) {
    let mut cursor_x = x;
    for ch in text.chars() {
        let Some(rows) = (font.get)(ch) else { continue; };
        for (row_idx, row) in rows.iter().enumerate() {
            for col in 0..font.width {
                let bit = 1u16 << (font.width - 1 - col);
                if row & bit != 0 {
                    let px = cursor_x + col;
                    let py = y + row_idx as u32;
                    if px < img.width() && py < img.height() {
                        img.put_pixel(px, py, Rgba([color[0], color[1], color[2], 255]));
                    }
                }
            }
        }
        cursor_x += font.width + 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageBuffer;

    #[test]
    fn draw_text_paints_expected_pixel_count() {
        let mut img: RgbaImage = ImageBuffer::from_pixel(40, 22, Rgba([0, 0, 0, 0]));
        draw_text(&mut img, "42", 0, 0, [255, 255, 255], &CLASSIC);
        let lit = img.pixels().filter(|p| p[3] > 0).count();
        assert!(lit > 10, "expected visible digits, got {lit} lit pixels");
    }

    #[test]
    fn draw_text_skips_unknown_chars() {
        let mut img: RgbaImage = ImageBuffer::from_pixel(22, 22, Rgba([0, 0, 0, 0]));
        draw_text(&mut img, "A", 0, 0, [255, 255, 255], &CLASSIC);
        let lit = img.pixels().filter(|p| p[3] > 0).count();
        assert_eq!(lit, 0);
    }

    #[test]
    fn classic_glyph_zero_has_correct_width() {
        let rows = (CLASSIC.get)('0').unwrap();
        assert_eq!(rows.len(), CLASSIC.height as usize);
    }

    #[test]
    fn draw_text_digital_paints_digits() {
        let mut img: RgbaImage = ImageBuffer::from_pixel(40, 22, Rgba([0, 0, 0, 0]));
        draw_text(&mut img, "42", 0, 0, [255, 255, 255], &DIGITAL);
        assert!(img.pixels().filter(|p| p[3] > 0).count() > 5);
    }

    #[test]
    fn draw_text_bold_paints_digits() {
        let mut img: RgbaImage = ImageBuffer::from_pixel(50, 32, Rgba([0, 0, 0, 0]));
        draw_text(&mut img, "42", 0, 0, [255, 255, 255], &BOLD);
        assert!(img.pixels().filter(|p| p[3] > 0).count() > 5);
    }
}
