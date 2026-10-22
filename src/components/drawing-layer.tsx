"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { IChartApi, ISeriesApi, Logical, SeriesType, UTCTimestamp } from "lightweight-charts";
import { screenXToTime, timeToScreenX } from "@/components/chart-coords";
import { DrawingProperties, applyListAction } from "@/components/drawing-editor";
import { S1_PREFIX } from "@/components/s1-overlay";
import { DrawingEditBar, type EditAction } from "@/components/drawing-edit-bar";
import { FIB_CHANNEL_RATIOS, FIB_FAN_RATIOS, GANN_FAN, GANN_RATIOS, RECTANGLE_CENTER, barsBetween, centerSegment, defaultTextStyle, dragBox, dedupePoints, drawingVisible, editPosition, isPositionHandle, positionGeometry, positionMetrics, positionPoints, setAnchor, duplicateDrawing, fibExtensionPrice, fibLevelSet, fibTimes, FULL_SPAN_KINDS, hexAlpha, levelColor, isBoxHandle, isClosedShape, measureGestureDown, measureGestureFinish, measureGestureMove, measureLines, measureStats, measureTone, overRightPriceScale, pitchforkOrigin, placeMeasureCard, pointsNeeded, preferredTemplate, regressionLine, resizeBox, screenAngle, shiftDrawing, zoomPriceRange, type Drawing, type DrawTool, type MagnetMode, type MeasureGesture, type Point } from "@/components/drawing-model";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume?: number };

const WEAK_MAGNET_PX = 14;

type MarkStyle = { stroke?: number; pattern?: "solid" | "dashed" | "dotted" };
type Mark = (
  | { id: string; kind: "segment"; x1: number; y1: number; x2: number; y2: number; color: string; selected: boolean; dash?: boolean }
  | { id: string; kind: "hline"; y: number; color: string; label: string; selected: boolean }
  | { id: string; kind: "poly"; d: string; color: string; selected: boolean; opacity?: number }
  | { id: string; kind: "text"; x: number; y: number; text: string; color: string; selected: boolean; size?: number; bold?: boolean; italic?: boolean; anchor?: "start" | "middle" | "end"; angle?: number }
  | { id: string; kind: "dot"; x: number; y: number; color: string; selected: boolean }
  | { id: string; kind: "vline"; x: number; color: string; selected: boolean }
  | { id: string; kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; color: string; fill: string; selected: boolean }
  | { id: string; kind: "handle"; x: number; y: number; selected: boolean }
  | { id: string; kind: "box"; x: number; y: number; width: number; height: number; fill: string; color: string; selected: boolean }
  | { id: string; kind: "card"; x: number; y: number; width: number; height: number; lines: string[]; color: string; selected: boolean }
  | { id: string; kind: "profile"; x: number; y: number; width: number; color: string; selected: boolean }
) & MarkStyle;

export const SHAPE_COLOR = "#9C27B0";
export const SHAPE_FILL_OPACITY = 0.2;
/** New line tools (everything in the Lines menu) are dark red. A saved default style still wins. */
export const LINE_COLOR = "#B71C1C";
export const LINE_KINDS = new Set<string>(["trend", "ray", "infoline", "extended", "angle", "hline", "hray", "vline", "crossline", "channel", "regression"]);

/** The colour a new drawing gets (and its preview while placing): the saved default style, else the tool default. */
function newDrawingColor(kind: Drawing["kind"]) {
  const saved = preferredTemplate(kind)?.color;
  if (saved) return saved;
  if (kind === "rect" || kind === "ellipse" || kind === "circle") return SHAPE_COLOR;
  return LINE_KINDS.has(kind) ? LINE_COLOR : "#D4AF37";
}

const NO_OVERLAYS: Drawing[] = [];

