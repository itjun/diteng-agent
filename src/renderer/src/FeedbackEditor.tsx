import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { CursorArrowIcon, HandIcon, TrashIcon, ZoomInIcon, ZoomOutIcon } from '@radix-ui/react-icons';
import type { FeedbackChatApp, ShortcutAction } from '../../shared/types';
import {
  AlertIcon, ArrowToolIcon, CopyIcon, EllipseToolIcon, MosaicToolIcon,
  PenToolIcon, RectToolIcon, RedoIcon, TextToolIcon, UndoIcon,
} from './theme-icons';
import {
  AnnotationHistory, clamp, createBoxShape, drawMosaicPreview, drawShape,
  findShapeAtPoint, isGestureTooSmall, shapeBounds, transformShape,
} from './feedback-annotations';
import type { GestureShape, Handle, Point, Shape, TextShape } from './feedback-annotations';
import styles from './FeedbackEditor.module.css';

export type FeedbackEditorResult =
  | { action: 'cancel' }
  | { action: 'copy'; target: FeedbackChatApp | null; history: AnnotationHistory };

export interface FeedbackEditorDraft { png: Uint8Array; history: AnnotationHistory }

export interface FeedbackEditorProps {
  png: Uint8Array;
  initialHistory?: AnnotationHistory;
  onClose: (result: FeedbackEditorResult) => void;
}

type Tool = 'hand' | 'select' | 'arrow' | 'rect' | 'ellipse' | 'pen' | 'text' | 'mosaic';
type WidthKey = 'thin' | 'medium' | 'thick';
interface TextDraft { shape: TextShape; index: number | null }
interface TransformDraft { index: number; original: Shape; preview: Shape; start: Point; handle: Handle }
const COLORS = [
  { label: '红色', value: '#e5484d' }, { label: '黄色', value: '#f5b301' },
  { label: '蓝色', value: '#3b6fd4' }, { label: '绿色', value: '#2fa66a' },
];
const WIDTHS: { key: WidthKey; label: string; value: number }[] = [
  { key: 'thin', label: '细线（2px）', value: 2 },
  { key: 'medium', label: '中等线宽（4px）', value: 4 },
  { key: 'thick', label: '粗线（7px）', value: 7 },
];
const TOOLS: { key: Tool; label: string; icon: ReactNode }[] = [
  { key: 'select', label: '选择', icon: <CursorArrowIcon /> },
  { key: 'hand', label: '拖动画布（空格）', icon: <HandIcon /> },
  { key: 'arrow', label: '箭头', icon: <ArrowToolIcon /> },
  { key: 'rect', label: '矩形', icon: <RectToolIcon /> },
  { key: 'ellipse', label: '椭圆', icon: <EllipseToolIcon /> },
  { key: 'pen', label: '画笔', icon: <PenToolIcon /> },
  { key: 'text', label: '文字', icon: <TextToolIcon /> },
  { key: 'mosaic', label: '马赛克', icon: <MosaicToolIcon /> },
];
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('导出标注图失败，请重试'));
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, 'image/png');
  });
}

