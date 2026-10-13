import { percentOf } from "@/lib/money";
import type { ChargeSettings } from "@/lib/trading/settings";

export type ChargeBreakdown = {
  brokerage: bigint;
  stt: bigint;
  exchange: bigint;
  sebi: bigint;
  stamp: bigint;
  gst: bigint;
  total: bigint;
};

/**
 * Educational delivery-equity charge model.
 * Each component is rounded half-up to the nearest paise, then summed.
 * This will not match a specific broker's statement to the paisa.
 */
export function calculateCharges(side: "BUY" | "SELL", notionalPaise: bigint, settings: ChargeSettings): ChargeBreakdown {
  if (notionalPaise < 0n) throw new Error("Notional cannot be negative.");
  const rawBrokerage = percentOf(notionalPaise, settings.brokeragePercent);
  const cap = BigInt(settings.brokerageCapPaise);
  const brokerage = rawBrokerage > cap ? cap : rawBrokerage;
  const stt = side === "SELL" ? percentOf(notionalPaise, settings.sttSellPercent) : 0n;
  const exchange = percentOf(notionalPaise, settings.exchangePercent);
  const sebi = sebiCharge(notionalPaise, settings.sebiPerCrorePaise);
  const stamp = side === "BUY" ? percentOf(notionalPaise, settings.stampBuyPercent) : 0n;
  const gst = percentOf(brokerage + exchange, settings.gstPercent);
  const total = brokerage + stt + exchange + sebi + stamp + gst;
  return { brokerage, stt, exchange, sebi, stamp, gst, total };
}

function sebiCharge(notionalPaise: bigint, perCrorePaise: number): bigint {
  // ₹10 per crore of turnover => perCrorePaise (1000) per 1e7 rupees => per 1e9 paise.
  const crorePaise = 1_000_000_000n;
  const numerator = notionalPaise * BigInt(perCrorePaise);
  return (numerator + crorePaise / 2n) / crorePaise;
}
