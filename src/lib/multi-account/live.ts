import type { LiveGate } from "@/lib/multi-account/compliance";

/**
 * Read-only broker account normalisation. Values are taken only from broker payloads;
 * anything missing or malformed becomes null and is shown as Unavailable, never zero.
 */

export const LIVE_SLOTS = 8;

export type ConnectionState = "NOT_CONNECTED" | "AUTH_REQUIRED" | "EXPIRED" | "CONNECTED" | "DATA_UNAVAILABLE" | "ERROR";

export type LiveFunds = { availablePaise: number | null; usedMarginPaise: number | null; withdrawablePaise: number | null; openingLimitPaise: number | null; error: string | null };

export type LivePosition = {
  key: string;
  symbol: string;
  underlying: string | null;
  expiry: string | null;
  strike: number | null;
  right: "CE" | "PE" | null;
  product: string | null;
  side: "LONG" | "SHORT" | "CLOSED";
  netQty: number;
  avgPaise: number | null;
  realizedPaise: number | null;
  unrealizedPaise: number | null;
};

export type LiveOrderStatus = "PENDING" | "PARTIAL" | "FILLED" | "REJECTED" | "CANCELLED" | "EXPIRED" | "UNKNOWN";

export type LiveOrder = {
  ref: string;
  symbol: string;
  side: "BUY" | "SELL" | null;
  orderType: string | null;
  product: string | null;
  quantity: number | null;
  filledQuantity: number | null;
  pricePaise: number | null;
  avgPaise: number | null;
  status: LiveOrderStatus;
  brokerStatus: string;
  reason: string;
  createdAt: string | null;
};

export type LiveHolding = {
  key: string;
  symbol: string;
  quantity: number;
  availableQty: number | null;
  avgPaise: number | null;
  /** quantity × average cost when both are known; otherwise null. */
  costPaise: number | null;
};

export type LiveTotals = {
  realizedPaise: number | null;
  unrealizedPaise: number | null;
  openPositions: number | null;
  pendingOrders: number | null;
  rejectedOrders: number | null;
  holdingsCostPaise: number | null;
  holdingsCount: number | null;
};

/** Family account details shown to its owner. Secrets never appear here. */
export type FamilyInfo = {
  brokerAccountId: string;
  relationship: "SELF" | "SPOUSE" | "DEPENDENT_CHILD" | "DEPENDENT_PARENT";
  relationshipLabel: string;
  configured: boolean;
  staticIp: string | null;
  ipConfirmed: boolean;
  /** Redirect URL to enter when the holder creates their Dhan API key. */
  callbackUrl: string;
};

export type LiveAccount = {
  id: string;
  /** What to send as accountId when ordering: "server", a broker account id, or null for an empty slot. */
  target: string | null;
  family: FamilyInfo | null;
  /** Owner's switch: included in orders. */
  enabled: boolean;
  /** Full Dhan client id, sent only to the account's owner. */
  clientId: string | null;
  /** Holder's name as reported by Dhan, when known. */
  holderName: string | null;
  slot: number;
  nickname: string;
  maskedId: string | null;
  connection: ConnectionState;
  authorized: boolean;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  tradingReady: boolean;
  tradingReason: string;
  message: string;
  funds: LiveFunds | null;
  positions: LivePosition[] | null;
  positionsError: string | null;
  holdings: LiveHolding[] | null;
  holdingsError: string | null;
  orders: LiveOrder[] | null;
  ordersError: string | null;
  totals: LiveTotals;
};

export type LiveCapabilities = { readFunds: boolean; readPositions: boolean; readOrders: boolean; readHoldings: boolean; placeOrders: boolean; cancelOrders: boolean; connectAccounts: boolean };

export type LiveView = {
  accounts: LiveAccount[];
  capabilities: LiveCapabilities;
  missing: string[];
  viewerOwnsConnection: boolean;
  /** Live execution gate computed on the server for this viewer. */
  gate: LiveGate;
  notice: string;
  syncedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function paise(value: unknown): number | null {
  const rupees = num(value);
  return rupees == null ? null : Math.round(rupees * 100);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function errorOf(raw: unknown): string | null {
  return isRecord(raw) && typeof raw.error === "string" ? raw.error : null;
}

function listOf(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.data)) return raw.data;
  return null;
}