export function DrawingLayer({
  chartRef,
  seriesRef,
  candles,
  drawings,
  onDrawings,
  tool,
  magnet,
  hidden,
  annotation,
  command,
  enabled,
  onTool,
  onSelect,
  ready = 0,
  span = "1d",
  focusId,
  stay = false,
  lockAll = false,
  overlays = NO_OVERLAYS,
}: {
  chartRef: { current: IChartApi | null };
  seriesRef: { current: ISeriesApi<SeriesType> | null };
  candles: Bar[];
  drawings: Drawing[];
  onDrawings: (next: Drawing[], undo?: boolean) => void;
  tool: DrawTool;
  magnet: MagnetMode | boolean;
  stay?: boolean;
  lockAll?: boolean;
  /** Strategy drawings (S1): drawn like the rest, never selectable, never saved, never in undo. */
  overlays?: Drawing[];
  hidden: boolean;
  annotation: string;
  command: { id: number; name: "lock" | "trash" | "color" } | null;
  enabled: boolean;
  onTool: (tool: DrawTool) => void;
  onSelect?: (id: string | null) => void;
  ready?: number;
  span?: string;
  focusId?: string | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef<() => void>(() => undefined);
  const drawingsRef = useRef(drawings);
  const overlaysRef = useRef(overlays);
  const toolRef = useRef(tool);
  const magnetRef = useRef<MagnetMode>("off");
  const annotationRef = useRef(annotation);
  const onDrawingsRef = useRef(onDrawings);
  const onToolRef = useRef(onTool);
  const onSelectRef = useRef(onSelect);
  const draftRef = useRef<Point[]>([]);
  const previewRef = useRef<Point | null>(null);
  const selectedRef = useRef<string | null>(null);
  const brushing = useRef<Point[] | null>(null);
  const pickedAt = useRef(0);
  const measureDrag = useRef<MeasureGesture | null>(null);
  const shapeDrag = useRef<Point | null>(null);
  const spanRef = useRef(span);
  const candlesRef = useRef(candles);
  /** Set when a press grabbed an existing drawing while a drawing tool was active, so its pointerup adds no point. */
  const grabbed = useRef(false);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [selected, setSelected] = useState<string | null>(focusId ?? null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  /** In-place text box opened from "+ Add text" or by double-clicking a caption. */
  const [inline, setInline] = useState<{ id: string; x: number; y: number; angle: number } | null>(null);
  const inlineCancelled = useRef(false);
  const [eraseHover, setEraseHover] = useState<string | null>(null);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const stayRef = useRef(stay);
  const lockAllRef = useRef(lockAll);
  const [seenFocus, setSeenFocus] = useState(focusId);
  if (focusId !== seenFocus) {
    setSeenFocus(focusId);
    if (focusId !== undefined) setSelected(focusId);
  }
  useEffect(() => {
    stayRef.current = stay;
    lockAllRef.current = lockAll;
  }, [stay, lockAll]);
  drawingsRef.current = drawings;
  overlaysRef.current = overlays;
  toolRef.current = tool;
  magnetRef.current = magnet === true ? "strong" : magnet === false ? "off" : magnet;
  annotationRef.current = annotation;
  onDrawingsRef.current = onDrawings;
  onToolRef.current = onTool;
  onSelectRef.current = onSelect;
  selectedRef.current = selected;
  spanRef.current = span;
  useEffect(() => {
    candlesRef.current = candles;
  }, [candles]);

  function project() {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || hidden) {
      setMarks([]);
      return;
    }
    const scale = chart.timeScale();
    const xy = (point: Point) => {
      const x = timeToScreenX((index) => scale.logicalToCoordinate(index as Logical), candles, point.time);
      const y = series.priceToCoordinate(point.price);
      return x == null || y == null ? null : { x, y };
    };
    const next: Mark[] = [];
    const show = [...drawingsRef.current, ...overlaysRef.current];
    const preview = previewShape();
    if (preview) show.push(preview);
    for (const drawing of show) {
      if (drawing.id !== "preview" && !drawingVisible(drawing, spanRef.current)) continue;
      const active = drawing.id === selectedRef.current;
      const from = next.length;
      if ((drawing.kind === "hline" || drawing.kind === "hray") && drawing.points[0]) {
        const y = series.priceToCoordinate(drawing.points[0].price);
        if (y != null && drawing.kind === "hline") next.push({ id: drawing.id, kind: "hline", y, color: drawing.color, label: drawing.points[0].price.toFixed(2), selected: active });
        if (drawing.kind === "hray" && y != null) {
          const x = timeToScreenX((index) => scale.logicalToCoordinate(index as Logical), candles, drawing.points[0].time);
          if (x != null) next.push({ id: drawing.id, kind: "segment", x1: x, y1: y, x2: Math.max(x, scale.width()), y2: y, color: drawing.color, selected: active, dash: drawing.dash === "dashed" });
        }
      } else if ((drawing.kind === "text" || drawing.kind === "note" || drawing.kind === "price" || drawing.kind === "callout") && drawing.points[0]) {
        const at = xy(drawing.points[0]);
        if (at) {
          const label = drawing.kind === "price" ? (drawing.text || drawing.points[0].price.toFixed(2)) : (drawing.text || "Note");
          const style = drawing.textStyle;
          const size = style?.size ?? 12;
          if (drawing.kind === "note" || drawing.kind === "price" || drawing.kind === "callout") next.push({ id: `${drawing.id}-bg`, kind: "box", x: at.x - 4, y: drawing.kind === "callout" ? at.y - 20 - size * 1.35 : at.y - size - 4, width: Math.max(48, label.length * size * 0.6 + 8), height: size + 8, fill: "var(--elevated)", color: drawing.color, selected: active });
          if (drawing.kind === "callout") next.push({ id: `${drawing.id}-stem`, kind: "segment", x1: at.x, y1: at.y, x2: at.x, y2: at.y - 16, color: drawing.color, selected: active });
          next.push({ id: drawing.id, kind: "text", x: at.x, y: drawing.kind === "callout" ? at.y - 22 : at.y, text: label, color: drawing.color, selected: active, size, bold: style?.bold, italic: style?.italic });
        }
      } else if (drawing.kind === "marker" && drawing.points[0]) {
        const at = xy(drawing.points[0]);
        if (at) {
          next.push({ id: drawing.id, kind: "dot", x: at.x, y: at.y, color: drawing.color, selected: active });
          if (drawing.text) next.push({ id: `${drawing.id}-glyph`, kind: "text", x: at.x + 8, y: at.y + 4, text: drawing.text, color: drawing.textStyle?.color ?? drawing.color, selected: active, size: drawing.textStyle?.size, bold: drawing.textStyle?.bold, italic: drawing.textStyle?.italic });
        }
      } else if (drawing.kind === "range" && drawing.points.length >= 2) {
        pushRange(next, drawing, xy, candles, active, hostRef.current);
      } else if ((drawing.kind === "path" || drawing.kind === "polyline" || drawing.kind === "brush" || drawing.kind === "highlighter") && drawing.points.length > 1) {
        const d = drawing.points.flatMap((point, index) => {
          const at = xy(point);
          return at ? [`${index === 0 ? "M" : "L"}${at.x},${at.y}`] : [];
        }).join(" ");
        if (d) next.push({ id: drawing.id, kind: "poly", d, color: drawing.color, selected: active, opacity: drawing.kind === "highlighter" ? 0.35 : 1 });
      } else if ((drawing.kind === "fib" || drawing.kind === "fibext") && drawing.points.length >= 2) {
        fibLevelSet(drawing).forEach((level, index) => {
          if (!level.visible) return;
          const price = fibExtensionPrice(drawing.points, level.ratio);
          const y = series.priceToCoordinate(price);
          if (y != null) next.push({ id: `${drawing.id}-${level.ratio}`, kind: "hline", y, color: levelColor(drawing, index), label: `${(level.ratio * 100).toFixed(1)}% ${price.toFixed(2)}`, selected: active });
        });
      } else if (drawing.kind === "fibtime" && drawing.points.length >= 2) {
        fibTimes(drawing.points[0].time, drawing.points[1].time).forEach((zone, index) => {
          const at = xy({ time: zone.time, price: drawing.points[0].price });
          if (at) next.push({ id: `${drawing.id}-t${zone.ratio}`, kind: "vline", x: at.x, color: levelColor(drawing, index), selected: active });
        });
      } else if (drawing.kind === "channel" && drawing.points.length >= 2) {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy);
        const offset = (drawing.points[2]?.price ?? drawing.points[0].price) - drawing.points[0].price;
        pushSegment(next, `${drawing.id}-b`, { time: drawing.points[0].time, price: drawing.points[0].price + offset }, { time: drawing.points[1].time, price: drawing.points[1].price + offset }, drawing.color, active, xy);
      } else if ((drawing.kind === "long" || drawing.kind === "short") && drawing.points.length >= 2) {
        pushPosition(next, drawing, xy, series, hostRef.current?.clientHeight ?? 0);
      } else if (drawing.kind === "forecast" && drawing.points.length >= 2) {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy, true);
      } else if (drawing.kind === "projection" && drawing.points.length >= 2) {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy);
        const extend = {
          time: drawing.points[1].time + (drawing.points[1].time - drawing.points[0].time),
          price: drawing.points[1].price + (drawing.points[1].price - drawing.points[0].price),
        };
        pushSegment(next, `${drawing.id}-ext`, drawing.points[1], extend, drawing.color, active, xy, true);
      } else if (drawing.kind === "avwap" && drawing.points[0]) {
        pushPoly(next, drawing.id, anchoredVwap(candles, drawing.points[0].time), drawing.color, active, xy);
      } else if ((drawing.kind === "bars" || drawing.kind === "ghost") && drawing.points.length >= 2) {
        pushPoly(next, drawing.id, patternLine(candles, drawing.points[0].time, drawing.points[1].time, drawing.kind === "ghost"), drawing.color, active, xy, drawing.kind === "ghost" ? 0.45 : 1);
      } else if (drawing.kind === "vprofile" && drawing.points.length >= 2) {
        pushProfile(next, drawing, candles, xy);
      } else if ((drawing.kind === "ray" || drawing.kind === "extended") && drawing.points.length >= 2) {
        const a = xy(drawing.points[0]);
        const b = xy(drawing.points[1]);
        const width = scale.width();
        const height = hostRef.current?.clientHeight ?? 0;
        if (a && b && width > 0 && height > 0) {
          const end = toEdge(a, b, width, height);
          const start = drawing.kind === "extended" ? toEdge(b, a, width, height) : a;
          next.push({ id: drawing.id, kind: "segment", x1: start.x, y1: start.y, x2: end.x, y2: end.y, color: drawing.color, selected: active, dash: drawing.dash === "dashed" });
        }
      } else if (drawing.kind === "vline" && drawing.points[0]) {
        const at = xy(drawing.points[0]);
        if (at) next.push({ id: drawing.id, kind: "vline", x: at.x, color: drawing.color, selected: active });
      } else if ((drawing.kind === "rect" || drawing.kind === "ellipse") && drawing.points.length >= 2) {
        pushClosed(next, drawing, xy, active);
      } else if (drawing.kind === "triangle" && drawing.points.length >= 3) {
        pushPoly(next, drawing.id, [...drawing.points, drawing.points[0]], drawing.color, active, xy);
      } else if (drawing.kind === "arrow" && drawing.points.length >= 2) {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy, drawing.dash === "dashed");
        pushArrowHead(next, drawing, xy);
      } else if (drawing.kind === "circle" && drawing.points.length >= 2) {
        pushCircle(next, drawing, xy, active);
      } else if (drawing.kind === "rrect" && drawing.points.length >= 2) {
        pushRotatedRect(next, drawing, xy, active);
      } else if ((drawing.kind === "arc" || drawing.kind === "curve" || drawing.kind === "dcurve") && drawing.points.length >= 2) {
        pushBend(next, drawing, xy, active);
      } else if (isMarkArrow(drawing.kind) && drawing.points[0]) {
        pushMarkArrow(next, drawing, xy, active);
      } else if (drawing.kind === "crossline" && drawing.points[0]) {
        const at = xy(drawing.points[0]);
        if (at) {
          next.push({ id: drawing.id, kind: "hline", y: at.y, color: drawing.color, label: drawing.points[0].price.toFixed(2), selected: active });
          next.push({ id: `${drawing.id}-v`, kind: "vline", x: at.x, color: drawing.color, selected: active });
        }
      } else if (drawing.kind === "infoline" && drawing.points.length >= 2) {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy);
        const left = xy(drawing.points[0]);
        const right = xy(drawing.points[1]);
        if (left && right) {
          const stats = measureStats(drawing.points[0], drawing.points[1], barsBetween(drawing.points[0].time, drawing.points[1].time, barStep(candles), candles.map((candle) => candle.time)));
          next.push({ id: `${drawing.id}-info`, kind: "text", x: right.x + 6, y: right.y - 6, text: `${signed(stats.change)} (${signed(stats.percent)}%) · ${stats.bars} bars · ${screenAngle(right.x - left.x, right.y - left.y).toFixed(1)}°`, color: drawing.color, selected: active });
        }
      } else if ((drawing.kind === "daterange" || drawing.kind === "dprange") && drawing.points.length >= 2) {
        pushSpan(next, drawing, xy, candles, active);
      } else if (drawing.kind === "regression" && drawing.points.length >= 2) {
        pushRegression(next, drawing, xy, candles, active);
      } else if ((drawing.kind === "pitchfork" || drawing.kind === "schiff" || drawing.kind === "modschiff") && drawing.points.length >= 3) {
        pushPitchfork(next, drawing, drawing.kind, xy, active);
      } else if (drawing.kind === "fibfan" && drawing.points.length >= 2) {
        pushFan(next, drawing, [...FIB_FAN_RATIOS, 1].map((ratio) => ({ ratio, label: ratio === 1 ? "1" : ratio.toString() })), xy, active);
      } else if (drawing.kind === "gannfan" && drawing.points.length >= 2) {
        pushFan(next, drawing, GANN_FAN.map(([a, b]) => ({ ratio: a / b, label: `${a}x${b}` })), xy, active);
      } else if (drawing.kind === "fibchannel" && drawing.points.length >= 3) {
        const offset = drawing.points[2].price - drawing.points[0].price;
        FIB_CHANNEL_RATIOS.forEach((ratio, index) => {
          const a = { time: drawing.points[0].time, price: drawing.points[0].price + offset * ratio };
          const b = { time: drawing.points[1].time, price: drawing.points[1].price + offset * ratio };
          pushSegment(next, index === 0 ? drawing.id : `${drawing.id}-c${index}`, a, b, levelColor(drawing, index), active, xy, ratio !== 0 && ratio !== 1);
          const end = xy(b);
          if (end) next.push({ id: `${drawing.id}-cl${index}`, kind: "text", x: end.x + 4, y: end.y + 4, text: ratio.toString(), color: levelColor(drawing, index), selected: active, size: 10 });
        });
      } else if ((drawing.kind === "gannbox" || drawing.kind === "gannsquare") && drawing.points.length >= 2) {
        pushGann(next, drawing, xy, active);
      } else if ((drawing.kind === "xabcd" || drawing.kind === "headshoulders" || drawing.kind === "elliott" || drawing.kind === "elliottabc") && drawing.points.length >= 2) {
        pushPattern(next, drawing, xy, active);
      } else if (drawing.kind === "angle" && drawing.points.length >= 2) {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy);
        const left = xy(drawing.points[0]);
        const right = xy(drawing.points[1]);
        if (left && right) next.push({ id: `${drawing.id}-angle`, kind: "text", x: right.x, y: right.y - 8, text: `${screenAngle(right.x - left.x, right.y - left.y).toFixed(1)}°`, color: drawing.color, selected: active });
      } else if (drawing.points.length >= 2 && drawing.kind !== "hray") {
        pushSegment(next, drawing.id, drawing.points[0], drawing.points[1], drawing.color, active, xy, drawing.dash === "dashed");
        if (drawing.kind === "measure") {
          const at = xy(drawing.points[1]);
          const from = Math.min(drawing.points[0].time, drawing.points[1].time);
          const to = Math.max(drawing.points[0].time, drawing.points[1].time);
          const bars = candles.filter((candle) => candle.time >= from && candle.time <= to).length;
          const stats = measureStats(drawing.points[0], drawing.points[1], bars);
          if (at) next.push({ id: `${drawing.id}-label`, kind: "text", x: at.x, y: at.y - 8, text: `${stats.change >= 0 ? "+" : ""}${stats.change.toFixed(2)} (${stats.percent >= 0 ? "+" : ""}${stats.percent.toFixed(2)}%) · ${stats.bars} bars · ${formatSpan(stats.seconds)}`, color: drawing.color, selected: active });
        }
      }
      const drawn = next.length;
      const fade = !isClosedShape(drawing.kind) && drawing.borderOpacity != null && drawing.borderOpacity < 1 ? drawing.borderOpacity : null;
      for (let index = from; index < drawn; index += 1) {
        const mark = next[index];
        const forced = "dash" in mark && mark.dash;
        const tinted = fade != null && "color" in mark ? { color: tint(mark.color, fade) } : {};
        next[index] = { ...mark, ...tinted, stroke: mark.stroke ?? drawing.width ?? 1.5, pattern: forced ? "dashed" : (mark.pattern ?? drawing.dash ?? "solid") };
      }
      if (drawing.kind === "rect") pushCenterLine(next, drawing, xy);
      pushCaption(next, drawing, xy, series, scale.width(), active);
      // While placing points, each placed anchor and the cursor end show the same ring as a selected handle.
      if (drawing.id === "preview" && drawing.kind !== "brush" && drawing.kind !== "highlighter") {
        drawing.points.forEach((point, index) => {
          const at = xy(point);
          if (at) next.push({ id: `preview#${index}`, kind: "handle", x: at.x, y: at.y, selected: true });
        });
      }
      if (active && drawing.id !== "preview") {
        if ((drawing.kind === "rect" || drawing.kind === "ellipse") && drawing.points.length >= 2) pushBoxHandles(next, drawing, xy);
        else if ((drawing.kind === "long" || drawing.kind === "short") && drawing.points.length >= 2) {
          const geometry = positionGeometry(drawing);
          if (geometry) {
            const spots: Array<[string, Point]> = [
              ["target", { time: geometry.left, price: geometry.target }],
              ["entry", { time: geometry.left, price: geometry.entry }],
              ["stop", { time: geometry.left, price: geometry.stop }],
              ["right", { time: geometry.right, price: geometry.entry }],
            ];
            for (const [name, spot] of spots) {
              const at = xy(spot);
              if (at) next.push({ id: `${drawing.id}#${name}`, kind: "handle", x: at.x, y: at.y, selected: true });
            }
          }
        } else if (drawing.kind === "brush" || drawing.kind === "highlighter") {
          // A stroke has hundreds of samples: two handles, both of which move the whole stroke.
          const first = xy(drawing.points[0]);
          const last = xy(drawing.points[drawing.points.length - 1]);
          if (first) next.push({ id: `${drawing.id}#move`, kind: "handle", x: first.x, y: first.y, selected: true });
          if (last) next.push({ id: `${drawing.id}#move-end`, kind: "handle", x: last.x, y: last.y, selected: true });
        } else drawing.points.forEach((point, index) => {
          // The channel's third handle sits on the parallel line it controls.
          const spot = drawing.kind === "channel" && index === 2 && drawing.points.length >= 3
            ? { time: (drawing.points[0].time + drawing.points[1].time) / 2, price: (drawing.points[0].price + drawing.points[1].price) / 2 + (point.price - drawing.points[0].price) }
            : point;
          const at = xy(spot);
          // The circle's centre handle moves the circle; the edge handle sets the radius.
          const id = drawing.kind === "circle" && index === 0 ? `${drawing.id}#move` : `${drawing.id}#${index}`;
          if (at) next.push({ id, kind: "handle", x: at.x, y: at.y, selected: true });
        });
      }
    }
    setMarks(next);
  }
  projectRef.current = project;

  function previewShape(): Drawing | null {
    const draft = draftRef.current;
    const preview = previewRef.current;
    const active = toolRef.current;
    if ((active === "brush" || active === "highlighter") && draft.length > 1) return { id: "preview", kind: active, points: draft, color: newDrawingColor(active), locked: false };
    if (!draft.length || !preview) return null;
    const points = [...draft, preview];
    if (pointsNeeded(active) >= 2) return { id: "preview", kind: active as Drawing["kind"], points, color: newDrawingColor(active as Drawing["kind"]), locked: false };
    return null;
  }

  useEffect(() => {
    project();
    const chart = chartRef.current;
    if (!chart) return;
    const onRange = () => project();
    chart.timeScale().subscribeVisibleTimeRangeChange(onRange);
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    chart.timeScale().subscribeSizeChange(onRange);
    const onClick = () => {
      if (performance.now() - pickedAt.current < 300) return;
      setSelected(null);
      onSelectRef.current?.(null);
      setMenu(null);
    };
    chart.subscribeClick(onClick);
    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.timeScale().unsubscribeSizeChange(onRange);
      chart.unsubscribeClick(onClick);
    };
  }, [candles, drawings, overlays, hidden, selected, tool, ready, span]);

  useEffect(() => {
    if (!enabled || !command) return;
    const current = drawingsRef.current;
    if (command.name === "trash") {
      const id = selectedRef.current;
      if (id) {
        const item = current.find((drawing) => drawing.id === id);
        if (item && !item.locked && !lockAllRef.current) onDrawingsRef.current(current.filter((drawing) => drawing.id !== id), true);
        setSelected(null);
      } else if (!lockAllRef.current && window.confirm("Remove all drawings for this symbol? Locked drawings, orders and balances stay.")) {
        onDrawingsRef.current(current.filter((drawing) => drawing.locked), true);
      }
    } else if (command.name === "lock") {
      const id = selectedRef.current;
      if (id) onDrawingsRef.current(current.map((drawing) => drawing.id === id ? { ...drawing, locked: !drawing.locked } : drawing), true);
      else {
        const unlock = current.length > 0 && current.every((drawing) => drawing.locked);
        onDrawingsRef.current(current.map((drawing) => ({ ...drawing, locked: !unlock })), true);
      }
    } else if (command.name === "color" && selectedRef.current) {
      onDrawingsRef.current(current.map((drawing) => drawing.id === selectedRef.current ? { ...drawing, color: nextColor(drawing.color) } : drawing), true);
    }
  }, [command, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable || target.closest('[role="slider"]'))) return;
      const mod = event.ctrlKey || event.metaKey;
      const chosen = selectedRef.current ? drawingsRef.current.find((drawing) => drawing.id === selectedRef.current) ?? null : null;
      if (chosen && mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        const copy = duplicateDrawing(chosen, crypto.randomUUID());
        onDrawingsRef.current([...drawingsRef.current, copy], true);
        setSelected(copy.id);
        onSelectRef.current?.(copy.id);
        return;
      }
      if (chosen && mod && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        if (!lockAllRef.current) onDrawingsRef.current(drawingsRef.current.map((drawing) => drawing.id === chosen.id ? { ...drawing, locked: !drawing.locked, updatedAt: Date.now() } : drawing), true);
        return;
      }
      if (chosen && !mod && !event.altKey && event.key.startsWith("Arrow") && !chosen.locked && !lockAllRef.current) {
        // One bar sideways or about one pixel of price; Shift moves ten.
        const factor = event.shiftKey ? 10 : 1;
        const series = seriesRef.current;
        const top = series?.coordinateToPrice(0);
        const below = series?.coordinateToPrice(factor);
        const dp = top != null && below != null ? Math.abs(top - below) : 0;
        const dt = barStep(candlesRef.current) * factor;
        const shift = event.key === "ArrowLeft" ? [-dt, 0] : event.key === "ArrowRight" ? [dt, 0] : event.key === "ArrowUp" ? [0, dp] : event.key === "ArrowDown" ? [0, -dp] : null;
        if (!shift || (shift[0] === 0 && shift[1] === 0)) return;
        event.preventDefault();
        onDrawingsRef.current(drawingsRef.current.map((drawing) => drawing.id === chosen.id ? { ...shiftDrawing(drawing, shift[0], shift[1]), updatedAt: Date.now() } : drawing), true);
        return;
      }
      if (event.key === "Escape") {
        setMenu(null);
        measureDrag.current = null;
        shapeDrag.current = null;
        brushing.current = null;
        draftRef.current = [];
        previewRef.current = null;
        setSelected(null);
        onSelectRef.current?.(null);
        onToolRef.current("cursor");
        project();
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedRef.current) {
        const item = drawingsRef.current.find((drawing) => drawing.id === selectedRef.current);
        if (item && !item.locked && !lockAllRef.current) onDrawingsRef.current(drawingsRef.current.filter((drawing) => drawing.id !== item.id), true);
        setSelected(null);
        onSelectRef.current?.(null);
      }
      if (event.key === "Enter" && (toolRef.current === "path" || toolRef.current === "polyline") && draftRef.current.length >= 2) {
        commit(draftRef.current, toolRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  function commit(raw: Point[], kind: Drawing["kind"] = toolRef.current as Drawing["kind"]) {
    let points = kind === "path" || kind === "polyline" || kind === "brush" || kind === "highlighter" ? dedupePoints(raw) : raw;
    if ((kind === "long" || kind === "short") && points.length >= 3) {
      const geometry = positionGeometry({ kind, points });
      if (geometry) {
        // Clicked in a column: give it about 20 bars of width so the zones are readable.
        const minimum = barStep(candlesRef.current) * 20;
        if (geometry.right - geometry.left < minimum) geometry.right = geometry.left + minimum;
        points = positionPoints(geometry);
      }
    }
    const typed = annotationRef.current.trim();
    const text = kind === "price" ? (typed || points[0]?.price.toFixed(2) || "") : kind === "marker" ? typed : (typed || (kind === "text" || kind === "note" || kind === "callout" ? "Note" : ""));
    const style = preferredTemplate(kind);
    const now = Date.now();
    const rectangle = kind === "rect";
    // TradingView-like shapes: purple outline, 80% transparent fill of the same colour; rectangles get a dashed middle line.
    const shape = rectangle || kind === "ellipse" || kind === "circle";
    const drawing: Drawing = { id: crypto.randomUUID(), kind, points, text, color: newDrawingColor(kind), fill: style?.fill ?? (shape ? SHAPE_COLOR : undefined), fillOpacity: style?.fillOpacity ?? (shape ? SHAPE_FILL_OPACITY : undefined), width: style?.width ?? (shape ? 1 : kind === "highlighter" ? 10 : 1.5), dash: style?.dash ?? "solid", borderVisible: style?.borderVisible, fillVisible: style?.fillVisible, center: rectangle ? (style?.center ?? { ...RECTANGLE_CENTER, color: SHAPE_COLOR, visible: true }) : undefined, textStyle: text ? defaultTextStyle() : undefined, locked: false, createdAt: now, updatedAt: now };
    onDrawingsRef.current([...drawingsRef.current, drawing], true);
    draftRef.current = [];
    previewRef.current = null;
    brushing.current = null;
    measureDrag.current = null;
    project();
    if (!stayRef.current) onToolRef.current("cursor");
  }

  function read(event: { clientX: number; clientY: number }, magnetOn = true): Point | null {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const host = hostRef.current;
    if (!chart || !series || !host) return null;
    const rect = host.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const price = series.coordinateToPrice(y);
    const time = screenXToTime((pixel) => chart.timeScale().coordinateToLogical(pixel), candles, x);
    if (price == null || time == null) return null;
    const mode = magnetOn ? magnetRef.current : "off";
    if (mode === "off" || !candles.length) return { time, price };
    const bar = candles.reduce((best, candle) => Math.abs(candle.time - time) < Math.abs(best.time - time) ? candle : best);
    const snap = [bar.open, bar.high, bar.low, bar.close].reduce((best, value) => Math.abs(value - price) < Math.abs(best - price) ? value : best);
    if (mode === "weak") {
      const snapY = series.priceToCoordinate(snap);
      if (snapY == null || Math.abs(snapY - y) > WEAK_MAGNET_PX) return { time, price };
    }
    return { time: bar.time, price: snap };
  }

  function isLocked(drawing: Drawing) {
    return Boolean(drawing.locked) || lockAll;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const point = read(event);
    if (!point) return;
    if (isClosedShape(toolRef.current as Drawing["kind"])) {
      shapeDrag.current = point;
      draftRef.current = [point];
      previewRef.current = point;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* The pointer already ended. */ }
      project();
      return;
    }
    if (toolRef.current === "range") {
      measureDrag.current = measureGestureDown(point);
      draftRef.current = [point];
      previewRef.current = point;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* The pointer already ended. */ }
      project();
      return;
    }
    if (toolRef.current === "brush" || toolRef.current === "highlighter") {
      brushing.current = [point];
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (toolRef.current === "zoom") {
      brushing.current = [point];
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const point = read(event);
    if (shapeDrag.current && point) {
      draftRef.current = [shapeDrag.current];
      previewRef.current = point;
      project();
      return;
    }
    if (measureDrag.current) {
      if (!point) return;
      measureDrag.current = measureGestureMove(measureDrag.current, point);
      draftRef.current = [measureDrag.current.start];
      previewRef.current = point;
      project();
      return;
    }
    if (!point) return;
    if (brushing.current && (toolRef.current === "brush" || toolRef.current === "highlighter")) {
      const last = brushing.current[brushing.current.length - 1];
      if (Math.abs(point.price - last.price) > 0 || point.time !== last.time) brushing.current.push(point);
      draftRef.current = brushing.current;
      previewRef.current = null;
      project();
      return;
    }
    previewRef.current = point;
    if (draftRef.current.length) project();
  }

  function finishMeasure(point: Point | null) {
    const drag = measureDrag.current;
    if (!drag) return false;
    measureDrag.current = null;
    const finished = measureGestureFinish(point ? measureGestureMove(drag, point) : drag);
    draftRef.current = [];
    previewRef.current = null;
    if (finished) commit(finished, "range");
    else project();
    return true;
  }

  function onPointerCancel() {
    if (shapeDrag.current) {
      shapeDrag.current = null;
      draftRef.current = [];
      previewRef.current = null;
      project();
      return;
    }
    if (!measureDrag.current) return;
    measureDrag.current = null;
    draftRef.current = [];
    previewRef.current = null;
    project();
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (grabbed.current) {
      grabbed.current = false;
      return;
    }
    const point = read(event);
    if (shapeDrag.current) {
      const start = shapeDrag.current;
      shapeDrag.current = null;
      const box = point ? dragBox(start, point) : null;
      draftRef.current = [];
      previewRef.current = null;
      if (box) commit(box, toolRef.current as Drawing["kind"]);
      else project();
      return;
    }
    if (finishMeasure(point)) return;
    const active = toolRef.current;
    if ((active === "brush" || active === "highlighter") && brushing.current && brushing.current.length > 1) {
      commit(brushing.current, active);
      return;
    }
    if (active === "zoom" && brushing.current && point && chartRef.current) {
      const from = Math.min(brushing.current[0].time, point.time);
      const to = Math.max(brushing.current[0].time, point.time);
      if (to > from) chartRef.current.timeScale().setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp });
      brushing.current = null;
      if (!stayRef.current) onToolRef.current("cursor");
      return;
    }
    brushing.current = null;
    if (!point) return;
    const needed = pointsNeeded(active);
    if (needed === 1) commit([point], active as Drawing["kind"]);
    else if (needed >= 2 && Number.isFinite(needed)) {
      draftRef.current = [...draftRef.current, point];
      if (draftRef.current.length >= needed) commit(draftRef.current.slice(0, needed), active as Drawing["kind"]);
    } else if (active === "path" || active === "polyline") {
      draftRef.current = [...draftRef.current, point];
    }
    previewRef.current = point;
    project();
  }

  function openInline(markId: string, drawingId: string) {
    const mark = marks.find((item) => item.id === markId);
    const target = drawingsRef.current.find((item) => item.id === drawingId);
    if (!mark || mark.kind !== "text" || !target || isLocked(target)) return;
    inlineCancelled.current = false;
    setInline({ id: drawingId, x: mark.x, y: mark.y, angle: mark.angle ?? 0 });
  }

  function saveInline(value: string) {
    const id = inline?.id;
    setInline(null);
    // Escape removes the box; a blur fired while it unmounts must not save.
    if (!id || inlineCancelled.current) return;
    const text = value.replace(/\s+/g, " ").trim();
    onDrawingsRef.current(drawingsRef.current.map((drawing) => drawing.id === id && drawing.text !== text
      ? { ...drawing, text, textStyle: drawing.textStyle ?? defaultTextStyle(drawing.color), updatedAt: Date.now() }
      : drawing), true);
  }

  function startDrag(id: string, event: ReactPointerEvent) {
    if (id.endsWith("-addtext") && toolRef.current === "cursor") {
      event.stopPropagation();
      event.preventDefault();
      pickedAt.current = event.timeStamp;
      openInline(id, id.slice(0, -"-addtext".length));
      return;
    }
    const hash = id.lastIndexOf("#");
    const suffix = hash >= 0 ? id.slice(hash + 1) : "";
    const pointIndex = suffix === "" ? undefined : Number(suffix);
    const lookup = hash >= 0 ? id.slice(0, hash) : id;
    const drawing = drawingsRef.current.find((item) => item.id === lookup || lookup.startsWith(`${item.id}-`) || lookup.startsWith(`${item.id}#`));
    const realId = drawing?.id;
    if (!realId || !drawing) return;
    const drawingTool = toolRef.current !== "cursor" && toolRef.current !== "eraser";
    // Mid-drawing (second click of a trend line, a path, a brush stroke): the press belongs to the new drawing.
    if (drawingTool && (draftRef.current.length > 0 || shapeDrag.current || brushing.current || measureDrag.current)) return;
    // Lines that span the whole chart (horizontal, vertical, fib levels) would block most of it: with a tool
    // active only their handles grab; anywhere else on them starts the new drawing.
    if (drawingTool && FULL_SPAN_KINDS.has(drawing.kind) && hash < 0) return;
    event.stopPropagation();
    event.preventDefault();
    pickedAt.current = event.timeStamp;
    if (drawingTool) {
      // Pressing an existing drawing with a tool active selects and moves it instead of starting a new one.
      grabbed.current = true;
      window.addEventListener("pointerup", () => { window.setTimeout(() => { grabbed.current = false; }, 0); }, { once: true });
      toolRef.current = "cursor";
      onToolRef.current("cursor");
    }
    if (toolRef.current === "eraser") {
      if (!isLocked(drawing)) onDrawingsRef.current(drawingsRef.current.filter((item) => item.id !== realId), true);
      setEraseHover(null);
      return;
    }
    setSelected(realId);
    onSelectRef.current?.(realId);
    if (isLocked(drawing) || toolRef.current !== "cursor") return;
    const positionHandle = (drawing.kind === "long" || drawing.kind === "short") && isPositionHandle(suffix) ? suffix : null;
    // The channel's third handle is drawn on the parallel line, not at its stored point, so it moves by offset.
    const offsetHandle = drawing.kind === "channel" && pointIndex === 2;
    const anchorEdit = isBoxHandle(suffix) || Number.isFinite(pointIndex) || positionHandle != null;
    const origin = read(event, anchorEdit);
    if (!origin) return;
    const snapshot = drawing.points.map((point) => ({ ...point }));
    let saved = false;
    const move = (ev: PointerEvent) => {
      const now = read(ev, anchorEdit);
      if (!now) return;
      const base = { ...drawing, points: snapshot };
      const shifted = positionHandle
        ? editPosition(base, positionHandle, now)
        : isBoxHandle(suffix) && (drawing.kind === "rect" || drawing.kind === "ellipse")
          ? resizeBox(base, suffix, now)
          : Number.isFinite(pointIndex) && !offsetHandle
            ? setAnchor(base, pointIndex as number, now)
            : shiftDrawing(base, now.time - origin.time, now.price - origin.price, Number.isFinite(pointIndex) ? pointIndex : undefined);
      onDrawingsRef.current(drawingsRef.current.map((item) => item.id === realId ? shifted : item), !saved);
      saved = true;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  useEffect(() => {
    const host = hostRef.current;
    const parent = host?.parentElement;
    const chartNode = host?.previousElementSibling;
    if (!parent || !chartNode) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.isTrusted) return;
      if (measureDrag.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const chart = chartRef.current;
      const series = seriesRef.current;
      if (!chart || !series) return;
      const rect = chartNode.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const scaleWidth = series.priceScale().width();
      if (event.deltaY !== 0 && overRightPriceScale(x, rect.width, scaleWidth)) {
        event.preventDefault();
        event.stopPropagation();
        const scale = series.priceScale();
        const range = scale.getVisibleRange();
        if (!range) return;
        scale.setAutoScale(false);
        scale.setVisibleRange(zoomPriceRange(range.from, range.to, event.deltaY, event.deltaMode));
        projectRef.current();
        return;
      }
      if (toolRef.current === "cursor") return;
      event.preventDefault();
      chartNode.dispatchEvent(new WheelEvent("wheel", {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        bubbles: true,
        cancelable: true,
      }));
    };
    parent.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => parent.removeEventListener("wheel", onWheel, { capture: true });
  }, [ready]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-drawing-menu]")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setHostSize({ width: box.width, height: box.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (tool === "range" || !measureDrag.current) return;
    measureDrag.current = null;
    draftRef.current = [];
    previewRef.current = null;
    projectRef.current();
  }, [tool]);

  function drawingFromMark(markId: string) {
    return drawingsRef.current.find((item) => item.id === markId || markId.startsWith(`${item.id}-`) || markId.startsWith(`${item.id}#`)) ?? null;
  }

  function openMenu(event: { preventDefault: () => void; clientX: number; clientY: number; currentTarget: EventTarget | null }) {
    if (toolRef.current !== "cursor") return;
    const node = event.currentTarget as Element | null;
    const markId = node?.getAttribute("data-drawing");
    const drawing = markId ? drawingFromMark(markId) : null;
    if (!drawing) return;
    event.preventDefault();
    setSelected(drawing.id);
    onSelectRef.current?.(drawing.id);
    setMenu({ x: event.clientX, y: event.clientY, id: drawing.id });
  }

  const capturing = enabled && tool !== "cursor";
  const interactive = enabled;
  const hitAll = interactive ? "auto" : "none";
  const hitStrokeAll = interactive ? "stroke" : "none";
  const menuDrawing = menu ? drawings.find((item) => item.id === menu.id) : null;
  const selectedDrawing = selected ? drawings.find((item) => item.id === selected) ?? null : null;
  const handles = marks.flatMap((mark) => mark.kind === "handle" ? [mark] : []);
  const editBar = selectedDrawing && tool === "cursor" && handles.length && hostSize.width > 0 ? placeEditBar(handles, hostSize.width) : null;
  const erasing = tool === "eraser" ? eraseHover : null;

  function ownedBy(markId: string, id: string) {
    return markId === id || markId.startsWith(`${id}-`) || markId.startsWith(`${id}#`);
  }

  function hoverMark(markId: string) {
    if (toolRef.current !== "eraser") return;
    const drawing = drawingFromMark(markId);
    setEraseHover(drawing && !isLocked(drawing) ? drawing.id : null);
  }

  function patchSelected(patch: Partial<Drawing>) {
    const id = selectedRef.current;
    const item = drawingsRef.current.find((drawing) => drawing.id === id);
    if (!id || !item || isLocked(item)) return;
    onDrawingsRef.current(drawingsRef.current.map((drawing) => drawing.id === id ? { ...drawing, ...patch, updatedAt: Date.now() } : drawing), true);
  }

  function removeDrawing(id: string) {
    const item = drawingsRef.current.find((drawing) => drawing.id === id);
    if (!item || isLocked(item)) return;
    onDrawingsRef.current(drawingsRef.current.filter((drawing) => drawing.id !== id), true);
    setSelected(null);
    onSelectRef.current?.(null);
  }

  function runAction(id: string, action: EditAction) {
    onDrawingsRef.current(applyListAction(drawingsRef.current, id, action), true);
    if (action === "hide") {
      setSelected(null);
      onSelectRef.current?.(null);
    }
  }

  function bind(markId: string) {
    return {
      "data-drawing": markId,
      onPointerDown: (event: ReactPointerEvent) => startDrag(markId, event),
      onPointerEnter: () => hoverMark(markId),
      onPointerLeave: () => setEraseHover(null),
      onContextMenu: openMenu,
      ...(markId.endsWith("-caption") ? { onDoubleClick: () => openInline(markId, markId.slice(0, -"-caption".length)) } : {}),
    };
  }

  return (
    <div ref={hostRef} className="absolute inset-0 z-10" style={{ pointerEvents: capturing ? "auto" : "none", touchAction: capturing ? "none" : "auto", cursor: tool === "eraser" ? "default" : capturing ? "crosshair" : "default" }} onPointerDown={capturing ? onPointerDown : undefined} onPointerMove={capturing ? onPointerMove : undefined} onPointerUp={capturing ? onPointerUp : undefined} onPointerCancel={capturing ? onPointerCancel : undefined} onDoubleClick={capturing && (tool === "path" || tool === "polyline") ? () => { if (draftRef.current.length >= 2) commit(draftRef.current, tool); } : undefined}>
      <svg className="h-full w-full" style={{ pointerEvents: "none" }}>
        {capturing ? <rect x="0" y="0" width="100%" height="100%" fill="transparent" style={{ pointerEvents: "all" }} /> : null}
        {marks.map((mark) => {
          const doomed = erasing != null && ownedBy(mark.id, erasing);
          const width = mark.selected || doomed ? Math.max(mark.stroke ?? 1.5, 2.2) : (mark.stroke ?? 1.5);
          const dash = mark.pattern === "dashed" ? "6 4" : mark.pattern === "dotted" ? "1.5 3" : undefined;
          const ink = mark.kind === "handle" ? "" : doomed ? "var(--loss)" : mark.color;
          const pointer = tool === "eraser" ? "pointer" : undefined;
          // Strategy overlays never take the pointer, so the chart still pans and zooms through them.
          const passive = mark.id.startsWith(S1_PREFIX);
          const hit = passive ? "none" : hitAll;
          const hitStroke = passive ? "none" : hitStrokeAll;
          if (mark.kind === "hline") {
            return (
              <g key={mark.id} {...bind(mark.id)} style={{ pointerEvents: hit, cursor: pointer }}>
                <line x1="0" x2="100%" y1={mark.y} y2={mark.y} stroke="transparent" strokeWidth={16} style={{ pointerEvents: hitStroke }} />
                <line x1="0" x2="100%" y1={mark.y} y2={mark.y} strokeWidth={width} strokeDasharray={dash} style={{ stroke: ink, pointerEvents: "none" }} />
                <text x="8" y={mark.y - 4} fontSize="11" style={{ fill: ink }}>{mark.label}</text>
              </g>
            );
          }
          if (mark.kind === "vline") {
            return (
              <g key={mark.id} {...bind(mark.id)} style={{ cursor: pointer }}>
                <line x1={mark.x} x2={mark.x} y1="0" y2="100%" stroke="transparent" strokeWidth={16} style={{ pointerEvents: hitStroke }} />
                <line x1={mark.x} x2={mark.x} y1="0" y2="100%" strokeWidth={width} strokeDasharray={dash} style={{ stroke: ink, pointerEvents: "none" }} />
              </g>
            );
          }
          if (mark.kind === "ellipse") {
            return <ellipse key={mark.id} {...bind(mark.id)} cx={mark.cx} cy={mark.cy} rx={mark.rx} ry={mark.ry} strokeWidth={width} strokeDasharray={dash} style={{ fill: mark.fill, stroke: ink, pointerEvents: hit, cursor: pointer }} />;
          }
          if (mark.kind === "handle") {
            return (
              <g key={mark.id} style={{ cursor: handleCursor(mark.id) }} onPointerDown={(event) => startDrag(mark.id, event)}>
                <circle cx={mark.x} cy={mark.y} r="10" fill="transparent" style={{ pointerEvents: "auto" }} />
                <circle cx={mark.x} cy={mark.y} r="4.5" strokeWidth="1.5" style={{ fill: "var(--panel)", stroke: "var(--primary)", pointerEvents: "none" }} />
              </g>
            );
          }
          if (mark.kind === "box") {
            return <rect key={mark.id} {...bind(mark.id)} x={mark.x} y={mark.y} width={mark.width} height={mark.height} strokeWidth={width} strokeDasharray={dash} style={{ fill: mark.fill, stroke: ink, pointerEvents: hit, cursor: pointer }} />;
          }
          if (mark.kind === "card") {
            return (
              <g key={mark.id} {...bind(mark.id)} style={{ pointerEvents: hit, cursor: pointer }}>
                <rect x={mark.x} y={mark.y} width={mark.width} height={mark.height} rx="6" style={{ fill: "var(--elevated)", stroke: ink }} />
                {mark.lines.map((line, index) => <text key={line} x={mark.x + 8} y={mark.y + 16 + index * 14} fontSize="11" style={{ fill: line.startsWith("Direction") || line.startsWith("Price Change") || line.startsWith("Percentage") ? ink : "var(--text)" }}>{line}</text>)}
              </g>
            );
          }
          if (mark.kind === "profile") {
            return <rect key={mark.id} {...bind(mark.id)} x={mark.x} y={mark.y} width={mark.width} height={8} opacity={0.55} style={{ fill: ink, pointerEvents: hit, cursor: pointer }} />;
          }
          if (mark.kind === "segment") {
            return (
              <g key={mark.id} {...bind(mark.id)} style={{ cursor: pointer }}>
                <line x1={mark.x1} y1={mark.y1} x2={mark.x2} y2={mark.y2} stroke="transparent" strokeWidth={16} style={{ pointerEvents: hitStroke }} />
                <line x1={mark.x1} y1={mark.y1} x2={mark.x2} y2={mark.y2} strokeWidth={width} strokeDasharray={dash} style={{ stroke: ink, pointerEvents: "none" }} />
              </g>
            );
          }
          if (mark.kind === "poly") {
            return (
              <g key={mark.id} {...bind(mark.id)} style={{ cursor: pointer }}>
                <path d={mark.d} fill="none" stroke="transparent" strokeWidth={16} style={{ pointerEvents: hitStroke }} />
                <path d={mark.d} fill="none" strokeWidth={width} strokeDasharray={dash} opacity={mark.opacity ?? 1} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: ink, pointerEvents: "none" }} />
              </g>
            );
          }
          if (mark.kind === "dot") {
            return <circle key={mark.id} {...bind(mark.id)} cx={mark.x} cy={mark.y} r={mark.selected ? 6 : 4} style={{ fill: ink, pointerEvents: hit, cursor: pointer }} />;
          }
          return <text key={mark.id} {...bind(mark.id)} x={mark.x} y={mark.y} transform={mark.angle ? `rotate(${mark.angle} ${mark.x} ${mark.y})` : undefined} fontSize={mark.size ?? 12} fontWeight={mark.bold ? 700 : 400} fontStyle={mark.italic ? "italic" : "normal"} textAnchor={mark.anchor ?? "start"} style={{ fill: ink, pointerEvents: hit, cursor: mark.id.endsWith("-addtext") ? "text" : pointer }}>{mark.text}</text>;
        })}
      </svg>
      {selectedDrawing && editBar ? (
        <DrawingEditBar
          key={selectedDrawing.id}
          drawing={selectedDrawing}
          locked={isLocked(selectedDrawing)}
          globalLock={lockAll}
          at={editBar}
          flip={editBar.y > hostSize.height / 2}
          box={shapeBox(handles)}
          onPatch={patchSelected}
          onDelete={() => removeDrawing(selectedDrawing.id)}
          onToggleLock={() => onDrawingsRef.current(drawingsRef.current.map((drawing) => drawing.id === selectedDrawing.id ? { ...drawing, locked: !drawing.locked } : drawing), true)}
          onSettings={() => setEditorOpen(true)}
          onAction={(action) => runAction(selectedDrawing.id, action)}
        />
      ) : null}
      {menu && menuDrawing ? (
        <div data-drawing-menu role="menu" aria-label="Drawing actions" className="surface-overlay fixed z-50 min-w-44 rounded-lg p-1 text-dense" style={{ top: menu.y, left: menu.x, pointerEvents: "auto" }} onPointerDown={(event) => event.stopPropagation()}>
          <ContextItem label="Settings" onClick={() => { setEditorOpen(true); setMenu(null); }} />
          <ContextItem label="Clone" onClick={() => { runAction(menuDrawing.id, "duplicate"); setMenu(null); }} />
          <ContextItem label="Bring forward" onClick={() => { runAction(menuDrawing.id, "forward"); setMenu(null); }} />
          <ContextItem label="Send backward" onClick={() => { runAction(menuDrawing.id, "backward"); setMenu(null); }} />
          <ContextItem label={menuDrawing.locked ? "Unlock" : "Lock"} disabled={lockAll} onClick={() => {
            onDrawingsRef.current(drawingsRef.current.map((item) => item.id === menuDrawing.id ? { ...item, locked: !item.locked } : item), true);
            setMenu(null);
          }} />
          <ContextItem label={menuDrawing.hidden ? "Show" : "Hide"} onClick={() => { runAction(menuDrawing.id, "hide"); setMenu(null); }} />
          <ContextItem label="Remove" danger disabled={isLocked(menuDrawing)} onClick={() => { removeDrawing(menuDrawing.id); setMenu(null); }} />
        </div>
      ) : null}
      {inline ? (
        <input
          key={inline.id}
          autoFocus
          aria-label="Drawing text"
          maxLength={120}
          defaultValue={drawingsRef.current.find((drawing) => drawing.id === inline.id)?.text ?? ""}
          placeholder="Add text"
          className="absolute z-40 h-7 w-44 rounded-md border border-primary bg-overlay px-2 py-0 text-center text-dense text-text shadow-e2"
          style={{ left: inline.x, top: inline.y, transform: `translate(-50%, -70%) rotate(${inline.angle}deg)`, pointerEvents: "auto" }}
          onPointerDown={(event) => event.stopPropagation()}
          onBlur={(event) => saveInline(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); inlineCancelled.current = true; setInline(null); }
          }}
        />
      ) : null}
      {editorOpen && selectedDrawing ? <DrawingProperties drawing={selectedDrawing} onChange={(next) => {
        const item = drawingsRef.current.find((drawing) => drawing.id === next.id);
        if (!item || (isLocked(item) && next.locked === item.locked && next.hidden === item.hidden)) return;
        onDrawingsRef.current(drawingsRef.current.map((drawing) => drawing.id === next.id ? next : drawing), true);
      }} onClose={() => setEditorOpen(false)} /> : null}
    </div>
  );
}

