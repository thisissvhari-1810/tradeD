export type Point = { time: number; price: number };
export type LineDash = "solid" | "dashed" | "dotted";

export type DrawTool =
  | "cursor" | "trend" | "ray" | "extended" | "hline" | "hray" | "vline" | "channel" | "angle"
  | "fib" | "fibext" | "fibtime" | "measure"
  | "rect" | "ellipse" | "circle" | "rrect" | "triangle" | "path" | "polyline" | "arc" | "curve" | "dcurve" | "arrow"
  | "arrowmark" | "arrowup" | "arrowdown" | "arrowleft" | "arrowright"
  | "text" | "note" | "price" | "callout" | "marker" | "range"
  | "long" | "short"
  | "forecast" | "bars" | "ghost" | "projection" | "avwap" | "vprofile"
  | "brush" | "highlighter" | "zoom"
  | "crossline" | "infoline" | "regression" | "daterange" | "dprange"
  | "pitchfork" | "schiff" | "modschiff"
  | "fibfan" | "fibchannel" | "gannbox" | "gannsquare" | "gannfan"
  | "xabcd" | "headshoulders" | "elliott" | "elliottabc"
  | "eraser";

export type MagnetMode = "off" | "weak" | "strong";
export type CursorStyle = "cross" | "dot" | "arrow";

export type TextAlign = "left" | "center" | "right";
export type TextValign = "top" | "middle" | "bottom";

export type DrawingTextStyle = {
  size: number;
  bold: boolean;
  italic: boolean;
  color: string;
  align: TextAlign;
  valign: TextValign;
  visible: boolean;
};

export type DrawingVisibility = { mode: "all" | "only" | "hide"; spans: string[] };

export type CenterLineStyle = { color: string; width: number; dash: LineDash; visible: boolean };

export const RECTANGLE_CENTER: CenterLineStyle = { color: "#F23645", width: 1, dash: "dashed", visible: true };

export type Drawing = {
  id: string;
  kind: Exclude<DrawTool, "cursor" | "zoom" | "eraser">;
  points: Point[];
  text?: string;
  name?: string;
  color: string;
  fill?: string;
  fillOpacity?: number;
  borderOpacity?: number;
  borderVisible?: boolean;
  fillVisible?: boolean;
  width?: number;
  dash?: LineDash;
  textStyle?: DrawingTextStyle;
  center?: CenterLineStyle;
  levelColors?: string[];
  /** Fibonacci levels for fib / fibext. Missing means the defaults for the tool. */
  levels?: FibLevel[];
  visibility?: DrawingVisibility;
  locked: boolean;
  hidden?: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export const BOX_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type BoxHandle = (typeof BOX_HANDLES)[number];

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

export type FibLevel = { ratio: number; visible: boolean };

/** The levels a fib / fib extension draws: the user's own set, or the defaults for that tool. */
export function fibLevelSet(drawing: { kind: string; levels?: FibLevel[] }): FibLevel[] {
  if (drawing.levels?.length) return drawing.levels;
  return (drawing.kind === "fibext" ? FIB_EXTENSION_RATIOS : FIB_RATIOS).map((ratio) => ({ ratio, visible: true }));
}

export function normalizeLevels(value: unknown): FibLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .filter((item): item is FibLevel => !!item && typeof item === "object" && typeof (item as FibLevel).ratio === "number" && Number.isFinite((item as FibLevel).ratio))
    .map((item) => ({ ratio: Math.max(-10, Math.min(10, item.ratio)), visible: item.visible !== false }))
    .slice(0, 16);
  return rows.length ? rows : undefined;
}
export const FIB_EXTENSION_RATIOS = [0, 0.618, 1, 1.272, 1.618] as const;
export const FIB_TIME_RATIOS = [0, 1, 2, 3, 5, 8] as const;
export const DRAW_COLORS = ["#D4AF37", "#089981", "#F23645", "#F0B90B", "#F8FAFC"] as const;
export const DRAW_PALETTE = [
  "#FFFFFF", "#D1D4DC", "#9598A1", "#5D606B", "#363A45", "#131722",
  "#F23645", "#FF9800", "#FFEB3B", "#4CAF50", "#089981", "#00BCD4",
  "#2962FF", "#673AB7", "#9C27B0", "#E91E63", "#D4AF37", "#F48FB1",
  "#FCCBCD", "#FFE0B2", "#FFF9C4", "#C8E6C9", "#BBDEFB", "#E1BEE7",
] as const;
export const LINE_WIDTHS = [1, 2, 3, 4, 5] as const;
export const GANN_RATIOS = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1] as const;
export const GANN_FAN = [[1, 8], [1, 4], [1, 3], [1, 2], [1, 1], [2, 1], [3, 1], [4, 1], [8, 1]] as const;
export const FIB_FAN_RATIOS = [0.382, 0.5, 0.618] as const;
export const FIB_CHANNEL_RATIOS = [0, 0.382, 0.618, 1, 1.618] as const;
const STORAGE_VERSION = 1;

