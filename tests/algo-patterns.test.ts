import { describe, expect, it } from "vitest";
import type { Candle } from "../src/lib/algo/lines";
import { analyzeMarket, findPattern, lineAt, marketTrend, PATTERN_DEFAULTS, swingPivots, trendlines, volumeCheck, type PatternSettings, type StrategyId } from "../src/lib/algo/patterns";
import { changedConfirmations, tradeConfirmations, type TradeSetup } from "../src/lib/algo/confirmations";

/**
 * Deterministic fixtures: candles built from a close series (open = previous close, high / low half a
 * point beyond the body). The base series has a descending resistance (swing highs at 3 and 9) and a W
 * (equal lows at 6 and 12, middle high at 9), and breaks out at candle 16.
 */
const OPEN = Date.UTC(2026, 9, 16, 3, 45) / 1000;
const T = (index: number) => OPEN + index * 60;
function build(closes: number[], first = 100): Candle[] {
  return closes.map((close, index) => {
    const open = index === 0 ? first : closes[index - 1];
    return { time: T(index), open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close };
  });
}
const BASE = [100, 102, 104, 108, 104, 101, 100, 102, 104, 106, 103, 101, 100, 101, 102, 103, 110];
const mirror = (closes: number[]) => closes.map((close) => 200 - close);
const only = (id: StrategyId): Partial<Record<StrategyId, boolean>> => ({ line: false, trendline: id === "trendline", w: id === "w", m: id === "m" });
const settings: PatternSettings = { ...PATTERN_DEFAULTS };
const analyse = (candles: Candle[], id: StrategyId, extra: Partial<PatternSettings> = {}, observationMinutes = 0) => analyzeMarket({ candles, sessionOpen: OPEN, observationMinutes, settings: { ...settings, ...extra }, enabled: only(id) });

describe("swing points without look-ahead", () => {
  it("finds the swing highs and lows of the fixture", () => {
    const pivots = swingPivots(build(BASE), 2);
    expect(pivots.filter((pivot) => pivot.kind === "HIGH").map((pivot) => [pivot.index, pivot.price])).toEqual([[3, 108.5], [9, 106.5]]);
    expect(pivots.filter((pivot) => pivot.kind === "LOW").map((pivot) => [pivot.index, pivot.price])).toEqual([[6, 99.5], [12, 99.5]]);
  });

  it("a swing point is only known once its later candles have completed", () => {
    const candles = build(BASE);
    expect(swingPivots(candles.slice(0, 11), 2).some((pivot) => pivot.index === 9)).toBe(false);
    const confirmed = swingPivots(candles.slice(0, 12), 2).find((pivot) => pivot.index === 9);
    expect(confirmed?.confirmedAt).toBe(T(11) + 60);
  });

  it("the analysis of a prefix never changes when later candles are appended (no future data)", () => {
    const candles = build(BASE);
    for (let end = 3; end <= candles.length; end += 1) {
      const prefix = analyse(candles.slice(0, end), "w").analysis;
      const pivotsKnown = swingPivots(candles, 2).filter((pivot) => pivot.confirmedAt <= candles[end - 1].time + 60).slice(-12);
      expect(prefix.pivots).toEqual(pivotsKnown);
    }
  });

  it("market structure: higher highs and lows, lower ones, or mixed", () => {
    const pivot = (kind: "HIGH" | "LOW", index: number, price: number) => ({ kind, index, time: T(index), price, confirmedAt: T(index + 2) });
    expect(marketTrend([pivot("HIGH", 1, 10), pivot("LOW", 2, 5), pivot("HIGH", 3, 12), pivot("LOW", 4, 6)])).toBe("BULLISH");
    expect(marketTrend([pivot("HIGH", 1, 12), pivot("LOW", 2, 6), pivot("HIGH", 3, 10), pivot("LOW", 4, 5)])).toBe("BEARISH");
    expect(marketTrend([pivot("HIGH", 1, 12), pivot("LOW", 2, 5), pivot("HIGH", 3, 10), pivot("LOW", 4, 6)])).toBe("SIDEWAYS");
    expect(marketTrend([pivot("HIGH", 1, 12)])).toBe("UNCONFIRMED");
  });
});

