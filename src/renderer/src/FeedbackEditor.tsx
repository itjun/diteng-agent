import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { FeedbackChatApp, ShortcutAction } from '../../shared/types';
import {
  AlertIcon,
  ArrowToolIcon,
  CopyIcon,
  EllipseToolIcon,
  MosaicToolIcon,
  PenToolIcon,
  RectToolIcon,
  RedoIcon,
  TextToolIcon,
  UndoIcon,
} from './theme-icons';
import styles from './FeedbackEditor.module.css';

/** 对外关闭结果：取消不做任何事；复制成功时 target 为目标聊天应用（null=仅复制） */
export type FeedbackEditorResult =
  | { action: 'cancel' }
  | { action: 'copy'; target: FeedbackChatApp | null };

export interface FeedbackEditorProps {
  /** 主进程截取的整窗 PNG 原始字节（编辑器内解码为底图） */
  png: Uint8Array;
  onClose: (result: FeedbackEditorResult) => void;
}

/** 标注工具 */
type Tool = 'arrow' | 'rect' | 'ellipse' | 'pen' | 'text' | 'mosaic';
/** 色板档位 */
type ColorKey = 'red' | 'yellow' | 'blue' | 'green';
/** 线宽档位 */
type WidthKey = 'thin' | 'medium' | 'thick';

interface Point {
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

interface TextShape {
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
type Shape = ArrowShape | RectShape | EllipseShape | PenShape | TextShape | MosaicShape;

/** 手势过程中的草稿（文字除外，文字走独立输入框） */
type GestureShape = ArrowShape | RectShape | EllipseShape | PenShape | MosaicShape;

interface GestureDraft {
  shape: GestureShape;
  /** 马赛克拖拽期只画虚线预览框，松手才像素化 */
  isMosaicPreview: boolean;
  /** 预览框线宽（图片像素） */
  previewLineWidth: number;
}

interface TextDraft {
  /** 图片坐标（文字基线起点） */
  x: number;
  y: number;
  /** 视口坐标（输入框定位用） */
  left: number;
  top: number;
  color: string;
  fontSize: number;
  value: string;
}

interface HistoryState {
  undoCount: number;
  redoCount: number;
}

const COLORS: { key: ColorKey; label: string; value: string }[] = [
  { key: 'red', label: '红色', value: '#e5484d' },
  { key: 'yellow', label: '黄色', value: '#f5b301' },
  { key: 'blue', label: '蓝色', value: '#3b6fd4' },
  { key: 'green', label: '绿色', value: '#2fa66a' },
];

const COLOR_VALUES: Record<ColorKey, string> = {
  red: '#e5484d',
  yellow: '#f5b301',
  blue: '#3b6fd4',
  green: '#2fa66a',
};

/** 线宽按「显示像素」定义（2/4/7），落到画布时再按截图缩放倍率换算成图片像素 */
const WIDTHS: { key: WidthKey; label: string }[] = [
  { key: 'thin', label: '细线（2px）' },
  { key: 'medium', label: '中等线宽（4px）' },
  { key: 'thick', label: '粗线（7px）' },
];

const WIDTH_PX: Record<WidthKey, number> = { thin: 2, medium: 4, thick: 7 };

/** 线宽按钮里的圆点大小样式（3 档） */
const WIDTH_DOT_CLASSES: Record<WidthKey, string> = {
  thin: styles.widthDotThin,
  medium: styles.widthDotMedium,
  thick: styles.widthDotThick,
};

const TOOL_OPTIONS: { key: Tool; label: string; testId: string; icon: ReactNode }[] = [
  { key: 'arrow', label: '箭头', testId: 'feedback-tool-arrow', icon: <ArrowToolIcon /> },
  { key: 'rect', label: '矩形', testId: 'feedback-tool-rect', icon: <RectToolIcon /> },
  { key: 'ellipse', label: '椭圆', testId: 'feedback-tool-ellipse', icon: <EllipseToolIcon /> },
  { key: 'pen', label: '画笔', testId: 'feedback-tool-pen', icon: <PenToolIcon /> },
  { key: 'text', label: '文字', testId: 'feedback-tool-text', icon: <TextToolIcon /> },
  { key: 'mosaic', label: '马赛克', testId: 'feedback-tool-mosaic', icon: <MosaicToolIcon /> },
];

/** 文字字号（显示像素，落到画布时按倍率换算） */
const TEXT_DISPLAY_FONT_SIZE = 20;
/** 马赛克块大小（显示像素） */
const MOSAIC_DISPLAY_BLOCK = 10;

/** 画布内文字字体：与输入框观感保持一致，优先系统中文字体 */
const CANVAS_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 由两个对角点得到规范化矩形（图片坐标） */
function normalizedRect(from: Point, to: Point): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    w: Math.abs(to.x - from.x),
    h: Math.abs(to.y - from.y),
  };
}

