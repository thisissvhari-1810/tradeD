/**
 * ATM option selection and the protective levels of a long option.
 *
 * ATM = the listed strike nearest the underlying's latest price (ties go to the lower strike), or the
 * nearest listed strike at or below / at or above it with the "down" / "up" rounding policies. Strikes
 * come from the instrument's real option chain, so the strike interval is the chain's own — never a
 * fixed distance. The contract's identifier, lot size and quote come from the chain as well.
 */

export type ChainQuote = { ltp: number | null; bid: number | null; ask: number | null; securityId: string | null };
export type ChainInput = {
  underlying: string;
  spot: number | null;
  expiry: string | null;
  /** When the chain snapshot was taken (ISO). */
  asOf: string;
  lotSize: number | null;
  strikes: Array<{ strike: number; ce: ChainQuote | null; pe: ChainQuote | null }>;
};

export type Right = "CE" | "PE";
export type AtmContract = { underlying: string; expiry: string; strike: number; right: Right; securityId: string; lotSize: number; bid: number; ask: number; ltp: number | null; spot: number; asOf: string };
export type AtmLimits = { rounding: "nearest" | "down" | "up"; maxQuoteAgeSeconds: number; maxSpreadPercent: number };

/** The chain's strike interval: the most common gap between neighbouring listed strikes. */
export function strikeInterval(strikes: number[]) {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = Math.round((sorted[index] - sorted[index - 1]) * 100) / 100;
    if (gap > 0) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [gap, count] of counts) if (best == null || count > (counts.get(best) ?? 0) || (count === counts.get(best) && gap < best)) best = gap;
  return best;
}

export function atmStrike(strikes: number[], spot: number, rounding: AtmLimits["rounding"]) {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (rounding === "down") return [...sorted].reverse().find((strike) => strike <= spot) ?? null;
  if (rounding === "up") return sorted.find((strike) => strike >= spot) ?? null;
  return sorted.reduce((best, strike) => (Math.abs(strike - spot) < Math.abs(best - spot) ? strike : best), sorted[0]);
}

/** Resolves and validates the ATM CALL or PUT; every rejection names its reason. */
export function resolveAtm(chain: ChainInput, right: Right, limits: AtmLimits, now: Date): { ok: true; contract: AtmContract } | { ok: false; reason: string } {
  if (chain.spot == null || !(chain.spot > 0)) return { ok: false, reason: "No valid underlying price." };
  if (!chain.expiry) return { ok: false, reason: "No valid option expiry." };
  if (!chain.lotSize || !Number.isInteger(chain.lotSize) || chain.lotSize <= 0) return { ok: false, reason: "The contract's lot size is unknown or invalid." };
  const age = (now.getTime() - new Date(chain.asOf).getTime()) / 1000;
  if (!Number.isFinite(age) || age > limits.maxQuoteAgeSeconds) return { ok: false, reason: `Stale option quote (${Math.round(age)} s old; limit ${limits.maxQuoteAgeSeconds} s).` };
  const strike = atmStrike(chain.strikes.map((row) => row.strike), chain.spot, limits.rounding);
  if (strike == null) return { ok: false, reason: "No listed strike for the ATM price." };
  const row = chain.strikes.find((item) => item.strike === strike);
  const side = right === "CE" ? row?.ce : row?.pe;
  if (!side || !side.securityId) return { ok: false, reason: `The ATM ${right} contract (${strike}) is not listed.` };
  if (side.bid == null || side.ask == null || !(side.bid > 0) || !(side.ask > 0) || side.ask < side.bid) return { ok: false, reason: `No valid bid and ask for the ATM ${right} (${strike}).` };
  const spread = ((side.ask - side.bid) / ((side.ask + side.bid) / 2)) * 100;
  if (spread > limits.maxSpreadPercent) return { ok: false, reason: `Bid/ask spread ${spread.toFixed(1)}% is wider than the ${limits.maxSpreadPercent}% limit.` };
  return { ok: true, contract: { underlying: chain.underlying, expiry: chain.expiry, strike, right, securityId: side.securityId, lotSize: chain.lotSize, bid: side.bid, ask: side.ask, ltp: side.ltp, spot: chain.spot, asOf: chain.asOf } };
}

/* ---------------- stop-loss and target ---------------- */

export type Protective = { mode: "percent" | "points"; value: number };

/**
 * Stop and target of a long option entered at premium P:
 *   percent: stop = P × (1 − v / 100), target = P × (1 + v / 100)
 *   points (absolute premium distance D): stop = P − D, target = P + D
 * Invalid settings (a non-positive distance, a stop at or below zero premium) are rejected.
 */
export function protectiveLevels(entry: number, stop: Protective, target: Protective): { ok: true; stop: number; target: number } | { ok: false; reason: string } {
  const problem = protectiveProblem(stop, target, entry);
  if (problem) return { ok: false, reason: problem };
  const stopPrice = stop.mode === "percent" ? entry * (1 - stop.value / 100) : entry - stop.value;
  const targetPrice = target.mode === "percent" ? entry * (1 + target.value / 100) : entry + target.value;
  return { ok: true, stop: Math.round(stopPrice * 100) / 100, target: Math.round(targetPrice * 100) / 100 };
}

/** Why a stop / target setting is invalid (for the settings form and the entry check), or null. */
export function protectiveProblem(stop: Protective, target: Protective, entry?: number) {
  if (!Number.isFinite(stop.value) || stop.value <= 0) return "The stop-loss distance must be positive.";
  if (!Number.isFinite(target.value) || target.value <= 0) return "The target distance must be positive.";
  if (stop.mode === "percent" && stop.value >= 100) return "A percentage stop-loss must be below 100%.";
  if (entry != null && stop.mode === "points" && stop.value >= entry) return `The stop-loss distance (₹${stop.value}) must be less than the entry premium (₹${entry}).`;
  return null;
}

export type ExitTrigger = { reason: "STOP" | "TARGET"; price: number; note: string };

/** Live / paper monitoring of the selected option's own premium (the bid you could sell at). */
export function quoteExit(bid: number, stop: number, target: number): ExitTrigger | null {
  if (bid <= stop) return { reason: "STOP", price: bid, note: bid < stop ? "Premium is through the stop-loss; the exit uses the actual bid, not the stop price." : "Stop-loss reached." };
  if (bid >= target) return { reason: "TARGET", price: bid, note: "Target reached." };
  return null;
}

/**
 * Replay exit on one option candle. A gap through a level fills at the open (never at the better level).
 * If the candle's range reaches both the stop and the target and the order of events cannot be known,
 * the conservative rule assumes the stop was hit first.
 */
export function candleExit(candle: { open: number; high: number; low: number; close: number }, stop: number, target: number): ExitTrigger | null {
  if (candle.open <= stop) return { reason: "STOP", price: candle.open, note: "Gapped through the stop-loss: filled at the candle's open, below the stop." };
  if (candle.open >= target) return { reason: "TARGET", price: candle.open, note: "Gapped through the target: filled at the candle's open." };
  const hitsStop = candle.low <= stop;
  const hitsTarget = candle.high >= target;
  if (hitsStop && hitsTarget) return { reason: "STOP", price: stop, note: "Stop-loss and target both inside one candle: the order is unknown, so the conservative rule takes the stop-loss." };
  if (hitsStop) return { reason: "STOP", price: stop, note: "Stop-loss reached." };
  if (hitsTarget) return { reason: "TARGET", price: target, note: "Target reached." };
  return null;
}