export function parseFunds(raw: unknown): LiveFunds | null {
  if (raw == null) return null;
  const error = errorOf(raw);
  if (error) return { availablePaise: null, usedMarginPaise: null, withdrawablePaise: null, openingLimitPaise: null, error };
  if (!isRecord(raw)) return { availablePaise: null, usedMarginPaise: null, withdrawablePaise: null, openingLimitPaise: null, error: "The broker returned funds in an unexpected format." };
  return {
    availablePaise: paise(raw.availabelBalance ?? raw.availableBalance),
    usedMarginPaise: paise(raw.utilizedAmount),
    withdrawablePaise: paise(raw.withdrawableBalance),
    openingLimitPaise: paise(raw.sodLimit),
    error: null,
  };
}

function rightOf(value: unknown): "CE" | "PE" | null {
  const raw = text(value)?.toUpperCase();
  if (raw === "CALL" || raw === "CE") return "CE";
  if (raw === "PUT" || raw === "PE") return "PE";
  return null;
}

function dateOf(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match?.[1] ?? null;
}

export function parsePositions(raw: unknown): { positions: LivePosition[] | null; error: string | null } {
  if (raw == null) return { positions: null, error: null };
  const error = errorOf(raw);
  if (error) return { positions: null, error };
  const list = listOf(raw);
  if (!list) return { positions: null, error: "The broker returned positions in an unexpected format." };
  const positions = list.filter(isRecord).map((item, index): LivePosition => {
    const netQty = num(item.netQty ?? item.netQuantity) ?? 0;
    const type = text(item.positionType)?.toUpperCase();
    const side = type === "LONG" || type === "SHORT" || type === "CLOSED" ? type : netQty > 0 ? "LONG" : netQty < 0 ? "SHORT" : "CLOSED";
    const symbol = text(item.tradingSymbol) ?? text(item.symbol) ?? "Unknown instrument";
    return {
      key: `${text(item.securityId) ?? symbol}|${text(item.productType) ?? ""}|${index}`,
      symbol,
      underlying: text(item.underlying) ?? null,
      expiry: dateOf(item.drvExpiryDate),
      strike: num(item.drvStrikePrice),
      right: rightOf(item.drvOptionType),
      product: text(item.productType),
      side,
      netQty,
      avgPaise: paise(netQty >= 0 ? item.buyAvg ?? item.costPrice : item.sellAvg ?? item.costPrice),
      realizedPaise: paise(item.realizedProfit),
      unrealizedPaise: paise(item.unrealizedProfit),
    };
  });
  return { positions, error: null };
}

const ORDER_STATUS: Record<string, LiveOrderStatus> = {
  TRANSIT: "PENDING", PENDING: "PENDING", OPEN: "PENDING", TRIGGER_PENDING: "PENDING",
  PART_TRADED: "PARTIAL", TRADED: "FILLED", COMPLETE: "FILLED",
  REJECTED: "REJECTED", CANCELLED: "CANCELLED", EXPIRED: "EXPIRED",
};

export function parseOrders(raw: unknown): { orders: LiveOrder[] | null; error: string | null } {
  if (raw == null) return { orders: null, error: null };
  const error = errorOf(raw);
  if (error) return { orders: null, error };
  const list = listOf(raw);
  if (!list) return { orders: null, error: "The broker returned orders in an unexpected format." };
  const orders = list.filter(isRecord).flatMap((item): LiveOrder[] => {
    const ref = text(item.orderId) ?? text(item.exchangeOrderId);
    if (!ref) return [];
    const brokerStatus = text(item.orderStatus)?.toUpperCase() ?? "";
    const side = text(item.transactionType)?.toUpperCase();
    return [{
      ref,
      symbol: text(item.tradingSymbol) ?? "Unknown instrument",
      side: side === "BUY" || side === "SELL" ? side : null,
      orderType: text(item.orderType),
      product: text(item.productType),
      quantity: num(item.quantity),
      filledQuantity: num(item.filledQty),
      pricePaise: paise(item.price),
      avgPaise: paise(item.averageTradedPrice),
      status: ORDER_STATUS[brokerStatus] ?? "UNKNOWN",
      brokerStatus: brokerStatus || "Not reported",
      reason: text(item.omsErrorDescription) ?? "",
      createdAt: text(item.createTime) ?? text(item.updateTime),
    }];
  });
  return { orders, error: null };
}

