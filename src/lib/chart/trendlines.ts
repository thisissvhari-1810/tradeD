/**
 * Mathi Trend Channel for Line Strategy Draw: 1-minute trend lines drawn the way the user draws them on the chart
 * (19 Nov 2026 example).
 *
 * The first block is the first 3 one-minute candles (09:15–09:17); its high is "1st High" and its low "1st Low".
 * The 09:15 candle counts with its body only (its opening-print wick is ignored), as in the user's drawing: 1st Low
 * 25,186.75 sat at the 09:15 body while its wick reached about 25,150.
 *  - Upper (resistance) line: from 1st High to a later swing high. It takes the swing high that gives the steepest
 *    line still lying on or above every swing high in between (the upper hull), so it touches the highs instead of
 *    floating above them.
 *  - Lower (support) line: from 1st Low to a later swing low, mirrored (on or below every swing low in between).
 * A swing high is a candle whose high is the highest of the 2 candles before and after it (confirmed when the 2nd
 * candle after it has closed); a swing low is the mirror. Lines only use swings confirmed by then.
 *
 * Breakout: the first completed candle that closes beyond a line (after the line's second point) AND beyond the latest
 * swing high (CALL) / swing low (PUT) — a drift through a still-steep line is not a breakout. The line is frozen there. Entry: the next candle trades beyond the breakout candle's high (CALL) / low (PUT) and closes beyond the line,
 * and the buy is at that candle's close. With no entry by 11:00, the strategy's daily rule buys in the day's direction
 * (the 10:59 close against the 09:15 open), as Mathi Trend Channel does. Pure and read-only: it never places an order.
 */
import type { Candle } from "@/lib/algo/lines";

export type TPoint = { time: number; price: number };
/** A line from `a` through `b`; `slope` in points per second. `brokenAt`: the candle that closed beyond it (frozen). */
export type TrendLine = { a: TPoint; b: TPoint; slope: number; brokenAt: number | null };
export type TrendSignal = { side: "CALL" | "PUT"; breakout: Candle | null; entry: Candle; level: number | null; reason: string; fallback: boolean };
export type TrendState = { firstHigh: TPoint | null; firstLow: TPoint | null; upper: TrendLine | null; lower: TrendLine | null; signal: TrendSignal | null };

const FIRST_BLOCK = 3;
const SWING = 2;
const FALLBACK_MINUTES = 105; // 11:00 IST = 09:15 + 105 minutes

export const priceOn = (line: Pick<TrendLine, "a" | "slope">, time: number) => line.a.price + line.slope * (time - line.a.time);
const r2 = (value: number) => Math.round(value * 100) / 100;
const clock = (time: number) => new Date((time + 19_800) * 1000).toISOString().slice(11, 16);
const fmt = (value: number) => value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The hull line from `anchor` through the swing that keeps every other swing on one side (upper: max slope; lower: min). */
function hullLine(anchor: TPoint, swings: TPoint[], upper: boolean): TrendLine | null {
  let best: TrendLine | null = null;
  for (const point of swings) {
    if (point.time <= anchor.time) continue;
    const slope = (point.price - anchor.price) / (point.time - anchor.time);
    if (!best || (upper ? slope > best.slope : slope < best.slope)) best = { a: anchor, b: point, slope, brokenAt: null };
  }
  return best;
}

