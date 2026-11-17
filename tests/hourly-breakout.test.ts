import { describe, expect, it } from "vitest";
import { bodyBreakout, candleTwo, firstBreakout, intrabarTrigger } from "@/lib/algo/hourly-breakout";
import type { Candle } from "@/lib/algo/lines";

const at = (clock: string) => Date.UTC(2026, 8, 1, +clock.slice(0, 2), +clock.slice(3, 5)) / 1000 - 19_800;
const flat = (from: string, minutes: number, price: number, high = price + 1, low = price - 1): Candle[] =>
  Array.from({ length: minutes }, (_, index) => ({ time: at(from) + index * 60, open: price, high, low, close: price }));

describe("Mathi Hourly Breakout — 1%", () => {
  it("builds candle 2 from 10:15–11:14 only and needs all 60 minutes", () => {
    const candles = [...flat("09:15", 60, 100, 200, 50), ...flat("10:15", 60, 100, 105, 95), ...flat("11:15", 5, 100, 300, 10)];
    expect(candleTwo(candles)).toMatchObject({ high: 105, low: 95, minutes: 60 });
    expect(candleTwo(candles.filter((candle) => candle.time !== at("10:40")))).toBeNull();
  });

  it("applies the 20% body rule from the brief's formula", () => {
    // Body 10 (100 → 110), level 108: 2 beyond = 20% → valid.
    expect(bodyBreakout({ time: 0, open: 100, high: 111, low: 99, close: 110 }, "CALL", 108, 0.2)).toMatchObject({ beyond: 2, beyondPercent: 20 });
    // Level 108.5: 1.5 beyond = 15% → not valid.
    expect(bodyBreakout({ time: 0, open: 100, high: 111, low: 99, close: 110 }, "CALL", 108.5, 0.2)).toBeNull();
    // Wick-only: high above the level, close below → not valid.
    expect(bodyBreakout({ time: 0, open: 100, high: 112, low: 99, close: 105 }, "CALL", 108, 0.2)).toBeNull();
    // Red candle that stays above the level (open 112 → close 110): beyond = 110 − 112 < 0 → not valid.
    expect(bodyBreakout({ time: 0, open: 112, high: 113, low: 109, close: 110 }, "CALL", 108, 0.2)).toBeNull();
    // PUT mirror: open 100 → close 90, level 92: 2 beyond of 10 → valid.
    expect(bodyBreakout({ time: 0, open: 100, high: 101, low: 89, close: 90 }, "PUT", 92, 0.2)).toMatchObject({ side: "PUT", beyond: 2 });
    // Doji closing beyond: no body → not valid.
    expect(bodyBreakout({ time: 0, open: 110, high: 111, low: 109, close: 110 }, "CALL", 108, 0.2)).toBeNull();
  });

  it("takes the first valid breakout and ignores the later opposite one", () => {
    const base = [...flat("09:15", 60, 100), ...flat("10:15", 60, 100, 105, 95)];
    const put = { time: at("11:40"), open: 96, high: 96, low: 90, close: 91 };
    const call = { time: at("12:10"), open: 104, high: 112, low: 104, close: 111 };
    const day = firstBreakout([...base, ...flat("11:15", 25, 100), put, call]);
    expect(day.signal?.side).toBe("PUT");
    expect(day.signal?.candle.time).toBe(at("11:40"));
  });

  it("rolling: candle 2's levels during 11:15–12:15, then the 11:15 hour's levels during 12:15–13:15", () => {
    const base = [...flat("09:15", 60, 100), ...flat("10:15", 60, 100, 110, 90), ...flat("11:15", 60, 100, 104, 96), ...flat("12:15", 10, 100)];
    // 12:25 breaks the 11:15 hour's LOW (96) but not candle 2's LOW (90).
    const put = { time: at("12:25"), open: 97, high: 97, low: 93, close: 94 };
    expect(firstBreakout([...base, put]).signal).toBeNull();
    const rolling = firstBreakout([...base, put], { bodyShare: 0.2, entryCutoff: "14:15", levels: "rolling" });
    expect(rolling.signal).toMatchObject({ side: "PUT", level: 96 });
  });

  it("continuation: a failed CALL is cancelled, then the PUT breaks and holds", () => {
    const settings = { bodyShare: 0.2, entryCutoff: "14:15", levels: "fixed" as const, continuation: true };
    const base = [...flat("09:15", 60, 100), ...flat("10:15", 60, 100, 105, 95), ...flat("11:15", 10, 100)];
    const callBreak = { time: at("11:25"), open: 104, high: 107, low: 104, close: 106 };
    const backInside = { time: at("11:26"), open: 106, high: 106, low: 103, close: 103.5 };
    const callAgain = { time: at("11:30"), open: 104, high: 108, low: 104, close: 107 };
    const putBreak = { time: at("11:40"), open: 96, high: 96, low: 92, close: 93 };
    const putHolds = { time: at("11:41"), open: 93, high: 94, low: 91, close: 92 };
    const day = firstBreakout([...base, callBreak, backInside, ...flat("11:27", 3, 100), callAgain, ...flat("11:31", 9, 100), putBreak, putHolds], settings);
    expect(day.signal?.side).toBe("PUT");
    expect(day.signal?.candle.time).toBe(at("11:41"));
  });

  it("continuation: the cancelling candle can itself be the opposite breakout", () => {
    const settings = { bodyShare: 0.2, entryCutoff: "14:15", levels: "fixed" as const, continuation: true };
    const base = [...flat("09:15", 60, 100), ...flat("10:15", 60, 100, 105, 95), ...flat("11:15", 10, 100)];
    const callBreak = { time: at("11:25"), open: 104, high: 107, low: 104, close: 106 };
    const crash = { time: at("11:26"), open: 106, high: 106, low: 90, close: 91 };
    const holds = { time: at("11:27"), open: 91, high: 92, low: 89, close: 90 };
    expect(firstBreakout([...base, callBreak, crash, holds], settings).signal).toMatchObject({ side: "PUT", level: 95 });
  });

  it("intrabar: enters inside the minute when 20% of the forming body is beyond, even if it closes back", () => {
    // Open 100, level 105: trigger p with (p − 105) = 0.2 (p − 100) → p = 106.25.
    expect(intrabarTrigger(100, 105, "CALL", 0.2)).toBeCloseTo(106.25);
    expect(intrabarTrigger(100, 95, "PUT", 0.2)).toBeCloseTo(93.75);
    const settings = { bodyShare: 0.2, entryCutoff: "14:15", levels: "fixed" as const, intrabar: true };
    const base = [...flat("09:15", 60, 100), ...flat("10:15", 60, 100, 105, 95), ...flat("11:15", 10, 100)];
    const spike = { time: at("11:25"), open: 100, high: 106.5, low: 99, close: 101 };
    const day = firstBreakout([...base, spike], settings);
    expect(day.signal).toMatchObject({ side: "CALL", trigger: 106.25 });
    // Reaching both triggers in one minute: order unknown → skipped.
    const both = { time: at("11:25"), open: 100, high: 107, low: 93, close: 100 };
    expect(firstBreakout([...base, both], settings).signal).toBeNull();
  });

  it("candidate (F): a weak close inside is tolerated, a strong one cancels, then a new break re-arms", () => {
    const settings = { bodyShare: 0.2, entryCutoff: "14:15", levels: "fixed" as const, candidate: true };
    const base = [...flat("09:15", 60, 100), ...flat("10:15", 60, 100, 105, 95), ...flat("11:15", 10, 100)];
    const brk = { time: at("11:25"), open: 104, high: 107, low: 104, close: 106 };
    // Weak: open 106 → close 104.9 (body 1.1, only 0.1 below 105 = 9%): kept.
    const weak = { time: at("11:26"), open: 106, high: 106, low: 104.5, close: 104.9 };
    const cont = { time: at("11:27"), open: 104.9, high: 106, low: 104.8, close: 105.6 };
    expect(firstBreakout([...base, brk, weak, cont], settings).signal?.candle.time).toBe(at("11:27"));
    // Strong: open 106 → close 102 (3 of 4 below 105 = 75%): cancelled; 11:27 closing above is then no entry.
    const strong = { time: at("11:26"), open: 106, high: 106, low: 101.5, close: 102 };
    expect(firstBreakout([...base, brk, strong, cont], settings).signal).toBeNull();
  });

  it("F3: a weak close inside enters only after a strong (≥ 50%) breakout candle", () => {
    const settings = { bodyShare: 0.2, entryCutoff: "14:15", levels: "fixed" as const, candidate: true, weakEnters: true, weakEntersMinBreak: 0.5 };
    const base = [...flat("09:15", 60, 100), ...flat("10:15", 60, 100, 105, 95), ...flat("11:15", 10, 100)];
    // Like 23 Feb 2026: PUT break with 79% of the body below 95, next candle closes 0.05 back inside (weak) → entry there.
    const strongBreak = { time: at("11:25"), open: 96, high: 96.1, low: 90.5, close: 91 };
    const weakBack = { time: at("11:26"), open: 91, high: 95.1, low: 90.8, close: 95.05 };
    expect(firstBreakout([...base, strongBreak, weakBack], settings).signal?.candle.time).toBe(at("11:26"));
    // A weak breakout (30% beyond) followed by the same weak close: no entry (F keeps waiting).
    const weakBreak = { time: at("11:25"), open: 98, high: 98, low: 92.5, close: 94 };
    expect(firstBreakout([...base, weakBreak, { ...weakBack, open: 94 }], settings).signal).toBeNull();
  });

  it("G: enters inside the 2nd candle once it crosses the breakout candle's low; no cross = cancelled", () => {
    const settings = { bodyShare: 0.2, entryCutoff: "14:15", levels: "fixed" as const, crossEntry: true };
    const base = [...flat("09:15", 60, 100), ...flat("10:15", 60, 100, 105, 95), ...flat("11:15", 10, 100)];
    const first = { time: at("11:25"), open: 96, high: 96.1, low: 92, close: 93 };
    const crosses = { time: at("11:26"), open: 93, high: 94, low: 91, close: 93.5 };
    expect(firstBreakout([...base, first, crosses], settings).signal).toMatchObject({ side: "PUT", trigger: 91.95 });
    expect(firstBreakout([...base, first, crosses], settings).signal?.candle.time).toBe(at("11:26"));
    const holds = { time: at("11:26"), open: 93, high: 95.5, low: 92.5, close: 95.2 };
    expect(firstBreakout([...base, first, holds], settings).signal).toBeNull();
  });

  it("does not read candles that close after the 14:15 cutoff, and has no fallback", () => {
    const base = [...flat("09:15", 60, 100), ...flat("10:15", 60, 100, 105, 95), ...flat("11:15", 180, 100)];
    expect(firstBreakout([...base, { time: at("14:15"), open: 104, high: 112, low: 104, close: 111 }]).signal).toBeNull();
    expect(firstBreakout([...base, { time: at("14:14"), open: 104, high: 112, low: 104, close: 111 }]).signal?.side).toBe("CALL");
  });
});
