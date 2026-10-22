/**
 * 占位图标生成（一次性工具，产物已入仓库，平时无需运行）：
 *   assets/trayTemplate.png —— macOS 托盘模板图（16x16 黑色形状，透明底）
 *   assets/tray.png         —— 托盘图标（32x32 彩色，Windows/兜底用）
 *   build/icon.png          —— electron-builder 应用图标（512x512）
 * 仅用 node:zlib 手写 PNG（无第三方绘图依赖），图形为"圆+竖笔"的占位 d 标。
 * 正式品牌图标到位后直接覆盖这三个文件即可。
 * 用法：node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- PNG 编码（8-bit RGBA）----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 形状绘制：圆角方块底 + "d" 形（圆环 + 竖笔），所有坐标按比例 ----
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return Math.max(outside, Math.min(Math.max(dx, dy), 0)) - radius;
}

/** alpha 抗锯齿覆盖度：sdf <= -1 全内、>= 1 全外 */
function coverage(sdf) {
  return Math.max(0, Math.min(1, 0.5 - sdf));
}

function subpixelCoverage(sdfAt) {
  // 2x2 子采样，缓解小尺寸边缘锯齿
  let sum = 0;
  for (const [ox, oy] of [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ]) {
    sum += coverage(sdfAt(ox, oy));
  }
  return sum / 4;
}

function drawIcon(size, { withBackground }) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [65, 118, 230]; // dsw 品牌蓝 rgb(65,118,230)
  const fg = withBackground ? [255, 255, 255] : [0, 0, 0]; // 模板图要求纯黑形状
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const sdf = (ox, oy) => roundedRectSdf(px + ox - 0.5, py + oy - 0.5, size / 2, size / 2, size * 0.48, size * 0.48, size * 0.22);
      let alpha = withBackground ? subpixelCoverage(sdf) : 0;
      // "d" 形：圆环 + 右侧竖笔
      const ringCx = size * 0.42;
      const ringCy = size * 0.52;
      const ringOuter = size * 0.2;
      const ringInner = size * 0.1;
      const ringSdf = (ox, oy) => {
        const d = Math.hypot(px + ox - 0.5 - ringCx, py + oy - 0.5 - ringCy);
        return Math.max(d - ringOuter, ringInner - d);
      };
      const stemSdf = (ox, oy) =>
        roundedRectSdf(px + ox - 0.5, py + oy - 0.5, size * 0.62, size * 0.52, size * 0.045, size * 0.24, size * 0.045);
      const glyphAlpha = Math.max(subpixelCoverage(ringSdf), subpixelCoverage(stemSdf));
      const index = (y * size + x) * 4;
      if (glyphAlpha > 0) {
        rgba[index] = fg[0];
        rgba[index + 1] = fg[1];
        rgba[index + 2] = fg[2];
        rgba[index + 3] = Math.round(Math.max(alpha, glyphAlpha) * 255);
      } else if (withBackground) {
        rgba[index] = bg[0];
        rgba[index + 1] = bg[1];
        rgba[index + 2] = bg[2];
        rgba[index + 3] = Math.round(alpha * 255);
      }
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(join(projectRoot, 'assets'), { recursive: true });
mkdirSync(join(projectRoot, 'build'), { recursive: true });
writeFileSync(join(projectRoot, 'assets/trayTemplate.png'), drawIcon(16, { withBackground: false }));
writeFileSync(join(projectRoot, 'assets/tray.png'), drawIcon(32, { withBackground: true }));
writeFileSync(join(projectRoot, 'build/icon.png'), drawIcon(512, { withBackground: true }));
console.log('已生成 assets/trayTemplate.png assets/tray.png build/icon.png');
