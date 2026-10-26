import { describe, expect, it } from "vitest";
import type { Candle } from "../src/lib/algo/lines";
import { openingRange, openingRangeBreak, sessionZones, zoneReaction } from "../src/lib/algo/setups";
import { planTrade, RISK_DEFAULTS, type PlanInput } from "../src/lib/algo/sizing";
import { setupScore } from "../src/lib/algo/quality";
import { analyzeTrend, AUTO_TREND_DEFAULTS } from "../src/lib/chart/trend-engine";
import { readAlgoConfig } from "../src/lib/algo/config";
import { ALGO_DEFAULTS, ENGINE_LABEL } from "../src/lib/algo/runner";

const OPEN = Date.UTC(2026, 9, 16, 3, 45) / 1000;
const T = (index: number) => OPEN + index * 60;
const candle = (index: number, open: number, high: number, low: number, close: number): Candle => ({ time: T(index), open, high, low, close });
const flat = (count: number, price: number) => Array.from({ length: count }, (_, index) => candle(index, price, price + 2, price - 2, price));

describe("defaults: the early session replaces the old all-day settings", () => {
  it("Mathi Strategy defaults: lines only, 50% of the body past the line, full ₹1,00,000 in whole lots, +3% on the premium, no stop-loss, 3 entries, no entry cutoff", () => {
    expect(ALGO_DEFAULTS).toMatchObject({ entryStart: "09:15", entryCutoff: "15:30", observationMinutes: 0, sizing: "capital", allocation: { percent: 100, maxCapital: 100_000 }, lots: 50, target: { mode: "percent", value: 3 }, stopLoss: false, crossRule: "body", crossPercent: 50, maxTrades: 3, stopAtLimit: false, maxDailyLoss: 2_000, risk: { dailyTarget: 3_000, stopAtTarget: true } });
    expect(ALGO_DEFAULTS.strategies).toEqual({ line: true, trendline: false, w: false, m: false, orb: false, bounce: false, rejection: false });
    expect(ALGO_DEFAULTS.filters).toEqual({ levelBlockMinutes: 0, breakoutBufferPercent: 0, secondCandle: false, momentum: false });
    expect([ALGO_DEFAULTS.structureStop, ALGO_DEFAULTS.maxHoldMinutes]).toEqual([false, 30]);
    // Old saved settings (any version) move once; the other setups can never be switched on for Mathi.
    const migrated = readAlgoConfig({ settingsVersion: 6, sizing: "risk", lots: 10, strategies: { w: true, m: true, bounce: true }, filters: { secondCandle: true, momentum: true } });
    expect(migrated).toMatchObject({ sizing: "capital", lots: 50, stopLoss: false, crossPercent: 50, maxTrades: 3, filters: ALGO_DEFAULTS.filters, strategies: ALGO_DEFAULTS.strategies });
    const kept = readAlgoConfig({ ...migrated, lots: 2, maxTrades: 3, filters: { ...migrated.filters, secondCandle: true }, strategies: { w: true } });
    expect([kept.lots, kept.filters.secondCandle, kept.strategies.w]).toEqual([2, true, false]);
    expect(Object.values(ENGINE_LABEL)).toEqual(["BUY / LONG CANDIDATE", "SELL / SHORT CANDIDATE", "WAIT FOR CONFIRMATION", "NO TRADE", "DAILY RISK LIMIT REACHED", "TRADING WINDOW CLOSED"]);
  });
});

describe("opening-range breakout", () => {
  const range = flat(15, 100).map((item, index) => ({ ...item, high: index === 4 ? 105 : 102, low: index === 9 ? 95 : 98 }));
  it("is building until its last candle closes; then the first body close above the high is a CALL, once", () => {
    expect(openingRangeBreak(range.slice(0, 10), openingRange(range.slice(0, 10), OPEN, 15), 0).status).toContain("BUILDING");
    const breakout = [...range, candle(15, 101, 104, 100, 103), candle(16, 103, 107, 102.5, 106)];
    const orb = openingRange(breakout, OPEN, 15);
    expect(orb).toMatchObject({ high: 105, low: 95, complete: true });
    expect(openingRangeBreak(breakout, orb, 0).hit).toMatchObject({ direction: "CALL", level: 105, invalidation: 105 });
    const again = [...breakout, candle(17, 106, 106.5, 104, 104.5), candle(18, 104.5, 108, 104, 107)];
    expect(openingRangeBreak(again, openingRange(again, OPEN, 15), 0).hit).toBeNull();
  });
  it("a gap open beyond the range is not a body crossing", () => {
    const gap = [...range, candle(15, 106, 108, 105.5, 107)];
    expect(openingRangeBreak(gap, openingRange(gap, OPEN, 15), 0).hit).toBeNull();
  });
});

