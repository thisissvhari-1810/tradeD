import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/algo/lines";
import { minuteTrendLines, priceOn } from "@/lib/chart/trendlines";

// Real NIFTY 1-minute candles (Dhan, 09:16-09:50; the API has no 09:15 bar for these days) for the user's two examples.
type Row = [string, number, number, number, number];
const NOV19: Row[] = [
  ["09:16", 25195.9, 25222.6, 25186.7, 25211.05], ["09:17", 25211.9, 25235.45, 25206.95, 25230.85], ["09:18", 25230.25, 25255.6, 25230.25, 25238.85],
  ["09:19", 25241.5, 25241.5, 25198.65, 25199.15], ["09:20", 25203.2, 25203.2, 25173.95, 25177.3], ["09:21", 25177.8, 25181.15, 25150.55, 25151.3],
  ["09:22", 25153.3, 25168.05, 25146.9, 25151.2], ["09:23", 25151.3, 25163.7, 25139.3, 25141.65], ["09:24", 25144.45, 25165.75, 25140.55, 25162.05],
  ["09:25", 25164.55, 25167.4, 25143.15, 25154.8], ["09:26", 25154.4, 25157.0, 25142.2, 25151.25], ["09:27", 25151.9, 25155.4, 25134.25, 25135.6],
  ["09:28", 25137.65, 25139.5, 25118.65, 25119.1], ["09:29", 25122.65, 25125.9, 25115.9, 25116.2], ["09:30", 25118.7, 25135.8, 25104.8, 25133.65],
  ["09:31", 25134.25, 25144.55, 25129.45, 25136.7], ["09:32", 25136.4, 25144.95, 25111.15, 25112.4], ["09:33", 25114.55, 25143.95, 25111.8, 25141.35],
  ["09:34", 25141.25, 25152.8, 25140.2, 25141.7], ["09:35", 25143.85, 25166.95, 25133.45, 25166.9], ["09:36", 25169.35, 25183.05, 25165.7, 25181.6],
  ["09:37", 25182.05, 25195.35, 25171.2, 25195.35], ["09:38", 25195.35, 25208.0, 25188.7, 25189.15], ["09:39", 25191.9, 25197.45, 25181.2, 25183.7],
  ["09:40", 25188.85, 25220.25, 25186.55, 25218.45], ["09:41", 25218.55, 25233.05, 25213.2, 25233.05], ["09:42", 25232.35, 25236.1, 25217.7, 25223.65],
  ["09:43", 25227.2, 25227.6, 25214.75, 25225.15], ["09:44", 25225.0, 25227.85, 25216.7, 25224.85], ["09:45", 25224.8, 25240.05, 25224.8, 25236.95],
  ["09:46", 25236.25, 25249.6, 25234.7, 25237.85], ["09:47", 25238.35, 25245.7, 25234.85, 25242.75], ["09:48", 25243.0, 25248.25, 25237.05, 25239.0],
  ["09:49", 25240.25, 25257.3, 25235.0, 25257.1], ["09:50", 25257.4, 25272.4, 25257.4, 25269.85],
];
const NOV23: Row[] = [
  ["09:16", 25974.1, 25979.65, 25920.3, 25927.5], ["09:17", 25929.3, 25936.3, 25877.75, 25882.75], ["09:18", 25881.2, 25898.65, 25859.0, 25860.2],
  ["09:19", 25860.35, 25867.85, 25851.2, 25860.2], ["09:20", 25861.65, 25878.4, 25840.9, 25841.05], ["09:21", 25841.1, 25848.25, 25821.7, 25827.1],
  ["09:22", 25828.4, 25845.65, 25820.0, 25843.75], ["09:23", 25845.35, 25846.35, 25817.25, 25819.9], ["09:24", 25820.1, 25821.7, 25783.65, 25784.05],
  ["09:25", 25782.6, 25786.95, 25715.4, 25738.5], ["09:26", 25737.45, 25748.95, 25703.65, 25711.1], ["09:27", 25708.75, 25725.6, 25697.1, 25722.25],
  ["09:28", 25723.75, 25732.35, 25681.05, 25682.95], ["09:29", 25685.5, 25693.5, 25668.85, 25675.25], ["09:30", 25674.9, 25733.7, 25674.9, 25707.05],
  ["09:31", 25709.15, 25710.15, 25667.5, 25669.9], ["09:32", 25671.1, 25672.7, 25633.4, 25633.4], ["09:33", 25635.9, 25637.5, 25620.4, 25624.45],
  ["09:34", 25626.65, 25626.9, 25572.2, 25573.15], ["09:35", 25573.2, 25612.65, 25567.3, 25583.95], ["09:36", 25583.3, 25656.3, 25576.45, 25645.25],
  ["09:37", 25643.75, 25695.95, 25641.55, 25695.95], ["09:38", 25693.15, 25715.7, 25691.4, 25713.95], ["09:39", 25716.8, 25716.8, 25669.85, 25685.95],
  ["09:40", 25685.9, 25686.75, 25642.2, 25647.25], ["09:41", 25649.8, 25661.95, 25635.85, 25657.1], ["09:42", 25658.2, 25673.45, 25645.1, 25665.8],
  ["09:43", 25668.3, 25705.6, 25663.55, 25681.0], ["09:44", 25682.4, 25693.55, 25677.9, 25690.8], ["09:45", 25693.25, 25694.7, 25671.9, 25676.3],
  ["09:46", 25675.35, 25690.65, 25658.7, 25676.5], ["09:47", 25678.4, 25678.4, 25653.05, 25659.3], ["09:48", 25658.0, 25663.0, 25649.7, 25662.55],
  ["09:49", 25662.3, 25664.15, 25647.05, 25660.4], ["09:50", 25661.9, 25666.7, 25638.8, 25648.15],
];

