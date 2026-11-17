import { describe, expect, it } from "vitest";
import { ALGO_STRATEGIES, isVariantStrategy, STRATEGY_NAME } from "../src/lib/algo/exclusive";
import { algoConfigProblems, readAlgoConfig } from "../src/lib/algo/config";
import type { Candle } from "../src/lib/algo/lines";
import { createReplayAdapter, simulateSession, type ReplayChain } from "../src/lib/algo/replay-adapter";
import { ALGO_DEFAULTS, MATHI_CHANNEL_DEFAULTS, type AlgoConfig, type AlgoEvent } from "../src/lib/algo/runner";
import { algoRequest } from "../src/lib/algo/request";
import { BAR_SECONDS, CHANNEL_SETTINGS_DEFAULTS, channelPrice, channelSignal, horizontalZones, threeMinuteBars, type ChannelSwing } from "../src/lib/algo/trend-channel";

/* Mathi Trend Channel: first valid deep-swing combination → primary line → exact parallel clone → breakout → next candle. */

const DATE = "2026-10-26";
const OPEN = Date.UTC(2026, 9, 26, 3, 45) / 1000; // 09:15 IST
const clock = (time: number) => new Date((time + 19_800) * 1000).toISOString().slice(11, 16);
const RULES = CHANNEL_SETTINGS_DEFAULTS;

type Bar = { open: number; high: number; low: number; close: number };

/** Three 1-minute candles making one 3-minute candle with exactly this open, high, low and close. */
function minutesOf(x: number, bar: Bar): Candle[] {
  const time = OPEN + x * BAR_SECONDS;
  return [
    { time, open: bar.open, high: bar.high, low: Math.min(bar.open, bar.close), close: bar.open },
    { time: time + 60, open: bar.open, high: Math.max(bar.open, bar.close), low: bar.low, close: bar.close },
    { time: time + 120, open: bar.close, high: bar.close, low: bar.close, close: bar.close },
  ];
}

/** 3-minute candles walking straight between pivots (x, close); each candle's range is its body ± 1 point. */
function walk(pivots: Array<[number, number]>, last = 124): Bar[] {
  const at = (x: number) => {
    const right = pivots.findIndex(([px]) => px >= x);
    if (right <= 0) return pivots[right < 0 ? pivots.length - 1 : 0][1];
    const [x0, y0] = pivots[right - 1];
    const [x1, y1] = pivots[right];
    return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  };
  const bars: Bar[] = [];
  for (let x = 1; x <= last; x += 1) {
    const open = x === 1 ? at(1) : at(x - 1);
    const close = at(x);
    bars.push({ open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close });
  }
  return bars;
}

/** A session: C1 (09:15) plus candles from 09:18. */
const day = (c1: Bar, bars: Bar[]) => [minutesOf(0, c1), ...bars.map((bar, index) => minutesOf(index + 1, bar))].flat();
const mirror = (bar: Bar, around = 25_000): Bar => ({ open: 2 * around - bar.open, high: 2 * around - bar.low, low: 2 * around - bar.high, close: 2 * around - bar.close });

/** C1 spikes to 25,500 (it would be the first deep high if it were used); then H1 09:18, L1 09:39, H2 10:03. */
const SPIKE: Bar = { open: 25_195, high: 25_500, low: 25_190, close: 25_200 };
const A_PATH: Array<[number, number]> = [[1, 25_200], [8, 25_050], [16, 25_150], [20, 25_100], [27, 25_170], [40, 25_200], [124, 25_200]];
const patternA = (c1 = SPIKE, path = A_PATH) => day(c1, walk(path));
const patternB = () => day(mirror(SPIKE), walk(A_PATH).map((bar) => mirror(bar)));
const barEnd = (x: number) => OPEN + (x + 1) * BAR_SECONDS;
const full = (candles: Candle[], settings = RULES) => channelSignal(candles, OPEN, settings, candles.at(-1)!.time + 60);
const upTo = (candles: Candle[], end: number, settings = RULES) => channelSignal(candles.filter((candle) => candle.time + 60 <= end), OPEN, settings, end);

