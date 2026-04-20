# Tray Font Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three hand-drawn pixel fonts in the Tauri tray icon with a single bundled Inter SemiBold TTF rasterized via `ab_glyph`, and remove the font-picker dropdown from Settings.

**Architecture:** Single font embedded at compile time via `include_bytes!`, loaded once into a `OnceLock<FontRef<'static>>`. `draw_text`/`measure_text` rasterize glyph outlines to alpha coverage and composite into the existing `RgbaImage`. `icon.rs` picks a pixel size based on string length; no user-facing font choice.

**Tech Stack:** Rust, `ab_glyph = "0.2"`, `image` crate (already used), Tauri 2, vanilla JS dashboard, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-20-tray-font-swap-design.md`

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `tauri/Cargo.toml` | Modify | Add `ab_glyph` dep |
| `tauri/assets/Inter-SemiBold.ttf` | Create | Bundled font data |
| `tauri/assets/OFL.txt` | Create | License |
| `tauri/src/fonts.rs` | Rewrite | TTF-based `draw_text` + `measure_text` |
| `tauri/src/icon.rs` | Modify | Swap font-picker to size-based call |
| `tauri/src/icon_settings.rs` | Modify | Remove `OverlayStyle` |
| `tauri/dist/dashboard.html` | Modify | Remove `#overlayStyleSection` |
| `tauri/dist/modules/settings.js` | Modify | Remove `overlayStyle` refs |
| `tauri/tests/dashboard_end_to_end.test.mjs` | Modify | Remove `overlayStyle` from fixtures |

---

## Task 1: Vendor Inter SemiBold + add dependency

**Files:**
- Create: `tauri/assets/Inter-SemiBold.ttf`
- Create: `tauri/assets/OFL.txt`
- Modify: `tauri/Cargo.toml`

- [ ] **Step 1: Create assets directory**

Run:
```bash
mkdir -p tauri/assets
```

- [ ] **Step 2: Download Inter SemiBold TTF**

Run (Windows PowerShell via bash):
```bash
curl -L -o tauri/assets/Inter-SemiBold.ttf https://github.com/rsms/inter/raw/v4.0/docs/font-files/Inter-SemiBold.ttf
```

Expected: file ~300 KB. Verify:
```bash
ls -la tauri/assets/Inter-SemiBold.ttf
```

- [ ] **Step 3: Download the OFL license**

Run:
```bash
curl -L -o tauri/assets/OFL.txt https://github.com/rsms/inter/raw/v4.0/LICENSE.txt
```

- [ ] **Step 4: Add `ab_glyph` to Cargo.toml**

Modify `tauri/Cargo.toml`. After the line `image = { version = "0.25", default-features = false, features = ["png"] }`, add:

```toml
ab_glyph = "0.2"
```

- [ ] **Step 5: Verify the dep compiles**

Run:
```bash
cargo check --manifest-path tauri/Cargo.toml
```

Expected: compiles clean, `ab_glyph` downloaded and built.

- [ ] **Step 6: Commit**

```bash
git add tauri/Cargo.toml tauri/Cargo.lock tauri/assets/Inter-SemiBold.ttf tauri/assets/OFL.txt
git commit -m "CHORE: bundle Inter SemiBold TTF + ab_glyph dep"
```

---

## Task 2: Rewrite `fonts.rs` — TDD the new rasterizer

**Files:**
- Modify: `tauri/src/fonts.rs`

- [ ] **Step 1: Replace `fonts.rs` with new TTF-based implementation and failing tests**

Overwrite the entire file with:

```rust
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
```

Note: this deletes the old `PixelFont` / `CLASSIC` / `DIGITAL` / `BOLD`
exports. `icon.rs` still references them, so the next `cargo check` will
fail — that is expected and fixed in Task 3.

- [ ] **Step 2: Run the new tests in isolation**

Run:
```bash
cargo test --manifest-path tauri/Cargo.toml --lib fonts:: --no-fail-fast
```

Expected: all 6 tests pass. (The rest of the crate may not compile yet —
that is fine for `--lib fonts::` as long as `fonts.rs` itself compiles
standalone. If the test command requires the whole crate to build, skip
this step and proceed to Task 3, which fixes the breakage.)

If `cargo test` refuses because of downstream compile errors in `icon.rs`,
skip this verification and rely on Task 3's green build instead — note this
in the commit message.

- [ ] **Step 3: Commit**

```bash
git add tauri/src/fonts.rs
git commit -m "REFACTOR: rewrite fonts.rs to use bundled Inter TTF via ab_glyph"
```

---

## Task 3: Swap `icon.rs` to size-based API

**Files:**
- Modify: `tauri/src/icon.rs` (lines 56–80)

- [ ] **Step 1: Replace the NumberSession/NumberWeekly branch**

Open `tauri/src/icon.rs`. Find the block starting at line 56
(`DisplayMode::NumberSession | DisplayMode::NumberWeekly =>`) and ending
at line 80 (closing `}` of that branch, before `encode_png`).

Replace the inside of that arm with:

