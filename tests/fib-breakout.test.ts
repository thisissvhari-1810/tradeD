import { describe, expect, it } from "vitest";
import {
  atmStrike, clockOf, contractSymbol, evaluateContractDay, FIB_DEFAULTS, FIB_FIRST_MINUTE_FILTERED, FIB_V0, fibLevels, fibPrice, hhmm, niftyLotSize, tradeCharges, type MinuteBar,
} from "@/lib/algo/fib-breakout";

/** First-hour reference only (rolling off). */
const ONE = { ...FIB_V0, referenceHours: 1 };
/** Rolling reference hours 2, 3, 4 (optional, off by default). */
const ROLL = { ...FIB_V0, referenceHours: 4 };
const H = 230.35;
const L = 220.2;

/** A 1-minute tape: each hour [09:15 + 60(k−1), +60) is a straight path from `from` to `to`. */
function tape(hours: [number, number][]): MinuteBar[] {
  const bars: MinuteBar[] = [];
  hours.forEach(([from, to], hour) => {
    for (let i = 0; i < 60; i += 1) {
      const t = hhmm("09:15") + hour * 60 + i;
      if (t >= hhmm("15:30")) continue;
      const open = from + ((to - from) * i) / 60;
      const close = from + ((to - from) * (i + 1)) / 60;
      bars.push({ t, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 100 });
    }
  });
  return bars;
}
/** Replace the bar at `clock` (keeps the rest of the tape). */
const put = (bars: MinuteBar[], clock: string, bar: Omit<MinuteBar, "t">) => bars.map((b) => (b.t === hhmm(clock) ? { t: b.t, volume: 100, ...bar } : b));

describe("Fibonacci levels — the supplied ₹220.20–₹230.35 example", () => {
  it("GREEN: price = L + R × level", () => {
    const at = (level: number) => fibPrice(H, L, "GREEN", level);
    expect(at(0.382)).toBeCloseTo(224.0773, 4); // spec table shows ₹224.09
    expect(at(0.236)).toBeCloseTo(222.5954, 4);
    const table: [number, number][] = [[1, 230.35], [0.786, 228.18], [0.618, 226.46], [0.382, 224.09], [0.236, 222.6], [0, 220.2]];
    for (const [level, price] of table) expect(Math.abs(at(level) - price)).toBeLessThan(0.0151);
  });
  it("RED: price = H − R × level (0 = High at the top, 1 = Low at the bottom)", () => {
    const at = (level: number) => fibPrice(H, L, "RED", level);
    expect(at(0)).toBeCloseTo(230.35, 6);
    expect(at(1)).toBeCloseTo(220.2, 6);
    expect(at(0.786)).toBeCloseTo(222.3721, 4);
    const table: [number, number][] = [[1, 220.2], [0.786, 222.37], [0.618, 224.09], [0.382, 226.47], [0.236, 227.96], [0, 230.35]];
    for (const [level, price] of table) expect(Math.abs(at(level) - price)).toBeLessThan(0.0151);
  });
  it("GREEN and RED are mirror images", () => {
    for (const { level, price } of fibLevels(H, L, "GREEN")) expect(price).toBeCloseTo(fibPrice(H, L, "RED", 1 - level), 9);
  });
});