describe("Strategy B: automatic trendline breakout", () => {
  it("builds the descending resistance through the two falling swing highs, fixed to their candles", () => {
    const { resistance, support } = trendlines(swingPivots(build(BASE), 2));
    expect(resistance).toMatchObject({ kind: "RESISTANCE", a: { index: 3, price: 108.5 }, b: { index: 9, price: 106.5 } });
    expect(lineAt(resistance!, 15)).toBeCloseTo(104.5, 6);
    expect(support).toBeNull();
  });

  it("CALL on the close above the resistance; nothing before it; nothing again after it", () => {
    const candles = build(BASE);
    expect(analyse(candles.slice(0, 16), "trendline").signals).toEqual([]);
    const breakout = analyse(candles, "trendline");
    expect(breakout.signals).toEqual([expect.objectContaining({ strategy: "trendline", direction: "CALL", time: T(16), trigger: 110 })]);
    expect(breakout.analysis.strategies.trendline.status).toBe("BREAKOUT CONFIRMED");
    expect(analyse(build([...BASE, 111]), "trendline").signals).toEqual([]);
  });

  it("PUT on the close below an ascending support (the mirror image)", () => {
    const result = analyse(build(mirror(BASE), 100), "trendline");
    expect(result.signals).toEqual([expect.objectContaining({ strategy: "trendline", direction: "PUT", time: T(16) })]);
  });

  it("without two confirmed swing points there is no trendline and no trade", () => {
    const result = analyse(build([100, 101, 102, 103, 104, 105]), "trendline");
    expect(result.signals).toEqual([]);
    expect(result.analysis.strategies.trendline.status).toBe("WAITING FOR VALID TRENDLINE");
  });
});

describe("Strategies C / D: W (double bottom) and M (double top)", () => {
  it("W: two equal lows, a middle high as the neckline; CALL only on the neckline breakout close", () => {
    const pattern = findPattern("W", swingPivots(build(BASE), 2), settings);
    expect(pattern).toMatchObject({ kind: "W", neckline: 106.5, invalidation: 99.5, confirmed: true });
    const waiting = analyse(build(BASE).slice(0, 16), "w");
    expect(waiting.signals).toEqual([]);
    expect(waiting.analysis.strategies.w.status).toBe("WAITING FOR NECKLINE BREAKOUT");
    const breakout = analyse(build(BASE), "w");
    expect(breakout.signals).toEqual([expect.objectContaining({ strategy: "w", direction: "CALL", level: 106.5, invalidation: 99.5 })]);
  });

  it("the W shape alone (before the second low is confirmed) is only 'forming'", () => {
    const forming = analyse(build(BASE).slice(0, 12), "w");
    expect(forming.signals).toEqual([]);
    expect(forming.analysis.strategies.w.status).toBe("W PATTERN FORMING");
  });

  it("lows too far apart in price are not a W; a close below the lows invalidates it", () => {
    const uneven = [...BASE.slice(0, 12), 97, 98, 99, 100, 110];
    expect(findPattern("W", swingPivots(build(uneven), 2), settings)).toBeNull();
    const broken = [...BASE.slice(0, 16), 98, 110];
    expect(analyse(build(broken), "w").signals).toEqual([]);
    expect(analyse(build(broken), "w").analysis.strategies.w.status).toBe("PATTERN INVALIDATED");
  });

  it("M: the mirror image; PUT only on the neckline breakdown close", () => {
    const result = analyse(build(mirror(BASE), 100), "m");
    expect(result.signals).toEqual([expect.objectContaining({ strategy: "m", direction: "PUT", level: 93.5, invalidation: 100.5 })]);
    expect(analyse(build(mirror(BASE), 100).slice(0, 16), "m").analysis.strategies.m.status).toBe("WAITING FOR NECKLINE BREAKDOWN");
  });

  it("retest mode waits for a real retest of the neckline and a confirming candle", () => {
    const candles = build([...BASE, 107, 112]);
    // Candle 16 breaks out, 17 comes back to the neckline (low 106.5), 18 is a strong bullish close.
    expect(analyse(candles.slice(0, 17), "w", { retest: true }).signals).toEqual([]);
    expect(analyse(candles.slice(0, 17), "w", { retest: true }).analysis.strategies.w.status).toBe("WAITING FOR RETEST");
    expect(analyse(candles.slice(0, 18), "w", { retest: true }).analysis.strategies.w.status).toBe("RETEST IN PROGRESS");
    expect(analyse(candles, "w", { retest: true }).signals).toEqual([expect.objectContaining({ strategy: "w", direction: "CALL", time: T(18) })]);
  });

  it("volume is only required where the feed has it", () => {
    const flat = build(BASE);
    expect(volumeCheck(flat, flat.length - 1)).toBe("UNAVAILABLE");
    const withVolume = flat.map((candle, index) => ({ ...candle, volume: index === flat.length - 1 ? 5000 : 1000 }));
    expect(volumeCheck(withVolume, withVolume.length - 1)).toBe("CONFIRMED");
    const weak = withVolume.map((candle, index) => (index === withVolume.length - 1 ? { ...candle, volume: 900 } : candle));
    expect(analyse(weak, "w", { volume: true }).signals).toEqual([]);
    expect(analyse(flat, "w", { volume: true }).signals[0]?.volume).toBe("UNAVAILABLE");
  });
});