```rust
        DisplayMode::NumberSession | DisplayMode::NumberWeekly => {
            let (pct, safe) = match ctx.display_mode {
                DisplayMode::NumberSession => (sess, ctx.session_safe),
                DisplayMode::NumberWeekly  => (weekly, ctx.weekly_safe),
                _ => unreachable!(),
            };
            let Some(pct) = pct else {
                draw_ring_arc(&mut img, Some(100.0), OUTER_R_OUT, OUTER_R_IN, IDLE_GRAY);
                return encode_png(&img);
            };
            let val = (pct.round() as i32).clamp(0, 99) as u32;
            let text = val.to_string();
            let size_px = overlay_size_px(&text);
            let (tw, th) = crate::fonts::measure_text(&text, size_px);
            let x = ((SIZE as i32 - tw as i32) / 2).max(0);
            let y = ((SIZE as i32 - th as i32) / 2).max(0);
            let color = color_for(Some(pct), ctx, safe, /*is_icon=*/false);
            crate::fonts::draw_text(&mut img, &text, x, y, color, size_px);
        }
```

- [ ] **Step 2: Add the `overlay_size_px` helper**

Add this function immediately after the `color_for` function in `icon.rs`
(after the closing `}` that ends `color_for`, before `pub fn urgency_rgb`):

```rust
fn overlay_size_px(text: &str) -> f32 {
    match text.chars().count() {
        0 | 1 => 14.0,
        2 => 12.0,
        _ => 10.0,
    }
}
```

- [ ] **Step 3: Remove the now-dead `OverlayStyle` import from the test module**

Still in `icon.rs`, at line ~251:

```rust
use crate::icon_settings::{ColorApplyTo, ColorMode, ColorStop, IconSettings, IconStyle, OverlayStyle, PaceColors, DefaultDisplay};
```

Remove `OverlayStyle,` from that import list. Also remove the line inside
the `IconSettings { ... }` struct literal (around line 258) that sets
`overlay_style: OverlayStyle::Classic,`. The field will be deleted in
Task 4, so the test fixture must not reference it anymore.

- [ ] **Step 4: Run `cargo check`**

Run:
```bash
cargo check --manifest-path tauri/Cargo.toml
```

Expected: fails because `IconSettings` still has `overlay_style` as a
required field (nothing removed from `icon_settings.rs` yet). The error
should be something like "missing field `overlay_style`". That is expected
and proves we identified every test fixture. Note the file:line of every
such error — we will fix them all in Task 4.

If instead the error is about `OverlayStyle` being undefined, go back and
make sure you only removed the test-fixture usage, not the import that
`icon_settings.rs` still exports.

- [ ] **Step 5: Commit**

```bash
git add tauri/src/icon.rs
git commit -m "REFACTOR: icon.rs uses size-based draw_text; drop font-picker branch"
```

---

## Task 4: Remove `OverlayStyle` from Rust settings

**Files:**
- Modify: `tauri/src/icon_settings.rs`

- [ ] **Step 1: Delete the enum**

Remove lines 18–21:

```rust
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OverlayStyle { Classic, Digital, Bold }
impl Default for OverlayStyle { fn default() -> Self { Self::Classic } }
```

- [ ] **Step 2: Delete the field from `IconSettings`**

In the `IconSettings` struct definition (around line 77), remove:

```rust
    pub overlay_style: OverlayStyle,
```

In the `Default` impl for `IconSettings` (around line 89), remove:

```rust
            overlay_style: OverlayStyle::default(),
```

- [ ] **Step 3: Delete the parse entry in `TryFrom<&Settings> for IconSettings`**

Around line 226, remove the block:

```rust
            overlay_style: parse_enum(e.get("overlayStyle"), &[
                ("classic", OverlayStyle::Classic),
                ("digital", OverlayStyle::Digital),
                ("bold", OverlayStyle::Bold),
            ]),
```

- [ ] **Step 4: Update the tests**

Inside `mod tests` at the bottom of the file:

- Remove the assertion `assert_eq!(icon.overlay_style, OverlayStyle::Classic);` from `icon_settings_defaults_when_extra_empty` (line ~310).
- In `icon_settings_parses_dashboard_dropdown_values` (line ~318), remove both the `"overlayStyle": "digital",` line from the JSON fixture (line ~323) and the assertion `assert_eq!(icon.overlay_style, OverlayStyle::Digital);` (line ~338).

- [ ] **Step 5: Run full test suite**

Run:
```bash
cargo test --manifest-path tauri/Cargo.toml
```

Expected: all tests pass (including the three updated ones and the six
new font tests from Task 2).

- [ ] **Step 6: Commit**

```bash
git add tauri/src/icon_settings.rs
git commit -m "REFACTOR: remove OverlayStyle enum from icon settings"
```

---

## Task 5: Remove dropdown from dashboard UI

**Files:**
- Modify: `tauri/dist/dashboard.html` (lines 164–171)
- Modify: `tauri/dist/modules/settings.js` (lines 81–82, 288, 352, 445, 486)

- [ ] **Step 1: Remove the HTML block**

In `tauri/dist/dashboard.html`, delete the entire block (lines 164–171):

