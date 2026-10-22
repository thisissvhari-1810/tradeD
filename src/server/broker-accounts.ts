import type { AccountRelationship, BrokerAccount, BrokerConnection } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { newCorrelationId, recordAudit } from "@/lib/audit/trail";
import { BrokerError, createDhanClient, tokenExpiry, type DhanClientOptions, type DhanCredentials } from "@/lib/dhan/client";
import { consentLoginUrl, consumeConsent, generateConsent } from "@/lib/dhan/consent";
import { readProfile } from "@/lib/dhan/funds";
import { decryptSecret, encryptSecret, fingerprint } from "@/lib/security/crypto";
import { assertMayManageBrokerAccounts, assertOwnsAccount } from "@/lib/security/authorization";
import { maskTail } from "@/lib/security/redact";
import type { SessionUser } from "@/server/auth";
import { getDhanClientId, saveMarketConnection } from "@/server/settings";

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
  staticIp: string | null;
  ipConfirmed: boolean;
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
    staticIp: row.staticIp || null,
    ipConfirmed: Boolean(row.staticIp && row.ipConfirmedAt),
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

/** What the encrypted envelope holds. The API key/secret are the holder's own Dhan app credentials. */
type Envelope = { clientId: string; appId?: string; appSecret?: string; accessToken?: string };

async function readEnvelope(accountId: string): Promise<Envelope | null> {
  const row = await prisma.brokerCredential.findUnique({ where: { accountId } });
  if (!row) return null;
  const parsed = JSON.parse(decryptSecret(row.ciphertext, credentialContext(accountId))) as Partial<Envelope>;
  if (typeof parsed.clientId !== "string") throw new AppError("Stored credential could not be read.", 500, "CREDENTIAL_UNREADABLE");
  return {
    clientId: parsed.clientId,
    ...(typeof parsed.appId === "string" ? { appId: parsed.appId } : {}),
    ...(typeof parsed.appSecret === "string" ? { appSecret: parsed.appSecret } : {}),
    ...(typeof parsed.accessToken === "string" ? { accessToken: parsed.accessToken } : {}),
  };
}

function sealEnvelope(accountId: string, envelope: Envelope) {
  return encryptSecret(JSON.stringify(envelope), credentialContext(accountId));
}

/**
 * Saves an access token obtained from the broker's own authorization flow. Server-internal only: no route
 * accepts a token typed by a user. The account stays AUTH_REQUIRED until validateBrokerConnection succeeds.
 */
export async function storeCredential(user: SessionUser, accountId: string, credentials: DhanCredentials & { expiresAt?: Date | null }, ctx: Ctx) {
  assertMayManageBrokerAccounts(user);
  await ownedAccount(user, accountId);
  await saveToken(user.id, accountId, credentials, ctx);
}

async function saveToken(ownerId: string, accountId: string, credentials: DhanCredentials & { expiresAt?: Date | null }, ctx: Ctx) {
  if (!/^\d{4,20}$/.test(credentials.clientId)) throw new AppError("The broker returned an invalid client id.", 502, "BROKER_CLIENT_INVALID");
  const previous = await readEnvelope(accountId).catch(() => null);
  const keep = previous && previous.clientId === credentials.clientId ? { appId: previous.appId, appSecret: previous.appSecret } : {};
  const { envelope, keyId } = sealEnvelope(accountId, { clientId: credentials.clientId, ...keep, accessToken: credentials.accessToken });
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
      await recordAudit({ userId: ownerId, accountId, action: "broker.credential.store", correlationId, outcome: "DENIED", detail: { reason: "client already linked" }, ip: ctx.ip });
      throw new AppError("This broker account is already linked in TradeD.", 409, "BROKER_ALREADY_LINKED");
    }
    throw error;
  }
  await recordAudit({ userId: ownerId, accountId, action: "broker.credential.store", correlationId, outcome: "SUCCESS", detail: { keyId, expiresAt }, ip: ctx.ip }, { required: true });
}