function ContextItem({ label, danger, disabled, onClick }: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} className={`block h-8 w-full rounded-md px-2.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)] disabled:opacity-40 ${danger ? "text-loss" : "text-text"}`} onClick={onClick}>
      {label}
    </button>
  );
}

function handleCursor(id: string) {
  const name = id.slice(id.lastIndexOf("#") + 1);
  if (name === "n" || name === "s" || name === "target" || name === "stop") return "ns-resize";
  if (name === "right") return "ew-resize";
  if (name === "e" || name === "w") return "ew-resize";
  if (name === "ne" || name === "sw") return "nesw-resize";
  if (name === "nw" || name === "se") return "nwse-resize";
  return "move";
}

/** The selected drawing's outline, from its handles, in chart-area pixels. */
function shapeBox(handles: Array<{ x: number; y: number }>) {
  if (!handles.length) return null;
  const xs = handles.map((handle) => handle.x);
  const ys = handles.map((handle) => handle.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function placeEditBar(handles: Array<{ x: number; y: number }>, hostWidth: number) {
  const xs = handles.map((handle) => handle.x);
  const ys = handles.map((handle) => handle.y);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const top = Math.min(...ys);
  const limit = Math.max(184, hostWidth - 184);
  return { x: Math.min(Math.max(184, mid), limit), y: top < 52 ? top + 18 : top - 48 };
}

function isMarkArrow(kind: Drawing["kind"]) {
  return kind === "arrowmark" || kind === "arrowup" || kind === "arrowdown" || kind === "arrowleft" || kind === "arrowright";
}

function pushMarkArrow(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null, selected: boolean) {
  const at = xy(drawing.points[0]);
  if (!at) return;
  const vector = drawing.kind === "arrowdown" ? [0, 22] : drawing.kind === "arrowleft" ? [-22, 0] : drawing.kind === "arrowright" ? [22, 0] : drawing.kind === "arrowmark" ? [16, -16] : [0, -22];
  const end = { x: at.x + vector[0], y: at.y + vector[1] };
  marks.push({ id: drawing.id, kind: "segment", x1: at.x, y1: at.y, x2: end.x, y2: end.y, color: drawing.color, selected });
  const angle = Math.atan2(end.y - at.y, end.x - at.x);
  const size = 9;
  const a = { x: end.x - size * Math.cos(angle - 0.45), y: end.y - size * Math.sin(angle - 0.45) };
  const b = { x: end.x - size * Math.cos(angle + 0.45), y: end.y - size * Math.sin(angle + 0.45) };
  marks.push({ id: `${drawing.id}-head`, kind: "poly", d: `M${a.x},${a.y} L${end.x},${end.y} L${b.x},${b.y}`, color: drawing.color, selected });
}

function pushCircle(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null, selected: boolean) {
  const center = xy(drawing.points[0]);
  const edge = xy(drawing.points[1]);
  if (!center || !edge) return;
  const radius = Math.max(4, Math.hypot(edge.x - center.x, edge.y - center.y));
  const fill = drawing.fillVisible === false ? "transparent" : tint(drawing.fill || drawing.color, drawing.fillOpacity ?? 0.13);
  marks.push({ id: drawing.id, kind: "ellipse", cx: center.x, cy: center.y, rx: radius, ry: radius, color: drawing.color, fill, selected });
}

function pushRotatedRect(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null, selected: boolean) {
  const a = xy(drawing.points[0]);
  const b = xy(drawing.points[1]);
  if (!a || !b) return;
  const c = drawing.points[2] ? xy(drawing.points[2]) : null;
  if (!c) {
    marks.push({ id: drawing.id, kind: "segment", x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: drawing.color, selected });
    return;
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const height = (c.x - a.x) * nx + (c.y - a.y) * ny;
  const c1 = { x: b.x + nx * height, y: b.y + ny * height };
  const c2 = { x: a.x + nx * height, y: a.y + ny * height };
  marks.push({ id: drawing.id, kind: "poly", d: `M${a.x},${a.y} L${b.x},${b.y} L${c1.x},${c1.y} L${c2.x},${c2.y} Z`, color: drawing.color, selected });
}

function pushBend(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null, selected: boolean) {
  const points = drawing.points.flatMap((point) => {
    const at = xy(point);
    return at ? [at] : [];
  });
  if (points.length < 2) return;
  let d = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
  if (drawing.kind === "dcurve" && points.length >= 4) d = `M${points[0].x},${points[0].y} C${points[1].x},${points[1].y} ${points[2].x},${points[2].y} ${points[3].x},${points[3].y}`;
  else if (drawing.kind === "arc" && points.length >= 3) {
    const control = { x: 2 * points[1].x - 0.5 * points[0].x - 0.5 * points[2].x, y: 2 * points[1].y - 0.5 * points[0].y - 0.5 * points[2].y };
    d = `M${points[0].x},${points[0].y} Q${control.x},${control.y} ${points[2].x},${points[2].y}`;
  } else if (drawing.kind === "curve" && points.length >= 3) d = `M${points[0].x},${points[0].y} Q${points[1].x},${points[1].y} ${points[2].x},${points[2].y}`;
  marks.push({ id: drawing.id, kind: "poly", d, color: drawing.color, selected });
}

function pushRange(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null, candles: Bar[], selected: boolean, host: HTMLElement | null) {
  const left = xy(drawing.points[0]);
  const right = xy(drawing.points[1]);
  if (!left || !right) return;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const width = Math.max(8, Math.abs(right.x - left.x));
  const height = Math.max(8, Math.abs(right.y - left.y));
  const stats = measureStats(drawing.points[0], drawing.points[1], barsBetween(drawing.points[0].time, drawing.points[1].time, barStep(candles), candles.map((candle) => candle.time)));
  const tone = measureTone(stats.up);
  const lines = measureLines(stats);
  const bounds = { width: host?.clientWidth || 0, height: host?.clientHeight || 0 };
  const card = placeMeasureCard(
    { x, y, width, height },
    { width: Math.max(168, ...lines.map((line) => line.length * 6.5 + 16)), height: lines.length * 14 + 12 },
    bounds.width > 0 && bounds.height > 0 ? bounds : { width: 10_000, height: 10_000 },
  );
  marks.push({ id: drawing.id, kind: "box", x, y, width, height, fill: tint(tone, 0.2), color: tone, selected });
  marks.push({ id: `${drawing.id}-start`, kind: "dot", x: left.x, y: left.y, color: tone, selected });
  marks.push({ id: `${drawing.id}-end`, kind: "dot", x: right.x, y: right.y, color: tone, selected });
  marks.push({ id: `${drawing.id}-card`, kind: "card", x: card.x, y: card.y, width: card.width, height: card.height, lines, color: tone, selected });
}

/** Where the ray from a through b leaves the chart area (at least b itself). */
function toEdge(a: { x: number; y: number }, b: { x: number; y: number }, width: number, height: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!dx && !dy) return b;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (width - a.x) / dx);
  else if (dx < 0) t = Math.min(t, -a.x / dx);
  if (dy > 0) t = Math.min(t, (height - a.y) / dy);
  else if (dy < 0) t = Math.min(t, -a.y / dy);
  if (!Number.isFinite(t) || t < 1) t = 1;
  return { x: a.x + dx * t, y: a.y + dy * t };
}

function farPoint(from: Point, to: Point, times: number): Point {
  return { time: to.time + (to.time - from.time) * times, price: to.price + (to.price - from.price) * times };
}

function formatSpan(seconds: number) {
  const abs = Math.abs(seconds);
  if (abs >= 86400) return `${Math.round(abs / 86400)}d`;
  if (abs >= 3600) return `${Math.round(abs / 3600)}h`;
  if (abs >= 60) return `${Math.round(abs / 60)}m`;
  return `${Math.round(abs)}s`;
}

function pushCenterLine(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null) {
  const style = drawing.center ?? RECTANGLE_CENTER;
  if (!style.visible) return;
  const segment = centerSegment(drawing.points);
  if (!segment) return;
  const left = xy(segment[0]);
  const right = xy(segment[1]);
  if (!left || !right) return;
  marks.push({ id: `${drawing.id}-center`, kind: "segment", x1: left.x, y1: left.y, x2: right.x, y2: right.y, color: style.color, selected: false, stroke: style.width, pattern: style.dash });
}

function pushClosed(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null, selected: boolean) {
  const left = xy(drawing.points[0]);
  const right = xy(drawing.points[1]);
  if (!left || !right) return;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const width = Math.max(2, Math.abs(right.x - left.x));
  const height = Math.max(2, Math.abs(right.y - left.y));
  const stroke = drawing.borderVisible === false ? "transparent" : tint(drawing.color, drawing.borderOpacity ?? 1);
  const fill = drawing.fillVisible === false ? "transparent" : tint(drawing.fill || drawing.color, drawing.fillOpacity ?? 0.13);
  if (drawing.kind === "ellipse") {
    marks.push({ id: drawing.id, kind: "ellipse", cx: x + width / 2, cy: y + height / 2, rx: width / 2, ry: height / 2, color: stroke, fill, selected });
    pushShapeText(marks, drawing, x, y, width, height);
    return;
  }
  marks.push({ id: drawing.id, kind: "box", x, y, width, height, fill, color: stroke, selected });
  pushShapeText(marks, drawing, x, y, width, height);
}

/** Line tools whose caption runs along the line, TradingView style. */
const ALONG_KINDS = new Set<string>(["trend", "ray", "extended", "infoline", "angle", "arrow", "forecast", "projection"]);

/** The middle of a line tool, nudged just above the line, with the line's angle kept upright for reading. */
export function alongLine(drawing: { kind: string; points: Point[] }, xy: XYFn) {
  if (!ALONG_KINDS.has(drawing.kind) || drawing.points.length < 2) return null;
  const a = xy(drawing.points[0]);
  const b = xy(drawing.points[1]);
  if (!a || !b) return null;
  let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle < -90) angle += 180;
  const radians = (angle * Math.PI) / 180;
  const lift = 7;
  return { x: (a.x + b.x) / 2 + Math.sin(radians) * lift, y: (a.y + b.y) / 2 - Math.cos(radians) * lift, angle };
}