/** 创建箭头/矩形/椭圆拖拽草稿（显式分支让 Shape 判别联合类型收窄） */
function createBoxShape(
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
function isGestureTooSmall(shape: GestureShape): boolean {
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
function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
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
      ctx.fillText(shape.text, shape.x, shape.y);
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
function drawMosaicPreview(
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

/** 把标注后的画布导出为 PNG 字节（toBlob 回调包成 Promise） */
function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('导出标注图失败，请重试'));
        return;
      }
      blob.arrayBuffer().then(
        (buffer) => resolve(new Uint8Array(buffer)),
        () => reject(new Error('导出标注图失败，请重试')),
      );
    }, 'image/png');
  });
}

/**
 * 反馈截图标注编辑器：壳内全屏模态浮层（不新建窗口）。
 * 底图按 PNG 原始像素绘制到 canvas，CSS 只做等比缩放；所有标注存图片坐标，
 * 撤销/重做统一按「底图 + shapes 重放」实现。复制成功由 onClose 通知壳，
 * 失败则保留编辑器与全部标注，并就地提示。
 */
export function FeedbackEditor({ png, onClose }: FeedbackEditorProps): JSX.Element {
  const [activeTool, setActiveTool] = useState<Tool>('arrow');
  const [activeColor, setActiveColor] = useState<ColorKey>('red');
  const [activeWidth, setActiveWidth] = useState<WidthKey>('medium');
  const [isReady, setIsReady] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [history, setHistory] = useState<HistoryState>({ undoCount: 0, redoCount: 0 });

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  /** 解码任务：复制时等待其完成，避免编辑器刚出现就点复制拿不到画布 */
  const decodeRef = useRef<Promise<void> | null>(null);
  const shapesRef = useRef<Shape[]>([]);
  const redoRef = useRef<Shape[]>([]);
  const draftRef = useRef<GestureDraft | null>(null);
  const gestureRef = useRef<GestureDraft | null>(null);
  const textDraftRef = useRef<TextDraft | null>(null);
  /** 画布上继续点选开新文字框时，抑制旧输入框 blur 的重复提交 */
  const isTextBlurSuppressedRef = useRef(false);
  const renderFrameRef = useRef(0);
  const isReadyRef = useRef(false);
  const isBusyRef = useRef(false);
  const isClosedRef = useRef(false);

  // 文字草稿同时镜像到 ref：document/主进程快捷键回调里要读到最新值
  textDraftRef.current = textDraft;

  /** 重放：清空后先画底图，再按顺序画全部标注与拖拽草稿 */
  const renderNow = useCallback(() => {
    const canvas = canvasRef.current;
    const bitmap = bitmapRef.current;
    if (!canvas || !bitmap) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    for (const shape of shapesRef.current) drawShape(context, shape);
    const draft = draftRef.current;
    if (!draft) return;
    if (draft.isMosaicPreview && draft.shape.type === 'mosaic') {
      drawMosaicPreview(context, draft.shape, draft.previewLineWidth);
      return;
    }
    drawShape(context, draft.shape);
  }, []);

  /** 指针移动很密：合并到一帧内只重放一次 */
  const scheduleRender = useCallback(() => {
    if (renderFrameRef.current !== 0) return;
    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = 0;
      renderNow();
    });
  }, [renderNow]);

  const syncHistory = useCallback(() => {
    setHistory({ undoCount: shapesRef.current.length, redoCount: redoRef.current.length });
  }, []);

  /** 画布 CSS 尺寸按窗口等比缩放适配（不放大到超过原始像素，避免小图糊掉） */
  const layoutCanvas = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const bitmap = bitmapRef.current;
    if (!stage || !canvas || !bitmap) return;
    const availableWidth = stage.clientWidth;
    const availableHeight = stage.clientHeight;
    if (availableWidth <= 0 || availableHeight <= 0) return;
    const scale = Math.min(availableWidth / bitmap.width, availableHeight / bitmap.height, 1);
    canvas.style.width = `${bitmap.width * scale}px`;
    canvas.style.height = `${bitmap.height * scale}px`;
  }, []);

  const pushShape = useCallback(
    (shape: Shape) => {
      shapesRef.current.push(shape);
      // 新操作让重做栈失效（标注编辑器通用语义）
      redoRef.current = [];
      syncHistory();
      renderNow();
    },
    [renderNow, syncHistory],
  );

  const undo = useCallback(() => {
    const shape = shapesRef.current.pop();
    if (!shape) return;
    redoRef.current.push(shape);
    syncHistory();
    renderNow();
  }, [renderNow, syncHistory]);

  const redo = useCallback(() => {
    const shape = redoRef.current.pop();
    if (!shape) return;
    shapesRef.current.push(shape);
    syncHistory();
    renderNow();
  }, [renderNow, syncHistory]);

  const cancelTextDraft = useCallback(() => {
    if (!textDraftRef.current) return;
    textDraftRef.current = null;
    setTextDraft(null);
  }, []);

  /** 提交文字：空串视为取消；提交后作为一条 shape 参与撤销/重做 */
  const commitTextDraft = useCallback(() => {
    const draft = textDraftRef.current;
    if (!draft) return;
    textDraftRef.current = null;
    setTextDraft(null);
    const value = draft.value.trim();
    if (!value) return;
    pushShape({
      type: 'text',
      x: draft.x,
      y: draft.y,
      color: draft.color,
      fontSize: draft.fontSize,
      text: value,
    });
  }, [pushShape]);

  const closeEditor = useCallback(() => {
    if (isClosedRef.current) return;
    isClosedRef.current = true;
    onClose({ action: 'cancel' });
  }, [onClose]);

  /** 复制标注图；成功即交回壳（由壳负责打开聊天应用与 toast），失败保留现场 */
  const copyImage = useCallback(
    async (target: FeedbackChatApp | null) => {
      if (isClosedRef.current || isBusyRef.current) return;
      isBusyRef.current = true;
      setIsBusy(true);
      setErrorText('');
      try {
        const decodeTask = decodeRef.current;
        if (decodeTask) await decodeTask;
        const canvas = canvasRef.current;
        if (!isReadyRef.current || !canvas) throw new Error('截图尚未就绪，请稍后重试');
        // 保证刚提交的标注已落到画布，再导出
        renderNow();
        const bytes = await canvasToPngBytes(canvas);
        const result = await window.diteng.copyFeedbackImage(bytes);
        if (!result.ok) throw new Error(result.message || '复制失败，请重试');
        // 复制期间用户可能已取消（组件卸载）：结果不再回传，避免壳重复收尾
        if (isClosedRef.current) return;
        isClosedRef.current = true;
        onClose({ action: 'copy', target });
      } catch (error) {
        if (isClosedRef.current) return;
        setErrorText(error instanceof Error && error.message ? error.message : '复制失败，请重试');
        // 失败不关编辑器：标注与画布全部保留，允许重试
        isBusyRef.current = false;
        setIsBusy(false);
      }
    },
    [onClose, renderNow],
  );

  // 解码 PNG 底图：canvas 尺寸取原始像素，CSS 尺寸由 layoutCanvas 适配窗口
  useEffect(() => {
    let isCancelled = false;
    const bytes = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
    const blob = new Blob([bytes], { type: 'image/png' });
    const decodeTask = (async () => {
      try {
        const bitmap = await createImageBitmap(blob);
        if (isCancelled) {
          bitmap.close();
          return;
        }
        bitmapRef.current = bitmap;
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        layoutCanvas();
        isReadyRef.current = true;
        setIsReady(true);
        renderNow();
      } catch {
        if (!isCancelled) setErrorText('截图解码失败，无法标注');
      }
    })();
    decodeRef.current = decodeTask;
    return () => {
      isCancelled = true;
      bitmapRef.current?.close();
      bitmapRef.current = null;
      isReadyRef.current = false;
      if (renderFrameRef.current !== 0) {
        window.cancelAnimationFrame(renderFrameRef.current);
        renderFrameRef.current = 0;
      }
    };
  }, [png, layoutCanvas, renderNow]);

  // 窗口尺寸变化时重新适配画布显示尺寸（canvas 像素尺寸不变，无需重放）
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => layoutCanvas());
    observer.observe(stage);
    layoutCanvas();
    return () => observer.disconnect();
  }, [layoutCanvas]);

  /** 指针位置换算为图片坐标（canvas.width / CSS 宽度） */
  const imagePointOf = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: clamp((event.clientX - rect.left) * scaleX, 0, canvas.width),
      y: clamp((event.clientY - rect.top) * scaleY, 0, canvas.height),
    };
  };

  /** 点击画布出文字输入框：输入框按视口坐标贴住点击点，提交时用图片坐标绘制 */
  const openTextDraft = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    point: Point,
    ratio: number,
  ): void => {
    const draft: TextDraft = {
      x: point.x,
      y: point.y,
      left: Math.min(event.clientX, window.innerWidth - 170),
      top: event.clientY,
      color: COLOR_VALUES[activeColor],
      fontSize: Math.max(10, Math.round(TEXT_DISPLAY_FONT_SIZE * ratio)),
      value: '',
    };
    textDraftRef.current = draft;
    setTextDraft(draft);
    // 旧输入框随焦点转移可能触发 blur：此处直接开新草稿，不应把空内容当提交
    isTextBlurSuppressedRef.current = true;
    window.setTimeout(() => {
      isTextBlurSuppressedRef.current = false;
    }, 0);
    // 同一输入框未卸载时 autoFocus 不再生效，补一次聚焦保证可以继续输入
    window.requestAnimationFrame(() => textInputRef.current?.focus());
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (isBusyRef.current || !isReadyRef.current || event.button !== 0) return;
    // 画布绘制不参与文本选择/焦点切换，避免拖拽时选中工具栏文字
    event.preventDefault();
    // 已有输入中的文字先提交，避免开始新操作时丢失内容
    commitTextDraft();
    const canvas = event.currentTarget;
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const point = imagePointOf(event);
    if (activeTool === 'text') return openTextDraft(event, point, ratio);
    const style: StrokeStyle = {
      color: COLOR_VALUES[activeColor],
      lineWidth: Math.max(1, Math.round(WIDTH_PX[activeWidth] * ratio)),
    };
    let draft: GestureDraft;
    if (activeTool === 'pen') {
      draft = {
        shape: { type: 'pen', points: [point], ...style },
        isMosaicPreview: false,
        previewLineWidth: 0,
      };
    } else if (activeTool === 'mosaic') {
      draft = {
        shape: {
          type: 'mosaic',
          from: point,
          to: point,
          block: Math.max(4, Math.round(MOSAIC_DISPLAY_BLOCK * ratio)),
        },
        isMosaicPreview: true,
        previewLineWidth: Math.max(1, Math.round(2 * ratio)),
      };
    } else {
      draft = {
        shape: createBoxShape(activeTool, point, style),
        isMosaicPreview: false,
        previewLineWidth: 0,
      };
    }
    gestureRef.current = draft;
    draftRef.current = draft;
    canvas.setPointerCapture(event.pointerId);
    scheduleRender();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const point = imagePointOf(event);
    if (gesture.shape.type === 'pen') {
      gesture.shape.points.push(point);
    } else {
      gesture.shape.to = point;
    }
    scheduleRender();
  };

  /** 收尾手势：过小的拖拽丢弃；马赛克在此刻才真正像素化（作为 shape 入栈） */
  const finishGesture = (isCancelled: boolean): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    draftRef.current = null;
    if (!isCancelled && !isGestureTooSmall(gesture.shape)) pushShape(gesture.shape);
    else renderNow();
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const canvas = event.currentTarget;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    finishGesture(false);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const canvas = event.currentTarget;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    finishGesture(true);
  };

  const handleTextDraftChange = (value: string): void => {
    const draft = textDraftRef.current;
    if (!draft) return;
    const next = { ...draft, value };
    textDraftRef.current = next;
    setTextDraft(next);
  };

  const handleTextInputBlur = (): void => {
    if (isTextBlurSuppressedRef.current) return;
    commitTextDraft();
  };

  /** 编辑器激活期间：主进程把 Esc/⌘Z/⇧⌘Z/⌘W 转成 editor-* 动作，这里统一处理 */
  const handleShortcut = useCallback(
    (action: ShortcutAction) => {
      if (action === 'editor-cancel') {
        // 文字输入中优先取消输入，不掉整个编辑器
        if (textDraftRef.current) cancelTextDraft();
        else closeEditor();
        return;
      }
      if (action === 'editor-undo') undo();
      else if (action === 'editor-redo') redo();
    },
    [cancelTextDraft, closeEditor, redo, undo],
  );

  // 挂载：通知主进程放行编辑器快捷键并聚焦根节点；卸载时复位并取消订阅
  useEffect(() => {
    window.diteng.setFeedbackEditorActive(true);
    rootRef.current?.focus();
    const unsubscribe = window.diteng.onShortcut(handleShortcut);
    return () => {
      unsubscribe();
      window.diteng.setFeedbackEditorActive(false);
    };
  }, [handleShortcut]);

  // 兜底键盘：Enter=仅复制、Esc=取消；文字输入框激活时交给输入框自己处理
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isClosedRef.current || textDraftRef.current || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeEditor();
        return;
      }
      if (event.key === 'Enter' && !event.repeat) {
        // 焦点在按钮上时也按「仅复制」处理，避免 Enter 只触发按钮
        event.preventDefault();
        void copyImage(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeEditor, copyImage]);

  const canUndo = history.undoCount > 0;
  const canRedo = history.redoCount > 0;
  const isInteractionDisabled = !isReady || isBusy;
  const textDraftWidth = textDraft
    ? Math.min(560, Math.max(140, textDraft.value.length * 24 + 32))
    : 0;

  return (
    <div
      ref={rootRef}
      className={styles.overlay}
      data-testid="feedback-editor"
      role="dialog"
      aria-modal="true"
      aria-label="反馈截图标注"
      tabIndex={-1}
    >
      <div className={styles.stage} ref={stageRef}>
        <div className={styles.canvasWrap}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            data-testid="feedback-editor-canvas"
            style={{ visibility: isReady ? 'visible' : 'hidden' }}
            tabIndex={0}
            aria-label="截图标注画布"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onContextMenu={(event) => event.preventDefault()}
          />
        </div>
        {!isReady && !errorText && <div className={styles.loading}>正在载入截图…</div>}
      </div>

      {textDraft && (
        <input
          ref={textInputRef}
          className={styles.textInput}
          data-testid="feedback-text-input"
          style={{
            left: textDraft.left,
            top: textDraft.top,
            width: textDraftWidth,
            color: textDraft.color,
          }}
          value={textDraft.value}
          autoFocus
          spellCheck={false}
          aria-label="输入标注文字"
          placeholder="输入文字，Enter 确认"
          onChange={(event) => handleTextDraftChange(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            // 输入法候选确认键（中文输入中的 Enter/Esc）交给输入法，不提交/取消
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              commitTextDraft();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelTextDraft();
            }
          }}
          onBlur={handleTextInputBlur}
        />
      )}

      <div className={styles.bottom}>
        {errorText && (
          <div className={styles.error} data-testid="feedback-error" role="alert">
            <AlertIcon />
            <span>{errorText}</span>
          </div>
        )}
        <div className={styles.toolbar} role="toolbar" aria-label="标注工具栏">
          <button
            type="button"
            className={styles.action}
            data-testid="feedback-cancel"
            title="取消标注（Esc）"
            onClick={closeEditor}
          >
            取消
          </button>
          <span className={styles.divider} aria-hidden="true" />
          {TOOL_OPTIONS.map((tool) => (
            <button
              key={tool.key}
              type="button"
              className={styles.iconButton}
              data-testid={tool.testId}
              title={tool.label}
              aria-label={tool.label}
              aria-pressed={activeTool === tool.key}
              disabled={isInteractionDisabled}
              onClick={() => setActiveTool(tool.key)}
            >
              {tool.icon}
            </button>
          ))}
          <span className={styles.divider} aria-hidden="true" />
          <div className={styles.swatchGroup} role="group" aria-label="标注颜色">
            {COLORS.map((color) => (
              <button
                key={color.key}
                type="button"
                className={styles.swatchButton}
                data-testid={`feedback-color-${color.key}`}
                title={color.label}
                aria-label={color.label}
                aria-pressed={activeColor === color.key}
                disabled={isInteractionDisabled}
                onClick={() => setActiveColor(color.key)}
              >
                <span className={styles.swatch} style={{ backgroundColor: color.value }} />
              </button>
            ))}
          </div>
          <div className={styles.widthGroup} role="group" aria-label="线宽">
            {WIDTHS.map((width) => (
              <button
                key={width.key}
                type="button"
                className={styles.widthButton}
                data-testid={`feedback-width-${width.key}`}
                title={width.label}
                aria-label={width.label}
                aria-pressed={activeWidth === width.key}
                disabled={isInteractionDisabled}
                onClick={() => setActiveWidth(width.key)}
              >
                <span className={`${styles.widthDot} ${WIDTH_DOT_CLASSES[width.key]}`} />
              </button>
            ))}
          </div>
          <span className={styles.divider} aria-hidden="true" />
          <button
            type="button"
            className={styles.iconButton}
            data-testid="feedback-undo"
            title="撤销（⌘Z）"
            aria-label="撤销"
            disabled={!canUndo || isBusy}
            onClick={undo}
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            data-testid="feedback-redo"
            title="重做（⇧⌘Z）"
            aria-label="重做"
            disabled={!canRedo || isBusy}
            onClick={redo}
          >
            <RedoIcon />
          </button>
          <span className={styles.divider} aria-hidden="true" />
          <button
            type="button"
            className={`${styles.action} ${styles.actionPrimary}`}
            data-testid="feedback-copy"
            title="仅复制标注图（Enter）"
            aria-label="仅复制标注图"
            aria-busy={isBusy}
            disabled={!isReady || isBusy}
            onClick={() => void copyImage(null)}
          >
            <CopyIcon />
            <span>仅复制</span>
          </button>
          <button
            type="button"
            className={styles.action}
            data-testid="feedback-open-wechat"
            title="复制并打开微信"
            aria-label="复制并打开微信"
            disabled={!isReady || isBusy}
            onClick={() => void copyImage('wechat')}
          >
            微信
          </button>
          <button
            type="button"
            className={styles.action}
            data-testid="feedback-open-wecom"
            title="复制并打开企业微信"
            aria-label="复制并打开企业微信"
            disabled={!isReady || isBusy}
            onClick={() => void copyImage('wecom')}
          >
            企业微信
          </button>
        </div>
      </div>
    </div>
  );
}
