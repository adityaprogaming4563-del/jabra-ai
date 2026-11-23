import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createIconPng(size, maskable = false) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const cx = size / 2;
  const cy = size / 2;
  // Maskable icons keep all visual marks strictly inside central 72% safe zone
  const scale = maskable ? 0.72 : 0.92;
  const rOuter = size * 0.35 * scale;
  const rInner = size * 0.25 * scale;
  const diamondRadius = size * 0.16 * scale;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const idx = rowStart + 1 + x * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);

      const grad = (x + y) / (2 * size);
      let r = Math.round(5 + grad * 12);
      let g = Math.round(10 + grad * 24);
      let b = Math.round(24 + grad * 56);
      const a = 255;

      // Sapphire ring
      if (dist <= rOuter && dist >= rInner) {
        const ringT = (dist - rInner) / (rOuter - rInner);
        const glow = Math.sin(ringT * Math.PI);
        r = Math.round(37 + glow * 28);
        g = Math.round(99 + glow * 92);
        b = Math.round(235 + glow * 20);
      }

      // Stylized four-point geometric star / diamond
      const manhattan = Math.abs(dx) * 1.15 + Math.abs(dy) * 0.85;
      const crossHoriz = Math.abs(dx) * 0.85 + Math.abs(dy) * 1.4;
      if (manhattan <= diamondRadius) {
        r = 224;
        g = 242;
        b = 254;
      } else if (crossHoriz <= diamondRadius * 0.92) {
        r = 56;
        g = 189;
        b = 248;
      }

      // Subtle navy core inside star
      if (dist <= size * 0.038 * scale) {
        r = 5;
        g = 10;
        b = 24;
      }

      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const compressed = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(publicDir, { recursive: true });

const targets = [
  { file: 'pwa-192x192.png', size: 192, maskable: false },
  { file: 'pwa-512x512.png', size: 512, maskable: false },
  { file: 'pwa-maskable-512x512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
];

for (const { file, size, maskable } of targets) {
  const outPath = path.join(publicDir, file);
  if (!fs.existsSync(outPath)) {
    fs.writeFileSync(outPath, createIconPng(size, maskable));
  }
}