/** Kinds that already draw their own text (text tools, and shapes that write inside the box). */
const OWN_TEXT = new Set<string>(["text", "note", "price", "callout", "marker", "rect", "ellipse"]);

/**
 * The text added from the style bar's T button, for every other drawing: above the middle of a
 * two-point line, beside a single anchor, near the left of a horizontal line, at the top of a vertical one.
 */
function pushCaption(marks: Mark[], drawing: Drawing, xy: XYFn, series: ISeriesApi<SeriesType>, width: number, selected = false) {
  if (drawing.id === "preview" || OWN_TEXT.has(drawing.kind) || !drawing.points[0]) return;
  const label = drawing.text?.replace(/\s+/g, " ").trim();
  const style = drawing.textStyle ?? defaultTextStyle(drawing.color);
  if (label && style.visible === false) return;
  // Selected and still without text: TradingView's faint "+ Add text" hint, clickable.
  if (!label && !selected) return;
  const along = alongLine(drawing, xy);
  if (along) {
    marks.push(label
      ? { id: `${drawing.id}-caption`, kind: "text", x: along.x, y: along.y, angle: along.angle, text: label, color: style.color, selected: false, size: style.size, bold: style.bold, italic: style.italic, anchor: "middle" }
      : { id: `${drawing.id}-addtext`, kind: "text", x: along.x, y: along.y, angle: along.angle, text: "+ Add text", color: "color-mix(in srgb, var(--primary) 70%, transparent)", selected: false, size: 12, italic: true, anchor: "middle" });
    return;
  }
  if (!label) return;
  const first = drawing.points[0];
  let x: number;
  let y: number;
  let anchor: "start" | "middle" | "end" = "middle";
  if (drawing.kind === "hline" || drawing.kind === "hray") {
    const lineY = series.priceToCoordinate(first.price);
    if (lineY == null) return;
    const start = drawing.kind === "hray" ? xy(first)?.x : null;
    x = start != null ? start + 8 : Math.max(48, width * 0.12);
    y = lineY - 6;
    anchor = "start";
  } else if (drawing.kind === "vline") {
    const at = xy(first);
    if (!at) return;
    x = at.x + 6;
    y = 18;
    anchor = "start";
  } else {
    const a = xy(first);
    const b = drawing.points[1] ? xy(drawing.points[1]) : null;
    if (!a) return;
    if (b) {
      x = (a.x + b.x) / 2;
      y = Math.min(a.y, b.y) === Math.max(a.y, b.y) ? a.y - 8 : (a.y + b.y) / 2 - 8;
    } else {
      x = a.x + 8;
      y = a.y - 8;
      anchor = "start";
    }
  }
  marks.push({ id: `${drawing.id}-caption`, kind: "text", x, y, text: label, color: style.color, selected: false, size: style.size, bold: style.bold, italic: style.italic, anchor });
}