describe("live-price breakout above the trigger from below", () => {
  it("GREEN: falls below 0.236 (ambiguous minute, no entry), then crosses back above → intraminute buy; sells at 0.382", () => {
    const bars = tape([[220.5, 229.5], [229.5, 221], [221, 226], [226, 226], [226, 226], [226, 226], [226, 226]]);
    const r = evaluateContractDay("CE", bars, ONE);
    expect(r.direction).toBe("GREEN");
    expect(r.startedBelow).toBe(false);
    expect(r.ambiguousMinutes.length).toBe(1); // the minute that fell through the trigger
    expect(r.entry!.fill).toBe("INTRAMINUTE");
    expect(r.entry!.price).toBeCloseTo(r.triggerOrder! + 0.1, 6);
    expect(r.entry!.time).toBeGreaterThanOrEqual(hhmm("11:15"));
    expect(r.exit!.reason).toBe("TARGET");
    expect(r.exit!.time).toBeGreaterThan(r.entry!.time + 1);
  });

  it("RED: first hour closes below 0.786; the rise through 0.786 buys; sells at 0.618 (13-Nov PUT)", () => {
    const bars = tape([[229.5, 220.5], [220.5, 225], [225, 225], [225, 225], [225, 225], [225, 225], [225, 225]]);
    const r = evaluateContractDay("PE", bars, FIB_V0);
    expect(r.direction).toBe("RED");
    expect(r.startedBelow).toBe(true);
    expect(r.entry!.fill).toBe("INTRAMINUTE");
    expect(r.entry!.time).toBeLessThan(hhmm("11:15"));
    expect(r.targetLevelPrice!).toBeGreaterThan(r.entryLevelPrice!);
    expect(r.exit!.reason).toBe("TARGET");
  });

  it("GAP_OPEN: below the trigger, the next minute opens above it → fill at that open; target checked in the same minute", () => {
    let bars = tape([[229.5, 220.5], [220.5, 220.5], [220.5, 220.5], [220.5, 220.5], [220.5, 220.5], [220.5, 220.5], [220.5, 220.5]]);
    bars = put(bars, "11:00", { open: 223, high: 226, low: 223, close: 225 });
    const r = evaluateContractDay("PE", bars, FIB_V0);
    expect(r.entry!.fill).toBe("GAP_OPEN");
    expect(r.entry!.price).toBeCloseTo(223.1, 6);
    expect(r.exit!.reason).toBe("TARGET");
    expect(clockOf(r.exit!.time)).toBe("11:01");
  });

  it("INTRAMINUTE_ARMED: a minute opening above, trading below and closing above the trigger buys", () => {
    const bars = put(tape([[220.5, 229.5], [229.5, 229.5], [229.5, 229.5], [229.5, 229.5], [229.5, 229.5], [229.5, 229.5], [229.5, 229.5]]), "11:00", { open: 226, high: 226, low: 221, close: 223 });
    const r = evaluateContractDay("CE", bars, FIB_V0);
    expect(r.entry!.fill).toBe("INTRAMINUTE_ARMED");
    expect(clockOf(r.entry!.time)).toBe("11:00");
  });

  it("never above → below → above: price that stays above the trigger all day is NO ENTRY (never forced)", () => {
    const bars = tape([[220.5, 229.5], [229.5, 228], [228, 228], [228, 228], [228, 228], [228, 228], [228, 228]]);
    const r = evaluateContractDay("CE", bars, FIB_V0);
    expect(r.status).toBe("NO_ENTRY");
    expect(r.entry).toBeNull();
  });

  it("no look-ahead: one minute before the entry minute completes there is no entry; at its end the same entry", () => {
    const bars = tape([[229.5, 220.5], [220.5, 225], [225, 225], [225, 225], [225, 225], [225, 225], [225, 225]]);
    const full = evaluateContractDay("PE", bars, FIB_V0);
    expect(evaluateContractDay("PE", bars, FIB_V0, full.entry!.time).entry).toBeNull();
    expect(evaluateContractDay("PE", bars, FIB_V0, full.entry!.time + 1).entry).toEqual(full.entry);
  });

  it("target not reached → square-off at the 15:29 open minus slippage", () => {
    const bars = tape([[220.5, 229.5], [229.5, 221], [221, 223], [223, 222], [222, 221], [221, 220], [220, 219]]);
    const r = evaluateContractDay("CE", bars, FIB_V0);
    expect(r.exit!.reason).toBe("SQUARE_OFF");
    expect(clockOf(r.exit!.time)).toBe("15:29");
    const at1529 = bars.find((b) => b.t === hhmm("15:29"))!;
    expect(r.exit!.price).toBeCloseTo(Math.floor((at1529.open - 0.1) / 0.05 + 1e-9) * 0.05, 6);
  });

  it("a touch without a tick through is not a target fill (conservative); touch mode accepts it", () => {
    const base = tape([[229.5, 220.5], [220.5, 223], [223, 223], [223, 223], [223, 223], [223, 223], [223, 223]]);
    const target = evaluateContractDay("PE", base, FIB_V0).targetOrder!;
    const touched = base.map((bar) => (bar.t === hhmm("13:00") ? { ...bar, high: target } : bar));
    expect(evaluateContractDay("PE", touched, FIB_V0).exit!.reason).toBe("SQUARE_OFF");
    expect(evaluateContractDay("PE", touched, { ...FIB_V0, targetFill: "touch" }).exit!.reason).toBe("TARGET");
  });

  it("one entry per contract per day", () => {
    const bars = tape([[229.5, 220.5], [220.5, 225], [225, 220.5], [220.5, 225], [225, 220.5], [220.5, 225], [225, 225]]);
    const r = evaluateContractDay("PE", bars, FIB_V0);
    expect(r.entry!.time).toBeLessThan(hhmm("11:15"));
  });

  it("an incomplete first hour is reported, not traded; a doji has no setup", () => {
    const thin = tape([[221, 229], [229, 221], [221, 224], [224, 226], [226, 226], [226, 226], [226, 226]]).filter((b) => b.t !== hhmm("09:15"));
    expect(evaluateContractDay("CE", thin, FIB_V0).status).toBe("INCOMPLETE");
    expect(evaluateContractDay("CE", tape([[225, 225], [225, 221], [221, 224], [224, 226], [226, 226], [226, 226], [226, 226]]), ONE).status).toBe("NO_SETUP");
  });
});

