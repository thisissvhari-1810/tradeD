import { describe, expect, it } from "vitest";
import { applyBuy, applySell, type PositionState } from "@/lib/trading/accounting";
import { summarizeRoundTrip, type FillLeg } from "@/lib/trading/closed-trade";
import { kolkataParts } from "@/lib/market/clock";
import { formatPnl, formatSignedBps } from "@/lib/money";
import { replayLedgerSymbol } from "@/lib/options/replay-premium";
import {
  fromSummaryWire,
  newlyClosed,
  priceMove,
  realizedInScope,
  realizedMetric,
  returnOnCostBps,
  summarizeReplaySession,
  toSummaryWire,
  tradeOutcome,
  type SessionFill,
  type SessionOpenPosition,
  type SessionTrade,
} from "@/lib/trading/replay-summary";

const SESSION = "2026-10-16.abcd1234";
const OTHER = "2026-10-15.zzzz9999";
const REPLAY_OPEN = Date.parse("2026-10-16T03:45:00Z"); // 09:15 IST

type Leg = [side: "BUY" | "SELL", quantity: number, priceRupees: number, chargesRupees: number, minute: number];

/** Runs legs through the real ledger accounting, returning fills, the closed round trip (if flat), and the position. */
function ledger(contract: string, session: string, legs: Leg[]) {
  const symbol = replayLedgerSymbol(contract, session);
  let state: PositionState = { quantity: 0, avgCostPaise: 0n, realizedPaise: 0n };
  const fills: SessionFill[] = [];
  const legsForTrip: FillLeg[] = [];
  legs.forEach(([side, quantity, price, charges, minute], index) => {
    const pricePaise = BigInt(Math.round(price * 100));
    const chargesPaise = BigInt(Math.round(charges * 100));
    let realized = 0n;
    if (side === "BUY") state = applyBuy(state, quantity, pricePaise, chargesPaise);
    else {
      const sold = applySell(state, quantity, pricePaise, chargesPaise);
      realized = sold.realizedOnTrade;
      state = sold;
    }
    const executedAt = new Date(REPLAY_OPEN + minute * 60_000);
    fills.push({ symbol, side, quantity, chargesPaise, realizedPaise: realized, executedAt });
    legsForTrip.push({ id: `${symbol}-${index}`, side, quantity, pricePaise, chargesPaise, notionalPaise: pricePaise * BigInt(quantity), realizedPaise: realized, executedAt, orderId: `${symbol}-o${index}` });
  });
  const trip = state.quantity === 0 ? summarizeRoundTrip(legsForTrip) : null;
  const trade: SessionTrade | null = trip ? {
    id: trip.exitExecutionId,
    symbol,
    direction: "LONG",
    quantity: trip.quantity,
    lotSize: 75,
    entryAt: trip.entryAt,
    exitAt: trip.exitAt,
    avgEntryPaise: trip.avgEntryPaise,
    avgExitPaise: trip.avgExitPaise,
    grossPaise: trip.grossPaise,
    chargesPaise: trip.chargesPaise,
    netPaise: trip.netPaise,
    returnBps: trip.returnBps,
    holdingSeconds: trip.holdingSeconds,
  } : null;
  return { symbol, fills, trade, state };
}

function fixture() {
  const win = ledger("NIFTY|2026-10-19|22950|CE", SESSION, [["BUY", 75, 100, 20, 5], ["SELL", 75, 110, 25, 30]]);
  const loss = ledger("NIFTY|2026-10-19|23000|PE", SESSION, [["BUY", 75, 200, 20, 40], ["SELL", 75, 190, 20, 70]]);
  const partial = ledger("BANKNIFTY|2026-10-19|51000|CE", SESSION, [["BUY", 150, 50, 10, 80], ["SELL", 75, 60, 10, 95]]);
  const elsewhere = ledger("NIFTY|2026-10-19|22950|CE", OTHER, [["BUY", 75, 100, 20, 5], ["SELL", 75, 150, 20, 10]]);
  const fills = [...win.fills, ...loss.fills, ...partial.fills, ...elsewhere.fills];
  const trades = [win.trade, loss.trade, elsewhere.trade].filter((trade): trade is SessionTrade => trade != null);
  const markPaise = 5_500n;
  const open: SessionOpenPosition[] = [
    { symbol: partial.symbol, quantity: partial.state.quantity, avgCostPaise: partial.state.avgCostPaise, unrealizedPaise: (markPaise - partial.state.avgCostPaise) * BigInt(partial.state.quantity), waiting: false },
  ];
  return { win, loss, partial, elsewhere, fills, trades, open };
}

