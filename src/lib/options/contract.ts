export function optionLedgerSymbol(underlying: string, expiry: string, strike: number, right: "CE" | "PE") {
  return `${underlying.trim().toUpperCase()}|${expiry}|${strike}|${right}`;
}

export function parseOptionLedgerSymbol(symbol: string): { underlying: string; expiry: string; strike: number; right: "CE" | "PE" } | null {
  const [underlying, expiry, strikeText, right] = symbol.split("|");
  const strike = Number(strikeText);
  if (!underlying || !/^\d{4}-\d{2}-\d{2}$/.test(expiry ?? "") || !Number.isFinite(strike) || (right !== "CE" && right !== "PE")) return null;
  return { underlying, expiry, strike, right };
}

export function premiumValuePaise(premiumPaise: bigint, lots: number, lotSize: number) {
  if (!Number.isInteger(lots) || lots <= 0 || !Number.isInteger(lotSize) || lotSize <= 0) return null;
  return premiumPaise * BigInt(lots) * BigInt(lotSize);
}
