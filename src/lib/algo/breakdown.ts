import { parseOptionLedgerSymbol } from "@/lib/options/contract";

/**
 * Profit and loss of the Algo account split by CALL and PUT, from the ledger itself: closed trades (net of
 * charges) and the marked open positions. Replay trades count by their own fills, whatever the real day.
 */
export type SideFigures = { trades: number; wins: number; losses: number; realizedPaise: bigint; open: number; unrealizedPaise: bigint; openValuePaise: bigint };
export type CallPutBreakdown = { call: SideFigures; put: SideFigures };

const empty = (): SideFigures => ({ trades: 0, wins: 0, losses: 0, realizedPaise: 0n, open: 0, unrealizedPaise: 0n, openValuePaise: 0n });

export function callPutBreakdown(
  closed: Array<{ symbol: string; netPaise: bigint }>,
  open: Array<{ symbol: string; unrealizedPaise: bigint | null; valuePaise: bigint | null }>,
): CallPutBreakdown {
  const result: CallPutBreakdown = { call: empty(), put: empty() };
  const sideOf = (symbol: string) => {
    const right = parseOptionLedgerSymbol(symbol)?.right;
    return right === "CE" ? result.call : right === "PE" ? result.put : null;
  };
  for (const trade of closed) {
    const side = sideOf(trade.symbol);
    if (!side) continue;
    side.trades += 1;
    side.realizedPaise += trade.netPaise;
    if (trade.netPaise > 0n) side.wins += 1;
    else if (trade.netPaise < 0n) side.losses += 1;
  }
  for (const position of open) {
    const side = sideOf(position.symbol);
    if (!side) continue;
    side.open += 1;
    side.unrealizedPaise += position.unrealizedPaise ?? 0n;
    side.openValuePaise += position.valuePaise ?? 0n;
  }
  return result;
}