describe("Mathi Trend Channel — 3-minute candles and C1", () => {
  it("builds 3-minute candles on the 09:15 grid from completed 1-minute candles", () => {
    const bars = threeMinuteBars(patternA(), OPEN);
    expect(bars).toHaveLength(125);
    expect(bars[0]).toMatchObject({ x: 0, time: OPEN, end: OPEN + 180, open: 25_195, high: 25_500, low: 25_190, close: 25_200, completedAt: OPEN + 180 });
    expect(clock(bars[1].time)).toBe("09:18");
    // A candle missing its last minute completes with the next minute the feed has.
    const gap = patternA().filter((candle) => candle.time !== OPEN + 180 + 120);
    expect(threeMinuteBars(gap, OPEN)[1].completedAt).toBe(OPEN + 360 + 60);
    // The forming candle is not complete.
    expect(threeMinuteBars(patternA().filter((candle) => candle.time < OPEN + 240), OPEN).at(-1)!.completedAt).toBe(0);
  });

  it("never uses C1: a 25,500 spike at 09:15 is not a swing, not a comparison and changes nothing", () => {
    const result = full(patternA());
    expect(result.state.c1).toMatchObject({ high: 25_500 });
    expect(result.state.swings.every((swing) => swing.time > OPEN)).toBe(true);
    expect(clock(result.state.pattern!.points[0].time)).toBe("09:18");
    const quiet = full(patternA({ open: 25_199, high: 25_200, low: 25_198, close: 25_200 }));
    expect(quiet.state.swings).toEqual(result.state.swings);
    expect(quiet.state.setups).toEqual(result.state.setups);
    expect(quiet.signal).toEqual(result.signal);
  });
});

