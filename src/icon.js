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

// Colors keyed by urgency
function urgencyRGB(pct) {
  if (pct == null) return [74, 144, 226]; // blue  — loading / unknown
  if (pct < 50) return [39, 174, 96]; // green — healthy
  if (pct < 80) return [230, 126, 34]; // orange — moderate
  return [231, 76, 60]; // red   — high
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds the 22×22 tray icon as a nativeImage.
 *
 * Outer ring (r 7.5–10.5): session (5-hour) utilisation.
 * Inner ring (r 3.5–5.5):  weekly  (7-day)  utilisation.
 * Both rings are coloured independently by urgency (green / orange / red).
 * Passing null for both renders a blue "loading" state.
 *
 * @param {number|null} sessionPct  0–100 or null
 * @param {number|null} weeklyPct   0–100 or null
 */
function makeIcon(sessionPct, weeklyPct) {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const track = [60, 60, 60];

  drawRingArc(pixels, sessionPct, 10.5, 7.5, urgencyRGB(sessionPct), track, 80);
  drawRingArc(pixels, weeklyPct, 5.5, 3.5, urgencyRGB(weeklyPct), track, 80);

  return nativeImage.createFromBuffer(pixelsToPNG(SIZE, pixels));
}

/**
 * Builds a single frame of the refresh animation.
 * The outer ring shows a bright blue spinning arc; the inner ring stays at
 * the last known weekly value so it always shows real data.
 *
 * @param {number}      frame      Animation frame counter (increments each tick)
 * @param {number|null} weeklyPct  Last known weekly utilisation (kept static)
 */
function makeSpinFrame(frame, weeklyPct) {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const track = [60, 60, 60];

  const arcLen = Math.PI * 0.6; // ~108° spinning arc
  const startAngle = (frame * 0.28) % (2 * Math.PI); // ~18fps feels snappy

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
  drawRingArc(pixels, weeklyPct, 5.5, 3.5, urgencyRGB(weeklyPct), track, 80);

  return nativeImage.createFromBuffer(pixelsToPNG(SIZE, pixels));
}

module.exports = { makeIcon, makeSpinFrame };