function pushShapeText(marks: Mark[], drawing: Drawing, x: number, y: number, width: number, height: number) {
  const style = drawing.textStyle ?? (drawing.text ? defaultTextStyle() : null);
  if (!drawing.text || !style || style.visible === false) return;
  const textX = style.align === "left" ? x + 6 : style.align === "right" ? x + width - 6 : x + width / 2;
  const textY = style.valign === "top" ? y + style.size : style.valign === "bottom" ? y + height - 6 : y + height / 2;
  marks.push({ id: `${drawing.id}-label`, kind: "text", x: textX, y: textY, text: drawing.text, color: style.color, selected: false, size: style.size, bold: style.bold, italic: style.italic, anchor: style.align === "left" ? "start" : style.align === "right" ? "end" : "middle" });
}

function pushBoxHandles(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null) {
  const [first, second] = drawing.points;
  const topLeft = xy({ time: Math.min(first.time, second.time), price: Math.max(first.price, second.price) });
  const bottomRight = xy({ time: Math.max(first.time, second.time), price: Math.min(first.price, second.price) });
  if (!topLeft || !bottomRight) return;
  const midX = (topLeft.x + bottomRight.x) / 2;
  const midY = (topLeft.y + bottomRight.y) / 2;
  const spots = {
    nw: topLeft,
    n: { x: midX, y: topLeft.y },
    ne: { x: bottomRight.x, y: topLeft.y },
    e: { x: bottomRight.x, y: midY },
    se: bottomRight,
    s: { x: midX, y: bottomRight.y },
    sw: { x: topLeft.x, y: bottomRight.y },
    w: { x: topLeft.x, y: midY },
  };
  for (const [name, at] of Object.entries(spots)) marks.push({ id: `${drawing.id}#${name}`, kind: "handle", x: at.x, y: at.y, selected: true });
}