/** True when this row is the server-configured account (the owner's own Dhan account that also feeds market data). */
export async function isServerRow(account: Pick<BrokerAccount, "clientFingerprint">, env: NodeJS.ProcessEnv = process.env) {
  const serverClient = await getDhanClientId().catch(() => "");
  return Boolean(serverClient && account.clientFingerprint && account.clientFingerprint === fingerprint(serverClient, "broker-client-id", env));
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export type ConfigureInput = { clientId: string; appId: string; appSecret?: string; staticIp: string; ipConfirmed: boolean };

/**
 * Stores a family member's Dhan client id, their own API key/secret (encrypted) and the static IP registered
 * for them. Dhan requires a unique static IP per individual, so an IP already used by another account is refused.
 */
export async function configureBrokerAccount(user: SessionUser, accountId: string, input: ConfigureInput, ctx: Ctx, env: NodeJS.ProcessEnv = process.env) {
  assertMayManageBrokerAccounts(user);
  const account = await ownedAccount(user, accountId);
  // The owner's own server account keeps its client id and the execution server's primary IP.
  const self = await isServerRow(account, env);
  const clientId = self ? await getDhanClientId() : input.clientId.trim();
  const appId = input.appId.trim();
  const staticIp = self ? (env.DHAN_STATIC_IP ?? "").trim() : input.staticIp.trim();
  if (!/^\d{4,20}$/.test(clientId)) throw new AppError("Dhan client id must be 4 to 20 digits.", 400, "INVALID_INPUT", { field: "clientId" });
  if (!/^[\x21-\x7e]{4,200}$/.test(appId)) throw new AppError("Paste the API key exactly as Dhan shows it.", 400, "INVALID_INPUT", { field: "appId" });
  if (!IPV4.test(staticIp)) throw new AppError("Enter the public static IP (for example 13.49.97.101).", 400, "INVALID_INPUT", { field: "staticIp" });
  if (!self) {
    if (staticIp === (env.DHAN_STATIC_IP ?? "").trim()) throw new AppError("That IP is registered for the primary account. Dhan needs a different static IP for each person.", 409, "STATIC_IP_IN_USE", { field: "staticIp" });
    const others = await prisma.brokerAccount.findMany({ where: { ownerId: user.id }, select: { id: true, staticIp: true } });
    if (others.some((item) => item.id !== accountId && item.staticIp === staticIp)) throw new AppError("Another account already uses that IP. Dhan needs a different static IP for each person.", 409, "STATIC_IP_IN_USE", { field: "staticIp" });
  }
  if (self) input = { ...input, ipConfirmed: true };

  const previous = await readEnvelope(accountId).catch(() => null);
  const appSecret = input.appSecret?.trim() || (previous && previous.appId === appId ? previous.appSecret : undefined);
  if (!appSecret || !/^[\x21-\x7e]{4,400}$/.test(appSecret)) throw new AppError("Paste the API secret.", 400, "INVALID_INPUT", { field: "appSecret" });
  const sameLogin = previous && previous.clientId === clientId && previous.appId === appId && previous.accessToken;
  const envelope: Envelope = { clientId, appId, appSecret, ...(sameLogin ? { accessToken: previous.accessToken } : {}) };
  const { envelope: sealed, keyId } = sealEnvelope(accountId, envelope);
  const print = fingerprint(clientId, "broker-client-id", env);
  try {
    await prisma.$transaction([
      prisma.brokerAccount.update({
        where: { id: accountId },
        data: {
          clientFingerprint: print,
          maskedClientId: maskTail(clientId),
          staticIp,
          ipConfirmedAt: input.ipConfirmed ? (account.staticIp === staticIp && account.ipConfirmedAt ? account.ipConfirmedAt : ctx.now ?? new Date()) : null,
          ...(sameLogin ? {} : { connection: "AUTH_REQUIRED" as const, tokenExpiresAt: null, authorizedAt: null }),
        },
      }),
      prisma.brokerCredential.upsert({ where: { accountId }, create: { accountId, ciphertext: sealed, keyId, expiresAt: null }, update: { ciphertext: sealed, keyId, ...(sameLogin ? {} : { expiresAt: null }) } }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("This Dhan account is already linked in TradeD.", 409, "BROKER_ALREADY_LINKED", { field: "clientId" });
    throw error;
  }
  await recordAudit({ userId: user.id, accountId, action: "broker.account.configure", correlationId: newCorrelationId(), outcome: "SUCCESS", detail: { staticIp, ipConfirmed: input.ipConfirmed, keyId }, ip: ctx.ip }, { required: true });
  return getBrokerAccount(user, accountId, ctx.now);
}

const CONSENT_MINUTES = 10;

/** Starts Dhan's consent login for one account and returns the Dhan page the holder must open. */
export async function startBrokerConsent(user: SessionUser, accountId: string, ctx: Ctx, deps: { fetch?: typeof fetch } = {}) {
  assertMayManageBrokerAccounts(user);
  await ownedAccount(user, accountId);
  const envelope = await readEnvelope(accountId);
  if (!envelope?.appId || !envelope.appSecret) throw new AppError("Add this account's Dhan client id, API key and secret first.", 409, "ACCOUNT_NOT_CONFIGURED");
  const consentId = await generateConsent({ appId: envelope.appId, appSecret: envelope.appSecret }, envelope.clientId, deps.fetch);
  const now = ctx.now ?? new Date();
  await prisma.brokerConsent.create({ data: { id: consentId, accountId, userId: user.id, expiresAt: new Date(now.getTime() + CONSENT_MINUTES * 60_000) } });
  await recordAudit({ userId: user.id, accountId, action: "broker.consent.start", correlationId: newCorrelationId(), outcome: "SUCCESS", ip: ctx.ip });
  return { url: consentLoginUrl(consentId), expiresInMinutes: CONSENT_MINUTES };
}

/**
 * Finishes a consent login from Dhan's redirect. No TradeD session is needed (the holder may sign in on their
 * own phone): the single-use tokenId is accepted only for a recent, unused consent, and the token Dhan returns
 * must belong to the client id configured for that account.
 */
export async function completeBrokerConsent(tokenId: string, accountHint: string | null, ctx: Ctx, deps: { fetch?: typeof fetch } = {}) {
  if (!/^[A-Za-z0-9._~-]{8,1024}$/.test(tokenId)) throw new AppError("The link from Dhan is incomplete. Start the connection again from TradeD.", 400, "CONSENT_INVALID");
  const now = ctx.now ?? new Date();
  const pending = await prisma.brokerConsent.findMany({
    where: { usedAt: null, expiresAt: { gt: now }, ...(accountHint ? { accountId: accountHint } : {}) },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
  const consent = accountHint ? pending[0] : pending.length === 1 ? pending[0] : undefined;
  if (!consent) throw new AppError("This connection link has expired or was already used. Start it again from TradeD.", 410, "CONSENT_EXPIRED");
  const claimed = await prisma.brokerConsent.updateMany({ where: { id: consent.id, usedAt: null }, data: { usedAt: now } });
  if (claimed.count !== 1) throw new AppError("This connection link was already used.", 410, "CONSENT_EXPIRED");
  const account = await prisma.brokerAccount.findUnique({ where: { id: consent.accountId } });
  if (!account || account.ownerId !== consent.userId) throw new AppError("Broker account not found.", 404, "ACCOUNT_NOT_FOUND");
  // No session on this redirect, so check the owner's standing and permissions here.
  const owner = await prisma.user.findUnique({ where: { id: account.ownerId }, select: { status: true, featMultiAccount: true, featBrokerConnection: true } });
  if (!owner || owner.status !== "ACTIVE" || !owner.featMultiAccount || !owner.featBrokerConnection) throw new AppError("Broker connection is not enabled for this account.", 403, "FEATURE_DISABLED");
  const envelope = await readEnvelope(account.id);
  if (!envelope?.appId || !envelope.appSecret) throw new AppError("This account has no API key configured.", 409, "ACCOUNT_NOT_CONFIGURED");
  const result = await consumeConsent({ appId: envelope.appId, appSecret: envelope.appSecret }, tokenId, deps.fetch);
  if (result.clientId !== envelope.clientId) {
    await prisma.brokerAccount.update({ where: { id: account.id }, data: { connection: "ERROR", lastError: "Dhan signed in a different client than the one configured for this account.", lastErrorAt: now } });
    await recordAudit({ userId: account.ownerId, accountId: account.id, action: "broker.consent.complete", correlationId: newCorrelationId(), outcome: "DENIED", detail: { reason: "client mismatch" }, ip: ctx.ip });
    throw new AppError("Dhan signed in a different account than the one configured here. Sign in with the right Dhan account.", 409, "CONSENT_CLIENT_MISMATCH");
  }
  await saveToken(account.ownerId, account.id, { clientId: result.clientId, accessToken: result.accessToken, expiresAt: result.expiresAt }, ctx);
  if (result.clientName) await prisma.brokerAccount.update({ where: { id: account.id }, data: { holderName: result.clientName } });
  // The owner's own account also feeds market data: the fresh token replaces the one pasted in Admin.
  if (await isServerRow(account)) await saveMarketConnection(account.ownerId, { clientId: result.clientId, accessToken: result.accessToken });
  const view = await validateAccount(account.ownerId, account.id, ctx, { fetch: deps.fetch });
  return { nickname: account.nickname, connection: view.connection };
}

/** Whether the account has a Dhan API key saved (so "Sign in with Dhan" can start). */
export async function hasAppKey(accountId: string) {
  const envelope = await readEnvelope(accountId).catch(() => null);
  return Boolean(envelope?.appId && envelope.appSecret);
}

/** The configured Dhan client id of an account, for its owner's view. Callers must already have checked ownership. */
export async function accountClientId(accountId: string): Promise<string | null> {
  return (await readEnvelope(accountId).catch(() => null))?.clientId ?? null;
}

/** Decrypted credentials of an account with a token. Callers must already have checked ownership. */
export async function loadAccountCredentials(accountId: string): Promise<DhanCredentials | null> {
  const envelope = await readEnvelope(accountId);
  if (!envelope?.accessToken) return null;
  return { clientId: envelope.clientId, accessToken: envelope.accessToken };
}

/** A broker client for one owned account, or an error explaining why the account cannot be used. */
export async function brokerClientFor(user: SessionUser, accountId: string, options: DhanClientOptions & { now?: Date } = {}) {
  const account = await ownedAccount(user, accountId);
  const now = options.now ?? new Date();
  if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() <= now.getTime()) throw new AppError("This account's authorization has expired. Reconnect it.", 409, "ACCOUNT_EXPIRED");
  const credentials = await loadAccountCredentials(accountId);
  if (!credentials) throw new AppError("This account is not connected.", 409, "ACCOUNT_NOT_CONNECTED");
  return createDhanClient(credentials, options);
}

/**
 * Confirms the stored credential with the broker. CONNECTED is written only after the broker answers
 * for the same client id; auth failures become EXPIRED and anything else becomes ERROR.
 */
export async function validateBrokerConnection(user: SessionUser, accountId: string, ctx: Ctx, options: DhanClientOptions = {}) {
  await ownedAccount(user, accountId);
  return validateAccount(user.id, accountId, ctx, options);
}

async function validateAccount(ownerId: string, accountId: string, ctx: Ctx, options: DhanClientOptions = {}) {
  const account = await prisma.brokerAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new AppError("Broker account not found.", 404, "ACCOUNT_NOT_FOUND");
  const now = ctx.now ?? new Date();
  const correlationId = newCorrelationId();
  const save = async (connection: BrokerConnection, extra: Partial<BrokerAccount> = {}) => {
    const row = await prisma.brokerAccount.update({ where: { id: accountId }, data: { connection, ...extra }, include: { credential: { select: { accountId: true } } } });
    return toView(row, now);
  };
  const envelope = await readEnvelope(accountId);
  if (!envelope) return save("NOT_CONNECTED");
  if (!envelope.accessToken) return save("AUTH_REQUIRED");
  if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() <= now.getTime()) {
    return save("EXPIRED", { lastError: "Authorization expired.", lastErrorAt: now });
  }
  try {
    const profile = await readProfile(createDhanClient({ clientId: envelope.clientId, accessToken: envelope.accessToken }, options));
    if (profile?.dhanClientId && profile.dhanClientId !== envelope.clientId) {
      await recordAudit({ userId: ownerId, accountId, action: "broker.connection.validate", correlationId, outcome: "FAILURE", detail: { reason: "client mismatch" }, ip: ctx.ip });
      return save("ERROR", { lastError: "The broker answered for a different client id.", lastErrorAt: now });
    }
    await recordAudit({ userId: ownerId, accountId, action: "broker.connection.validate", correlationId, outcome: "SUCCESS", ip: ctx.ip });
    return save("CONNECTED", { lastConnectedAt: now, lastSyncAt: now, lastError: "", lastErrorAt: null });
  } catch (error) {
    const broker = error instanceof BrokerError ? error : null;
    await recordAudit({ userId: ownerId, accountId, action: "broker.connection.validate", correlationId, outcome: "FAILURE", detail: { failure: broker?.failure ?? "UNKNOWN", brokerCode: broker?.brokerCode ?? null }, ip: ctx.ip });
    const message = broker ? broker.message : "The broker connection could not be checked.";
    return save(broker?.failure === "AUTH_EXPIRED" ? "EXPIRED" : "ERROR", { lastError: message, lastErrorAt: now });
  }
}