export function pointsNeeded(tool: DrawTool) {
  if (tool === "cursor" || tool === "zoom" || tool === "eraser") return 0;
  if (tool === "xabcd" || tool === "headshoulders" || tool === "elliott") return 5;
  if (tool === "fibext" || tool === "channel" || tool === "triangle" || tool === "long" || tool === "short" || tool === "rrect" || tool === "arc" || tool === "curve" || tool === "pitchfork" || tool === "schiff" || tool === "modschiff" || tool === "fibchannel" || tool === "elliottabc") return 3;
  if (tool === "dcurve") return 4;
  if (tool === "path" || tool === "polyline" || tool === "brush" || tool === "highlighter") return Infinity;
  if (tool === "hline" || tool === "hray" || tool === "vline" || tool === "crossline" || tool === "text" || tool === "note" || tool === "price" || tool === "callout" || tool === "marker" || tool === "avwap" || tool === "arrowmark" || tool === "arrowup" || tool === "arrowdown" || tool === "arrowleft" || tool === "arrowright") return 1;
  return 2;
}

/** Kinds whose lines span the whole chart. With a drawing tool active they never steal the press. */
export const FULL_SPAN_KINDS = new Set<string>(["hline", "vline", "crossline", "fib", "fibext", "fibtime"]);

/** Drops consecutive identical anchors (a double-click lands the last vertex twice). */
export function dedupePoints(points: Point[]) {
  return points.filter((point, index) => index === 0 || point.time !== points[index - 1].time || point.price !== points[index - 1].price);
}

/** Long / short: stop on the losing side of entry, target on the winning side, whichever order they were clicked. */
export function positionLevels(kind: "long" | "short", entry: number, a: number, b: number) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return kind === "long" ? { stop: low, target: high } : { stop: high, target: low };
}

/** Trend-based fib extension: levels measured from the third anchor by the first leg. 2-anchor drawings keep the old form. */
export function fibExtensionPrice(points: Point[], ratio: number) {
  if (points.length >= 3) return points[2].price + (points[1].price - points[0].price) * ratio;
  return points[0].price + (points[1].price - points[0].price) * ratio;
}

