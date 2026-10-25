/** 截图标注的图片坐标、绘制与编辑历史；不依赖界面缩放。 */
export interface Point {
  x: number;
  y: number;
}

interface StrokeStyle {
  color: string;
  lineWidth: number;
}

interface ArrowShape extends StrokeStyle {
  type: 'arrow';
  from: Point;
  to: Point;
}

interface RectShape extends StrokeStyle {
  type: 'rect';
  from: Point;
  to: Point;
}

interface EllipseShape extends StrokeStyle {
  type: 'ellipse';
  from: Point;
  to: Point;
}

interface PenShape extends StrokeStyle {
  type: 'pen';
  points: Point[];
}

export interface TextShape {
  type: 'text';
  /** 文字基线起点（图片坐标） */
  x: number;
  y: number;
  color: string;
  fontSize: number;
  text: string;
}

interface MosaicShape {
  type: 'mosaic';
  from: Point;
  to: Point;
  /** 马赛克块大小（图片像素） */
  block: number;
}

/** 全部标注（按绘制顺序重放；坐标与线宽均为图片像素） */
export type Shape = ArrowShape | RectShape | EllipseShape | PenShape | TextShape | MosaicShape;

/** 手势过程中的草稿（文字除外，文字走独立输入框） */
export type GestureShape = ArrowShape | RectShape | EllipseShape | PenShape | MosaicShape;


const CANVAS_FONT_STACK = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 由两个对角点得到规范化矩形（图片坐标） */
export function normalizedRect(from: Point, to: Point): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    w: Math.abs(to.x - from.x),
    h: Math.abs(to.y - from.y),
  };
}

/** 创建箭头/矩形/椭圆拖拽草稿（显式分支让 Shape 判别联合类型收窄） */
export function createBoxShape(
  tool: 'arrow' | 'rect' | 'ellipse',
  from: Point,
  style: StrokeStyle,
): ArrowShape | RectShape | EllipseShape {
  const to = { x: from.x, y: from.y };
  if (tool === 'arrow') return { type: 'arrow', from, to, ...style };
  if (tool === 'rect') return { type: 'rect', from, to, ...style };
  return { type: 'ellipse', from, to, ...style };
}

/** 过小的拖拽（误点）不入栈；画笔单点保留为圆点 */
export function isGestureTooSmall(shape: GestureShape): boolean {
  if (shape.type === 'pen') return false;
  const deltaX = Math.abs(shape.to.x - shape.from.x);
  const deltaY = Math.abs(shape.to.y - shape.from.y);
  if (shape.type === 'mosaic') return deltaX < 8 || deltaY < 8;
  return deltaX < 4 && deltaY < 4;
}

/** 箭头：线 + 实心三角箭头 */
function drawArrowShape(ctx: CanvasRenderingContext2D, shape: ArrowShape): void {
  const deltaX = shape.to.x - shape.from.x;
  const deltaY = shape.to.y - shape.from.y;
  if (deltaX === 0 && deltaY === 0) return;
  const angle = Math.atan2(deltaY, deltaX);
  const headLength = Math.max(shape.lineWidth * 3.4, 12);
  const headAngle = Math.PI / 7;
  const shaftEndX = shape.to.x - Math.cos(angle) * headLength * 0.9;
  const shaftEndY = shape.to.y - Math.sin(angle) * headLength * 0.9;
  ctx.strokeStyle = shape.color;
  ctx.lineWidth = shape.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(shape.from.x, shape.from.y);
  ctx.lineTo(shaftEndX, shaftEndY);
  ctx.stroke();
  ctx.fillStyle = shape.color;
  ctx.beginPath();
  ctx.moveTo(shape.to.x, shape.to.y);
  ctx.lineTo(
    shape.to.x - Math.cos(angle - headAngle) * headLength,
    shape.to.y - Math.sin(angle - headAngle) * headLength,
  );
  ctx.lineTo(
    shape.to.x - Math.cos(angle + headAngle) * headLength,
    shape.to.y - Math.sin(angle + headAngle) * headLength,
  );
  ctx.closePath();
  ctx.fill();
}

/** 矩形马赛克：把矩形区域缩小再放大（关闭平滑）得到像素块；重放时同样逐次应用 */
function drawMosaicShape(ctx: CanvasRenderingContext2D, shape: MosaicShape): void {
  const canvas = ctx.canvas;
  const rect = normalizedRect(shape.from, shape.to);
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(canvas.width, Math.ceil(rect.x + rect.w));
  const bottom = Math.min(canvas.height, Math.ceil(rect.y + rect.h));
  const width = right - left;
  const height = bottom - top;
  if (width < 2 || height < 2) return;
  const block = Math.max(2, shape.block);
  const smallWidth = Math.max(1, Math.ceil(width / block));
  const smallHeight = Math.max(1, Math.ceil(height / block));
  const small = document.createElement('canvas');
  small.width = smallWidth;
  small.height = smallHeight;
  const smallContext = small.getContext('2d');
  if (!smallContext) return;
  smallContext.imageSmoothingEnabled = true;
  smallContext.drawImage(canvas, left, top, width, height, 0, 0, smallWidth, smallHeight);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, smallWidth, smallHeight, left, top, width, height);
  ctx.restore();
}