describe("the first 15 minutes are analysis only", () => {
  it("no strategy signals while observing; the status says so", () => {
    const result = analyzeMarket({ candles: build(BASE), sessionOpen: OPEN, observationMinutes: 30, settings, enabled: { line: true, trendline: true, w: true, m: true } });
    expect(result.signals).toEqual([]);
    expect(result.analysis.observationComplete).toBe(false);
    expect(result.analysis.openingRange).toBeNull();
    expect(result.analysis.strategies.w.status).toBe("ANALYZING OPENING MARKET");
  });

  it("a breakout during the observation is not traded later when the window ends", () => {
    // The breakout candle (16) closes at minute 17, inside an 18-minute observation; candle 17 closes at 18.
    const candles = build([...BASE, 111]);
    const during = analyzeMarket({ candles: candles.slice(0, 17), sessionOpen: OPEN, observationMinutes: 18, settings, enabled: only("w") });
    expect(during.signals).toEqual([]);
    const after = analyzeMarket({ candles, sessionOpen: OPEN, observationMinutes: 18, settings, enabled: only("w") });
    expect(after.analysis.observationComplete).toBe(true);
    expect(after.signals).toEqual([]);
  });

  it("the opening range is the high and low of the observation window, known once it has passed", () => {
    const result = analyzeMarket({ candles: build(BASE), sessionOpen: OPEN, observationMinutes: 5, settings, enabled: only("w") });
    expect(result.analysis.openingRange).toEqual({ high: 108.5, low: 99.5 });
  });
});

describe("intratrade confirmations", () => {
  const setup: TradeSetup = { strategy: "w", strategies: ["w"], direction: "CALL", level: 106.5, invalidation: 99.5, underlyingEntry: 110, entryTime: T(17) };
  const premium = { value: 120, asOf: T(20), stop: 96, target: 168 };
  const statusOf = (closes: number[], extra: Partial<Parameters<typeof tradeConfirmations>[0]> = {}) => {
    const list = tradeConfirmations({ setup, candles: build([...BASE, ...closes]), premium, now: T(20), ...extra });
    return Object.fromEntries(list.map((item) => [item.category, item.status]));
  };

  it("price: strengthening, holding, weakening or invalidated against the setup", () => {
    expect(statusOf([112]).price).toBe("STRENGTHENING");
    expect(statusOf([110]).price).toBe("HOLDING");
    expect(statusOf([108]).price).toBe("WEAKENING");
    expect(statusOf([99]).price).toBe("SETUP INVALIDATED");
  });

  it("breakout level: holding, retest in progress, retest confirmed, or lost", () => {
    expect(statusOf([112, 113]).level).toBe("HOLDING");
    expect(statusOf([112, 107]).level).toBe("RETEST IN PROGRESS");
    expect(statusOf([107, 112]).level).toBe("RETEST CONFIRMED");
    expect(statusOf([112, 105]).level).toBe("SETUP INVALIDATED");
  });

  it("candle, volume and momentum report only what was evaluated", () => {
    expect(statusOf([115]).candle).toBe("CONFIRMED");
    expect(statusOf([105]).candle).toBe("WEAKENING");
    expect(statusOf([110.2]).candle).toBe("HOLDING");
    expect(statusOf([112]).volume).toBe("UNAVAILABLE");
    expect(statusOf([112]).momentum).toBe("UNAVAILABLE");
    const long = Array.from({ length: 30 }, (_, index) => 110 + index);
    expect(statusOf(long).momentum).toBe("CONFIRMED");
  });

  it("risk: exit condition, near the stop, stale premium noted, and unavailable without a premium", () => {
    expect(statusOf([112], { premium: { ...premium, value: 90 } }).risk).toBe("EXIT CONDITION TRIGGERED");
    expect(statusOf([112], { premium: { ...premium, value: 100 } }).risk).toBe("WEAKENING");
    expect(statusOf([112], { premium: null }).risk).toBe("UNAVAILABLE");
    const stale = tradeConfirmations({ setup, candles: build([...BASE, 112]), premium: { ...premium, asOf: T(10) }, now: T(20) }).find((item) => item.category === "risk");
    expect(stale?.why).toMatch(/last valid premium, 10 min old/);
  });

  it("only changed statuses are reported (no repeated events for an unchanged state)", () => {
    const first = tradeConfirmations({ setup, candles: build([...BASE, 112]), premium, now: T(20) });
    expect(changedConfirmations(null, first)).toHaveLength(first.length);
    const same = tradeConfirmations({ setup, candles: build([...BASE, 112]), premium, now: T(20) });
    expect(changedConfirmations(first, same)).toEqual([]);
    const moved = tradeConfirmations({ setup, candles: build([...BASE, 112, 105]), premium, now: T(20) });
    expect(changedConfirmations(first, moved).map((item) => item.category)).toContain("level");
  });
});

