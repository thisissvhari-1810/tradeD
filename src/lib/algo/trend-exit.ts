import type { Candle } from "./lines";

/**
 * Trend-aware exit management for an open Mathi Strategy trade (optional; the fixed time limit stays the default).
 * At the time checkpoint the trade is kept only while the index trend still supports it; a confirmed reversal
 * closes it; a hard stop-loss, the maximum holding time and the daily loss limit always come first. Every check
 * uses completed 1-minute index candles up to the decision time only (never a later candle).
 */

export type ExitMode = "fixed" | "trend";

export type ExitManagement = {
  /** "fixed": exit at the time limit (maxHoldMinutes). "trend": at the time limit (the checkpoint), keep only while the trend agrees. */
  mode: ExitMode;
  /** Trend mode: the hard maximum holding time, minutes from the entry (always exits). */
  maxHoldMinutes: number;
  /** How many of the 5 trend checks must agree to keep holding (1–5). */
  minScore: number;
  /** Trailing stop after the checkpoint: % below the highest premium since the checkpoint (0 = off). */
  trailPercent: number;
  /** Recovery exit: after the checkpoint, exit as soon as the premium is back at the entry (charges covered). */
  recoveryExit: boolean;
  /** Also exit before the checkpoint on a confirmed reversal (all 5 checks against the trade). */
  reversalBeforeCheckpoint: boolean;
  /** Hold past the checkpoint only while the day's realized P&L plus this trade's open loss stays above −₹this (0 = no cap). */
  maxLossRupees: number;
};

export const EXIT_MANAGEMENT_DEFAULTS: ExitManagement = { mode: "fixed", maxHoldMinutes: 90, minScore: 4, trailPercent: 0, recoveryExit: false, reversalBeforeCheckpoint: false, maxLossRupees: 0 };

export type TrendCheck = { name: string; agrees: boolean | null; detail: string };
export type TrendVerdict = { score: number; against: number; checks: TrendCheck[]; summary: string };

const ema = (values: number[], period: number) => {
  const k = 2 / (period + 1);
  let value: number | null = null;
  for (const item of values) value = value == null ? item : value + k * (item - value);
  return value;
};

/** Completed 5-minute candles (09:15, 09:20, …) from completed 1-minute candles. */
export function fiveMinute(candles: Candle[], sessionOpen: number): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const candle of candles) {
    const start = sessionOpen + Math.floor((candle.time - sessionOpen) / 300) * 300;
    if (!buckets.has(start)) buckets.set(start, []);
    buckets.get(start)!.push(candle);
  }
  return [...buckets.entries()]
    .filter(([, group]) => group.length === 5)
    .sort(([a], [b]) => a - b)
    .map(([time, group]) => ({ time, open: group[0].open, high: Math.max(...group.map((c) => c.high)), low: Math.min(...group.map((c) => c.low)), close: group.at(-1)!.close, volume: group.reduce((sum, c) => sum + (c.volume ?? 0), 0) }));
}

/**
 * The index trend for a CALL (up) or PUT (down) from completed candles only (`candles` must already exclude any
 * candle not finished at the decision time). Five checks, each agreeing, disagreeing or unknown (too few candles):
 * 1-minute 9/21 EMA, 5-minute 3/6 EMA, price against the session VWAP (time-weighted if volume is missing),
 * 5-minute momentum, and the last 10 minutes' swing structure (lower highs and lows for a PUT).
 */