/** 底图和标注始终使用图片坐标；选框与文字输入独立覆盖，导出只渲染标注内容。 */
export function FeedbackEditor({ png, initialHistory, onClose }: FeedbackEditorProps): JSX.Element {
  const [history] = useState(() => initialHistory ?? new AnnotationHistory());
  const [, setRevision] = useState(0);
  const [activeTool, setActiveTool] = useState<Tool>('arrow');
  const [activeColor, setActiveColor] = useState(COLORS[0].value);
  const [activeWidth, setActiveWidth] = useState<WidthKey>('medium');
  const [fontSize, setFontSize] = useState(20);
  const [mosaicSize, setMosaicSize] = useState(10);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [viewScale, setViewScale] = useState(0);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const decodeRef = useRef<Promise<void> | null>(null);
  const gestureRef = useRef<GestureShape | null>(null);
  const transformRef = useRef<TransformDraft | null>(null);
  const textDraftRef = useRef<TextDraft | null>(null);
  const selectedIndexRef = useRef(-1);
  const renderFrameRef = useRef(0);
  const isBusyRef = useRef(false);
  const isClosedRef = useRef(false);
  const viewRef = useRef({ isFit: true, scale: 1 });
  const isSpacePressedRef = useRef(false);
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const select = useCallback((index: number) => {
    selectedIndexRef.current = index;
    setSelectedIndex(index);
  }, []);
  const ratio = (): number => {
    const canvas = canvasRef.current;
    return canvas ? canvas.width / (canvas.getBoundingClientRect().width || canvas.width || 1) : 1;
  };
  const measureText = (text: string, size: number): number => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return text.length * size;
    context.font = `600 ${size}px ${FONT_STACK}`;
    return context.measureText(text).width;
  };
  const renderNow = useCallback((isExport = false) => {
    const canvas = canvasRef.current;
    const bitmap = bitmapRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !bitmap || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    history.shapes.forEach((shape, index) => {
      if (!isExport && textDraftRef.current?.index === index) return;
      const transform = transformRef.current;
      drawShape(context, !isExport && transform?.index === index ? transform.preview : shape);
    });
    const gesture = gestureRef.current;
    if (!isExport && gesture) {
      if (gesture.type === 'mosaic') drawMosaicPreview(context, gesture, 2 * ratio());
      else drawShape(context, gesture);
    }
  }, [history]);
  const scheduleRender = useCallback(() => {
    if (renderFrameRef.current) return;
    renderFrameRef.current = requestAnimationFrame(() => {
      renderFrameRef.current = 0;
      renderNow();
      refresh();
    });
  }, [refresh, renderNow]);
  const commit = useCallback((shapes: Shape[]) => {
    history.commit(shapes);
    refresh();
    renderNow();
  }, [history, refresh, renderNow]);
  const updateTextDraft = (draft: TextDraft | null): void => {
    textDraftRef.current = draft;
    setTextDraft(draft);
  };
  const cancelText = useCallback(() => {
    textDraftRef.current = null;
    setTextDraft(null);
    renderNow();
    canvasRef.current?.focus();
  }, [renderNow]);
  const commitText = useCallback(() => {
    const draft = textDraftRef.current;
    if (!draft) return;
    textDraftRef.current = null;
    setTextDraft(null);
    const shape = { ...draft.shape, text: draft.shape.text.trim() };
    const shapes = [...history.shapes];
    if (draft.index === null) {
      if (shape.text) { shapes.push(shape); select(shapes.length - 1); }
    } else if (shape.text) {
      shapes[draft.index] = shape;
      select(draft.index);
    } else {
      shapes.splice(draft.index, 1);
      select(-1);
    }
    commit(shapes);
    setActiveTool('select');
    canvasRef.current?.focus();
  }, [commit, history, select]);
  const openText = (point: Point, index: number | null): void => {
    const existing = index !== null ? history.shapes[index] : null;
    const shape: TextShape = existing?.type === 'text' ? { ...existing } : {
      type: 'text', x: point.x, y: point.y, text: '', color: activeColor, fontSize: fontSize * window.devicePixelRatio,
    };
    updateTextDraft({ shape, index });
    select(index ?? -1);
    setActiveTool('text');
    setActiveColor(shape.color);
    setFontSize(Math.round(shape.fontSize / window.devicePixelRatio));
    renderNow();
    requestAnimationFrame(() => {
      textInputRef.current?.focus();
      if (index !== null) textInputRef.current?.select();
    });
  };
  const undo = useCallback(() => {
    if (textDraftRef.current) { document.execCommand('undo'); return; }
    gestureRef.current = null;
    transformRef.current = null;
    history.undo();
    select(-1); refresh(); renderNow();
  }, [history, refresh, renderNow, select]);
  const redo = useCallback(() => {
    if (textDraftRef.current) { document.execCommand('redo'); return; }
    gestureRef.current = null;
    transformRef.current = null;
    history.redo();
    select(-1); refresh(); renderNow();
  }, [history, refresh, renderNow, select]);
  const deleteSelected = useCallback(() => {
    const index = selectedIndexRef.current;
    if (index < 0 || isBusyRef.current) return;
    commit(history.shapes.filter((_, i) => i !== index));
    select(-1);
  }, [commit, history, select]);
  const closeEditor = useCallback(() => {
    if (isClosedRef.current || isBusyRef.current) return;
    isClosedRef.current = true;
    onClose({ action: 'cancel' });
  }, [onClose]);
  const copyImage = useCallback(async (target: FeedbackChatApp | null) => {
    if (isClosedRef.current || isBusyRef.current) return;
    isBusyRef.current = true;
    setIsBusy(true); setErrorText('');
    commitText();
    try {
      await decodeRef.current;
      const canvas = canvasRef.current;
      if (!bitmapRef.current || !canvas) throw new Error('截图尚未就绪，请稍后重试');
      renderNow(true);
      const bytes = await canvasToPngBytes(canvas);
      const result = await window.diteng.copyFeedbackImage(bytes);
      if (!result.ok) throw new Error(result.message || '复制失败，请重试');
      if (isClosedRef.current) return;
      isClosedRef.current = true;
      onClose({ action: 'copy', target, history });
    } catch (error) {
      if (isClosedRef.current) return;
      setErrorText(error instanceof Error ? error.message : '复制失败，请重试');
      isBusyRef.current = false; setIsBusy(false); renderNow();
    }
  }, [commitText, history, onClose, renderNow]);

  const layoutCanvas = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const bitmap = bitmapRef.current;
    if (!stage || !canvas || !bitmap) return;
    stage.style.setProperty('--pan-space-x', `${stage.clientWidth / 2 + 24}px`);
    stage.style.setProperty('--pan-space-y', `${stage.clientHeight / 2 + 24}px`);
    const scale = viewRef.current.isFit
      ? Math.min(Math.max(1, stage.clientWidth - 48) / bitmap.width, Math.max(1, stage.clientHeight - 48) / bitmap.height, 1 / window.devicePixelRatio)
      : viewRef.current.scale;
    viewRef.current.scale = scale;
    canvas.style.width = `${bitmap.width * scale}px`;
    canvas.style.height = `${bitmap.height * scale}px`;
    if (viewRef.current.isFit) {
      stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
      stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
    }
    setViewScale(scale);
    refresh();
  }, [refresh]);
  const zoomTo = useCallback((scale: number, anchor?: Point) => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || !bitmapRef.current || isBusyRef.current) return;
    const oldRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const point = anchor ?? { x: stageRect.left + stage.clientWidth / 2, y: stageRect.top + stage.clientHeight / 2 };
    const imageX = (point.x - oldRect.left) / viewRef.current.scale;
    const imageY = (point.y - oldRect.top) / viewRef.current.scale;
    viewRef.current = { isFit: false, scale: clamp(scale, 0.2 / window.devicePixelRatio, 4 / window.devicePixelRatio) };
    layoutCanvas();
    const nextRect = canvas.getBoundingClientRect();
    stage.scrollLeft += nextRect.left + imageX * viewRef.current.scale - point.x;
    stage.scrollTop += nextRect.top + imageY * viewRef.current.scale - point.y;
  }, [layoutCanvas]);
  const fitToWindow = (): void => {
    viewRef.current.isFit = true;
    layoutCanvas();
  };
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey || textDraftRef.current) return;
      event.preventDefault();
      zoomTo(viewRef.current.scale * Math.exp(-event.deltaY * 0.008), { x: event.clientX, y: event.clientY });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [zoomTo]);
  useEffect(() => {
    let isCancelled = false;
    const bytes = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
    decodeRef.current = (async () => {
      try {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        if (isCancelled) { bitmap.close(); return; }
        bitmapRef.current = bitmap;
        const canvas = canvasRef.current;
        if (canvas) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
        layoutCanvas(); setIsReady(true); renderNow();
      } catch { if (!isCancelled) setErrorText('截图解码失败，无法标注'); }
    })();
    return () => {
      isCancelled = true; bitmapRef.current?.close(); bitmapRef.current = null;
      if (renderFrameRef.current) cancelAnimationFrame(renderFrameRef.current);
    };
  }, [png, layoutCanvas, renderNow]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(layoutCanvas);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [layoutCanvas]);
  const handleShortcut = useCallback((action: ShortcutAction) => {
    if (isBusyRef.current) return;
    if (action === 'editor-cancel') {
      if (textDraftRef.current) cancelText(); else closeEditor();
    } else if (action === 'editor-undo') undo();
    else if (action === 'editor-redo') redo();
  }, [cancelText, closeEditor, redo, undo]);
  useEffect(() => {
    window.diteng.setFeedbackEditorActive(true);
    rootRef.current?.focus();
    const unsubscribe = window.diteng.onShortcut(handleShortcut);
    return () => { unsubscribe(); window.diteng.setFeedbackEditorActive(false); };
  }, [handleShortcut]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isClosedRef.current || event.isComposing || isBusyRef.current) return;
      if (event.key === 'Tab') {
        const controls = [...(rootRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), textarea, canvas') ?? [])];
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === rootRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === rootRef.current)) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (textDraftRef.current) return;
      if (event.key === ' ' && !(event.target instanceof HTMLElement && event.target.closest('button, select, input, textarea'))) {
        event.preventDefault(); isSpacePressedRef.current = true; setIsSpacePressed(true); return;
      }
      if (event.key === 'Escape') { event.preventDefault(); closeEditor(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected(); }
      else if (event.key === 'Enter' && !event.repeat && (document.activeElement === canvasRef.current || document.activeElement === rootRef.current)) {
        event.preventDefault(); void copyImage(null);
      }
    };
    const releaseSpace = () => { isSpacePressedRef.current = false; setIsSpacePressed(false); };
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === ' ') releaseSpace(); };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseSpace);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseSpace);
    };
  }, [closeEditor, copyImage, deleteSelected]);

  const imagePoint = (event: { clientX: number; clientY: number }): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) * ratio(), 0, canvas.width), y: clamp((event.clientY - rect.top) * ratio(), 0, canvas.height) };
  };
  const startTransform = (event: ReactPointerEvent, index: number, handle: Handle): void => {
    if (isBusyRef.current) return;
    event.preventDefault(); event.stopPropagation();
    const original = history.shapes[index];
    if (!original) return;
    select(index);
    transformRef.current = { index, original, preview: original, start: imagePoint(event), handle };
    canvasRef.current?.setPointerCapture(event.pointerId);
  };
  const beginPan = (event: ReactPointerEvent<HTMLElement>): void => {
    const stage = stageRef.current;
    if (!stage || isBusyRef.current) return;
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault(); event.stopPropagation();
    canvasRef.current?.focus();
    panRef.current = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePan = (event: ReactPointerEvent<HTMLElement>): void => {
    const pan = panRef.current; const stage = stageRef.current;
    if (!pan || !stage) return;
    stage.scrollLeft = pan.left - event.clientX + pan.x;
    stage.scrollTop = pan.top - event.clientY + pan.y;
  };
  const endPan = (event: ReactPointerEvent<HTMLElement>): void => {
    panRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!isReady || isBusyRef.current) return;
    if (isSpacePressedRef.current || activeTool === 'hand' || event.button === 1) { beginPan(event); return; }
    if (event.button !== 0) return;
    event.preventDefault();
    if (textDraftRef.current) { commitText(); return; }
    canvasRef.current?.focus();
    const point = imagePoint(event);
    const index = findShapeAtPoint(history.shapes, point, 6 * ratio(), measureText);
    if (activeTool === 'select' || activeTool === 'text' && index >= 0 && history.shapes[index].type === 'text') {
      select(index);
      if (index >= 0) {
        const shape = history.shapes[index];
        if ('color' in shape) setActiveColor(shape.color);
        if (shape.type === 'text') setFontSize(Math.round(shape.fontSize / window.devicePixelRatio));
        if (shape.type === 'mosaic') setMosaicSize(Math.round(shape.block / window.devicePixelRatio));
        if ('lineWidth' in shape) setActiveWidth(WIDTHS.reduce((closest, item) => Math.abs(item.value - shape.lineWidth / window.devicePixelRatio) < Math.abs(closest.value - shape.lineWidth / window.devicePixelRatio) ? item : closest).key);
        startTransform(event, index, 'move');
      }
      return;
    }
    select(-1);
    if (activeTool === 'text') { openText(point, null); return; }
    const width = WIDTHS.find((item) => item.key === activeWidth)!.value * window.devicePixelRatio;
    if (activeTool === 'pen') gestureRef.current = { type: 'pen', points: [point], color: activeColor, lineWidth: width };
    else if (activeTool === 'mosaic') gestureRef.current = { type: 'mosaic', from: point, to: point, block: mosaicSize * window.devicePixelRatio };
    else gestureRef.current = createBoxShape(activeTool, point, { color: activeColor, lineWidth: width });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (panRef.current) { movePan(event); return; }
    const point = imagePoint(event);
    const transform = transformRef.current;
    if (transform) transform.preview = transformShape(transform.original, transform.handle, transform.start, point);
    const gesture = gestureRef.current;
    if (gesture?.type === 'pen') gesture.points.push(point);
    else if (gesture) gesture.to = point;
    if (transform || gesture) scheduleRender();
  };
  const finishPointer = (event: ReactPointerEvent<HTMLCanvasElement>, isCancelled: boolean): void => {
    if (panRef.current) { endPan(event); return; }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const transform = transformRef.current; const gesture = gestureRef.current;
    transformRef.current = null; gestureRef.current = null;
    if (!isCancelled && transform) commit(history.shapes.map((shape, index) => index === transform.index ? transform.preview : shape));
    else if (!isCancelled && gesture && !isGestureTooSmall(gesture)) {
      commit([...history.shapes, gesture]); select(history.shapes.length - 1); setActiveTool('select');
    } else renderNow();
    refresh();
  };
  const changeStyle = (property: 'color' | 'lineWidth' | 'fontSize' | 'block', value: string | number): void => {
    const draft = textDraftRef.current;
    if (draft && (property === 'color' || property === 'fontSize')) {
      updateTextDraft({ ...draft, shape: { ...draft.shape, [property]: value } });
      return;
    }
    const shape = history.shapes[selectedIndexRef.current];
    if (!shape || !(property in shape)) return;
    commit(history.shapes.map((item, index) => index === selectedIndexRef.current ? { ...item, [property]: value } : item));
  };

  const selectedShape = transformRef.current?.preview ?? history.shapes[selectedIndex];
  const isPanTool = isSpacePressed || activeTool === 'hand';
  const bounds = selectedShape ? shapeBounds(selectedShape, measureText) : null;
  const displayRatio = ratio();
  const handles: { key: Handle; point: Point; label: string }[] = [];
  if (selectedShape?.type === 'arrow') handles.push({ key: 'from', point: selectedShape.from, label: '调整箭头起点' }, { key: 'to', point: selectedShape.to, label: '调整箭头终点' });
  else if (bounds && selectedShape?.type !== 'text' && selectedShape?.type !== 'pen') {
    for (const key of ['nw', 'ne', 'sw', 'se'] as const) handles.push({ key, point: { x: bounds.x + (key.endsWith('e') ? bounds.w : 0), y: bounds.y + (key.startsWith('s') ? bounds.h : 0) }, label: '调整标注大小' });
  }
  const isDisabled = !isReady || isBusy;
  const isTextTool = activeTool === 'text' || selectedShape?.type === 'text';
  const isMosaicTool = activeTool === 'mosaic' || selectedShape?.type === 'mosaic';

  return (
    <div ref={rootRef} className={styles.overlay} data-testid="feedback-editor" role="dialog" aria-modal="true" aria-label="反馈截图标注" tabIndex={-1}
      data-shape-count={history.shapes.length} data-selected-type={selectedShape?.type ?? ''}>
      <div className={styles.header}>
        <strong>反馈截图</strong>
        <div className={styles.zoomControls} role="group" aria-label="画布缩放">
          <button type="button" className={styles.action} data-testid="feedback-fit" disabled={isDisabled} onClick={fitToWindow}>适合窗口</button>
          <button type="button" className={styles.iconButton} data-testid="feedback-zoom-out" aria-label="缩小画布" disabled={isDisabled} onClick={() => zoomTo(viewRef.current.scale / 1.25)}><ZoomOutIcon /></button>
          <button type="button" className={styles.action} data-testid="feedback-zoom-100" title="按原页面大小显示" disabled={isDisabled} onClick={() => zoomTo(1 / window.devicePixelRatio)}>100%</button>
          <button type="button" className={styles.iconButton} data-testid="feedback-zoom-in" aria-label="放大画布" disabled={isDisabled} onClick={() => zoomTo(viewRef.current.scale * 1.25)}><ZoomInIcon /></button>
          <output className={styles.zoomValue} data-testid="feedback-zoom-value" aria-live="polite">{Math.round(viewScale * window.devicePixelRatio * 100)}%</output>
        </div>
        <button type="button" className={styles.action} data-testid="feedback-cancel" title="退出编辑（Esc）" disabled={isBusy} onClick={closeEditor}>退出编辑</button>
      </div>
      <div className={styles.stage} ref={stageRef} data-testid="feedback-stage"
        style={{ cursor: isPanning ? 'grabbing' : isPanTool ? 'grab' : undefined }}
        onPointerDown={(event) => { if (isSpacePressedRef.current || activeTool === 'hand' || event.button === 1) beginPan(event); }}
        onPointerMove={(event) => { if (panRef.current) movePan(event); }} onPointerUp={endPan} onPointerCancel={endPan}>
        <div className={styles.canvasSurface}>
        <div className={styles.canvasWrap}>
          <canvas ref={canvasRef} className={styles.canvas} data-testid="feedback-editor-canvas" tabIndex={0} aria-label="截图标注画布"
            style={{ visibility: isReady ? 'visible' : 'hidden', cursor: isPanning ? 'grabbing' : isPanTool ? 'grab' : activeTool === 'select' ? 'default' : activeTool === 'text' ? 'text' : 'crosshair' }}
            onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
            onPointerUp={(event) => finishPointer(event, false)} onPointerCancel={(event) => finishPointer(event, true)}
            onDoubleClick={(event) => {
              if (isBusyRef.current || isPanTool) return;
              const point = imagePoint(event);
              const index = findShapeAtPoint(history.shapes, point, 6 * ratio(), measureText);
              if (index >= 0 && history.shapes[index].type === 'text') openText(point, index);
            }} onContextMenu={(event) => event.preventDefault()} />
          {bounds && !textDraft && !isPanTool && <>
            <div className={styles.selection} data-testid="feedback-selection" style={{ left: bounds.x / displayRatio, top: bounds.y / displayRatio, width: bounds.w / displayRatio, height: bounds.h / displayRatio }} />
            {handles.map((handle) => <button type="button" key={handle.key} className={styles.handle} aria-label={handle.label} data-testid={`feedback-handle-${handle.key}`}
              disabled={isBusy} style={{ left: handle.point.x / displayRatio, top: handle.point.y / displayRatio }}
              onPointerDown={(event) => startTransform(event, selectedIndex, handle.key)} />)}
          </>}
          {textDraft && <div className={styles.textEditor} style={{ left: clamp(textDraft.shape.x / displayRatio, 0, Math.max(0, (canvasRef.current?.clientWidth ?? 400) - 320)), top: Math.max(0, (textDraft.shape.y - textDraft.shape.fontSize) / displayRatio) }}>
            <textarea ref={textInputRef} className={styles.textInput} data-testid="feedback-text-input" aria-label="输入标注文字" placeholder="输入文字" spellCheck={false}
              style={{ color: textDraft.shape.color, fontSize: textDraft.shape.fontSize / displayRatio }} value={textDraft.shape.text}
              onChange={(event) => updateTextDraft({ ...textDraft, shape: { ...textDraft.shape, text: event.target.value } })}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commitText(); }
                else if (event.key === 'Escape') { event.preventDefault(); cancelText(); }
              }} />
            <div className={styles.textActions}><span>⌘ / Ctrl + Enter 确认</span><button type="button" data-testid="feedback-text-done" className={`${styles.action} ${styles.actionPrimary}`} onClick={commitText}>完成</button></div>
          </div>}
        </div>
        </div>
        {!isReady && !errorText && <div className={styles.loading}>正在载入截图…</div>}
      </div>
      <div className={styles.bottom}>
        {errorText && <div className={styles.error} data-testid="feedback-error" role="alert"><AlertIcon /><span>{errorText}</span></div>}
        <div className={styles.toolbar} role="toolbar" aria-label="标注工具栏">
          {TOOLS.map((tool) => <button type="button" key={tool.key} className={styles.iconButton} data-testid={`feedback-tool-${tool.key}`} title={tool.label} aria-label={tool.label}
            aria-pressed={activeTool === tool.key} disabled={isDisabled} onClick={() => { commitText(); setActiveTool(tool.key); }}>{tool.icon}</button>)}
          <span className={styles.divider} aria-hidden="true" />
          {!isMosaicTool && <div className={styles.swatchGroup} role="group" aria-label="标注颜色">{COLORS.map((color, index) => <button type="button" key={color.value} className={styles.swatchButton} title={color.label} aria-label={color.label}
            data-testid={`feedback-color-${['red', 'yellow', 'blue', 'green'][index]}`} aria-pressed={activeColor === color.value} disabled={isDisabled}
            onClick={() => { setActiveColor(color.value); changeStyle('color', color.value); }}><span className={styles.swatch} style={{ backgroundColor: color.value }} /></button>)}</div>}
          {isTextTool ? <label className={styles.option}>字号<select aria-label="文字字号" data-testid="feedback-font-size" value={fontSize} disabled={isDisabled}
            onChange={(event) => { const size = Number(event.target.value); setFontSize(size); changeStyle('fontSize', size * window.devicePixelRatio); }}>{[16, 20, 24, 32, 40].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
            : isMosaicTool ? <label className={styles.option}>颗粒<select aria-label="马赛克颗粒大小" value={mosaicSize} disabled={isDisabled}
              onChange={(event) => { const size = Number(event.target.value); setMosaicSize(size); changeStyle('block', size * window.devicePixelRatio); }}>{[6, 10, 16, 24].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
            : <div className={styles.widthGroup} role="group" aria-label="线宽">{WIDTHS.map((width) => <button type="button" key={width.key} className={styles.widthButton} data-testid={`feedback-width-${width.key}`} title={width.label} aria-label={width.label}
              aria-pressed={activeWidth === width.key} disabled={isDisabled} onClick={() => { setActiveWidth(width.key); changeStyle('lineWidth', width.value * window.devicePixelRatio); }}>
              <span className={`${styles.widthDot} ${styles[{ thin: 'widthDotThin', medium: 'widthDotMedium', thick: 'widthDotThick' }[width.key]]}`} /></button>)}</div>}
          <span className={styles.divider} aria-hidden="true" />
          <button type="button" className={styles.iconButton} data-testid="feedback-delete" title="删除标注（Delete）" aria-label="删除标注" disabled={selectedIndex < 0 || isBusy} onClick={deleteSelected}><TrashIcon /></button>
          <button type="button" className={styles.iconButton} data-testid="feedback-undo" title="撤销（⌘Z）" aria-label="撤销" disabled={!history.canUndo || isBusy} onClick={undo}><UndoIcon /></button>
          <button type="button" className={styles.iconButton} data-testid="feedback-redo" title="重做（⇧⌘Z）" aria-label="重做" disabled={!history.canRedo || isBusy} onClick={redo}><RedoIcon /></button>
          <div className={styles.completionActions}>
          <span className={styles.divider} aria-hidden="true" />
          <button type="button" className={`${styles.action} ${styles.actionPrimary}`} data-testid="feedback-copy" aria-busy={isBusy} disabled={isDisabled} onClick={() => void copyImage(null)}><CopyIcon /><span>{isBusy ? '正在复制…' : '复制图片'}</span></button>
          <button type="button" className={styles.action} data-testid="feedback-open-wechat" disabled={isDisabled} onClick={() => void copyImage('wechat')}>复制并打开微信</button>
          <button type="button" className={styles.action} data-testid="feedback-open-wecom" disabled={isDisabled} onClick={() => void copyImage('wecom')}>复制并打开企业微信</button>
          </div>
        </div>
        <div className={styles.canvasHint}>{activeTool === 'hand' ? '按住鼠标拖动画布 · 点击“适合窗口”恢复居中' : '选择标注可修改 · 双击文字重新编辑 · ⌘ / Ctrl + 滚轮缩放 · 空格拖动画布'}</div>
      </div>
    </div>
  );
}
