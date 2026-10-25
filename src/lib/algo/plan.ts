import { analyzeTrend, AUTO_TREND_DEFAULTS, averageRange, linePrice, type Structure } from "@/lib/chart/trend-engine";
import { ATM_DELTA, type RiskSettings } from "./sizing";

/**
 * The provisional pre-market plan for one session, from data that exists before 09:15: the previous day's
 * OHLC, recent daily candles (volatility, gaps, swing levels and trendlines) and, once the session has
 * opened, its actual opening gap. It lists scenarios with their trigger, invalidation and entry zone; it is
 * never a forecast — previous-day information is context, not proof of today's direction.
 */

type Bar = { time: number; open: number; high: number; low: number; close: number; volume?: number };
export type PlanLevel = { price: number; label: string; kind: "RESISTANCE" | "SUPPORT" | "REFERENCE" };
export type Scenario = { title: string; trigger: string; level: number; invalidation: string; entryZone: string };

export type MarketPlan = {
  date: string;
  underlying: string;
  provisional: true;
  previous: { date: string; high: number; low: number; close: number; range: number };
  /** Known only once the session has opened (null before 09:15). */
  gap: { open: number; points: number; percent: number } | null;
  volatility: { atr: number | null; averageRange: number | null; averageGapPercent: number | null; gapsUp: number; gapsDown: number; days: number };
  dailyStructure: Structure;
  levels: PlanLevel[];
  bullish: Scenario[];
  bearish: Scenario[];
  risk: { perTrade: number; dailyLoss: number; dailyTarget: number; lotSize: number | null; maxIndexStop: number | null; minRewardRisk: number };
  notes: string[];
};

const round = (value: number) => Math.round(value * 100) / 100;
const fmt = (value: number) => value.toFixed(2);

