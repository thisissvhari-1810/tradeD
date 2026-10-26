import type { Candle } from "./lines";
import type { ReplayChain } from "./replay-adapter";

/**
 * Historical (expired) weekly index options for backtests. Contracts that have expired cannot be looked up
 * in the instrument list, so a past day's real ATM premiums come from Dhan's expired-options history
 * (POST /v2/charts/rollingoption): for one strike offset from ATM (ATM, ATM+1, ATM−1 …) and one side it
 * returns each minute's candle together with the strike it belonged to. Requesting every offset in a band
 * and regrouping the rows by strike gives each fixed strike's own 1-minute premium tape — what a position
 * held on that strike is valued at, minute by minute.
 */

/** Strike offsets requested around ATM (index options near expiry: up to ±10). */
export const ROLLING_OFFSETS = Array.from({ length: 21 }, (_, index) => index - 10).map((step) => (step === 0 ? "ATM" : step > 0 ? `ATM+${step}` : `ATM${step}`));

export type RollingSide = "CALL" | "PUT";

/** The request body for one offset and side (`expiryCode` 1 = the nearest weekly expiry on each day). */
export function rollingRequest(input: { underlyingSecurityId: number; offset: string; side: RollingSide; from: string; to: string }) {
  return {
    exchangeSegment: "NSE_FNO", interval: "1", securityId: input.underlyingSecurityId, instrument: "OPTIDX", expiryFlag: "WEEK", expiryCode: 1,
    strike: input.offset, drvOptionType: input.side, requiredData: ["open", "high", "low", "close", "volume", "strike", "spot"], fromDate: input.from, toDate: input.to,
  };
}

type Series = { open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[]; strike?: number[]; spot?: number[]; timestamp?: number[] };

const SESSION_FIRST = 9 * 60 + 15; // 09:15 IST, minutes
const SESSION_LAST = 15 * 60 + 29; // 15:29 IST: the last 1-minute candle of the session
const istMinutes = (seconds: number) => {
  const date = new Date((seconds + 19_800) * 1000);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
};
export const istDate = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(0, 10);

/** Premium tapes keyed by "CE:strike" / "PE:strike", per IST date, sorted by time, one candle per minute. */
export type ExpiredTapes = Map<string, Map<string, Candle[]>>;

/**
 * Regroups the offset responses into each strike's own tape for each day. Rows outside the 09:15–15:29
 * session, without a positive close, or duplicated (the same strike and minute from two offsets) are dropped.
 */
export function mergeRolling(responses: Array<{ side: RollingSide; data: unknown }>): ExpiredTapes {
  const byDay = new Map<string, Map<string, Map<number, Candle>>>();
  for (const { side, data } of responses) {
    const root = (data && typeof data === "object" ? (data as { data?: Record<string, Series | null> }).data : null) ?? null;
    const series = root?.[side === "CALL" ? "ce" : "pe"] ?? null;
    if (!series?.timestamp?.length) continue;
    const right = side === "CALL" ? "CE" : "PE";
    series.timestamp.forEach((time, index) => {
      const minutes = istMinutes(time);
      const strike = series.strike?.[index];
      const close = series.close?.[index];
      if (minutes < SESSION_FIRST || minutes > SESSION_LAST || !strike || !(close != null && close > 0)) return;
      const day = istDate(time);
      const key = `${right}:${strike}`;
      if (!byDay.has(day)) byDay.set(day, new Map());
      const strikes = byDay.get(day)!;
      if (!strikes.has(key)) strikes.set(key, new Map());
      const open = series.open?.[index] ?? close;
      strikes.get(key)!.set(time, { time, open, high: Math.max(series.high?.[index] ?? close, open, close), low: Math.min(series.low?.[index] ?? close, open, close), close, volume: series.volume?.[index] ?? 0 });
    });
  }
  const out: ExpiredTapes = new Map();
  for (const [day, strikes] of byDay) {
    const tapes = new Map<string, Candle[]>();
    for (const [key, minutes] of strikes) tapes.set(key, [...minutes.values()].sort((a, b) => a.time - b.time));
    out.set(day, tapes);
  }
  return out;
}

/**
 * The time value left at the session's last minute, from the strike whose call and put are closest in price
 * (the at-the-money strike): with no time value, call − put is the intrinsic value, so what is left is twice
 * the cheaper side.
 */
function lastTimeValue(tapes: Map<string, Candle[]>) {
  let last = 0;
  for (const tape of tapes.values()) last = Math.max(last, tape.at(-1)?.time ?? 0);
  let best: { gap: number; value: number } | null = null;
  for (const key of tapes.keys()) {
    if (!key.startsWith("CE:")) continue;
    const ce = tapes.get(key)?.find((candle) => candle.time === last)?.close;
    const pe = tapes.get(`PE:${key.slice(3)}`)?.find((candle) => candle.time === last)?.close;
    if (ce == null || pe == null) continue;
    const gap = Math.abs(ce - pe);
    if (!best || gap < best.gap) best = { gap, value: 2 * Math.min(ce, pe) };
  }
  return best?.value ?? null;
}

/**
 * Which days were weekly expiry days: at the session's last minute the nearest weekly at-the-money options
 * have no more than `tolerance` points of time value left. Each day's expiry is then the first expiry day on
 * or after it; days after the last expiry in the range have none known (null).
 */
export function weeklyExpiries(tapes: ExpiredTapes, tolerance = 5): Map<string, string | null> {
  const days = [...tapes.keys()].sort();
  const expiring = days.filter((day) => {
    const value = lastTimeValue(tapes.get(day)!);
    return value != null && value <= tolerance;
  });
  return new Map(days.map((day) => [day, expiring.find((expiry) => expiry >= day) ?? null]));
}

/** A day's contract list from its expired tapes: every strike seen, each side with a backtest-only id. */
export function expiredChain(input: { symbol: string; date: string; expiry: string | null; lotSize: number; tapes: Map<string, Candle[]> }): ReplayChain {
  const strikes = [...new Set([...input.tapes.keys()].map((key) => Number(key.split(":")[1])))].sort((a, b) => a - b);
  const id = (strike: number, right: "CE" | "PE") => (input.tapes.has(`${right}:${strike}`) ? `expired:${input.date}:${right}:${strike}` : null);
  return { symbol: input.symbol, expiry: input.expiry ?? `weekly after ${input.date}`, kind: "index", lotSize: input.lotSize, strikes: strikes.map((strike) => ({ strike, ce: { securityId: id(strike, "CE") }, pe: { securityId: id(strike, "PE") } })) };
}

/** The tape for a backtest-only contract id (`expired:date:right:strike`). */
export function expiredTape(tapes: Map<string, Candle[]>, securityId: string): Candle[] {
  const [, , right, strike] = securityId.split(":");
  return tapes.get(`${right}:${strike}`) ?? [];
}
