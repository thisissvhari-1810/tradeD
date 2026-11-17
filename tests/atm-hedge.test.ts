import { describe, expect, it } from "vitest";
import {
  atmStrike, evaluateHedgeDay, HEDGE_DEFAULTS, hedgeLotSize, hedgeMonitor, hhmm, legLots, pendingExitOrders, reconcileEntry, targetPremium,
  type HedgeDayInput, type HedgeSettings, type MinuteBar,
} from "@/lib/algo/atm-hedge";

const NO_SLIP: HedgeSettings = { ...HEDGE_DEFAULTS, slippageTicks: 0 };

/** Flat 1-minute tape from 09:15 to 15:29 at `price`, with optional overrides per clock. */
function tape(price: number, overrides: Record<string, Partial<MinuteBar>> = {}): MinuteBar[] {
  const bars: MinuteBar[] = [];
  for (let t = hhmm("09:15"); t <= hhmm("15:29"); t += 1) bars.push({ t, open: price, high: price, low: price, close: price, volume: 100 });
  return bars.map((bar) => {
    const key = Object.keys(overrides).find((k) => hhmm(k) === bar.t);
    return key ? { ...bar, ...overrides[key] } : bar;
  });
}
const day = (ce: MinuteBar[], pe: MinuteBar[], extra: Partial<HedgeDayInput> = {}): HedgeDayInput => ({
  date: "2026-11-16", expiry: "2026-11-17", firstClose: 24_510, strike: 24_500, lotSize: 65, ce, pe, ...extra,
});

describe("strike, target and sizing", () => {
  it("ATM = first-candle close rounded to 50", () => {
    expect(atmStrike(24_510, 50)).toBe(24_500);
    expect(atmStrike(24_525, 50)).toBe(24_550);
  });
  it("target premium — points and percent (spec examples)", () => {
    expect(targetPremium(280, { targetMode: "POINTS", targetValue: 4 })).toBe(284);
    expect(targetPremium(280, { targetMode: "PERCENT", targetValue: 1.43 })).toBeCloseTo(284.004, 3);
  });
  it("lot sizes by expiry", () => {
    expect(hedgeLotSize("2024-04-25")).toBe(50);
    expect(hedgeLotSize("2024-12-19")).toBe(25);
    expect(hedgeLotSize("2024-12-26")).toBe(25);
    expect(hedgeLotSize("2025-01-02")).toBe(75);
    expect(hedgeLotSize("2026-01-06")).toBe(65);
  });
  it("a leg never exceeds its allocation including charges", () => {
    const lots = legLots(50_000, 140, 65, "2026-11-16", HEDGE_DEFAULTS.charges);
    expect(lots).toBe(5); // 5 × 65 × 140 = 45,500
    expect(legLots(9_100, 140, 65, "2026-11-16", HEDGE_DEFAULTS.charges)).toBe(0); // exactly one lot of premium, no room for charges
  });
});