export function buildPlan(input: {
  date: string;
  underlying: string;
  previous: { date: string; high: number; low: number; close: number };
  /** Completed daily candles before the session, oldest first. */
  daily: Bar[];
  /** The session's opening price, once known. */
  open: number | null;
  risk: RiskSettings;
  maxDailyLoss: number;
  lotSize: number | null;
  orbMinutes: number;
}): MarketPlan {
  const { previous, risk } = input;
  const daily = input.daily.slice(-60);
  const recent = daily.slice(-20);
  const gaps = recent.slice(1).map((bar, index) => (bar.open - recent[index].close) / recent[index].close);
  const trend = daily.length >= 10 ? analyzeTrend(daily.map((bar) => ({ ...bar, volume: bar.volume ?? 0 })), null, { ...AUTO_TREND_DEFAULTS, left: 2, right: 2, observationMinutes: 0, lookback: 60 }) : null;
  const next = daily.length; // the session's index, one after the last daily candle

  const levels: PlanLevel[] = [
    { price: previous.high, label: "Previous-day high", kind: "RESISTANCE" },
    { price: previous.low, label: "Previous-day low", kind: "SUPPORT" },
    { price: previous.close, label: "Previous-day close", kind: "REFERENCE" },
  ];
  if (recent.length >= 5) {
    levels.push({ price: Math.max(...recent.map((bar) => bar.high)), label: `${recent.length}-day high`, kind: "RESISTANCE" });
    levels.push({ price: Math.min(...recent.map((bar) => bar.low)), label: `${recent.length}-day low`, kind: "SUPPORT" });
  }
  if (trend?.phase === "ACTIVE") {
    if (trend.resistance) levels.push({ price: round(linePrice(trend.resistance, next)), label: "Daily resistance trendline (projected)", kind: "RESISTANCE" });
    if (trend.support) levels.push({ price: round(linePrice(trend.support, next)), label: "Daily support trendline (projected)", kind: "SUPPORT" });
    for (const level of trend.levels) levels.push({ price: level.price, label: `Daily ${level.kind === "SUPPORT" ? "equal lows" : "equal highs"}`, kind: level.kind });
  }
  const unique = levels
    .map((level) => ({ ...level, price: round(level.price) }))
    .filter((level, index, all) => all.findIndex((other) => other.label === level.label) === index)
    .sort((a, b) => b.price - a.price);

  const tolerance = previous.close * 0.001;
  const above = (price: number) => unique.filter((level) => level.price > price + tolerance).sort((a, b) => a.price - b.price)[0];
  const below = (price: number) => unique.filter((level) => level.price < price - tolerance).sort((a, b) => b.price - a.price)[0];
  const room = (from: number, to: PlanLevel | undefined) => (to ? `next level ${to.label} ${fmt(to.price)} (${fmt(Math.abs(to.price - from))} points)` : "no mapped level beyond");

  const bullish: Scenario[] = [
    { title: "Breakout above the previous-day high", trigger: `A 1-minute candle whose body closes above ${fmt(previous.high)}`, level: previous.high, invalidation: `A close back below ${fmt(previous.high)}`, entryZone: `${fmt(previous.high)}–${fmt(previous.high * 1.001)}; ${room(previous.high, above(previous.high))}` },
    { title: "Bounce at the previous-day low", trigger: `Price reaches ${fmt(previous.low)} and a candle closes back above it with a long lower wick or an engulfing`, level: previous.low, invalidation: "A close below the rejection candle's low", entryZone: `${fmt(previous.low)}–${fmt(previous.low * 1.001)}; ${room(previous.low, above(previous.low))}` },
    { title: `Opening-range breakout (first ${input.orbMinutes} min)`, trigger: `After 09:${String(15 + input.orbMinutes).padStart(2, "0")}, the first body close above the opening-range high`, level: NaN, invalidation: "A close back inside the range", entryZone: "Just above the opening-range high" },
  ];
  const bearish: Scenario[] = [
    { title: "Breakdown below the previous-day low", trigger: `A 1-minute candle whose body closes below ${fmt(previous.low)}`, level: previous.low, invalidation: `A close back above ${fmt(previous.low)}`, entryZone: `${fmt(previous.low * 0.999)}–${fmt(previous.low)}; ${room(previous.low, below(previous.low))}` },
    { title: "Rejection at the previous-day high", trigger: `Price reaches ${fmt(previous.high)} and a candle closes back below it with a long upper wick or an engulfing`, level: previous.high, invalidation: "A close above the rejection candle's high", entryZone: `${fmt(previous.high * 0.999)}–${fmt(previous.high)}; ${room(previous.high, below(previous.high))}` },
    { title: `Opening-range breakdown (first ${input.orbMinutes} min)`, trigger: `After 09:${String(15 + input.orbMinutes).padStart(2, "0")}, the first body close below the opening-range low`, level: NaN, invalidation: "A close back inside the range", entryZone: "Just below the opening-range low" },
  ];

  const perTrade = round((risk.capital * risk.perTradePercent) / 100);
  const maxIndexStop = input.lotSize ? round(perTrade / (ATM_DELTA * input.lotSize)) : null;
  const gap = input.open != null ? { open: input.open, points: round(input.open - previous.close), percent: round(((input.open - previous.close) / previous.close) * 100) } : null;
  const notes = [
    "Provisional: built from data available before the session. Previous-day levels are context, not a prediction of today's direction.",
    `Opening behaviour is from daily candles only (gaps over the last ${Math.max(0, recent.length - 1)} sessions); intraday opening statistics need more history than is loaded.`,
  ];
  if (maxIndexStop != null) notes.push(`With ₹${perTrade} risk per trade and a lot of ${input.lotSize}, a 1-lot trade's index stop can be at most about ${fmt(maxIndexStop)} points away (before charges); a wider setup is skipped.`);
  if (gap) notes.push(`Opened ${gap.points >= 0 ? "up" : "down"} ${fmt(Math.abs(gap.points))} points (${gap.percent}%) from the previous close.`);
  return {
    date: input.date,
    underlying: input.underlying,
    provisional: true,
    previous: { ...previous, range: round(previous.high - previous.low) },
    gap,
    volatility: {
      atr: daily.length >= 15 ? round(averageRange(daily.slice(-14))) : null,
      averageRange: recent.length ? round(recent.reduce((sum, bar) => sum + (bar.high - bar.low), 0) / recent.length) : null,
      averageGapPercent: gaps.length ? round((gaps.reduce((sum, value) => sum + Math.abs(value), 0) / gaps.length) * 100) : null,
      gapsUp: gaps.filter((value) => value > 0).length,
      gapsDown: gaps.filter((value) => value < 0).length,
      days: recent.length,
    },
    dailyStructure: trend?.phase === "ACTIVE" ? trend.structure : "UNCONFIRMED",
    levels: unique,
    bullish,
    bearish,
    risk: { perTrade, dailyLoss: input.maxDailyLoss, dailyTarget: risk.dailyTarget, lotSize: input.lotSize, maxIndexStop, minRewardRisk: risk.minRewardRisk },
    notes,
  };
}
