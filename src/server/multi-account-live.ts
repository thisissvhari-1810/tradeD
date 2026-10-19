import { maskId } from "@/lib/multi-account/engine";
import { LIVE_SLOTS, liveTotals, parseFunds, parseHoldings, parseOrders, parsePositions, type ConnectionState, type LiveAccount, type LiveView } from "@/lib/multi-account/live";
import type { SessionUser } from "@/server/auth";
import { brokerAccountView } from "@/server/dhan-account";
import { getDhanClientId } from "@/server/settings";

/**
 * Read-only live account view. The only broker connection TradeD has is the single server-configured
 * account, so it is shown to the super admin who configured it and to nobody else.
 * Tokens and full client IDs never leave the server; there is no order or cancel path here.
 */

const TRADING_LOCKED = "Order placement is not available: the connection is read-only and static-IP order routing is not set up.";

export const LIVE_MISSING = [
  "A per-holder broker authorization flow (each holder signs in and grants API access themselves). The broker API app key, secret and redirect URL for that flow are not configured.",
  "Per-account server-side credential storage with expiry and refresh tracking. TradeD stores one market-data token only.",
  "An order adapter with idempotent placement, cancellation and status reconciliation. No order endpoint is implemented, by design.",
  "A static IP registered for each account holder, required for API order placement since 1 April 2026. The current hosting has no fixed outbound IP.",
  "Family-only use: accounts must belong to you or your family (self, spouse, dependent children, dependent parents).",
];

function emptySlot(slot: number, message: string): LiveAccount {
  return {
    id: `live-${slot}`,
    slot,
    nickname: `Live slot ${slot}`,
    maskedId: null,
    connection: "NOT_CONNECTED",
    authorized: false,
    tokenExpiresAt: null,
    lastSyncAt: null,
    tradingReady: false,
    tradingReason: "Not connected.",
    message,
    funds: null,
    positions: null,
    positionsError: null,
    holdings: null,
    holdingsError: null,
    orders: null,
    ordersError: null,
    totals: { realizedPaise: null, unrealizedPaise: null, openPositions: null, pendingOrders: null, rejectedOrders: null, holdingsCostPaise: null, holdingsCount: null },
  };
}

export async function serverAccount(now = new Date()): Promise<LiveAccount> {
  const [broker, clientId] = await Promise.all([brokerAccountView(), getDhanClientId()]);
  const base = emptySlot(1, broker.reason);
  const maskedId = clientId ? maskId(clientId) : null;
  const tokenExpiresAt = broker.token.expiresAt;
  if (!broker.clientConfigured && broker.token.source === "missing") return { ...base, nickname: "Server connection", maskedId, message: "No broker account is configured on the server." };
  if (broker.token.source === "missing" || !broker.clientConfigured) return { ...base, nickname: "Server connection", maskedId, connection: "AUTH_REQUIRED", tokenExpiresAt, tradingReason: "Authentication required.", message: broker.reason };
  if (broker.token.expired) return { ...base, nickname: "Server connection", maskedId, connection: "EXPIRED", tokenExpiresAt, tradingReason: "Authorization expired.", message: broker.reason };
  const funds = parseFunds(broker.funds);
  const { positions, error: positionsError } = parsePositions(broker.positions);
  const { holdings, error: holdingsError } = parseHoldings(broker.holdings);
  const { orders, error: ordersError } = parseOrders(broker.orders);
  const failures = [funds?.error, positionsError, holdingsError, ordersError].filter(Boolean).length;
  const connection: ConnectionState = failures === 4 ? "ERROR" : failures > 0 ? "DATA_UNAVAILABLE" : "CONNECTED";
  return {
    ...base,
    nickname: "Server connection",
    maskedId,
    connection,
    authorized: true,
    tokenExpiresAt,
    lastSyncAt: failures === 4 ? null : now.toISOString(),
    tradingReason: TRADING_LOCKED,
    message: failures === 4 ? "Every account read failed. Check the token and client ID on the server." : broker.reason,
    funds,
    positions,
    positionsError,
    holdings,
    holdingsError,
    orders,
    ordersError,
    totals: liveTotals(positions, orders, holdings),
  };
}

export async function liveAccountsView(user: SessionUser, now = new Date()): Promise<LiveView> {
  const owner = user.role === "SUPER_ADMIN";
  const first = owner ? await serverAccount(now) : null;
  const slots = Array.from({ length: LIVE_SLOTS }, (_, index) => (index === 0 && first ? first : emptySlot(index + 1, "No broker account is connected to this slot.")));
  const reads = first && (first.connection === "CONNECTED" || first.connection === "DATA_UNAVAILABLE");
  return {
    accounts: slots,
    capabilities: {
      readFunds: Boolean(reads && first?.funds && !first.funds.error),
      readPositions: Boolean(reads && first?.positions),
      readOrders: Boolean(reads && first?.orders),
      readHoldings: Boolean(reads && first?.holdings),
      placeOrders: false,
      cancelOrders: false,
      connectAccounts: false,
    },
    missing: LIVE_MISSING,
    viewerOwnsConnection: owner,
    notice: owner
      ? "Read-only. Funds, positions and orders are read from the server-configured broker connection. Orders cannot be placed from TradeD."
      : "No broker account is connected to your TradeD user. The server connection belongs to the administrator and is not shown to other users.",
    syncedAt: now.toISOString(),
  };
}