function pushArrowHead(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null) {
  const left = xy(drawing.points[0]);
  const right = xy(drawing.points[1]);
  if (!left || !right) return;
  const angle = Math.atan2(right.y - left.y, right.x - left.x);
  const size = 12;
  const a = { x: right.x - size * Math.cos(angle - 0.45), y: right.y - size * Math.sin(angle - 0.45) };
  const b = { x: right.x - size * Math.cos(angle + 0.45), y: right.y - size * Math.sin(angle + 0.45) };
  marks.push({ id: `${drawing.id}-head`, kind: "poly", d: `M${a.x},${a.y} L${right.x},${right.y} L${b.x},${b.y}`, color: drawing.color, selected: false });
}

function pushSegment(marks: Mark[], id: string, a: Point, b: Point, color: string, selected: boolean, xy: XYFn, dash = false) {
  const left = xy(a);
  const right = xy(b);
  if (left && right) marks.push({ id, kind: "segment", x1: left.x, y1: left.y, x2: right.x, y2: right.y, color, selected, dash });
}

function pushPoly(marks: Mark[], id: string, points: Point[], color: string, selected: boolean, xy: (point: Point) => { x: number; y: number } | null, opacity = 1) {
  const d = points.flatMap((point, index) => {
    const at = xy(point);
    return at ? [`${index === 0 ? "M" : "L"}${at.x},${at.y}`] : [];
  }).join(" ");
  if (d) marks.push({ id, kind: "poly", d, color, selected, opacity });
}

