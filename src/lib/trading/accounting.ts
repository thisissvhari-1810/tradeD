/** Average-cost accounting. Buy-side charges are included in cost basis. Sell-side charges reduce realized proceeds. */

export type PositionState = {
  quantity: number;
  avgCostPaise: bigint;
  realizedPaise: bigint;
};

export function applyBuy(position: PositionState, fillQty: number, fillPricePaise: bigint, chargesPaise: bigint): PositionState {
  if (fillQty <= 0) throw new Error("Fill quantity must be positive.");
  if (fillPricePaise <= 0n) throw new Error("Fill price must be positive.");
  const newQty = position.quantity + fillQty;
  const cost = position.avgCostPaise * BigInt(position.quantity) + fillPricePaise * BigInt(fillQty) + chargesPaise;
  const avg = (cost + BigInt(newQty) / 2n) / BigInt(newQty);
  return { quantity: newQty, avgCostPaise: avg, realizedPaise: position.realizedPaise };
}

export function applySell(position: PositionState, fillQty: number, fillPricePaise: bigint, chargesPaise: bigint): PositionState & { realizedOnTrade: bigint } {
  if (fillQty <= 0) throw new Error("Fill quantity must be positive.");
  if (fillQty > position.quantity) throw new Error("Cannot sell more than the open quantity.");
  const proceeds = fillPricePaise * BigInt(fillQty) - chargesPaise;
  const cost = position.avgCostPaise * BigInt(fillQty);
  const realizedOnTrade = proceeds - cost;
  const quantity = position.quantity - fillQty;
  return {
    quantity,
    avgCostPaise: quantity === 0 ? 0n : position.avgCostPaise,
    realizedPaise: position.realizedPaise + realizedOnTrade,
    realizedOnTrade,
  };
}

export function holdingsValue(quantity: number, markPaise: bigint): bigint {
  return markPaise * BigInt(quantity);
}

export function unrealizedPnl(quantity: number, avgCostPaise: bigint, markPaise: bigint): bigint {
  return (markPaise - avgCostPaise) * BigInt(quantity);
}

export function portfolioEquity(cashAvailable: bigint, cashReserved: bigint, holdings: bigint): bigint {
  return cashAvailable + cashReserved + holdings;
}

export function performanceCapital(startingCapital: bigint, adminAdjustmentPaise: bigint): bigint {
  return startingCapital + adminAdjustmentPaise;
}

export function performancePnl(equity: bigint, startingCapital: bigint, adminAdjustmentPaise: bigint): bigint {
  return equity - performanceCapital(startingCapital, adminAdjustmentPaise);
}

export type EquityPoint = { equity: bigint };

export function maxDrawdownBps(points: EquityPoint[]): number {
  if (points.length === 0) return 0;
  let peak = points[0].equity;
  let maxBps = 0n;
  for (const point of points) {
    if (point.equity > peak) peak = point.equity;
    if (peak > 0n) {
      const dd = ((peak - point.equity) * 10_000n) / peak;
      if (dd > maxBps) maxBps = dd;
    }
  }
  return Number(maxBps);
}

export type ClosedTrade = { realizedPaise: bigint };

export function tradeStats(trades: ClosedTrade[]): {
  winRateBps: number;
  averageWin: bigint;
  averageLoss: bigint;
  profitFactor: string;
  wins: number;
  losses: number;
} {
  const wins = trades.filter((trade) => trade.realizedPaise > 0n);
  const losses = trades.filter((trade) => trade.realizedPaise < 0n);
  const grossWin = wins.reduce((sum, trade) => sum + trade.realizedPaise, 0n);
  const grossLoss = losses.reduce((sum, trade) => sum + -trade.realizedPaise, 0n);
  const averageWin = wins.length ? grossWin / BigInt(wins.length) : 0n;
  const averageLoss = losses.length ? grossLoss / BigInt(losses.length) : 0n;
  const decisive = wins.length + losses.length;
  const winRateBps = decisive === 0 ? 0 : Number((BigInt(wins.length) * 10_000n) / BigInt(decisive));
  let profitFactor = "—";
  if (grossLoss === 0n && grossWin > 0n) profitFactor = "∞";
  else if (grossLoss > 0n) {
    const scaled = (grossWin * 100n) / grossLoss;
    profitFactor = `${(Number(scaled) / 100).toFixed(2)}`;
  }
  return { winRateBps, averageWin, averageLoss, profitFactor, wins: wins.length, losses: losses.length };
}

export type LedgerMove = { cashDelta: bigint; reservedDelta: bigint };

export function foldLedger(openingAvailable: bigint, openingReserved: bigint, moves: LedgerMove[]): { cashAvailable: bigint; cashReserved: bigint } {
  return moves.reduce(
    (state, move) => ({
      cashAvailable: state.cashAvailable + move.cashDelta,
      cashReserved: state.cashReserved + move.reservedDelta,
    }),
    { cashAvailable: openingAvailable, cashReserved: openingReserved },
  );
}