describe("evaluateHedgeDay", () => {
  it("spec example: 140 + 140 = 280 entry, both at 142 → 284 → target, exit both", () => {
    const ce = tape(140, { "10:00": { close: 142 }, "10:01": { open: 142, close: 142 } });
    const pe = tape(140, { "10:00": { close: 142 }, "10:01": { open: 142, close: 142 } });
    const r = evaluateHedgeDay(day(ce, pe), NO_SLIP);
    expect(r.status).toBe("CLOSED");
    expect(r.entryTime).toBe(hhmm("09:16"));
    expect(r.combinedEntry).toBe(280);
    expect(r.targetPremium).toBe(284);
    expect(r.exitReason).toBe("TARGET");
    expect(r.exitTime).toBe(hhmm("10:01")); // the 10:00 candle's close is known at 10:01
    expect(r.points).toBe(4);
    expect(r.ce!.quantity).toBe(325);
    expect(r.gross).toBe(r2(2 * 325 * 2));
  });
  it("the target is on the COMBINED premium, not a leg: CE +10 / PE −8 = +2 does not hit a +4 target", () => {
    const ce = tape(140, { "11:00": { close: 150 } });
    const pe = tape(140, { "11:00": { close: 132 } });
    const r = evaluateHedgeDay(day(ce, pe), NO_SLIP);
    expect(r.exitReason).toBe("SQUARE_OFF");
    expect(r.maxPoints).toBe(2);
  });
  it("never adds CE high + PE high: a target touched only inside a minute is not taken", () => {
    const ce = tape(140, { "11:00": { high: 146 } });
    const pe = tape(140, { "11:00": { high: 146 } });
    expect(evaluateHedgeDay(day(ce, pe), NO_SLIP).exitReason).toBe("SQUARE_OFF");
  });
  it("square-off at the 15:29 open when the target is never reached", () => {
    const ce = tape(140, { "15:29": { open: 120 } });
    const pe = tape(140, { "15:29": { open: 150 } });
    const r = evaluateHedgeDay(day(ce, pe), NO_SLIP);
    expect(r.exitReason).toBe("SQUARE_OFF");
    expect(r.exitTime).toBe(hhmm("15:29"));
    expect(r.points).toBe(-10);
  });
  it("slippage: buys fill above the open, sells below the trigger (2 ticks each)", () => {
    const ce = tape(140, { "10:00": { close: 145 } });
    const pe = tape(140, { "10:00": { close: 145 } });
    const r = evaluateHedgeDay(day(ce, pe), HEDGE_DEFAULTS);
    expect(r.ce!.entryPrice).toBe(140.1);
    expect(r.combinedEntry).toBe(280.2);
    expect(r.combinedTrigger).toBe(290);
    expect(r.combinedExit).toBe(289.8);
    expect(r.points).toBe(9.6);
    expect(r.net).toBeLessThan(r.gross!);
  });
  it("no entry before the first candle completes; paper mode reports progress", () => {
    const ce = tape(140), pe = tape(140);
    expect(evaluateHedgeDay(day(ce, pe), NO_SLIP, hhmm("09:15")).status).toBe("WAITING");
    const open = evaluateHedgeDay(day(ce, pe), NO_SLIP, hhmm("10:30"));
    expect(open.status).toBe("OPEN");
    expect(open.combinedEntry).toBe(280);
  });
  it("paper mode never uses a candle before it is complete", () => {
    const ce = tape(140, { "10:00": { close: 150 } });
    const pe = tape(140);
    expect(evaluateHedgeDay(day(ce, pe), NO_SLIP, hhmm("10:00")).status).toBe("OPEN"); // close known only at 10:01
    expect(evaluateHedgeDay(day(ce, pe), NO_SLIP, hhmm("10:01")).exitReason).toBe("TARGET");
  });
  it("a missing leg at the entry minute waits for the first minute both trade; none by 09:20 → not executed", () => {
    const pe = tape(140);
    const late = tape(140).filter((bar) => bar.t >= hhmm("09:18"));
    expect(evaluateHedgeDay(day(late, pe), NO_SLIP).entryTime).toBe(hhmm("09:18"));
    const none = tape(140).filter((bar) => bar.t >= hhmm("09:21"));
    expect(evaluateHedgeDay(day(none, pe), NO_SLIP).status).toBe("NOT_EXECUTED");
  });
  it("percent mode", () => {
    const short = tape(140, { "12:00": { close: 142.1 } });
    const pe = tape(140, { "12:00": { close: 142 } });
    const settings = { ...NO_SLIP, targetMode: "PERCENT" as const, targetValue: 1.5 };
    const miss = evaluateHedgeDay(day(short, pe), settings);
    expect(miss.targetPremium).toBe(284.2);
    expect(miss.exitReason).toBe("SQUARE_OFF"); // 284.1 < 284.2
    const hit = evaluateHedgeDay(day(tape(140, { "12:00": { close: 142.2 } }), pe), settings);
    expect(hit.exitReason).toBe("TARGET");
  });
  it("unequal quantities: rupee P&L is quantity-weighted, points are not", () => {
    const ce = tape(100, { "10:00": { close: 106 } });
    const pe = tape(200, { "10:00": { close: 198 } });
    const r = evaluateHedgeDay(day(ce, pe), NO_SLIP);
    expect(r.ce!.lots).toBe(7);
    expect(r.pe!.lots).toBe(3);
    expect(r.points).toBe(4);
    expect(r.gross).toBe(r2(6 * 455 - 2 * 195));
  });
});

describe("order safety", () => {
  const leg = (right: "CE" | "PE", status: "PENDING" | "FILLED" | "PARTIAL" | "REJECTED" | "CANCELLED", filledQty: number, avgPrice = 140) => ({ right, requestedQty: 325, filledQty, avgPrice, status });
  it("waits while a leg is working; both filled → active with combined entry", () => {
    expect(reconcileEntry(leg("CE", "FILLED", 325), leg("PE", "PENDING", 0)).action).toBe("WAIT");
    const ok = reconcileEntry(leg("CE", "FILLED", 325, 141), leg("PE", "FILLED", 325, 139.5));
    expect(ok.action).toBe("ACTIVE");
    expect(ok.combinedEntry).toBe(280.5);
  });
  it("one leg rejected → unwind the other; no single-leg position", () => {
    const r = reconcileEntry(leg("CE", "FILLED", 325), leg("PE", "REJECTED", 0));
    expect(r.action).toBe("UNWIND");
    expect(r.unwind).toEqual([{ right: "CE", qty: 325 }]);
  });
  it("partial fill after timeout keeps the filled quantities and cancels the rest", () => {
    const r = reconcileEntry(leg("CE", "FILLED", 325), leg("PE", "PARTIAL", 130), true);
    expect(r.action).toBe("ACTIVE");
    expect(r.cancel).toEqual(["PE"]);
  });
  it("no duplicate exits while sells are working", () => {
    expect(pendingExitOrders({ CE: 325, PE: 325 }, { CE: 0, PE: 0 })).toHaveLength(2);
    expect(pendingExitOrders({ CE: 325, PE: 325 }, { CE: 325, PE: 0 })).toEqual([{ right: "PE", side: "SELL", qty: 325 }]);
    expect(pendingExitOrders({ CE: 0, PE: 0 }, { CE: 0, PE: 0 })).toHaveLength(0);
  });
});

describe("dashboard monitor", () => {
  it("spec dashboard example", () => {
    const m = hedgeMonitor({ ceEntry: 140, peEntry: 140, ceNow: 142, peNow: 142, ceQty: 325, peQty: 325, targetMode: "POINTS", targetValue: 4, date: "2026-11-16" });
    expect(m.combinedEntry).toBe(280);
    expect(m.combinedNow).toBe(284);
    expect(m.profitPoints).toBe(4);
    expect(m.targetPremium).toBe(284);
    expect(m.remainingPoints).toBe(0);
    expect(m.progressPct).toBe(100);
    expect(m.status).toBe("TARGET REACHED – EXIT BOTH LEGS");
  });
});

function r2(v: number) { return Math.round(v * 100) / 100; }