function pushPosition(marks: Mark[], drawing: Drawing, xy: (point: Point) => { x: number; y: number } | null, series: ISeriesApi<SeriesType>, height: number) {
  const geometry = positionGeometry(drawing);
  if (!geometry) return;
  const left = xy({ time: geometry.left, price: geometry.entry });
  const right = xy({ time: geometry.right, price: geometry.entry });
  const targetY = series.priceToCoordinate(geometry.target);
  const stopY = series.priceToCoordinate(geometry.stop);
  const entryY = series.priceToCoordinate(geometry.entry);
  if (!left || !right || targetY == null || stopY == null || entryY == null) return;
  const kind = drawing.kind === "short" ? "short" : "long";
  const x = Math.min(left.x, right.x);
  const width = Math.max(24, Math.abs(right.x - left.x));
  // The profit zone carries the drawing's id so a press on it selects / moves the whole drawing.
  marks.push(box(drawing.id, x, entryY, targetY, width, "var(--profit)", false));
  marks.push(box(`${drawing.id}-risk`, x, entryY, stopY, width, "var(--loss)", false));
  marks.push({ id: `${drawing.id}-entry`, kind: "segment", x1: x, y1: entryY, x2: x + width, y2: entryY, color: "var(--text-2)", selected: false, stroke: 1 });
  const stats = positionMetrics(kind, geometry);
  const fit = (y: number) => Math.min(Math.max(y, 14), Math.max(14, height - 6));
  const price = (value: number) => value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const above = (y: number) => fit(y - 6);
  const below = (y: number) => fit(y + 15);
  const targetOutside = kind === "long" ? above(targetY) : below(targetY);
  const stopOutside = kind === "long" ? below(stopY) : above(stopY);
  marks.push({ id: `${drawing.id}-target`, kind: "text", x: x + 6, y: targetOutside, text: `Target ${price(geometry.target)} · ${stats.reward >= 0 ? "+" : "−"}${price(Math.abs(stats.reward))} (${stats.rewardPercent.toFixed(2)}%)`, color: "var(--profit)", selected: false, size: 11 });
  marks.push({ id: `${drawing.id}-stop`, kind: "text", x: x + 6, y: stopOutside, text: `Stop ${price(geometry.stop)} · ${stats.risk >= 0 ? "−" : "+"}${price(Math.abs(stats.risk))} (${stats.riskPercent.toFixed(2)}%)`, color: "var(--loss)", selected: false, size: 11 });
  marks.push({ id: `${drawing.id}-ratio`, kind: "text", x: x + 6, y: fit(entryY - 4), text: `${kind === "long" ? "Long" : "Short"} · entry ${price(geometry.entry)} · R:R ${stats.ratio == null ? "—" : stats.ratio.toFixed(2)}`, color: "var(--text)", selected: false, size: 11 });
}

function box(id: string, x: number, y1: number, y2: number, width: number, color: string, selected: boolean): Mark {
  const y = Math.min(y1, y2);
  return { id, kind: "box", x, y, width, height: Math.max(2, Math.abs(y2 - y1)), fill: tint(color, 0.2), color, selected };
}

function pushProfile(marks: Mark[], drawing: Drawing, candles: Bar[], xy: (point: Point) => { x: number; y: number } | null) {
  const from = Math.min(drawing.points[0].time, drawing.points[1].time);
  const to = Math.max(drawing.points[0].time, drawing.points[1].time);
  const slice = candles.filter((candle) => candle.time >= from && candle.time <= to);
  if (!slice.length) return;
  const low = Math.min(...slice.map((candle) => candle.low));
  const high = Math.max(...slice.map((candle) => candle.high));
  const bins = 16;
  const step = (high - low) / bins || 1;
  const volumes = Array.from({ length: bins }, () => 0);
  for (const candle of slice) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor((candle.close - low) / step)));
    volumes[index] += candle.volume || 1;
  }
  const peak = Math.max(...volumes, 1);
  const origin = xy({ time: to, price: low });
  if (!origin) return;
  volumes.forEach((volume, index) => {
    const price = low + (index + 0.5) * step;
    const at = xy({ time: to, price });
    if (!at) return;
    marks.push({ id: `${drawing.id}-${index}`, kind: "profile", x: at.x, y: at.y - 4, width: Math.max(2, (volume / peak) * 96), color: drawing.color, selected: false });
  });
}

function barStep(candles: Bar[]) {
  if (candles.length < 2) return 86_400;
  return Math.max(60, candles[candles.length - 1].time - candles[candles.length - 2].time);
}

function patternLine(candles: Bar[], from: number, to: number, ghost: boolean): Point[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const slice = candles.filter((candle) => candle.time >= start && candle.time <= end);
  if (slice.length < 2) return [];
  const step = barStep(candles);
  const origin = ghost ? end + slice.length * step : end;
  return slice.map((candle, index) => ({ time: origin + index * step, price: candle.close }));
}

function anchoredVwap(candles: Bar[], anchor: number): Point[] {
  let priceVolume = 0;
  let volume = 0;
  const line: Point[] = [];
  for (const candle of candles) {
    if (candle.time < anchor) continue;
    const typical = (candle.high + candle.low + candle.close) / 3;
    const size = candle.volume || 1;
    priceVolume += typical * size;
    volume += size;
    line.push({ time: candle.time, price: priceVolume / volume });
  }
  return line;
}

type XYFn = (point: Point) => { x: number; y: number } | null;

function tint(color: string, opacity: number) {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return hexAlpha(color, opacity);
  if (opacity >= 1) return color;
  return `color-mix(in srgb, ${color} ${Math.round(Math.max(0, opacity) * 100)}%, transparent)`;
}

