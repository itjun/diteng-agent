/** 真实反馈编辑器的视口与标注导出回归；隔离 Electron，不访问账号或系统剪贴板。 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { ensureVite } from './e2e-app-control.mjs';

const fixtureDir = mkdtempSync(join(tmpdir(), 'diteng-feedback-viewport-'));
const mainPath = join(fixtureDir, 'main.cjs');
writeFileSync(mainPath, `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => { const win = new BrowserWindow({ width: 1200, height: 850, webPreferences: { nodeIntegration: false, contextIsolation: true } }); win.loadURL('about:blank'); });`);
let app;
let browser;
try {
  await ensureVite();
  const entry = await (await fetch('http://127.0.0.1:5173/src/main.tsx')).text();
  const reactUrl = entry.match(/from "([^"]*deps\/react\.js[^"]*)"/)[1];
  const reactDomUrl = entry.match(/from "([^"]*deps\/react-dom_client\.js[^"]*)"/)[1];
  app = spawn(electronPath, [mainPath, '--remote-debugging-port=0', '--user-data-dir=' + join(fixtureDir, 'profile')], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Electron CDP 未就绪')), 15000);
    app.stderr.on('data', (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page');
  await page.route('**/__feedback-test__', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-platform="darwin"><body style="margin:0"><div id="root"></div><script type="module">
import React from '${reactUrl}';
import ReactDOM from '${reactDomUrl}';
import '/theme/base.css';
import '/theme/design-platform.css';
import '/src/global.css';
const { injectIntoGlobalHook } = await import('/@react-refresh');
injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
const { FeedbackEditor } = await import('/src/FeedbackEditor.tsx');
window.diteng = { setFeedbackEditorActive() {}, onShortcut() { return () => {}; }, async copyFeedbackImage(bytes) { window.exportedBytes = bytes; return { ok: true }; } };
const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1000;
const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
const blob = await new Promise(resolve => canvas.toBlob(resolve));
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(FeedbackEditor, { png: new Uint8Array(await blob.arrayBuffer()), onClose(result) { window.editorResult = result.action; } }));
</script></body></html>` }));
  const errors = [];
  page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message); });
  await page.goto('http://127.0.0.1:5173/__feedback-test__');
  const canvas = page.getByTestId('feedback-editor-canvas');
  await page.getByTestId('feedback-fit').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="feedback-editor-canvas"]')?.width === 1600 && !document.querySelector('[data-testid="feedback-fit"]').disabled);
  const checks = [];
  const check = (name, isPass, detail = '') => { checks.push(isPass); console.log(`${isPass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const drag = async (x, y, dx, dy) => {
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 }); await page.mouse.up();
  };
  await page.getByTestId('feedback-tool-hand').click();
  const before = await canvas.boundingBox();
  const center = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  await drag(center.x, center.y, 60, 35);
  const after = await canvas.boundingBox();
  check('适合窗口时手形工具向右下拖动', Math.abs(after.x - before.x - 60) < 2 && Math.abs(after.y - before.y - 35) < 2);
  await drag(center.x + 60, center.y + 35, -120, -70);
  const reversed = await canvas.boundingBox();
  check('反向拖动画布', Math.abs(reversed.x - before.x + 60) < 2 && Math.abs(reversed.y - before.y + 35) < 2);
  check('平移不新增标注', await page.getByTestId('feedback-editor').getAttribute('data-shape-count') === '0');
  await page.getByTestId('feedback-fit').click();
  const fitted = await canvas.boundingBox();
  check('适合窗口恢复居中', Math.abs(fitted.x - before.x) < 2 && Math.abs(fitted.y - before.y) < 2);
  await page.getByTestId('feedback-tool-arrow').click();
  await drag(fitted.x + fitted.width * 0.2, fitted.y + fitted.height * 0.4, fitted.width * 0.6, 0);
  await canvas.focus();
  await page.keyboard.down('Space');
  check('空格拖动时隐藏编辑手柄', await page.getByTestId('feedback-handle-to').count() === 0);
  await drag(center.x, center.y, 40, -30);
  await page.keyboard.up('Space');
  const spacePan = await canvas.boundingBox();
  check('空格临时拖动不移动标注', Math.abs(spacePan.x - fitted.x - 40) < 2 && Math.abs(spacePan.y - fitted.y + 30) < 2 && await page.getByTestId('feedback-editor').getAttribute('data-shape-count') === '1');
  await page.getByTestId('feedback-tool-hand').click();
  const stage = await page.getByTestId('feedback-stage').boundingBox();
  await drag(stage.x + 10, stage.y + 10, 25, 20);
  const backgroundPan = await canvas.boundingBox();
  check('画布外空白区域也能拖动', Math.abs(backgroundPan.x - spacePan.x - 25) < 2 && Math.abs(backgroundPan.y - spacePan.y - 20) < 2);
  await page.getByTestId('feedback-fit').click();
  await page.getByTestId('feedback-zoom-in').click();
  await page.getByTestId('feedback-zoom-in').click();
  await page.getByTestId('feedback-zoom-in').click();
  const zoomed = await canvas.boundingBox();
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  check('拖动时显示抓握光标', await canvas.evaluate((element) => getComputedStyle(element).cursor) === 'grabbing');
  await page.mouse.move(center.x - 80, center.y - 45, { steps: 8 });
  await page.mouse.up();
  const zoomPan = await canvas.boundingBox();
  check('放大后拖动画布', zoomed.width > fitted.width && Math.abs(zoomPan.x - zoomed.x + 80) < 2 && Math.abs(zoomPan.y - zoomed.y + 45) < 2);
  await page.screenshot({ path: '/tmp/diteng-feedback-viewport.png' });
  await page.getByTestId('feedback-copy').click();
  await page.waitForFunction(() => window.editorResult === 'copy');
  const exported = await page.evaluate(async () => {
    const bitmap = await createImageBitmap(new Blob([window.exportedBytes], { type: 'image/png' }));
    const surface = document.createElement('canvas'); surface.width = bitmap.width; surface.height = bitmap.height;
    const context = surface.getContext('2d'); context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, pixel: [...context.getImageData(1040, 400, 1, 1).data], bytes: [...window.exportedBytes] };
  });
  check('平移缩放后仍按原图尺寸及坐标导出', exported.width === 1600 && exported.height === 1000 && Math.abs(exported.pixel[0] - 229) < 5 && Math.abs(exported.pixel[1] - 72) < 5);
  writeFileSync('/tmp/diteng-feedback-arrow.png', Buffer.from(exported.bytes));
  check('编辑器无运行异常', errors.length === 0, errors.join(' | '));
  assert.ok(checks.every(Boolean), '反馈编辑器回归失败');
} finally {
  await browser?.close();
  if (app && app.exitCode === null) {
    const closed = new Promise((resolve) => app.once('exit', resolve));
    app.kill('SIGTERM'); await closed;
  }
  rmSync(fixtureDir, { recursive: true, force: true });
}
