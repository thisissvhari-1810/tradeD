import { ema } from "@/lib/market/indicators";
import type { Candle } from "./lines";
import type { Direction, StrategySignal } from "./patterns";

/**
 * "Algo - Primary Strategy": NIFTY 50 options on an opening-range breakout confirmed by session VWAP and
 * the trend. Decided only on completed 1-minute index candles (no look-ahead):
 * - the opening range is the high / low of the first `orMinutes` (default 09:15–09:30); nothing is traded
 *   inside it, and nothing seen inside it is queued for later;
 * - CALL: a candle closes above the range high (crossing it on that candle), above session VWAP, with the
 *   trend filter bullish; PUT is the mirror image below the range low;
 * - optional retest: after the break, a later candle touches the range edge and closes back beyond it.
 * VWAP needs volume. Index candles often have none; then the strategy either uses a clearly labelled TWAP
 * (time-weighted average of the typical price) or refuses the setup — never an invented VWAP.
 */

export type PrimarySettings = {
  /** Opening-range length from 09:15 (15 = 09:15–09:30). */
  orMinutes: number;
  /** Require price above (CALL) / below (PUT) session VWAP. */
  vwap: boolean;
  /** Without volume on the index candles: use a time-weighted average instead, or refuse the setup. */
  vwapFallback: "twap" | "reject";
  /** Trend confirmation: 9 / 21 EMA of the session's closes, or none. */
  trend: "ema" | "none";
  trendFast: number;
  trendSlow: number;
  /** Wait for a retest of the broken range edge before entering. */
  retest: boolean;
  /** A break not retested within this many candles expires. */
  retestBars: number;
  /** A close must clear the range edge by this % (0 = any close beyond it). */
  breakBufferPercent: number;
  /** The stop on the index: beyond the signal candle's extreme, the range midpoint, or the opposite range edge. */
  stopBasis: "candle" | "mid" | "range";
};

export const PRIMARY_SETTINGS_DEFAULTS: PrimarySettings = { orMinutes: 15, vwap: true, vwapFallback: "twap", trend: "ema", trendFast: 9, trendSlow: 21, retest: false, retestBars: 10, breakBufferPercent: 0.02, stopBasis: "candle" };

export type PrimaryState = {
  status: string;
  range: { high: number; low: number; end: number; complete: boolean } | null;
  vwap: { value: number; source: "VWAP" | "TWAP" } | null;
  trend: "BULLISH" | "BEARISH" | "FLAT" | null;
  /** Every condition checked on the last candle, in plain words. */
  checks: string[];
};

const clock = (time: number) => new Date((time + 19_800) * 1000).toISOString().slice(11, 16);
const round = (value: number) => Math.round(value * 100) / 100;

/** Session VWAP from volume, or the labelled TWAP fallback when the candles carry no volume. */
export function sessionVwap(candles: Candle[], fallback: PrimarySettings["vwapFallback"]): PrimaryState["vwap"] {
  if (!candles.length) return null;
  const typical = (candle: Candle) => (candle.high + candle.low + candle.close) / 3;
  const volume = candles.reduce((sum, candle) => sum + (candle.volume ?? 0), 0);
  if (volume > 0) return { value: round(candles.reduce((sum, candle) => sum + typical(candle) * (candle.volume ?? 0), 0) / volume), source: "VWAP" };
  if (fallback === "reject") return null;
  return { value: round(candles.reduce((sum, candle) => sum + typical(candle), 0) / candles.length), source: "TWAP" };
}

/**
 * The Primary Strategy on the session's completed candles (the last one is the candle being evaluated).
 * Returns at most one signal, with its level and its invalidation (where the stop goes), and the state of
 * every condition for the dashboard.
 */
