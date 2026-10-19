import type { BrokerAccount, BrokerOrder, BrokerOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { recordAudit } from "@/lib/audit/trail";
import { BrokerError, createDhanClient, type DhanCredentials } from "@/lib/dhan/client";
import { readFunds } from "@/lib/dhan/funds";
import { estimatePaise, FINAL_STATUSES, newCorrelationId, readBrokerOrder, validateIntent, workerOrder, type LiveOrderIntent } from "@/lib/dhan/orders";
import { parseFunds } from "@/lib/multi-account/live";
import { assertOwnsAccount } from "@/lib/security/authorization";
import { liveSwitchOn, staticIpReady } from "@/lib/security/flags";
import { executeLegs } from "@/lib/multi-account/executor";
import { fingerprint } from "@/lib/security/crypto";
import { maskTail } from "@/lib/security/redact";
import type { SessionUser } from "@/server/auth";
import { loadAccountCredentials } from "@/server/broker-accounts";
import { callWorker, ExecutionUncertainError } from "@/server/execution-client";
import { gateFor, tradesServerAccount } from "@/server/live-gate";
import { getDhanAccessToken, getDhanClientId } from "@/server/settings";

/**
 * Live orders for the holder's own server-configured Dhan account.
 * Rules: every order is idempotent per (account, key); one unresolved order per account at a time;
 * the audit record is written before anything is sent; an uncertain outcome becomes UNKNOWN and is
 * reconciled with Dhan by correlation id, never resent.
 */

export type Deps = { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; now?: Date };
export type Ctx = { ip: string | null };

const UNRESOLVED: BrokerOrderStatus[] = ["SUBMITTING", "UNKNOWN"];
const NOT_FOUND_GRACE_MS = 120_000;

export type LiveOrderView = {
  id: string;
  correlationId: string;
  brokerOrderId: string | null;
  symbol: string;
  exchangeSegment: string;
  side: "BUY" | "SELL";
  productType: string;
  orderType: string;
  quantity: number;
  pricePaise: number | null;
  status: BrokerOrderStatus;
  brokerStatus: string;
  filledQuantity: number;
  remainingQuantity: number;
  avgPricePaise: number | null;
  reason: string;
  createdAt: string;
  submittedAt: string | null;
  final: boolean;
};

function toView(row: BrokerOrder): LiveOrderView {
  return {
    id: row.id,
    correlationId: row.correlationId,
    brokerOrderId: row.brokerOrderId,
    symbol: row.symbol,
    exchangeSegment: row.exchangeSegment,
    side: row.side,
    productType: row.productType,
    orderType: row.orderType,
    quantity: row.quantity,
    pricePaise: row.pricePaise == null ? null : Number(row.pricePaise),
    status: row.status,
    brokerStatus: row.brokerStatus,
    filledQuantity: row.filledQuantity,
    remainingQuantity: row.remainingQuantity,
    avgPricePaise: row.avgPricePaise == null ? null : Number(row.avgPricePaise),
    reason: row.rejectReason,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    final: FINAL_STATUSES.has(row.status),
  };
}

async function serverCredentials(): Promise<DhanCredentials> {
  const clientId = await getDhanClientId();
  if (!clientId) throw new AppError("The Dhan client id is not set.", 503, "BROKER_NOT_CONFIGURED");
  return { clientId, accessToken: await getDhanAccessToken() };
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/** The BrokerAccount row for the server Dhan account, created for its holder on first use. */
export async function ensureServerAccount(user: SessionUser, env: NodeJS.ProcessEnv = process.env) {
  if (!tradesServerAccount(user, env)) throw new AppError("Broker account not found.", 404, "ACCOUNT_NOT_FOUND");
  const clientId = await getDhanClientId();
  if (!clientId) throw new AppError("The Dhan client id is not set.", 503, "BROKER_NOT_CONFIGURED");
  const print = fingerprint(clientId, "broker-client-id", env);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await prisma.brokerAccount.findUnique({ where: { clientFingerprint: print } });
    if (existing) return assertOwnsAccount(user, existing);
    const used = new Set((await prisma.brokerAccount.findMany({ where: { ownerId: user.id }, select: { slot: true } })).map((item) => item.slot));
    const slot = [1, 2, 3, 4, 5, 6, 7, 8].find((item) => !used.has(item));
    if (!slot) throw new AppError("All eight account slots are in use. Remove one to link your Dhan account.", 409, "ACCOUNT_LIMIT");
    try {
      return await prisma.brokerAccount.create({
        data: { ownerId: user.id, slot, nickname: "My Dhan account", relationship: "SELF", maskedClientId: maskTail(clientId), clientFingerprint: print, connection: "CONNECTED", authorizedAt: new Date() },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new AppError("The account was linked at the same time by another request. Try again.", 409, "ACCOUNT_BUSY");
}

function locked(unmet: string[]): never {
  throw new AppError("Live orders are locked for this account.", 403, "LIVE_LOCKED", { details: { unmet } });
}

export type Target = { account: BrokerAccount; credentials: DhanCredentials; server: boolean };

function isServerAccount(account: Pick<BrokerAccount, "clientFingerprint">, serverClientId: string, env: NodeJS.ProcessEnv) {
  return Boolean(serverClientId && account.clientFingerprint && account.clientFingerprint === fingerprint(serverClientId, "broker-client-id", env));
}

/**
 * Resolves where an order may go and with which credentials. "server" is the holder's own server-configured
 * Dhan account; anything else is a family BrokerAccount the user owns, which must be connected through
 * Dhan's consent login and have its own registered static IP.
 */
export async function resolveTarget(user: SessionUser, accountId: string, env: NodeJS.ProcessEnv = process.env): Promise<Target> {
  if (accountId === "server") {
    const gate = await gateFor(user, env);
    if (!gate.enabled) locked(gate.requirements.filter((item) => !item.met).map((item) => item.label));
    return { account: await ensureServerAccount(user, env), credentials: await serverCredentials(), server: true };
  }
  const account = assertOwnsAccount(user, await prisma.brokerAccount.findUnique({ where: { id: accountId } }));
  if (isServerAccount(account, await getDhanClientId(), env)) return resolveTarget(user, "server", env);
  const unmet: string[] = [];
  if (!liveSwitchOn(env)) unmet.push("Live orders switched on by the operator");
  if (!staticIpReady(env)) unmet.push("Execution server configured");
  if (user.status !== "ACTIVE" || !user.tradingEnabled) unmet.push("Your TradeD user may trade");
  if (!account.staticIp || !account.ipConfirmedAt) unmet.push("This holder's static IP is registered with Dhan");
  if (account.connection !== "CONNECTED" || !account.tokenExpiresAt || account.tokenExpiresAt.getTime() <= Date.now()) unmet.push("This holder signed in through Dhan today");
  const credentials = unmet.length ? null : await loadAccountCredentials(account.id);
  if (!credentials) locked(unmet.length ? unmet : ["This holder signed in through Dhan today"]);
  return { account, credentials, server: false };
}

async function credentialsForAccount(account: BrokerAccount, env: NodeJS.ProcessEnv): Promise<DhanCredentials> {
  if (isServerAccount(account, await getDhanClientId(), env)) return serverCredentials();
  const credentials = await loadAccountCredentials(account.id);
  if (!credentials) throw new AppError("This account is not connected. Sign in through Dhan again to check its orders.", 409, "ACCOUNT_NOT_CONNECTED");
  return credentials;
}

async function checkIntent(intent: LiveOrderIntent, credentials: DhanCredentials | null, deps: Deps) {
  const problems = validateIntent(intent);
  const estimate = estimatePaise(intent);
  let availablePaise: number | null = null;
  let fundsError: string | null = null;
  if (credentials) {
    try {
      const funds = parseFunds(await readFunds(createDhanClient(credentials, { fetch: deps.fetch })));
      availablePaise = funds?.availablePaise ?? null;
      fundsError = funds?.error ?? null;
    } catch (error) {
      fundsError = error instanceof Error ? error.message : "Funds could not be read.";
    }
  }
  if (intent.side === "BUY" && estimate != null && availablePaise != null && estimate > availablePaise) problems.push("Estimated value is above the available funds reported by Dhan.");
  return { problems, estimatePaise: estimate, availablePaise, fundsError };
}

/** Validation, value estimate and funds check for the server account. Sends nothing. */
export async function previewLiveOrder(user: SessionUser, intent: LiveOrderIntent, deps: Deps = {}) {
  const env = deps.env ?? process.env;
  const gate = await gateFor(user, env);
  const checked = await checkIntent(intent, tradesServerAccount(user, env) ? await serverCredentials().catch(() => null) : null, deps);
  return { ...checked, gate, eligible: gate.enabled && checked.problems.length === 0 };
}

export async function placeLiveOrder(user: SessionUser, input: { key: string; intent: LiveOrderIntent; accountId?: string }, ctx: Ctx, deps: Deps = {}) {
  const env = deps.env ?? process.env;
  const target = await resolveTarget(user, input.accountId ?? "server", env);
  const preview = await checkIntent(input.intent, target.credentials, deps);
  const account = target.account;

  const already = await prisma.brokerOrder.findUnique({ where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: input.key } } });
  if (already) return { order: toView(already), duplicate: true };
  if (preview.problems.length) throw new AppError(preview.problems[0] ?? "The order is not valid.", 400, "INVALID_ORDER", { details: { problems: preview.problems } });

  const intent = input.intent;
  const correlationId = newCorrelationId();
  let row: BrokerOrder;
  try {
    row = await prisma.$transaction(async (tx) => {
      // Serialises order creation per account across concurrent requests and server instances.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${account.id}))`;
      const open = await tx.brokerOrder.count({ where: { accountId: account.id, mode: "LIVE", status: { in: UNRESOLVED } } });
      if (open > 0) throw new AppError("An earlier order on this account has an unconfirmed outcome. Refresh its status before placing another.", 409, "ORDER_UNRESOLVED");
      return tx.brokerOrder.create({
        data: {
          accountId: account.id, userId: user.id, mode: "LIVE", idempotencyKey: input.key, correlationId,
          exchangeSegment: intent.exchangeSegment, securityId: intent.securityId, symbol: intent.symbol, productType: intent.productType,
          side: intent.side, orderType: intent.orderType, quantity: intent.quantity,
          pricePaise: intent.pricePaise == null ? null : BigInt(intent.pricePaise), status: "SUBMITTING", remainingQuantity: intent.quantity,
        },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await prisma.brokerOrder.findUnique({ where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: input.key } } });
      if (existing) return { order: toView(existing), duplicate: true };
    }
    throw error;
  }

  const auditDetail = { orderId: row.id, symbol: intent.symbol, side: intent.side, quantity: intent.quantity, orderType: intent.orderType, productType: intent.productType, pricePaise: intent.pricePaise, estimatePaise: preview.estimatePaise };
  try {
    await recordAudit({ userId: user.id, accountId: account.id, action: "live.order.submit", correlationId, outcome: "SUCCESS", detail: auditDetail, ip: ctx.ip }, { required: true });
  } catch (error) {
    await prisma.brokerOrder.update({ where: { id: row.id }, data: { status: "REJECTED", rejectReason: "Not sent: the audit record could not be saved." } });
    throw error;
  }

  let update: Partial<BrokerOrder>;
  try {
    const result = await callWorker("/v1/orders/place", { credentials: target.credentials, order: workerOrder(intent, correlationId) }, { env, fetch: deps.fetch });
    if (result.outcome === "ACCEPTED") {
      const mapped = readBrokerOrder({ orderId: result.orderId, orderStatus: result.orderStatus });
      update = { brokerOrderId: result.orderId, status: mapped && mapped.status !== "UNKNOWN" ? mapped.status : "PENDING", brokerStatus: result.orderStatus, submittedAt: new Date() };
    } else if (result.outcome === "REJECTED") {
      update = { status: "REJECTED", rejectReason: result.message, submittedAt: new Date() };
    } else {
      update = { status: "UNKNOWN", rejectReason: result.message, submittedAt: new Date() };
    }
  } catch (error) {
    if (error instanceof ExecutionUncertainError) update = { status: "UNKNOWN", rejectReason: error.message, submittedAt: new Date() };
    else if (error instanceof AppError && (error.code === "EXECUTION_REFUSED" || error.code === "EXECUTION_NOT_CONFIGURED" || error.code === "BROKER_NOT_CONFIGURED")) update = { status: "REJECTED", rejectReason: error.message };
    else update = { status: "UNKNOWN", rejectReason: "The order outcome could not be confirmed. Refresh its status." };
  }
  const saved = await prisma.brokerOrder.update({ where: { id: row.id }, data: update });
  await recordAudit({ userId: user.id, accountId: account.id, action: "live.order.result", correlationId, outcome: saved.status === "REJECTED" ? "FAILURE" : "SUCCESS", detail: { orderId: row.id, status: saved.status, brokerOrderId: saved.brokerOrderId, reason: saved.rejectReason }, ip: ctx.ip });
  return { order: toView(saved), duplicate: false };
}

async function ownedOrder(user: SessionUser, orderId: string) {
  const row = await prisma.brokerOrder.findUnique({ where: { id: orderId }, include: { account: true } });
  if (!row) throw new AppError("Order not found.", 404, "ORDER_NOT_FOUND");
  assertOwnsAccount(user, row.account);
  return row;
}

/** Brings one order in line with Dhan. Reads need no static IP, so this calls Dhan directly. */
export async function reconcileLiveOrder(user: SessionUser, orderId: string, ctx: Ctx, deps: Deps = {}) {
  const row = await ownedOrder(user, orderId);
  if (FINAL_STATUSES.has(row.status) && row.brokerOrderId) return { order: toView(row), changed: false };
  if (row.status === "REJECTED" && !row.brokerOrderId) return { order: toView(row), changed: false };
  const now = deps.now ?? new Date();
  const client = createDhanClient(await credentialsForAccount(row.account, deps.env ?? process.env), { fetch: deps.fetch });
  let broker: ReturnType<typeof readBrokerOrder> = null;
  try {
    broker = readBrokerOrder(row.brokerOrderId ? await client.get(`/orders/${encodeURIComponent(row.brokerOrderId)}`) : await client.get(`/orders/external/${encodeURIComponent(row.correlationId)}`));
  } catch (error) {
    if (!(error instanceof BrokerError) || error.failure === "AUTH_EXPIRED" || error.failure === "NETWORK" || error.failure === "TIMEOUT" || error.failure === "RATE_LIMITED") throw error;
    // Other broker errors on a lookup mean "no such order".
  }
  let data: Partial<BrokerOrder>;
  if (broker) {
    data = {
      brokerOrderId: broker.orderId,
      status: broker.status,
      brokerStatus: broker.brokerStatus,
      ...(broker.filledQuantity != null ? { filledQuantity: broker.filledQuantity } : {}),
      ...(broker.remainingQuantity != null ? { remainingQuantity: broker.remainingQuantity } : {}),
      ...(broker.avgPricePaise != null ? { avgPricePaise: BigInt(broker.avgPricePaise) } : {}),
      ...(broker.status === "REJECTED" ? { rejectReason: broker.reason || row.rejectReason } : {}),
    };
  } else if (!row.brokerOrderId && now.getTime() - (row.submittedAt ?? row.createdAt).getTime() > NOT_FOUND_GRACE_MS) {
    data = { status: "REJECTED", rejectReason: "Dhan has no record of this order, so it was not placed." };
  } else {
    return { order: toView(row), changed: false, message: "Dhan has no record of this order yet. Check again in a minute." };
  }
  const saved = await prisma.brokerOrder.update({ where: { id: row.id }, data });
  if (saved.status !== row.status) {
    await recordAudit({ userId: user.id, accountId: row.accountId, action: "live.order.reconcile", correlationId: row.correlationId, outcome: "SUCCESS", detail: { orderId: row.id, from: row.status, to: saved.status }, ip: ctx.ip });
  }
  return { order: toView(saved), changed: saved.status !== row.status };
}

export async function cancelLiveOrder(user: SessionUser, orderId: string, ctx: Ctx, deps: Deps = {}) {
  const env = deps.env ?? process.env;
  const row = await ownedOrder(user, orderId);
  const target = await resolveTarget(user, row.accountId, env);
  if (!row.brokerOrderId || (row.status !== "PENDING" && row.status !== "PARTIAL")) throw new AppError("Only an open order can be cancelled.", 409, "ORDER_NOT_OPEN");
  await recordAudit({ userId: user.id, accountId: row.accountId, action: "live.order.cancel", correlationId: row.correlationId, outcome: "SUCCESS", detail: { orderId: row.id, brokerOrderId: row.brokerOrderId }, ip: ctx.ip }, { required: true });
  let message: string | undefined;
  try {
    const result = await callWorker("/v1/orders/cancel", { credentials: target.credentials, orderId: row.brokerOrderId }, { env, fetch: deps.fetch });
    if (result.outcome === "REJECTED") throw new AppError(`Dhan refused the cancellation: ${result.message}`, 409, "CANCEL_REJECTED");
    if (result.outcome === "UNKNOWN") message = result.message;
  } catch (error) {
    if (!(error instanceof ExecutionUncertainError)) throw error;
    message = error.message;
  }
  const reconciled = await reconcileLiveOrder(user, orderId, ctx, deps);
  return { ...reconciled, message };
}

export async function listLiveOrders(user: SessionUser) {
  const accounts = await prisma.brokerAccount.findMany({ where: { ownerId: user.id }, select: { id: true } });
  if (accounts.length === 0) return [];
  const rows = await prisma.brokerOrder.findMany({ where: { accountId: { in: accounts.map((item) => item.id) }, mode: "LIVE" }, orderBy: { createdAt: "desc" }, take: 30 });
  return rows.map(toView);
}

export type LegResult = { accountId: string; ok: boolean; order?: LiveOrderView; duplicate?: boolean; error?: { message: string; code: string } };

/**
 * Places the same contract on several accounts, each with its own quantity. Every leg settles on its own:
 * one account's rejection or uncertainty never cancels, retries or changes another. Not atomic across accounts.
 */
export async function placeLiveOrders(user: SessionUser, input: { key: string; intent: Omit<LiveOrderIntent, "quantity">; legs: Array<{ accountId: string; quantity: number }> }, ctx: Ctx, deps: Deps = {}): Promise<LegResult[]> {
  const ids = new Set(input.legs.map((leg) => leg.accountId));
  if (ids.size !== input.legs.length) throw new AppError("Each account can appear once per order.", 400, "DUPLICATE_ACCOUNT");
  const settled = await executeLegs(input.legs, (leg) => placeLiveOrder(user, { key: input.key, accountId: leg.accountId, intent: { ...input.intent, quantity: leg.quantity } }, ctx, deps));
  return settled.map((item, index) => {
    const accountId = input.legs[index]!.accountId;
    if (item.status === "fulfilled") return { accountId, ok: item.value.order.status !== "REJECTED", order: item.value.order, duplicate: item.value.duplicate };
    const error = item.reason instanceof AppError ? { message: item.reason.message, code: item.reason.code } : { message: "The order could not be placed.", code: "INTERNAL" };
    return { accountId, ok: false, error };
  });
}
