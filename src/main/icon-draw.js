'use strict';
/*
 * Draws the "Cody" mascot (rounded robot head with antenna) into PNG buffers with no dependencies.
 * Used for the tray icon at runtime and by scripts/make-icons.js for the app icon.
 */
const zlib = require('zlib');

const clamp = (x) => Math.max(0, Math.min(1, x));

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;
function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/** Mascot body SDF in unit coords (0..1), with eyes as a separate SDF. */
function mascot(x, y) {
  const head = sdRoundRect(x, y, 0.5, 0.6, 0.38, 0.28, 0.14);
  const stem = sdSegment(x, y, 0.5, 0.32, 0.5, 0.17, 0.035);
  const ball = sdCircle(x, y, 0.5, 0.13, 0.075);
  const body = Math.min(head, stem, ball);
  const eyes = Math.min(sdCircle(x, y, 0.36, 0.6, 0.075), sdCircle(x, y, 0.64, 0.6, 0.075));
  return { body, eyes };
}

function hex(c) { const n = parseInt(c.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

/**
 * @param {number} size  pixel size
 * @param {object} o
 *   o.mode: 'template' (black silhouette, eyes cut out) | 'color' (colored mascot, transparent bg) | 'app' (dark tile bg)
 *   o.color, o.bg, o.eye: hex colors; o.badge: hex color of a status dot (top-right), optional
 */
function renderRGBA(size, o = {}) {
  const mode = o.mode || 'color';
  const fg = hex(o.color || (mode === 'template' ? '#000000' : '#8B7CF6'));
  const bg = hex(o.bg || '#171922');
  const eye = hex(o.eye || '#171922');
  const badge = o.badge ? hex(o.badge) : null;
  const buf = Buffer.alloc(size * size * 4);
  const SS = 3; // supersampling per axis
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          let x = (px + (sx + 0.5) / SS) / size;
          let y = (py + (sy + 0.5) / SS) / size;
          let col = null, alpha = 0;
          if (mode === 'app') {
            const tile = sdRoundRect(x, y, 0.5, 0.5, 0.45, 0.45, 0.2);
            if (tile <= 0) { col = bg; alpha = 1; }
            // mascot scaled into the tile
            x = (x - 0.5) / 0.68 + 0.5; y = (y - 0.5) / 0.68 + 0.5;
          }
          const m = mascot(x, y);
          if (m.body <= 0) {
            if (m.eyes <= 0) {
              if (mode === 'template' || mode === 'color') { if (!col) alpha = 0; }
              else { col = eye; alpha = 1; }
            } else { col = fg; alpha = 1; }
          }
          if (badge) {
            const d = sdCircle(x, y, 0.84, 0.18, 0.15);
            if (d <= 0) { col = badge; alpha = 1; }
          }
          if (col && alpha) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}

// --- minimal PNG encoder ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mascotPNG(size, opts) { return encodePNG(renderRGBA(size, opts), size, size); }

module.exports = { mascotPNG };
