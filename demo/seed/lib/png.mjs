// Generates SYNTHETIC images for the demo (no photographs of real people): a soft
// two-colour gradient with a few geometric marks, encoded as a valid PNG using
// only node:zlib. Deterministic per seed so a reseed produces identical bytes.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** @param palette [[r,g,b],[r,g,b]] */
export function syntheticPng(width, height, palette, seed = 1) {
  const [a, b] = palette;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const ring = Math.hypot(x - width * 0.5, y - height * 0.45) % (40 + seed * 7) < 3 ? 30 : 0;
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = Math.min(255, Math.round(a[0] + (b[0] - a[0]) * t) + ring);
      raw[o + 1] = Math.min(255, Math.round(a[1] + (b[1] - a[1]) * t) + ring);
      raw[o + 2] = Math.min(255, Math.round(a[2] + (b[2] - a[2]) * t) + ring);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
