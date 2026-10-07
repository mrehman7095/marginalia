// Regenerates extension/icons/*.png without dependencies: node dev/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => buf.reduce((c, b) => crcTable[(c ^ b) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff;
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
};

const roundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.max(x0 + r, Math.min(x1 - r, x)), cy = Math.max(y0 + r, Math.min(y1 - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
};

// Shape in unit coordinates: gradient tile, white page, margin rule, amber note dot.
function color(u, v) {
  if (!roundRect(u, v, 0, 0, 1, 1, 0.22)) return null;
  const t = (u + v) / 2;
  let c = [52 + (107 - 52) * t, 81 + (70 - 81) * t, 209 + (193 - 209) * t];
  if (roundRect(u, v, 0.24, 0.18, 0.76, 0.82, 0.06)) c = [255, 255, 255];
  if (u > 0.37 && u < 0.41 && v > 0.18 && v < 0.82) c = [214, 220, 240];
  if (v > 0.34 && v < 0.38 && u > 0.47 && u < 0.68) c = [180, 188, 214];
  if (v > 0.48 && v < 0.52 && u > 0.47 && u < 0.62) c = [180, 188, 214];
  if ((u - 0.7) ** 2 + (v - 0.72) ** 2 < 0.16 ** 2) c = [229, 163, 54];
  return c;
}

for (const size of [16, 32, 48, 128]) {
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = color((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0;
      raw[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(new URL(`../extension/icons/icon${size}.png`, import.meta.url), png);
}
