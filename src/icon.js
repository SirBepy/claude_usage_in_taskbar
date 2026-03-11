"use strict";

const { nativeImage } = require("electron");
const zlib = require("zlib");

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

function makeCirclePNG(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // 8-bit RGBA

  const cx = size / 2,
    cy = size / 2,
    radius = size / 2 - 0.5;
  const rowLen = 1 + size * 4;
  const raw = Buffer.alloc(size * rowLen, 0);

  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5,
        dy = y - cy + 0.5;
      const a = Math.sqrt(dx * dx + dy * dy) <= radius ? 255 : 0;
      const o = y * rowLen + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }

  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Returns a 22×22 circle nativeImage coloured by usage percentage.
 * @param {number|null} pct  0–100, or null for "unknown/loading" (blue)
 */
function iconForPct(pct) {
  let r, g, b;
  if (pct == null) {
    [r, g, b] = [74, 144, 226];   // blue — unknown / loading
  } else if (pct < 50) {
    [r, g, b] = [39, 174, 96];    // green
  } else if (pct < 80) {
    [r, g, b] = [230, 126, 34];   // orange
  } else {
    [r, g, b] = [231, 76, 60];    // red
  }
  return nativeImage.createFromBuffer(makeCirclePNG(22, r, g, b));
}

module.exports = { iconForPct };
