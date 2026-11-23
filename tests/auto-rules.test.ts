import { describe, expect, it } from "vitest";
import { chargeRupees, lotsFor, newTarget, newTrail, targetStep, trailStart, trailStep, trailStopLevel } from "@/lib/auto/exits";
import { bodyBreak, decide, eventOn, minuteSignal, planF, secondHourDecision, sensexExpiry, type Bar, type Minutes } from "@/lib/auto/rules";
import { optionCharges } from "@/lib/options/engine";

// The 5-year parity (all research trades of the 8 strategies: same entry minute, strike, CE/PE, buy, exit minute and
// exit price) is run by the parity script on the research data (D:/TRADING); these tests pin the formulas.

const flat = (from: number, to: number, price: number): Minutes => new Map(Array.from({ length: to - from + 1 }, (_, i) => [from + i, { o: price, h: price + 1, l: price - 1, c: price } as Bar]));

describe("trailing exit: min(+2%, +₹2) on the option premium", () => {
  it("starts at the lower of +2% and +₹2", () => {
    expect(trailStart(50).level).toBe(51); // 2% of ₹50 = ₹1 < ₹2
    expect(trailStart(150).level).toBe(152); // 2% = ₹3 > ₹2 → +₹2
  });

  it("starts only on a trade at start + 1 tick with volume, then trails 1% of the buy price and never below the start", () => {
    const s = newTrail(100, null);
    expect(trailStep(s, 700, { o: 100, h: 102, l: 100, c: 101.5, v: 10 })).toBeNull(); // 102 = start, not start + tick
    expect(s.active).toBe(false);
    expect(trailStep(s, 701, { o: 101.5, h: 104, l: 101.5, c: 104, v: 0 })).toBeNull(); // no volume
    expect(s.active).toBe(false);
    expect(trailStep(s, 702, { o: 104, h: 105, l: 104, c: 105, v: 5 })).toBeNull();
    expect(s.active).toBe(true);
    expect(trailStopLevel(s)).toBe(104); // 105 − ₹1
    const hit = trailStep(s, 703, { o: 104.5, h: 104.5, l: 103, c: 103.5, v: 5 });
    expect(hit).toEqual({ minute: 703, price: 103.95, reason: "TRAIL_STOP" }); // sold 1 tick below the stop
  });

  it("trade 2: +0.5% lock until the trail starts", () => {
    const s = newTrail(100, 0.5);
    expect(trailStep(s, 700, { o: 100, h: 100.6, l: 100, c: 100.55, v: 3 })).toBeNull(); // armed at +0.5%, closes above it
    expect(trailStep(s, 701, { o: 100.5, h: 100.5, l: 100.2, c: 100.3, v: 3 })).toEqual({ minute: 701, price: 100.45, reason: "LOCK_STOP" });
  });

  it("reads each candle once (a repeated check cannot move the trail twice)", () => {
    const s = newTrail(100, null);
    trailStep(s, 702, { o: 104, h: 105, l: 104, c: 105, v: 5 });
    expect(trailStep(s, 702, { o: 104, h: 120, l: 50, c: 60, v: 5 })).toBeNull();
  });

  it("MonWed: +1.48% fills in the first minute whose high reaches it", () => {
    const t = newTarget(100, 0.0148);
    expect(targetStep(t, 615, { o: 100, h: 101.47, l: 99, c: 101 })).toBeNull();
    expect(targetStep(t, 616, { o: 101, h: 101.5, l: 100, c: 101 })).toEqual({ minute: 616, price: 101.48, reason: "TARGET" });
  });
});

describe("₹20,000 sizing and charges", () => {
  it("buys whole lots whose cost plus charges fits the wallet (never more)", () => {
    expect(lotsFor(100, 65, 20_000)).toBe(3); // 3 × 65 × 100 = 19,500 + charges < 20,000
    expect(lotsFor(102, 65, 20_000)).toBe(3);
    expect(lotsFor(400, 65, 20_000)).toBe(0); // one lot costs 26,000: the signal is skipped
    const k = lotsFor(102.55, 65, 20_000);
    expect(k * 65 * 102.55 + chargeRupees("BUY", 102.55, k * 65)).toBeLessThanOrEqual(20_000);
  });

  it("charges are the app's option charges", () => {
    for (const [p, q] of [[100, 195], [57.35, 260], [250.05, 65]] as const) {
      expect(chargeRupees("BUY", p, q)).toBe(Number(optionCharges("BUY", BigInt(Math.round(p * 100)), q).total) / 100);
      expect(chargeRupees("SELL", p, q)).toBe(Number(optionCharges("SELL", BigInt(Math.round(p * 100)), q).total) / 100);
    }
  });
});

