import { formatPnl } from "@/lib/money";
import { tradeStats } from "@/lib/trading/accounting";
import { replaySessionOf } from "@/lib/options/replay-premium";

/**
 * Replay-session P&L, derived from the practice ledger only.
 *
 * Accounting convention (same as `applyBuy` / `applySell` and `summarizeRoundTrip`):
 * - Buy charges are folded into average cost; sell charges reduce proceeds.
 * - Every fill's `realizedPaise` is therefore already NET of all charges on the quantity it closed.
 * - A closed trade's `netPaise` is the sum of its sell fills' `realizedPaise`; `grossPaise` and
 *   `chargesPaise` are reported alongside it and must never be subtracted again.
 * - Open unrealized P&L is (mark − average cost) × quantity, so entry charges are already inside it.
 * - Session net = realized + unrealized. Charges are shown for information and are already included.
 * - Win rate counts decisive trades only: break-even trades are completed but excluded from the
 *   denominator, matching `tradeStats` used by Portfolio.
 */

export type SessionFill = {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  chargesPaise: bigint;
  realizedPaise: bigint;
  executedAt: Date;
};

export type SessionTrade = {
  id: string;
  symbol: string;
  direction: string;
  quantity: number;
  lotSize: number | null;
  entryAt: Date;
  exitAt: Date;
  avgEntryPaise: bigint;
  avgExitPaise: bigint;
  grossPaise: bigint;
  chargesPaise: bigint;
  netPaise: bigint;
  returnBps: number;
  holdingSeconds: number;
};

export type SessionOpenPosition = {
  symbol: string;
  quantity: number;
  avgCostPaise: bigint;
  /** Null when the replay premium is unavailable at the replay time. */
  unrealizedPaise: bigint | null;
  /** The replay clock is earlier than this position's entry fill. */
  waiting: boolean;
};

export type TradeOutcome = "WIN" | "LOSS" | "BREAK_EVEN";

export type SessionTradeResult = SessionTrade & { outcome: TradeOutcome };

export type ReplaySessionSummary = {
  session: string;
  /** Net realized P&L of every session fill (completed trades plus partial exits). */
  realizedPaise: bigint;
  completedNetPaise: bigint;
  completedGrossPaise: bigint;
  /** Realized on partial exits of positions that are still open. */
  partialRealizedPaise: bigint;
  /** All charges on session fills. Already included in realized and unrealized. */
  chargesPaise: bigint;
  /** Null when an open position that has started cannot be priced. */
  unrealizedPaise: bigint | null;
  /** Realized + unrealized; null while unrealized is unknown. */
  netPaise: bigint | null;
  /** Entry cost (including entry charges) of completed trades and open positions. */
  investedPaise: bigint;
  returnBps: number | null;
  openCount: number;
  waitingCount: number;
  unpricedCount: number;
  trades: SessionTradeResult[];
  wins: number;
  losses: number;
  breakEven: number;
  winRateBps: number | null;
  best: SessionTradeResult | null;
  worst: SessionTradeResult | null;
  averageWinPaise: bigint | null;
  averageLossPaise: bigint | null;
};

export type RealizedScope =
  | { kind: "day"; dateKey: string; dayOf: (at: Date) => string }
  | { kind: "replay"; session: string };

/** Realized P&L of fills inside a scope: a real calendar day, or one replay session. */
export function realizedInScope(fills: Array<Pick<SessionFill, "realizedPaise" | "executedAt"> & { symbol?: string }>, scope: RealizedScope): bigint {
  return fills.reduce((sum, fill) => {
    const inside = scope.kind === "day" ? scope.dayOf(fill.executedAt) === scope.dateKey : fill.symbol != null && replaySessionOf(fill.symbol) === scope.session;
    return inside ? sum + fill.realizedPaise : sum;
  }, 0n);
}

export function tradeOutcome(netPaise: bigint): TradeOutcome {
  return netPaise > 0n ? "WIN" : netPaise < 0n ? "LOSS" : "BREAK_EVEN";
}