export function trendVerdict(candles: Candle[], side: "CALL" | "PUT", sessionOpen: number): TrendVerdict {
  const up = side === "CALL";
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const closes = sorted.map((candle) => candle.close);
  const last = sorted.at(-1);
  const checks: TrendCheck[] = [];
  const add = (name: string, agrees: boolean | null, detail: string) => checks.push({ name, agrees, detail });

  const fast = closes.length >= 21 ? ema(closes, 9) : null;
  const slow = closes.length >= 21 ? ema(closes, 21) : null;
  add("1-min EMA", fast == null || slow == null ? null : up ? fast > slow : fast < slow, fast == null || slow == null ? "fewer than 21 candles" : `9 EMA ${fast.toFixed(2)} ${fast > slow ? ">" : "≤"} 21 EMA ${slow!.toFixed(2)}`);

  const five = fiveMinute(sorted, sessionOpen);
  const fiveCloses = five.map((candle) => candle.close);
  const f3 = fiveCloses.length >= 6 ? ema(fiveCloses, 3) : null;
  const f6 = fiveCloses.length >= 6 ? ema(fiveCloses, 6) : null;
  add("5-min EMA", f3 == null || f6 == null ? null : up ? f3 > f6 : f3 < f6, f3 == null || f6 == null ? "fewer than 6 five-minute candles" : `3 EMA ${f3.toFixed(2)} ${f3 > f6! ? ">" : "≤"} 6 EMA ${f6!.toFixed(2)}`);

  const volume = sorted.reduce((sum, candle) => sum + (candle.volume ?? 0), 0);
  const typical = (candle: Candle) => (candle.high + candle.low + candle.close) / 3;
  const vwap = sorted.length ? (volume > 0 ? sorted.reduce((sum, candle) => sum + typical(candle) * (candle.volume ?? 0), 0) / volume : sorted.reduce((sum, candle) => sum + typical(candle), 0) / sorted.length) : null;
  add("VWAP", vwap == null || !last ? null : up ? last.close > vwap : last.close < vwap, vwap == null || !last ? "no candles" : `close ${last.close.toFixed(2)} ${last.close > vwap ? "above" : "at or below"} ${volume > 0 ? "VWAP" : "session average (no volume)"} ${vwap.toFixed(2)}`);

  const back = sorted.length >= 6 ? sorted[sorted.length - 6].close : null;
  add("Momentum", back == null || !last ? null : up ? last.close > back : last.close < back, back == null || !last ? "fewer than 6 candles" : `close ${last.close.toFixed(2)} vs ${back.toFixed(2)} five minutes earlier`);

  if (sorted.length >= 10) {
    const recent = sorted.slice(-5);
    const prior = sorted.slice(-10, -5);
    const hi = (list: Candle[]) => Math.max(...list.map((c) => c.high));
    const lo = (list: Candle[]) => Math.min(...list.map((c) => c.low));
    const agrees = up ? hi(recent) > hi(prior) && lo(recent) > lo(prior) : hi(recent) < hi(prior) && lo(recent) < lo(prior);
    add("Swing structure", agrees, `last 5 min high ${hi(recent).toFixed(2)} / low ${lo(recent).toFixed(2)} vs previous 5 min ${hi(prior).toFixed(2)} / ${lo(prior).toFixed(2)}`);
  } else add("Swing structure", null, "fewer than 10 candles");

  const score = checks.filter((check) => check.agrees === true).length;
  const against = checks.filter((check) => check.agrees === false).length;
  return { score, against, checks, summary: checks.map((check) => `${check.name} ${check.agrees == null ? "n/a" : check.agrees ? "✓" : "✗"}`).join(", ") };
}

export type ExitDecision = { action: "hold" | "exit"; reason?: string; label?: string; note: string };

/**
 * The trend-mode decision for one minute after (or, with reversalBeforeCheckpoint, before) the checkpoint. The
 * caller has already applied the hard stop-loss and the target (protective exits always come first).
 */
export function trendExitDecision(input: {
  settings: ExitManagement;
  side: "CALL" | "PUT";
  elapsedMinutes: number;
  checkpointMinutes: number;
  verdict: TrendVerdict;
  premium: number;
  entry: number;
  chargesPerUnit: number;
  highestSinceCheckpoint: number | null;
  dailyLossExceeded: boolean;
}): ExitDecision {
  const { settings, verdict } = input;
  const past = input.elapsedMinutes >= input.checkpointMinutes;
  const reversal = verdict.against === verdict.checks.length;
  if (!past) {
    if (settings.reversalBeforeCheckpoint && reversal) return { action: "exit", reason: "REVERSAL", note: `Confirmed reversal before the checkpoint: ${verdict.summary}` };
    return { action: "hold", note: "" };
  }
  if (input.elapsedMinutes >= settings.maxHoldMinutes) return { action: "exit", reason: "MAX_HOLD", note: `Maximum holding time ${settings.maxHoldMinutes} min reached` };
  if (input.dailyLossExceeded) return { action: "exit", reason: "RISK", note: "The daily loss limit would be exceeded by holding on" };
  if (reversal) return { action: "exit", reason: "REVERSAL", note: `Confirmed reversal: ${verdict.summary}` };
  if (settings.trailPercent > 0 && input.highestSinceCheckpoint != null && input.premium <= input.highestSinceCheckpoint * (1 - settings.trailPercent / 100)) {
    return { action: "exit", reason: "TRAIL", note: `Trailing stop: ${settings.trailPercent}% below ₹${input.highestSinceCheckpoint.toFixed(2)}` };
  }
  if (settings.recoveryExit && input.premium >= input.entry + input.chargesPerUnit) return { action: "exit", reason: "RECOVERY", note: `Premium back at the entry (₹${input.entry.toFixed(2)} + charges)` };
  if (verdict.score < settings.minScore) return { action: "exit", reason: "TIME", note: `Time checkpoint ${input.checkpointMinutes} min: trend not confirmed (${verdict.score}/${verdict.checks.length}: ${verdict.summary})` };
  return { action: "hold", note: `Held past the ${input.checkpointMinutes}-min checkpoint: trend confirmed (${verdict.score}/${verdict.checks.length}: ${verdict.summary})` };
}
