// Generates web/icons/*.png and icon.svg (no external tools needed).
// Usage: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x1f, 0x4e, 0x79], FG = [0xff, 0xff, 0xff], AC = [0xf2, 0xa9, 0x3b];

// shapes in a 100x100 design space
function colorAt(x, y) {
  // document sheet with folded corner
  if (x >= 26 && x <= 74 && y >= 16 && y <= 84 && !(x > 62 && y < 16 + (x - 62))) {
    if (x > 62 && y < 28 && y >= 16 + (x - 62) - 0.5 && y <= 16 + (x - 62) + 1.5) return BG;
    // drawing lines on the sheet
    const inLine = (yy) => y >= yy && y <= yy + 3 && x >= 33 && x <= 67;
    if (inLine(36) || inLine(46) || inLine(56)) return BG;
    // arrow (convert) at bottom
    if (y >= 66 && y <= 76) {
      if (x >= 33 && x <= 56 && y >= 69.5 && y <= 72.5) return AC;
      if (x >= 54 && x <= 66 && Math.abs(y - 71) <= (66 - x) * 0.55) return AC;
    }
    return FG;
  }
  return BG;
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const ss = 4; // supersampling
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = colorAt(((px + (sx + 0.5) / ss) / size) * 100, ((py + (sy + 0.5) / ss) / size) * 100);
          r += c[0]; g += c[1]; b += c[2];
        }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = r / (ss * ss); raw[o + 1] = g / (ss * ss); raw[o + 2] = b / (ss * ss); raw[o + 3] = 255;
    }
  }
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const s of [180, 192, 512]) writeFileSync(join(outDir, `icon-${s}.png`), png(s));
writeFileSync(join(outDir, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" fill="#1f4e79"/>
<path d="M26 16H62L74 28V84H26Z" fill="#fff"/>
<path d="M62 16V28H74" fill="none" stroke="#1f4e79" stroke-width="2"/>
<g fill="#1f4e79"><rect x="33" y="36" width="34" height="3"/><rect x="33" y="46" width="34" height="3"/><rect x="33" y="56" width="34" height="3"/></g>
<path d="M33 69.5H54V66L66 71L54 76V72.5H33Z" fill="#f2a93b"/>
</svg>
`);
console.log('icons written to', outDir);