/** Per-unit price move in the position's favour, and its percentage of the entry price. */
export function priceMove(direction: "LONG" | "SHORT", entryPaise: bigint, markPaise: bigint): { paise: bigint; bps: number | null } {
  const paise = direction === "LONG" ? markPaise - entryPaise : entryPaise - markPaise;
  return { paise, bps: entryPaise > 0n ? Number((paise * 10_000n) / entryPaise) : null };
}

/** P&L as basis points of the cost basis. Null when there is no cost to compare against. */
export function returnOnCostBps(pnlPaise: bigint, costPaise: bigint): number | null {
  if (costPaise <= 0n) return null;
  return Number((pnlPaise * 10_000n) / costPaise);
}

export function summarizeReplaySession(input: { session: string; fills: SessionFill[]; trades: SessionTrade[]; open: SessionOpenPosition[] }): ReplaySessionSummary {
  const { session } = input;
  const inSession = (symbol: string) => replaySessionOf(symbol) === session;
  const fills = input.fills.filter((fill) => inSession(fill.symbol));
  const realizedPaise = realizedInScope(fills, { kind: "replay", session });
  const chargesPaise = fills.reduce((sum, fill) => sum + fill.chargesPaise, 0n);

  const trades: SessionTradeResult[] = input.trades
    .filter((trade) => inSession(trade.symbol))
    .sort((a, b) => a.exitAt.getTime() - b.exitAt.getTime())
    .map((trade) => ({ ...trade, outcome: tradeOutcome(trade.netPaise) }));
  const completedNetPaise = trades.reduce((sum, trade) => sum + trade.netPaise, 0n);
  const completedGrossPaise = trades.reduce((sum, trade) => sum + trade.grossPaise, 0n);

  const open = input.open.filter((row) => inSession(row.symbol) && row.quantity > 0);
  const started = open.filter((row) => !row.waiting);
  const unpriced = started.filter((row) => row.unrealizedPaise == null);
  const unrealizedPaise = unpriced.length ? null : started.reduce((sum, row) => sum + (row.unrealizedPaise ?? 0n), 0n);
  const netPaise = unrealizedPaise == null ? null : realizedPaise + unrealizedPaise;

  const investedPaise = trades.reduce((sum, trade) => sum + trade.avgEntryPaise * BigInt(trade.quantity), 0n)
    + started.reduce((sum, row) => sum + row.avgCostPaise * BigInt(row.quantity), 0n);

  const stats = tradeStats(trades.map((trade) => ({ realizedPaise: trade.netPaise })));
  const decisive = stats.wins + stats.losses;
  const best = trades.reduce<SessionTradeResult | null>((top, trade) => (!top || trade.netPaise > top.netPaise ? trade : top), null);
  const worst = trades.reduce<SessionTradeResult | null>((low, trade) => (!low || trade.netPaise < low.netPaise ? trade : low), null);

  return {
    session,
    realizedPaise,
    completedNetPaise,
    completedGrossPaise,
    partialRealizedPaise: realizedPaise - completedNetPaise,
    chargesPaise,
    unrealizedPaise,
    netPaise,
    investedPaise,
    returnBps: netPaise == null ? null : returnOnCostBps(netPaise, investedPaise),
    openCount: started.length,
    waitingCount: open.length - started.length,
    unpricedCount: unpriced.length,
    trades,
    wins: stats.wins,
    losses: stats.losses,
    breakEven: trades.length - decisive,
    winRateBps: decisive === 0 ? null : stats.winRateBps,
    best,
    worst,
    averageWinPaise: stats.wins ? stats.averageWin : null,
    averageLossPaise: stats.losses ? -stats.averageLoss : null,
  };
}

/** JSON-safe form: paise as decimal strings, dates as ISO strings. */
export type ReplaySummaryWire = ReturnType<typeof toSummaryWire>;

