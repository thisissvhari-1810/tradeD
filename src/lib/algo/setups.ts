import { analyzeTrend, AUTO_TREND_DEFAULTS, averageRange, type AutoLine, type AutoTrend } from "@/lib/chart/trend-engine";
import type { Candle } from "./lines";
import { strongCandle, type Direction, type PatternSettings } from "./patterns";

/**
 * The early-session setups, each decided on the last completed candle only (no look-ahead):
 * - trendline breakout / breakdown, on the chart's automatic trendline engine (confirmed swings only);
 * - opening-range breakout, on a configurable opening range built from the session's own candles;
 * - support bounce and resistance rejection, at meaningful zones (previous-day and strategy levels,
 *   equal highs / lows, the active trendlines and the opening range).
 * Every hit carries its level and its invalidation (where the trade is wrong), from which the stop is placed.
 */

export type Zone = { price: number; label: string };
export type SetupHit = { direction: Direction; level: number; invalidation: number; reason: string };

const round = (value: number) => Math.round(value * 100) / 100;
const clock = (time: number) => new Date((time + 19_800) * 1000).toISOString().slice(11, 16);

/** The automatic trendline engine on the session's 1-minute candles (no observation wait here). */
export function sessionTrend(candles: Candle[], settings: PatternSettings): AutoTrend {
  const k = Math.max(1, Math.floor(settings.pivotStrength));
  return analyzeTrend(candles.map((candle) => ({ ...candle, volume: candle.volume ?? 0 })), 60, { ...AUTO_TREND_DEFAULTS, left: k, right: k, breakPercent: settings.minBreakPercent, observationMinutes: 0, lookback: 400 });
}

export const linePriceAt = (line: AutoLine, index: number) => line.a.price + (index - line.a.index) * line.slope;

/** The breakout buffer in index points: a % of price, fixed points, or a multiple of the average candle range. */
export function breakBuffer(price: number, candles: Candle[], settings: PatternSettings): number {
  if (settings.bufferMode === "points") return settings.bufferValue;
  if (settings.bufferMode === "atr") return settings.bufferValue * averageRange(candles.slice(-20));
  return (price * settings.bufferValue) / 100;
}

/**
 * The trade's structural stop for a trendline break: the latest confirmed swing low below the close (CALL)
 * or swing high above it (PUT) — or, with "line", the broken line itself.
 */
function trendStop(trend: AutoTrend, close: number, direction: Direction, level: number, settings: PatternSettings): { price: number; label: string } {
  if (settings.trendStop === "swing") {
    const swing = [...trend.swings].reverse().find((item) => (direction === "CALL" ? item.kind === "LOW" && item.price < close : item.kind === "HIGH" && item.price > close));
    if (swing) return { price: swing.price, label: `${direction === "CALL" ? "swing low" : "swing high"} ${swing.price.toFixed(2)} at ${clock(swing.time)}` };
  }
  return { price: level, label: `the line at ${level.toFixed(2)}` };
}

/**
 * A break of the trendline that was active before this candle — a descending resistance (CALL) or an
 * ascending support (PUT) — measured against the line's own price at this candle (a diagonal line moves),
 * beyond the breakout buffer. "close": the candle's body crosses it and closes beyond; "intrabar": the
 * candle's high (low) crosses it (paper and replay only). One signal per line: a line already crossed
 * since it became known does not signal again. With retest mode, the entry is instead the first strong
 * candle that closes beyond the broken line again after touching it, within `retestBars` candles.
 */
