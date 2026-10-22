// Draws the app icon (the same calendar as public/favicon.svg) into the PNG files the web app
// manifest needs. No dependencies: a tiny rasterizer for rounded rectangles plus a PNG encoder.
//
//   npm run icons
//
// Output (public/icons/):
//   icon-192.png, icon-512.png   transparent background ("any" icons)
//   maskable-512.png             white full-bleed background, artwork inside the safe zone
//   apple-touch-icon.png         180px, white background (iOS home screen)

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// The favicon artwork in its 32×32 coordinate space: [x, y, w, h, radius, color].
const SHAPES = [
  [3, 6, 26, 23, 4, '#3b82f6'], // body
  [3, 6, 26, 7, 3, '#1d4ed8'], // top band
  [9, 3, 3, 7, 1.5, '#1e3a8a'], // left ring
  [20, 3, 3, 7, 1.5, '#1e3a8a'], // right ring
  [8, 17, 6, 4, 1, '#ffffff'], // left day
  [18, 17, 6, 4, 1, '#ffffff'], // right day
];
const ART = { minX: 3, minY: 3, maxX: 29, maxY: 29 };
const SUPERSAMPLE = 4;

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

function insideRoundedRect(px, py, [x, y, w, h, r]) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/**
 * Renders the artwork into an RGBA buffer. `artSize` is how many pixels the artwork spans;
 * it is centred on the canvas, over an optional opaque background.
 */
function render(size, artSize, background) {
  const pixels = new Float64Array(size * size * 4); // premultiplied RGBA, 0..1
  if (background) {
    const [r, g, b] = hex(background);
    for (let i = 0; i < size * size; i++) pixels.set([r / 255, g / 255, b / 255, 1], i * 4);
  }
  const artW = ART.maxX - ART.minX;
  const scale = artSize / artW;
  const offset = (size - artSize) / 2;
  const toArt = (p) => p / scale + ART.minX - offset / scale;

  for (const shape of SHAPES) {
    const [sr, sg, sb] = hex(shape[5]).map((v) => v / 255);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let hits = 0;
        for (let sy = 0; sy < SUPERSAMPLE; sy++) {
          for (let sx = 0; sx < SUPERSAMPLE; sx++) {
            const ax = toArt(x + (sx + 0.5) / SUPERSAMPLE);
            const ay = toArt(y + (sy + 0.5) / SUPERSAMPLE);
            if (insideRoundedRect(ax, ay, shape)) hits++;
          }
        }
        if (!hits) continue;
        const a = hits / SUPERSAMPLE ** 2;
        const i = (y * size + x) * 4;
        // "Source over" compositing, premultiplied.
        pixels[i] = sr * a + pixels[i] * (1 - a);
        pixels[i + 1] = sg * a + pixels[i + 1] * (1 - a);
        pixels[i + 2] = sb * a + pixels[i + 2] * (1 - a);
        pixels[i + 3] = a + pixels[i + 3] * (1 - a);
      }
    }
  }

  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = pixels[i * 4 + 3];
    for (let c = 0; c < 3; c++) {
      out[i * 4 + c] = a ? Math.round((pixels[i * 4 + c] / a) * 255) : 0;
    }
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // no filter
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = new URL('../public/icons/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const icons = [
  // name, size, artwork size, background
  ['icon-192.png', 192, 192 * 0.9, null],
  ['icon-512.png', 512, 512 * 0.9, null],
  // Maskable: Android crops to a circle/squircle; keep the artwork in the central ~60%.
  ['maskable-512.png', 512, 512 * 0.58, '#ffffff'],
  ['apple-touch-icon.png', 180, 180 * 0.72, '#ffffff'],
];

for (const [name, size, artSize, background] of icons) {
  writeFileSync(new URL(name, outDir), encodePng(size, render(size, artSize, background)));
  console.log(`public/icons/${name}`);
}