describe("Mathi Trend Channel — Test Case A: 2 deep highs + 1 deep low", () => {
  const result = full(patternA());
  const { pattern, upper, lower } = result.state;

  it("selects the first valid combination H1 → L1 → H2 in chronological order", () => {
    expect(pattern!.kind).toBe("A");
    expect(pattern!.points.map((point) => [point.label, point.kind, clock(point.time), point.price])).toEqual([
      ["H1", "HIGH", "09:18", 25_201],
      ["L1", "LOW", "09:39", 25_049],
      ["H2", "HIGH", "10:03", 25_151],
    ]);
    // Locked when H2 was confirmed: its third later candle (10:12) closed.
    expect(clock(pattern!.completedAt)).toBe("10:15");
  });

  it("draws the primary line through H1 and H2 and clones it parallel through L1", () => {
    expect(upper!.role).toBe("PRIMARY");
    expect(lower!.role).toBe("CLONE");
    expect(upper!.slope).toBeCloseTo(-50 / 15, 12);
    // The clone carries the primary's own slope value: identical, not recomputed.
    expect(Object.is(lower!.slope, upper!.slope)).toBe(true);
    const [h1, l1, h2] = pattern!.points;
    expect(channelPrice(upper!, h1.x)).toBeCloseTo(h1.price, 9);
    expect(channelPrice(upper!, h2.x)).toBeCloseTo(h2.price, 9);
    expect(channelPrice(lower!, l1.x)).toBeCloseTo(l1.price, 9);
    // Constant distance: the same at every candle, and equal to the reported width.
    const widths = Array.from({ length: 125 }, (_, x) => channelPrice(upper!, x) - channelPrice(lower!, x));
    for (const width of widths) expect(width).toBeCloseTo(widths[0], 9);
    expect(result.state.width).toBeCloseTo(widths[0], 2);
    expect(channelPrice(upper!, l1.x)).toBeGreaterThan(l1.price);
  });

  it("keeps horizontal resistance at the highs and support at the lows", () => {
    const resistance = result.state.zones.filter((zone) => zone.kind === "RESISTANCE").map((zone) => zone.high);
    const support = result.state.zones.filter((zone) => zone.kind === "SUPPORT").map((zone) => zone.low);
    expect(resistance).toEqual(expect.arrayContaining([25_151, 25_201]));
    expect(support).toEqual(expect.arrayContaining([25_049, 25_099]));
  });

  it("WATCH on a channel-only break, BREAKOUT once resistance also breaks, CALL when the next candle crosses its high", () => {
    const [watch, breakout] = result.state.setups;
    expect([watch.status, watch.direction, clock(watch.time), watch.close, watch.level]).toEqual(["WATCH", "CALL", "10:24", 25_130, 25_151]);
    expect(watch.close).toBeGreaterThan(watch.line);
    expect([breakout.status, clock(breakout.time), breakout.close, breakout.high, breakout.low, breakout.level]).toEqual(["CONFIRMED", "10:33", 25_160, 25_161, 25_149, 25_151]);
    expect(breakout.confirm).toMatchObject({ high: 25_171, close: 25_170 });
    expect(clock(breakout.confirm!.time)).toBe("10:36");
  });

  it("signals the ATM CALL only on the minute the confirming candle completes", () => {
    const at = barEnd(27);
    expect(clock(at)).toBe("10:39");
    const now = upTo(patternA(), at);
    expect(now.signal).toMatchObject({ strategy: "channel", direction: "CALL", level: 25_151, trigger: 25_170 });
    expect(now.signal!.reason).toMatch(/Pattern A \(H1 25201\.00 09:18, L1 25049\.00 09:39, H2 25151\.00 10:03\)/);
    expect(upTo(patternA(), at - 60).signal).toBeNull();
    expect(upTo(patternA(), at + 60).signal).toBeNull();
    // At the breakout candle's close: waiting for the next candle, no entry.
    expect(upTo(patternA(), barEnd(26)).state.status).toMatch(/Bullish breakout at 10:33: waiting for the next candle to cross above 25161\.00/);
    expect(upTo(patternA(), barEnd(23)).latest.map((setup) => setup.status)).toEqual(["WATCH"]);
  });

  it("skips the trade when the next candle does not cross the breakout high", () => {
    // The 10:36 candle closes at 25,155: high 25,161 — not above the breakout high 25,161.
    const flat: Array<[number, number]> = [[1, 25_200], [8, 25_050], [16, 25_150], [20, 25_100], [26, 25_160], [27, 25_155], [40, 25_120], [124, 25_120]];
    const result = full(patternA(SPIKE, flat));
    const breakout = result.state.setups.find((setup) => setup.status !== "WATCH")!;
    expect([breakout.status, clock(breakout.time)]).toEqual(["FAILED", "10:33"]);
    expect(breakout.reasons.at(-1)).toMatch(/NOT CONFIRMED — skipped: 10:36 candle high 25161\.00 did not cross above the breakout high 25161\.00/);
    expect(upTo(patternA(SPIKE, flat), barEnd(27)).signal).toBeNull();
    expect(upTo(patternA(SPIKE, flat), barEnd(27)).decided?.status).toBe("FAILED");
  });

  it("skips the trade when the next candle crosses the high but closes back under resistance", () => {
    const candles = patternA().map((candle) => (candle.time === OPEN + 27 * BAR_SECONDS + 120 ? { ...candle, open: 25_150, high: 25_150, low: 25_140, close: 25_140 } : candle));
    const breakout = full(candles).state.setups.find((setup) => setup.status !== "WATCH")!;
    expect(breakout.status).toBe("FAILED");
    expect(breakout.reasons.at(-1)).toMatch(/closed 25140\.00, not above resistance 25151\.00/);
  });

  it("channel-only mode (research) enters on the channel break alone", () => {
    const settings = { ...RULES, requireLevel: false, minMomentumPercent: 0 };
    const result = full(patternA(), settings);
    const first = result.state.setups[0];
    expect([first.status, clock(first.time), first.level]).toEqual(["CONFIRMED", "10:24", null]);
    expect(upTo(patternA(), barEnd(24), settings).signal).toMatchObject({ direction: "CALL" });
  });

  it("skips a confirmed breakout that fails the strong-candle or momentum rule (logged with the reason)", () => {
    // The 10:33 breakout candle: body 10 of a 12-point range (83%); 10:36 close 25,170 is +50 points (0.199%) on 15 minutes.
    expect(full(patternA()).state.setups[1].status).toBe("CONFIRMED");
    const body = full(patternA(), { ...RULES, minBreakoutBody: 90 }).state.setups[1];
    expect(body.status).toBe("FAILED");
    expect(body.reasons.at(-1)).toMatch(/RULE — skipped: the breakout candle's body is 83% of its range \(needs 90%\)/);
    const momentum = full(patternA(), { ...RULES, minMomentumPercent: 0.25 }).state.setups[1];
    expect(momentum.status).toBe("FAILED");
    expect(momentum.reasons.at(-1)).toMatch(/NIFTY moved 0\.199% up in the last 15 minutes \(needs 0\.25%\)/);
    expect(upTo(patternA(), barEnd(27), { ...RULES, minMomentumPercent: 0.25 }).signal).toBeNull();
    // Both off: the confirmation alone decides.
    expect(full(patternA(), { ...RULES, minBreakoutBody: 0, minMomentumPercent: 0 }).state.setups[1].status).toBe("CONFIRMED");
  });

  it("retest: enters only after price comes back to the broken level and a later candle closes above the retest high", () => {
    // Breakout 10:33 above 25,151, confirmed 10:36; back to 25,152 at 10:42 (within 0.03%); 10:45 closes 25,190.
    const path: Array<[number, number]> = [[1, 25_200], [8, 25_050], [16, 25_150], [20, 25_100], [27, 25_170], [29, 25_153], [30, 25_190], [40, 25_200], [124, 25_200]];
    for (const retest of ["after", "instead"] as const) {
      const settings = { ...RULES, retest };
      const setup = full(patternA(SPIKE, path), settings).state.setups.find((item) => item.status !== "WATCH")!;
      expect([setup.status, clock(setup.retest!.time), setup.retest!.low, clock(setup.entry!.time)]).toEqual(["CONFIRMED", "10:42", 25_152, "10:45"]);
      expect(setup.reasons.join(" ")).toMatch(/RETEST HELD — price came back to 25152\.00 at 10:42 \(level 25151\.00\)/);
      expect(upTo(patternA(SPIKE, path), barEnd(27), settings).signal).toBeNull();
      expect(upTo(patternA(SPIKE, path), barEnd(30), settings).signal).toMatchObject({ direction: "CALL", trigger: 25_190 });
    }
    // Without a retest within the window the setup is skipped.
    const none = full(patternA(), { ...RULES, retest: "after", retestCandles: 3 }).state.setups.find((item) => item.status !== "WATCH")!;
    expect(none.status).toBe("FAILED");
    expect(none.reasons.at(-1)).toMatch(/NO RETEST — skipped: no retest of 25151\.00 within 3 candles/);
  });

  it("daily trade: at the fallback time a CALL / PUT from the day's direction or the channel", () => {
    const at = OPEN + (14 * 60 - 555) * 60; // the 13:57 candle closes at 14:00
    const daymove = upTo(patternA(), at, { ...RULES, fallback: "daymove", fallbackTime: "14:00" });
    expect(daymove.signal).toMatchObject({ direction: "CALL", level: 25_195 });
    expect(daymove.signal!.reason).toMatch(/DAILY TRADE at 14:00 \(no setup traded yet today\): NIFTY 25200\.00 is at or above the 09:15 open 25195\.00 → ATM CALL/);
    expect(upTo(patternA(), at - 180, { ...RULES, fallback: "daymove", fallbackTime: "14:00" }).signal).toBeNull();
    expect(upTo(patternA(), at, { ...RULES, fallback: "off" }).signal).toBeNull();
    // Default: the daily trade at 11:00 from the day's direction (NIFTY 25,184 at 11:00 is below the 25,195 open → PUT).
    expect(upTo(patternA(), OPEN + (11 * 60 - 555) * 60, RULES).signal).toMatchObject({ direction: "PUT" });
    expect(upTo(patternB(), at, { ...RULES, fallback: "daymove", fallbackTime: "14:00" }).signal).toMatchObject({ direction: "PUT" });
    expect(upTo(patternA(), at, { ...RULES, fallback: "channel", fallbackTime: "14:00" }).signal!.reason).toMatch(/above the channel → ATM CALL/);
  });

  it("opening-gap rule: no CALL after a gap-up open, no PUT after a gap-down open", () => {
    const at = barEnd(27);
    // 09:15 opened 25,195: a previous close of 25,100 is a gap-up (CALL skipped), 25,300 a gap-down (CALL allowed).
    const up = channelSignal(patternA().filter((candle) => candle.time + 60 <= at), OPEN, { ...RULES, gapRule: true, fallback: "off" }, at, 25_100);
    expect(up.signal).toBeNull();
    expect(up.decided!.reasons.at(-1)).toMatch(/NIFTY opened 25195\.00, above the previous close 25100\.00 — no CALL on a gap-up day/);
    expect(channelSignal(patternA().filter((candle) => candle.time + 60 <= at), OPEN, { ...RULES, gapRule: true }, at, 25_300).signal).toMatchObject({ direction: "CALL" });
    expect(channelSignal(patternA().filter((candle) => candle.time + 60 <= at), OPEN, { ...RULES, gapRule: false }, at, 25_100).signal).toMatchObject({ direction: "CALL" });
  });

  it("does not trade Pattern A when only Pattern B is enabled", () => {
    const result = upTo(patternA(), barEnd(27), { ...RULES, patterns: "B" });
    expect(result.signal).toBeNull();
    expect(result.state.status).toMatch(/Pattern A selected — not traded \(settings: Pattern B only\)/);
    expect(upTo(patternA(), barEnd(27), { ...RULES, patterns: "A" }).signal).not.toBeNull();
  });
});

describe("Mathi Trend Channel — Test Case B: 2 deep lows + 1 deep high", () => {
  const result = full(patternB());
  const { pattern, upper, lower } = result.state;

  it("selects L1 → H1 → L2 and clones the lower line through H1", () => {
    expect(pattern!.kind).toBe("B");
    expect(pattern!.points.map((point) => [point.label, clock(point.time), point.price])).toEqual([["L1", "09:18", 24_799], ["H1", "09:39", 24_951], ["L2", "10:03", 24_849]]);
    expect(lower!.role).toBe("PRIMARY");
    expect(upper!.role).toBe("CLONE");
    expect(Object.is(upper!.slope, lower!.slope)).toBe(true);
    expect(lower!.slope).toBeCloseTo(50 / 15, 12);
    const [l1, h1, l2] = pattern!.points;
    expect(channelPrice(lower!, l1.x)).toBeCloseTo(l1.price, 9);
    expect(channelPrice(lower!, l2.x)).toBeCloseTo(l2.price, 9);
    expect(channelPrice(upper!, h1.x)).toBeCloseTo(h1.price, 9);
  });

  it("WATCH below the lower line, BREAKDOWN below support, PUT when the next candle crosses its low", () => {
    const [watch, breakdown] = result.state.setups;
    expect([watch.status, watch.direction, clock(watch.time), watch.level]).toEqual(["WATCH", "PUT", "10:24", 24_849]);
    expect([breakdown.status, clock(breakdown.time), breakdown.low, breakdown.level]).toEqual(["CONFIRMED", "10:33", 24_839, 24_849]);
    expect(upTo(patternB(), barEnd(27)).signal).toMatchObject({ direction: "PUT", level: 24_849 });
  });
});

describe("Mathi Trend Channel — properties on random sessions", () => {
  /** A seeded random walk: 125 three-minute candles. */
  function randomDay(seed: number): Candle[] {
    let state = seed;
    const random = () => ((state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    let price = 25_000;
    const bars: Bar[] = [];
    for (let x = 0; x < 125; x += 1) {
      const open = price;
      price += (random() - 0.5) * 30 + Math.sin(x / (6 + seed % 7)) * 6;
      bars.push({ open, high: Math.max(open, price) + random() * 8, low: Math.min(open, price) - random() * 8, close: price });
    }
    return bars.flatMap((bar, x) => minutesOf(x, bar));
  }
  const seeds = Array.from({ length: 200 }, (_, index) => index + 1);

  it("both boundaries always share one slope, pass through their swings and alternate in time", () => {
    let patterns = 0;
    for (const seed of seeds) {
      const { pattern, upper, lower } = full(randomDay(seed)).state;
      if (!pattern) continue;
      patterns += 1;
      expect(Object.is(upper!.slope, lower!.slope)).toBe(true);
      const [a, b, c] = pattern.points;
      expect(a.time < b.time && b.time < c.time).toBe(true);
      expect([a.kind, b.kind, c.kind]).toEqual(pattern.kind === "A" ? ["HIGH", "LOW", "HIGH"] : ["LOW", "HIGH", "LOW"]);
      const primary = pattern.kind === "A" ? upper! : lower!;
      const clone = pattern.kind === "A" ? lower! : upper!;
      expect(channelPrice(primary, a.x)).toBeCloseTo(a.price, 6);
      expect(channelPrice(primary, c.x)).toBeCloseTo(c.price, 6);
      expect(channelPrice(clone, b.x)).toBeCloseTo(b.price, 6);
      expect(channelPrice(upper!, 0) - channelPrice(lower!, 0)).toBeCloseTo(channelPrice(upper!, 124) - channelPrice(lower!, 124), 6);
      // The middle swing is beyond the primary line, so the clone is on the right side: a real channel.
      expect(pattern.kind === "A" ? b.price < Math.min(a.price, c.price) : b.price > Math.max(a.price, c.price)).toBe(true);
      expect(channelPrice(upper!, b.x)).toBeGreaterThan(channelPrice(lower!, b.x));
    }
    expect(patterns).toBeGreaterThan(150);
  });

  it("never repaints: every result known at a minute is the same later (swings, combination, setups)", () => {
    for (const seed of seeds.slice(0, 25)) {
      const candles = randomDay(seed);
      const final = full(candles).state;
      for (let end = OPEN + 600; end <= OPEN + 22_500; end += 180) {
        const then = upTo(candles, end).state;
        if (then.pattern) expect(then.pattern).toEqual(final.pattern);
        for (const setup of then.setups) {
          const later = final.setups.find((item) => item.id === setup.id);
          expect(later).toBeDefined();
          if (setup.status === "AWAITING") expect({ ...later!, status: "AWAITING", confirm: null, entry: null, decidedAt: null, reasons: later!.reasons.slice(0, 1) }).toEqual(setup);
          else expect(later).toEqual(setup);
        }
        // Only swings confirmed by then were used.
        for (const swing of then.swings) expect(swing.confirmedAt).toBeLessThanOrEqual(end);
      }
    }
  }, 120_000);

  it("the first candle never affects the result", () => {
    for (const seed of seeds.slice(0, 50)) {
      const candles = randomDay(seed);
      const spiked = candles.map((candle) => (candle.time < OPEN + 180 ? { ...candle, high: candle.high + 400, low: candle.low - 400 } : candle));
      const a = full(candles);
      const b = full(spiked);
      expect(b.state.swings).toEqual(a.state.swings);
      expect(b.state.setups).toEqual(a.state.setups);
    }
  });
});

describe("Mathi Trend Channel — horizontal zones", () => {
  const swing = (kind: "HIGH" | "LOW", price: number, time: number): ChannelSwing => ({ kind, label: "", time, x: 0, price, confirmedAt: time + 540 });
  it("merges nearby swing levels into one zone and keeps distant ones apart", () => {
    const zones = horizontalZones([swing("HIGH", 25_100, 1), swing("HIGH", 25_108, 2), swing("HIGH", 25_200, 3), swing("LOW", 24_900, 4)], 0.05);
    expect(zones.map((zone) => [zone.kind, zone.low, zone.high, zone.members.length])).toEqual([["RESISTANCE", 25_100, 25_108, 2], ["RESISTANCE", 25_200, 25_200, 1], ["SUPPORT", 24_900, 24_900, 1]]);
  });
});

/** NIFTY weekly strikes every 50; each option moves 0.5 per NIFTY point from ₹100 at 25,000 (CE up, PE down). */
const CHAIN: ReplayChain = {
  symbol: "NIFTY", expiry: "2026-10-27", kind: "index", lotSize: 65,
  strikes: Array.from({ length: 21 }, (_, index) => 24_500 + index * 50).map((strike) => ({ strike, ce: { securityId: `CE:${strike}` }, pe: { securityId: `PE:${strike}` } })),
};
function tapes(candles: Candle[]) {
  return async (contract: { right: string }) => candles.map((candle) => {
    const at = (spot: number) => Math.round((contract.right === "PE" ? 100 - (spot - 25_000) * 0.5 : 100 + (spot - 25_000) * 0.5) * 100) / 100;
    const values = [at(candle.open), at(candle.high), at(candle.low), at(candle.close)];
    return { time: candle.time, open: values[0], high: Math.max(...values), low: Math.min(...values), close: values[3] };
  });
}
async function replay(candles: Candle[], config: AlgoConfig = { ...MATHI_CHANNEL_DEFAULTS, mode: "REPLAY" }) {
  const adapter = createReplayAdapter({ candles, chain: CHAIN, config, capital: 100_000, tapeOf: tapes(candles) });
  return simulateSession({ sessionId: `${DATE}.channel`, date: DATE, config, candles, lines: [], adapter, startNote: "test" });
}
const entries = (events: AlgoEvent[]) => events.filter((event) => event.kind === "ENTRY" && event.order?.status === "FILLED");

describe("Mathi Trend Channel — the runner", { timeout: 60_000 }, () => {
  it("buys the ATM CALL at 10:39 on Pattern A and the ATM PUT on Pattern B, with Mathi Strategy's execution", async () => {
    const a = await replay(patternA());
    const [call] = entries(a.events);
    expect([call.side, clock(call.time + 60), call.contract?.strike]).toEqual(["CALL", "10:39", 25_150]);
    expect(call.setup).toMatchObject({ strategy: "channel", direction: "CALL", level: 25_151 });
    expect(call.target).toBeCloseTo(call.order!.price! * 1.03, 1);
    const b = await replay(patternB());
    expect(entries(b.events).map((event) => [event.side, clock(event.time + 60)])[0]).toEqual(["PUT", "10:39"]);
   }, 60_000);

  it("daily trade: enters at the fallback time only on a day without a traded setup", async () => {
    const daily: AlgoConfig = { ...MATHI_CHANNEL_DEFAULTS, mode: "REPLAY", channel: { ...CHANNEL_SETTINGS_DEFAULTS, fallback: "daymove", fallbackTime: "14:00" } };
    // A setup trades at 10:39: the 14:00 daily trade is not taken (one trade a day).
    expect(entries((await replay(patternA(), daily)).events).map((event) => clock(event.time + 60))).toEqual(["10:39"]);
    // The setup fails its momentum rule: the daily trade is the day's trade.
    const noSetup: AlgoConfig = { ...daily, channel: { ...daily.channel!, minMomentumPercent: 1 } };
    const [trade] = entries((await replay(patternA(), noSetup)).events);
    expect([trade.side, clock(trade.time + 60)]).toEqual(["CALL", "14:00"]);
  });

  it("trades on expiry day by default; skipExpiryDay stops it", async () => {
    // The test chain's weekly expiry is 2026-10-27; a session on that date is expiry day.
    const expiryDay = patternA().map((candle) => ({ ...candle, time: candle.time + 86_400 }));
    const day = (config: AlgoConfig) => simulateSession({ sessionId: "2026-10-27.channel", date: "2026-10-27", config, candles: expiryDay, lines: [], adapter: createReplayAdapter({ candles: expiryDay, chain: CHAIN, config, capital: 100_000, tapeOf: tapes(expiryDay) }), startNote: "test" });
    expect(entries((await day({ ...MATHI_CHANNEL_DEFAULTS, mode: "REPLAY" })).events)).toHaveLength(1);
    const run = await day({ ...MATHI_CHANNEL_DEFAULTS, mode: "REPLAY", channel: { ...CHANNEL_SETTINGS_DEFAULTS, skipExpiryDay: true } });
    expect(entries(run.events)).toHaveLength(0);
    expect(run.events.some((event) => (event.reasons ?? []).some((reason) => reason.startsWith("EXPIRY DAY")))).toBe(true);
    // The day before expiry trades as usual.
    expect(entries((await replay(patternA())).events)).toHaveLength(1);
  });

  it("logs the WATCH and never enters on it", async () => {
    const { events } = await replay(patternA());
    const watch = events.find((event) => event.key === `eval:${OPEN + 23 * BAR_SECONDS + 120}`);
    expect(watch?.message).toMatch(/WATCH — 10:24 candle closed 25130\.00 above the upper channel line/);
    expect(entries(events).every((event) => clock(event.time + 60) !== "10:27")).toBe(true);
  });

  it("logs a skipped confirmation as REJECTED with its reason", async () => {
    const flat: Array<[number, number]> = [[1, 25_200], [8, 25_050], [16, 25_150], [20, 25_100], [26, 25_160], [27, 25_155], [40, 25_120], [124, 25_120]];
    const { events } = await replay(patternA(SPIKE, flat));
    const skipped = events.find((event) => event.key === `eval:${OPEN + 27 * BAR_SECONDS + 120}`);
    expect(skipped?.kind).toBe("REJECTED");
    expect(skipped?.reasons?.[0]).toMatch(/SKIPPED — CALL breakout at 10:33: NOT CONFIRMED/);
    expect(entries(events).filter((event) => clock(event.time + 60) === "10:39")).toHaveLength(0);
  });

  it("is its own strategy: own settings, name and requests; Mathi Strategy's defaults unchanged", () => {
    expect(ALGO_DEFAULTS.engine).toBe("existing");
    expect(ALGO_DEFAULTS.channel).toBeUndefined();
    expect(ALGO_STRATEGIES).toContain("MATHI_CHANNEL");
    expect(isVariantStrategy("MATHI_CHANNEL")).toBe(true);
    expect(STRATEGY_NAME.MATHI_CHANNEL).toBe("Mathi Trend Channel");
    for (const op of ["start", "stop", "tick", "exit"]) expect(algoRequest.safeParse({ action: "variant", strategy: "MATHI_CHANNEL", op }).success).toBe(true);
    expect(algoRequest.safeParse({ action: "save", strategy: "MATHI_CHANNEL", config: {} }).success).toBe(true);
    const saved = readAlgoConfig(JSON.parse(JSON.stringify(MATHI_CHANNEL_DEFAULTS)));
    expect(saved).toMatchObject({ engine: "channel", channel: CHANNEL_SETTINGS_DEFAULTS, target: { mode: "percent", value: 3 }, stopLoss: false, maxTrades: 1, maxHoldMinutes: 0, exitManagement: { mode: "fixed" }, regime: { enabled: false }, confirmation: { mode: "single" }, intrabar: false });
    expect(algoConfigProblems(saved)).toEqual([]);
    expect(algoConfigProblems({ ...saved, channel: { ...CHANNEL_SETTINGS_DEFAULTS, right: 0 } }).join(" ")).toMatch(/right \(confirming\) candles must be 1 to 10/);
    expect(algoConfigProblems({ ...saved, underlying: "BANKNIFTY" }).join(" ")).toMatch(/NIFTY 50 options only/);
  });
});