function signed(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function arrowHeadMark(id: string, from: { x: number; y: number }, to: { x: number; y: number }, color: string): Mark {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 8;
  const a = { x: to.x - size * Math.cos(angle - 0.45), y: to.y - size * Math.sin(angle - 0.45) };
  const b = { x: to.x - size * Math.cos(angle + 0.45), y: to.y - size * Math.sin(angle + 0.45) };
  return { id, kind: "poly", d: `M${a.x},${a.y} L${to.x},${to.y} L${b.x},${b.y}`, color, selected: false, pattern: "solid" };
}

function pushSpan(marks: Mark[], drawing: Drawing, xy: XYFn, candles: Bar[], selected: boolean) {
  const left = xy(drawing.points[0]);
  const right = xy(drawing.points[1]);
  if (!left || !right) return;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const width = Math.max(4, Math.abs(right.x - left.x));
  const height = Math.max(4, Math.abs(right.y - left.y));
  const midY = y + height / 2;
  const midX = x + width / 2;
  const forward = right.x >= left.x;
  const bars = barsBetween(drawing.points[0].time, drawing.points[1].time, barStep(candles), candles.map((candle) => candle.time));
  const seconds = Math.abs(drawing.points[1].time - drawing.points[0].time);
  marks.push({ id: drawing.id, kind: "box", x, y, width, height, fill: tint(drawing.color, 0.12), color: tint(drawing.color, 0.5), selected });
  marks.push({ id: `${drawing.id}-h`, kind: "segment", x1: x, y1: midY, x2: x + width, y2: midY, color: drawing.color, selected });
  marks.push(arrowHeadMark(`${drawing.id}-hh`, forward ? { x, y: midY } : { x: x + width, y: midY }, forward ? { x: x + width, y: midY } : { x, y: midY }, drawing.color));
  const lines = [`${bars} bars, ${formatSpan(seconds)}`];
  if (drawing.kind === "dprange") {
    const up = right.y <= left.y;
    marks.push({ id: `${drawing.id}-v`, kind: "segment", x1: midX, y1: y, x2: midX, y2: y + height, color: drawing.color, selected });
    marks.push(arrowHeadMark(`${drawing.id}-vh`, up ? { x: midX, y: y + height } : { x: midX, y }, up ? { x: midX, y } : { x: midX, y: y + height }, drawing.color));
    const change = drawing.points[1].price - drawing.points[0].price;
    const percent = drawing.points[0].price ? (change / drawing.points[0].price) * 100 : 0;
    lines.unshift(`${signed(change)} (${signed(percent)}%)`);
  }
  lines.forEach((line, index) => marks.push({ id: `${drawing.id}-t${index}`, kind: "text", x: midX, y: y + height + 14 + index * 14, text: line, color: drawing.color, selected, anchor: "middle", size: 11 }));
}

function pushRegression(marks: Mark[], drawing: Drawing, xy: XYFn, candles: Bar[], selected: boolean) {
  const from = Math.min(drawing.points[0].time, drawing.points[1].time);
  const to = Math.max(drawing.points[0].time, drawing.points[1].time);
  const fit = regressionLine(candles.filter((candle) => candle.time >= from && candle.time <= to).map((candle) => ({ time: candle.time, price: candle.close })));
  if (!fit) {
    pushSegment(marks, drawing.id, drawing.points[0], drawing.points[1], drawing.color, selected, xy, true);
    return;
  }
  const band = fit.deviation * 2;
  pushSegment(marks, drawing.id, { time: from, price: fit.at(from) }, { time: to, price: fit.at(to) }, drawing.color, selected, xy);
  pushSegment(marks, `${drawing.id}-up`, { time: from, price: fit.at(from) + band }, { time: to, price: fit.at(to) + band }, drawing.color, selected, xy, true);
  pushSegment(marks, `${drawing.id}-dn`, { time: from, price: fit.at(from) - band }, { time: to, price: fit.at(to) - band }, drawing.color, selected, xy, true);
}

function pushPitchfork(marks: Mark[], drawing: Drawing, kind: "pitchfork" | "schiff" | "modschiff", xy: XYFn, selected: boolean) {
  const [a, b, c] = drawing.points;
  const origin = pitchforkOrigin(kind, a, b);
  const mid = { time: (b.time + c.time) / 2, price: (b.price + c.price) / 2 };
  const dt = (mid.time - origin.time) * 4;
  const dp = (mid.price - origin.price) * 4;
  const reach = (point: Point) => ({ time: point.time + dt, price: point.price + dp });
  pushSegment(marks, drawing.id, origin, reach(mid), drawing.color, selected, xy);
  pushSegment(marks, `${drawing.id}-b`, b, reach(b), levelColor(drawing, 1), selected, xy);
  pushSegment(marks, `${drawing.id}-c`, c, reach(c), levelColor(drawing, 2), selected, xy);
  pushSegment(marks, `${drawing.id}-bc`, b, c, drawing.color, selected, xy, true);
  if (origin !== a) pushSegment(marks, `${drawing.id}-ao`, a, origin, drawing.color, selected, xy, true);
}

function pushFan(marks: Mark[], drawing: Drawing, rays: Array<{ ratio: number; label: string }>, xy: XYFn, selected: boolean) {
  const [origin, unit] = drawing.points;
  const dt = unit.time - origin.time;
  const dp = unit.price - origin.price;
  rays.forEach((ray, index) => {
    const target = { time: origin.time + dt, price: origin.price + dp * ray.ratio };
    const far = farPoint(origin, target, 3);
    const color = levelColor(drawing, index);
    pushSegment(marks, index === 0 ? drawing.id : `${drawing.id}-r${index}`, origin, far, color, selected, xy);
    const at = xy(target);
    if (at) marks.push({ id: `${drawing.id}-rl${index}`, kind: "text", x: at.x + 4, y: at.y - 3, text: ray.label, color, selected, size: 10 });
  });
}

function pushGann(marks: Mark[], drawing: Drawing, xy: XYFn, selected: boolean) {
  const [first, second] = drawing.points;
  const t0 = Math.min(first.time, second.time);
  const t1 = Math.max(first.time, second.time);
  const p0 = Math.min(first.price, second.price);
  const p1 = Math.max(first.price, second.price);
  const topLeft = xy({ time: t0, price: p1 });
  const bottomRight = xy({ time: t1, price: p0 });
  if (!topLeft || !bottomRight) return;
  marks.push({ id: drawing.id, kind: "box", x: topLeft.x, y: topLeft.y, width: Math.max(2, bottomRight.x - topLeft.x), height: Math.max(2, bottomRight.y - topLeft.y), fill: tint(drawing.color, drawing.fillVisible === false ? 0 : drawing.fillOpacity ?? 0.06), color: drawing.color, selected });
  pushSegment(marks, `${drawing.id}-d1`, { time: t0, price: p0 }, { time: t1, price: p1 }, drawing.color, selected, xy);
  if (drawing.kind === "gannsquare") {
    pushSegment(marks, `${drawing.id}-d2`, { time: t0, price: p1 }, { time: t1, price: p0 }, drawing.color, selected, xy);
    pushSegment(marks, `${drawing.id}-mh`, { time: t0, price: (p0 + p1) / 2 }, { time: t1, price: (p0 + p1) / 2 }, drawing.color, selected, xy, true);
    pushSegment(marks, `${drawing.id}-mv`, { time: (t0 + t1) / 2, price: p0 }, { time: (t0 + t1) / 2, price: p1 }, drawing.color, selected, xy, true);
    return;
  }
  GANN_RATIOS.slice(1, -1).forEach((ratio, offset) => {
    const index = offset + 1;
    const color = levelColor(drawing, index);
    const price = p0 + (p1 - p0) * ratio;
    const time = t0 + (t1 - t0) * ratio;
    pushSegment(marks, `${drawing.id}-gh${index}`, { time: t0, price }, { time: t1, price }, color, selected, xy, true);
    pushSegment(marks, `${drawing.id}-gv${index}`, { time, price: p0 }, { time, price: p1 }, color, selected, xy, true);
    const label = xy({ time: t1, price });
    if (label) marks.push({ id: `${drawing.id}-gl${index}`, kind: "text", x: label.x + 4, y: label.y + 4, text: ratio.toString(), color, selected, size: 10 });
  });
}

const PATTERN_LABELS: Record<"xabcd" | "headshoulders" | "elliott" | "elliottabc", string[]> = {
  xabcd: ["X", "A", "B", "C", "D"],
  headshoulders: ["Left shoulder", "", "Head", "", "Right shoulder"],
  elliott: ["(1)", "(2)", "(3)", "(4)", "(5)"],
  elliottabc: ["(A)", "(B)", "(C)"],
};

function pushPattern(marks: Mark[], drawing: Drawing, xy: XYFn, selected: boolean) {
  const kind = drawing.kind as keyof typeof PATTERN_LABELS;
  const points = drawing.points;
  pushPoly(marks, drawing.id, points, drawing.color, selected, xy);
  const labels = PATTERN_LABELS[kind];
  points.forEach((point, index) => {
    const label = labels[index];
    const at = xy(point);
    if (!label || !at) return;
    const neighbours = [points[index - 1], points[index + 1]].filter((item): item is Point => item != null);
    const high = neighbours.every((item) => point.price >= item.price);
    marks.push({ id: `${drawing.id}-l${index}`, kind: "text", x: at.x, y: high ? at.y - 8 : at.y + 16, text: label, color: drawing.color, selected, anchor: "middle", size: 11, bold: true });
  });
  if (kind === "headshoulders" && points.length >= 4) {
    pushSegment(marks, `${drawing.id}-neck`, farPoint(points[3], points[1], 0.6), farPoint(points[1], points[3], 0.6), drawing.color, selected, xy, true);
  }
  if (kind === "xabcd" && points.length >= 3) {
    const leg = (a: Point, b: Point) => Math.abs(b.price - a.price);
    const ratios: Array<[Point, Point, number, number, string]> = [];
    if (points.length >= 3) ratios.push([points[0], points[2], leg(points[1], points[2]), leg(points[0], points[1]), "ab"]);
    if (points.length >= 4) ratios.push([points[1], points[3], leg(points[2], points[3]), leg(points[1], points[2]), "bc"]);
    if (points.length >= 5) {
      ratios.push([points[2], points[4], leg(points[3], points[4]), leg(points[2], points[3]), "cd"]);
      ratios.push([points[0], points[4], leg(points[1], points[4]), leg(points[0], points[1]), "xd"]);
    }
    for (const [a, b, part, whole, key] of ratios) {
      pushSegment(marks, `${drawing.id}-${key}`, a, b, drawing.color, selected, xy, true);
      const start = xy(a);
      const end = xy(b);
      if (start && end && whole > 0) marks.push({ id: `${drawing.id}-${key}r`, kind: "text", x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 4, text: (part / whole).toFixed(3), color: drawing.color, selected, anchor: "middle", size: 10 });
    }
  }
}

function nextColor(color: string) {
  const index = ["#D4AF37", "#10B981", "#EF4444", "#F0B90B", "#F8FAFC"].indexOf(color);
  return ["#D4AF37", "#10B981", "#EF4444", "#F0B90B", "#F8FAFC"][(index + 1) % 5];
}
