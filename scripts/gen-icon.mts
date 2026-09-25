/**
 * Generates an original JARVIS app icon (dark square, accent ring, core dot)
 * as a raw PNG — no image libraries needed. Run: npx tsx scripts/gen-icon.mts
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const SIZE = 512;
const px = new Uint8Array(SIZE * SIZE * 4);

const set = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
};

const cx = SIZE / 2, cy = SIZE / 2;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= 190 && d > 150) set(x, y, 0x58, 0xa6, 0xff);        // accent ring
    else if (d <= 150) set(x, y, 0x0d, 0x11, 0x17);               // inner dark
    else if (d <= 205 && d > 190) set(x, y, 0x2d, 0x33, 0x3b);    // ring edge
    else set(x, y, 0x16, 0x1b, 0x22);                              // outer bg
    // core dot + orbit dots
    if (Math.hypot(x - cx, y - cy) <= 40) set(x, y, 0x58, 0xa6, 0xff);
    for (const ang of [0, 72, 144, 216, 216 + 72].map((a) => (a * Math.PI) / 180)) {
      if (Math.hypot(x - cx + 110 * Math.cos(ang), y - cy + 110 * Math.sin(ang)) <= 16) {
        set(x, y, 0xe6, 0xed, 0xf3);
      }
    }
  }
}

// encode PNG
const crcTable = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.concat([...Array(SIZE)].map((_, y) => Buffer.concat([Buffer.from([0]), px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4)])));
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync('apps/desktop/src-tauri/icons', { recursive: true });
writeFileSync('apps/desktop/src-tauri/icons/icon.png', png);
console.log('icon written:', png.length, 'bytes');