export function isHexColor(value: string) {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

export function regressionLine(points: Array<{ time: number; price: number }>) {
  const n = points.length;
  if (n < 2) return null;
  const meanT = points.reduce((sum, point) => sum + point.time, 0) / n;
  const meanP = points.reduce((sum, point) => sum + point.price, 0) / n;
  let cov = 0;
  let varT = 0;
  for (const point of points) {
    cov += (point.time - meanT) * (point.price - meanP);
    varT += (point.time - meanT) ** 2;
  }
  const slope = varT ? cov / varT : 0;
  const at = (time: number) => meanP + slope * (time - meanT);
  const deviation = Math.sqrt(points.reduce((sum, point) => sum + (point.price - at(point.time)) ** 2, 0) / n);
  return { at, deviation };
}

export function pitchforkOrigin(kind: "pitchfork" | "schiff" | "modschiff", a: Point, b: Point): Point {
  if (kind === "schiff") return { time: a.time, price: (a.price + b.price) / 2 };
  if (kind === "modschiff") return { time: (a.time + b.time) / 2, price: (a.price + b.price) / 2 };
  return a;
}

export function levelColor(drawing: { color: string; levelColors?: string[] }, index: number) {
  return drawing.levelColors?.[index] || drawing.color;
}

export function fibLevels(start: number, end: number, ratios: readonly number[] = FIB_RATIOS) {
  return ratios.map((ratio) => ({ ratio, price: start + (end - start) * ratio }));
}

export function fibTimes(start: number, end: number) {
  const span = end - start;
  return FIB_TIME_RATIOS.map((ratio) => ({ ratio, time: start + span * ratio }));
}

export function positionStats(entry: number, stop: number, target: number) {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return {
    risk,
    reward,
    ratio: risk ? reward / risk : 0,
    riskPercent: entry ? (risk / entry) * 100 : 0,
    rewardPercent: entry ? (reward / entry) * 100 : 0,
  };
}

export type MeasureStats = {
  start: number;
  end: number;
  change: number;
  percent: number;
  bars: number;
  seconds: number;
  up: boolean;
  direction: "Bullish" | "Bearish" | "Unchanged";
  points: number;
  ticks: number | null;
};

export function measureStats(start: Point, end: Point, bars: number, tick?: number): MeasureStats {
  const change = end.price - start.price;
  const percent = start.price ? ((end.price - start.price) / start.price) * 100 : 0;
  return {
    start: start.price,
    end: end.price,
    change,
    percent,
    bars,
    seconds: Math.abs(end.time - start.time),
    up: change >= 0,
    direction: change > 0 ? "Bullish" : change < 0 ? "Bearish" : "Unchanged",
    points: change,
    ticks: tick && tick > 0 ? change / tick : null,
  };
}

export function barsBetween(startTime: number, endTime: number, step: number, candleTimes: number[] = []) {
  const from = Math.min(startTime, endTime);
  const to = Math.max(startTime, endTime);
  const inside = candleTimes.filter((time) => time >= from && time <= to).length;
  if (!(step > 0)) return Math.max(0, inside - 1);
  if (!candleTimes.length || to < candleTimes[0] || from > candleTimes[candleTimes.length - 1]) {
    return Math.max(0, Math.round((to - from) / step));
  }
  const first = candleTimes[0];
  const last = candleTimes[candleTimes.length - 1];
  let extra = 0;
  if (to > last) extra += Math.max(0, Math.round((to - Math.max(from, last)) / step));
  if (from < first) extra += Math.max(0, Math.round((Math.min(to, first) - from) / step));
  return Math.max(0, inside - 1) + extra;
}

export function formatMeasurePrice(price: number) {
  const negative = price < 0;
  const abs = Math.abs(price);
  const digits = abs >= 1 ? (Math.abs(abs - Math.round(abs)) < 0.001 ? 0 : 2) : abs >= 0.01 ? 4 : 6;
  const [whole, fraction] = abs.toFixed(digits).split(".");
  const grouped = whole.length <= 3 ? whole : `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${whole.slice(-3)}`;
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${body}` : body;
}

export function formatMeasureSpan(seconds: number) {
  const abs = Math.abs(seconds);
  if (abs >= 86_400) {
    const days = Math.floor(abs / 86_400);
    const hours = Math.round((abs % 86_400) / 3600);
    return hours ? `${days}d ${hours}h` : `${days}d`;
  }
  if (abs >= 3600) return `${Math.round(abs / 3600)}h`;
  if (abs >= 60) return `${Math.round(abs / 60)}m`;
  return `${Math.round(abs)}s`;
}

export function measureTone(up: boolean) {
  return up ? "#089981" : "#F23645";
}

export function measureLines(stats: MeasureStats) {
  const points = `${stats.change > 0 ? "+" : stats.change < 0 ? "-" : ""}${formatMeasurePrice(Math.abs(stats.change))} points`;
  const percent = `${stats.percent > 0 ? "+" : stats.percent < 0 ? "-" : ""}${Math.abs(stats.percent).toFixed(2)}%`;
  const lines = [
    `Start Price: ${formatMeasurePrice(stats.start)}`,
    `End Price: ${formatMeasurePrice(stats.end)}`,
    `Price Change: ${points}`,
    `Percentage Change: ${percent}`,
  ];
  if (stats.ticks != null && Number.isFinite(stats.ticks)) lines.push(`Ticks: ${stats.ticks > 0 ? "+" : ""}${Number(stats.ticks.toFixed(2))}`);
  lines.push(`Bars: ${stats.bars}`, `Time: ${formatMeasureSpan(stats.seconds)}`, `Direction: ${stats.direction}`);
  return lines;
}

export type MeasureGesture = { start: Point; end: Point };

export function measureGestureDown(point: Point): MeasureGesture {
  return { start: point, end: point };
}

export function measureGestureMove(gesture: MeasureGesture, point: Point): MeasureGesture {
  return { start: gesture.start, end: point };
}

export function measureGestureFinish(gesture: MeasureGesture | null): [Point, Point] | null {
  if (!gesture) return null;
  if (gesture.start.time === gesture.end.time && gesture.start.price === gesture.end.price) return null;
  return [gesture.start, gesture.end];
}

export function measureAllowsChartWheel(dragging: boolean) {
  return !dragging;
}

export function placeMeasureCard(
  box: { x: number; y: number; width: number; height: number },
  card: { width: number; height: number },
  bounds: { width: number; height: number },
  pad = 8,
) {
  let x = box.x + pad;
  let y = box.y + pad;
  const width = Math.min(card.width, Math.max(40, bounds.width - pad * 2));
  const height = card.height;
  if (y + height > bounds.height - pad) y = box.y - height - pad;
  if (x + width > bounds.width - pad) x = bounds.width - pad - width;
  if (x < pad) x = pad;
  if (y < pad) y = pad;
  if (y + height > bounds.height - pad) y = Math.max(pad, bounds.height - pad - height);
  return { x, y, width, height };
}

export function zoomPriceRange(from: number, to: number, deltaY: number, deltaMode = 0) {
  const speed = deltaMode === 1 ? 32 : deltaMode === 2 ? 120 : 1;
  const delta = (speed * deltaY) / 100;
  const factor = Math.exp(Math.max(-1.2, Math.min(1.2, delta * 0.35)));
  const middle = (from + to) / 2;
  const span = Math.max(Math.abs(to - from) * factor, Math.abs(middle) * 0.0002 || 0.01);
  return { from: middle - span / 2, to: middle + span / 2 };
}

export function overRightPriceScale(x: number, chartWidth: number, scaleWidth: number) {
  return scaleWidth > 0 && x >= chartWidth - scaleWidth;
}

export function screenAngle(dx: number, dy: number) {
  if (!dx && !dy) return 0;
  return Math.atan2(-dy, dx) * (180 / Math.PI);
}

export function shiftDrawing(drawing: Drawing, dt: number, dp: number, pointIndex?: number): Drawing {
  if (drawing.locked) return drawing;
  const move = (point: Point, index: number) => {
    if (pointIndex != null && index !== pointIndex) return point;
    if (drawing.kind === "hline") return { time: point.time, price: point.price + dp };
    if (drawing.kind === "vline") return { time: point.time + dt, price: point.price };
    return { time: point.time + dt, price: point.price + dp };
  };
  return { ...drawing, points: drawing.points.map(move) };
}

export function isBoxHandle(value: string): value is BoxHandle {
  return (BOX_HANDLES as readonly string[]).includes(value);
}

export function isClosedShape(kind: Drawing["kind"]) {
  return kind === "rect" || kind === "ellipse" || kind === "circle";
}

export function dragBox(start: Point, end: Point): [Point, Point] | null {
  if (start.time === end.time && start.price === end.price) return null;
  return [start, end];
}

export function centerPrice(top: number, bottom: number) {
  return (top + bottom) / 2;
}

export function centerSegment(points: Point[]): [Point, Point] | null {
  if (points.length < 2) return null;
  const price = centerPrice(points[0].price, points[1].price);
  return [
    { time: Math.min(points[0].time, points[1].time), price },
    { time: Math.max(points[0].time, points[1].time), price },
  ];
}

export function resizeBox(drawing: Drawing, handle: BoxHandle, point: Point): Drawing {
  if (drawing.locked || drawing.points.length < 2) return drawing;
  const [first, second] = drawing.points;
  let timeStart = Math.min(first.time, second.time);
  let timeEnd = Math.max(first.time, second.time);
  let priceLow = Math.min(first.price, second.price);
  let priceHigh = Math.max(first.price, second.price);
  if (handle === "w" || handle === "nw" || handle === "sw") timeStart = point.time;
  if (handle === "e" || handle === "ne" || handle === "se") timeEnd = point.time;
  if (handle === "s" || handle === "sw" || handle === "se") priceLow = point.price;
  if (handle === "n" || handle === "nw" || handle === "ne") priceHigh = point.price;
  return { ...drawing, points: [{ time: timeStart, price: priceHigh }, { time: timeEnd, price: priceLow }], updatedAt: Date.now() };
}

export function drawingVisible(drawing: Drawing, span: string) {
  if (drawing.hidden) return false;
  const rule = drawing.visibility;
  if (!rule || rule.mode === "all" || rule.spans.length === 0) return true;
  const listed = rule.spans.includes(span);
  return rule.mode === "only" ? listed : !listed;
}

export function duplicateDrawing(drawing: Drawing, id: string): Drawing {
  const shift = Math.abs(drawing.points[0]?.price ?? 1) * 0.002 || 0.01;
  return {
    ...drawing,
    id,
    locked: false,
    name: drawing.name ? `${drawing.name} copy` : undefined,
    points: drawing.points.map((point) => ({ time: point.time, price: point.price + shift })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function moveDrawing(drawings: Drawing[], id: string, direction: "forward" | "backward") {
  const index = drawings.findIndex((drawing) => drawing.id === id);
  if (index < 0) return drawings;
  const target = direction === "forward" ? Math.min(drawings.length - 1, index + 1) : Math.max(0, index - 1);
  if (target === index) return drawings;
  const next = drawings.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function hexAlpha(color: string, opacity: number) {
  const hex = color.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return color;
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, "0");
  return `#${hex}${alpha}`;
}

export function defaultTextStyle(color = "#F8FAFC"): DrawingTextStyle {
  return { size: 12, bold: false, italic: false, color, align: "center", valign: "middle", visible: true };
}

const TEMPLATE_KEY = "td-draw-templates";

export type DrawingTemplate = {
  id: string;
  name: string;
  kind: Drawing["kind"];
  preferred?: boolean;
  color: string;
  fill: string;
  fillOpacity: number;
  width: number;
  dash: LineDash;
  borderVisible: boolean;
  fillVisible: boolean;
  center?: CenterLineStyle;
};

export function loadTemplates(): DrawingTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TEMPLATE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is DrawingTemplate => !!item && typeof item === "object" && typeof (item as DrawingTemplate).kind === "string") : [];
  } catch {
    return [];
  }
}

