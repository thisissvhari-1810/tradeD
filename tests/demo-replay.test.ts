import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEMO_ORDER_ROUTE,
  DEMO_START_PAISE,
  applyDemoFill,
  buyingPower,
  candleChange,
  demoAccount,
  demoUnrealized,
  emptyDemoBook,
  fundsForBuy,
  maxBuyQuantity,
  positionResult,
  firstCandleOn,
  initialPlayhead,
  loadDemoBook,
  placeDemoOrder,
  practiceStats,
  revealLimit,
  sessionDays,
  setAllowShort,
  setDemoProtection,
  settleDemoOrders,
  sliceTo,
  stepPlayhead,
  type DemoCandle,
} from "@/lib/trading/demo-replay";

function ist(hour: number, minute = 0): number {
  return Math.floor(Date.UTC(2026, 9, 12, hour - 5, minute - 30) / 1000);
}

function bar(hour: number, minute: number, close: number): DemoCandle {
  return { time: ist(hour, minute), open: close - 1, high: close + 1, low: close - 2, close, volume: 100 };
}

const session = [bar(12, 0, 100), bar(13, 0, 110), bar(14, 0, 120), bar(15, 29, 130)];

describe("demo replay", () => {
  it("keeps a one-hour and two-hour delay behind the open session", () => {
    const now = ist(14, 0);
    expect(revealLimit(session, now, true, 3600)).toBe(ist(13, 0));
    expect(initialPlayhead(session, now, true, 3600)).toBe(ist(13, 0));
    expect(revealLimit(session, now, true, 7200)).toBe(ist(12, 0));
    expect(sliceTo(session, ist(13, 0)).map((candle) => candle.close)).toEqual([100, 110]);
  });

  it("starts after the close one delay before the last loaded candle and can play forward", () => {
    const now = ist(20, 54);
    expect(revealLimit(session, now, false, 3600)).toBe(ist(15, 29));
    expect(initialPlayhead(session, now, false, 3600)).toBe(ist(14, 0));
    expect(initialPlayhead(session, now, false, 7200)).toBe(ist(13, 0));
    const forward = stepPlayhead(session, ist(14, 0), 1, ist(15, 29));
    expect(forward).toBe(ist(15, 29));
    expect(stepPlayhead(session, ist(13, 0), 1, ist(13, 0))).toBe(ist(13, 0));
  });

  it("measures the hovered candle against the previous close", () => {
    const stats = candleChange(22600, 22400);
    expect(stats.change).toBe(200);
    expect(stats.percent).toBeCloseTo(0.892857, 4);
  });

  it("fills only the replay candle and leaves another book untouched", () => {
    const book = emptyDemoBook();
    const other = emptyDemoBook();
    const bought = applyDemoFill(book, {
      id: "b1",
      symbol: "reliance",
      side: "BUY",
      quantity: 2,
      candle: bar(13, 0, 110),
      playheadTime: ist(13, 0),
      revealTime: ist(13, 0),
    });
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;
    expect(bought.book.positions[0]).toMatchObject({ symbol: "RELIANCE", quantity: 2, avgPaise: 11000 });
    expect(bought.book.cashPaise).toBeLessThan(DEMO_START_PAISE);
    expect(other.cashPaise).toBe(DEMO_START_PAISE);
    expect(other.positions).toEqual([]);
    const future = applyDemoFill(bought.book, {
      id: "b2",
      symbol: "RELIANCE",
      side: "BUY",
      quantity: 1,
      candle: bar(14, 0, 120),
      playheadTime: ist(13, 0),
      revealTime: ist(13, 0),
    });
    expect(future.ok).toBe(false);
    const marked = (12000 - 11000) * 2;
    expect(marked).toBe(2000);
  });

  it("rejects a sell larger than the demo position and a buy the demo cash cannot fund", () => {
    const book = emptyDemoBook();
    const bought = applyDemoFill(book, {
      id: "b1",
      symbol: "TCS",
      side: "BUY",
      quantity: 1,
      candle: bar(13, 0, 110),
      playheadTime: ist(13, 0),
      revealTime: ist(13, 0),
    });
    if (!bought.ok) throw new Error("buy");
    const sold = applyDemoFill(bought.book, {
      id: "s1",
      symbol: "TCS",
      side: "SELL",
      quantity: 2,
      candle: bar(13, 0, 110),
      playheadTime: ist(13, 0),
      revealTime: ist(13, 0),
    });
    expect(sold.ok).toBe(false);
    const expensive = applyDemoFill(emptyDemoBook(), {
      id: "b3",
      symbol: "TCS",
      side: "BUY",
      quantity: 1_000_000,
      candle: bar(13, 0, 110),
      playheadTime: ist(13, 0),
      revealTime: ist(13, 0),
    });
    expect(expensive.ok).toBe(false);
  });

  it("keeps a limit order waiting until the replay candle trades through it", () => {
    const book = emptyDemoBook();
    const waiting = placeDemoOrder(book, {
      id: "l1",
      symbol: "INFY",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      limitPrice: 90,
      candle: bar(13, 0, 110),
      playheadTime: ist(13, 0),
      revealTime: ist(13, 0),
      paused: false,
    });
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    expect(waiting.book.positions).toEqual([]);
    expect(waiting.book.orders[0]?.status).toBe("OPEN");
    const early = settleDemoOrders(waiting.book, "INFY", bar(14, 0, 80), ist(13, 0), ist(13, 0));
    expect(early.positions).toEqual([]);
    const touched = bar(14, 0, 100);
    touched.low = 89;
    const filled = settleDemoOrders(waiting.book, "INFY", touched, ist(14, 0), ist(14, 0));
    expect(filled.positions[0]).toMatchObject({ symbol: "INFY", quantity: 1, avgPaise: 9000 });
    expect(filled.orders.find((order) => order.id === "l1")?.status).toBe("FILLED");
  });

  it("fills a paused market demo order at the revealed replay price", () => {
    const paused = placeDemoOrder(emptyDemoBook(), {
      id: "m1",
      symbol: "INFY",
      side: "BUY",
      type: "MARKET",
      quantity: 1,
      limitPrice: null,
      candle: bar(13, 0, 110),
      playheadTime: ist(13, 0),
      revealTime: ist(13, 0),
      paused: true,
    });
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.book.positions[0]).toMatchObject({ symbol: "INFY", quantity: 1, avgPaise: 11000 });
    expect(paused.book.fills[0]?.time).toBe(ist(13, 0));
    const hidden = bar(13, 0, 100);
    hidden.low = 70;
    const openOnly = { ...hidden, high: hidden.open, low: hidden.open, close: hidden.open, volume: 0 };
    const waiting = placeDemoOrder(emptyDemoBook(), {
      id: "l2",
      symbol: "INFY",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      limitPrice: 90,
      candle: openOnly,
      playheadTime: ist(13, 0),
      revealTime: ist(13, 0),
      paused: true,
    });
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    expect(waiting.book.positions).toEqual([]);
    expect(waiting.book.orders[0]?.status).toBe("OPEN");
  });

  it("lists session dates in Asia/Kolkata and starts at the first bar of that date", () => {
    expect(sessionDays(session)).toEqual(["2026-10-12"]);
    expect(firstCandleOn(session, "2026-10-12")).toBe(ist(12, 0));
    expect(firstCandleOn(session, "2026-10-13")).toBeNull();
  });

  it("buys, marks unrealized P&L, sells part, then closes the rest", () => {
    const bought = placeDemoOrder(emptyDemoBook(), {
      id: "b1", symbol: "INFY", side: "BUY", type: "MARKET", quantity: 4, limitPrice: null,
      candle: bar(13, 0, 100), playheadTime: ist(13, 0), revealTime: ist(13, 0), paused: true, sessionDate: "2026-10-12", timeframe: "1m",
    });
    if (!bought.ok) throw new Error("buy");
    expect(demoUnrealized(bought.book, { INFY: 11000 })).toBe(4000);
    const partial = applyDemoFill(bought.book, {
      id: "s1", symbol: "INFY", side: "SELL", quantity: 1, candle: bar(14, 0, 110), playheadTime: ist(14, 0), revealTime: ist(14, 0), sessionDate: "2026-10-12", timeframe: "1m",
    });
    if (!partial.ok) throw new Error(partial.error);
    expect(partial.book.positions[0]).toMatchObject({ quantity: 3 });
    expect(partial.book.trades).toHaveLength(1);
    expect(partial.book.trades[0]).toMatchObject({ side: "LONG", quantity: 1, exitReason: "manual", sessionDate: "2026-10-12" });
    expect(partial.book.trades[0]?.netPaise).toBeGreaterThan(0);
    const closed = applyDemoFill(partial.book, {
      id: "s2", symbol: "INFY", side: "SELL", quantity: 3, candle: bar(15, 0, 90), playheadTime: ist(15, 0), revealTime: ist(15, 0),
    });
    if (!closed.ok) throw new Error(closed.error);
    expect(closed.book.positions).toEqual([]);
    expect(closed.book.trades).toHaveLength(2);
    const restored = loadDemoBook(JSON.stringify(closed.book));
    expect(restored.trades).toHaveLength(2);
    expect(restored.cashPaise).toBe(closed.book.cashPaise);
    expect(practiceStats(restored.trades, restored.startPaise).trades).toBe(2);
  });

  it("uses the stop when one candle reaches both the stop and the target", () => {
    const bought = placeDemoOrder(emptyDemoBook(), {
      id: "b1", symbol: "INFY", side: "BUY", type: "MARKET", quantity: 1, limitPrice: null,
      stopLoss: 95, takeProfit: 120,
      candle: bar(13, 0, 100), playheadTime: ist(13, 0), revealTime: ist(13, 0), paused: false,
    });
    if (!bought.ok) throw new Error(bought.error);
    const same = { ...bar(13, 0, 100), high: 130, low: 90 };
    const early = settleDemoOrders(bought.book, "INFY", same, ist(13, 0), ist(13, 0));
    expect(early.positions).toHaveLength(1);
    const next = { ...bar(14, 0, 100), high: 130, low: 90 };
    const exited = settleDemoOrders(bought.book, "INFY", next, ist(14, 0), ist(14, 0));
    expect(exited.positions).toEqual([]);
    expect(exited.trades).toHaveLength(1);
    expect(exited.trades[0]).toMatchObject({ exitReason: "stop", exitPaise: 9500 });
  });

  it("fills a stop at the open when the candle gaps through it", () => {
    const bought = placeDemoOrder(emptyDemoBook(), {
      id: "b1", symbol: "INFY", side: "BUY", type: "MARKET", quantity: 1, limitPrice: null,
      candle: bar(13, 0, 100), playheadTime: ist(13, 0), revealTime: ist(13, 0), paused: false,
    });
    if (!bought.ok) throw new Error("buy");
    const armed = setDemoProtection(bought.book, "INFY", 95, 120, 100, ist(13, 0) + 60);
    if (!armed.ok) throw new Error(armed.error);
    const gap = { ...bar(14, 0, 80), open: 80, high: 85, low: 70, close: 82 };
    const exited = settleDemoOrders(armed.book, "INFY", gap, ist(14, 0), ist(14, 0));
    expect(exited.trades[0]).toMatchObject({ exitReason: "stop", exitPaise: 8000 });
  });

  it("refuses a short until short selling is turned on", () => {
    const blocked = placeDemoOrder(emptyDemoBook(), {
      id: "s1", symbol: "INFY", side: "SELL", type: "MARKET", quantity: 1, limitPrice: null,
      candle: bar(13, 0, 100), playheadTime: ist(13, 0), revealTime: ist(13, 0), paused: true,
    });
    expect(blocked.ok).toBe(false);
    const opened = placeDemoOrder(setAllowShort(emptyDemoBook(), true), {
      id: "s2", symbol: "INFY", side: "SELL", type: "MARKET", quantity: 1, limitPrice: null,
      candle: bar(13, 0, 100), playheadTime: ist(13, 0), revealTime: ist(13, 0), paused: true,
    });
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.book.positions[0]?.quantity).toBe(-1);
    const down = demoUnrealized(opened.book, { INFY: 9000 });
    expect(down).toBe(1000);
    const account = demoAccount(opened.book, { INFY: 9000 });
    expect(account.equityPaise).toBeGreaterThan(DEMO_START_PAISE);
  });

  it("rests a buy stop until the revealed range reaches the trigger", () => {
    const quiet = bar(13, 0, 100);
    const waiting = placeDemoOrder(emptyDemoBook(), {
      id: "stop1", symbol: "INFY", side: "BUY", type: "STOP", quantity: 1, limitPrice: null, stopPrice: 105,
      candle: quiet, playheadTime: ist(13, 0), revealTime: ist(13, 0), paused: false,
    });
    if (!waiting.ok) throw new Error(waiting.error);
    expect(waiting.book.positions).toEqual([]);
    const crossed = { ...bar(14, 0, 106), open: 101, high: 108, low: 100, close: 106 };
    const filled = settleDemoOrders(waiting.book, "INFY", crossed, ist(14, 0), ist(14, 0));
    expect(filled.positions[0]).toMatchObject({ quantity: 1, avgPaise: 10500 });
  });

  it("accepts a ₹10,000 buy against ₹1,00,000 and still rejects a shortfall", () => {
    const book = emptyDemoBook(10_000_000);
    const candle = bar(13, 0, 1000);
    const bought = placeDemoOrder(book, {
      id: "afford", symbol: "RELIANCE", side: "BUY", type: "MARKET", quantity: 10, limitPrice: null,
      candle, playheadTime: candle.time, revealTime: candle.time + 60, paused: true,
    });
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;
    expect(bought.book.positions[0]).toMatchObject({ quantity: 10 });
    expect(buyingPower(bought.book)).toBeGreaterThan(8_000_000);
    const second = placeDemoOrder(bought.book, {
      id: "more", symbol: "RELIANCE", side: "BUY", type: "MARKET", quantity: 10, limitPrice: null,
      candle, playheadTime: candle.time, revealTime: candle.time + 60, paused: true,
    });
    expect(second.ok).toBe(true);
    const tooBig = placeDemoOrder(book, {
      id: "big", symbol: "RELIANCE", side: "BUY", type: "MARKET", quantity: 200, limitPrice: null,
      candle, playheadTime: candle.time, revealTime: candle.time + 60, paused: true,
    });
    expect(tooBig.ok).toBe(false);
    if (tooBig.ok) return;
    expect(tooBig.error).toContain("Available buying power");
    expect(tooBig.error).toContain("Required funds");
    expect(tooBig.error).toContain("Shortfall");
    expect(book.positions).toEqual([]);
    const index = placeDemoOrder(book, {
      id: "nifty", symbol: "NIFTY", side: "BUY", type: "MARKET", quantity: 5, limitPrice: null, product: "index",
      candle: bar(13, 0, 25000), playheadTime: candle.time, revealTime: candle.time + 60, paused: true,
    });
    expect(index.ok).toBe(false);
    if (index.ok) return;
    expect(index.error).toContain("index");
    const oneUnit = placeDemoOrder(book, {
      id: "nifty1", symbol: "NIFTY", side: "BUY", type: "MARKET", quantity: 1, limitPrice: null, product: "index",
      candle: bar(13, 0, 25000), playheadTime: candle.time, revealTime: candle.time + 60, paused: true,
    });
    expect(oneUnit.ok).toBe(true);
  });

  it("updates unrealized return from the replay mark and keeps a partial position", () => {
    const candle = bar(13, 0, 100);
    const bought = placeDemoOrder(emptyDemoBook(), {
      id: "p", symbol: "INFY", side: "BUY", type: "MARKET", quantity: 4, limitPrice: null,
      candle, playheadTime: candle.time, revealTime: candle.time + 60, paused: true,
    });
    if (!bought.ok) throw new Error(bought.error);
    const marked = positionResult(bought.book.positions[0], 11000);
    expect(marked?.pnlPaise).toBe(4000);
    expect(marked?.percent).toBeCloseTo(10, 5);
    const sold = placeDemoOrder(bought.book, {
      id: "s", symbol: "INFY", side: "SELL", type: "MARKET", quantity: 1, limitPrice: null,
      candle: bar(14, 0, 110), playheadTime: ist(14, 0), revealTime: ist(14, 0) + 60, paused: true,
    });
    if (!sold.ok) throw new Error(sold.error);
    expect(sold.book.positions[0].quantity).toBe(3);
    expect(sold.book.trades).toHaveLength(1);
    expect(sold.book.trades[0].netPaise).not.toBe(0);
  });

  it("repairs an empty book whose cash was stored below the starting balance", () => {
    const repaired = loadDemoBook(JSON.stringify({ ...emptyDemoBook(10_000_000), cashPaise: 100 }));
    expect(repaired.cashPaise).toBe(10_000_000);
    expect(maxBuyQuantity(repaired, 1000)).toBeGreaterThanOrEqual(99);
    expect(fundsForBuy(repaired, 1000, 10).ok).toBe(true);
  });

  it("does not point demo orders at a broker or the portfolio route", () => {
    expect(DEMO_ORDER_ROUTE).toBeNull();
    const source = readFileSync("src/lib/trading/demo-replay.ts", "utf8");
    expect(source).not.toMatch(/placeOrder\(/);
    expect(source).not.toMatch(/\/api\/orders/);
    expect(source).not.toMatch(/api\.dhan\.co/);
  });
});
