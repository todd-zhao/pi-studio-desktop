import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const ASSET_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "desktop",
  "assets"
);

const BG = [27, 27, 30, 255];
const GLYPH = [245, 245, 245, 255];
const RADIUS = 52;
const MARGIN = 22;

function insideRoundedRect(x, y) {
  const left = MARGIN;
  const right = SIZE - MARGIN;
  const top = MARGIN;
  const bottom = SIZE - MARGIN;
  if (x < left || x > right || y < top || y > bottom) return 0;
  const cx = Math.max(left + RADIUS, Math.min(right - RADIUS, x));
  const cy = Math.max(top + RADIUS, Math.min(bottom - RADIUS, y));
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= RADIUS) return 1;
  if (dist >= RADIUS + 2) return 0;
  return (RADIUS + 2 - dist) / 2;
}

function insideGlyph(x, y) {
  const barTop = 64;
  const barBottom = 96;
  const barLeft = 56;
  const barRight = 200;
  const legBottom = 200;
  if (x >= barLeft && x <= barRight && y >= barTop && y <= barBottom) return 1;
  if (x >= 56 && x <= 88 && y >= barTop && y <= legBottom) return 1;
  if (x >= 168 && x <= 200 && y >= barTop && y <= legBottom) return 1;
  return 0;
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let bg = 0;
    let glyph = 0;
    for (const ox of [0.25, 0.75]) {
      for (const oy of [0.25, 0.75]) {
        bg += insideRoundedRect(x + ox, y + oy);
        glyph += insideGlyph(x + ox, y + oy);
      }
    }
    bg /= 4;
    glyph /= 4;
    const alpha = Math.max(BG[3] * bg, GLYPH[3] * glyph);
    const i = (y * SIZE + x) * 4;
    if (alpha > 0) {
      const t = (GLYPH[3] * glyph) / alpha;
      rgba[i] = Math.round(BG[0] * (1 - t) + GLYPH[0] * t);
      rgba[i + 1] = Math.round(BG[1] * (1 - t) + GLYPH[1] * t);
      rgba[i + 2] = Math.round(BG[2] * (1 - t) + GLYPH[2] * t);
      rgba[i + 3] = Math.round(alpha);
    }
  }
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = SIZE * 4 + 1;
  const raw = Buffer.alloc(stride * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * stride] = 0; // no filter
    rgba.copy(raw, y * stride + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = encodePng();
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0); // reserved
icoHeader.writeUInt16LE(1, 2); // type: icon
icoHeader.writeUInt16LE(1, 4); // image count

const icoEntry = Buffer.alloc(16);
icoEntry[0] = 0; // width 256
icoEntry[1] = 0; // height 256
icoEntry[2] = 0; // palette
icoEntry[3] = 0; // reserved
icoEntry.writeUInt16LE(1, 4); // planes
icoEntry.writeUInt16LE(32, 6); // bpp
icoEntry.writeUInt32LE(png.length, 8); // bytes
icoEntry.writeUInt32LE(22, 12); // offset

mkdirSync(ASSET_DIR, { recursive: true });
const pngPath = path.join(ASSET_DIR, "icon.png");
const icoPath = path.join(ASSET_DIR, "icon.ico");
writeFileSync(pngPath, png);
writeFileSync(icoPath, Buffer.concat([icoHeader, icoEntry, png]));
console.log(`Icon written: ${pngPath}, ${icoPath}`);
