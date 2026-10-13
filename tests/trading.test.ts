import { describe, expect, it } from "vitest";
import { applyAdverseSlippage, formatInr, paiseToRupees, rupeesToPaise } from "@/lib/money";
import { applyBuy, applySell, foldLedger, maxDrawdownBps, performancePnl, portfolioEquity, tradeStats } from "@/lib/trading/accounting";
import { decideOrder, quoteIsStale, shouldTriggerResting, type QuoteView } from "@/lib/trading/decide";
import { calculateCharges } from "@/lib/trading/fees";
import { DEFAULT_CHARGES, DEFAULT_RISK } from "@/lib/trading/settings";
import { can, canReadStudent } from "@/lib/auth/permissions";
import { demoQuote } from "@/lib/market/demo";
import { bollinger, ema, sma, vwap } from "@/lib/market/indicators";
import { fibLevels } from "@/components/drawing-model";
import { summarizeRoundTrip, type FillLeg } from "@/lib/trading/closed-trade";
import { compositeScore } from "@/lib/trading/ranking";

const quote = (overrides: Partial<QuoteView> = {}): QuoteView => ({
  mode: "DEMO",
  lastPaise: 10000n,
  bidPaise: 9990n,
  askPaise: 10010n,
  asOf: new Date(),
  marketOpen: true,
  ...overrides,
});

const baseIntent = {
  side: "BUY" as const,
  type: "MARKET" as const,
  quantity: 10,
  lotSize: 1,
  tickPaise: 5,
  positionQuantity: 0,
  openSellQuantity: 0,
  positionMarkPaise: 10000n,
  equityPaise: 1_000_000n,
};

describe("money", () => {
  it("converts rupees without binary drift", () => {
    expect(rupeesToPaise("100000.00")).toBe(10_000_000n);
    expect(paiseToRupees(10_000_000n)).toBe("100000.00");
    expect(formatInr(10_000_000n)).toBe("₹1,00,000.00");
  });
});

describe("fees and accounting", () => {
  it("charges a buy and keeps the average cost inclusive of those charges", () => {
    const notional = 10000n * 10n;
    const charges = calculateCharges("BUY", notional, DEFAULT_CHARGES);
    expect(charges.total).toBeGreaterThan(0n);
    expect(charges.stt).toBe(0n);
    const position = applyBuy({ quantity: 0, avgCostPaise: 0n, realizedPaise: 0n }, 10, 10000n, charges.total);
    expect(position.quantity).toBe(10);
    expect(position.avgCostPaise).toBeGreaterThan(10000n);
  });

  it("realizes profit after sell charges and does not mix it into unrealized equity twice", () => {
    const opened = applyBuy({ quantity: 0, avgCostPaise: 0n, realizedPaise: 0n }, 10, 10000n, 100n);
    const sold = applySell(opened, 10, 11000n, 50n);
    expect(sold.quantity).toBe(0);
    expect(sold.realizedOnTrade).toBe(11000n * 10n - 50n - opened.avgCostPaise * 10n);
    const equity = portfolioEquity(50000n, 20000n, 0n);
    expect(equity).toBe(70000n);
  });

  it("rejects an oversell in the accounting function", () => {
    expect(() => applySell({ quantity: 2, avgCostPaise: 100n, realizedPaise: 0n }, 3, 100n, 0n)).toThrow(/more than/);
  });

  it("folds reserves without double counting", () => {
    const folded = foldLedger(100000n, 0n, [{ cashDelta: -40000n, reservedDelta: 40000n }]);
    expect(folded.cashAvailable).toBe(60000n);
    expect(folded.cashReserved).toBe(40000n);
    expect(portfolioEquity(folded.cashAvailable, folded.cashReserved, 0n)).toBe(100000n);
  });

  it("removes admin cash from performance", () => {
    expect(performancePnl(110000n, 100000n, 10000n)).toBe(0n);
    expect(performancePnl(90000n, 100000n, -10000n)).toBe(0n);
  });

  it("computes drawdown and trade stats", () => {
    expect(maxDrawdownBps([{ equity: 100n }, { equity: 80n }, { equity: 90n }])).toBe(2000);
    const stats = tradeStats([{ realizedPaise: 100n }, { realizedPaise: -50n }]);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.profitFactor).toBe("2.00");
  });
});

