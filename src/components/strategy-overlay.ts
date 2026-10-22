import type { Drawing, DrawingTextStyle } from "@/components/drawing-model";
import type { StrategyBox, StrategyLevel, StrategySettings } from "@/components/strategy-settings";
import { s1Checks, s1Levels, s1Reveal, type S1Data, type S1Levels } from "@/lib/trading/s1";

/** Every strategy drawing id starts with this, so the chart draws them read-only and never saves them. */
export const STRATEGY_PREFIX = "strategy:";

function label(color: string): DrawingTextStyle {
  return { size: 11, bold: true, italic: false, color, align: "left", valign: "top", visible: true };
}

export function price(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export type StrategyView = { levels: S1Levels | null; failures: string[]; drawings: Drawing[] };

/**
 * The strategy drawings for one session, in chart data (time, price), never pixels. Styles come
 * from the settings and never change a price. Boxes span the session (09:15-15:30 IST). In replay,
 * `cursor` hides what was not yet known at that time. Nothing is drawn if a check fails.
 */
export function strategyView(data: S1Data, cursor: number | null, settings: StrategySettings): StrategyView {
  const levels = s1Levels(data.previous, data.open, data.firstMinute);
  if (!levels || !data.previous) return { levels: null, failures: [], drawings: [] };
  const failures = s1Checks(levels, data.previous, data.open, data.sessionOpen);
  if (failures.length) return { levels, failures, drawings: [] };
  const show = s1Reveal(data, levels, cursor);
  const tag = `${STRATEGY_PREFIX}${data.symbol}:${data.date}`;
  const left = data.sessionOpen;
  const right = data.sessionClose;

  const box = (id: string, style: StrategyBox, top: number, bottom: number, text: string): Drawing | null => {
    if (!style.visible && !style.mid.visible) return null;
    return {
      id: `${tag}:${id}`,
      kind: "rect",
      points: [{ time: left, price: top }, { time: right, price: bottom }],
      color: style.border,
      fill: style.fill,
      fillOpacity: style.opacity,
      width: style.width,
      dash: style.dash,
      borderVisible: style.visible ? undefined : false,
      fillVisible: style.visible ? undefined : false,
      center: { ...style.mid },
      text: style.visible ? text : undefined,
      textStyle: label(style.border),
      locked: true,
    };
  };

  const line = (id: string, style: StrategyLevel, value: number, start: number, text: string): Drawing | null => {
    if (!style.visible) return null;
    const right = style.extend === "right";
    return {
      id: `${tag}:${id}`,
      kind: right ? "hray" : "trend",
      points: right ? [{ time: start, price: value }] : [{ time: start, price: value }, { time: data.sessionClose, price: value }],
      color: style.color,
      width: style.width,
      dash: style.dash,
      text: style.label ? text : undefined,
      textStyle: label(style.color),
      locked: true,
    };
  };

  const drawings = [
    box("close-box", settings.closeBox, levels.closeBox.top, levels.closeBox.bottom, `Prev ${data.previous.date} · range ${price(levels.range)} · mid = close ${price(data.previous.close)}`),
    show.openBox && levels.openBox && data.open != null
      ? box("open-box", settings.openBox, levels.openBox.top, levels.openBox.bottom, `Same range · mid = open ${price(data.open)}`)
      : null,
    show.openingRange && levels.openingRange ? line("high", settings.high, levels.openingRange.high, levels.openingRange.time, `9:15 High ${price(levels.openingRange.high)}`) : null,
    show.openingRange && levels.openingRange ? line("low", settings.low, levels.openingRange.low, levels.openingRange.time, `9:15 Low ${price(levels.openingRange.low)}`) : null,
  ].filter((drawing): drawing is Drawing => drawing != null);
  return { levels, failures, drawings };
}
