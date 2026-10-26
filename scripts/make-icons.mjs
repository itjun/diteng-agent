/**
 * 从正式品牌源重建图标：node scripts/make-icons.mjs（macOS + Xcode 26+）。
 * appicon.icon 保留独立标志图层，由系统渲染深浅色、透明和染色外观；
 * ICNS/PNG 供旧版 macOS、DMG 和 Windows 使用，模板图供 macOS 菜单栏使用。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(scriptPath));
const iconSource = join(projectRoot, 'build/appicon.icon');
const assetsPath = join(projectRoot, 'assets');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败（${result.status}）`);
}

if (process.versions.electron) {
  const { app, nativeImage } = await import('electron');
  app.whenReady().then(() => {
    try {
      const output = process.argv[2];
      const tile = nativeImage.createFromPath(join(output, 'default.png')).resize({ width: 824, height: 824, quality: 'best' });
      if (tile.isEmpty()) throw new Error('原生图标渲染为空');
      const tilePixels = tile.toBitmap();
      const iconPixels = Buffer.alloc(1024 * 1024 * 4);
      for (let y = 0; y < 824; y++) {
        tilePixels.copy(iconPixels, ((y + 100) * 1024 + 100) * 4, y * 824 * 4, (y + 1) * 824 * 4);
      }
      const color = nativeImage.createFromBitmap(iconPixels, { width: 1024, height: 1024 });
      writeFileSync(join(projectRoot, 'build/icon.png'), color.toPNG());
      const iconset = join(output, 'appicon.iconset');
      mkdirSync(iconset);
      for (const size of [16, 32, 128, 256, 512]) {
        for (const scale of [1, 2]) {
          const suffix = scale === 1 ? '' : '@2x';
          writeFileSync(join(iconset, `icon_${size}x${size}${suffix}.png`), color.resize({ width: size * scale, height: size * scale, quality: 'best' }).toPNG());
        }
      }
      const source = nativeImage.createFromPath(join(iconSource, 'Assets/brand-mark.png'));
      if (source.isEmpty()) throw new Error('品牌标志图层为空');
      const { width, height } = source.getSize();
      const bitmap = source.toBitmap();
      let left = width;
      let top = height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (bitmap[(y * width + x) * 4 + 3] < 128) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      if (right < left) throw new Error('品牌标志图层没有可见像素');
      const mark = source.crop({ x: left, y: top, width: right - left + 1, height: bottom - top + 1 });
      for (const scale of [1, 2]) {
        const size = 16 * scale;
        const inset = scale;
        const ratio = (size - inset * 2) / Math.max(mark.getSize().width, mark.getSize().height);
        const scaledWidth = Math.round(mark.getSize().width * ratio);
        const scaledHeight = Math.round(mark.getSize().height * ratio);
        const scaled = mark.resize({ width: scaledWidth, height: scaledHeight, quality: 'best' }).toBitmap();
        const pixels = Buffer.alloc(size * size * 4);
        const offsetX = Math.floor((size - scaledWidth) / 2);
        const offsetY = Math.floor((size - scaledHeight) / 2);
        for (let y = 0; y < scaledHeight; y++) {
          for (let x = 0; x < scaledWidth; x++) {
            // 只保留 alpha：纯黑模板由 macOS 着色，不能带白色底板或预先反色。
            pixels[((y + offsetY) * size + x + offsetX) * 4 + 3] = scaled[(y * scaledWidth + x) * 4 + 3];
          }
        }
        const suffix = scale === 1 ? '' : '@2x';
        const template = nativeImage.createFromBitmap(pixels, { width: size, height: size });
        writeFileSync(join(assetsPath, `trayTemplate${suffix}.png`), template.toPNG());
        writeFileSync(join(assetsPath, `tray${suffix}.png`), color.resize({ width: 32 * scale, height: 32 * scale, quality: 'best' }).toPNG());
      }
      app.quit();
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
} else {
  if (process.platform !== 'darwin') throw new Error('重建图标需要 macOS 与 Xcode 26+；其他平台直接使用已入库的图标');
  mkdirSync(assetsPath, { recursive: true });
  const output = mkdtempSync(join(tmpdir(), 'diteng-icons-'));
  try {
    const locatedTool = spawnSync('xcrun', ['--find', 'actool'], { encoding: 'utf8' });
    if (locatedTool.status !== 0) throw new Error('找不到 Xcode actool');
    const composer = resolve(dirname(locatedTool.stdout.trim()), '../../../Applications/Icon Composer.app/Contents/Executables/ictool');
    run(composer, [iconSource, '--export-image', '--output-file', join(output, 'default.png'),
      '--platform', 'macOS', '--rendition', 'Default', '--width', '1024', '--height', '1024', '--scale', '1']);
    const require = createRequire(import.meta.url);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    run(require('electron'), [scriptPath, output], { env });
    run('iconutil', ['--convert', 'icns', join(output, 'appicon.iconset'), '--output', join(projectRoot, 'build/icon.icns')]);
    for (const name of ['trayTemplate@2x.png', 'tray@2x.png']) {
      run('sips', ['--setProperty', 'dpiWidth', '144', '--setProperty', 'dpiHeight', '144', join(assetsPath, name)]);
    }
    console.log('已重建 build/icon.icns、build/icon.png 与 assets/ 下的彩色/模板托盘图标（含 @2x）');
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