describe("entry rules and time limits", () => {
  it("20% body rule and flip tiny", () => {
    expect(bodyBreak({ o: 100, h: 111, l: 99, c: 110 }, "CALL", 108)).toBe(2);
    expect(bodyBreak({ o: 100, h: 111, l: 99, c: 110 }, "CALL", 109)).toBeNull();
    expect(decide({ side: "CALL", level: 100, brk: 0, conf: 1, firstClose: 101, confClose: 102 })).toEqual({ right: "PE", flip: true });
    expect(decide({ side: "CALL", level: 100, brk: 0, conf: 1, firstClose: 102, confClose: 103 })).toEqual({ right: "CE", flip: false });
  });

  it("Second Hour: nothing before the 10:15 hour is complete, and no trade after 12:10", () => {
    const n = flat(555, 700, 25_000);
    expect(secondHourDecision(n, { date: "2026-11-26", prevClose: 25_000, daysToExpiry: 2 }, { onlyDays: null, oneTrade: false, allowGapDown: true, wedMomentum: true }, 675).kind).toBe("WAIT");
    expect(secondHourDecision(n, { date: "2026-11-26", prevClose: 25_000, daysToExpiry: 2 }, { onlyDays: null, oneTrade: false, allowGapDown: true, wedMomentum: true }, 740)).toMatchObject({ kind: "SKIP", reason: "no breakout signal by 12:10" });
    expect(secondHourDecision(n, { date: "2026-11-25", prevClose: 25_000, daysToExpiry: 2 }, { onlyDays: ["Tue", "Thu"], oneTrade: false, allowGapDown: true, wedMomentum: true }, 700)).toMatchObject({ kind: "SKIP" });
  });

  it("only reads the candles it is given (no look-ahead): a later breakout is invisible earlier", () => {
    const n = flat(555, 760, 25_000);
    n.set(700, { o: 25_000, h: 25_010, l: 24_999, c: 25_009 }); // breaks the 10:15 hour high (25,001)
    n.set(701, { o: 25_009, h: 25_012, l: 25_005, c: 25_010 }); // confirms
    const early = new Map([...n].filter(([m]) => m < 701));
    expect(planF(early)).toBeNull();
    expect(planF(n)).toMatchObject({ side: "CALL", brk: 700, conf: 701 });
  });

  it("13:15 Minute reads the 13:15 candle only from 13:16", () => {
    const n = flat(555, 830, 25_000);
    n.set(800, { o: 25_000, h: 25_010, l: 24_999, c: 25_009 });
    n.set(801, { o: 25_009, h: 25_012, l: 25_005, c: 25_010 });
    expect(minuteSignal(n, 796, 825)).toMatchObject({ side: "CALL", conf: 801 });
  });
});

describe("calendars", () => {
  const tradingDay = (d: string) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  it("SENSEX weekly expiry by the exchange rule (Friday → Tuesday → Thursday)", () => {
    expect(sensexExpiry("2024-06-07", tradingDay)).toBe(true); // Friday era
    expect(sensexExpiry("2025-03-04", tradingDay)).toBe(true); // Tuesday era
    expect(sensexExpiry("2026-11-26", tradingDay)).toBe(true); // Thursday era
    expect(sensexExpiry("2026-11-24", tradingDay)).toBe(false);
    expect(sensexExpiry("2026-11-25", (d) => tradingDay(d) && d !== "2026-11-26")).toBe(true); // holiday → previous day
  });

  it("MonWed events: RBI day, Fed week and the session after the decision", () => {
    const lists = { rbi: ["2026-12-04"], fomc: ["2026-12-09"], election: [], budget: [], tariff: [] };
    const next = (d: string) => ({ "2026-12-09": "2026-12-10" } as Record<string, string>)[d] ?? null;
    expect(eventOn("2026-12-04", lists, next)).toBe("RBI policy");
    expect(eventOn("2026-12-07", lists, next)).toBe("Fed week");
    expect(eventOn("2026-12-10", lists, next)).toBe("Fed reaction");
    expect(eventOn("2026-12-14", lists, next)).toBeNull();
  });
});