export function primarySignal(candles: Candle[], sessionOpen: number, settings: PrimarySettings): { signal: StrategySignal | null; state: PrimaryState } {
  const end = sessionOpen + settings.orMinutes * 60;
  const inside = candles.filter((candle) => candle.time >= sessionOpen && candle.time < end);
  const last = candles.at(-1);
  const empty: PrimaryState = { status: "WAITING FOR THE OPEN", range: null, vwap: null, trend: null, checks: [] };
  if (!last || !inside.length) return { signal: null, state: empty };
  const range = { high: Math.max(...inside.map((candle) => candle.high)), low: Math.min(...inside.map((candle) => candle.low)), end, complete: last.time + 60 >= end };
  const vwap = sessionVwap(candles, settings.vwapFallback);
  const closes = candles.map((candle) => candle.close);
  const fast = ema(closes, settings.trendFast).at(-1);
  const slow = ema(closes, settings.trendSlow).at(-1);
  const trend: PrimaryState["trend"] = closes.length < settings.trendSlow || fast == null || slow == null ? null : fast > slow ? "BULLISH" : fast < slow ? "BEARISH" : "FLAT";
  const state: PrimaryState = { status: "", range: { ...range, high: round(range.high), low: round(range.low) }, vwap, trend, checks: [] };
  // Inside the observation window: analysis only, and nothing is carried forward.
  if (last.time < end) return { signal: null, state: { ...state, status: `OBSERVING OPENING RANGE (to ${clock(end)})` } };

  const index = candles.length - 1;
  const up = range.high * (1 + settings.breakBufferPercent / 100);
  const down = range.low * (1 - settings.breakBufferPercent / 100);
  const crossedUp = (at: number) => candles[at].time >= end && candles[at].close > up && candles[at - 1].close <= up;
  const crossedDown = (at: number) => candles[at].time >= end && candles[at].close < down && candles[at - 1].close >= down;

  // The entry candle for each direction: the crossing itself, or (retest mode) the reclaim after a retest.
  const entryFor = (direction: Direction): { ok: boolean; note: string } => {
    const bull = direction === "CALL";
    const edge = bull ? range.high : range.low;
    if (!settings.retest) {
      if (!(bull ? crossedUp(index) : crossedDown(index))) return { ok: false, note: "" };
      return { ok: true, note: `close ${last.close.toFixed(2)} ${bull ? "above the range high" : "below the range low"} ${edge.toFixed(2)}` };
    }
    let broke = -1;
    for (let at = Math.max(1, index - settings.retestBars); at < index; at += 1) if (bull ? crossedUp(at) : crossedDown(at)) broke = at;
    if (broke < 0) return { ok: false, note: "" };
    for (let at = broke + 1; at < index; at += 1) {
      // Already reclaimed after an earlier retest (that was the entry), or failed back inside: no entry now.
      if (bull ? candles[at].close < range.low : candles[at].close > range.high) return { ok: false, note: "" };
      if ((bull ? candles[at].low <= edge : candles[at].high >= edge) && (bull ? candles[at].close > up : candles[at].close < down)) return { ok: false, note: "" };
    }
    const touched = bull ? last.low <= edge * 1.0003 : last.high >= edge * 0.9997;
    const reclaimed = bull ? last.close > up && last.close > last.open : last.close < down && last.close < last.open;
    if (!touched || !reclaimed) return { ok: false, note: "" };
    return { ok: true, note: `retest of the range ${bull ? "high" : "low"} ${edge.toFixed(2)} held; close ${last.close.toFixed(2)}` };
  };

  for (const direction of ["CALL", "PUT"] as const) {
    const entry = entryFor(direction);
    if (!entry.ok) continue;
    const bull = direction === "CALL";
    const checks = [`Opening range ${range.low.toFixed(2)}–${range.high.toFixed(2)} (to ${clock(end)}): ${entry.note}.`];
    if (settings.vwap) {
      if (!vwap) return { signal: null, state: { ...state, status: "VWAP UNAVAILABLE", checks: [...checks, "VWAP needs volume and the index candles have none; the fallback is set to refuse: no trade."] } };
      const side = bull ? last.close > vwap.value : last.close < vwap.value;
      checks.push(`${vwap.source === "VWAP" ? "VWAP" : "TWAP (no index volume, so not a true VWAP)"} ${vwap.value.toFixed(2)}: close is ${last.close > vwap.value ? "above" : "below"} it${side ? "" : " — against the signal"}.`);
      if (!side) return { signal: null, state: { ...state, status: bull ? "BREAKOUT BELOW VWAP: NO TRADE" : "BREAKDOWN ABOVE VWAP: NO TRADE", checks } };
    }
    if (settings.trend === "ema") {
      const agrees = bull ? trend === "BULLISH" : trend === "BEARISH";
      checks.push(trend == null ? `Trend: fewer than ${settings.trendSlow} candles for the ${settings.trendSlow} EMA yet — unconfirmed.` : `Trend: ${settings.trendFast} EMA ${fast!.toFixed(2)} ${fast! > slow! ? ">" : "≤"} ${settings.trendSlow} EMA ${slow!.toFixed(2)} (${trend.toLowerCase()})${agrees ? "" : " — against the signal"}.`);
      if (!agrees) return { signal: null, state: { ...state, status: `TREND ${trend ? "AGAINST" : "UNCONFIRMED"}: NO TRADE`, checks } };
    }
    const invalidation = settings.stopBasis === "range" ? (bull ? range.low : range.high) : settings.stopBasis === "mid" ? (range.high + range.low) / 2 : bull ? last.low : last.high;
    const stopText = settings.stopBasis === "range" ? `the range ${bull ? "low" : "high"}` : settings.stopBasis === "mid" ? "the range midpoint" : `the signal candle's ${bull ? "low" : "high"}`;
    checks.push(`Stop beyond ${stopText} ${invalidation.toFixed(2)}.`);
    const signal: StrategySignal = { id: `primary:${direction}:${last.time}`, strategy: "primary", direction, time: last.time, trigger: last.close, level: round(bull ? range.high : range.low), invalidation: round(invalidation), reason: `Primary ORB + VWAP: ${checks.join(" ")}`, volume: "NOT_REQUIRED" };
    return { signal, state: { ...state, status: `${bull ? "BREAKOUT" : "BREAKDOWN"} CONFIRMED`, checks } };
  }
  const where = last.close > range.high ? "above the range" : last.close < range.low ? "below the range" : "inside the range";
  return { signal: null, state: { ...state, status: settings.retest ? "WAITING FOR BREAK AND RETEST" : `WAITING FOR A BREAK OF ${range.low.toFixed(2)}–${range.high.toFixed(2)}`, checks: [`Close ${last.close.toFixed(2)} is ${where}; no new crossing on this candle.`] } };
}
