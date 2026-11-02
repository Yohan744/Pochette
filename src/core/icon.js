'use strict';

/*
 * Composes a Finder icon from a cover: margin, rounded corners, subtle border
 * and drop shadow, like macOS icons. No dependencies: works directly on
 * the pixels (premultiplied BGRA from nativeImage.toBitmap / createFromBitmap).
 */

const SIZE = 1024; // icon canvas
const BOX = 880; // cover size inside the canvas
const RADIUS = 78; // corner radius
const SHADOW = { dy: 10, sigma: 14, opacity: 0.32 };
const BORDER = { width: 2.5, opacity: 0.22 };

const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Signed distance from a point to the edge of a centered rounded rectangle (negative inside). */
function roundedDist(x, y, cx, cy, half, r) {
  const qx = Math.abs(x - cx) - (half - r);
  const qy = Math.abs(y - cy) - (half - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * @param src  BGRA pixels of the cover, already cropped square and resized to BOX × BOX
 * @returns    premultiplied BGRA pixels, SIZE × SIZE
 */
function composeIcon(src) {
  if (src.length !== BOX * BOX * 4) throw new Error(`Expected a ${BOX}×${BOX} bitmap`);
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const off = (SIZE - BOX) / 2;
  const c = SIZE / 2;
  const half = BOX / 2;
  const s2 = SHADOW.sigma * 2;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d = roundedDist(px, py, c, c, half, RADIUS);
      const cov = clamp(0.5 - d); // anti-aliased coverage of the cover

      // drop shadow: offset downwards, soft edge
      const ds = roundedDist(px, py - SHADOW.dy, c, c, half, RADIUS);
      const t = clamp((ds + SHADOW.sigma) / (s2 + SHADOW.sigma));
      const sa = SHADOW.opacity * (1 - t * t * (3 - 2 * t));

      const i = (y * SIZE + x) * 4;
      if (cov <= 0) {
        out[i + 3] = Math.round(sa * 255); // black shadow: premultiplied RGB = 0
        continue;
      }
      // dark inner border so light covers stand out from the background
      const ba = BORDER.opacity * clamp(1 - Math.abs(d + BORDER.width / 2) / (BORDER.width / 2));
      const sx = Math.min(BOX - 1, Math.max(0, Math.floor(px - off)));
      const sy = Math.min(BOX - 1, Math.max(0, Math.floor(py - off)));
      const j = (sy * BOX + sx) * 4;
      const k = cov * (1 - ba);
      out[i] = Math.round(src[j] * k);
      out[i + 1] = Math.round(src[j + 1] * k);
      out[i + 2] = Math.round(src[j + 2] * k);
      out[i + 3] = Math.round((cov + sa * (1 - cov)) * 255);
    }
  }
  return out;
}

module.exports = { composeIcon, SIZE, BOX };
