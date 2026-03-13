"use strict";

const { nativeImage } = require("electron");
const zlib = require("zlib");

// ── PNG primitives ────────────────────────────────────────────────────────────

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function pixelsToPNG(size, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // 8-bit RGBA

  const rowLen = 1 + size * 4;
  const raw = Buffer.alloc(size * rowLen, 0);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * rowLen + 1 + x * 4;
      raw[dst] = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
      raw[dst + 3] = pixels[src + 3];
    }
  }

  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Ring drawing ──────────────────────────────────────────────────────────────

const SIZE = 22;
const CX = SIZE / 2;
const CY = SIZE / 2;

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

// Colors keyed by urgency from settings
function urgencyRGB(pct, settings = {}) {
  if (pct == null) return [74, 144, 226]; // blue  — loading / unknown

  const thresholds = settings.colorThresholds || [
    { min: 0, color: "#27ae60" },
    { min: 50, color: "#e67e22" },
    { min: 80, color: "#e74c3c" },
  ];

  // Find the highest threshold that is <= pct
  let activeColor = thresholds[0]?.color || "#4a90e2";
  for (const t of thresholds) {
    if (pct >= t.min) {
      activeColor = t.color;
    } else {
      break;
    }
  }

  return hexToRgb(activeColor);
}

/**
 * Draws a ring arc onto a pixel buffer (RGBA flat array, SIZE×SIZE).
 *
 * @param {Uint8Array} pixels  Destination buffer (mutated in place)
 * @param {number|null} pct    0–100 fill amount, or null (draws empty ring only)
 * @param {number} outerR      Outer radius of the ring
 * @param {number} innerR      Inner radius of the ring
 * @param {number[]} fgRGB     [r,g,b] colour for the filled arc
 * @param {number[]} bgRGB     [r,g,b] colour for the empty arc track
 * @param {number} bgAlpha     Alpha (0–255) for the empty arc track
 */
function drawRingArc(pixels, pct, outerR, innerR, fgRGB, bgRGB, bgAlpha) {
  const [fr, fg, fb] = fgRGB;
  const [br, bg, bb] = bgRGB;
  const filledAngle =
    pct != null ? (Math.min(pct, 100) / 100) * 2 * Math.PI : 0;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - CX + 0.5;
      const dy = y - CY + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < innerR - 1 || dist > outerR + 1) continue;

      // Soft edge alpha so the ring has anti-aliased borders.
      const edgeAlpha =
        Math.min(1, dist - (innerR - 1)) * Math.min(1, outerR + 1 - dist);

      // Angle from top, clockwise: 0 = 12 o'clock.
      let angle = Math.atan2(dx, -dy);
      if (angle < 0) angle += 2 * Math.PI;

      const idx = (y * SIZE + x) * 4;
      const inFilled = angle <= filledAngle;

      // Blend on top of whatever is already in the buffer (pre-multiplied alpha).
      const srcA = pixels[idx + 3] / 255;
      const dstA = inFilled ? edgeAlpha : (bgAlpha / 255) * edgeAlpha;

      const outA = dstA + srcA * (1 - dstA);
      if (outA < 0.004) continue;

      const blend = (dst, src) =>
        Math.round((src * dstA + dst * srcA * (1 - dstA)) / outA);

      pixels[idx] = blend(pixels[idx], inFilled ? fr : br);
      pixels[idx + 1] = blend(pixels[idx + 1], inFilled ? fg : bg);
      pixels[idx + 2] = blend(pixels[idx + 2], inFilled ? fb : bb);
      pixels[idx + 3] = Math.round(outA * 255);
    }
  }
}

/**
 * Draws a short spinning arc onto the pixel buffer — used for the refresh animation.
 * The arc spans `arcLen` radians starting at `startAngle` (clockwise from top).
 */