/** 单条标注绘制（底图之外的所有操作都经此重放） */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.save();
  switch (shape.type) {
    case 'arrow': {
      drawArrowShape(ctx, shape);
      break;
    }
    case 'rect': {
      const rect = normalizedRect(shape.from, shape.to);
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.lineWidth;
      ctx.lineJoin = 'round';
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      break;
    }
    case 'ellipse': {
      const rect = normalizedRect(shape.from, shape.to);
      if (rect.w <= 0 || rect.h <= 0) break;
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.lineWidth;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.ellipse(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w / 2, rect.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'pen': {
      if (shape.points.length === 0) break;
      ctx.strokeStyle = shape.color;
      ctx.fillStyle = shape.color;
      ctx.lineWidth = shape.lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (shape.points.length === 1) {
        const dot = shape.points[0];
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, Math.max(shape.lineWidth / 2, 0.5), 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      ctx.beginPath();
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      for (let index = 1; index < shape.points.length; index += 1) {
        ctx.lineTo(shape.points[index].x, shape.points[index].y);
      }
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.fillStyle = shape.color;
      ctx.font = `600 ${shape.fontSize}px ${CANVAS_FONT_STACK}`;
      ctx.textBaseline = 'alphabetic';
      shape.text.split('\n').forEach((line, index) => {
        ctx.fillText(line, shape.x, shape.y + index * shape.fontSize * 1.35);
      });
      break;
    }
    case 'mosaic': {
      drawMosaicShape(ctx, shape);
      break;
    }
  }
  ctx.restore();
}

/** 马赛克拖拽预览：半透明底 + 虚线框（松手才真正像素化） */
export function drawMosaicPreview(
  ctx: CanvasRenderingContext2D,
  shape: MosaicShape,
  previewLineWidth: number,
): void {
  const rect = normalizedRect(shape.from, shape.to);
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = Math.max(1, previewLineWidth);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

export interface Bounds { x: number; y: number; w: number; h: number }
export type Handle = 'move' | 'from' | 'to' | 'nw' | 'ne' | 'sw' | 'se';

export function shapeBounds(shape: Shape, measure: (text: string, fontSize: number) => number): Bounds {
  if (shape.type === 'text') {
    return {
      x: shape.x, y: shape.y - shape.fontSize,
      w: Math.max(shape.fontSize, ...shape.text.split('\n').map((line) => measure(line, shape.fontSize))),
      h: shape.fontSize * 1.35 * shape.text.split('\n').length,
    };
  }
  if (shape.type === 'pen') {
    const xs = shape.points.map((point) => point.x);
    const ys = shape.points.map((point) => point.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return normalizedRect(shape.from, shape.to);
}

function segmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const fraction = dx === 0 && dy === 0 ? 0 : clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(point.x - from.x - fraction * dx, point.y - from.y - fraction * dy);
}

/** 按绘制层级从上往下命中；箭头和画笔按线段命中，避免巨大的空白包围框抢走点选。 */
export function findShapeAtPoint(shapes: Shape[], point: Point, tolerance: number, measure: (text: string, fontSize: number) => number): number {
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    const shape = shapes[index];
    if (shape.type === 'arrow') {
      if (segmentDistance(point, shape.from, shape.to) <= tolerance + shape.lineWidth / 2) return index;
      continue;
    }
    if (shape.type === 'pen') {
      if (shape.points.some((to, i) => segmentDistance(point, shape.points[Math.max(0, i - 1)], to) <= tolerance + shape.lineWidth / 2)) return index;
      continue;
    }
    const bounds = shapeBounds(shape, measure);
    if (point.x >= bounds.x - tolerance && point.y >= bounds.y - tolerance && point.x <= bounds.x + bounds.w + tolerance && point.y <= bounds.y + bounds.h + tolerance) return index;
  }
  return -1;
}

export function transformShape(shape: Shape, handle: Handle, start: Point, point: Point): Shape {
  const dx = point.x - start.x;
  const dy = point.y - start.y;
  const move = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  if (handle === 'move') {
    if (shape.type === 'text') return { ...shape, x: shape.x + dx, y: shape.y + dy };
    if (shape.type === 'pen') return { ...shape, points: shape.points.map(move) };
    return { ...shape, from: move(shape.from), to: move(shape.to) };
  }
  if (shape.type === 'text' || shape.type === 'pen') return shape;
  if (handle === 'from' || handle === 'to') return { ...shape, [handle]: point };
  const bounds = normalizedRect(shape.from, shape.to);
  const opposite = {
    x: handle.endsWith('w') ? bounds.x + bounds.w : bounds.x,
    y: handle.startsWith('n') ? bounds.y + bounds.h : bounds.y,
  };
  return { ...shape, from: opposite, to: point };
}

/** 每次提交保存不可变的整组标注，新增、编辑、移动与删除共享同一撤销语义。 */
export class AnnotationHistory {
  shapes: Shape[] = [];
  private past: Shape[][] = [];
  private future: Shape[][] = [];

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  commit(shapes: Shape[]): void {
    if (JSON.stringify(shapes) === JSON.stringify(this.shapes)) return;
    this.past = [...this.past.slice(-99), this.shapes];
    this.shapes = shapes;
    this.future = [];
  }

  undo(): void {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.shapes);
    this.shapes = previous;
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.shapes);
    this.shapes = next;
  }
}
