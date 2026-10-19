import { applyBuy, applySell } from "@/lib/trading/accounting";
import { calculateCharges } from "@/lib/trading/fees";
import type { ChargeSettings } from "@/lib/trading/settings";
import { optionLedgerSymbol } from "@/lib/options/contract";

/** Multi-account demo engine. Pure: no I/O, no broker access. All money is integer paise. */

export const ACCOUNT_SLOTS = 8;
export const MAX_REQUESTS_KEPT = 300;
export const DEFAULT_DEMO_CAPITAL_PAISE = 5_00_000_00;

export type Side = "BUY" | "SELL";
export type Right = "CE" | "PE";
export type OrderType = "MARKET" | "LIMIT";
export type Product = "INTRADAY" | "MARGIN";
export type Mode = "DEMO" | "LIVE";

export type RiskLimits = {
  maxLots: number;
  maxCapitalPaise: number;
  maxDailyLossPaise: number;
  maxOpenPositions: number;
  /** Empty means every underlying is allowed. */
  underlyings: string[];
  sides: Side[];
};

export type DemoAccount = {
  id: string;
  slot: number;
  nickname: string;
  tradingEnabled: boolean;
  selected: boolean;
  lots: number;
  startingPaise: number;
  cashPaise: number;
  realizedPaise: number;
  dayKey: string;
  dayRealizedPaise: number;
  risk: RiskLimits;
};

export type Contract = { underlying: string; expiry: string; strike: number; right: Right };

export type PriceSource = { kind: "chain" } | { kind: "replay"; date: string; time: string };

export type PriceQuote = {
  premiumPaise: number;
  lotSize: number;
  asOf: string;
  source: "chain" | "replay";
  label: string;
  securityId: string | null;
};

export type LegStatus = "FILLED" | "PARTIAL" | "PENDING" | "REJECTED" | "CANCELLED" | "UNKNOWN";

export type Leg = {
  id: string;
  accountId: string;
  nickname: string;
  lots: number;
  quantity: number;
  filledQuantity: number;
  status: LegStatus;
  avgPaise: number | null;
  chargesPaise: number;
  realizedPaise: number | null;
  reason: string;
  ref: string;
  updatedAt: string;
};

export type OverallStatus = "Completed" | "Partially Completed" | "Failed" | "Pending";

export type OrderRequest = {
  id: string;
  key: string;
  createdAt: string;
  mode: "DEMO";
  contract: Contract;
  side: Side;
  orderType: OrderType;
  limitPaise: number | null;
  product: Product;
  stopLossPaise: number | null;
  targetPaise: number | null;
  closing: boolean;
  quote: PriceQuote;
  legs: Leg[];
  status: OverallStatus;
};

export type DemoPosition = {
  accountId: string;
  symbol: string;
  contract: Contract;
  lotSize: number;
  securityId: string | null;
  quantity: number;
  avgCostPaise: number;
  openedAt: string;
  source: "chain" | "replay";
};

export type DemoDoc = {
  v: 1;
  halted: boolean;
  haltedAt: string | null;
  accounts: DemoAccount[];
  positions: DemoPosition[];
  requests: OrderRequest[];
};

export function defaultRisk(): RiskLimits {
  return { maxLots: 10, maxCapitalPaise: DEFAULT_DEMO_CAPITAL_PAISE, maxDailyLossPaise: 25_000_00, maxOpenPositions: 5, underlyings: [], sides: ["BUY", "SELL"] };
}

export function defaultAccount(slot: number, startingPaise = DEFAULT_DEMO_CAPITAL_PAISE): DemoAccount {
  return {
    id: `demo-${slot}`,
    slot,
    nickname: `Demo account ${slot}`,
    tradingEnabled: true,
    selected: false,
    lots: 1,
    startingPaise,
    cashPaise: startingPaise,
    realizedPaise: 0,
    dayKey: "",
    dayRealizedPaise: 0,
    risk: defaultRisk(),
  };
}

export function defaultDoc(): DemoDoc {
  return { v: 1, halted: false, haltedAt: null, accounts: Array.from({ length: ACCOUNT_SLOTS }, (_, index) => defaultAccount(index + 1)), positions: [], requests: [] };
}

export function contractSymbol(contract: Contract) {
  return optionLedgerSymbol(contract.underlying, contract.expiry, contract.strike, contract.right);
}

export function overallStatus(legs: Array<Pick<Leg, "status">>): OverallStatus {
  if (legs.length === 0) return "Failed";
  if (legs.some((leg) => leg.status === "PENDING" || leg.status === "UNKNOWN")) return "Pending";
  if (legs.every((leg) => leg.status === "FILLED")) return "Completed";
  if (legs.some((leg) => leg.status === "FILLED" || leg.status === "PARTIAL")) return "Partially Completed";
  return "Failed";
}

