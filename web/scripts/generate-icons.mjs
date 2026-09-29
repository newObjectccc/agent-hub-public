/**
 * 零依赖 PNG 图标生成器（Node 内置 zlib，不引入任何图形库）。
 * 生成 PWA 图标 192/512 + maskable 512 + iOS apple-touch-icon 180。
 *
 * 图形：圆角深色底 + 白色"对话气泡"几何图形，纯像素计算绘制（2x2 超采样抗锯齿）。
 * 用法：node scripts/generate-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

// ---------- 最小 PNG 编码 ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 每行前置 filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 图形绘制（0..1 归一化坐标） ----------
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function drawIcon({ size, maskable = false }) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 2; // 超采样
  const bg = [0x14, 0x1b, 0x2e]; // 深蓝黑
  const fg = [0xff, 0xff, 0xff];

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          let col = null;

          // 背景：maskable 为整块方形，普通为圆角矩形
          const bgHit = maskable ? true : inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22);
          if (bgHit) col = bg;

          // 白色对话气泡主体
          if (inRoundRect(x, y, 0.2, 0.22, 0.8, 0.62, 0.12)) col = fg;
          // 气泡尾巴（左下）
          if (x >= 0.28 && x <= 0.46 && y > 0.56 && y <= 0.74 && y - 0.56 >= (x - 0.28) * 0.85) {
            col = fg;
          }
          // 气泡内三个圆点（挖空为背景色）
          for (const dx of [0.33, 0.5, 0.67]) {
            if ((x - dx) ** 2 + (y - 0.42) ** 2 <= 0.048 ** 2) col = bg;
          }

          if (col) {
            const w = 1 / (SS * SS);
            r += col[0] * w;
            g += col[1] * w;
            b += col[2] * w;
            a += 255 * w;
          }
        }
      }
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(a);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(outDir, { recursive: true });
const targets = [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
  ["apple-touch-icon-180.png", 180, true],
];
for (const [name, size, maskable] of targets) {
  writeFileSync(join(outDir, name), drawIcon({ size, maskable }));
  console.log(`generated public/icons/${name} (${size}x${size})`);
}