describe("order decisions", () => {
  it("rejects a market order when the quote is unavailable", () => {
    const decision = decideOrder(baseIntent, quote({ mode: "UNAVAILABLE", lastPaise: null, asOf: null }), 1_000_000n, new Date(), DEFAULT_CHARGES, DEFAULT_RISK, true);
    expect(decision.ok).toBe(false);
  });

  it("rejects a stale realtime market order", () => {
    const old = new Date(Date.now() - 60_000);
    expect(quoteIsStale(quote({ mode: "REALTIME", asOf: old }), new Date(), DEFAULT_RISK)).toBe(true);
    const decision = decideOrder(baseIntent, quote({ mode: "REALTIME", asOf: old }), 1_000_000n, new Date(), DEFAULT_CHARGES, DEFAULT_RISK, true);
    expect(decision.ok).toBe(false);
  });

  it("rejects an unaffordable buy and an oversell", () => {
    const poor = decideOrder(baseIntent, quote(), 100n, new Date(), DEFAULT_CHARGES, DEFAULT_RISK, true);
    expect(poor.ok).toBe(false);
    const oversell = decideOrder({ ...baseIntent, side: "SELL", positionQuantity: 1 }, quote(), 1_000_000n, new Date(), DEFAULT_CHARGES, DEFAULT_RISK, true);
    expect(oversell.ok).toBe(false);
  });

  it("reserves cash for a resting limit buy", () => {
    const decision = decideOrder({ ...baseIntent, type: "LIMIT", limitPaise: 9000n }, quote(), 1_000_000n, new Date(), DEFAULT_CHARGES, DEFAULT_RISK, true);
    expect(decision.ok && decision.action).toBe("REST");
    if (decision.ok && decision.action === "REST") expect(decision.reserve).toBeGreaterThan(9000n * 10n);
  });

  it("applies adverse slippage", () => {
    expect(applyAdverseSlippage(10000n, "BUY", 5, 5n)).toBeGreaterThanOrEqual(10000n);
    expect(applyAdverseSlippage(10000n, "SELL", 5, 5n)).toBeLessThanOrEqual(10000n);
  });

  it("triggers stops only on the defined cross", () => {
    expect(shouldTriggerResting({ side: "SELL", type: "STOP", limitPaise: null, stopPaise: 9500n, triggered: false, lastPaise: 9400n })).toBe("FILL");
    expect(shouldTriggerResting({ side: "BUY", type: "LIMIT", limitPaise: 9900n, stopPaise: null, triggered: false, lastPaise: 10000n })).toBe("WAIT");
  });

  it("processes two buys sequentially so the second cannot spend the same cash", () => {
    let cash = 15000n;
    const first = decideOrder({ ...baseIntent, quantity: 1 }, quote({ lastPaise: 10000n, askPaise: 10000n }), cash, new Date(), { ...DEFAULT_CHARGES, slippageBps: 0 }, DEFAULT_RISK, true);
    expect(first.ok && first.action).toBe("FILL");
    if (first.ok && first.action === "FILL") cash -= first.fillPrice + first.charges;
    const second = decideOrder({ ...baseIntent, quantity: 1 }, quote({ lastPaise: 10000n, askPaise: 10000n }), cash, new Date(), { ...DEFAULT_CHARGES, slippageBps: 0 }, DEFAULT_RISK, true);
    expect(second.ok).toBe(false);
  });
});