describe("replay session summary", () => {
  it("summarises net, charges, counts, win rate and extremes from the ledger", () => {
    const { win, loss, partial, fills, trades, open } = fixture();
    const summary = summarizeReplaySession({ session: SESSION, fills, trades, open });
    const winNet = win.trade?.netPaise ?? 0n;
    const lossNet = loss.trade?.netPaise ?? 0n;
    expect(winNet).toBeGreaterThan(0n);
    expect(lossNet).toBeLessThan(0n);
    expect(summary.trades.map((trade) => trade.outcome)).toEqual(["WIN", "LOSS"]);
    expect(summary.completedNetPaise).toBe(winNet + lossNet);
    expect(summary.partialRealizedPaise).toBe(partial.state.realizedPaise);
    expect(summary.chargesPaise).toBe(BigInt((20 + 25 + 20 + 20 + 10 + 10) * 100));
    expect(summary.unrealizedPaise).toBe(open[0].unrealizedPaise);
    expect(summary.netPaise).toBe(summary.realizedPaise + (open[0].unrealizedPaise ?? 0n));
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.winRateBps).toBe(5_000);
    expect(summary.best?.netPaise).toBe(winNet);
    expect(summary.worst?.netPaise).toBe(lossNet);
    expect(summary.averageWinPaise).toBe(winNet);
    expect(summary.averageLossPaise).toBe(lossNet);
    expect(summary.openCount).toBe(1);
  });

  it("does not subtract charges twice: closed-trade net equals gross minus charges", () => {
    // Entry cost divides evenly by quantity, so average-cost rounding (a few paise at most) does not apply.
    const win = ledger("NIFTY|2026-10-19|22950|CE", SESSION, [["BUY", 75, 100, 15, 5], ["SELL", 75, 110, 25, 30]]);
    const trade = win.trade;
    expect(trade).not.toBeNull();
    if (!trade) return;
    expect(trade.grossPaise).toBe(75n * 1_000n);
    expect(trade.chargesPaise).toBe(4_000n);
    expect(trade.netPaise).toBe(trade.grossPaise - trade.chargesPaise);
    const summary = summarizeReplaySession({ session: SESSION, fills: win.fills, trades: [trade], open: [] });
    expect(summary.realizedPaise).toBe(trade.netPaise);
    expect(summary.netPaise).toBe(trade.netPaise);
  });

  it("handles an empty session without inventing numbers", () => {
    const summary = summarizeReplaySession({ session: SESSION, fills: [], trades: [], open: [] });
    expect(summary.realizedPaise).toBe(0n);
    expect(summary.netPaise).toBe(0n);
    expect(summary.trades).toHaveLength(0);
    expect(summary.winRateBps).toBeNull();
    expect(summary.returnBps).toBeNull();
    expect(summary.best).toBeNull();
    expect(summary.averageWinPaise).toBeNull();
    expect(summary.averageLossPaise).toBeNull();
  });

  it("counts break-even trades as completed but outside the win rate", () => {
    const flat = ledger("NIFTY|2026-10-19|22800|CE", SESSION, [["BUY", 75, 100, 0, 1], ["SELL", 75, 100, 0, 2]]);
    const win = ledger("NIFTY|2026-10-19|22900|CE", SESSION, [["BUY", 75, 100, 0, 3], ["SELL", 75, 101, 0, 4]]);
    const trades = [flat.trade, win.trade].filter((trade): trade is SessionTrade => trade != null);
    const summary = summarizeReplaySession({ session: SESSION, fills: [...flat.fills, ...win.fills], trades, open: [] });
    expect(summary.trades.map((trade) => trade.outcome)).toEqual(["BREAK_EVEN", "WIN"]);
    expect(summary.breakEven).toBe(1);
    expect(summary.winRateBps).toBe(10_000);
    expect(tradeOutcome(0n)).toBe("BREAK_EVEN");
  });

  it("never counts open or waiting positions as completed, and reports unknown marks as unknown", () => {
    const { partial } = fixture();
    const waiting: SessionOpenPosition = { symbol: partial.symbol, quantity: 75, avgCostPaise: 5_000n, unrealizedPaise: null, waiting: true };
    const summary = summarizeReplaySession({ session: SESSION, fills: partial.fills, trades: [], open: [waiting] });
    expect(summary.trades).toHaveLength(0);
    expect(summary.wins + summary.losses + summary.breakEven).toBe(0);
    expect(summary.waitingCount).toBe(1);
    expect(summary.unrealizedPaise).toBe(0n);

    const unpriced: SessionOpenPosition = { ...waiting, waiting: false };
    const missing = summarizeReplaySession({ session: SESSION, fills: partial.fills, trades: [], open: [unpriced] });
    expect(missing.unrealizedPaise).toBeNull();
    expect(missing.netPaise).toBeNull();
    expect(missing.returnBps).toBeNull();
    expect(missing.unpricedCount).toBe(1);
  });

  it("round-trips through the JSON wire format", () => {
    const { fills, trades, open } = fixture();
    const summary = summarizeReplaySession({ session: SESSION, fills, trades, open });
    const wire = JSON.parse(JSON.stringify(toSummaryWire(summary))) as ReturnType<typeof toSummaryWire>;
    expect(fromSummaryWire(wire)).toEqual(summary);
  });

  it("announces each closed trade once", () => {
    const { fills, trades, open } = fixture();
    const summary = summarizeReplaySession({ session: SESSION, fills, trades, open });
    const seen = new Set<string>();
    const first = newlyClosed(seen, summary);
    expect(first).toHaveLength(2);
    first.forEach((trade) => seen.add(trade.id));
    expect(newlyClosed(seen, summary)).toHaveLength(0);
  });
});

