// Authors soft facial folds in the head's existing rest-space atlas.
// Three forehead folds, brow compression and smile lines follow the reference.
// Run with `node scripts/build-reference-wrinkles.mjs`; original maps are retained.
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const R = 2048, x0 = -1.05, y0 = -1.80, sx = 2.10, sy = 3.25;
const dx = sx / (R - 1), dy = sy / (R - 1);
const height = new Float32Array(R * R);
const points = (count, fn) => Array.from({ length: count }, (_, i) => fn(i / (count - 1)));
function stroke(curve, width, depth, ridge = .22) {
  const margin = width * 7;
  const xs = curve.map(p => p[0]), ys = curve.map(p => p[1]);
  const left = Math.max(0, Math.floor((Math.min(...xs) - margin - x0) / dx));
  const right = Math.min(R - 1, Math.ceil((Math.max(...xs) + margin - x0) / dx));
  const bottom = Math.max(0, Math.floor((Math.min(...ys) - margin - y0) / dy));
  const top = Math.min(R - 1, Math.ceil((Math.max(...ys) + margin - y0) / dy));
  for (let y = bottom; y <= top; y++) for (let x = left; x <= right; x++) {
    const px = x0 + x * dx, py = y0 + y * dy;
    let nearest = Infinity, along = 0;
    for (let j = 0; j < curve.length - 1; j++) {
      const a = curve[j], b = curve[j + 1], vx = b[0] - a[0], vy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / Math.max(1e-12, vx * vx + vy * vy)));
      const distance = (px - a[0] - t * vx) ** 2 + (py - a[1] - t * vy) ** 2;
      if (distance < nearest) { nearest = distance; along = (j + t) / (curve.length - 1); }
    }
    const taper = Math.max(0, Math.sin(Math.PI * along)) ** .65;
    const trough = Math.exp(-nearest / (2 * width * width));
    const shoulder = Math.exp(-nearest / (2 * (width * 3.1) ** 2));
    height[y * R + x] += depth * taper * (ridge * shoulder - trough);
  }
}
// Broad, gently curved folds with rounded shoulders rather than straight cuts.
/* Previous widely spaced forehead curves retained for reference.
for (const [i, cy, span, width, depth] of [
  [0, .535, .45, .010, .0084],
  [1, .655, .50, .0115, .0092],
  [2, .785, .46, .009, .0072],
]) {
  stroke(points(42, t => {
    const u = t * 2 - 1;
    return [u * span, cy + .045 * u * u - .009 * Math.cos(u * Math.PI)
      + .0035 * Math.sin(u * 10 + i * 1.4)];
  }), width, depth);
}
*/
// The reference groups three uneven folds above the brow, with a fuller middle fold.
// Keep the lower arc above the eyebrows and let their soft shoulders blend naturally.
for (const [i, cy, span, width, depth] of [
  [0, .665, .405, .0105, .0055],
  [1, .727, .465, .0125, .0068],
  [2, .795, .425, .0090, .0042],
]) {
  stroke(points(64, t => {
    const u = t * 2 - 1;
    const bend = .026 * u * u - .008 * Math.cos(u * Math.PI);
    const uneven = .0045 * Math.sin(u * 7.5 + i * 1.25)
      + .0020 * Math.sin(u * 15.0 - i * .8) + .0030 * u;
    return [u * span + .008 * Math.sin(i * 2.1), cy + bend + uneven];
  }), width, depth, .24);
}
for (const side of [-1, 1]) {
  // stroke(points(25, t => [side * (.045 + .013 * Math.sin(t * 2.5)), .33 + t * .19]), .005, .0042);
  stroke(points(25, t => [side * (.047 + .012 * Math.sin(t * 2.5)), .44 + t * .14]), .007, .0020);
  // Nasolabial and mouth-corner folds stay outside the vermilion.
  // stroke(points(40, t => [side * (.118 + .225 * t - .072 * t * t), -.035 - .375 * t]), .0105, .0058, .28);
  // stroke(points(25, t => [side * (.245 + .025 * Math.sin(t * 2.1)), -.355 - .19 * t]), .007, .0024);
  // Smile folds have broader, softer relief; the mouth-corner tail fades out early.
  stroke(points(48, t => [side * (.118 + .225 * t - .072 * t * t), -.035 - .375 * t]), .0125, .0044, .26);
  stroke(points(32, t => [side * (.245 + .025 * Math.sin(t * 2.1)), -.355 - .16 * t]), .008, .0014);
  for (let i = 0; i < 9; i++) {
    stroke(points(16, t => [side * (.355 + (i % 3) * .055 + t * .045),
      -.025 - Math.floor(i / 3) * .08 - .022 * t + .003 * Math.sin(t * 6 + i)]), .0021, .0008);
  }
}
for (let i = 0; i < 2; i++) {
  stroke(points(30, t => { const u = t * 2 - 1; return [u * .32, -.97 - i * .21 + .06 * u * u]; }), .007, .0016);
}

// Encode the negative height gradient in RG and crease depth in B, as the shader expects.
const rgba = Buffer.alloc(R * (R * 4 + 1));
const encode = v => Math.round(128 + Math.max(-1, Math.min(1, v)) * 127);
for (let row = 0; row < R; row++) {
  const y = R - 1 - row; // PNG top is the forehead; texture V=0 is the atlas bottom.
  for (let x = 0; x < R; x++) {
    const i = y * R + x, o = row * (R * 4 + 1) + 1 + x * 4;
    rgba[o] = encode((height[y * R + Math.max(0, x - 1)] - height[y * R + Math.min(R - 1, x + 1)]) / (2 * dx));
    rgba[o + 1] = encode((height[Math.max(0, y - 1) * R + x] - height[Math.min(R - 1, y + 1) * R + x]) / (2 * dy));
    rgba[o + 2] = Math.round(Math.max(0, Math.min(1, -height[i] / .012)) * 255);
    rgba[o + 3] = 255;
  }
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(R, 0); header.writeUInt32BE(R, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header), chunk('IDAT', deflateSync(rgba)), chunk('IEND', Buffer.alloc(0))]);
// const target = path.join(root, 'assets/textures/skin/anatomy-age-reference-v2.png');
const target = path.join(root, 'assets/textures/skin/anatomy-age-reference-v3.png');
fs.writeFileSync(target, png);
console.log(`Created ${path.relative(root, target)} (${R} x ${R}, ${png.length} bytes)`);