export function trendlineBreak(trend: AutoTrend, candles: Candle[], settings: PatternSettings): { hit: SetupHit | null; status: string } {
  const last = candles.length - 1;
  const candle = candles[last];
  if (!candle || last < 2) return { hit: null, status: "WAITING FOR VALID TRENDLINE" };
  if (!settings.retest) {
    const before = sessionTrend(candles.slice(0, -1), settings);
    for (const line of [before.resistance, before.support]) {
      if (!line) continue;
      const direction: Direction = line.kind === "RESISTANCE" ? "CALL" : "PUT";
      if (direction === "CALL" ? !(line.slope < 0) : !(line.slope > 0)) continue;
      const price = linePriceAt(line, last);
      const buffer = breakBuffer(price, candles, settings);
      const bull = direction === "CALL";
      // Already crossed since the line became known: that break was the signal (or it failed); not again.
      const known = line.b.index + Math.max(1, Math.floor(settings.pivotStrength));
      let crossed = false;
      for (let index = known; index < last && !crossed; index += 1) {
        const level = linePriceAt(line, index);
        const probe = settings.breakMode === "intrabar" ? (bull ? candles[index].high : candles[index].low) : candles[index].close;
        if (bull ? probe > level + buffer : probe < level - buffer) crossed = true;
      }
      if (crossed) continue;
      const inside = bull ? candle.open <= price : candle.open >= price;
      const beyond = settings.breakMode === "intrabar"
        ? (bull ? candle.high > price + buffer : candle.low < price - buffer) && (bull ? candles[last - 1].close <= linePriceAt(line, last - 1) : candles[last - 1].close >= linePriceAt(line, last - 1))
        : inside && (bull ? candle.close > price + buffer : candle.close < price - buffer);
      if (!beyond) continue;
      const what = bull ? "descending resistance" : "ascending support";
      const stop = trendStop(trend, candle.close, direction, price, settings);
      const how = settings.breakMode === "intrabar" ? `${bull ? "high" : "low"} ${(bull ? candle.high : candle.low).toFixed(2)} crossed` : `close ${candle.close.toFixed(2)}`;
      return {
        hit: { direction, level: round(price), invalidation: round(stop.price), reason: `${bull ? "Breakout" : "Breakdown"}: ${how} ${bull ? "above" : "below"} the ${what} trendline (${clock(line.a.time)}–${clock(line.b.time)}) at ${price.toFixed(2)} (+${buffer.toFixed(2)} buffer). Stop beyond ${stop.label}.` },
        status: bull ? "BREAKOUT CONFIRMED" : "BREAKDOWN CONFIRMED",
      };
    }
  } else {
    for (const line of trend.brokenLines) {
      if (!line.broken) continue;
      const direction: Direction = line.kind === "RESISTANCE" ? "CALL" : "PUT";
      if (direction === "CALL" ? !(line.slope < 0) : !(line.slope > 0)) continue;
      const what = direction === "CALL" ? "descending resistance" : "ascending support";
      const anchors = `${clock(line.a.time)}–${clock(line.b.time)}`;
      const since = last - line.broken.index;
      if (since < 1 || since > settings.retestBars) continue;
      const now = linePriceAt(line, last);
      const tolerance = (now * settings.tolerancePercent) / 100;
      let held = true;
      for (let index = line.broken.index + 1; index < last && held; index += 1) {
        const level = linePriceAt(line, index);
        if (direction === "CALL" ? candles[index].close < level - tolerance : candles[index].close > level + tolerance) held = false;
      }
      if (!held) continue;
      const touched = direction === "CALL" ? candle.low <= now + tolerance : candle.high >= now - tolerance;
      const buffer = breakBuffer(now, candles, settings);
      const beyond = direction === "CALL" ? candle.close > now + buffer : candle.close < now - buffer;
      if (touched && beyond && strongCandle(candle, direction)) {
        // The retest candle's extreme is the structure that must hold.
        const stop = settings.trendStop === "swing" ? (direction === "CALL" ? candle.low : candle.high) : now;
        return { hit: { direction, level: round(now), invalidation: round(stop), reason: `Retest of the broken ${what} trendline (${anchors}) at ${now.toFixed(2)} held; close ${candle.close.toFixed(2)}. Stop beyond the retest ${direction === "CALL" ? "low" : "high"} ${stop.toFixed(2)}.` }, status: "RETEST CONFIRMED" };
      }
      return { hit: null, status: "WAITING FOR RETEST" };
    }
  }
  const waiting = [trend.resistance && trend.resistance.slope < 0 ? "BREAKOUT" : "", trend.support && trend.support.slope > 0 ? "BREAKDOWN" : ""].filter(Boolean);
  return { hit: null, status: waiting.length ? `WAITING FOR ${waiting.join(" / ")}` : "WAITING FOR VALID TRENDLINE" };
}

export type OpeningRange = { high: number; low: number; end: number; complete: boolean };

/** The opening range so far: the session's first `minutes` (complete once its last candle has closed). */
export function openingRange(candles: Candle[], sessionOpen: number, minutes: number): OpeningRange | null {
  const end = sessionOpen + minutes * 60;
  const inside = candles.filter((candle) => candle.time >= sessionOpen && candle.time < end);
  if (!inside.length || minutes <= 0) return null;
  const last = candles.at(-1)!;
  return { high: Math.max(...inside.map((candle) => candle.high)), low: Math.min(...inside.map((candle) => candle.low)), end, complete: last.time + 60 >= end };
}

/** The first body close beyond the completed opening range on each side (one breakout per side per day). */
export function openingRangeBreak(candles: Candle[], range: OpeningRange | null, bufferPercent: number): { hit: SetupHit | null; status: string } {
  if (!range) return { hit: null, status: "BUILDING OPENING RANGE" };
  if (!range.complete) return { hit: null, status: `BUILDING OPENING RANGE (to ${clock(range.end)})` };
  const candle = candles.at(-1)!;
  if (candle.time < range.end) return { hit: null, status: "OPENING RANGE COMPLETE" };
  const up = range.high * (1 + bufferPercent / 100);
  const down = range.low * (1 - bufferPercent / 100);
  const after = candles.filter((item) => item.time >= range.end && item.time < candle.time);
  const upTaken = after.some((item) => item.close > up);
  const downTaken = after.some((item) => item.close < down);
  if (!upTaken && candle.close > up && candle.open <= range.high) {
    return { hit: { direction: "CALL", level: round(range.high), invalidation: round(range.high), reason: `Opening-range breakout: close ${candle.close.toFixed(2)} above the range high ${range.high.toFixed(2)} (range to ${clock(range.end)}).` }, status: "BREAKOUT CONFIRMED" };
  }
  if (!downTaken && candle.close < down && candle.open >= range.low) {
    return { hit: { direction: "PUT", level: round(range.low), invalidation: round(range.low), reason: `Opening-range breakdown: close ${candle.close.toFixed(2)} below the range low ${range.low.toFixed(2)} (range to ${clock(range.end)}).` }, status: "BREAKDOWN CONFIRMED" };
  }
  const taken = [upTaken ? "high" : "", downTaken ? "low" : ""].filter(Boolean);
  return { hit: null, status: taken.length === 2 ? "BOTH SIDES ALREADY BROKEN" : taken.length ? `RANGE ${taken[0].toUpperCase()} ALREADY BROKEN` : `WAITING FOR BREAK OF ${range.low.toFixed(2)}–${range.high.toFixed(2)}` };
}

