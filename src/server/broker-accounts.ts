import type { AccountRelationship, BrokerAccount, BrokerConnection } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { newCorrelationId, recordAudit } from "@/lib/audit/trail";
import { BrokerError, createDhanClient, tokenExpiry, type DhanClientOptions, type DhanCredentials } from "@/lib/dhan/client";
import { readProfile } from "@/lib/dhan/funds";
import { decryptSecret, encryptSecret, fingerprint } from "@/lib/security/crypto";
import { assertMayManageBrokerAccounts, assertOwnsAccount } from "@/lib/security/authorization";
import { maskTail } from "@/lib/security/redact";
import type { SessionUser } from "@/server/auth";

/**
 * Broker accounts owned by a TradeD user. Every function takes the session user and checks ownership
 * itself, so a route cannot forget to. Credentials are decrypted only inside this module and are
 * never returned to callers outside the server.
 */

export const MAX_BROKER_ACCOUNTS = 8;

export const RELATIONSHIP_LABEL: Record<AccountRelationship, string> = {
  SELF: "Self",
  SPOUSE: "Spouse",
  DEPENDENT_CHILD: "Dependent child",
  DEPENDENT_PARENT: "Dependent parent",
};

export type Ctx = { ip: string | null; now?: Date };

export type BrokerAccountView = {
  id: string;
  slot: number;
  broker: string;
  nickname: string;
  relationship: AccountRelationship;
  relationshipLabel: string;
  maskedClientId: string | null;
  connection: BrokerConnection;
  hasCredential: boolean;
  authorizedAt: string | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean;
  lastConnectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

type Row = BrokerAccount & { credential?: { accountId: string } | null };

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function toView(row: Row, now = new Date()): BrokerAccountView {
  const tokenExpired = row.tokenExpiresAt != null && row.tokenExpiresAt.getTime() <= now.getTime();
  return {
    id: row.id,
    slot: row.slot,
    broker: row.broker,
    nickname: row.nickname,
    relationship: row.relationship,
    relationshipLabel: RELATIONSHIP_LABEL[row.relationship],
    maskedClientId: row.maskedClientId || null,
    // A stored CONNECTED never outlives its token.
    connection: row.connection === "CONNECTED" && tokenExpired ? "EXPIRED" : row.connection,
    hasCredential: Boolean(row.credential),
    authorizedAt: iso(row.authorizedAt),
    tokenExpiresAt: iso(row.tokenExpiresAt),
    tokenExpired,
    lastConnectedAt: iso(row.lastConnectedAt),
    lastSyncAt: iso(row.lastSyncAt),
    lastError: row.lastError || null,
    lastErrorAt: iso(row.lastErrorAt),
  };
}

const credentialContext = (accountId: string) => `broker-account:${accountId}`;

async function ownedAccount(user: SessionUser, accountId: string): Promise<Row> {
  const row = await prisma.brokerAccount.findUnique({ where: { id: accountId }, include: { credential: { select: { accountId: true } } } });
  return assertOwnsAccount(user, row);
}

export async function listBrokerAccounts(user: SessionUser, now = new Date()): Promise<BrokerAccountView[]> {
  const rows = await prisma.brokerAccount.findMany({
    where: { ownerId: user.id },
    include: { credential: { select: { accountId: true } } },
    orderBy: { slot: "asc" },
  });
  return rows.map((row) => toView(row, now));
}

export async function getBrokerAccount(user: SessionUser, accountId: string, now = new Date()) {
  return toView(await ownedAccount(user, accountId), now);
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

export async function createBrokerAccount(user: SessionUser, input: { nickname: string; relationship: AccountRelationship }, ctx: Ctx) {
  assertMayManageBrokerAccounts(user);
  const correlationId = newCorrelationId();
  const taken = await prisma.brokerAccount.findMany({ where: { ownerId: user.id }, select: { slot: true } });
  if (taken.length >= MAX_BROKER_ACCOUNTS) throw new AppError(`You can add up to ${MAX_BROKER_ACCOUNTS} broker accounts.`, 409, "ACCOUNT_LIMIT");
  const used = new Set(taken.map((item) => item.slot));
  const slot = Array.from({ length: MAX_BROKER_ACCOUNTS }, (_, index) => index + 1).find((item) => !used.has(item)) ?? 0;
  let row: Row;
  try {
    row = await prisma.brokerAccount.create({ data: { ownerId: user.id, slot, nickname: input.nickname.trim(), relationship: input.relationship } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("Another account was added at the same time. Refresh and try again.", 409, "ACCOUNT_BUSY");
    throw error;
  }
  await recordAudit({ userId: user.id, accountId: row.id, action: "broker.account.create", correlationId, outcome: "SUCCESS", detail: { slot, relationship: input.relationship }, ip: ctx.ip });
  return toView(row, ctx.now);
}

export async function updateBrokerAccount(user: SessionUser, accountId: string, input: { nickname?: string; relationship?: AccountRelationship }, ctx: Ctx) {
  assertMayManageBrokerAccounts(user);
  await ownedAccount(user, accountId);
  const row = await prisma.brokerAccount.update({
    where: { id: accountId },
    data: { ...(input.nickname !== undefined ? { nickname: input.nickname.trim() } : {}), ...(input.relationship ? { relationship: input.relationship } : {}) },
    include: { credential: { select: { accountId: true } } },
  });
  await recordAudit({ userId: user.id, accountId, action: "broker.account.update", correlationId: newCorrelationId(), outcome: "SUCCESS", detail: input, ip: ctx.ip });
  return toView(row, ctx.now);
}

/** Forgets the credential. The account row stays so its history and orders remain readable. */
export async function disconnectBrokerAccount(user: SessionUser, accountId: string, ctx: Ctx) {
  assertMayManageBrokerAccounts(user);
  await ownedAccount(user, accountId);
  const correlationId = newCorrelationId();
  await recordAudit({ userId: user.id, accountId, action: "broker.account.disconnect", correlationId, outcome: "SUCCESS", ip: ctx.ip }, { required: true });
  const [, row] = await prisma.$transaction([
    prisma.brokerCredential.deleteMany({ where: { accountId } }),
    prisma.brokerAccount.update({
      where: { id: accountId },
      data: { connection: "NOT_CONNECTED", clientFingerprint: null, authorizedAt: null, tokenExpiresAt: null, lastError: "", lastErrorAt: null },
      include: { credential: { select: { accountId: true } } },
    }),
  ]);
  return toView(row, ctx.now);
}

const OPEN_LIVE = ["SUBMITTING", "PENDING", "PARTIAL", "UNKNOWN"] as const;

export async function removeBrokerAccount(user: SessionUser, accountId: string, ctx: Ctx) {
  assertMayManageBrokerAccounts(user);
  await ownedAccount(user, accountId);
  const open = await prisma.brokerOrder.count({ where: { accountId, mode: "LIVE", status: { in: [...OPEN_LIVE] } } });
  if (open > 0) throw new AppError("This account has live orders that are open or unconfirmed. Resolve them before removing it.", 409, "ACCOUNT_HAS_OPEN_ORDERS");
  await recordAudit({ userId: user.id, accountId, action: "broker.account.remove", correlationId: newCorrelationId(), outcome: "SUCCESS", ip: ctx.ip }, { required: true });
  await prisma.brokerAccount.delete({ where: { id: accountId } });
  return { removed: true as const };
}

/**
 * Saves a credential obtained from the broker's own authorization flow. Server-internal only: no route
 * accepts a token typed by a user. The account stays AUTH_REQUIRED until validateBrokerConnection succeeds.
 */
export async function storeCredential(user: SessionUser, accountId: string, credentials: DhanCredentials & { expiresAt?: Date | null }, ctx: Ctx) {
  assertMayManageBrokerAccounts(user);
  await ownedAccount(user, accountId);
  if (!/^\d{4,20}$/.test(credentials.clientId)) throw new AppError("The broker returned an invalid client id.", 502, "BROKER_CLIENT_INVALID");
  const { envelope, keyId } = encryptSecret(JSON.stringify({ clientId: credentials.clientId, accessToken: credentials.accessToken }), credentialContext(accountId));
  const expiresAt = credentials.expiresAt ?? tokenExpiry(credentials.accessToken);
  const print = fingerprint(credentials.clientId, "broker-client-id");
  const correlationId = newCorrelationId();
  try {
    await prisma.$transaction([
      prisma.brokerAccount.update({
        where: { id: accountId },
        data: { clientFingerprint: print, maskedClientId: maskTail(credentials.clientId), connection: "AUTH_REQUIRED", authorizedAt: ctx.now ?? new Date(), tokenExpiresAt: expiresAt, lastError: "", lastErrorAt: null },
      }),
      prisma.brokerCredential.upsert({
        where: { accountId },
        create: { accountId, ciphertext: envelope, keyId, expiresAt },
        update: { ciphertext: envelope, keyId, expiresAt },
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      await recordAudit({ userId: user.id, accountId, action: "broker.credential.store", correlationId, outcome: "DENIED", detail: { reason: "client already linked" }, ip: ctx.ip });
      throw new AppError("This broker account is already linked in TradeD.", 409, "BROKER_ALREADY_LINKED");
    }
    throw error;
  }
  await recordAudit({ userId: user.id, accountId, action: "broker.credential.store", correlationId, outcome: "SUCCESS", detail: { keyId, expiresAt }, ip: ctx.ip }, { required: true });
}

/** Decrypts an account's credential. Callers must already have checked ownership. */
async function loadCredential(accountId: string): Promise<DhanCredentials | null> {
  const row = await prisma.brokerCredential.findUnique({ where: { accountId } });
  if (!row) return null;
  const parsed = JSON.parse(decryptSecret(row.ciphertext, credentialContext(accountId))) as Partial<DhanCredentials>;
  if (typeof parsed.clientId !== "string" || typeof parsed.accessToken !== "string") throw new AppError("Stored credential could not be read.", 500, "CREDENTIAL_UNREADABLE");
  return { clientId: parsed.clientId, accessToken: parsed.accessToken };
}

/** A broker client for one owned account, or an error explaining why the account cannot be used. */
export async function brokerClientFor(user: SessionUser, accountId: string, options: DhanClientOptions & { now?: Date } = {}) {
  const account = await ownedAccount(user, accountId);
  const now = options.now ?? new Date();
  if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() <= now.getTime()) throw new AppError("This account's authorization has expired. Reconnect it.", 409, "ACCOUNT_EXPIRED");
  const credentials = await loadCredential(accountId);
  if (!credentials) throw new AppError("This account is not connected.", 409, "ACCOUNT_NOT_CONNECTED");
  return createDhanClient(credentials, options);
}

/**
 * Confirms the stored credential with the broker. CONNECTED is written only after the broker answers
 * for the same client id; auth failures become EXPIRED and anything else becomes ERROR.
 */
export async function validateBrokerConnection(user: SessionUser, accountId: string, ctx: Ctx, options: DhanClientOptions = {}) {
  const account = await ownedAccount(user, accountId);
  const now = ctx.now ?? new Date();
  const correlationId = newCorrelationId();
  const save = async (connection: BrokerConnection, extra: Partial<BrokerAccount> = {}) => {
    const row = await prisma.brokerAccount.update({ where: { id: accountId }, data: { connection, ...extra }, include: { credential: { select: { accountId: true } } } });
    return toView(row, now);
  };
  const credentials = await loadCredential(accountId);
  if (!credentials) return save("NOT_CONNECTED");
  if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() <= now.getTime()) {
    return save("EXPIRED", { lastError: "Authorization expired.", lastErrorAt: now });
  }
  try {
    const profile = await readProfile(createDhanClient(credentials, options));
    if (profile?.dhanClientId && profile.dhanClientId !== credentials.clientId) {
      await recordAudit({ userId: user.id, accountId, action: "broker.connection.validate", correlationId, outcome: "FAILURE", detail: { reason: "client mismatch" }, ip: ctx.ip });
      return save("ERROR", { lastError: "The broker answered for a different client id.", lastErrorAt: now });
    }
    await recordAudit({ userId: user.id, accountId, action: "broker.connection.validate", correlationId, outcome: "SUCCESS", ip: ctx.ip });
    return save("CONNECTED", { lastConnectedAt: now, lastSyncAt: now, lastError: "", lastErrorAt: null });
  } catch (error) {
    const broker = error instanceof BrokerError ? error : null;
    await recordAudit({ userId: user.id, accountId, action: "broker.connection.validate", correlationId, outcome: "FAILURE", detail: { failure: broker?.failure ?? "UNKNOWN", brokerCode: broker?.brokerCode ?? null }, ip: ctx.ip });
    const message = broker ? broker.message : "The broker connection could not be checked.";
    return save(broker?.failure === "AUTH_EXPIRED" ? "EXPIRED" : "ERROR", { lastError: message, lastErrorAt: now });
  }
}