describe("support bounce and resistance rejection", () => {
  const zones = [{ price: 100, label: "previous-day low" }, { price: 110, label: "previous-day high" }];
  it("a bounce needs the approach from above, a touch, a bullish close back above and a long lower wick", () => {
    const bounce = [candle(0, 103, 103.5, 101.5, 102), candle(1, 101, 101.6, 99.98, 101.5)];
    expect(zoneReaction(bounce, zones, 0.03, "CALL").hit).toMatchObject({ direction: "CALL", level: 100, invalidation: 99.98 });
    // Closed below the zone: no bounce. No rejection wick: no bounce.
    expect(zoneReaction([bounce[0], candle(1, 102, 102.4, 99, 99.5)], zones, 0.03, "CALL").hit).toBeNull();
    expect(zoneReaction([bounce[0], candle(1, 100.1, 101.6, 100, 101.5)], zones, 0.03, "CALL").hit).toBeNull();
  });
  it("a rejection is the mirror image at resistance", () => {
    const reject = [candle(0, 107, 108.5, 106.5, 108), candle(1, 109, 110.02, 108.3, 108.5)];
    expect(zoneReaction(reject, zones, 0.03, "PUT").hit).toMatchObject({ direction: "PUT", level: 110, invalidation: 110.02 });
  });
  it("zones merge within tolerance and include the opening range once it is complete", () => {
    const trend = analyzeTrend(flat(30, 100).map((item) => ({ ...item, volume: 0 })), 60, { ...AUTO_TREND_DEFAULTS, observationMinutes: 0 });
    const merged = sessionZones([{ price: 100, label: "A" }, { price: 100.01, label: "B" }], trend, { high: 102, low: 98, end: T(15), complete: true }, 29, 0.03);
    expect(merged.map((zone) => [zone.price, zone.label])).toEqual([[98, "opening-range low"], [100, "A / B"], [102, "opening-range high"]]);
  });
});

describe("risk sizing and the setup score", () => {
  const base: PlanInput = {
    direction: "CALL", entryIndex: 23_160, invalidation: 23_155, zones: [], price: 100, lotSize: 75, slippageTicks: 1,
    charges: () => 20, cash: 100_000, maxLots: 10, risk: { ...RISK_DEFAULTS, perTradePercent: 0.5, dailyTarget: 5_000 }, minScore: 0,
    score: { structure: "BULLISH", momentum: { fast: 2, slow: 1 }, candle: { open: 23_150, high: 23_161, low: 23_149, close: 23_160 }, agreeing: 1, volume: "UNAVAILABLE" },
  };
  it("the stop goes beyond the invalidation; the target is twice the distance; lots fit the ₹500 budget", () => {
    const result = planTrade(base);
    expect(result.ok).toBe(true);
    const plan = result.plan;
    // 0.03% of 23,160 ≈ 6.95 beyond the level: stop ≈ 23,148.05, ≈ 11.95 points; target 2 × that.
    expect(plan.stopIndex).toBeCloseTo(23_148.05, 1);
    expect(plan.targetIndex).toBeCloseTo(23_160 + 2 * plan.stopDistance, 1);
    expect(plan.premiumStop).toBeCloseTo(100 - 0.5 * plan.stopDistance, 0);
    expect(plan.risk).toBeLessThanOrEqual(500);
    expect(plan.lots).toBe(Math.min(10, Math.floor(500 / ((100 - plan.premiumStop + 0.05) * 75 + 40))));
  });
  it("no trade when one lot risks more than the budget, when the next level leaves too little room, or below the minimum score", () => {
    const wide = planTrade({ ...base, invalidation: 23_120 });
    expect(wide.ok).toBe(false);
    expect(!wide.ok && wide.reasons.join(" ")).toContain("above the ₹500.00 risk per trade: no trade");
    const blocked = planTrade({ ...base, zones: [{ price: 23_170, label: "previous-day high" }] });
    expect(!blocked.ok && blocked.reasons.join(" ")).toContain("Not enough room: the previous-day high at 23170.00");
    const weak = planTrade({ ...base, minScore: 95 });
    expect(!weak.ok && weak.reasons.join(" ")).toContain("below the minimum 95");
  });
  it("the score adds up its parts (each says what it measured); it is not a probability", () => {
    const score = setupScore({ ...base.score, direction: "CALL", rewardRisk: 3, minRewardRisk: 2, costShare: 0.04 });
    expect(score.parts.map((part) => part.label)).toEqual(["Trend alignment", "Momentum", "Confirmation candle", "Confluence", "Room (reward : risk)", "Volume", "Costs"]);
    expect(score.score).toBe(score.parts.reduce((sum, part) => sum + part.points, 0));
    expect(score.parts.reduce((sum, part) => sum + part.max, 0)).toBe(100);
    const against = setupScore({ ...base.score, structure: "BEARISH", momentum: { fast: 1, slow: 2 }, direction: "CALL", rewardRisk: 1, minRewardRisk: 2, costShare: 0.5 });
    expect(against.score).toBeLessThan(score.score);
  });
});

