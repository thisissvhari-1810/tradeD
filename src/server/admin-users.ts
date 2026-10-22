import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import type { PracticeMode, Prisma, Role, UserStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { FEATURES, featureColumns, featuresOf, type Features } from "@/lib/auth/features";
import { formatInr } from "@/lib/money";
import { hashPassword, hashToken, newToken, type SessionUser } from "@/server/auth";
import { ensurePracticeAccount } from "@/server/practice-account";
import { getTradingSettings } from "@/server/settings";
import { adjustFunds } from "@/server/trading";
import { openStudentAccount } from "@/server/users";

/**
 * Super Admin user management. Every function checks the actor itself, so a route cannot forget to,
 * and every change is written to AuditLog. Password hashes, tokens and broker secrets are never returned.
 */

export const ROLE_LABEL: Record<Role, string> = { SUPER_ADMIN: "Super Admin", STUDENT: "Standard User", INSTRUCTOR: "Instructor" };
const LINK_HOURS = 72;
const MAX_ADJUST_PAISE = 1_00_00_000_00n; // ₹1 crore per adjustment

function assertSuperAdmin(actor: SessionUser) {
  if (actor.role !== "SUPER_ADMIN" || actor.status !== "ACTIVE") throw new AppError("Only an active Super Admin can do this.", 403);
}

async function audit(tx: Prisma.TransactionClient | typeof prisma, actor: SessionUser, action: string, targetId: string, data: { reason?: string; before?: unknown; after?: unknown; ip?: string | null }) {
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      action,
      targetType: "User",
      targetId,
      reason: data.reason ?? "",
      before: data.before === undefined ? undefined : (JSON.parse(JSON.stringify(data.before)) as Prisma.InputJsonValue),
      after: data.after === undefined ? undefined : (JSON.parse(JSON.stringify(data.after)) as Prisma.InputJsonValue),
      ipAddress: data.ip ?? null,
    },
  });
}

const USER_FIELDS = {
  id: true, name: true, email: true, role: true, status: true, notes: true, createdAt: true, lastLoginAt: true, mfaEnabled: true,
  tradingEnabled: true, featDemoTrading: true, featReplay: true, featMultiAccount: true, featBrokerConnection: true, featPortfolio: true, featOrderHistory: true, featAnalytics: true,
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_FIELDS }>;

function present(row: UserRow, wallets: Array<{ mode: PracticeMode; cashAvailable: bigint; cashReserved: bigint }>) {
  const byMode = (mode: PracticeMode) => wallets.find((item) => item.mode === mode);
  const demo = byMode("DEMO");
  const live = byMode("LIVE");
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    roleLabel: ROLE_LABEL[row.role],
    status: row.status,
    notes: row.notes,
    mfaEnabled: row.mfaEnabled,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    features: featuresOf(row),
    wallets: {
      DEMO: demo ? { available: formatInr(demo.cashAvailable), reserved: formatInr(demo.cashReserved), availablePaise: demo.cashAvailable.toString() } : null,
      LIVE: live ? { available: formatInr(live.cashAvailable), reserved: formatInr(live.cashReserved), availablePaise: live.cashAvailable.toString() } : null,
    },
  };
}

export async function adminSummary(actor: SessionUser) {
  assertSuperAdmin(actor);
  const [total, active, suspended, disabled, multiOn, cash, credits, debits] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: "ACTIVE" } }),
    prisma.user.count({ where: { status: "SUSPENDED" } }),
    prisma.user.count({ where: { status: "DISABLED" } }),
    prisma.user.count({ where: { featMultiAccount: true } }),
    prisma.virtualAccount.aggregate({ _sum: { cashAvailable: true, cashReserved: true } }),
    prisma.ledgerEntry.aggregate({ where: { type: "ADMIN_ADJUSTMENT", cashDelta: { gt: 0 } }, _sum: { cashDelta: true }, _count: true }),
    prisma.ledgerEntry.aggregate({ where: { type: "ADMIN_ADJUSTMENT", cashDelta: { lt: 0 } }, _sum: { cashDelta: true }, _count: true }),
  ]);
  return {
    users: { total, active, suspendedOrDisabled: suspended + disabled, suspended, disabled },
    multiAccount: { enabled: multiOn, disabled: total - multiOn },
    wallets: {
      totalBalance: formatInr((cash._sum.cashAvailable ?? 0n) + (cash._sum.cashReserved ?? 0n)),
      adminCredits: formatInr(credits._sum.cashDelta ?? 0n),
      adminCreditCount: credits._count,
      adminDebits: formatInr(-(debits._sum.cashDelta ?? 0n)),
      adminDebitCount: debits._count,
    },
  };
}