const day = (date: string, rows: Row[]) => {
  const [y, m, d] = date.split("-").map(Number);
  const open = Date.UTC(y, m - 1, d, 3, 45) / 1000;
  const tape: Candle[] = rows.map(([clock, o, h, l, c]) => ({ time: open + ((+clock.slice(0, 2) * 60 + +clock.slice(3)) - 555) * 60, open: o, high: h, low: l, close: c }));
  return { open, close: open + 375 * 60, tape, at: (clock: string) => open + ((+clock.slice(0, 2) * 60 + +clock.slice(3)) - 555) * 60 };
};

describe("Mathi Trend Channel, 1-minute (the user's examples)", () => {
  it("19 Nov: 1st Low > 1st High > 2nd Low (2 lows + 1 high), broken up at 09:35, CALL at 09:36", () => {
    const { open, close, tape, at } = day("2026-11-19", NOV19);
    const state = minuteTrendLines(tape, open, close, close + 60);
    expect(state.points).toEqual([
      { kind: "LOW", time: at("09:16"), price: 25186.7 },
      { kind: "HIGH", time: at("09:18"), price: 25255.6 },
      { kind: "LOW", time: at("09:23"), price: 25139.3 }, // the user's "2nd Low 25,139.30"
    ]);
    expect(state.pattern).toBe("B");
    // The clone through 1st High is parallel to the line through the two lows.
    expect(state.upper!.slope).toBeCloseTo(state.lower!.slope, 10);
    expect(priceOn(state.upper!, at("09:18"))).toBeCloseTo(25255.6, 6);
    expect(state.signal).toMatchObject({ side: "CALL", fallback: false, breakout: { time: at("09:35") }, entry: { time: at("09:36") } });
  });

  it("23 Nov: 1st High > 1st Low > 2nd High (2 highs + 1 low); the block low moves down to the 09:35 low", () => {
    const { open, close, tape, at } = day("2026-11-23", NOV23);
    const state = minuteTrendLines(tape, open, close, close + 60);
    expect(state.points).toEqual([
      { kind: "HIGH", time: at("09:16"), price: 25979.65 },
      { kind: "LOW", time: at("09:35"), price: 25567.3 },
      { kind: "HIGH", time: at("09:39"), price: 25716.8 },
    ]);
    expect(state.pattern).toBe("A");
    expect(priceOn(state.lower!, at("09:35"))).toBeCloseTo(25567.3, 6);
    expect(state.signal).toMatchObject({ side: "CALL", fallback: false });
  });

  it("shows only what was known at the time", () => {
    const { open, close, tape, at } = day("2026-11-23", NOV23);
    expect(minuteTrendLines(tape, open, close, at("09:20")).points).toHaveLength(1); // the low is still moving
    expect(minuteTrendLines(tape, open, close, at("09:38")).points).toHaveLength(1); // 09:35 not yet 3 quiet candles
    const formed = minuteTrendLines(tape, open, close, at("09:43"));
    expect(formed.points).toHaveLength(3);
    expect(formed.signal).toBeNull();
  });

  it("falls back to the day's direction at 11:00 when no channel entry happens", () => {
    const flat: Candle[] = Array.from({ length: 375 }, (_, i) => ({ time: 1_795_060_000 + i * 60, open: 25000 - i * 0.1, high: 25000.5 - i * 0.1, low: 24999.5 - i * 0.1, close: 25000 - i * 0.1 }));
    const state = minuteTrendLines(flat, 1_795_060_000, 1_795_060_000 + 375 * 60, 1_795_060_000 + 376 * 60);
    expect(state.signal).toMatchObject({ side: "PUT", fallback: true, entry: { time: 1_795_060_000 + 104 * 60 } });
  });
});

describe("Mathi Trend Channel on the chart's own candles", () => {
  it("reads 5-minute candles on a 5-minute chart (23 Nov: 1st High on the 09:15 candle, 1st Low on the 09:35 candle)", () => {
    // The full day (real candles, 23 Nov) gives 1st High 25,979.65 > 1st Low 25,567.30 > 2nd High 25,705.60 (09:40 candle).
    const { open, close, tape, at } = day("2026-11-23", NOV23);
    const state = minuteTrendLines(tape, open, close, close + 300, 300);
    expect(state.points.map((point) => [point.kind, point.time, point.price])).toEqual([
      ["HIGH", at("09:15"), 25979.65],
      ["LOW", at("09:35"), 25567.3],
    ]);
    // Only completed 5-minute candles count.
    expect(minuteTrendLines(tape, open, close, at("09:29"), 300).points).toHaveLength(0);
  });

  it("has no 11:00 daily rule on candles bigger than 5 minutes", () => {
    const flat: Candle[] = Array.from({ length: 375 }, (_, i) => ({ time: 1_795_060_000 + i * 60, open: 25000 - i * 0.1, high: 25000.5 - i * 0.1, low: 24999.5 - i * 0.1, close: 25000 - i * 0.1 }));
    expect(minuteTrendLines(flat, 1_795_060_000, 1_795_060_000 + 375 * 60, 1_795_060_000 + 376 * 60, 900).signal).toBeNull();
  });
});
