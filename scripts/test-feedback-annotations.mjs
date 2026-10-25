import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/renderer/src/feedback-annotations.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const module = { exports: {} };
new Function('module', 'exports', output)(module, module.exports);
const { AnnotationHistory, findShapeAtPoint, shapeBounds, transformShape } = module.exports;
const measure = (text, size) => text.length * size;
const arrow = { type: 'arrow', from: { x: 20, y: 20 }, to: { x: 120, y: 120 }, color: '#e5484d', lineWidth: 4 };
const text = { type: 'text', x: 30, y: 70, text: '第一行\n第二行', color: '#e5484d', fontSize: 20 };

test('箭头两端可以独立调整，原标注保持不变', () => {
  const moved = transformShape(arrow, 'to', arrow.to, { x: 200, y: 180 });
  assert.deepEqual(moved.to, { x: 200, y: 180 });
  assert.deepEqual(moved.from, arrow.from);
  assert.deepEqual(arrow.to, { x: 120, y: 120 });
});
test('多行文字与自由画笔整体移动，坐标不依赖显示缩放', () => {
  const moved = transformShape(text, 'move', { x: 0, y: 0 }, { x: 100, y: -20 });
  assert.equal(moved.x, 130); assert.equal(moved.y, 50); assert.equal(moved.text, text.text);
  const pen = { type: 'pen', points: [{ x: 0, y: 1 }, { x: 4, y: 8 }], lineWidth: 2, color: 'red' };
  assert.deepEqual(transformShape(pen, 'move', { x: 1, y: 1 }, { x: 3, y: 5 }).points, [{ x: 2, y: 5 }, { x: 6, y: 12 }]);
  assert.deepEqual(pen.points[0], { x: 0, y: 1 });
});
test('反方向绘制的矩形可从角点缩放，固定对角不变', () => {
  const rect = { type: 'rect', from: { x: 120, y: 100 }, to: { x: 20, y: 30 }, lineWidth: 4, color: 'red' };
  const resized = transformShape(rect, 'nw', { x: 20, y: 30 }, { x: 10, y: 15 });
  assert.deepEqual(resized.from, { x: 120, y: 100 });
  assert.deepEqual(shapeBounds(resized, measure), { x: 10, y: 15, w: 110, h: 85 });
});
test('新增、修改、删除可以逐步撤销与重做', () => {
  const history = new AnnotationHistory();
  history.commit([arrow]);
  history.commit([arrow, text]);
  const edited = { ...text, text: '修改后的文字\n保留第二行' };
  history.commit([arrow, edited]);
  history.commit([edited]);
  history.undo(); assert.deepEqual(history.shapes, [arrow, edited]);
  history.undo(); assert.deepEqual(history.shapes, [arrow, text]);
  history.redo(); assert.deepEqual(history.shapes, [arrow, edited]);
  history.redo(); assert.deepEqual(history.shapes, [edited]);
});
test('单击选择而没有移动不会产生历史，撤销后新增会清空重做', () => {
  const history = new AnnotationHistory();
  history.commit([arrow]); history.commit([{ ...arrow }]);
  history.undo(); assert.deepEqual(history.shapes, []); assert.equal(history.canUndo, false);
  history.commit([text]); assert.equal(history.canRedo, false);
});
test('箭头空白包围区不抢走点选，交叠标注优先命中上层', () => {
  assert.equal(findShapeAtPoint([arrow], { x: 20, y: 120 }, 5, measure), -1);
  assert.equal(findShapeAtPoint([arrow], { x: 70, y: 72 }, 5, measure), 0);
  assert.equal(findShapeAtPoint([arrow, { ...text, x: 60, y: 75 }], { x: 70, y: 70 }, 5, measure), 1);
});
test('渐宽箭头的箭翼可点选，选框包含整个实心轮廓', () => {
  const horizontal = { ...arrow, from: { x: 20, y: 60 }, to: { x: 220, y: 60 } };
  assert.equal(findShapeAtPoint([horizontal], { x: 208, y: 68 }, 0, measure), 0);
  assert.equal(findShapeAtPoint([horizontal], { x: 25, y: 64 }, 0, measure), -1);
  const bounds = shapeBounds(horizontal, measure);
  assert.ok(bounds.y < 51 && bounds.y + bounds.h > 69);
  assert.equal(bounds.x, 20); assert.equal(bounds.w, 200);
  const short = { ...horizontal, to: { x: 26, y: 60 } };
  assert.equal(shapeBounds(short, measure).x, 20);
  assert.equal(shapeBounds(short, measure).w, 6);
});
test('文字选框包含第二行，空行不丢失高度', () => {
  assert.deepEqual(shapeBounds(text, measure), { x: 30, y: 50, w: 60, h: 54 });
  assert.equal(findShapeAtPoint([text], { x: 50, y: 95 }, 0, measure), 0);
  assert.equal(shapeBounds({ ...text, text: '一\n\n二' }, measure).h, 81);
});
