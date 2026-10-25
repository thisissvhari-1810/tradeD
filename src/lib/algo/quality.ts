import type { Direction } from "./patterns";

/**
 * A transparent setup-quality score (0–100) from measurable conditions. It is not a probability: each
 * part says what it measured and how many of its points it earned, and the minimum to trade is a setting
 * to calibrate with the backtest.
 */

export type ScorePart = { label: string; points: number; max: number; why: string };
export type SetupScore = { score: number; parts: ScorePart[] };

export type ScoreInput = {
  direction: Direction;
  /** The session's swing structure from the trendline engine. */
  structure: "BULLISH" | "BEARISH" | "SIDEWAYS" | "UNCONFIRMED";
  /** 9 / 21 EMA of the session's closes (null with too few candles). */
  momentum: { fast: number; slow: number } | null;
  /** The signal candle. */
  candle: { open: number; high: number; low: number; close: number };
  /** How many strategies agreed on the candle. */
  agreeing: number;
  volume: "CONFIRMED" | "WEAK" | "UNAVAILABLE" | "NOT_REQUIRED";
  /** Room to the next opposing level divided by the stop distance (Infinity when none is known). */
  rewardRisk: number;
  minRewardRisk: number;
  /** Round-trip charges as a share of the planned reward (0.1 = 10%). */
  costShare: number;
};

export function setupScore(input: ScoreInput): SetupScore {
  const bull = input.direction === "CALL";
  const parts: ScorePart[] = [];
  const agrees = input.structure === (bull ? "BULLISH" : "BEARISH");
  const against = input.structure === (bull ? "BEARISH" : "BULLISH");
  parts.push({ label: "Trend alignment", max: 20, points: agrees ? 20 : against ? 0 : 10, why: `Swing structure ${input.structure.toLowerCase()}${agrees ? ", with the trade" : against ? ", against the trade" : ""}.` });
  if (input.momentum) {
    const up = input.momentum.fast > input.momentum.slow;
    const with_ = bull ? up : !up;
    parts.push({ label: "Momentum", max: 15, points: with_ ? 15 : 0, why: `9 EMA ${input.momentum.fast.toFixed(2)} ${up ? ">" : "≤"} 21 EMA ${input.momentum.slow.toFixed(2)}.` });
  } else parts.push({ label: "Momentum", max: 15, points: 7, why: "Too few candles for the 21 EMA yet (neutral)." });
  const range = input.candle.high - input.candle.low;
  const body = input.candle.close - input.candle.open;
  const inDirection = bull ? body > 0 : body < 0;
  const strong = inDirection && range > 0 && Math.abs(body) / range >= 0.5;
  parts.push({ label: "Confirmation candle", max: 20, points: strong ? 20 : inDirection ? 10 : 0, why: range > 0 ? `Body ${Math.round((Math.abs(body) / range) * 100)}% of the range, ${inDirection ? "in" : "against"} the trade's direction.` : "No range." });
  parts.push({ label: "Confluence", max: 15, points: input.agreeing >= 2 ? 15 : 8, why: `${input.agreeing} strateg${input.agreeing === 1 ? "y" : "ies"} agreed.` });
  const rr = input.rewardRisk;
  parts.push({ label: "Room (reward : risk)", max: 15, points: rr >= input.minRewardRisk * 1.5 ? 15 : rr >= input.minRewardRisk ? 10 : 0, why: Number.isFinite(rr) ? `${rr.toFixed(1)} : 1 to the next opposing level.` : "No opposing level within reach." });
  parts.push({ label: "Volume", max: 5, points: input.volume === "CONFIRMED" ? 5 : input.volume === "WEAK" ? 0 : 3, why: input.volume === "CONFIRMED" ? "Above its 20-candle average." : input.volume === "WEAK" ? "Below 1.2× its 20-candle average." : "No reliable volume for this instrument (neutral)." });
  parts.push({ label: "Costs", max: 10, points: input.costShare <= 0.05 ? 10 : input.costShare <= 0.15 ? 5 : 0, why: `Round-trip charges ≈ ${Math.round(input.costShare * 100)}% of the planned reward.` });
  return { score: parts.reduce((sum, part) => sum + part.points, 0), parts };
}
