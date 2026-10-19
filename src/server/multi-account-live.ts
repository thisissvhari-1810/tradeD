import { liveGate, type LiveGate } from "@/lib/multi-account/compliance";
import { maskId } from "@/lib/multi-account/engine";
import { LIVE_SLOTS, liveTotals, parseFunds, parseHoldings, parseOrders, parsePositions, type ConnectionState, type LiveAccount, type LiveView } from "@/lib/multi-account/live";
import type { SessionUser } from "@/server/auth";
import { brokerAccountView } from "@/server/dhan-account";
import { getDhanClientId } from "@/server/settings";
import { liveSwitchOn, staticIpReady } from "@/lib/security/flags";
import { ownsServerAccount, tradesServerAccount } from "@/server/live-gate";
import type { BrokerAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { BrokerError, createDhanClient } from "@/lib/dhan/client";
import { readFunds, readHoldings, readOrders, readPositions } from "@/lib/dhan/funds";
import { encryptionConfigured, fingerprint } from "@/lib/security/crypto";
import { loadAccountCredentials, RELATIONSHIP_LABEL } from "@/server/broker-accounts";

/**
 * Live account view. The broker connection TradeD has is the single server-configured account, shown
 * only to its holder (DHAN_ACCOUNT_OWNER_EMAIL, or the super admin when unset) and to nobody else.
 * Tokens and full client IDs never leave the server. Orders go through server/live-orders, not here.
 */

/** What each family member needs before their slot can trade. */
export const LIVE_MISSING = [
  "The account belongs to you or your family: spouse, dependent child or dependent parent.",
  "The holder creates their own API key in Dhan (web.dhan.co > My Profile > Access DhanHQ APIs) with TradeD's redirect URL, and you save the client id, API key and secret here.",
  "The holder has their own static IP registered as primary in their Dhan account. Dhan requires a unique IP per person; it is an extra Elastic IP on the execution server.",
  "The holder signs in through Dhan once a day (Dhan tokens last 24 hours). TradeD never sees their password or OTP.",
];

function appOrigin(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.APP_URL?.trim() || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://traded-one.vercel.app");
  return raw.replace(/\/+$/, "");
}

function emptySlot(slot: number, message: string): LiveAccount {
  return {
    id: `live-${slot}`,
    target: null,
    family: null,
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
    target: "server",
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

type Reads = { funds: unknown; positions: unknown; holdings: unknown; orders: unknown; authFailed: boolean };

async function readAll(credentials: { clientId: string; accessToken: string }): Promise<Reads> {
  const client = createDhanClient(credentials);
  let authFailed = false;
  const read = async (fn: (c: typeof client) => Promise<unknown>) => {
    try {
      return await fn(client);
    } catch (error) {
      if (error instanceof BrokerError && error.failure === "AUTH_EXPIRED") authFailed = true;
      return { error: error instanceof Error ? error.message : "Account request failed." };
    }
  };
  const [funds, positions, holdings, orders] = await Promise.all([read(readFunds), read(readPositions), read(readHoldings), read(readOrders)]);
  return { funds, positions, holdings, orders, authFailed };
}

/** One family account: broker data from that holder's own token, never from anyone else's. */
async function familyAccount(row: BrokerAccount, now: Date, canTrade: { globalReady: boolean; userReady: boolean }, env: NodeJS.ProcessEnv): Promise<LiveAccount> {
  const info = {
    brokerAccountId: row.id,
    relationship: row.relationship,
    relationshipLabel: RELATIONSHIP_LABEL[row.relationship],
    configured: Boolean(row.maskedClientId),
    staticIp: row.staticIp || null,
    ipConfirmed: Boolean(row.staticIp && row.ipConfirmedAt),
    callbackUrl: `${appOrigin(env)}/api/broker-accounts/callback/${row.id}`,
  };
  const base: LiveAccount = { ...emptySlot(row.slot, ""), id: row.id, target: row.id, family: info, nickname: row.nickname, maskedId: row.maskedClientId || null, tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null };
  if (!info.configured) return { ...base, tradingReason: "Not set up.", message: "Add this holder's Dhan client id, API key and static IP." };
  const credentials = await loadAccountCredentials(row.id).catch(() => null);
  if (!credentials) return { ...base, connection: "AUTH_REQUIRED", tradingReason: "Not signed in through Dhan.", message: `${row.nickname} needs to sign in through Dhan.` };
  if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= now.getTime()) return { ...base, connection: "EXPIRED", authorized: false, tradingReason: "Authorization expired.", message: `${row.nickname}'s Dhan sign-in expired. Sign in through Dhan again.` };
  const reads = await readAll(credentials);
  if (reads.authFailed) return { ...base, connection: "EXPIRED", tradingReason: "Authorization expired.", message: "Dhan rejected this holder's token. Sign in through Dhan again." };
  const funds = parseFunds(reads.funds);
  const { positions, error: positionsError } = parsePositions(reads.positions);
  const { holdings, error: holdingsError } = parseHoldings(reads.holdings);
  const { orders, error: ordersError } = parseOrders(reads.orders);
  const failures = [funds?.error, positionsError, holdingsError, ordersError].filter(Boolean).length;
  const connection: ConnectionState = failures === 4 ? "ERROR" : failures > 0 ? "DATA_UNAVAILABLE" : "CONNECTED";
  const unmet = [
    !canTrade.globalReady ? "live orders are switched off on the server" : "",
    !canTrade.userReady ? "your TradeD user may not trade" : "",
    !info.ipConfirmed ? "this holder's static IP is not confirmed" : "",
    failures === 4 ? "broker reads failed" : "",
  ].filter(Boolean);
  const ready = unmet.length === 0;
  return {
    ...base,
    connection,
    authorized: true,
    lastSyncAt: failures === 4 ? null : now.toISOString(),
    tradingReady: ready,
    tradingReason: ready ? `Ready: orders leave from ${info.staticIp} after you confirm them.` : `Order placement locked: ${unmet.join("; ")}.`,
    message: failures === 4 ? "Every account read failed." : "",
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

async function familyAccounts(user: SessionUser, now: Date, env: NodeJS.ProcessEnv): Promise<LiveAccount[]> {
  if (!encryptionConfigured(env)) return [];
  const serverClient = await getDhanClientId().catch(() => "");
  const serverPrint = serverClient ? fingerprint(serverClient, "broker-client-id", env) : null;
  const rows = await prisma.brokerAccount.findMany({ where: { ownerId: user.id }, orderBy: { slot: "asc" } });
  const canTrade = { globalReady: liveSwitchOn(env) && staticIpReady(env), userReady: user.status === "ACTIVE" && user.tradingEnabled };
  return Promise.all(rows.filter((row) => !serverPrint || row.clientFingerprint !== serverPrint).map((row) => familyAccount(row, now, canTrade, env)));
}

export async function liveAccountsView(user: SessionUser, now = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<LiveView> {
  const owner = ownsServerAccount(user);
  const broker = owner ? await brokerAccountView() : null;
  const gate = liveGate({
    staticIp: staticIpReady(),
    ownAccount: tradesServerAccount(user),
    authorized: Boolean(broker && broker.clientConfigured && broker.token.source !== "missing" && !broker.token.expired),
    switchedOn: liveSwitchOn(),
  });
  const [first, family] = await Promise.all([owner && broker ? serverAccount(now, gate, broker) : Promise.resolve(null), familyAccounts(user, now, env)]);
  const filled = [...(first ? [first] : []), ...family].slice(0, LIVE_SLOTS);
  const slots = Array.from({ length: LIVE_SLOTS }, (_, index) => {
    const account = filled[index];
    return account ? { ...account, slot: index + 1 } : emptySlot(index + 1, "No broker account is connected to this slot.");
  });
  const linked = slots.filter((item) => item.connection === "CONNECTED" || item.connection === "DATA_UNAVAILABLE");
  return {
    accounts: slots,
    capabilities: {
      readFunds: linked.some((item) => item.funds && !item.funds.error),
      readPositions: linked.some((item) => item.positions),
      readOrders: linked.some((item) => item.orders),
      readHoldings: linked.some((item) => item.holdings),
      placeOrders: slots.some((item) => item.tradingReady),
      cancelOrders: slots.some((item) => item.tradingReady),
      connectAccounts: encryptionConfigured(env),
    },
    missing: LIVE_MISSING,
    viewerOwnsConnection: owner,
    gate,
    notice: !owner && family.length === 0
      ? "No broker account is connected to your TradeD user yet."
      : slots.some((item) => item.tradingReady)
        ? "Orders go to Dhan only after you review and confirm them. Each holder's orders leave from that holder's own static IP."
        : "Read-only. Funds, positions and orders are read from Dhan. Order placement stays locked until every live-trading requirement is met.",
    syncedAt: now.toISOString(),
  };
}