export async function listUsers(actor: SessionUser, filter: { q?: string; role?: Role; status?: UserStatus; multi?: "on" | "off"; page?: number; pageSize?: number }) {
  assertSuperAdmin(actor);
  const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 5), 100);
  const page = Math.max(filter.page ?? 1, 1);
  const q = filter.q?.trim();
  const where: Prisma.UserWhereInput = {
    ...(q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }, { id: q }] } : {}),
    ...(filter.role ? { role: filter.role } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.multi ? { featMultiAccount: filter.multi === "on" } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, select: { ...USER_FIELDS, accounts: { select: { mode: true, cashAvailable: true, cashReserved: true } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { total, page, pageSize, users: rows.map(({ accounts, ...row }) => present(row, accounts)) };
}

export async function userDetail(actor: SessionUser, userId: string) {
  assertSuperAdmin(actor);
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { ...USER_FIELDS, accounts: { select: { id: true, mode: true, cashAvailable: true, cashReserved: true, currentPeriod: { select: { startingCapital: true } } } } } });
  if (!row) throw new AppError("User not found.", 404);
  const walletIds = row.accounts.map((item) => item.id);
  const [ledger, orders, auditRows] = await Promise.all([
    prisma.ledgerEntry.findMany({ where: { accountId: { in: walletIds } }, orderBy: { createdAt: "desc" }, take: 200, include: { account: { select: { mode: true } } } }),
    prisma.order.findMany({ where: { accountId: { in: walletIds } }, orderBy: { submittedAt: "desc" }, take: 100, include: { instrument: { select: { symbol: true, name: true } }, account: { select: { mode: true } } } }),
    prisma.auditLog.findMany({ where: { OR: [{ targetId: userId }, { targetId: { in: walletIds } }] }, orderBy: { createdAt: "desc" }, take: 100, include: { actor: { select: { name: true, email: true } } } }),
  ]);
  const actorIds = [...new Set(ledger.map((entry) => entry.actorId).filter((id): id is string => Boolean(id)))];
  const actors = new Map((await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })).map((item) => [item.id, item]));
  const { accounts, ...user } = row;
  return {
    user: present(user, accounts),
    startingCapital: Object.fromEntries(accounts.map((item) => [item.mode, item.currentPeriod ? formatInr(item.currentPeriod.startingCapital) : null])),
    ledger: ledger.map((entry) => ({
      id: entry.id,
      wallet: entry.account.mode,
      type: entry.type,
      amount: formatInr(entry.cashDelta),
      amountPaise: entry.cashDelta.toString(),
      balanceBefore: formatInr(entry.cashAvailableAfter - entry.cashDelta),
      balanceAfter: formatInr(entry.cashAvailableAfter),
      reason: entry.reason,
      admin: entry.actorId ? actors.get(entry.actorId)?.email ?? entry.actorId : null,
      at: entry.createdAt.toISOString(),
    })),
    orders: orders.map((order) => ({
      id: order.id,
      wallet: order.account.mode,
      symbol: order.instrument.symbol,
      name: order.instrument.name,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      status: order.status,
      avgFill: order.avgFillPaise == null ? null : formatInr(order.avgFillPaise),
      replay: order.instrument.symbol.includes("|R:"),
      at: order.submittedAt.toISOString(),
    })),
    audit: auditRows.map((item) => ({ id: item.id, action: item.action, actor: item.actor?.email ?? null, reason: item.reason, at: item.createdAt.toISOString(), after: item.after })),
  };
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function setupLink(tx: Prisma.TransactionClient, userId: string, origin: string) {
  await tx.passwordReset.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  const token = newToken();
  await tx.passwordReset.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + LINK_HOURS * 3600_000) } });
  return `${origin}/set-password?token=${encodeURIComponent(token)}`;
}

/** A password nobody knows, until the user sets theirs through the setup link. */
async function unusablePasswordHash() {
  return hash(randomBytes(32).toString("base64url"), 12);
}

