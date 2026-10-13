export type Point = { time: number; price: number };
export type LineDash = "solid" | "dashed" | "dotted";

export type DrawTool =
  | "cursor" | "trend" | "ray" | "extended" | "hline" | "hray" | "vline" | "channel" | "angle"
  | "fib" | "fibext" | "fibtime" | "measure"
  | "rect" | "ellipse" | "triangle" | "path" | "arrow"
  | "text" | "note" | "price" | "callout" | "marker" | "range"
  | "long" | "short"
  | "forecast" | "bars" | "ghost" | "projection" | "avwap" | "vprofile"
  | "brush" | "zoom";

export type Drawing = {
  id: string;
  kind: Exclude<DrawTool, "cursor" | "zoom">;
  points: Point[];
  text?: string;
  color: string;
  width?: number;
  dash?: LineDash;
  locked: boolean;
  hidden?: boolean;
};

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 1] as const;
export const FIB_EXTENSION_RATIOS = [0, 0.618, 1, 1.272, 1.618] as const;
export const FIB_TIME_RATIOS = [0, 1, 2, 3, 5, 8] as const;
export const DRAW_COLORS = ["#D4AF37", "#089981", "#F23645", "#F0B90B", "#F8FAFC"] as const;
const STORAGE_VERSION = 1;

export function pointsNeeded(tool: DrawTool) {
  if (tool === "cursor" || tool === "zoom") return 0;
  if (tool === "channel" || tool === "triangle" || tool === "long" || tool === "short") return 3;
  if (tool === "path" || tool === "brush") return Infinity;
  if (tool === "hline" || tool === "hray" || tool === "vline" || tool === "text" || tool === "note" || tool === "price" || tool === "callout" || tool === "marker" || tool === "avwap") return 1;
  return 2;
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
    if (drawing.kind === "hline" || drawing.kind === "hray") return { time: point.time, price: point.price + dp };
    if (drawing.kind === "vline") return { time: point.time + dt, price: point.price };
    return { time: point.time + dt, price: point.price + dp };
  };
  return { ...drawing, points: drawing.points.map(move) };
}

export function drawingKey(symbol: string) {
  return `td-draw:${symbol}`;
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
    color: typeof row.color === "string" ? row.color : "#D4AF37",
    width: typeof row.width === "number" ? row.width : 1.5,
    dash: row.dash === "dashed" || row.dash === "dotted" ? row.dash : "solid",
    locked: Boolean(row.locked),
    hidden: Boolean(row.hidden),
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