export function chargesFor(side: Side, notionalPaise: number, settings: ChargeSettings) {
  return Number(calculateCharges(side, BigInt(notionalPaise), settings).total);
}

function dayRealized(account: DemoAccount, today: string) {
  return account.dayKey === today ? account.dayRealizedPaise : 0;
}

function openPositions(doc: Pick<DemoDoc, "positions">, accountId: string) {
  return doc.positions.filter((position) => position.accountId === accountId && position.quantity > 0);
}

export type OrderIntent = {
  contract: Contract;
  side: Side;
  orderType: OrderType;
  limitPaise: number | null;
  /** Per-account lots override; when absent each account's configured lots are used. */
  lots?: Record<string, number>;
  /** Close-position workflow: reduces exposure, so it is allowed during an emergency stop. */
  closing?: boolean;
};

/**
 * Checks one account right before its leg is filled. Returns the rejection reason, or null.
 * Accounts are never pooled: every check reads only this account's cash, limits and positions.
 */
export function riskCheck(doc: DemoDoc, account: DemoAccount, intent: OrderIntent, lots: number, quote: PriceQuote, settings: ChargeSettings, today: string): string | null {
  const closing = intent.closing === true && intent.side === "SELL";
  if (doc.halted && !closing) return "Emergency stop is on. New orders are blocked for every account.";
  if (!account.tradingEnabled && !closing) return "Trading is turned off for this account.";
  if (!Number.isInteger(lots) || lots <= 0) return "Set at least 1 lot for this account.";
  if (!closing && lots > account.risk.maxLots) return `${lots} lots is above this account's limit of ${account.risk.maxLots}.`;
  if (!closing && !account.risk.sides.includes(intent.side)) return `${intent.side} orders are not allowed for this account.`;
  const underlying = intent.contract.underlying.toUpperCase();
  if (!closing && account.risk.underlyings.length > 0 && !account.risk.underlyings.includes(underlying)) return `${underlying} is not on this account's allowed list.`;
  const quantity = lots * quote.lotSize;
  const symbol = contractSymbol(intent.contract);
  const held = openPositions(doc, account.id);
  const existing = held.find((position) => position.symbol === symbol);
  if (intent.side === "SELL") {
    if (!existing || existing.quantity < quantity) return existing ? `This account holds ${existing.quantity} units, fewer than ${quantity}.` : "This account has no open position in this contract. Short options are not available.";
    return null;
  }
  if (dayRealized(account, today) <= -account.risk.maxDailyLossPaise) return "This account has reached its daily loss limit. New buys are blocked until tomorrow.";
  if (!existing && held.length >= account.risk.maxOpenPositions) return `This account already has ${held.length} open positions, its limit.`;
  const price = fillPrice(intent, quote);
  const notional = price * quantity;
  const cost = notional + chargesFor("BUY", notional, settings);
  if (cost > account.cashPaise) return "Not enough demo cash in this account for this order.";
  const deployed = held.reduce((sum, position) => sum + position.avgCostPaise * position.quantity, 0);
  if (deployed + cost > account.risk.maxCapitalPaise) return "This order would take the account above its capital limit.";
  return null;
}

/** Fill price for a marketable order, or null when a limit order cannot fill at the quote. */
export function marketablePrice(intent: Pick<OrderIntent, "side" | "orderType" | "limitPaise">, quote: Pick<PriceQuote, "premiumPaise">): number | null {
  if (intent.orderType === "MARKET") return quote.premiumPaise;
  const limit = intent.limitPaise;
  if (limit == null || limit <= 0) return null;
  if (intent.side === "BUY") return limit >= quote.premiumPaise ? quote.premiumPaise : null;
  return limit <= quote.premiumPaise ? quote.premiumPaise : null;
}

function fillPrice(intent: OrderIntent, quote: PriceQuote) {
  return marketablePrice(intent, quote) ?? intent.limitPaise ?? quote.premiumPaise;
}

export type LegPlan = { account: DemoAccount; lots: number; quantity: number; reject: string | null };

export function planLegs(doc: DemoDoc, accountIds: string[], intent: OrderIntent, quote: PriceQuote, settings: ChargeSettings, today: string): LegPlan[] {
  const unique = [...new Set(accountIds)];
  return unique.flatMap((id) => {
    const account = doc.accounts.find((item) => item.id === id);
    if (!account) return [];
    const lots = intent.lots?.[id] ?? account.lots;
    return [{ account, lots, quantity: lots * quote.lotSize, reject: riskCheck(doc, account, intent, lots, quote, settings, today) }];
  });
}

