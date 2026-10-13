import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kolkataParts } from "@/lib/market/clock";
import { buildForecast } from "@/lib/market/forecast";
import type { Candle } from "@/lib/market/demo";

const FRIDAY = Math.floor(Date.parse("2026-10-09T09:45:00Z") / 1000);

function weekdayCandles(closes: number[], end = FRIDAY): Candle[] {
  const times: number[] = [];
  let cursor = end;
  while (times.length < closes.length) {
    const parts = kolkataParts(new Date(cursor * 1000));
    if (parts.weekday !== "Sat" && parts.weekday !== "Sun") times.push(cursor);
    cursor -= 86400;
  }
  times.reverse();
  return times.map((time, index) => ({
    time,
    open: closes[index],
    high: closes[index] + 1,
    low: Math.max(0.5, closes[index] - 1),
    close: closes[index],
    volume: 1000,
  }));
}

describe("holt forecast", () => {
  it("is deterministic and follows a rising close series", () => {
    const candles = weekdayCandles(Array.from({ length: 80 }, (_, index) => 100 + index));
    const first = buildForecast({ symbol: "RELIANCE", timeframe: "1d", horizon: "5d", candles, now: new Date("2026-10-09T10:00:00Z") });
    const second = buildForecast({ symbol: "RELIANCE", timeframe: "1d", horizon: "5d", candles, now: new Date("2026-10-09T10:00:00Z") });
    expect(first.status).toBe("ready");
    expect(second).toEqual(first);
    expect(first.endpoint).toBeGreaterThan(first.referencePrice ?? 0);
    expect(first.direction).toBe("up");
    expect(first.changePct).toBeCloseTo((((first.endpoint ?? 0) - (first.referencePrice ?? 1)) / (first.referencePrice ?? 1)) * 100, 8);
    expect(first.points).toHaveLength(6);
    const bar = first.points[1];
    expect(bar.open).toBe(first.referencePrice);
    expect(bar.price).toBeGreaterThan(bar.open ?? 0);
    expect(bar.high ?? 0).toBeGreaterThanOrEqual(Math.max(bar.open ?? 0, bar.price));
    expect(bar.low ?? 0).toBeLessThanOrEqual(Math.min(bar.open ?? 0, bar.price));
    expect(first.validation.mae).not.toBeNull();
    expect(first.validation.mae ?? 99).toBeLessThan(1);
    expect(first.bands).toBe(true);
  });

  it("skips the weekend and a listed holiday", () => {
    const candles = weekdayCandles(Array.from({ length: 40 }, () => 250));
    const next = buildForecast({ symbol: "TCS", timeframe: "1d", horizon: "1d", candles, now: new Date("2026-10-09T10:00:00Z") });
    expect(kolkataParts(new Date((next.endTime ?? 0) * 1000)).dateKey).toBe("2026-10-12");
    const holiday = buildForecast({ symbol: "TCS", timeframe: "1d", horizon: "1d", candles, holidays: ["2026-10-12"], now: new Date("2026-10-09T10:00:00Z") });
    expect(kolkataParts(new Date((holiday.endTime ?? 0) * 1000)).dateKey).toBe("2026-10-13");
  });

  it("rejects a short history and a horizon shorter than one bar", () => {
    const short = buildForecast({ symbol: "INFY", timeframe: "1d", horizon: "5d", candles: weekdayCandles(Array.from({ length: 12 }, (_, index) => 80 + index)) });
    expect(short.status).toBe("insufficient");
    expect(short.points).toEqual([]);
    const hourly = Array.from({ length: 40 }, (_, index) => ({
      time: 1_700_000_000 + index * 3600,
      open: 50,
      high: 51,
      low: 49,
      close: 50 + index * 0.1,
      volume: 10,
    }));
    const blocked = buildForecast({ symbol: "INFY", timeframe: "1h", horizon: "15m", candles: hourly });
    expect(blocked.status).toBe("unavailable");
    expect(blocked.points).toEqual([]);
  });

  it("uses the same result after duplicate and out-of-order candles are cleaned", () => {
    const candles = weekdayCandles(Array.from({ length: 40 }, (_, index) => 20 + index * 0.4));
    const messy = [candles[3], { ...candles[3], close: candles[3].close }, ...candles.slice().reverse()];
    const clean = buildForecast({ symbol: "SBIN", timeframe: "1d", horizon: "3d", candles, now: new Date("2026-10-09T10:00:00Z") });
    const dirty = buildForecast({ symbol: "SBIN", timeframe: "1d", horizon: "3d", candles: messy, now: new Date("2026-10-09T10:00:00Z") });
    expect(dirty.endpoint).toBe(clean.endpoint);
    expect(dirty.points.map((point) => point.time)).toEqual(clean.points.map((point) => point.time));
  });

  it("reaches a one-month horizon from one-minute bars", () => {
    const candles = Array.from({ length: 40 }, (_, index) => ({
      time: FRIDAY - (39 - index) * 60,
      open: 100,
      high: 101,
      low: 99,
      close: 100 + index * 0.05,
      volume: 10,
    }));
    const result = buildForecast({ symbol: "RELIANCE", timeframe: "1m", horizon: "1mo", candles, now: new Date("2026-10-09T10:00:00Z") });
    expect(result.status).toBe("ready");
    expect(result.endTime ?? 0).toBeGreaterThan(FRIDAY + 20 * 86400);
    expect(result.points.length).toBeLessThanOrEqual(160);
    expect(result.points[result.points.length - 1]?.price).toBeGreaterThan(0);
  });

  it("does not call a random generator", () => {
    const engine = readFileSync(new URL("../src/lib/market/forecast.ts", import.meta.url), "utf8");
    const route = readFileSync(new URL("../src/app/api/market/forecast/route.ts", import.meta.url), "utf8");
    expect(engine).not.toMatch(/Math\.random/);
    expect(route).not.toMatch(/Math\.random/);
  });
});
