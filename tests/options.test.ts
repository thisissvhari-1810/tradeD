import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LIVE_BROKER_ORDER_URL,
  backtestOptions,
  decideOptionOrder,
  dropFormingBar,
  evaluateRisk,
  evaluateSignal,
  longOptionMaxLoss,
  modelChain,
  sampleBreakoutBars,
  slippedPaise,
  type OptionContract,
  type Signal,
} from "@/lib/options/engine";

const day = "2026-10-07";

function bullishInput() {
  const candles5 = sampleBreakoutBars();
  const spot = candles5[candles5.length - 1].close;
  return {
    candles5,
    candles15: candles5,
    chain: modelChain(spot, day, 75),
    spot,
    timestamp: "2026-10-07T09:40:00.000Z",
    dataTimestamp: "2026-10-07T09:40:00.000Z",
    quality: "modelled" as const,
    nowDay: day,
  };
}

describe("NIFTY options paper engine", () => {
  it("buys a call only when the closed bar breaks higher with trend and volume", () => {
    const signal = evaluateSignal(bullishInput());
    expect(signal.direction).toBe("CE");
    expect(signal.contract?.side).toBe("CE");
    expect(signal.entry).toBe(signal.contract?.ask);
    expect(signal.rejections).toEqual([]);
    expect(signal.ruleScore).toBeGreaterThan(0);
  });

  it("buys a put when the same pattern is reversed", () => {
    const rising = sampleBreakoutBars();
    const peak = Math.max(...rising.map((bar) => bar.high));
    const candles5 = rising.map((bar) => ({
      ...bar,
      open: peak - (bar.open - 24_400),
      high: peak - (bar.low - 24_400),
      low: peak - (bar.high - 24_400),
      close: peak - (bar.close - 24_400),
    }));
    const spot = candles5[candles5.length - 1].close;
    const signal = evaluateSignal({ ...bullishInput(), candles5, candles15: candles5, chain: modelChain(spot, day, 75), spot });
    expect(signal.direction).toBe("PE");
    expect(signal.entry).toBe(signal.contract?.ask);
  });

  it("returns no trade when volume does not confirm the break", () => {
    const candles5 = sampleBreakoutBars().map((bar, index, rows) => (index === rows.length - 1 ? { ...bar, volume: 100 } : bar));
    const signal = evaluateSignal({ ...bullishInput(), candles5, candles15: candles5 });
    expect(signal.direction).toBe("NO TRADE");
    expect(signal.rejections.length).toBeGreaterThan(0);
  });

  it("does not let a still-forming candle create the signal", () => {
    const candles = sampleBreakoutBars();
    const closed = dropFormingBar(candles, candles[candles.length - 1].time + 10, 300);
    expect(closed).toHaveLength(candles.length - 1);
    const withFuture = [...closed, { ...candles[candles.length - 1], close: candles[candles.length - 1].close + 500, volume: 50_000 }];
    const spot = closed[closed.length - 1].close;
    const earlier = evaluateSignal({ ...bullishInput(), candles5: closed, candles15: closed, chain: modelChain(spot, day, 75), spot });
    const leaked = evaluateSignal({ ...bullishInput(), candles5: closed, candles15: closed, chain: modelChain(spot, day, 75), spot });
    expect(earlier.direction).toBe(leaked.direction);
    expect(withFuture.length).toBeGreaterThan(closed.length);
  });

  it("blocks a fourth entry, a second position, a stale quote, and an oversized premium", () => {
    const base = { equityPaise: 500_000_000n, dayEntries: 0, openPositions: 0, dayRealizedPaise: 0n, stale: false, minutesIst: 10 * 60, premiumPaise: 10_000n, quantity: 75, chargesPaise: 2_000n, sameContractOpen: false };
    expect(evaluateRisk(base).ok).toBe(true);
    expect(evaluateRisk({ ...base, dayEntries: 3 }).ok).toBe(false);
    expect(evaluateRisk({ ...base, openPositions: 1 }).ok).toBe(false);
    expect(evaluateRisk({ ...base, stale: true }).ok).toBe(false);
    expect(evaluateRisk({ ...base, dayRealizedPaise: -6_000_000n }).ok).toBe(false);
    expect(evaluateRisk({ ...base, equityPaise: 100_000n, premiumPaise: 10_000n, quantity: 75 }).reasons.join(" ")).toMatch(/premium/i);
  });

  it("treats the whole premium as the maximum loss for a long option", () => {
    expect(longOptionMaxLoss(10_000n, 75, 2_000n)).toBe(752_000n);
    const stopDistance = 3_000n * 75n;
    expect(longOptionMaxLoss(10_000n, 75, 2_000n)).toBeGreaterThan(stopDistance);
  });

  it("fills a buy above the ask and refuses a missing ask", () => {
    const contract: OptionContract = { side: "CE", strike: 24500, expiry: "2026-10-14", lotSize: 75, ltp: 100, bid: 99, ask: 101, volume: 1000, oi: 1000, iv: 0.14 };
    const signal = { direction: "CE", contractKey: "NIFTY|2026-10-14|24500|CE", contract, quality: "modelled" } as Signal;
    const risk = evaluateRisk({ equityPaise: 500_000_000n, dayEntries: 0, openPositions: 0, dayRealizedPaise: 0n, stale: false, minutesIst: 600, premiumPaise: 10_100n, quantity: 75, chargesPaise: 2_000n, sameContractOpen: false });
    const filled = decideOptionOrder({ action: "BUY", signal, risk, contract, cashPaise: 500_000_000n, openContractKey: null, lots: 1, slippageBps: 100 });
    expect(filled.ok).toBe(true);
    if (filled.ok) expect(filled.fillPaise).toBeGreaterThan(10_100n);
    expect(filled.ok && filled.simulated).toBe(true);
    const noAsk = decideOptionOrder({ action: "BUY", signal, risk, contract: { ...contract, ask: null }, cashPaise: 500_000_000n, openContractKey: null, lots: 1, slippageBps: 10 });
    expect(noAsk.ok).toBe(false);
    const blocked = decideOptionOrder({ action: "BUY", signal, risk: { ...risk, ok: false, reasons: ["blocked"] }, contract, cashPaise: 500_000_000n, openContractKey: null, lots: 1, slippageBps: 10 });
    expect(blocked.ok).toBe(false);
  });

  it("keeps the later backtest window separate from the earlier bars", () => {
    const candles5 = sampleBreakoutBars(80);
    const report = backtestOptions({ candles5, candles15: candles5, lotSize: 75, equityRupees: 5_000_000 });
    expect(report.premiumSource).toBe("modelled");
    expect(report.test.window).toBe("test");
    expect(report.inSample.window).toBe("in-sample");
    expect(report.note).toMatch(/not historical NSE/);
  });

  it("has no live broker order endpoint", () => {
    expect(LIVE_BROKER_ORDER_URL).toBeNull();
    const market = readFileSync("src/server/options-market.ts", "utf8");
    const paper = readFileSync("src/server/options-paper.ts", "utf8");
    expect(market).not.toMatch(/\/orders/);
    expect(paper).not.toMatch(/placeOrder\(/);
    expect(paper).not.toMatch(/api\.dhan\.co/);
    expect(slippedPaise(100, 0, "BUY")).toBe(10_000n);
  });
});
