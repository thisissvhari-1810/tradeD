export function compositeScore(input: {
  equityNow: bigint;
  equityAtJoin: bigint;
  adminNow: bigint;
  adminAtJoin: bigint;
  drawdownBps: number;
  learningBps: number;
  returnWeight: number;
  drawdownWeight: number;
  learningWeight: number;
}): { returnBps: number; compositeBps: number } {
  const adjusted = input.equityNow - (input.adminNow - input.adminAtJoin);
  const pnl = adjusted - input.equityAtJoin;
  const returnBps = input.equityAtJoin === 0n ? 0 : Number((pnl * 10_000n) / input.equityAtJoin);
  const weighted = returnBps * input.returnWeight - input.drawdownBps * input.drawdownWeight + input.learningBps * input.learningWeight;
  return { returnBps, compositeBps: Math.round(weighted / 100) };
}