describe("optional rolling reference hours 2, 3, 4 (off by default)", () => {
  it("no entry from the 1st hour's levels by 11:15 → the 2nd hour's candle becomes the reference", () => {
    // hour 1 GREEN 100 → 140 (trigger 0.236 = 109.44); hour 2 stays above it (RED 140 → 130); hour 3 dips to 128 and comes back to 136
    const bars = tape([[100, 140], [140, 130], [130, 128], [128, 136], [136, 136], [136, 136], [136, 136]]);
    expect(evaluateContractDay("CE", bars, ONE).status).toBe("NO_ENTRY");
    const r = evaluateContractDay("CE", bars, ROLL);
    expect(r.reference!.hour).toBeGreaterThan(1);
    expect(r.entry!.time).toBeGreaterThanOrEqual(hhmm("11:15"));
    expect(r.entry!.time).toBeGreaterThanOrEqual(r.reference!.end);
    // the levels are the reference candle's own (no later data)
    const ref = r.reference!;
    expect(r.entryLevelPrice!).toBeCloseTo(fibPrice(ref.high, ref.low, r.direction!, r.entryLevel!), 9);
  });

  it("the 2nd hour's levels are only used from 11:15 (no look-ahead) and there is still one entry a day", () => {
    const bars = tape([[100, 140], [140, 130], [130, 128], [128, 136], [136, 136], [136, 136], [136, 136]]);
    const r = evaluateContractDay("CE", bars, ROLL);
    expect(evaluateContractDay("CE", bars, ROLL, r.entry!.time).entry).toBeNull();
    expect(evaluateContractDay("CE", bars, ROLL, r.entry!.time + 1).entry).toEqual(r.entry);
  });

  it("no cross in any reference window → NO ENTRY (never forced)", () => {
    const bars = tape([[100, 140], [140, 150], [150, 160], [160, 170], [170, 180], [180, 190], [190, 200]]);
    const r = evaluateContractDay("CE", bars, ROLL);
    expect(r.status).toBe("NO_ENTRY");
    expect(r.note).toContain("hour 4");
  });
});