function drawSpinningArc(
  pixels,
  startAngle,
  arcLen,
  outerR,
  innerR,
  color,
  bgRGB,
  bgAlpha,
) {
  const [fr, fg, fb] = color;
  const [br, bg, bb] = bgRGB;
  const endAngle = startAngle + arcLen;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - CX + 0.5;
      const dy = y - CY + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < innerR - 1 || dist > outerR + 1) continue;

      const edgeAlpha =
        Math.min(1, dist - (innerR - 1)) * Math.min(1, outerR + 1 - dist);

      let angle = Math.atan2(dx, -dy);
      if (angle < 0) angle += 2 * Math.PI;

      // Handle arc wrap-around past 2π.
      const inArc =
        endAngle > 2 * Math.PI
          ? angle >= startAngle || angle <= endAngle - 2 * Math.PI
          : angle >= startAngle && angle <= endAngle;

      const idx = (y * SIZE + x) * 4;
      const srcA = pixels[idx + 3] / 255;
      const dstA = inArc ? edgeAlpha : (bgAlpha / 255) * edgeAlpha;
      const outA = dstA + srcA * (1 - dstA);
      if (outA < 0.004) continue;

      const blend = (dst, src) =>
        Math.round((src * dstA + dst * srcA * (1 - dstA)) / outA);

      pixels[idx] = blend(pixels[idx], inArc ? fr : br);
      pixels[idx + 1] = blend(pixels[idx + 1], inArc ? fg : bg);
      pixels[idx + 2] = blend(pixels[idx + 2], inArc ? fb : bb);
      pixels[idx + 3] = Math.round(outA * 255);
    }
  }
}

// ── Pixel Fonts (Giant) ────────────────────────────────────────────────────────
const FONTS = {
  classic: {
    width: 9,
    height: 13,
    glyphs: {
      0: [0x1FE, 0x1FF, 0x1E1, 0x1E1, 0x1E1, 0x1E1, 0x1E1, 0x1E1, 0x1E1, 0x1E1, 0x1E1, 0x1FF, 0x1FE],
      1: [0x018, 0x018, 0x1F8, 0x1F8, 0x018, 0x018, 0x018, 0x018, 0x018, 0x018, 0x018, 0x1FC, 0x1FC],
      2: [0x1FE, 0x1FF, 0x007, 0x007, 0x00F, 0x01F, 0x07E, 0x0F0, 0x1E0, 0x1C0, 0x1C0, 0x1FF, 0x1FF],
      3: [0x1FE, 0x1FF, 0x007, 0x007, 0x00F, 0x01E, 0x01E, 0x00F, 0x007, 0x007, 0x007, 0x1FF, 0x1FE],
      4: [0x01E, 0x01E, 0x03E, 0x07E, 0x0DE, 0x19E, 0x13E, 0x1FF, 0x1FF, 0x01E, 0x01E, 0x01E, 0x01E],
      5: [0x1FF, 0x1FF, 0x180, 0x180, 0x1FE, 0x1FF, 0x007, 0x00F, 0x01E, 0x01E, 0x007, 0x1FF, 0x1FE],
      6: [0x0FE, 0x1FF, 0x180, 0x180, 0x1FE, 0x1FF, 0x181, 0x181, 0x181, 0x181, 0x181, 0x1FF, 0x0FE],
      7: [0x1FF, 0x1FF, 0x007, 0x007, 0x00E, 0x01C, 0x038, 0x070, 0x0E0, 0x1C0, 0x1C0, 0x1C0, 0x1C0],
      8: [0x0FE, 0x1FF, 0x181, 0x181, 0x1FF, 0x1FF, 0x181, 0x181, 0x181, 0x181, 0x181, 0x1FF, 0x0FE],
      9: [0x0FE, 0x1FF, 0x181, 0x181, 0x181, 0x181, 0x1FF, 0x07F, 0x001, 0x001, 0x001, 0x1FF, 0x0FE],
    }
  },
  digital: {
    width: 9,
    height: 14,
    glyphs: {
      0: [0x1FF, 0x1FF, 0x183, 0x183, 0x183, 0x183, 0x183, 0x183, 0x183, 0x183, 0x183, 0x1FF, 0x1FF],
      1: [0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003],
      2: [0x1FF, 0x1FF, 0x003, 0x003, 0x003, 0x1FF, 0x1FF, 0x180, 0x180, 0x180, 0x180, 0x1FF, 0x1FF],
      3: [0x1FF, 0x1FF, 0x003, 0x003, 0x003, 0x1FF, 0x1FF, 0x003, 0x003, 0x003, 0x003, 0x1FF, 0x1FF],
      4: [0x183, 0x183, 0x183, 0x183, 0x183, 0x1FF, 0x1FF, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003],
      5: [0x1FF, 0x1FF, 0x180, 0x180, 0x180, 0x1FF, 0x1FF, 0x003, 0x003, 0x003, 0x003, 0x1FF, 0x1FF],
      6: [0x1FF, 0x1FF, 0x180, 0x180, 0x180, 0x1FF, 0x1FF, 0x183, 0x183, 0x183, 0x183, 0x1FF, 0x1FF],
      7: [0x1FF, 0x1FF, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003],
      8: [0x1FF, 0x1FF, 0x183, 0x183, 0x183, 0x1FF, 0x1FF, 0x183, 0x183, 0x183, 0x183, 0x1FF, 0x1FF],
      9: [0x1FF, 0x1FF, 0x183, 0x183, 0x183, 0x1FF, 0x1FF, 0x003, 0x003, 0x003, 0x003, 0x1FF, 0x1FF],
    }
  },
  bold: {
    width: 10,
    height: 16,
    glyphs: {
      0: [0x3FF, 0x3FF, 0x3FF, 0x303, 0x303, 0x303, 0x303, 0x303, 0x303, 0x303, 0x303, 0x3FF, 0x3FF, 0x3FF],
      1: [0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030, 0x030],
      2: [0x3FF, 0x3FF, 0x300, 0x300, 0x300, 0x3FF, 0x3FF, 0x3FF, 0x300, 0x300, 0x300, 0x3FF, 0x3FF, 0x3FF], // wait i messed up 2
      2: [0x3FF, 0x3FF, 0x003, 0x003, 0x003, 0x3FF, 0x3FF, 0x3FF, 0x300, 0x300, 0x300, 0x3FF, 0x3FF, 0x3FF],
      3: [0x3FF, 0x3FF, 0x003, 0x003, 0x003, 0x3FF, 0x3FF, 0x3FF, 0x003, 0x003, 0x003, 0x3FF, 0x3FF, 0x3FF],
      4: [0x303, 0x303, 0x303, 0x303, 0x303, 0x3FF, 0x3FF, 0x3FF, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003],
      5: [0x3FF, 0x3FF, 0x300, 0x300, 0x300, 0x3FF, 0x3FF, 0x3FF, 0x003, 0x003, 0x003, 0x3FF, 0x3FF, 0x3FF],
      6: [0x3FF, 0x3FF, 0x300, 0x300, 0x300, 0x3FF, 0x3FF, 0x3FF, 0x303, 0x303, 0x303, 0x3FF, 0x3FF, 0x3FF],
      7: [0x3FF, 0x3FF, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003, 0x003],
      8: [0x3FF, 0x3FF, 0x303, 0x303, 0x303, 0x3FF, 0x3FF, 0x3FF, 0x303, 0x303, 0x303, 0x3FF, 0x3FF, 0x3FF],
      9: [0x3FF, 0x3FF, 0x303, 0x303, 0x303, 0x3FF, 0x3FF, 0x3FF, 0x003, 0x003, 0x003, 0x3FF, 0x3FF, 0x3FF],
    }
  }
};