describe("realized P&L consistency (regression: replay profit showed ₹0.00 as Realized today)", () => {
  it("session realized = sum of closed trades + partial exits = Realized metric in replay", () => {
    const { fills, trades, open, partial } = fixture();
    const summary = summarizeReplaySession({ session: SESSION, fills, trades, open });
    const sessionTrades = trades.filter((trade) => trade.symbol.endsWith(SESSION));
    const closedSum = sessionTrades.reduce((sum, trade) => sum + trade.netPaise, 0n);
    const fillSum = fills.filter((fill) => fill.symbol.endsWith(SESSION)).reduce((sum, fill) => sum + fill.realizedPaise, 0n);

    expect(summary.realizedPaise).toBe(fillSum);
    expect(summary.realizedPaise).toBe(closedSum + partial.state.realizedPaise);
    const metric = realizedMetric({ replay: true, summary });
    expect(metric.paise).toBe(summary.realizedPaise);
    expect(metric.value).toBe(formatPnl(summary.realizedPaise));
  });

  it("with no partial exits, the hero, the closed trades and the metric are the same number", () => {
    const { win, loss } = fixture();
    const trades = [win.trade, loss.trade].filter((trade): trade is SessionTrade => trade != null);
    const summary = summarizeReplaySession({ session: SESSION, fills: [...win.fills, ...loss.fills], trades, open: [] });
    const closedSum = trades.reduce((sum, trade) => sum + trade.netPaise, 0n);
    expect(summary.realizedPaise).toBe(closedSum);
    expect(summary.netPaise).toBe(closedSum);
    expect(realizedMetric({ replay: true, summary }).paise).toBe(closedSum);
  });

  it("reproduces the old bug: a real-day filter drops replay fills stamped with the simulated date", () => {
    const { fills } = fixture();
    const dayOf = (at: Date) => kolkataParts(at).dateKey;
    const realToday = realizedInScope(fills, { kind: "day", dateKey: "2026-10-18", dayOf });
    const session = realizedInScope(fills, { kind: "replay", session: SESSION });
    expect(realToday).toBe(0n);
    expect(session).not.toBe(0n);
    expect(realizedMetric({ replay: false, today: formatPnl(realToday) }).label).toBe("Realized today");
  });
});

describe("percentage conventions", () => {
  it("measures price move in the position's favour for long and short", () => {
    expect(priceMove("LONG", 10_000n, 11_000n)).toEqual({ paise: 1_000n, bps: 1_000 });
    expect(priceMove("SHORT", 10_000n, 11_000n)).toEqual({ paise: -1_000n, bps: -1_000 });
    expect(priceMove("SHORT", 10_000n, 9_000n)).toEqual({ paise: 1_000n, bps: 1_000 });
    expect(priceMove("LONG", 0n, 9_000n).bps).toBeNull();
  });

  it("uses cost basis as the P&L denominator and refuses a zero denominator", () => {
    expect(returnOnCostBps(74_877n, 634_465n)).toBe(1_180);
    expect(returnOnCostBps(-74_877n, 634_465n)).toBe(-1_180);
    expect(returnOnCostBps(100n, 0n)).toBeNull();
  });

  it("formats signed money and percentages with a true minus sign", () => {
    expect(formatPnl(108_718n)).toBe("+₹1,087.18");
    expect(formatPnl(-108_718n)).toBe("−₹1,087.18");
    expect(formatPnl(0n)).toBe("₹0.00");
    expect(formatPnl(13_690_040n)).toBe("+₹1,36,900.40");
    expect(formatSignedBps(1_180)).toBe("+11.80%");
    expect(formatSignedBps(-425)).toBe("−4.25%");
  });
});