function sumOrNull(values: Array<number | null>): number | null {
  if (values.some((value) => value == null)) return null;
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export function parseHoldings(raw: unknown): { holdings: LiveHolding[] | null; error: string | null } {
  if (raw == null) return { holdings: null, error: null };
  const error = errorOf(raw);
  // Dhan answers an account with no holdings with an error rather than an empty list.
  if (error && /no\s+holdings?/i.test(error)) return { holdings: [], error: null };
  if (error) return { holdings: null, error };
  const list = listOf(raw);
  if (!list) return { holdings: null, error: "The broker returned holdings in an unexpected format." };
  const holdings = list.filter(isRecord).flatMap((item, index): LiveHolding[] => {
    const symbol = text(item.tradingSymbol) ?? text(item.symbol);
    const quantity = num(item.totalQty ?? item.quantity);
    if (!symbol || quantity == null || quantity <= 0) return [];
    const avgPaise = paise(item.avgCostPrice ?? item.costPrice);
    return [{
      key: `${text(item.isin) ?? text(item.securityId) ?? symbol}|${index}`,
      symbol,
      quantity,
      availableQty: num(item.availableQty ?? item.dpQty),
      avgPaise,
      costPaise: avgPaise == null ? null : avgPaise * quantity,
    }];
  });
  return { holdings, error: null };
}

export function liveTotals(positions: LivePosition[] | null, orders: LiveOrder[] | null, holdings: LiveHolding[] | null = null): LiveTotals {
  return {
    realizedPaise: positions ? sumOrNull(positions.map((position) => position.realizedPaise)) : null,
    unrealizedPaise: positions ? sumOrNull(positions.filter((position) => position.netQty !== 0).map((position) => position.unrealizedPaise)) : null,
    openPositions: positions ? positions.filter((position) => position.netQty !== 0).length : null,
    pendingOrders: orders ? orders.filter((order) => order.status === "PENDING" || order.status === "PARTIAL").length : null,
    rejectedOrders: orders ? orders.filter((order) => order.status === "REJECTED").length : null,
    holdingsCostPaise: holdings ? sumOrNull(holdings.map((holding) => holding.costPaise)) : null,
    holdingsCount: holdings ? holdings.length : null,
  };
}

export type CombinedLive = {
  connected: number;
  authorized: number;
  eligible: number;
  synced: number;
  incomplete: boolean;
  realizedPaise: number | null;
  unrealizedPaise: number | null;
  totalPaise: number | null;
  availablePaise: number | null;
  usedMarginPaise: number | null;
  openPositions: number | null;
  pendingOrders: number | null;
  rejectedOrders: number | null;
  holdingsCostPaise: number | null;
};

/** Combines only accounts that synced; flags the result as incomplete when any connected account failed a read. */
export function combineLive(accounts: LiveAccount[]): CombinedLive {
  const connected = accounts.filter((account) => account.connection === "CONNECTED" || account.connection === "DATA_UNAVAILABLE");
  const failedRead = (account: LiveAccount) => account.connection !== "CONNECTED" || account.funds?.error != null || account.positionsError != null || account.holdingsError != null || account.ordersError != null;
  const synced = connected.filter((account) => !failedRead(account));
  const pick = (read: (account: LiveAccount) => number | null) => (synced.length === 0 ? null : sumOrNull(synced.map(read)));
  const realizedPaise = pick((account) => account.totals.realizedPaise);
  const unrealizedPaise = pick((account) => account.totals.unrealizedPaise);
  return {
    connected: connected.length,
    authorized: accounts.filter((account) => account.authorized).length,
    eligible: accounts.filter((account) => account.tradingReady).length,
    synced: synced.length,
    incomplete: synced.length < connected.length,
    realizedPaise,
    unrealizedPaise,
    totalPaise: realizedPaise == null || unrealizedPaise == null ? null : realizedPaise + unrealizedPaise,
    availablePaise: pick((account) => account.funds?.availablePaise ?? null),
    usedMarginPaise: pick((account) => account.funds?.usedMarginPaise ?? null),
    openPositions: pick((account) => account.totals.openPositions),
    pendingOrders: pick((account) => account.totals.pendingOrders),
    rejectedOrders: pick((account) => account.totals.rejectedOrders),
    holdingsCostPaise: pick((account) => account.totals.holdingsCostPaise),
  };
}