```html
                <div class="option" id="overlayStyleSection">
                    <span class="option-label">Number Font Style</span>
                    <select id="overlayStyle">
                        <option value="classic">Classic Giant</option>
                        <option value="digital">Digital 7-Seg</option>
                        <option value="bold">Ultra-Bold</option>
                    </select>
                </div>
```

- [ ] **Step 2: Remove the two element refs in settings.js**

In `tauri/dist/modules/settings.js`, delete lines 81–82:

```js
const overlayStyle = document.getElementById("overlayStyle");
const overlayStyleSection = document.getElementById("overlayStyleSection");
```

- [ ] **Step 3: Remove `overlayStyle` from the save payload**

In the same file around line 288, delete the line:

```js
    overlayStyle: overlayStyle.value,
```

from the object literal being built. Watch trailing commas — delete the
whole line including its comma.

- [ ] **Step 4: Remove the visibility toggle**

Around line 352, delete:

```js
  overlayStyleSection.style.display = "flex";
```

If there is a matching `"none"` assignment anywhere else in the same
function, delete that too.

- [ ] **Step 5: Remove the load-form line**

Around line 445, delete:

```js
    overlayStyle.value = settings.overlayStyle || "classic";
```

- [ ] **Step 6: Remove `overlayStyle` from the change-listener array**

Around line 486:

```js
  for (const el of [iconStyle, overlayStyle, timeStyle, tooltipLayout]) {
```

Change to:

```js
  for (const el of [iconStyle, timeStyle, tooltipLayout]) {
```

- [ ] **Step 7: Confirm no refs remain**

Run:
```bash
grep -rn "overlayStyle" tauri/dist/
```

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add tauri/dist/dashboard.html tauri/dist/modules/settings.js
git commit -m "FEAT: remove font-style dropdown from dashboard settings"
```

---

## Task 6: Update vitest dashboard fixtures

**Files:**
- Modify: `tauri/tests/dashboard_end_to_end.test.mjs` (lines 34, 185)

- [ ] **Step 1: Remove `overlayStyle` from fixture objects**

In `tauri/tests/dashboard_end_to_end.test.mjs`:

- Line 34 — inside a settings fixture, remove the `overlayStyle: "classic",` entry.
- Line 185 — same treatment: remove `overlayStyle: "classic",` from the inline settings object.

- [ ] **Step 2: Confirm no refs remain**

Run:
```bash
grep -rn "overlayStyle" tauri/tests/
```

Expected: no output.

- [ ] **Step 3: Run vitest**

Run:
```bash
cd tauri
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tauri/tests/dashboard_end_to_end.test.mjs
git commit -m "TEST: drop overlayStyle from dashboard test fixtures"
```

---

## Task 7: Full build + manual visual check

**Files:** none modified

- [ ] **Step 1: Full cargo test**

Run:
```bash
cargo test --manifest-path tauri/Cargo.toml
```

Expected: every test passes.

- [ ] **Step 2: Full vitest**

Run:
```bash
cd tauri
npx vitest run
```

Expected: every test passes.

- [ ] **Step 3: Confirm no `OverlayStyle` symbol anywhere in Rust**

Run:
```bash
grep -rn "OverlayStyle\|PixelFont\|fonts::CLASSIC\|fonts::DIGITAL\|fonts::BOLD" tauri/src/
```

Expected: no output.

- [ ] **Step 4: Launch the app and eyeball the tray**

Run:
```bash
cd tauri
npm run tauri dev
```

Then:
- Click the tray icon to cycle through: icon / session number / weekly number.
- Confirm the new font reads cleanly at 22×22 in the Windows tray.
- Confirm 1-, 2-, and 3-digit values (0, 45, 100) all fit visually.
- Confirm the spin animation on poll still renders.
- Open Settings → Icon section → confirm the "Number Font Style" dropdown is gone and the Icon Style dropdown is still there.

- [ ] **Step 5: Commit (no file changes — skip this step if nothing changed)**

If the manual check surfaced a tweak (e.g., bumping a size constant in
`overlay_size_px`), commit it under `FIX:` with a one-line message.
Otherwise skip.

---

## Self-Review Notes

- **Spec coverage:**
  - `ab_glyph` dep → Task 1. ✓
  - Bundled Inter SemiBold + OFL → Task 1. ✓
  - `fonts.rs` rewrite with `draw_text`/`measure_text` → Task 2. ✓
  - `icon.rs` size-based call → Task 3. ✓
  - `OverlayStyle` enum/field/parse removal → Task 4. ✓
  - Dashboard HTML + JS cleanup → Task 5. ✓
  - Vitest fixture cleanup → Task 6. ✓
  - Manual visual check → Task 7. ✓
  - Stale `overlayStyle` tolerated by `Settings.extra` → inherent to design, no task needed. ✓

- **Type consistency:**
  - `draw_text` signature uses `(x: i32, y: i32, color: [u8; 3], size_px: f32)` in both Task 2 (definition) and Task 3 (call site). ✓
  - `measure_text` returns `(u32, u32)` in both Task 2 and Task 3. ✓
  - `overlay_size_px` defined and called inside `icon.rs` in Task 3. ✓

- **No placeholders.** Every code step shows full code. No "TODO" / "TBD" / "similar to". ✓