describe("chart drawings and dashboard wiring use the stored analysis", () => {
  it("trendlines run from their fixed first pivot to the latest candle; necklines are dashed while forming and hidden once invalidated", async () => {
    const { algoAnalysisDrawings, algoPivotMarkers } = await import("../src/components/algo/algo-drawings");
    const both = { line: false, trendline: true, w: true, m: false };
    const done = analyzeMarket({ candles: build(BASE), sessionOpen: OPEN, observationMinutes: 0, settings, enabled: both }).analysis;
    const drawings = algoAnalysisDrawings(done, { trendline: "#00f", neckline: "#fa0" });
    // Switched-off strategies draw nothing (M is off here; with only W on, no trendline either).
    expect(algoAnalysisDrawings(analyse(build(BASE), "w").analysis, { trendline: "#00f", neckline: "#fa0" }).map((drawing) => drawing.id)).toEqual(["algo:neckline:W"]);
    // After the breakout candle the resistance is broken (no longer active); the support through the equal lows stays.
    // The broken resistance stays as a dashed segment up to the breakout candle.
    expect(drawings.map((drawing) => drawing.id)).toEqual(["algo:trendline:support", `algo:trendline:broken:resistance:${T(3)}:${T(9)}`, "algo:neckline:W"]);
    expect(drawings[1]).toMatchObject({ kind: "trend", dash: "dashed", points: [{ time: T(3), price: 108.5 }, { time: T(16) }] });
    // Before it: a ray through the two fixed swing highs, extended to the right.
    const before = algoAnalysisDrawings(analyzeMarket({ candles: build(BASE).slice(0, 16), sessionOpen: OPEN, observationMinutes: 0, settings, enabled: both }).analysis, { trendline: "#00f", neckline: "#fa0" });
    expect(before.find((drawing) => drawing.id === "algo:trendline:resistance")).toMatchObject({ kind: "ray", points: [{ time: T(3), price: 108.5 }, { time: T(9), price: 106.5 }] });
    expect(drawings[2]).toMatchObject({ dash: "solid", points: [{ time: T(6), price: 106.5 }, { time: T(16), price: 106.5 }] });
    const forming = algoAnalysisDrawings(analyse(build(BASE).slice(0, 12), "w").analysis, { trendline: "#00f", neckline: "#fa0" });
    expect(forming.find((drawing) => drawing.id === "algo:neckline:W")?.dash).toBe("dashed");
    const invalid = analyse(build([...BASE.slice(0, 16), 98, 110]), "w").analysis;
    expect(algoAnalysisDrawings(invalid, { trendline: "#00f", neckline: "#fa0" }).some((drawing) => drawing.id === "algo:neckline:W")).toBe(false);
    // Three W pivots and the breakout arrow, all without text.
    expect(algoPivotMarkers(done, "#888").map((marker) => marker.text)).toEqual(["", "", "", ""]);
    expect(new Set(algoPivotMarkers(done, "#888").map((marker) => marker.id)).size).toBe(4);
    expect(algoPivotMarkers(done, "#888")).toContainEqual(expect.objectContaining({ time: T(16), shape: "arrowUp", position: "belowBar" }));
  });

  it("nothing is drawn while the opening is observed; the trendline appears once the window has passed", async () => {
    const { algoAnalysisDrawings, algoPivotMarkers } = await import("../src/components/algo/algo-drawings");
    const enabled = { line: false, trendline: true, w: true, m: false };
    const colors = { trendline: "#00f", neckline: "#fa0" };
    // The resistance is known from candle 11, but the window runs to minute 30: nothing on the chart yet.
    const observing = analyzeMarket({ candles: build(BASE).slice(0, 16), sessionOpen: OPEN, observationMinutes: 30, settings, enabled }).analysis;
    expect(observing.resistance).not.toBeNull();
    expect(algoAnalysisDrawings(observing, colors)).toEqual([]);
    expect(algoPivotMarkers(observing, "#888")).toEqual([]);
    // Once the window has passed (here 15 minutes, ending before the last candle) the ray is drawn.
    const after = analyzeMarket({ candles: build(BASE).slice(0, 16), sessionOpen: OPEN, observationMinutes: 15, settings, enabled }).analysis;
    expect(after.observationComplete).toBe(true);
    expect(algoAnalysisDrawings(after, colors).map((drawing) => [drawing.id, drawing.kind])).toContainEqual(["algo:trendline:resistance", "ray"]);
  });

  it("the live chart draws the paper Algo's analysis too (outside replay)", async () => {
    const { readFileSync } = await import("node:fs");
    const desk = readFileSync("src/components/chart-desk.tsx", "utf8");
    expect(desk).toMatch(/useLiveAlgoAnalysis\(\{ enabled: !replay\.active && !optionView && !live && canPaperTrade, symbol \}\)/);
    const hook = readFileSync("src/components/algo/use-live-analysis.ts", "utf8");
    expect(hook).toMatch(/data\.config\.mode === "PAPER" && data\.config\.underlying === symbol && fresh/);
  });

  it("the dashboard, drawer and Strategy tab read the run's stored analysis and confirmations (no separate calculation)", async () => {
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync("src/components/algo/algo-replay-panel.tsx", "utf8");
    expect(panel).toMatch(/<MarketAnalysisSection analysis=\{state\?\.analysis\}/);
    expect(panel).toMatch(/<StrategyRows analysis=\{state\?\.analysis\} positionOpen=\{Boolean\(position\)\} \/>/);
    expect(panel).toMatch(/confirmations=\{position && position\.entryKey === trade\.entryKey \? state\?\.confirmations \?\? null : null\}/);
    expect(panel).toMatch(/waitingMessage\(state\?\.analysis, trades\.length, max\)/);
    expect(readFileSync("src/components/algo/algo-trade-drawer.tsx", "utf8")).toMatch(/<ConfirmationList confirmations=\{run\.state\.confirmations \?\? null\} \/>/);
    // Live paper shows them in the Algo panel beside the chart; a stale feed is the server's WAITING FOR DATA.
    const livePanel = readFileSync("src/components/algo/algo-live-panel.tsx", "utf8");
    expect(livePanel).toMatch(/<MarketAnalysisSection analysis=\{state\.analysis\}/);
    expect(readFileSync("src/components/algo/algo-live-session.tsx", "utf8")).toMatch(/live\.status === "WAITING_FOR_DATA"/);
    expect(readFileSync("src/components/chart-desk.tsx", "utf8")).toMatch(/algoRun\.state\.analysis/);
    // Nothing later than the replay time is drawn on the chart.
    expect(readFileSync("src/components/chart-desk.tsx", "utf8")).toMatch(/analysisNow\.asOf <= replay\.cursor \+ 60/);
    expect(readFileSync("src/components/chart-desk.tsx", "utf8")).toMatch(/\.filter\(\(marker\) => !replay\.active \|\| replay\.cursor == null \|\| marker\.time < replay\.cursor\)/);
    for (const file of ["src/components/algo/algo-analysis.tsx", "src/components/algo/algo-replay-panel.tsx"]) expect(readFileSync(file, "utf8")).not.toMatch(/Math\.random/);
  });
});

