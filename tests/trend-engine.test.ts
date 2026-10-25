import { describe, expect, it } from "vitest";
import { AUTO_TREND_DEFAULTS, analyzeTrend, completedCandles, findSwings, readAutoTrendSettings, significantSwings, type AutoTrendSettings } from "../src/lib/chart/trend-engine";
import type { Candle } from "../src/lib/market/demo";

// 2026-10-22 09:15 IST.
const OPEN = Date.UTC(2026, 9, 22, 3, 45) / 1000;
const settings: AutoTrendSettings = { ...AUTO_TREND_DEFAULTS, left: 2, right: 2, minSwingAtr: 0.5 };

/** One-minute candles following a path of closes (each candle opens at the previous close, small wicks). */
function path(closes: number[], start = OPEN, first = closes[0]): Candle[] {
  let previous = first;
  return closes.map((close, index) => {
    const candle = { time: start + index * 60, open: previous, high: Math.max(previous, close) + 1, low: Math.min(previous, close) - 1, close, volume: 0 };
    previous = close;
    return candle;
  });
}

/** A falling channel: 10-candle waves between a resistance and a support both dropping 2 points a candle. */
function fallingChannel(waves: number, base = 22700): number[] {
  const closes: number[] = [];
  for (let index = 0; index < waves * 10; index += 1) {
    const phase = index % 10;
    const swing = phase < 5 ? phase * 8 : (10 - phase) * 8; // 0 → 40 → 0
    closes.push(base - index * 2 + swing);
  }
  return closes;
}

describe("swings", () => {
  it("a swing is confirmed only after `right` later candles; with fewer it is provisional", () => {
    const candles = path([100, 102, 105, 103, 101, 99]);
    const swings = findSwings(candles, 0, 0, 2, 2, 60);
    const high = swings.find((swing) => swing.kind === "HIGH")!;
    expect(high.index).toBe(2);
    expect(high.confirmedAt).toBe(candles[4].time + 60);
    const early = findSwings(candles.slice(0, 4), 0, 0, 2, 2, 60).find((swing) => swing.kind === "HIGH")!;
    expect(early.confirmedAt).toBeNull();
  });

  it("small swings are filtered, and two highs in a row keep the higher", () => {
    const swings = [
      { kind: "LOW" as const, index: 0, time: 0, price: 100, confirmedAt: 1 },
      { kind: "HIGH" as const, index: 2, time: 2, price: 101, confirmedAt: 3 },
      { kind: "HIGH" as const, index: 4, time: 4, price: 110, confirmedAt: 5 },
      { kind: "LOW" as const, index: 6, time: 6, price: 108, confirmedAt: 7 },
      { kind: "LOW" as const, index: 8, time: 8, price: 95, confirmedAt: 9 },
    ];
    expect(significantSwings(swings, 5).map((swing) => swing.price)).toEqual([100, 110, 95]);
  });

  it("swings already confirmed never move when more candles arrive (no look-ahead)", () => {
    const candles = path(fallingChannel(8));
    const settled = (count: number) => analyzeTrend(candles.slice(0, count), 60, { ...settings, observationMinutes: 0 }).swings.filter((swing) => swing.confirmedAt! <= candles[59].time + 60);
    const early = settled(60);
    const later = settled(80);
    for (const swing of early) expect(later).toContainEqual(swing);
  });
});

