/**
 * Mathi Trend Channel for Line Strategy Draw: the channel the user draws (examples 19 and 23 Nov 2026, 1-minute), on the
 * chart's own candles: a 5-minute chart reads 5-minute candles, 15-minute 15-minute, and so on (user, 23 Nov 2026).
 * Every count below is in those candles; the 09:15 one-minute candle always counts by its body.
 *
 * Three swing points make the channel:
 *  - 2 highs + 1 low (1st High → 1st Low → 2nd High): the primary line runs through the two highs, its exact parallel
 *    clone through the low.
 *  - 2 lows + 1 high (1st Low → 1st High → 2nd Low): the primary line through the two lows, the clone through the high.
 * The points:
 *  1. The first block (09:15–09:17; the 09:15 candle by its body, its opening wick ignored) gives the first two points:
 *     its high and its low, in the order they happened.
 *  2. The later of the two keeps moving while price keeps going that way, and is fixed once 3 candles after it have not
 *     gone beyond it (23 Nov: the block low 25,877.75 at 09:17 moved down to 25,567.30 at 09:35).
 *  3. The third point is the next swing the other way: fixed once 3 candles after it have not gone beyond it, and only
 *     if it moved at least 2 × the average 1-minute range from the second point (small pullbacks don't count).
 * Breakout (after the third point is fixed): a candle closes beyond a channel line. Entry: the next candle trades beyond
 * the breakout candle's high (CALL) / low (PUT) and closes beyond the line; the buy is at its close. If it doesn't, that
 * candle can itself be the next breakout. With no entry by 11:00, the strategy's daily rule buys in the day's direction
 * (the 10:59 close against the 09:15 open), as Mathi Trend Channel does. Lines stop moving once fixed. Pure and
 * read-only: it never places an order. The algo's own Trend Channel (3-minute channel) is separate and unchanged.
 */
import type { Candle } from "@/lib/algo/lines";

export type TPoint = { time: number; price: number; kind: "HIGH" | "LOW" };
/** A line from `a`; `slope` in points per second. */
export type TrendLine = { a: { time: number; price: number }; slope: number; role: "PRIMARY" | "CLONE"; side: "UPPER" | "LOWER" };
export type TrendSignal = { side: "CALL" | "PUT"; breakout: Candle | null; entry: Candle; level: number | null; reason: string; fallback: boolean };
export type TrendState = {
  /** The swing points found so far (1 to 3), in time order. */
  points: TPoint[];
  pattern: "A" | "B" | null;
  upper: TrendLine | null;
  lower: TrendLine | null;
  signal: TrendSignal | null;
};

const FIRST_BLOCK = 3;
const RIGHT = 3;
const DEPTH_ATR = 2;
const FALLBACK_MINUTES = 105; // 11:00 IST = 09:15 + 105 minutes
const LATE_CUTOFF_MINUTES = 345; // 15:00 IST: last entry on candles bigger than 5 minutes (no 11:00 rule there)

export const priceOn = (line: Pick<TrendLine, "a" | "slope">, time: number) => line.a.price + line.slope * (time - line.a.time);
const r2 = (value: number) => Math.round(value * 100) / 100;
const clock = (time: number) => new Date((time + 19_800) * 1000).toISOString().slice(11, 16);
const fmt = (value: number) => value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const beyond = (kind: "HIGH" | "LOW", a: number, b: number) => (kind === "HIGH" ? a > b : a < b);
const extreme = (bar: Candle, kind: "HIGH" | "LOW") => (kind === "HIGH" ? bar.high : bar.low);

/** The channel from three points: the two of one kind make the primary line, the clone goes through the third. */
function channelOf(points: TPoint[]): Pick<TrendState, "pattern" | "upper" | "lower"> {
  const [p0, p1, p2] = points;
  if (p0.kind !== p2.kind) return { pattern: null, upper: null, lower: null };
  const slope = (p2.price - p0.price) / (p2.time - p0.time);
  const highs = p0.kind === "HIGH";
  const primary: TrendLine = { a: { time: p0.time, price: p0.price }, slope, role: "PRIMARY", side: highs ? "UPPER" : "LOWER" };
  const clone: TrendLine = { a: { time: p1.time, price: p1.price }, slope, role: "CLONE", side: highs ? "LOWER" : "UPPER" };
  return { pattern: highs ? "A" : "B", upper: highs ? primary : clone, lower: highs ? clone : primary };
}

/**
 * The session's candles of `seconds` (60 = 1-minute, 300 = 5-minute, …) on the 09:15 grid, built from 1-minute candles.
 * The 09:15 one-minute candle counts by its body (its opening-print wick is ignored).
 */
