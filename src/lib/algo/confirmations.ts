import { ema } from "@/lib/market/indicators";
import type { Candle } from "./lines";
import { strongCandle, volumeCheck, type Direction, type StrategyId } from "./patterns";

/**
 * Intratrade confirmations: after entry, whether the trade's own setup still holds, strengthens, weakens
 * or is invalidated. They inform (and are logged when they change); they never place, reverse or skip an
 * order — exits stay with the stop-loss, target and the user. Only completed candles are used, and a
 * value that cannot be evaluated is UNAVAILABLE rather than assumed.
 */

export type ConfirmationCategory = "price" | "level" | "candle" | "volume" | "momentum" | "risk";
export type ConfirmationStatus =
  | "WAITING" | "CONFIRMED" | "STRENGTHENING" | "HOLDING" | "WEAKENING" | "RETEST IN PROGRESS" | "RETEST CONFIRMED"
  | "CONFLICTING SIGNAL" | "SETUP INVALIDATED" | "EXIT CONDITION TRIGGERED" | "UNAVAILABLE";

export type Confirmation = {
  category: ConfirmationCategory;
  label: string;
  status: ConfirmationStatus;
  /** The latest observed value (a close, a level, a premium, a volume ratio), when there is one. */
  value: number | null;
  /** When the value was last valid (unix seconds; the end of its candle). */
  time: number | null;
  why: string;
};

/** What a trade was entered on: its strategy, direction, the broken level and its invalidation. */
export type TradeSetup = {
  strategy: StrategyId;
  /** Every strategy that agreed on the entry candle. */
  strategies: StrategyId[];
  direction: Direction;
  /** The broken level on the underlying (crossed line, trendline price or neckline). */
  level: number;
  /** A close back beyond this invalidates the setup. */
  invalidation: number;
  /** The underlying's close on the signal candle. */
  underlyingEntry: number;
  /** When the position was opened (unix seconds). */
  entryTime: number;
};

export const CONFIRMATION_LABEL: Record<ConfirmationCategory, string> = { price: "Price action", level: "Breakout level", candle: "Candle", volume: "Volume", momentum: "Momentum", risk: "Risk / exit" };

const fmt = (value: number) => value.toFixed(2);