describe("backtest metrics and the training / validation / out-of-sample split", async () => {
  const { backtestTotals, splitDates, chooseOnTraining } = await import("../src/lib/algo/backtest");
  const stats = (realized: number, wins: number, losses: number) => ({ signals: 0, accepted: 0, rejected: 0, trades: wins + losses, wins, losses, realized, maxDrawdown: 0, exits: {} });
  const trade = (entryTime: number, realized: number, risk = 500) => ({ number: 1, side: "CALL" as const, strategy: "line", entryTime, entryPremium: 100, exitTime: entryTime + 60, exitPremium: 100, exitReason: "x", realized, risk });
  const day = (date: string, trades: ReturnType<typeof trade>[], variant = "saved") => ({ date, variant, ok: true as const, expiry: null, stats: stats(trades.reduce((sum, item) => sum + item.realized, 0), trades.filter((item) => item.realized > 0).length, trades.filter((item) => item.realized <= 0).length), trades, rejected: 0, dailyTarget: 5_000 });
  it("average win / loss, R multiples, losing streaks, no-trade days and target days", () => {
    const totals = backtestTotals([day("2026-10-01", [trade(1, -500), trade(2, -500)]), day("2026-10-02", [trade(3, -250), trade(4, 1_000)]), day("2026-10-05", []), day("2026-10-06", [trade(5, 5_200, 1_000)])]);
    expect(totals).toMatchObject({ averageWin: 3_100, averageLoss: -416.67, maxConsecutiveLosses: 3, noTradeDays: 25, targetDays: 25, tradesPerDay: 1.25 });
    expect(totals.averageR).toBeCloseTo((-1 - 1 - 0.5 + 2 + 5.2) / 5, 2);
  });
  it("splits in time order 60 / 20 / 20, and chooses a variant on the training days only", () => {
    const dates = Array.from({ length: 10 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
    expect(splitDates([...dates].reverse())).toEqual({ training: dates.slice(0, 6), validation: dates.slice(6, 8), test: dates.slice(8) });
    // "score:70" wins on the training days; "saved" only does better later (which must not influence the choice).
    const days = dates.flatMap((date, index) => [day(date, [trade(index, index < 6 ? -100 : 900)], "saved"), day(date, [trade(index, index < 6 ? 300 : -100)], "score:70")]);
    expect(chooseOnTraining(days, ["saved", "score:70"])).toBe("score:70");
  });
});

describe("pre-market plan", async () => {
  const { buildPlan } = await import("../src/lib/algo/plan");
  const DAY = 86_400;
  const daily = Array.from({ length: 30 }, (_, index) => {
    const open = 23_000 + Math.sin(index / 3) * 150;
    const close = open + (index % 2 ? 40 : -30);
    return { time: OPEN - (30 - index) * DAY, open, high: Math.max(open, close) + 60, low: Math.min(open, close) - 60, close };
  });
  it("is provisional; lists previous-day levels, scenarios with invalidations, volatility and the 1-lot stop room", () => {
    const plan = buildPlan({ date: "2026-10-16", underlying: "NIFTY", previous: { date: "2026-10-15", high: 23_200, low: 23_050, close: 23_120 }, daily, open: null, risk: { ...RISK_DEFAULTS, perTradePercent: 0.5, dailyTarget: 5_000 }, maxDailyLoss: 1_500, lotSize: 75, orbMinutes: 15 });
    expect(plan.provisional).toBe(true);
    expect(plan.gap).toBeNull();
    expect(plan.levels.map((level) => level.label)).toEqual(expect.arrayContaining(["Previous-day high", "Previous-day low", "Previous-day close"]));
    expect(plan.bullish[0]).toMatchObject({ title: "Breakout above the previous-day high", level: 23_200, invalidation: "A close back below 23200.00" });
    expect(plan.bearish[0]).toMatchObject({ title: "Breakdown below the previous-day low", level: 23_050 });
    expect(plan.risk).toMatchObject({ perTrade: 500, maxIndexStop: 13.33 });
    expect(plan.volatility.days).toBe(20);
    expect(plan.notes[0]).toContain("Provisional");
    const opened = buildPlan({ date: "2026-10-16", underlying: "NIFTY", previous: { date: "2026-10-15", high: 23_200, low: 23_050, close: 23_120 }, daily, open: 23_180, risk: RISK_DEFAULTS, maxDailyLoss: 1_500, lotSize: 75, orbMinutes: 15 });
    expect(opened.gap).toEqual({ open: 23_180, points: 60, percent: 0.26 });
  });
});

describe("trendline breakouts: detection modes, buffer, structural stop, target modes", async () => {
  const { analyzeMarket, PATTERN_DEFAULTS } = await import("../src/lib/algo/patterns");
  const { algoConfigProblems } = await import("../src/lib/algo/config");
  const build = (closes: number[], first = 100): Candle[] => closes.map((close, index) => {
    const open = index === 0 ? first : closes[index - 1];
    return { time: T(index), open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close };
  });
  // A descending resistance through the swing highs at 3 (108.5) and 9 (106.5); the line is ≈ 104.17 at candle 16.
  const BASE = [100, 102, 104, 108, 104, 101, 100, 102, 104, 106, 103, 101, 100, 101, 102, 103];
  const signals = (candles: Candle[], extra: Partial<typeof PATTERN_DEFAULTS> = {}) => analyzeMarket({ candles, sessionOpen: OPEN, observationMinutes: 0, settings: { ...PATTERN_DEFAULTS, ...extra }, enabled: { trendline: true } }).signals;
  const wick = (high: number, close: number): Candle => ({ time: T(16), open: 103, high, low: 102.5, close });

  it("close mode needs the body to close beyond the line's price at that candle; intrabar mode takes the high crossing", () => {
    const pierced = [...build(BASE), wick(106, 103.5)];
    expect(signals(pierced)).toEqual([]);
    expect(signals(pierced, { breakMode: "intrabar" })).toEqual([expect.objectContaining({ strategy: "trendline", direction: "CALL" })]);
    // One signal per line: the next candle crossing again does not signal.
    expect(signals([...pierced, { time: T(17), open: 103.5, high: 106, low: 103, close: 104 }], { breakMode: "intrabar" })).toEqual([]);
  });

  it("the buffer can be % of price, points or a multiple of the average range", () => {
    const close = [...build(BASE), wick(110.5, 110)];
    expect(signals(close, { bufferMode: "points", bufferValue: 5 })).toHaveLength(1);
    expect(signals(close, { bufferMode: "points", bufferValue: 6 })).toEqual([]);
    expect(signals(close, { bufferMode: "atr", bufferValue: 0.5 })).toHaveLength(1);
  });

  it("the stop is beyond the latest swing low (or, with the line option, the broken line)", () => {
    const close = [...build(BASE), wick(110.5, 110)];
    expect(signals(close, { trendStop: "swing" })[0]).toMatchObject({ invalidation: 99.5, reason: expect.stringContaining("Stop beyond swing low 99.50") });
    expect(signals(close, { trendStop: "line" })[0].invalidation).toBeCloseTo(104.17, 1);
  });

  it("target to the next level when it is at least the minimum multiple away; trailing has no fixed target", () => {
    const base: PlanInput = { direction: "CALL", entryIndex: 23_160, invalidation: 23_155, zones: [{ price: 23_220, label: "previous-day high" }], price: 100, lotSize: 75, slippageTicks: 1, charges: () => 20, cash: 100_000, maxLots: 10, risk: RISK_DEFAULTS, minScore: 0, score: { structure: "BULLISH", momentum: { fast: 2, slow: 1 }, candle: { open: 23_150, high: 23_161, low: 23_149, close: 23_160 }, agreeing: 1, volume: "UNAVAILABLE" } };
    const level = planTrade({ ...base, risk: { ...RISK_DEFAULTS, targetMode: "level" } }).plan;
    expect(level.targetIndex).toBeCloseTo(23_220, 1);
    expect(level.rewardRisk).toBeGreaterThan(2);
    const trail = planTrade({ ...base, zones: [{ price: 23_170, label: "previous-day high" }], risk: { ...RISK_DEFAULTS, targetMode: "trail" } });
    expect(trail.ok).toBe(true);
    expect(trail.plan.targetMode).toBe("trail");
  });

  it("intrabar detection is refused for live trading", () => {
    const live = { ...ALGO_DEFAULTS, mode: "LIVE" as const, patterns: { ...ALGO_DEFAULTS.patterns, breakMode: "intrabar" as const } };
    expect(algoConfigProblems(live)).toContain("Intrabar breakout detection is for paper trading and replay only; live trading needs candle-close confirmation.");
  });
});
