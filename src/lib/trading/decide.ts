import { applyAdverseSlippage } from "@/lib/money";
import { calculateCharges } from "@/lib/trading/fees";
import type { ChargeSettings, RiskSettings } from "@/lib/trading/settings";

export type DataModeName = "REALTIME" | "DELAYED" | "HISTORICAL" | "DEMO" | "UNAVAILABLE";
export type OrderTypeName = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "TARGET";
export type Side = "BUY" | "SELL";

export type QuoteView = {
  mode: DataModeName;
  lastPaise: bigint | null;
  bidPaise: bigint | null;
  askPaise: bigint | null;
  asOf: Date | null;
  marketOpen: boolean;
};

export type OrderIntent = {
  side: Side;
  type: OrderTypeName;
  quantity: number;
  limitPaise?: bigint | null;
  stopPaise?: bigint | null;
  lotSize: number;
  tickPaise: number;
  positionQuantity: number;
  openSellQuantity: number;
  positionMarkPaise: bigint;
  equityPaise: bigint;
};

export type Decision =
  | { ok: true; action: "FILL"; fillPrice: bigint; charges: bigint; reserve: bigint; reference: string }
  | { ok: true; action: "REST"; reserve: bigint; reference: string }
  | { ok: false; reason: string };

export function quoteIsStale(quote: QuoteView, now: Date, risk: RiskSettings): boolean {
  if (!quote.asOf || quote.lastPaise == null || quote.mode === "UNAVAILABLE" || quote.mode === "HISTORICAL") return true;
  const ageSeconds = (now.getTime() - quote.asOf.getTime()) / 1000;
  if (quote.mode === "REALTIME") return ageSeconds > risk.staleRealtimeSeconds;
  if (quote.mode === "DELAYED") return ageSeconds > risk.staleDelayedSeconds;
  if (quote.mode === "DEMO") return ageSeconds > risk.staleDemoSeconds;
  return true;
}

export function referencePrice(quote: QuoteView, side: Side): bigint | null {
  if (side === "BUY") return quote.askPaise ?? quote.lastPaise;
  return quote.bidPaise ?? quote.lastPaise;
}

export function decideOrder(
  intent: OrderIntent,
  quote: QuoteView,
  cashAvailable: bigint,
  now: Date,
  charges: ChargeSettings,
  risk: RiskSettings,
  tradingEnabled: boolean,
): Decision {
  if (!tradingEnabled) return { ok: false, reason: "Trading is disabled for this account." };
  if (!risk.allowedOrderTypes.includes(intent.type)) return { ok: false, reason: `${intent.type} orders are not enabled.` };
  if (!Number.isInteger(intent.quantity) || intent.quantity <= 0) return { ok: false, reason: "Quantity must be a positive whole number." };
  if (intent.quantity % intent.lotSize !== 0) return { ok: false, reason: `Quantity must be a multiple of the lot size (${intent.lotSize}).` };
  if (intent.quantity > risk.maxOrderQuantity) return { ok: false, reason: "Quantity exceeds the configured maximum." };

  const stale = quoteIsStale(quote, now, risk);
  const tradableSession = quote.marketOpen || (quote.mode === "DEMO" && risk.demoFillWhenClosed);

  if (intent.side === "SELL") {
    const free = intent.positionQuantity - intent.openSellQuantity;
    if (intent.quantity > free) return { ok: false, reason: "Sell quantity exceeds shares available after open sell orders." };
  }

  if (intent.type === "MARKET") {
    if (quote.mode === "UNAVAILABLE" || quote.mode === "HISTORICAL" || quote.lastPaise == null) {
      return { ok: false, reason: "Market data is unavailable. Market orders are not filled with an invented price." };
    }
    if (stale) return { ok: false, reason: "The latest price is stale. Market orders were not filled." };
    if (!tradableSession) return { ok: false, reason: "The market is closed. Market orders were not filled." };
    const raw = referencePrice(quote, intent.side);
    if (raw == null || raw <= 0n) return { ok: false, reason: "No usable bid or ask is available." };
    const fillPrice = applyAdverseSlippage(raw, intent.side, charges.slippageBps, BigInt(intent.tickPaise));
    if (fillPrice <= 0n) return { ok: false, reason: "Execution price is invalid." };
    return finishImmediate(intent, fillPrice, cashAvailable, charges, risk, `Filled against ${quote.mode.toLowerCase()} reference price.`);
  }

  if (intent.type === "LIMIT" || intent.type === "TARGET") {
    if (intent.limitPaise == null || intent.limitPaise <= 0n) return { ok: false, reason: "A limit price is required." };
    if (intent.limitPaise % BigInt(intent.tickPaise) !== 0n) return { ok: false, reason: "Limit price does not match the tick size." };
    if (intent.type === "TARGET" && intent.side !== "SELL") return { ok: false, reason: "Target orders are sell orders." };
    if (!stale && tradableSession && quote.lastPaise != null && crossed(intent, quote.lastPaise)) {
      const fillPrice = intent.type === "TARGET"
        ? applyAdverseSlippage(quote.lastPaise, "SELL", charges.slippageBps, BigInt(intent.tickPaise))
        : intent.limitPaise;
      return finishImmediate(intent, fillPrice, cashAvailable, charges, risk, "Trigger price was already met.");
    }
    const reserve = intent.side === "BUY" ? buyReserve(intent.quantity, intent.limitPaise, charges) : 0n;
    if (intent.side === "BUY" && cashAvailable < reserve) return { ok: false, reason: "Insufficient available cash to reserve this limit order." };
    if (intent.side === "BUY" && !withinRisk(intent, intent.limitPaise, risk)) return { ok: false, reason: "Order exceeds a configured risk limit." };
    return { ok: true, action: "REST", reserve, reference: "Order is resting until the reference price crosses the limit." };
  }

  if (intent.stopPaise == null || intent.stopPaise <= 0n) return { ok: false, reason: "A stop price is required." };
  if (intent.stopPaise % BigInt(intent.tickPaise) !== 0n) return { ok: false, reason: "Stop price does not match the tick size." };
  if (intent.side !== "SELL") return { ok: false, reason: "Stop orders are protective sell orders in this simulator." };
  if (intent.type === "STOP_LIMIT" && (intent.limitPaise == null || intent.limitPaise <= 0n)) {
    return { ok: false, reason: "A limit price is required for a stop-limit order." };
  }
  if (!stale && tradableSession && quote.lastPaise != null && quote.lastPaise <= intent.stopPaise) {
    if (intent.type === "STOP") {
      const raw = referencePrice(quote, "SELL");
      if (raw == null) return { ok: false, reason: "No usable price to fill the stop order." };
      const fillPrice = applyAdverseSlippage(raw, "SELL", charges.slippageBps, BigInt(intent.tickPaise));
      return finishImmediate(intent, fillPrice, cashAvailable, charges, risk, "Stop was already triggered.");
    }
    return { ok: true, action: "REST", reserve: 0n, reference: "Stop-limit triggered and will rest at its limit." };
  }
  return { ok: true, action: "REST", reserve: 0n, reference: "Stop is armed." };
}