function tradeToWire(trade: SessionTradeResult) {
  return {
    ...trade,
    entryAt: trade.entryAt.toISOString(),
    exitAt: trade.exitAt.toISOString(),
    avgEntryPaise: trade.avgEntryPaise.toString(),
    avgExitPaise: trade.avgExitPaise.toString(),
    grossPaise: trade.grossPaise.toString(),
    chargesPaise: trade.chargesPaise.toString(),
    netPaise: trade.netPaise.toString(),
  };
}

export function toSummaryWire(summary: ReplaySessionSummary) {
  const text = (value: bigint | null) => (value == null ? null : value.toString());
  return {
    ...summary,
    realizedPaise: summary.realizedPaise.toString(),
    completedNetPaise: summary.completedNetPaise.toString(),
    completedGrossPaise: summary.completedGrossPaise.toString(),
    partialRealizedPaise: summary.partialRealizedPaise.toString(),
    chargesPaise: summary.chargesPaise.toString(),
    unrealizedPaise: text(summary.unrealizedPaise),
    netPaise: text(summary.netPaise),
    investedPaise: summary.investedPaise.toString(),
    trades: summary.trades.map(tradeToWire),
    best: summary.best ? tradeToWire(summary.best) : null,
    worst: summary.worst ? tradeToWire(summary.worst) : null,
    averageWinPaise: text(summary.averageWinPaise),
    averageLossPaise: text(summary.averageLossPaise),
  };
}

function tradeFromWire(trade: ReturnType<typeof tradeToWire>): SessionTradeResult {
  return {
    ...trade,
    entryAt: new Date(trade.entryAt),
    exitAt: new Date(trade.exitAt),
    avgEntryPaise: BigInt(trade.avgEntryPaise),
    avgExitPaise: BigInt(trade.avgExitPaise),
    grossPaise: BigInt(trade.grossPaise),
    chargesPaise: BigInt(trade.chargesPaise),
    netPaise: BigInt(trade.netPaise),
  };
}

export function fromSummaryWire(wire: ReplaySummaryWire): ReplaySessionSummary {
  const big = (value: string | null) => (value == null ? null : BigInt(value));
  return {
    ...wire,
    realizedPaise: BigInt(wire.realizedPaise),
    completedNetPaise: BigInt(wire.completedNetPaise),
    completedGrossPaise: BigInt(wire.completedGrossPaise),
    partialRealizedPaise: BigInt(wire.partialRealizedPaise),
    chargesPaise: BigInt(wire.chargesPaise),
    unrealizedPaise: big(wire.unrealizedPaise),
    netPaise: big(wire.netPaise),
    investedPaise: BigInt(wire.investedPaise),
    trades: wire.trades.map(tradeFromWire),
    best: wire.best ? tradeFromWire(wire.best) : null,
    worst: wire.worst ? tradeFromWire(wire.worst) : null,
    averageWinPaise: big(wire.averageWinPaise),
    averageLossPaise: big(wire.averageLossPaise),
  };
}

/**
 * The "Realized" metric card. In replay it is the session's realized P&L (same number as the hero);
 * outside replay it keeps the ledger's real-calendar-day value.
 */
export function realizedMetric(input: { replay: true; summary: ReplaySessionSummary | null } | { replay: false; today: string }): { label: string; value: string; paise: bigint | null } {
  if (!input.replay) return { label: "Realized today", value: input.today, paise: null };
  if (!input.summary) return { label: "Realized this session", value: "No trades yet", paise: null };
  return { label: "Realized this session", value: formatPnl(input.summary.realizedPaise), paise: input.summary.realizedPaise };
}

/** Trades that appear in `next` but not in `seen`; used to announce an exit exactly once. */
export function newlyClosed(seen: ReadonlySet<string>, next: ReplaySessionSummary): SessionTradeResult[] {
  return next.trades.filter((trade) => !seen.has(trade.id));
}
