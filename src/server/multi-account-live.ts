import { liveGate, type LiveGate } from "@/lib/multi-account/compliance";
import { maskId } from "@/lib/multi-account/engine";
import { LIVE_SLOTS, liveTotals, parseFunds, parseHoldings, parseOrders, parsePositions, type ConnectionState, type LiveAccount, type LiveView } from "@/lib/multi-account/live";
import type { SessionUser } from "@/server/auth";
import { brokerAccountView } from "@/server/dhan-account";
import { getDhanClientId } from "@/server/settings";
import { liveSwitchOn, staticIpReady } from "@/lib/security/flags";
import { ownsServerAccount, tradesServerAccount } from "@/server/live-gate";

/**
 * Live account view. The broker connection TradeD has is the single server-configured account, shown
 * only to its holder (DHAN_ACCOUNT_OWNER_EMAIL, or the super admin when unset) and to nobody else.
 * Tokens and full client IDs never leave the server. Orders go through server/live-orders, not here.
 */

/** Why slots 2 to 8 cannot be connected yet. */
export const LIVE_MISSING = [
  "Each additional holder must authorize their own Dhan account through Dhan's consent login. That flow needs Dhan partner access or each holder's own API key, which is not set up.",
  "Each holder needs their own static IP registered with Dhan; the execution server's IP is registered for the primary holder only.",
  "Accounts must belong to you or your family (self, spouse, dependent children, dependent parents).",
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

export async function serverAccount(now = new Date(), gate: LiveGate = liveGate(), prefetched?: Awaited<ReturnType<typeof brokerAccountView>>): Promise<LiveAccount> {
  const [broker, clientId] = await Promise.all([prefetched ?? brokerAccountView(), getDhanClientId()]);
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
    tradingReady: gate.enabled,
    tradingReason: gate.enabled ? "Ready: orders are sent from the registered static IP after you confirm them." : `Order placement locked: ${gate.requirements.filter((item) => !item.met).map((item) => item.label.toLowerCase()).join("; ")}.`,
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
  const owner = ownsServerAccount(user);
  const broker = owner ? await brokerAccountView() : null;
  const gate = liveGate({
    staticIp: staticIpReady(),
    ownAccount: tradesServerAccount(user),
    authorized: Boolean(broker && broker.clientConfigured && broker.token.source !== "missing" && !broker.token.expired),
    switchedOn: liveSwitchOn(),
  });
  const first = owner && broker ? await serverAccount(now, gate, broker) : null;
  const slots = Array.from({ length: LIVE_SLOTS }, (_, index) => (index === 0 && first ? first : emptySlot(index + 1, "No broker account is connected to this slot.")));
  const reads = first && (first.connection === "CONNECTED" || first.connection === "DATA_UNAVAILABLE");
  return {
    accounts: slots,
    capabilities: {
      readFunds: Boolean(reads && first?.funds && !first.funds.error),
      readPositions: Boolean(reads && first?.positions),
      readOrders: Boolean(reads && first?.orders),
      readHoldings: Boolean(reads && first?.holdings),
      placeOrders: Boolean(reads && gate.enabled),
      cancelOrders: Boolean(reads && gate.enabled),
      connectAccounts: false,
    },
    missing: LIVE_MISSING,
    viewerOwnsConnection: owner,
    gate,
    notice: !owner
      ? "No broker account is connected to your TradeD user. The server connection belongs to its holder and is not shown to other users."
      : gate.enabled
        ? "Your Dhan account is connected. Orders are sent from the registered static IP only after you review and confirm them."
        : "Read-only. Funds, positions and orders are read from your Dhan account. Order placement stays locked until every live-trading requirement is met.",
    syncedAt: now.toISOString(),
  };
}