function crossed(intent: OrderIntent, last: bigint): boolean {
  if (intent.type === "TARGET") return intent.side === "SELL" && last >= (intent.limitPaise ?? 0n);
  if (intent.side === "BUY") return last <= (intent.limitPaise ?? 0n);
  return last >= (intent.limitPaise ?? 0n);
}

function buyReserve(quantity: number, limitPaise: bigint, charges: ChargeSettings): bigint {
  const notional = limitPaise * BigInt(quantity);
  return notional + calculateCharges("BUY", notional, charges).total;
}

function withinRisk(intent: OrderIntent, price: bigint, risk: RiskSettings): boolean {
  const notional = price * BigInt(intent.quantity);
  if (notional > BigInt(risk.maxOrderValuePaise)) return false;
  if (intent.equityPaise <= 0n) return false;
  const nextExposure = intent.positionMarkPaise * BigInt(intent.positionQuantity) + notional;
  const limit = (intent.equityPaise * BigInt(Math.round(Number(risk.maxPositionPercent) * 100))) / 10_000n;
  return nextExposure <= limit || risk.maxPositionPercent === "100";
}

function finishImmediate(
  intent: OrderIntent,
  fillPrice: bigint,
  cashAvailable: bigint,
  charges: ChargeSettings,
  risk: RiskSettings,
  reference: string,
): Decision {
  const notional = fillPrice * BigInt(intent.quantity);
  const fee = calculateCharges(intent.side, notional, charges).total;
  if (notional > BigInt(risk.maxOrderValuePaise)) return { ok: false, reason: "Order value exceeds the configured maximum." };
  if (intent.side === "BUY") {
    const cost = notional + fee;
    if (cashAvailable < cost) return { ok: false, reason: "Insufficient available cash for this purchase, including estimated charges." };
    if (!withinRisk(intent, fillPrice, risk)) return { ok: false, reason: "Order exceeds a configured position limit." };
    return { ok: true, action: "FILL", fillPrice, charges: fee, reserve: 0n, reference };
  }
  return { ok: true, action: "FILL", fillPrice, charges: fee, reserve: 0n, reference };
}

export function shouldTriggerResting(input: {
  side: Side;
  type: OrderTypeName;
  limitPaise: bigint | null;
  stopPaise: bigint | null;
  triggered: boolean;
  lastPaise: bigint;
}): "FILL" | "ARM" | "WAIT" {
  if (input.type === "LIMIT") {
    if (input.limitPaise == null) return "WAIT";
    if (input.side === "BUY" && input.lastPaise <= input.limitPaise) return "FILL";
    if (input.side === "SELL" && input.lastPaise >= input.limitPaise) return "FILL";
    return "WAIT";
  }
  if (input.type === "TARGET") {
    if (input.limitPaise != null && input.lastPaise >= input.limitPaise) return "FILL";
    return "WAIT";
  }
  if (input.type === "STOP") {
    if (input.stopPaise != null && input.lastPaise <= input.stopPaise) return "FILL";
    return "WAIT";
  }
  if (input.type === "STOP_LIMIT") {
    if (!input.triggered) {
      if (input.stopPaise != null && input.lastPaise <= input.stopPaise) return "ARM";
      return "WAIT";
    }
    if (input.limitPaise != null && input.lastPaise >= input.limitPaise) return "FILL";
    return "WAIT";
  }
  return "WAIT";
}
