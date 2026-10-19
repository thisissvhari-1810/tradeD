import { randomBytes } from "crypto";

/**
 * Live order intent, validation and Dhan mapping. Pure functions: the execution worker repeats the
 * same structural checks, so a bug on one side cannot alone send a malformed order.
 */

export type Segment = "NSE_EQ" | "BSE_EQ" | "NSE_FNO" | "BSE_FNO";
export type Product = "CNC" | "INTRADAY" | "MARGIN";
export type LiveOrderType = "MARKET" | "LIMIT";
export type Side = "BUY" | "SELL";

export type LiveOrderIntent = {
  exchangeSegment: Segment;
  securityId: string;
  symbol: string;
  side: Side;
  productType: Product;
  orderType: LiveOrderType;
  quantity: number;
  /** Lot size for F&O; quantity must be a whole number of lots. */
  lotSize: number | null;
  /** Limit price in paise; null for market orders. */
  pricePaise: number | null;
  /** Latest known price in paise, used only to estimate value. */
  referencePaise: number | null;
};

export type RiskLimits = { maxQuantity: number; maxOrderValuePaise: number };

export const DEFAULT_LIVE_LIMITS: RiskLimits = { maxQuantity: 1800, maxOrderValuePaise: 5_00_000_00 };

export function estimatePaise(intent: Pick<LiveOrderIntent, "quantity" | "pricePaise" | "referencePaise">): number | null {
  const price = intent.pricePaise ?? intent.referencePaise;
  return price != null && price > 0 ? price * intent.quantity : null;
}

/** All problems with an intent, as user-facing sentences. Empty means valid. */
export function validateIntent(intent: LiveOrderIntent, limits: RiskLimits = DEFAULT_LIVE_LIMITS): string[] {
  const problems: string[] = [];
  const fno = intent.exchangeSegment.endsWith("_FNO");
  if (!/^\d{1,12}$/.test(intent.securityId)) problems.push("This instrument has no broker security id.");
  if (!Number.isInteger(intent.quantity) || intent.quantity < 1) problems.push("Quantity must be a whole number above zero.");
  else if (intent.quantity > limits.maxQuantity) problems.push(`Quantity is above the per-order limit of ${limits.maxQuantity}.`);
  if (fno) {
    if (!intent.lotSize || intent.lotSize < 1) problems.push("The contract's lot size is unknown, so the order cannot be sized.");
    else if (intent.quantity % intent.lotSize !== 0) problems.push(`Quantity must be a multiple of the lot size (${intent.lotSize}).`);
  }
  if (intent.productType === "CNC" && fno) problems.push("Delivery (CNC) is for equity only.");
  if (intent.productType === "MARGIN" && !fno) problems.push("Carry (MARGIN) is for F&O only.");
  if (intent.orderType === "LIMIT" && !(intent.pricePaise != null && Number.isInteger(intent.pricePaise) && intent.pricePaise > 0)) problems.push("Enter a limit price.");
  if (intent.orderType === "MARKET" && intent.pricePaise != null) problems.push("A market order cannot carry a price.");
  const value = estimatePaise(intent);
  if (value != null && value > limits.maxOrderValuePaise) problems.push(`Estimated value is above the per-order limit of ₹${(limits.maxOrderValuePaise / 100).toLocaleString("en-IN")}.`);
  return problems;
}

/** Dhan correlation ids: max 30 characters of letters, digits, underscore and hyphen. */
export function newCorrelationId() {
  return `td${randomBytes(12).toString("hex")}`;
}

export function workerOrder(intent: LiveOrderIntent, correlationId: string) {
  return {
    correlationId,
    transactionType: intent.side,
    exchangeSegment: intent.exchangeSegment,
    productType: intent.productType,
    orderType: intent.orderType,
    securityId: intent.securityId,
    quantity: intent.quantity,
    price: intent.orderType === "LIMIT" && intent.pricePaise ? intent.pricePaise / 100 : 0,
  };
}

export type LocalStatus = "PENDING" | "PARTIAL" | "FILLED" | "REJECTED" | "CANCELLED" | "EXPIRED" | "UNKNOWN";

export function mapDhanStatus(status: unknown): LocalStatus {
  switch (String(status ?? "").toUpperCase()) {
    case "TRANSIT":
    case "PENDING":
    case "TRIGGERED":
      return "PENDING";
    case "PART_TRADED":
      return "PARTIAL";
    case "TRADED":
      return "FILLED";
    case "REJECTED":
      return "REJECTED";
    case "CANCELLED":
      return "CANCELLED";
    case "EXPIRED":
    case "CLOSED":
      return "EXPIRED";
    default:
      return "UNKNOWN";
  }
}

export const FINAL_STATUSES = new Set<string>(["FILLED", "REJECTED", "CANCELLED", "EXPIRED"]);

/** Fields TradeD keeps from a Dhan order-book row. */
export function readBrokerOrder(row: unknown) {
  const item = (Array.isArray(row) ? row[row.length - 1] : row) as Record<string, unknown> | null | undefined;
  if (!item || typeof item !== "object" || !item.orderId) return null;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
  const filled = number(item.filledQty);
  const remaining = number(item.remainingQuantity);
  const avg = number(item.averageTradedPrice);
  return {
    orderId: String(item.orderId),
    brokerStatus: String(item.orderStatus ?? ""),
    status: mapDhanStatus(item.orderStatus),
    filledQuantity: filled != null ? Math.trunc(filled) : null,
    remainingQuantity: remaining != null ? Math.trunc(remaining) : null,
    avgPricePaise: avg != null && avg > 0 ? Math.round(avg * 100) : null,
    reason: typeof item.omsErrorDescription === "string" ? item.omsErrorDescription.slice(0, 300) : "",
  };
}
