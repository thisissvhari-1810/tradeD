export type FillLeg = {
  id: string;
  side: "BUY" | "SELL";
  quantity: number;
  pricePaise: bigint;
  chargesPaise: bigint;
  notionalPaise: bigint;
  realizedPaise: bigint;
  executedAt: Date;
  orderId: string;
};

export type RoundTrip = {
  quantity: number;
  avgEntryPaise: bigint;
  avgExitPaise: bigint;
  grossPaise: bigint;
  chargesPaise: bigint;
  netPaise: bigint;
  returnBps: number;
  entryAt: Date;
  exitAt: Date;
  holdingSeconds: number;
  orderIds: string[];
  exitExecutionId: string;
};

export function roundTripSegment(fills: FillLeg[]): FillLeg[] {
  let quantity = 0;
  let start = 0;
  for (let index = 0; index < fills.length; index += 1) {
    const fill = fills[index];
    quantity += fill.side === "BUY" ? fill.quantity : -fill.quantity;
    if (quantity < 0) return [];
    if (quantity === 0 && index < fills.length - 1) start = index + 1;
  }
  if (quantity !== 0) return [];
  return fills.slice(start);
}

export function summarizeRoundTrip(fills: FillLeg[]): RoundTrip | null {
  const segment = roundTripSegment(fills);
  const buys = segment.filter((fill) => fill.side === "BUY");
  const sells = segment.filter((fill) => fill.side === "SELL");
  if (!buys.length || !sells.length) return null;
  const quantity = buys.reduce((sum, fill) => sum + fill.quantity, 0);
  const sold = sells.reduce((sum, fill) => sum + fill.quantity, 0);
  if (quantity !== sold || quantity <= 0) return null;
  const buyNotional = buys.reduce((sum, fill) => sum + fill.notionalPaise, 0n);
  const sellNotional = sells.reduce((sum, fill) => sum + fill.notionalPaise, 0n);
  const chargesPaise = segment.reduce((sum, fill) => sum + fill.chargesPaise, 0n);
  const grossPaise = sellNotional - buyNotional;
  const netPaise = sells.reduce((sum, fill) => sum + fill.realizedPaise, 0n);
  const cost = buyNotional + buys.reduce((sum, fill) => sum + fill.chargesPaise, 0n);
  const avgEntryPaise = (cost + BigInt(quantity) / 2n) / BigInt(quantity);
  const avgExitPaise = (sellNotional + BigInt(quantity) / 2n) / BigInt(quantity);
  const entryAt = buys.reduce((min, fill) => (fill.executedAt < min ? fill.executedAt : min), buys[0].executedAt);
  const exitAt = sells.reduce((max, fill) => (fill.executedAt > max ? fill.executedAt : max), sells[0].executedAt);
  const returnBps = cost === 0n ? 0 : Number((netPaise * 10_000n) / cost);
  return {
    quantity,
    avgEntryPaise,
    avgExitPaise,
    grossPaise,
    chargesPaise,
    netPaise,
    returnBps,
    entryAt,
    exitAt,
    holdingSeconds: Math.max(0, Math.floor((exitAt.getTime() - entryAt.getTime()) / 1000)),
    orderIds: [...new Set(segment.map((fill) => fill.orderId))],
    exitExecutionId: sells[sells.length - 1].id,
  };
}