function drawDigit(pixels, digit, x, y, color, style = "classic") {
  const font = FONTS[style] || FONTS.classic;
  const glyph = font.glyphs[digit];
  if (!glyph) return;
  for (let row = 0; row < glyph.length; row++) {
    for (let col = 0; col < font.width; col++) {
      if ((glyph[row] >> (font.width - 1 - col)) & 1) {
        const px = x + col;
        const py = y + row;
        if (px >= 0 && px < SIZE && py >= 0 && py < SIZE) {
          const idx = (py * SIZE + px) * 4;
          pixels[idx] = color[0];
          pixels[idx + 1] = color[1];
          pixels[idx + 2] = color[2];
          pixels[idx + 3] = 255;
        }
      }
    }
  }
}

function drawText(pixels, text, x, y, color, style = "classic") {
  const font = FONTS[style] || FONTS.classic;
  let curX = x;
  for (const char of String(text)) {
    drawDigit(pixels, parseInt(char, 10), curX, y, color, style);
    curX += font.width + 1; // digit width + 1 spacing
  }
}

/**
 * Draws two vertical bars instead of rings.
 */
function drawBars(pixels, sessionPct, weeklyPct, trackRGB, settings) {
  if (settings.cleanNumberMode) return; // Skip if in clean mode

  const sessionRGB = urgencyRGB(sessionPct, settings);
  const weeklyRGB = urgencyRGB(weeklyPct, settings);

  const sessionFill =
    sessionPct != null ? (Math.min(sessionPct, 100) / 100) * 18 : 0;
  const weeklyFill =
    weeklyPct != null ? (Math.min(weeklyPct, 100) / 100) * 18 : 0;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const idx = (y * SIZE + x) * 4;

      // Session bar (Left: x 3-8, y 2-20)
      if (x >= 3 && x <= 8 && y >= 2 && y <= 20) {
        const isFilled = 20 - y <= sessionFill;
        const [r, g, b] = isFilled ? sessionRGB : trackRGB;
        const alpha = isFilled ? 255 : 80;

        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = alpha;
      }

      // Weekly bar (Right: x 13-18, y 2-20)
      if (x >= 13 && x <= 18 && y >= 2 && y <= 20) {
        const isFilled = 20 - y <= weeklyFill;
        const [r, g, b] = isFilled ? weeklyRGB : trackRGB;
        const alpha = isFilled ? 255 : 80;

        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = alpha;
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds the 22×22 tray icon as a nativeImage.
 *
 * @param {number|null} sessionPct  0–100 or null
 * @param {number|null} weeklyPct   0–100 or null
 * @param {object}      settings    App settings
 */
function makeIcon(sessionPct, weeklyPct, settings = {}) {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const track = [60, 60, 60];

  if (!settings.cleanNumberMode) {
    if (settings.iconStyle === "bars") {
      drawBars(pixels, sessionPct, weeklyPct, track, settings);
    } else {
      drawRingArc(
        pixels,
        sessionPct,
        10.5,
        7.5,
        urgencyRGB(sessionPct, settings),
        track,
        80,
      );
      drawRingArc(
        pixels,
        weeklyPct,
        5.5,
        3.5,
        urgencyRGB(weeklyPct, settings),
        track,
        80,
      );
    }
  }

  // Draw numeric overlay if requested
  const overlayType = settings.overlayDisplay;
  if (overlayType === "session" || overlayType === "weekly") {
    const pct = overlayType === "session" ? sessionPct : weeklyPct;
    if (pct != null) {
      const val = Math.min(Math.round(pct), 99);
      const str = String(val);
      const style = settings.overlayStyle || "classic";
      const font = FONTS[style];
      
      // Calculate centering
      const totalWidth = (str.length * font.width) + (str.length - 1);
      const x = Math.max(0, Math.floor((SIZE - totalWidth) / 2));
      const y = Math.max(0, Math.floor((SIZE - font.height) / 2));

      // Draw a darkened plate for maximum contrast (unless in clean mode where background is black anyway)
      if (!settings.cleanNumberMode) {
        const plateX = Math.max(0, x - 1);
        const plateY = Math.max(0, y - 1);
        const plateW = Math.min(SIZE - plateX, totalWidth + 2);
        const plateH = Math.min(SIZE - plateY, font.height + 2);

        for (let py = plateY; py < plateY + plateH; py++) {
          for (let px = plateX; px < plateX + plateW; px++) {
            const idx = (py * SIZE + px) * 4;
            pixels[idx] = Math.round(pixels[idx] * 0.2);
            pixels[idx + 1] = Math.round(pixels[idx + 1] * 0.2);
            pixels[idx + 2] = Math.round(pixels[idx + 2] * 0.2);
            pixels[idx + 3] = Math.max(pixels[idx + 3], 210);
          }
        }
      }

      drawText(pixels, str, x, y, [255, 255, 255], style);
    }
  }

  return nativeImage.createFromBuffer(pixelsToPNG(SIZE, pixels));
}

/**
 * Builds a single frame of the refresh animation.
 *
 * @param {number}      frame      Animation frame counter
 * @param {number|null} weeklyPct  Last known weekly utilisation
 * @param {object}      settings    App settings
 */
function makeSpinFrame(frame, weeklyPct, settings = {}) {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const track = [60, 60, 60];

  if (settings.iconStyle === "bars") {
    // For bars animation, we can just make them pulse or some simple effect
    // For now, let's just keep them static but blueish
    drawBars(pixels, 100, weeklyPct, track, settings);
    // Overwrite session bar color with spinning blue
    const blue = [74, 144, 226];
    const pulse = Math.abs(Math.sin(frame * 0.2));
    for (let y = 2; y <= 20; y++) {
      for (let x = 3; x <= 8; x++) {
        const idx = (y * SIZE + x) * 4;
        pixels[idx] = blue[0];
        pixels[idx + 1] = blue[1];
        pixels[idx + 2] = blue[2];
        pixels[idx + 3] = Math.round(150 + pulse * 105);
      }
    }
  } else {
    const arcLen = Math.PI * 0.6;
    const startAngle = (frame * 0.28) % (2 * Math.PI);

    drawSpinningArc(
      pixels,
      startAngle,
      arcLen,
      10.5,
      7.5,
      [74, 144, 226],
      track,
      40,
    );
    drawRingArc(
      pixels,
      weeklyPct,
      5.5,
      3.5,
      urgencyRGB(weeklyPct, settings),
      track,
      80,
    );
  }

  return nativeImage.createFromBuffer(pixelsToPNG(SIZE, pixels));
}

module.exports = { makeIcon, makeSpinFrame };
