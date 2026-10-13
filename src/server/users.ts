import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { hashPassword, instructorStudentIds, type SessionUser } from "@/server/auth";
import { getTradingSettings } from "@/server/settings";
import { rupeesToPaise } from "@/lib/money";
import { can } from "@/lib/auth/permissions";

type Tx = Prisma.TransactionClient;

export async function openStudentAccount(tx: Tx, userId: string, startingCapital: bigint, actorId: string) {
  const account = await tx.virtualAccount.create({
    data: { userId, currency: "INR", cashAvailable: 0n, cashReserved: 0n },
  });
  const period = await tx.practicePeriod.create({
    data: { accountId: account.id, sequence: 1, label: "Practice period 1", startingCapital, createdById: actorId },
  });
  await tx.virtualAccount.update({
    where: { id: account.id },
    data: { currentPeriodId: period.id, cashAvailable: startingCapital },
  });
  await tx.ledgerEntry.create({
    data: {
      accountId: account.id,
      practicePeriodId: period.id,
      type: "OPENING_BALANCE",
      cashDelta: startingCapital,
      reservedDelta: 0n,
      cashAvailableAfter: startingCapital,
      cashReservedAfter: 0n,
      reason: "Starting virtual capital",
      actorId,
    },
  });
  await tx.watchlist.create({ data: { userId, name: "Default" } });
  return account;
}

export async function createManagedUser(
  actor: SessionUser,
  input: { name: string; email: string; password: string; role: Role; startingRupees?: string; classId?: string },
  ip?: string,
) {
  if (input.role === "STUDENT" && !can(actor.role, "users.createStudent")) throw new AppError("You cannot create students.", 403);
  if (input.role !== "STUDENT" && !can(actor.role, "users.manage")) throw new AppError("Only a super admin can create this role.", 403);
  const settings = await getTradingSettings();
  let starting = settings.startingCapitalPaise;
  if (input.startingRupees) {
    if (actor.role !== "SUPER_ADMIN") throw new AppError("Only a super admin can set a custom starting balance.", 403);
    starting = rupeesToPaise(input.startingRupees);
    if (starting <= 0n) throw new AppError("Starting balance must be positive.");
  }
  if (actor.role === "INSTRUCTOR") {
    if (!input.classId) throw new AppError("Choose one of your classes.");
    const owned = await prisma.class.findFirst({ where: { id: input.classId, instructorId: actor.id, archivedAt: null } });
    if (!owned) throw new AppError("That class is not assigned to you.", 403);
  }
  const passwordHash = await hashPassword(input.password);
  const email = input.email.toLowerCase();
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name: input.name.trim(), email, passwordHash, role: input.role, createdById: actor.id, tradingEnabled: input.role === "STUDENT" },
    });
    if (input.role === "STUDENT") {
      await openStudentAccount(tx, user.id, starting, actor.id);
      if (input.classId) {
        await tx.classMembership.create({ data: { classId: input.classId, userId: user.id } });
      }
    }
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: "user.create",
        targetType: "User",
        targetId: user.id,
        reason: `Created ${input.role}`,
        after: { email, role: input.role, startingPaise: input.role === "STUDENT" ? starting.toString() : null },
        ipAddress: ip,
      },
    });
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  });
}

export async function setUserAccess(actor: SessionUser, userId: string, input: { status?: "ACTIVE" | "SUSPENDED" | "DISABLED"; tradingEnabled?: boolean; reason: string }, ip?: string) {
  if (!can(actor.role, "trading.suspend") && !can(actor.role, "users.manage")) throw new AppError("You cannot change account access.", 403);
  if (!input.reason.trim()) throw new AppError("A reason is required.");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError("User not found.", 404);
  if (user.role === "SUPER_ADMIN" && user.id !== actor.id) throw new AppError("Super admin accounts cannot be changed here.", 403);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { status: input.status ?? user.status, tradingEnabled: input.tradingEnabled ?? user.tradingEnabled },
  });
  if (updated.status === "DISABLED") {
    await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: "user.access",
      targetType: "User",
      targetId: userId,
      reason: input.reason,
      before: { status: user.status, tradingEnabled: user.tradingEnabled },
      after: { status: updated.status, tradingEnabled: updated.tradingEnabled },
      ipAddress: ip,
    },
  });
  return { id: updated.id, status: updated.status, tradingEnabled: updated.tradingEnabled };
}

export async function assertCanViewStudent(actor: SessionUser, studentUserId: string) {
  if (actor.id === studentUserId) return;
  if (actor.role === "SUPER_ADMIN") return;
  if (actor.role === "INSTRUCTOR") {
    const ids = await instructorStudentIds(actor.id);
    if (ids.includes(studentUserId)) return;
  }
  throw new AppError("You cannot view this student.", 403);
}
