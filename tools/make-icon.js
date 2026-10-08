'use strict';

/**
 * 生成程序图标（build/icon.png 与 build/icon.ico）。
 *
 * 不想为了一个图标去引图形库，所以这里直接用 Node 手写：
 * 先把图形按 4 倍超采样画进像素缓冲（顺便就把抗锯齿做了），
 * 再编码成 PNG（zlib 是内置的），最后把几个尺寸塞进 ICO 容器。
 *
 * 图案是一块木纹棋盘加两颗棋子 —— 比放个汉字在高分屏小尺寸下更容易认。
 *
 * 用法： node tools/make-icon.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.resolve(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // 超采样倍数

// ---------------------------------------------------------------- PNG 编码

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前面加一个 filter 字节（0 = 不过滤）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO 容器：可以直接内嵌 PNG（Vista 以后都支持） */
function encodeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = 图标
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size; // 256 用 0 表示
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// ---------------------------------------------------------------- 画图

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 圆角矩形内部判定 */
function inRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  if (px >= x + r && px <= x + w - r) return py >= y && py <= y + h;
  if (py >= y + r && py <= y + h - r) return px >= x && px <= x + w;
  return dx * dx + dy * dy <= r * r;
}

/** 给一颗棋子着色：径向渐变 + 一点点高光，让它别像纯色圆片 */
function stoneColor(cx, cy, r, px, py, dark) {
  const d = Math.hypot(px - cx, py - cy) / r;
  const lx = (px - cx) / r;
  const ly = (py - cy) / r;
  const light = clamp01(1 - Math.hypot(lx + 0.38, ly + 0.42) * 0.85);
  if (dark) return mix([86, 92, 102], [6, 8, 11], clamp01(d * 0.9 + 0.1 - light * 0.35));
  return mix([255, 255, 255], [196, 202, 211], clamp01(d * 0.55 - light * 0.5));
}

/** 采样一个点，返回 [r,g,b,a]（逻辑坐标，范围 0..size） */
function sample(px, py, size) {
  const R = size * 0.22;
  if (!inRoundRect(px, py, 0, 0, size, size, R)) return [0, 0, 0, 0];

  // 木纹底色
  let c = mix([233, 201, 143], [203, 154, 86], clamp01((px + py) / (2 * size) * 1.15));

  // 3x3 的棋盘线
  const inset = size * 0.26;
  const step = (size - inset * 2) / 2;
  const lw = Math.max(size * 0.022, 1);
  for (let i = 0; i < 3; i++) {
    const g = inset + step * i;
    if (Math.abs(px - g) < lw / 2 || Math.abs(py - g) < lw / 2) return [96, 66, 30, 255];
  }

  // 两颗子：黑在左上、白在右下
  const sr = size * 0.14;
  const bx = inset;
  const by = inset;
  const wx = inset + step * 2;
  const wy = inset + step * 2;
  if (Math.hypot(px - wx, py - wy) <= sr) {
    const [r, g, b] = stoneColor(wx, wy, sr, px, py, false);
    return [r, g, b, 255];
  }
  if (Math.hypot(px - bx, py - by) <= sr) {
    const [r, g, b] = stoneColor(bx, by, sr, px, py, true);
    return [r, g, b, 255];
  }

  return [c[0], c[1], c[2], 255];
}

function render(size) {
  const W = size * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = sample((x * SS + sx + 0.5) / SS, (y * SS + sy + 0.5) / SS, size);
          const w = ca / 255;
          r += cr * w;
          g += cg * w;
          b += cb * w;
          a += ca;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const i = (y * size + x) * 4;
      if (alpha > 0) {
        const wsum = a / 255 || 1;
        out[i] = Math.round(r / wsum);
        out[i + 1] = Math.round(g / wsum);
        out[i + 2] = Math.round(b / wsum);
      }
      out[i + 3] = Math.round(alpha);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

fs.mkdirSync(OUT_DIR, { recursive: true });

const images = SIZES.map((size) => ({ size, data: encodePNG(size, size, render(size)) }));
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeICO(images));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), images[images.length - 1].data);

console.log(`已生成图标：`);
for (const img of images) {
  console.log(`  ${String(img.size).padStart(3)}x${img.size}  ${(img.data.length / 1024).toFixed(1)} KB`);
}
console.log(`  -> build/icon.ico`);
console.log(`  -> build/icon.png`);