export function saveTemplates(templates: DrawingTemplate[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TEMPLATE_KEY, JSON.stringify(templates));
}

export function preferredTemplate(kind: Drawing["kind"]) {
  return loadTemplates().find((template) => template.kind === kind && template.preferred) ?? null;
}

export function drawingKey(symbol: string) {
  return `td-draw:${symbol}`;
}

function normalizeTextStyle(value: Drawing["textStyle"]): DrawingTextStyle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const align = value.align === "left" || value.align === "right" || value.align === "center" ? value.align : "center";
  const valign = value.valign === "top" || value.valign === "bottom" || value.valign === "middle" ? value.valign : "middle";
  return {
    size: typeof value.size === "number" ? value.size : 12,
    bold: Boolean(value.bold),
    italic: Boolean(value.italic),
    color: typeof value.color === "string" ? value.color : "#F8FAFC",
    align,
    valign,
    visible: value.visible === false ? false : true,
  };
}

function normalizeCenter(value: Drawing["center"]): CenterLineStyle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const dash = value.dash === "dashed" || value.dash === "dotted" || value.dash === "solid" ? value.dash : "dashed";
  return {
    color: typeof value.color === "string" ? value.color : RECTANGLE_CENTER.color,
    width: typeof value.width === "number" ? value.width : 1,
    dash,
    visible: value.visible === false ? false : true,
  };
}