describe("first minute: default (no filters) and the saved filtered alternative (user, 17 Nov 2026)", () => {
  /** 1-minute tape: [time, open, high, low, close] rows (09:15 is the reference candle). */
  const m = (rows: [string, number, number, number, number][]): MinuteBar[] => rows.map(([c, o, h, l, cl]) => ({ t: hhmm(c), open: o, high: h, low: l, close: cl, volume: 100 }));
  // 09:15 candle RED: O 120 H 130 L 100 C 105 → trigger 0.786 = 130 − 30×0.786 = 106.42 (stop 106.45), target 0.618 = 111.46 (order 111.50)
  const base: [string, number, number, number, number][] = [["09:15", 120, 130, 100, 105], ["09:16", 105, 105.5, 104, 104.5], ["09:17", 104.5, 107, 104.5, 106.8], ["09:18", 107, 113, 107, 112.5]];
  for (let t = hhmm("09:19"); t <= hhmm("15:29"); t += 1) base.push([clockOf(t), 112, 112.5, 111.8, 112]);
  it("defaults: 1-minute reference, V0 levels, no filters; filtered alternative and V0 kept", () => {
    expect(FIB_DEFAULTS.hourMinutes).toBe(1);
    expect(FIB_DEFAULTS.redEntryLevel).toBe(0.786);
    expect(FIB_DEFAULTS.skipExpiryDay).toBe(false);
    expect(FIB_DEFAULTS.minTargetPct).toBe(0);
    expect(FIB_FIRST_MINUTE_FILTERED.skipExpiryDay).toBe(true);
    expect(FIB_FIRST_MINUTE_FILTERED.minTargetPct).toBe(5);
    expect(FIB_V0.hourMinutes).toBe(60);
    expect(FIB_V0.minTargetPct).toBe(0);
  });
  it("levels come from the 09:15 one-minute candle; entry from 09:16 at the live cross; exit at the Fib target", () => {
    const r = evaluateContractDay("PE", m(base), { ...FIB_DEFAULTS, minTargetPct: 0 }, 24 * 60, { dte: 2 });
    expect(r.direction).toBe("RED");
    expect(r.entryLevelPrice!).toBeCloseTo(106.42, 2);
    expect(clockOf(r.entry!.time)).toBe("09:17");
    expect(r.entry!.price).toBeCloseTo(106.55, 6);          // 106.45 + 2 ticks
    expect(r.exit!.reason).toBe("TARGET");
    expect(r.exit!.price).toBeCloseTo(111.5, 6);
  });
  it("target under 5% above the buy price → NO ENTRY (small target); 5% or more trades", () => {
    // target 111.50 vs buy 106.55 = +4.65% → skipped under the filtered alternative's 5%; the default trades it
    expect(evaluateContractDay("PE", m(base), FIB_DEFAULTS, 24 * 60, { dte: 2 }).exit!.reason).toBe("TARGET");
    const r = evaluateContractDay("PE", m(base), FIB_FIRST_MINUTE_FILTERED, 24 * 60, { dte: 2 });
    expect(r.status).toBe("NO_ENTRY");
    expect(r.skipReason).toBe("SMALL_TARGET");
    const ok = evaluateContractDay("PE", m(base), { ...FIB_FIRST_MINUTE_FILTERED, minTargetPct: 4 }, 24 * 60, { dte: 2 });
    expect(ok.status).toBe("CLOSED");
    expect(ok.exit!.reason).toBe("TARGET");
  });
  it("expiry day → NO ENTRY (expiry rule)", () => {
    expect(evaluateContractDay("PE", m(base), FIB_DEFAULTS, 24 * 60, { dte: 0 }).entry).not.toBeNull();
    const r = evaluateContractDay("PE", m(base), { ...FIB_FIRST_MINUTE_FILTERED, minTargetPct: 0 }, 24 * 60, { dte: 0 });
    expect(r.status).toBe("NO_ENTRY");
    expect(r.skipReason).toBe("EXPIRY_DAY");
  });
});

describe("contract, ATM, lot size, charges", () => {
  it("ATM = nearest strike step to the spot close", () => {
    expect(atmStrike(25_302, 50)).toBe(25_300);
    expect(atmStrike(25_274.9, 50)).toBe(25_250);
  });
  it("lot size follows the contract expiry", () => {
    expect(niftyLotSize("2026-11-17")).toBe(65);
    expect(niftyLotSize("2025-12-30")).toBe(75);
  });
  it("contract symbol", () => {
    expect(contractSymbol("NIFTY", "2026-11-17", 25300, "CE")).toBe("NIFTY 17-NOV-2026 25300 CE");
  });
  it("statutory charges", () => {
    const c = tradeCharges(100, 110, 65, "2026-11-12", FIB_DEFAULTS.charges);
    expect(c.brokerage).toBe(40);
    expect(Math.abs(c.stt - 110 * 65 * 0.0015)).toBeLessThanOrEqual(0.0051);
    expect(Math.abs(tradeCharges(100, 110, 65, "2026-03-31", FIB_DEFAULTS.charges).stt - 110 * 65 * 0.001)).toBeLessThanOrEqual(0.0051);
    // older rates (APEX audit): STT 0.05% before Apr-2023, 0.0625% to Sep-2024; NSE 0.053% / 0.05% / 0.0495%
    expect(Math.abs(tradeCharges(100, 110, 50, "2022-06-01", FIB_DEFAULTS.charges).stt - 110 * 50 * 0.0005)).toBeLessThanOrEqual(0.0051);
    expect(Math.abs(tradeCharges(100, 110, 50, "2022-06-01", FIB_DEFAULTS.charges).exchange - 210 * 50 * 0.00053)).toBeLessThanOrEqual(0.0051);
    expect(Math.abs(tradeCharges(100, 110, 25, "2024-06-03", FIB_DEFAULTS.charges).stt - 110 * 25 * 0.000625)).toBeLessThanOrEqual(0.0051);
    expect(Math.abs(tradeCharges(100, 110, 25, "2024-06-03", FIB_DEFAULTS.charges).exchange - 210 * 25 * 0.000495)).toBeLessThanOrEqual(0.0051);
  });
});
