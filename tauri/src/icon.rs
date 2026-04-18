//! Renders the tray icon as an RGBA PNG byte buffer.

use image::{ImageBuffer, ImageEncoder, Rgba, RgbaImage};

const SIZE: u32 = 22;
const CENTER: f32 = (SIZE as f32) / 2.0;

const OUTER_R_OUT: f32 = 10.5;
const OUTER_R_IN: f32  = 7.5;
const INNER_R_OUT: f32 = 5.5;
const INNER_R_IN:  f32 = 3.5;

const TRACK: Rgba<u8>   = Rgba([60, 60, 60, 255]);
const LOADING: Rgba<u8> = Rgba([64, 128, 220, 255]); // blue
const GREEN: Rgba<u8>   = Rgba([60, 180, 75, 255]);
const ORANGE: Rgba<u8>  = Rgba([240, 150, 40, 255]);
const RED: Rgba<u8>     = Rgba([220, 60, 60, 255]);

fn color_for(pct: f32) -> Rgba<u8> {
    if pct >= 80.0 { RED }
    else if pct >= 50.0 { ORANGE }
    else { GREEN }
}

/// Returns RGBA png bytes (as a `Vec<u8>`) for a tray icon showing the two rings.
/// `five_hour_pct` and `seven_day_pct` are 0..=100. Pass `None` to render the
/// "loading" state for that ring.
pub fn render_rings(five_hour_pct: Option<f32>, seven_day_pct: Option<f32>) -> Vec<u8> {
    let mut img: RgbaImage = ImageBuffer::from_pixel(SIZE, SIZE, Rgba([0, 0, 0, 0]));
    draw_ring(&mut img, OUTER_R_OUT, OUTER_R_IN, TRACK);
    draw_ring(&mut img, INNER_R_OUT, INNER_R_IN, TRACK);
    if let Some(p) = five_hour_pct {
        draw_ring_arc(&mut img, OUTER_R_OUT, OUTER_R_IN, p, color_for(p));
    } else {
        draw_ring_arc(&mut img, OUTER_R_OUT, OUTER_R_IN, 100.0, LOADING);
    }
    if let Some(p) = seven_day_pct {
        draw_ring_arc(&mut img, INNER_R_OUT, INNER_R_IN, p, color_for(p));
    } else {
        draw_ring_arc(&mut img, INNER_R_OUT, INNER_R_IN, 100.0, LOADING);
    }
    encode_png(&img)
}

fn draw_ring(img: &mut RgbaImage, r_out: f32, r_in: f32, color: Rgba<u8>) {
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 + 0.5 - CENTER;
            let dy = y as f32 + 0.5 - CENTER;
            let d = (dx * dx + dy * dy).sqrt();
            if d <= r_out && d >= r_in {
                img.put_pixel(x, y, color);
            }
        }
    }
}

fn draw_ring_arc(img: &mut RgbaImage, r_out: f32, r_in: f32, pct: f32, color: Rgba<u8>) {
    let pct = pct.clamp(0.0, 100.0);
    // Start at 12 o'clock, sweep clockwise, proportional to pct.
    let max_angle = pct / 100.0 * std::f32::consts::TAU;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 + 0.5 - CENTER;
            let dy = y as f32 + 0.5 - CENTER;
            let d = (dx * dx + dy * dy).sqrt();
            if d > r_out || d < r_in { continue; }
            // angle measured clockwise from 12 o'clock:
            let mut a = (-dy).atan2(dx) * -1.0 + std::f32::consts::FRAC_PI_2;
            if a < 0.0 { a += std::f32::consts::TAU; }
            if a <= max_angle {
                img.put_pixel(x, y, color);
            }
        }
    }
}

fn encode_png(img: &RgbaImage) -> Vec<u8> {
    let mut buf = Vec::with_capacity(4096);
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba8,
        )
        .expect("png encode");
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_header_correct() {
        let bytes = render_rings(Some(40.0), Some(80.0));
        // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
        assert_eq!(&bytes[0..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }

    #[test]
    fn decoded_dimensions_are_22x22() {
        let bytes = render_rings(Some(40.0), Some(80.0));
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.width(), SIZE);
        assert_eq!(decoded.height(), SIZE);
    }

    #[test]
    fn loading_state_renders_without_panicking() {
        let _ = render_rings(None, None);
    }

    #[test]
    fn full_ring_colors_high_pct_red() {
        assert_eq!(color_for(85.0), RED);
        assert_eq!(color_for(50.0), ORANGE);
        assert_eq!(color_for(10.0), GREEN);
    }
}
