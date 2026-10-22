import type { Drawing, DrawingTextStyle } from "@/components/drawing-model";
import { s1Levels, s1Reveal, type S1Data } from "@/lib/trading/s1";

/** Every S1 drawing id starts with this, so the chart draws them read-only and never saves them. */
export const S1_PREFIX = "s1:";

const CLOSE_BOX = "#2962FF";
const OPEN_BOX = "#FF9800";
const RANGE_HIGH = "#089981";
const RANGE_LOW = "#F23645";

function label(color: string): DrawingTextStyle {
  return { size: 11, bold: false, italic: false, color, align: "left", valign: "top", visible: true };
}

function price(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The S1 drawings for one session, in chart data (time, price), never pixels:
 * the previous-day box centred on the previous close, its clone centred on the open, and the
 * first-minute high / low lines. Boxes span the session (09:15–15:30 IST). In replay, `cursor`
 * hides what was not yet known at that time.
 */
export function s1Drawings(data: S1Data, cursor: number | null): Drawing[] {
  const levels = s1Levels(data.previous, data.open, data.firstMinute);
  if (!levels || !data.previous) return [];
  const show = s1Reveal(data, levels, cursor);
  const tag = `${S1_PREFIX}${data.symbol}:${data.date}`;
  const left = data.sessionOpen;
  const right = data.sessionClose;
  const box = (id: string, color: string, top: number, bottom: number, text: string): Drawing => ({
    id: `${tag}:${id}`,
    kind: "rect",
    points: [{ time: left, price: top }, { time: right, price: bottom }],
    color,
    fill: color,
    fillOpacity: 0.08,
    borderOpacity: 0.85,
    width: 1,
    dash: "solid",
    // The dashed midline is the alignment price (previous close / open).
    center: { color, width: 1, dash: "dashed", visible: true },
    text,
    textStyle: label(color),
    locked: true,
  });
  const line = (id: string, color: string, value: number, start: number, text: string): Drawing => ({
    id: `${tag}:${id}`,
    kind: "hray",
    points: [{ time: start, price: value }],
    color,
    width: 1.5,
    dash: "solid",
    text,
    textStyle: { ...label(color), size: 11 },
    locked: true,
  });

  const out: Drawing[] = [
    box("close-box", CLOSE_BOX, levels.closeBox.top, levels.closeBox.bottom, `S1 · ${data.previous.date} range ${price(levels.range)} · mid = prev close ${price(data.previous.close)}`),
  ];
  if (show.openBox && levels.openBox && data.open != null) {
    out.push(box("open-box", OPEN_BOX, levels.openBox.top, levels.openBox.bottom, `S1 · same range · mid = open ${price(data.open)}`));
  }
  if (show.openingRange && levels.openingRange) {
    out.push(line("or-high", RANGE_HIGH, levels.openingRange.high, levels.openingRange.time, `1m high ${price(levels.openingRange.high)}`));
    out.push(line("or-low", RANGE_LOW, levels.openingRange.low, levels.openingRange.time, `1m low ${price(levels.openingRange.low)}`));
  }
  return out;
}
