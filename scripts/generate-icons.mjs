#!/usr/bin/env node
//
// Generates the PWA icon set from the KODE mark.
//
// Committed as a script rather than as opaque binaries so the icons can be
// regenerated when the brand moves, and so anyone can see exactly how they were
// produced. Run with:  node scripts/generate-icons.mjs
//
// No image library. The mark is a traced polygon set, so the PNGs are encoded
// directly — which keeps the build free of a native dependency that exists
// solely to draw one letter.

import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public');

const BLUE = [0x21, 0x50, 0xa0];
const WHITE = [0xff, 0xff, 0xff];
const NAVY = [0x0d, 0x1f, 0x3f];

/**
 * The mark's contours, read from `@kode/shared` so there is exactly one copy.
 *
 * Six subpaths: the V and the leg, each as an outline, a hairline channel and
 * an inner fill. Even-odd across all six is what preserves the channel.
 */
function loadMarkContours() {
  const brand = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'shared', 'src', 'brand.ts'),
    'utf8',
  );
  const block = /export const KODE_MARK_PATH =([\s\S]*?);\n/.exec(brand);
  if (!block) throw new Error('KODE_MARK_PATH not found in brand.ts');

  const d = [...block[1].matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');

  return d
    .split('M')
    .filter((piece) => piece.trim())
    .map((piece) =>
      [...piece.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => [
        Number.parseFloat(m[1]),
        Number.parseFloat(m[2]),
      ]),
    )
    .filter((points) => points.length > 2);
}

const CONTOURS = loadMarkContours();
const MARK_W = 100;
const MARK_H = 102;

/**
 * Even-odd across every contour.
 *
 * Testing each subpath separately and OR-ing the results would fill the inner
 * channels — the whole point of even-odd is that a crossing inside a hole
 * cancels the one that put us inside the outline.
 */
function insideMark(x, y) {
  let hit = false;
  for (const polygon of CONTOURS) {
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

/**
 * Renders one icon.
 *
 * `inset` is the fraction of the canvas the mark occupies. Maskable icons need
 * the mark inside a 40%-radius safe circle, because Android crops the corners
 * to whatever shape the launcher uses — an icon drawn edge to edge loses its
 * extremities on a circular launcher.
 */
function render(size, { background, foreground, inset, radius }) {
  const pixels = Buffer.alloc(size * size * 4);

  const markWidth = size * inset;
  const markHeight = (markWidth / MARK_W) * MARK_H;
  const offsetX = (size - markWidth) / 2;
  const offsetY = (size - markHeight) / 2;

  // 3× supersampling. The mark is all diagonals, and without it the K's cut
  // edge is visibly stepped at 192px.
  const SAMPLES = 3;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let coverage = 0;
      let inBackground = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;

          if (withinRoundedSquare(px, py, size, radius)) inBackground += 1;

          const mx = ((px - offsetX) / markWidth) * MARK_W;
          const my = ((py - offsetY) / markHeight) * MARK_H;
          if (mx >= 0 && mx <= MARK_W && my >= 0 && my <= MARK_H && insideMark(mx, my)) {
            coverage += 1;
          }
        }
      }

      const total = SAMPLES * SAMPLES;
      const bgAlpha = inBackground / total;
      const fgAlpha = coverage / total;

      const index = (y * size + x) * 4;
      const blended = [0, 1, 2].map((channel) =>
        Math.round(background[channel] * (1 - fgAlpha) + foreground[channel] * fgAlpha),
      );

      pixels[index] = blended[0];
      pixels[index + 1] = blended[1];
      pixels[index + 2] = blended[2];
      pixels[index + 3] = Math.round(255 * Math.max(bgAlpha, fgAlpha * bgAlpha));
    }
  }

  return encodePng(size, size, pixels);
}

function withinRoundedSquare(x, y, size, radius) {
  if (radius <= 0) return true;
  const nearestX = Math.min(Math.max(x, radius), size - radius);
  const nearestY = Math.min(Math.max(y, radius), size - radius);
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

/* ─────────────────────────────────────────────────────────── PNG encoding ── */

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // One filter byte per scanline. Filter 0 (none) keeps the encoder trivial;
  // deflate still compresses a flat-colour icon to a few kilobytes.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ────────────────────────────────────────────────────────────────── output ── */

const ICONS = [
  // The standard set: brand blue ground, white mark, rounded like an app icon.
  { name: 'icon-192.png', size: 192, background: BLUE, foreground: WHITE, inset: 0.5, radius: 38 },
  { name: 'icon-512.png', size: 512, background: BLUE, foreground: WHITE, inset: 0.5, radius: 102 },
  // Maskable: full-bleed square, mark pulled well inside the safe circle.
  {
    name: 'icon-maskable.png',
    size: 512,
    background: BLUE,
    foreground: WHITE,
    inset: 0.34,
    radius: 0,
  },
  // iOS does not honour the manifest; it wants its own square, and it applies
  // its own corner radius, so this one is drawn flat.
  {
    name: 'apple-touch-icon.png',
    size: 180,
    background: NAVY,
    foreground: WHITE,
    inset: 0.46,
    radius: 0,
  },
];

await mkdir(OUT_DIR, { recursive: true });

for (const icon of ICONS) {
  const png = render(icon.size, icon);
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(join(OUT_DIR, icon.name));
    stream.on('error', reject);
    stream.on('finish', resolve);
    stream.end(png);
  });
  process.stdout.write(`  ${icon.name.padEnd(24)} ${icon.size}×${icon.size}  ${png.length} bytes\n`);
}

process.stdout.write('\nIcons written to apps/web/public/\n');
