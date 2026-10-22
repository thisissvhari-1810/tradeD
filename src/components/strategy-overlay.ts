import { shiftDrawing, type Drawing, type DrawingTextStyle } from "@/components/drawing-model";
import type { StrategyBox, StrategyLevel, StrategySettings } from "@/components/strategy-settings";
import { s1Levels, s1Reveal, type S1Data, type S1Levels } from "@/lib/trading/s1";

/** Every strategy drawing id starts with this, so the chart draws them read-only and never saves them. */
export const STRATEGY_PREFIX = "strategy:";

function label(color: string): DrawingTextStyle {
  return { size: 11, bold: true, italic: false, color, align: "left", valign: "top", visible: true };
}

export function price(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Top, bottom, midpoint and height read back from a rectangle drawing's own anchors. */
export function boxOf(drawing: Drawing) {
  const [a, b] = drawing.points;
  const top = Math.max(a.price, b.price);
  const bottom = Math.min(a.price, b.price);
  return { top, bottom, mid: (top + bottom) / 2, height: top - bottom, left: Math.min(a.time, b.time), right: Math.max(a.time, b.time) };
}

export type StrategyTrace = {
  previous: { high: number; low: number; close: number };
  original: ReturnType<typeof boxOf>;
  shiftA: number;
  boxA: ReturnType<typeof boxOf>;
  open: number | null;
  cloneMidBefore: number | null;
  shiftB: number | null;
  boxB: ReturnType<typeof boxOf> | null;
  rectangles: number;
};

export type StrategyView = { levels: S1Levels | null; failures: string[]; drawings: Drawing[]; trace: StrategyTrace | null };

/**
 * The strategy drawings for one session, made the way they are made by hand, with the drawing tool's
 * own operations, in chart data (time, price), never pixels:
 *   A0 = a rectangle over the previous day's candle, high to low
 *   A  = A0 moved vertically (shiftDrawing, the drag-to-move operation) by close − A0's midpoint
 *   B0 = a clone of A (same anchors, new id)
 *   B  = B0 moved vertically by open − B0's midpoint
 * Only A and B are drawn (A0 is never shown). Midpoints and heights are then read back from the
 * drawings themselves and checked; if any check fails nothing is drawn. Styles never move a price.
 */
export function strategyView(data: S1Data, cursor: number | null, settings: StrategySettings): StrategyView {
  const levels = s1Levels(data.previous, data.open, data.firstMinute);
  if (!levels || !data.previous) return { levels: null, failures: [], drawings: [], trace: null };
  const previous = data.previous;
  const show = s1Reveal(data, levels, cursor);
  const tag = `${STRATEGY_PREFIX}${data.symbol}:${data.date}`;
  // Horizontal: around the previous candle (the session before it to today) when daily anchors exist,
  // else today's session. B keeps A's horizontal coordinates unless "one session right" is chosen.
  const anchors = settings.boxSpan === "candles" ? data.anchors ?? null : null;
  const [left, right] = anchors ? [anchors.before, anchors.day] : [data.sessionOpen, data.sessionClose];
  const cloneDt = anchors && settings.cloneShift === "session" ? anchors.day - anchors.previous : 0;

  // Step 1: the original rectangle over the previous day's candle (unlocked so the move applies).
  const original: Drawing = { id: `${tag}:close-box`, kind: "rect", points: [{ time: left, price: previous.high }, { time: right, price: previous.low }], color: settings.closeBox.border, locked: false };
  const originalBox = boxOf(original);
  // Step 2: move it so its midpoint is the previous close.
  const shiftA = previous.close - originalBox.mid;
  const movedA = shiftDrawing(original, 0, shiftA);
  const boxA = boxOf(movedA);
  // Step 3: clone the moved rectangle, then move the clone so its midpoint is the open.
  const clone: Drawing | null = data.open != null ? { ...movedA, id: `${tag}:open-box` } : null;
  const cloneMidBefore = clone ? boxOf(clone).mid : null;
  const shiftB = clone && data.open != null && cloneMidBefore != null ? data.open - cloneMidBefore : null;
  const movedB = clone && shiftB != null ? shiftDrawing(clone, cloneDt, shiftB) : null;
  const boxB = movedB ? boxOf(movedB) : null;

  // Checks on the drawings themselves.
  const failures: string[] = [];
  const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9);
  const range = previous.high - previous.low;
  if (!same(boxA.height, range)) failures.push("Box A height differs from the previous day's range.");
  if (!same(boxA.mid, previous.close)) failures.push("Box A midpoint is not the previous close.");
  if (boxA.left !== originalBox.left || boxA.right !== originalBox.right) failures.push("Box A moved horizontally.");
  if (boxB && data.open != null) {
    if (!same(boxB.height, boxA.height)) failures.push("Box B height differs from box A.");
    if (!same(boxB.mid, data.open)) failures.push("Box B midpoint is not the open.");
  }
  if (levels.openingRange && levels.openingRange.time !== data.sessionOpen) failures.push("The opening candle is not the 09:15 candle.");

  const style = (drawing: Drawing, box: StrategyBox, text: string): Drawing | null => {
    if (!box.visible && !box.mid.visible) return null;
    return {
      ...drawing,
      color: box.border,
      fill: box.fill,
      fillOpacity: box.opacity,
      width: box.width,
      dash: box.dash,
      borderVisible: box.visible ? undefined : false,
      fillVisible: box.visible ? undefined : false,
      center: { ...box.mid },
      text: box.visible ? text : undefined,
      textStyle: label(box.border),
      locked: true,
    };
  };

  const line = (id: string, level: StrategyLevel, value: number, start: number, text: string): Drawing | null => {
    if (!level.visible) return null;
    const extend = level.extend === "right";
    return {
      id: `${tag}:${id}`,
      kind: extend ? "hray" : "trend",
      points: extend ? [{ time: start, price: value }] : [{ time: start, price: value }, { time: data.sessionClose, price: value }],
      color: level.color,
      width: level.width,
      dash: level.dash,
      text: level.label ? text : undefined,
      textStyle: label(level.color),
      locked: true,
    };
  };

  const drawn = failures.length ? [] : [
    style(movedA, settings.closeBox, `A · prev ${previous.date} range ${price(range)} · mid = close ${price(previous.close)}`),
    show.openBox && movedB && data.open != null ? style(movedB, settings.openBox, `B · clone of A · mid = open ${price(data.open)}`) : null,
    show.openingRange && levels.openingRange ? line("high", settings.high, levels.openingRange.high, levels.openingRange.time, `9:15 High ${price(levels.openingRange.high)}`) : null,
    show.openingRange && levels.openingRange ? line("low", settings.low, levels.openingRange.low, levels.openingRange.time, `9:15 Low ${price(levels.openingRange.low)}`) : null,
  ].filter((drawing): drawing is Drawing => drawing != null);
  // One drawing per id, always: the same ids are produced on every render, so nothing accumulates.
  const drawings = drawn.filter((drawing, index) => drawn.findIndex((item) => item.id === drawing.id) === index);

  const trace: StrategyTrace = {
    previous: { high: previous.high, low: previous.low, close: previous.close },
    original: originalBox,
    shiftA,
    boxA,
    open: data.open,
    cloneMidBefore,
    shiftB,
    boxB,
    rectangles: drawings.filter((drawing) => drawing.kind === "rect").length,
  };
  return { levels, failures, drawings, trace };
}
