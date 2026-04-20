# Tray Font Swap: Hand-Drawn Pixel Fonts → Bundled TTF

**Date:** 2026-04-20
**Branch:** `tauri-rewrite`
**Scope:** Tauri only. Electron implementation frozen, no parity work.

## Problem

Tray icon text (e.g. `45`, `100`) is rendered via three hand-drawn pixel fonts
(`Classic`, `Digital`, `Bold`) defined as bit tables in `tauri/src/fonts.rs`.
The user finds none of them attractive. A font-picker dropdown in Settings
exposes the choice, which exists solely because no single bundled font looks
good.

## Goal

Replace all three hand-drawn fonts with a single bundled TrueType font
(Inter SemiBold), rasterized at runtime via the `ab_glyph` crate. Remove the
font-picker dropdown and its supporting code/settings once the new font is
in place.

## Non-Goals

- No changes to the Electron build.
- No runtime font picker — single bundled font, not swappable by the user.
- No OS-specific font loading (Segoe UI / SF Pro). Bundled font guarantees
  visual parity across Windows and macOS.
- No changes to non-tray text (dashboard, tooltip use CSS / OS fonts already).

## Architecture

### Dependency

Add to `tauri/Cargo.toml`:

```toml
ab_glyph = "0.2"
```

`ab_glyph` is a lightweight, pure-Rust TTF/OTF outline rasterizer. No
allocations per glyph after font load. Coverage output (`u8` alpha per pixel)
composites cleanly onto the existing RGBA icon buffer.

### Bundled font

- File: `tauri/assets/Inter-SemiBold.ttf`
- Source: https://rsms.me/inter (SIL Open Font License)
- Embedded at compile time via `include_bytes!("../assets/Inter-SemiBold.ttf")`
- Parsed once into a `FontRef<'static>` stored in a `OnceLock`
- License file (`OFL.txt`) copied alongside the TTF

SemiBold chosen over Regular: at ~12px on a 22×22 icon, heavier strokes
stay readable when anti-aliased. Regular tends to look spindly at that size.

### `fonts.rs` rewrite

Complete replacement. New public surface:

```rust
pub fn draw_text(
    img: &mut RgbaImage,
    text: &str,
    x: i32,
    y: i32,
    color: [u8; 3],
    size_px: f32,
);

pub fn measure_text(text: &str, size_px: f32) -> (u32, u32); // (w, h)
```

Internals:

- `static FONT: OnceLock<FontRef<'static>>` loaded from embedded bytes
- For each char: `font.glyph_id(c).with_scale(size_px)` → `outline_glyph` →
  `draw(|px, py, coverage| { ... })`
- Coverage (`0.0..=1.0`) multiplied into target pixel alpha; RGB lerp with
  existing pixel (source-over).
- Horizontal positioning uses glyph advance + kerning from `ab_glyph`.
- `measure_text` needed because current code positions text centered — it
  must know the rendered pixel width in advance.

### `icon.rs` changes

Replace the `match overlay_style` block that picks a `PixelFont`:

**Before** (icon.rs:69-79, approx.):
```rust
let font: &PixelFont = match ctx.settings.overlay_style {
    OverlayStyle::Classic => &fonts::CLASSIC,
    OverlayStyle::Digital => &fonts::DIGITAL,
    OverlayStyle::Bold    => &fonts::BOLD,
};
fonts::draw_text(&mut img, &text, x, y, color, font);
```

**After**:
```rust
let size = overlay_size_for(&text);   // see sizing below
let (w, h) = fonts::measure_text(&text, size);
let x = center(SIZE, w);
let y = center(SIZE, h);
fonts::draw_text(&mut img, &text, x, y, color, size);
```

Sizing: one function returns an appropriate `size_px` based on string length
so `100` fits the same visual box as `45`. Starting values (to tune by eye):

- 1 char → 14.0
- 2 char → 12.0
- 3 char → 10.0

### Settings cleanup

**Rust (`icon_settings.rs`):**
- Remove `OverlayStyle` enum (lines 19–21).
- Remove `overlay_style` field from `IconSettings` (lines 81, 94).
- Remove `overlayStyle` parsing in the `TryFrom` impl (lines 226–230).
- Remove affected assertions in tests (lines 310, 323, 338).

**Dashboard UI (`tauri/dist/`):**
- `dashboard.html`: delete the `#overlayStyleSection` block (lines 164–170).
- `modules/settings.js`: remove `overlayStyle` refs (lines 81, 82, 288, 352,
  445, 486).
- `tests/dashboard_end_to_end.test.mjs`: remove `overlayStyle` from fixture
  payloads (lines 34, 185).

**Settings file migration:** old saved `overlayStyle` values in users' JSON
on disk become unknown extra keys — `Settings.extra` already tolerates
unknown keys, so no migration code required. Stale value harmlessly ignored.

### Tests

- Delete existing pixel-paint tests in `fonts.rs` (`draw_text_paints_expected_pixel_count`,
  `draw_text_skips_unknown_chars`, `classic_height_matches_glyph_row_count`,
  `draw_text_digital_paints_digits`, `draw_text_bold_paints_digits`).
- Add new tests:
  - `draw_text_paints_nonzero_pixels_for_digits` — rasterizes `"42"`, counts
    pixels with alpha > 0, asserts > 0 and roughly within expected bbox.
  - `measure_text_returns_nonzero_dims_for_digits` — sanity for the measurer.
  - `draw_text_noop_for_empty_string` — empty input, no pixels touched.
- Visual check (manual): run app, cycle through all display modes
  (icon / session / weekly pct), eyeball the tray at native 22×22 on
  Windows. Check on the high-DPI secondary monitor as well if available.

## File-Level Change Summary

| File | Change |
|---|---|
| `tauri/Cargo.toml` | Add `ab_glyph = "0.2"` |
| `tauri/assets/Inter-SemiBold.ttf` | New file (bundled) |
| `tauri/assets/OFL.txt` | New file (license) |
| `tauri/src/fonts.rs` | Full rewrite: TTF-based `draw_text` + `measure_text` |
| `tauri/src/icon.rs` | Swap font-picker match → single size-based call |
| `tauri/src/icon_settings.rs` | Delete `OverlayStyle` + field + parsing + test assertions |
| `tauri/dist/dashboard.html` | Remove `#overlayStyleSection` |
| `tauri/dist/modules/settings.js` | Remove `overlayStyle` refs |
| `tauri/tests/dashboard_end_to_end.test.mjs` | Remove `overlayStyle` from fixtures |

## Risks & Mitigations

- **Rendering quality at 22×22.** Inter SemiBold at 12px is known-good for
  UI contexts. If visual check reveals muddiness, fall back to size tuning
  or try Inter Bold. No architectural rework needed.
- **Binary size.** Inter SemiBold is ~300 KB embedded. Acceptable for a
  tray app (~20 MB installer baseline). No action required.
- **Kerning / metrics at fractional sizes.** `ab_glyph` rounds internally.
  If digit pairs look uneven, pin `size_px` to integer values.
- **Stale `overlayStyle` in users' settings files.** Ignored by `extra`
  deserializer. No action required.

## Success Criteria

- Tray icon text at 22×22 looks cleaner and more legible than any of the
  three previous hand-drawn fonts.
- No `PixelFont` / `CLASSIC` / `DIGITAL` / `BOLD` / `OverlayStyle` symbols
  remain in the Rust source.
- No `overlayStyle` references remain in `tauri/dist/` or `tauri/tests/`.
- `cargo test` passes.
- `vitest` passes.
- Manual check: render session / weekly / icon modes, cycle via tray click,
  animations still work.
