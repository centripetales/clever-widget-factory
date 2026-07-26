#!/usr/bin/env node

/**
 * Debug tool: renders the HSV green-mask used by growth-color-metrics.js as a
 * visual overlay (background pixels dimmed to grayscale, masked pixels left in
 * full color) so the threshold can be eyeballed against the source photo instead
 * of trusted from a bare percentage.
 *
 * Usage:
 *   node scripts/growth-color-mask-preview.js <photo_url> <output_png_path> [photo_url output_png_path ...]
 */

const sharp = require('sharp');

const HUE_MIN_DEG = 70;
const HUE_MAX_DEG = 170;
const SATURATION_MIN = 0.15;
const VALUE_MIN = 0.08;
const EXG_THRESHOLD = 0.05;
const RESIZE_MAX_DIM = 800;

async function fetchImageBytes(photoUrl) {
  let url = photoUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://cwf-dev-assets.s3.us-west-2.amazonaws.com/${url}`;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch image from ${url}: ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

function rgbToHsv(r, g, b) {
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rN) h = 60 * (((gN - bN) / delta) % 6);
    else if (max === gN) h = 60 * ((bN - rN) / delta + 2);
    else h = 60 * ((rN - gN) / delta + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
}

// Excess Green Index: uses relative channel dominance (normalized chromaticity),
// not saturation, so it stays sensitive to pale/washed-out or backlit foliage
// where HSV saturation collapses toward zero even though green still dominates.
function excessGreen(r, g, b) {
  const sum = r + g + b;
  if (sum === 0) return 0;
  const rN = r / sum, gN = g / sum, bN = b / sum;
  return 2 * gN - rN - bN;
}

async function renderMaskOverlay(imageBuffer, outPath) {
  const { data, info } = await sharp(imageBuffer)
    .resize(RESIZE_MAX_DIM, RESIZE_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const out = Buffer.alloc(width * height * 3);
  let greenCount = 0;

  for (let i = 0; i < width * height; i++) {
    const off = i * channels;
    const r = data[off], g = data[off + 1], b = data[off + 2];
    const { h, s, v } = rgbToHsv(r, g, b);
    const hsvGreen = h >= HUE_MIN_DEG && h <= HUE_MAX_DEG && s >= SATURATION_MIN && v >= VALUE_MIN;
    const exgGreen = excessGreen(r, g, b) >= EXG_THRESHOLD;
    const isGreen = hsvGreen || exgGreen;
    const outOff = i * 3;
    if (isGreen) {
      greenCount++;
      // Leave masked (plant) pixels in full original color.
      out[outOff] = r;
      out[outOff + 1] = g;
      out[outOff + 2] = b;
    } else {
      // Dim non-masked (background) pixels to grayscale so the mask pops visually.
      const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b) * 0.35;
      out[outOff] = gray;
      out[outOff + 1] = gray;
      out[outOff + 2] = gray;
    }
  }

  await sharp(out, { raw: { width, height, channels: 3 } }).png().toFile(outPath);
  const pct = ((greenCount / (width * height)) * 100).toFixed(2);
  return { width, height, greenPercent: pct };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length % 2 !== 0) {
    console.error('Usage: node scripts/growth-color-mask-preview.js <photo_url> <output_png_path> [...]');
    process.exit(1);
  }
  for (let i = 0; i < args.length; i += 2) {
    const [url, outPath] = [args[i], args[i + 1]];
    console.log(`Rendering mask for ${url} -> ${outPath}`);
    const buf = await fetchImageBytes(url);
    const result = await renderMaskOverlay(buf, outPath);
    console.log(`  ${result.width}x${result.height}, green_pixel_percent=${result.greenPercent}%`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