function normalizeVisibility(value: Drawing["visibility"]): DrawingVisibility | undefined {
  if (!value || typeof value !== "object") return undefined;
  const mode = value.mode === "only" || value.mode === "hide" || value.mode === "all" ? value.mode : "all";
  const spans = Array.isArray(value.spans) ? value.spans.filter((span): span is string => typeof span === "string") : [];
  return { mode, spans };
}

export function normalizeDrawing(value: unknown): Drawing | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<Drawing>;
  if (typeof row.id !== "string" || typeof row.kind !== "string" || !Array.isArray(row.points)) return null;
  const points = row.points.filter((point): point is Point => !!point && typeof point.time === "number" && typeof point.price === "number" && Number.isFinite(point.time) && Number.isFinite(point.price));
  if (!points.length) return null;
  return {
    id: row.id,
    kind: row.kind as Drawing["kind"],
    points,
    text: typeof row.text === "string" ? row.text : undefined,
    name: typeof row.name === "string" ? row.name : undefined,
    color: typeof row.color === "string" ? row.color : "#D4AF37",
    fill: typeof row.fill === "string" ? row.fill : undefined,
    fillOpacity: typeof row.fillOpacity === "number" ? row.fillOpacity : undefined,
    borderOpacity: typeof row.borderOpacity === "number" ? row.borderOpacity : undefined,
    borderVisible: row.borderVisible === false ? false : undefined,
    fillVisible: row.fillVisible === false ? false : undefined,
    width: typeof row.width === "number" ? row.width : 1.5,
    dash: row.dash === "dashed" || row.dash === "dotted" ? row.dash : "solid",
    textStyle: normalizeTextStyle(row.textStyle),
    center: normalizeCenter(row.center),
    levelColors: Array.isArray(row.levelColors) ? row.levelColors.filter((item): item is string => typeof item === "string").slice(0, 16) : undefined,
    levels: normalizeLevels(row.levels),
    visibility: normalizeVisibility(row.visibility),
    locked: Boolean(row.locked),
    hidden: Boolean(row.hidden),
    createdAt: typeof row.createdAt === "number" ? row.createdAt : undefined,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : undefined,
  };
}

export function parseStoredDrawings(raw: string | null): Drawing[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { drawings?: unknown }).drawings) ? (parsed as { drawings: unknown[] }).drawings : [];
    return rows.map(normalizeDrawing).filter((item): item is Drawing => item != null);
  } catch {
    return [];
  }
}

export function loadDrawings(symbol: string): Drawing[] {
  if (typeof window === "undefined") return [];
  return parseStoredDrawings(window.localStorage.getItem(drawingKey(symbol)));
}

export function saveDrawings(symbol: string, drawings: Drawing[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(drawingKey(symbol), JSON.stringify({ v: STORAGE_VERSION, drawings }));
}