/** The lines and the entry as known once every candle up to `clock` (unix seconds) has closed. */
export function minuteTrendLines(candles: Candle[], sessionOpen: number, sessionClose: number, clockAt: number): TrendState {
  const bars = candles.filter((bar) => bar.time >= sessionOpen && bar.time < sessionClose && bar.time + 60 <= clockAt).sort((a, b) => a.time - b.time);
  const empty: TrendState = { firstHigh: null, firstLow: null, upper: null, lower: null, signal: null };
  const block = bars.filter((bar) => bar.time < sessionOpen + FIRST_BLOCK * 60);
  if (clockAt < sessionOpen + FIRST_BLOCK * 60 || !block.length) return empty;
  // The 09:15 candle by its body; 09:16 and 09:17 by their full range.
  const span = block.map((bar) => (bar.time === sessionOpen ? { time: bar.time, high: Math.max(bar.open, bar.close), low: Math.min(bar.open, bar.close) } : bar));
  const top = span.reduce((best, bar) => (bar.high > best.high ? bar : best));
  const bottom = span.reduce((best, bar) => (bar.low < best.low ? bar : best));
  const firstHigh = { time: top.time, price: top.high };
  const firstLow = { time: bottom.time, price: bottom.low };
  const highs: TPoint[] = [];
  const lows: TPoint[] = [];
  let upper: TrendLine | null = null;
  let lower: TrendLine | null = null;
  let frozenUpper: TrendLine | null = null;
  let frozenLower: TrendLine | null = null;
  let pending: { side: "CALL" | "PUT"; bar: Candle; line: TrendLine } | null = null;
  let signal: TrendSignal | null = null;
  const fallbackAt = sessionOpen + FALLBACK_MINUTES * 60;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!signal && bar.time >= sessionOpen + FIRST_BLOCK * 60) {
      upper = frozenUpper ?? hullLine(firstHigh, highs, true);
      lower = frozenLower ?? hullLine(firstLow, lows, false);
      if (pending) {
        const line = pending.line;
        const call = pending.side === "CALL";
        const level = priceOn(line, bar.time);
        const beyond = call ? bar.high > pending.bar.high && bar.close > level : bar.low < pending.bar.low && bar.close < level;
        if (beyond && bar.time < fallbackAt) {
          signal = {
            side: pending.side, breakout: pending.bar, entry: bar, level: r2(level), fallback: false,
            reason: `${call ? "Upper" : "Lower"} trend line (${clock(line.a.time)} ${fmt(line.a.price)} → ${clock(line.b.time)} ${fmt(line.b.price)}) broken by the ${clock(pending.bar.time)} close ${fmt(pending.bar.close)}; the ${clock(bar.time)} candle went ${call ? "above its high" : "below its low"} and closed ${fmt(bar.close)}.`,
          };
        }
        pending = null;
      }
      if (!signal && bar.time < fallbackAt) {
        const lastHigh = highs.at(-1)?.price ?? firstHigh.price;
        const lastLow = lows.at(-1)?.price ?? firstLow.price;
        if (upper && !frozenUpper && bar.time > upper.b.time && bar.close > priceOn(upper, bar.time) && bar.close > lastHigh) {
          frozenUpper = upper = { ...upper, brokenAt: bar.time };
          pending = { side: "CALL", bar, line: upper };
        } else if (lower && !frozenLower && bar.time > lower.b.time && bar.close < priceOn(lower, bar.time) && bar.close < lastLow) {
          frozenLower = lower = { ...lower, brokenAt: bar.time };
          pending = { side: "PUT", bar, line: lower };
        }
      }
      if (!signal && bar.time + 60 >= fallbackAt && bar.time < fallbackAt) {
        const open = bars[0].open;
        const side = bar.close >= open ? "CALL" : "PUT";
        signal = { side, breakout: null, entry: bar, level: null, fallback: true, reason: `No trend-line entry by 11:00: the daily rule follows the day's direction (${clock(bar.time)} close ${fmt(bar.close)} ${side === "CALL" ? "above" : "below"} the 09:15 open ${fmt(open)}).` };
      }
    }
    // The swing whose 2nd candle after it just closed is confirmed now (used from the next candle on).
    const j = i - SWING;
    if (j >= SWING) {
      const pivot = bars[j];
      const around = [...bars.slice(j - SWING, j), ...bars.slice(j + 1, j + 1 + SWING)];
      if (pivot.time > firstHigh.time && bars.slice(j - SWING, j).every((bar) => bar.high <= pivot.high) && bars.slice(j + 1, j + 1 + SWING).every((bar) => bar.high < pivot.high) && around.length === SWING * 2) highs.push({ time: pivot.time, price: pivot.high });
      if (pivot.time > firstLow.time && bars.slice(j - SWING, j).every((bar) => bar.low >= pivot.low) && bars.slice(j + 1, j + 1 + SWING).every((bar) => bar.low > pivot.low) && around.length === SWING * 2) lows.push({ time: pivot.time, price: pivot.low });
    }
  }
  // After the last candle: the lines as they stand now (frozen ones stay where they broke). Once the entry is taken both
  // lines stay as they were at the entry, so the chart shows the lines the trade came from.
  if (!signal) {
    upper = frozenUpper ?? hullLine(firstHigh, highs, true);
    lower = frozenLower ?? hullLine(firstLow, lows, false);
  }
  return { firstHigh, firstLow, upper, lower, signal };
}
