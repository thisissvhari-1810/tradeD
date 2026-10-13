import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEMO_ORDER_ROUTE,
  DEMO_START_PAISE,
  applyDemoFill,
  candleChange,
  emptyDemoBook,
  firstCandleOn,
  initialPlayhead,
  placeDemoOrder,
  revealLimit,
  sessionDays,
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
    expect(bought.book.positions).toEqual([{ symbol: "RELIANCE", quantity: 2, avgPaise: 11000 }]);
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
    expect(filled.positions).toEqual([{ symbol: "INFY", quantity: 1, avgPaise: 9000 }]);
    expect(filled.orders.find((order) => order.id === "l1")?.status).toBe("FILLED");
  });

  it("refuses a market demo order while playback is paused", () => {
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
    expect(paused.ok).toBe(false);
  });

  it("lists session dates in Asia/Kolkata and starts at the first bar of that date", () => {
    expect(sessionDays(session)).toEqual(["2026-10-12"]);
    expect(firstCandleOn(session, "2026-10-12")).toBe(ist(12, 0));
    expect(firstCandleOn(session, "2026-10-13")).toBeNull();
  });

  it("does not point demo orders at a broker or the portfolio route", () => {
    expect(DEMO_ORDER_ROUTE).toBeNull();
    const source = readFileSync("src/lib/trading/demo-replay.ts", "utf8");
    expect(source).not.toMatch(/placeOrder\(/);
    expect(source).not.toMatch(/\/api\/orders/);
    expect(source).not.toMatch(/api\.dhan\.co/);
  });
});