/** Applies one filled leg to its own account and position. Returns the realised amount for sells. */
export function applyFill(doc: DemoDoc, accountId: string, intent: OrderIntent, quote: PriceQuote, quantity: number, pricePaise: number, settings: ChargeSettings, today: string, at: string): { chargesPaise: number; realizedPaise: number | null } {
  const account = doc.accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("Unknown account.");
  const symbol = contractSymbol(intent.contract);
  const notional = pricePaise * quantity;
  const charges = chargesFor(intent.side, notional, settings);
  let position = doc.positions.find((item) => item.accountId === accountId && item.symbol === symbol);
  if (intent.side === "BUY") {
    if (!position) {
      position = { accountId, symbol, contract: { ...intent.contract, underlying: intent.contract.underlying.toUpperCase() }, lotSize: quote.lotSize, securityId: quote.securityId, quantity: 0, avgCostPaise: 0, openedAt: at, source: quote.source };
      doc.positions.push(position);
    }
    const next = applyBuy({ quantity: position.quantity, avgCostPaise: BigInt(position.avgCostPaise), realizedPaise: 0n }, quantity, BigInt(pricePaise), BigInt(charges));
    position.quantity = next.quantity;
    position.avgCostPaise = Number(next.avgCostPaise);
    account.cashPaise -= notional + charges;
    return { chargesPaise: charges, realizedPaise: null };
  }
  if (!position) throw new Error("No position to sell.");
  const next = applySell({ quantity: position.quantity, avgCostPaise: BigInt(position.avgCostPaise), realizedPaise: 0n }, quantity, BigInt(pricePaise), BigInt(charges));
  const realized = Number(next.realizedOnTrade);
  position.quantity = next.quantity;
  position.avgCostPaise = Number(next.avgCostPaise);
  account.cashPaise += notional - charges;
  account.realizedPaise += realized;
  account.dayRealizedPaise = dayRealized(account, today) + realized;
  account.dayKey = today;
  doc.positions = doc.positions.filter((item) => item.quantity > 0);
  return { chargesPaise: charges, realizedPaise: realized };
}

export type AccountSummary = {
  accountId: string;
  cashPaise: number;
  investedPaise: number;
  openPositions: number;
  realizedPaise: number;
  dayRealizedPaise: number;
  /** Null when at least one open position has no current price. */
  unrealizedPaise: number | null;
};

export type Summary = {
  accounts: AccountSummary[];
  combined: { cashPaise: number; investedPaise: number; openPositions: number; realizedPaise: number; dayRealizedPaise: number; unrealizedPaise: number | null; marksMissing: number };
  orderCounts: Record<OverallStatus, number>;
  legCounts: Record<LegStatus, number>;
  selected: number;
  enabled: number;
};

/** marks: contract symbol → current premium in paise, or null when no price is available. */
export function summarize(doc: DemoDoc, marks: Map<string, number | null>, today: string): Summary {
  let marksMissing = 0;
  const accounts = doc.accounts.map((account): AccountSummary => {
    const held = openPositions(doc, account.id);
    let unrealized: number | null = 0;
    for (const position of held) {
      const mark = marks.get(position.symbol);
      if (mark == null) {
        unrealized = null;
        marksMissing += 1;
      } else if (unrealized != null) {
        unrealized += (mark - position.avgCostPaise) * position.quantity;
      }
    }
    return {
      accountId: account.id,
      cashPaise: account.cashPaise,
      investedPaise: held.reduce((sum, position) => sum + position.avgCostPaise * position.quantity, 0),
      openPositions: held.length,
      realizedPaise: account.realizedPaise,
      dayRealizedPaise: dayRealized(account, today),
      unrealizedPaise: unrealized,
    };
  });
  const sum = (pick: (row: AccountSummary) => number) => accounts.reduce((total, row) => total + pick(row), 0);
  const orderCounts: Record<OverallStatus, number> = { Completed: 0, "Partially Completed": 0, Failed: 0, Pending: 0 };
  const legCounts: Record<LegStatus, number> = { FILLED: 0, PARTIAL: 0, PENDING: 0, REJECTED: 0, CANCELLED: 0, UNKNOWN: 0 };
  for (const request of doc.requests) {
    orderCounts[request.status] += 1;
    for (const leg of request.legs) legCounts[leg.status] += 1;
  }
  return {
    accounts,
    combined: {
      cashPaise: sum((row) => row.cashPaise),
      investedPaise: sum((row) => row.investedPaise),
      openPositions: sum((row) => row.openPositions),
      realizedPaise: sum((row) => row.realizedPaise),
      dayRealizedPaise: sum((row) => row.dayRealizedPaise),
      unrealizedPaise: accounts.some((row) => row.unrealizedPaise == null) ? null : sum((row) => row.unrealizedPaise ?? 0),
      marksMissing,
    },
    orderCounts,
    legCounts,
    selected: doc.accounts.filter((account) => account.selected).length,
    enabled: doc.accounts.filter((account) => account.tradingEnabled).length,
  };
}

/** Masks anything that looks like a broker client ID so it never renders in full. */
export function maskId(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "••••";
  return `${"•".repeat(Math.min(6, trimmed.length - 4))}${trimmed.slice(-4)}`;
}