export function tradeConfirmations(input: {
  setup: TradeSetup;
  /** The session's completed underlying candles up to now. */
  candles: Candle[];
  /** The option's latest valid premium with its stop-loss and target, or null when unavailable. */
  premium: { value: number; asOf: number; stop: number; target: number } | null;
  now: number;
}): Confirmation[] {
  const { setup, candles, premium, now } = input;
  const sign = setup.direction === "CALL" ? 1 : -1;
  const after = candles.filter((candle) => candle.time + 60 > setup.entryTime);
  const last = candles.at(-1) ?? null;
  const at = last ? last.time + 60 : null;
  const list: Confirmation[] = [];
  const add = (category: ConfirmationCategory, status: ConfirmationStatus, value: number | null, why: string, time: number | null = at) => list.push({ category, label: CONFIRMATION_LABEL[category], status, value, time, why });

  if (!last || !after.length) {
    add("price", "WAITING", setup.underlyingEntry, "Waiting for the first completed candle after entry.");
  } else {
    // Price action: the underlying's close against the signal close and the setup's invalidation.
    const invalid = sign * (last.close - setup.invalidation) < 0;
    const move = sign * (last.close - setup.underlyingEntry);
    if (invalid) add("price", "SETUP INVALIDATED", last.close, `Closed at ${fmt(last.close)}, beyond the setup's invalidation ${fmt(setup.invalidation)}.`);
    else if (move >= setup.underlyingEntry * 0.001) add("price", "STRENGTHENING", last.close, `Closed ${fmt(Math.abs(move))} points ${setup.direction === "CALL" ? "above" : "below"} the signal close.`);
    else if (move >= 0) add("price", "HOLDING", last.close, "Holding the signal close.");
    else add("price", "WEAKENING", last.close, `Closed ${fmt(Math.abs(move))} points against the trade since the signal.`);

    // Breakout level: still holding, retested (and held), or lost.
    const beyond = (close: number) => sign * (close - setup.level) > 0;
    const touched = (candle: Candle) => (setup.direction === "CALL" ? candle.low <= setup.level : candle.high >= setup.level);
    const touchIndex = after.findIndex(touched);
    if (!beyond(last.close)) add("level", "SETUP INVALIDATED", setup.level, `Closed back ${setup.direction === "CALL" ? "below" : "above"} the broken level ${fmt(setup.level)}.`);
    else if (touchIndex === after.length - 1) add("level", "RETEST IN PROGRESS", setup.level, `The last candle came back to the level ${fmt(setup.level)} and closed beyond it.`);
    else if (touchIndex >= 0) add("level", "RETEST CONFIRMED", setup.level, `Retested ${fmt(setup.level)} at ${new Date((after[touchIndex].time + 19_800) * 1000).toISOString().slice(11, 16)} and held.`);
    else add("level", "HOLDING", setup.level, `Price has stayed ${setup.direction === "CALL" ? "above" : "below"} the broken level ${fmt(setup.level)}.`);

    // Candle: a decisive body in the trade's direction, or a strong opposite candle.
    const opposite: Direction = setup.direction === "CALL" ? "PUT" : "CALL";
    if (strongCandle(last, setup.direction)) add("candle", "CONFIRMED", last.close, `Strong ${setup.direction === "CALL" ? "bullish" : "bearish"} body (at least half the candle's range).`);
    else if (strongCandle(last, opposite)) add("candle", "WEAKENING", last.close, `Strong ${setup.direction === "CALL" ? "bearish" : "bullish"} candle against the trade.`);
    else add("candle", "HOLDING", last.close, "No decisive candle either way.");

    // Volume: only where the feed provides it (index candles usually do not).
    const volume = volumeCheck(candles, candles.length - 1);
    if (volume === "UNAVAILABLE") add("volume", "UNAVAILABLE", null, "The feed has no reliable volume for this instrument.", null);
    else add("volume", volume === "CONFIRMED" ? "CONFIRMED" : "WEAKENING", last.volume ?? null, volume === "CONFIRMED" ? "Volume above 1.2× its 20-candle average." : "Volume below 1.2× its 20-candle average.");

    // Momentum: 9 / 21 EMA of closes.
    const closes = candles.map((candle) => candle.close);
    const fast = ema(closes, 9).at(-1);
    const slow = ema(closes, 21).at(-1);
    if (fast == null || slow == null) add("momentum", "UNAVAILABLE", null, "Needs 21 completed candles for the 9 / 21 EMA.", null);
    else if (sign * (fast - slow) > 0) add("momentum", "CONFIRMED", Math.round((fast - slow) * 100) / 100, `9 EMA ${setup.direction === "CALL" ? "above" : "below"} the 21 EMA.`);
    else add("momentum", "CONFLICTING SIGNAL", Math.round((fast - slow) * 100) / 100, `9 EMA ${setup.direction === "CALL" ? "below" : "above"} the 21 EMA: momentum is against the trade.`);
  }

  // Risk: the option's own premium against its stop-loss and target.
  if (!premium) add("risk", "UNAVAILABLE", null, "No valid option premium for this time.", null);
  else {
    const stale = now - premium.asOf > 120;
    const room = Math.max(0.01, premium.target - premium.stop);
    const staleNote = stale ? ` (last valid premium, ${Math.round((now - premium.asOf) / 60)} min old)` : "";
    if (premium.value <= premium.stop) add("risk", "EXIT CONDITION TRIGGERED", premium.value, `Premium ${fmt(premium.value)} at or below the stop-loss ${fmt(premium.stop)}${staleNote}.`, premium.asOf);
    else if (premium.value >= premium.target) add("risk", "EXIT CONDITION TRIGGERED", premium.value, `Premium ${fmt(premium.value)} at or above the target ${fmt(premium.target)}${staleNote}.`, premium.asOf);
    else if ((premium.value - premium.stop) / room < 0.25) add("risk", "WEAKENING", premium.value, `Premium ${fmt(premium.value)} is close to the stop-loss ${fmt(premium.stop)}${staleNote}.`, premium.asOf);
    else if ((premium.target - premium.value) / room < 0.25) add("risk", "STRENGTHENING", premium.value, `Premium ${fmt(premium.value)} is close to the target ${fmt(premium.target)}${staleNote}.`, premium.asOf);
    else add("risk", "HOLDING", premium.value, `Premium ${fmt(premium.value)}: ${fmt(premium.value - premium.stop)} above the stop-loss, ${fmt(premium.target - premium.value)} below the target${staleNote}.`, premium.asOf);
  }
  return list;
}

/** Confirmations whose status changed since the previous check (only those are logged). */
export function changedConfirmations(previous: Confirmation[] | null | undefined, next: Confirmation[]) {
  const before = new Map((previous ?? []).map((item) => [item.category, item.status]));
  return next.filter((item) => before.get(item.category) !== item.status);
}