export type CreateInput = { name: string; email: string; role: "SUPER_ADMIN" | "STUDENT"; status: "ACTIVE" | "SUSPENDED"; features: Features; initialCreditRupees?: number | null; notes?: string };

export async function createUser(actor: SessionUser, input: CreateInput, ctx: { ip: string | null; origin: string }) {
  assertSuperAdmin(actor);
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!name || name.length > 80) throw new AppError("Enter a name of up to 80 characters.", 400, "INVALID_INPUT", { field: "name" });
  if (!EMAIL.test(email)) throw new AppError("Enter a valid email address.", 400, "INVALID_INPUT", { field: "email" });
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) throw new AppError("A user with this email already exists.", 409, "EMAIL_TAKEN", { field: "email" });
  const credit = input.initialCreditRupees ? BigInt(Math.round(input.initialCreditRupees * 100)) : 0n;
  if (credit < 0n || credit > MAX_ADJUST_PAISE) throw new AppError("Initial credit must be between ₹0 and ₹1,00,00,000.", 400, "INVALID_INPUT", { field: "initialCreditRupees" });
  const { startingCapitalPaise } = await getTradingSettings();
  const passwordHash = await unusablePasswordHash();
  const { user, link } = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { name, email, passwordHash, role: input.role, status: input.status, createdById: actor.id, notes: (input.notes ?? "").slice(0, 500), ...featureColumns(input.features) },
    });
    // Existing wallet rule: the Demo wallet opens with the configured starting capital.
    await openStudentAccount(tx, created.id, startingCapitalPaise, actor.id, "DEMO");
    const link = await setupLink(tx, created.id, ctx.origin);
    await audit(tx, actor, "user.create", created.id, { after: { email, role: input.role, status: input.status, features: input.features }, ip: ctx.ip });
    return { user: created, link };
  });
  if (credit > 0n) await adjustFunds(actor, user.id, credit, "Initial credit at account creation (administrative, not a deposit)", ctx.ip ?? undefined, `create-credit:${user.id}`, "DEMO");
  return { userId: user.id, setupLink: link, linkExpiresHours: LINK_HOURS };
}

async function assertNotLastSuperAdmin(userId: string, next: { role?: Role; status?: UserStatus }) {
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
  if (!target || target.role !== "SUPER_ADMIN" || target.status !== "ACTIVE") return;
  const losing = (next.role && next.role !== "SUPER_ADMIN") || (next.status && next.status !== "ACTIVE");
  if (!losing) return;
  const others = await prisma.user.count({ where: { role: "SUPER_ADMIN", status: "ACTIVE", id: { not: userId } } });
  if (others === 0) throw new AppError("This is the last active Super Admin. Make another Super Admin first.", 409, "LAST_SUPER_ADMIN");
}

export type UpdateInput = { name?: string; email?: string; notes?: string; role?: "SUPER_ADMIN" | "STUDENT"; status?: UserStatus; features?: Partial<Features> };

export async function updateUser(actor: SessionUser, userId: string, input: UpdateInput, ctx: { ip: string | null }) {
  assertSuperAdmin(actor);
  const before = await prisma.user.findUnique({ where: { id: userId }, select: USER_FIELDS });
  if (!before) throw new AppError("User not found.", 404);
  if (userId === actor.id && (input.role === "STUDENT" || (input.status && input.status !== "ACTIVE"))) throw new AppError("You cannot demote or deactivate your own account.", 409, "SELF_CHANGE");
  await assertNotLastSuperAdmin(userId, { role: input.role, status: input.status });
  const email = input.email?.trim().toLowerCase();
  if (email !== undefined) {
    if (!EMAIL.test(email)) throw new AppError("Enter a valid email address.", 400, "INVALID_INPUT", { field: "email" });
    const clash = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (clash && clash.id !== userId) throw new AppError("Another user already has this email.", 409, "EMAIL_TAKEN", { field: "email" });
  }
  const data: Prisma.UserUpdateInput = {
    ...(input.name !== undefined ? { name: input.name.trim().slice(0, 80) } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(input.notes !== undefined ? { notes: input.notes.slice(0, 500) } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.features ? featureColumns(input.features) : {}),
  };
  // Decide the audit label and capture the old values before anything is written.
  const action = input.features && Object.keys(input).length === 1 ? "user.permissions" : input.status && input.status !== before.status ? `user.status.${input.status.toLowerCase()}` : input.role && input.role !== before.role ? "user.role" : "user.update";
  const snapshot = { ...before, features: featuresOf(before) };
  const roleChanged = Boolean(input.role && input.role !== before.role);
  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({ where: { id: userId }, data, select: USER_FIELDS });
    // Deactivation, archiving and role changes end existing sessions.
    if ((input.status && input.status !== "ACTIVE") || roleChanged) {
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await audit(tx, actor, action, userId, { before: snapshot, after: { ...updated, features: featuresOf(updated) }, ip: ctx.ip });
    return updated;
  });
  return { user: present(after, []) };
}