/**
 * A bounce off support (CALL) or a rejection at resistance (PUT) on the last candle: it came from the
 * near side (the previous close), reached the zone (within tolerance), closed back on the near side in the
 * trade's direction, and shows rejection — a wick of at least half its range against the zone, or an
 * engulfing of the previous candle. The stop goes beyond the rejection wick.
 */
export function zoneReaction(candles: Candle[], zones: Zone[], tolerancePercent: number, direction: Direction): { hit: SetupHit | null; status: string } {
  const candle = candles.at(-1);
  const previous = candles.at(-2);
  if (!candle || !previous) return { hit: null, status: "WAITING FOR PRICE ACTION" };
  const range = candle.high - candle.low;
  if (range <= 0) return { hit: null, status: "NO REJECTION" };
  const bull = direction === "CALL";
  const wick = bull ? Math.min(candle.open, candle.close) - candle.low : candle.high - Math.max(candle.open, candle.close);
  const engulf = bull
    ? previous.close < previous.open && candle.close > candle.open && candle.close >= previous.open && candle.open <= previous.close
    : previous.close > previous.open && candle.close < candle.open && candle.close <= previous.open && candle.open >= previous.close;
  const rejection = wick >= range * 0.5 || engulf;
  const near = zones
    .filter((zone) => (bull ? zone.price < candle.close && previous.close > zone.price : zone.price > candle.close && previous.close < zone.price))
    .sort((a, b) => (bull ? Math.abs(candle.low - a.price) - Math.abs(candle.low - b.price) : Math.abs(candle.high - a.price) - Math.abs(candle.high - b.price)));
  for (const zone of near) {
    const tolerance = (zone.price * tolerancePercent) / 100;
    const reached = bull ? candle.low <= zone.price + tolerance : candle.high >= zone.price - tolerance;
    if (!reached) continue;
    const closedInDirection = bull ? candle.close > candle.open : candle.close < candle.open;
    if (!closedInDirection || !rejection) return { hit: null, status: `AT ${zone.label.toUpperCase()}: NO REJECTION YET` };
    const how = engulf ? "engulfing candle" : `${bull ? "lower" : "upper"} wick ${Math.round((wick / range) * 100)}% of the range`;
    return {
      hit: { direction, level: round(zone.price), invalidation: round(bull ? candle.low : candle.high), reason: `${bull ? "Bounce off" : "Rejection at"} ${zone.label} ${zone.price.toFixed(2)}: ${bull ? "low" : "high"} ${(bull ? candle.low : candle.high).toFixed(2)}, close ${candle.close.toFixed(2)} (${how}).` },
      status: bull ? "BOUNCE CONFIRMED" : "REJECTION CONFIRMED",
    };
  }
  return { hit: null, status: bull ? "WAITING FOR SUPPORT TEST" : "WAITING FOR RESISTANCE TEST" };
}

/**
 * The zones the session can react to, merged within tolerance: strategy / previous-day levels, the active
 * trendlines' current price, equal highs / lows and the completed opening range.
 */
export function sessionZones(lines: Zone[], trend: AutoTrend, range: OpeningRange | null, lastIndex: number, tolerancePercent: number): Zone[] {
  const zones: Zone[] = [...lines];
  if (trend.support) zones.push({ price: round(linePriceAt(trend.support, lastIndex)), label: "support trendline" });
  if (trend.resistance) zones.push({ price: round(linePriceAt(trend.resistance, lastIndex)), label: "resistance trendline" });
  for (const level of trend.levels) if (level.source === "EQUAL_SWINGS") zones.push({ price: level.price, label: level.kind === "SUPPORT" ? "equal lows" : "equal highs" });
  if (range?.complete) zones.push({ price: round(range.high), label: "opening-range high" }, { price: round(range.low), label: "opening-range low" });
  const merged: Zone[] = [];
  for (const zone of zones.filter((item) => Number.isFinite(item.price) && item.price > 0).sort((a, b) => a.price - b.price)) {
    const last = merged.at(-1);
    if (last && zone.price - last.price <= (last.price * tolerancePercent) / 100) {
      if (!last.label.includes(zone.label)) last.label = `${last.label} / ${zone.label}`;
    } else merged.push({ ...zone });
  }
  return merged;
}