describe("permissions and competitions", () => {
  it("stops students from reading another student or adjusting funds", () => {
    expect(can("STUDENT", "funds.adjust")).toBe(false);
    expect(can("SUPER_ADMIN", "funds.adjust")).toBe(true);
    expect(canReadStudent({ id: "a", role: "STUDENT" }, "b")).toBe(false);
    expect(canReadStudent({ id: "a", role: "STUDENT" }, "a")).toBe(true);
    expect(canReadStudent({ id: "teacher", role: "INSTRUCTOR" }, "b", ["b"])).toBe(true);
  });

  it("does not treat an admin credit as competition profit", () => {
    const score = compositeScore({
      equityNow: 110000n,
      equityAtJoin: 100000n,
      adminNow: 10000n,
      adminAtJoin: 0n,
      drawdownBps: 0,
      learningBps: 0,
      returnWeight: 100,
      drawdownWeight: 0,
      learningWeight: 0,
    });
    expect(score.returnBps).toBe(0);
  });
});

describe("indicators", () => {
  it("computes SMA, EMA, Bollinger bands, and cumulative VWAP from the supplied bars", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(sma(values, 3)[2]).toBe(2);
    expect(ema(values, 3)[2]).toBe(2);
    expect(ema(values, 3)[9]).toBeGreaterThan(8);
    const bands = bollinger(values, 3, 2);
    expect(bands.middle[2]).toBe(2);
    expect(bands.upper[2]).toBeGreaterThan(bands.middle[2] ?? 0);
    expect(bands.lower[2]).toBeLessThan(bands.middle[2] ?? 0);
    const series = vwap([{ high: 3, low: 1, close: 2, volume: 10 }, { high: 4, low: 2, close: 3, volume: 0 }]);
    expect(series[0]).toBe(2);
    expect(series[1]).toBeNull();
  });

  it("places Fibonacci levels between the two selected prices", () => {
    const levels = fibLevels(100, 200);
    expect(levels.find((level) => level.ratio === 0)?.price).toBe(100);
    expect(levels.find((level) => level.ratio === 0.5)?.price).toBe(150);
    expect(levels.find((level) => level.ratio === 1)?.price).toBe(200);
    expect(levels.find((level) => level.ratio === 0.618)?.price).toBeCloseTo(161.8);
  });
});

describe("closed trades", () => {
  const leg = (side: "BUY" | "SELL", price: bigint, realized: bigint, id: string): FillLeg => ({
    id, side, quantity: 10, pricePaise: price, chargesPaise: 0n, notionalPaise: price * 10n, realizedPaise: realized, executedAt: new Date("2026-10-10T04:00:00.000Z"), orderId: id,
  });

  it("keeps a profitable round trip and a losing round trip", () => {
    const profit = summarizeRoundTrip([leg("BUY", 100_000n, 0n, "b1"), leg("SELL", 110_000n, 100_000n, "s1")]);
    expect(profit?.netPaise).toBe(100_000n);
    expect(profit?.quantity).toBe(10);
    expect(profit?.exitExecutionId).toBe("s1");
    const loss = summarizeRoundTrip([leg("BUY", 100_000n, 0n, "b2"), leg("SELL", 90_000n, -100_000n, "s2")]);
    expect(loss?.netPaise).toBe(-100_000n);
    expect(loss?.grossPaise).toBe(-100_000n);
  });
});

describe("demo market data", () => {
  it("labels synthetic prices as demo and stays deterministic", () => {
    const now = new Date("2026-10-09T04:30:00.000Z");
    const instrument = { symbol: "RELIANCE", name: "Reliance Industries", exchange: "NSE", sector: "Energy", basePaise: 245000, tickPaise: 5 };
    const left = demoQuote(instrument, now);
    const right = demoQuote(instrument, now);
    expect(left.mode).toBe("DEMO");
    expect(left.message.toLowerCase()).toContain("demo");
    expect(left.lastPaise).toBe(right.lastPaise);
    expect(left.source).toBe("tradelab-demo");
  });
});