export async function issuePasswordLink(actor: SessionUser, userId: string, ctx: { ip: string | null; origin: string }) {
  assertSuperAdmin(actor);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
  if (!user) throw new AppError("User not found.", 404);
  if (user.status === "DISABLED") throw new AppError("Reactivate this user before sending a password link.", 409);
  const link = await prisma.$transaction(async (tx) => {
    const created = await setupLink(tx, userId, ctx.origin);
    await audit(tx, actor, "user.password_link", userId, { ip: ctx.ip });
    return created;
  });
  return { setupLink: link, linkExpiresHours: LINK_HOURS };
}

export async function adjustWallet(actor: SessionUser, userId: string, input: { wallet: PracticeMode; direction: "credit" | "debit"; amountRupees: number; reason: string; key: string }, ctx: { ip: string | null }) {
  assertSuperAdmin(actor);
  if (!Number.isFinite(input.amountRupees) || input.amountRupees <= 0) throw new AppError("Enter an amount above zero.", 400, "INVALID_INPUT", { field: "amountRupees" });
  const paise = BigInt(Math.round(input.amountRupees * 100));
  if (paise <= 0n || paise > MAX_ADJUST_PAISE) throw new AppError("Amount must be between ₹0.01 and ₹1,00,00,000.", 400, "INVALID_INPUT", { field: "amountRupees" });
  const reason = input.reason.trim();
  if (reason.length < 3) throw new AppError("Enter a reason for this adjustment.", 400, "INVALID_INPUT", { field: "reason" });
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!target) throw new AppError("User not found.", 404);
  if (input.wallet === "LIVE") await ensurePracticeAccount(userId, "LIVE");
  const label = input.direction === "credit" ? "Administrative credit (not a deposit)" : "Administrative debit";
  const account = await adjustFunds(actor, userId, input.direction === "credit" ? paise : -paise, `${label}: ${reason}`, ctx.ip ?? undefined, `admin-wallet:${input.key}`, input.wallet);
  return { wallet: input.wallet, balance: formatInr(account.cashAvailable) };
}

export async function auditLog(actor: SessionUser, page = 1) {
  assertSuperAdmin(actor);
  const take = 50;
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, skip: (Math.max(page, 1) - 1) * take, take, include: { actor: { select: { email: true } } } });
  const targets = new Map((await prisma.user.findMany({ where: { id: { in: rows.map((row) => row.targetId) } }, select: { id: true, email: true } })).map((item) => [item.id, item.email]));
  return rows.map((row) => ({ id: row.id, action: row.action, actor: row.actor?.email ?? "system", target: targets.get(row.targetId) ?? `${row.targetType} ${row.targetId.slice(0, 8)}`, reason: row.reason, at: row.createdAt.toISOString() }));
}

/** Completes an invite or reset: one use, unexpired, never for a disabled account. */
export async function completePasswordSetup(token: string, password: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new AppError("This link is not valid.", 400, "LINK_INVALID");
  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { select: { id: true, status: true, email: true } } } });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) throw new AppError("This link has expired or was already used. Ask your administrator for a new one.", 410, "LINK_EXPIRED");
  if (row.user.status === "DISABLED") throw new AppError("This account is disabled.", 403);
  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.passwordReset.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash, tokenVersion: { increment: 1 } } }),
    prisma.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.auditLog.create({ data: { actorId: row.userId, action: "user.password_set", targetType: "User", targetId: row.userId, reason: "Password set through a one-time link." } }),
  ]);
  return { email: row.user.email };
}

export const FEATURE_LIST = FEATURES;