export function sessionBars(candles: Candle[], sessionOpen: number, sessionClose: number, seconds: number): Candle[] {
  const out = new Map<number, Candle>();
  for (const candle of [...candles].filter((bar) => bar.time >= sessionOpen && bar.time < sessionClose).sort((a, b) => a.time - b.time)) {
    const bar = candle.time === sessionOpen ? { ...candle, high: Math.max(candle.open, candle.close), low: Math.min(candle.open, candle.close) } : candle;
    const start = sessionOpen + Math.floor((bar.time - sessionOpen) / seconds) * seconds;
    const into = out.get(start);
    if (!into) out.set(start, { time: start, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    else Object.assign(into, { high: Math.max(into.high, bar.high), low: Math.min(into.low, bar.low), close: bar.close });
  }
  return [...out.values()];
}

/** The channel and the entry on `barSeconds` candles, as known once every candle up to `clockAt` (unix seconds) has closed. */
export function minuteTrendLines(candles: Candle[], sessionOpen: number, sessionClose: number, clockAt: number, barSeconds = 60): TrendState {
  const minutes = candles.filter((bar) => bar.time + 60 <= clockAt);
  const bars = sessionBars(minutes, sessionOpen, sessionClose, barSeconds).filter((bar) => bar.time + barSeconds <= clockAt);
  const state: TrendState = { points: [], pattern: null, upper: null, lower: null, signal: null };
  const blockEnd = sessionOpen + FIRST_BLOCK * barSeconds;
  const block = bars.filter((bar) => bar.time < blockEnd);
  if (clockAt < blockEnd || !block.length) return state;

  // 1. The block's high and low, in the order they happened.
  const top = block.reduce((best, bar) => (bar.high > best.high ? bar : best));
  const bottom = block.reduce((best, bar) => (bar.low < best.low ? bar : best));
  const highFirst = top.time < bottom.time || (top.time === bottom.time && top.close < top.open);
  const first: TPoint = highFirst ? { time: top.time, price: top.high, kind: "HIGH" } : { time: bottom.time, price: bottom.low, kind: "LOW" };
  let candidate: TPoint = highFirst ? { time: bottom.time, price: bottom.low, kind: "LOW" } : { time: top.time, price: top.high, kind: "HIGH" };
  state.points = [first];
  let quiet = block.filter((bar) => bar.time > candidate.time).length;

  let sumRange = 0;
  let counted = 0;
  let pending: { side: "CALL" | "PUT"; bar: Candle; line: TrendLine } | null = null;
  // 1- to 5-minute candles: entries until 11:00, then the daily rule. Bigger candles need hours to form a channel, so
  // they watch for a breakout until 15:00 and have no 11:00 rule.
  const dailyRule = barSeconds <= 300;
  const fallbackAt = sessionOpen + (dailyRule ? FALLBACK_MINUTES : LATE_CUTOFF_MINUTES) * 60;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (i > 0 && bar.time > sessionOpen) {
      sumRange += Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i - 1].close), Math.abs(bar.low - bars[i - 1].close));
      counted += 1;
    }
    if (bar.time < blockEnd || state.signal) continue;

    if (state.upper && state.lower) {
      // Breakout and entry once the channel exists.
      if (pending) {
        const call = pending.side === "CALL";
        const level = priceOn(pending.line, bar.time);
        const ok = call ? bar.high > pending.bar.high && bar.close > level : bar.low < pending.bar.low && bar.close < level;
        if (ok && bar.time < fallbackAt) {
          const [p0, p1, p2] = state.points;
          state.signal = {
            side: pending.side, breakout: pending.bar, entry: bar, level: r2(level), fallback: false,
            reason: `Pattern ${state.pattern} (${[p0, p1, p2].map((p, n) => `${n === 2 ? "2nd" : "1st"} ${p.kind === "HIGH" ? "High" : "Low"} ${fmt(p.price)} at ${clock(p.time)}`).join(", ")}): the ${clock(pending.bar.time)} candle closed ${fmt(pending.bar.close)} ${call ? "above the upper" : "below the lower"} line; the ${clock(bar.time)} candle went ${call ? "above its high" : "below its low"} and closed ${fmt(bar.close)}.`,
          };
          continue;
        }
        pending = null;
      }
      if (bar.time < fallbackAt) {
        if (bar.close > priceOn(state.upper, bar.time)) pending = { side: "CALL", bar, line: state.upper };
        else if (bar.close < priceOn(state.lower, bar.time)) pending = { side: "PUT", bar, line: state.lower };
      }
    } else {
      // 2–3. Move the candidate while price goes beyond it; fix it after 3 quiet candles (the 3rd point needs depth).
      if (beyond(candidate.kind, extreme(bar, candidate.kind), candidate.price)) {
        candidate = { time: bar.time, price: extreme(bar, candidate.kind), kind: candidate.kind };
        quiet = 0;
      } else {
        quiet += 1;
      }
      if (quiet >= RIGHT) {
        const last = state.points.at(-1)!;
        const atr = counted ? sumRange / counted : 0;
        const deep = state.points.length === 1 || Math.abs(candidate.price - last.price) >= DEPTH_ATR * atr;
        if (deep) {
          const fixed = candidate;
          state.points.push(fixed);
          if (state.points.length === 3) Object.assign(state, channelOf(state.points));
          // The next candidate: the other way, from the candles after this point.
          const kind = fixed.kind === "HIGH" ? "LOW" : "HIGH";
          const after = bars.slice(0, i + 1).filter((item) => item.time > fixed.time);
          const best = after.reduce<Candle | null>((pick, item) => (!pick || beyond(kind, extreme(item, kind), extreme(pick, kind)) ? item : pick), null);
          candidate = best ? { time: best.time, price: extreme(best, kind), kind } : { time: bar.time, price: extreme(bar, kind), kind };
          quiet = best ? after.filter((item) => item.time > best.time).length : 0;
        }
      }
    }

    if (dailyRule && !state.signal && bar.time + barSeconds >= fallbackAt && bar.time < fallbackAt) {
      const open = bars[0].open;
      const side = bar.close >= open ? "CALL" : "PUT";
      state.signal = { side, breakout: null, entry: bar, level: null, fallback: true, reason: `No channel entry by 11:00: the daily rule follows the day's direction (${clock(bar.time)} close ${fmt(bar.close)} ${side === "CALL" ? "above" : "below"} the 09:15 open ${fmt(open)}).` };
    }
  }
  return state;
}