describe("body crossing only: a gap beyond the level is not a breakout", () => {
  it("a W neckline breakout must come from a candle whose body crosses the neckline", () => {
    // Same W, but the last candle opens above the neckline (a gap from 103 to 107) and closes at 110.
    const candles = build(BASE).map((candle, index) => (index === 16 ? { ...candle, open: 107, low: 106.8 } : candle));
    expect(analyse(candles, "w").signals).toEqual([]);
    expect(analyse(build(BASE), "w").signals).toHaveLength(1);
  });
});

describe("multi-day backtest arithmetic", () => {
  it("lists weekdays in a range, and the last N weekdays before a date", async () => {
    const { tradingDays, lastTradingDays } = await import("../src/lib/algo/backtest");
    expect(tradingDays("2026-10-16", "2026-10-21")).toEqual(["2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21"]);
    expect(lastTradingDays("2026-10-26", 3)).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
  });

  it("totals: P&L, win rate, profit factor and the drawdown of the running P&L; skipped days are not zero days", async () => {
    const { backtestTotals, backtestCsv } = await import("../src/lib/algo/backtest");
    const stats = (realized: number, wins: number, losses: number) => ({ signals: 0, accepted: wins + losses, rejected: 0, trades: wins + losses, wins, losses, realized, maxDrawdown: 0, exits: {} });
    const trade = (realized: number) => ({ number: 1, side: "CALL" as const, strategy: "line", entryTime: 0, entryPremium: 100, exitTime: 1, exitPremium: 100, exitReason: "Target", realized });
    const days = [
      { date: "2026-10-19", variant: "saved" as const, ok: true as const, expiry: null, stats: stats(1000, 1, 0), trades: [trade(1000)], rejected: 0 },
      { date: "2026-10-20", variant: "saved" as const, ok: true as const, expiry: null, stats: stats(-1500, 0, 2), trades: [trade(-700), trade(-800)], rejected: 1 },
      { date: "2026-10-21", variant: "saved" as const, ok: false as const, reason: "No 1-minute candles (a holiday or no data)." },
      { date: "2026-10-22", variant: "saved" as const, ok: true as const, expiry: null, stats: stats(2000, 1, 0), trades: [trade(2000)], rejected: 0 },
    ];
    const totals = backtestTotals(days);
    expect(totals).toMatchObject({ days: 4, daysSkipped: 1, daysTraded: 3, trades: 4, wins: 2, losses: 2, winRate: 50, pnl: 1500, averagePerDay: 500, maxDrawdown: 1500, profitFactor: 2 });
    expect(totals.bestDay).toEqual({ date: "2026-10-22", pnl: 2000 });
    expect(totals.worstDay).toEqual({ date: "2026-10-20", pnl: -1500 });
    const csv = backtestCsv(days);
    expect(csv).toMatch(/2026-10-21,Saved settings,Skipped/);
    expect(csv).toMatch(/TOTAL,Saved settings,All days: 4 days \(1 skipped\),4,2,2,1500\.00/);
  });

  it("the backtest runs one day per request on the server with the saved settings, or with the fixes off to compare", async () => {
    const { readFileSync } = await import("node:fs");
    const server = readFileSync("src/server/algo.ts", "utf8");
    const start = server.indexOf("export async function backtestDay");
    const day = server.slice(start, start + server.slice(start).search(/\r?\n\}\r?\n/));
    expect(day.length).toBeGreaterThan(200);
    expect(day).toMatch(/variant === "baseline" \? \{ \.\.\.saved, filters: \{ levelBlockMinutes: 0, breakoutBufferPercent: 0, secondCandle: false, momentum: false \}, structureStop: false \}\s*: score \? \{ \.\.\.saved, minScore: Math\.min\(100, Number\(score\[1\]\)\) \}\s*: confirm \? \{ \.\.\.saved, filters: \{ \.\.\.saved\.filters, secondCandle: false \}, confirmation: \{ \.\.\.saved\.confirmation, mode: confirm\[1\]/);
    expect(day).not.toMatch(/prisma\.\w+\.(update|create|upsert|delete)/);
    // The day loop is the shared one (lib/algo/replay-adapter), the same for replay and backtests.
    expect(server).toMatch(/await simulateSession\(\{ sessionId, date, config, candles, lines, adapter,/);
    expect(readFileSync("src/lib/algo/replay-adapter.ts", "utf8")).toMatch(/if \(sessionComplete\(state, config\.stopAtLimit === false \? Infinity : config\.maxTrades\)\) break;/);
    expect(readFileSync("src/app/api/algo/route.ts", "utf8")).toMatch(/return Response\.json\(await backtestDay\(user, input\.date, input\.variant, input\.strategy, input\.capital, input\.slippageTicks\)\)/);
  });
});