describe("trendlines", () => {
  it("a falling channel gives a falling resistance and a falling support through real swing points", () => {
    const candles = path(fallingChannel(8));
    const result = analyzeTrend(candles, 60, { ...settings, observationMinutes: 0 });
    expect(result.phase).toBe("ACTIVE");
    expect(result.resistance?.slope).toBeLessThan(0);
    expect(result.support?.slope).toBeLessThan(0);
    for (const line of [result.resistance!, result.support!]) {
      for (const anchor of [line.a, line.b]) {
        const candle = candles[anchor.index];
        expect(anchor.time).toBe(candle.time);
        expect(anchor.price).toBe(anchor.kind === "HIGH" ? candle.high : candle.low);
      }
      expect(line.a.index).toBeLessThan(line.b.index);
    }
    // No candle between the anchors crosses the line.
    const support = result.support!;
    for (let index = support.a.index; index <= support.b.index; index += 1) expect(candles[index].low).toBeGreaterThanOrEqual(support.a.price + (index - support.a.index) * support.slope - 0.05 * support.a.price / 100);
    expect(result.structure).toBe("BEARISH");
  });

  it("the active line does not change between swing confirmations, and a new lower low re-anchors support", () => {
    const closes = fallingChannel(6);
    const candles = path(closes);
    const at = (count: number) => analyzeTrend(candles.slice(0, count), 60, { ...settings, observationMinutes: 0 });
    // Between confirmations (mid-wave, no new swing) the chosen line is the same.
    expect(at(43).support?.id).toBe(at(44).support?.id);
    // A sharp drop: support breaks, then a deeper low is confirmed and becomes an anchor.
    const drop = [...closes, ...Array.from({ length: 6 }, (_, index) => closes.at(-1)! - 20 - index * 15), ...Array.from({ length: 8 }, (_, index) => closes.at(-1)! - 100 + index * 6)];
    const after = analyzeTrend(path(drop), 60, { ...settings, observationMinutes: 0 });
    expect(after.brokenLines.some((line) => line.kind === "SUPPORT")).toBe(true);
    const deepest = Math.min(...after.swings.filter((swing) => swing.kind === "LOW").map((swing) => swing.price));
    expect(after.swings.some((swing) => swing.kind === "LOW" && swing.price === deepest && swing.index > 60)).toBe(true);
  });

  it("a close through the line marks it broken at that candle", () => {
    const closes = fallingChannel(5);
    const breakout = [...closes, closes.at(-1)! + 30, closes.at(-1)! + 60, closes.at(-1)! + 70];
    const candles = path(breakout);
    const result = analyzeTrend(candles, 60, { ...settings, observationMinutes: 0 });
    const broken = result.brokenLines.find((line) => line.kind === "RESISTANCE");
    expect(broken?.status).toBe("BROKEN");
    expect(broken!.broken!.close).toBeGreaterThan(broken!.broken!.price);
  });
});

describe("opening observation and sessions", () => {
  it("nothing is drawn before 09:45; the opening range and structure are tracked", () => {
    const candles = path(fallingChannel(3).slice(0, 29));
    const result = analyzeTrend(candles, 60, settings);
    expect(result.phase).toBe("OBSERVING");
    expect(result.support).toBeNull();
    expect(result.resistance).toBeNull();
    expect(result.observation?.complete).toBe(false);
    expect(result.session?.high).toBe(Math.max(...candles.map((candle) => candle.high)));
    expect(result.message).toContain("09:45");
    const after = analyzeTrend(path(fallingChannel(6)), 60, settings);
    expect(after.phase).toBe("ACTIVE");
    expect(after.observation?.complete).toBe(true);
  });

  it("1-minute charts read only the current session: the session range resets on a new day", () => {
    const yesterday = path(fallingChannel(6), OPEN - 86_400);
    const today = path(fallingChannel(6, 22000));
    const result = analyzeTrend([...yesterday, ...today], 60, settings);
    expect(result.session?.date).toBe("2026-10-22");
    expect(result.session?.high).toBe(Math.max(...today.map((candle) => candle.high)));
    expect(result.swings.every((swing) => swing.time >= OPEN)).toBe(true);
  });

  it("daily charts have no session observation", () => {
    const days = path(fallingChannel(4)).map((candle, index) => ({ ...candle, time: OPEN + index * 86_400 }));
    const result = analyzeTrend(days, null, settings);
    expect(result.phase).toBe("ACTIVE");
    expect(result.observation).toBeNull();
  });
});

describe("levels and settings", () => {
  it("equal highs make one horizontal resistance level", () => {
    const wave = [0, 10, 20, 30, 40, 30, 20, 10];
    const closes = [...wave, ...wave, ...wave, 0, -5].map((value) => 22700 + value);
    const result = analyzeTrend(path(closes), 60, { ...settings, observationMinutes: 0 });
    const level = result.levels.find((item) => item.kind === "RESISTANCE" && item.source === "EQUAL_SWINGS");
    expect(level?.members.length).toBeGreaterThanOrEqual(2);
    expect(level?.price).toBeCloseTo(22741, 0);
  });

  it("the forming candle is never analysed", () => {
    const candles = path([1, 2, 3]);
    expect(completedCandles(candles, true)).toHaveLength(2);
    expect(completedCandles(candles, false)).toHaveLength(3);
  });

  it("saved settings are clamped to their limits and colors validated", () => {
    const read = readAutoTrendSettings({ left: 99, right: 0, lookback: 5, trendlines: false, colors: { support: "red", resistance: "#123456" } });
    expect([read.left, read.right, read.lookback, read.trendlines]).toEqual([10, 1, 30, false]);
    expect(read.colors.support).toBe(AUTO_TREND_DEFAULTS.colors.support);
    expect(read.colors.resistance).toBe("#123456");
  });
});
