import { walletKey } from "@/server/practice-account";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { formatInr, formatSignedInr, rupeesToPaise } from "@/lib/money";
import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/server/auth";
import { adjustFunds, resetPracticePeriod } from "@/server/trading";

export async function listDemoAccounts(actor: SessionUser) {
  if (!can(actor.role, "funds.adjust")) throw new AppError("You cannot allocate demo capital.", 403);
  const students = await prisma.user.findMany({
    where: { role: "STUDENT" },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      accounts: {
        where: { mode: "DEMO" },
        select: {
          id: true,
          cashAvailable: true,
          cashReserved: true,
          updatedAt: true,
          currentPeriod: { select: { id: true, label: true, startingCapital: true, startedAt: true } },
        },
      },
    },
  });
  const rows = [];
  for (const student of students) {
    const account = student.accounts[0] ?? null;
    const periodId = account?.currentPeriod?.id;
    const realized = periodId
      ? (await prisma.position.aggregate({ where: { accountId: account.id, practicePeriodId: periodId }, _sum: { realizedPaise: true } }))._sum.realizedPaise ?? 0n
      : 0n;
    const trades = periodId ? await prisma.closedTrade.count({ where: { accountId: account?.id, practicePeriodId: periodId } }) : 0;
    const wins = periodId ? await prisma.closedTrade.count({ where: { accountId: account?.id, practicePeriodId: periodId, netPaise: { gt: 0 } } }) : 0;
    const losses = periodId ? await prisma.closedTrade.count({ where: { accountId: account?.id, practicePeriodId: periodId, netPaise: { lt: 0 } } }) : 0;
    rows.push({
      id: student.id,
      name: student.name,
      email: student.email,
      status: student.status,
      accountId: account?.id ?? null,
      startingCapital: account?.currentPeriod ? formatInr(account.currentPeriod.startingCapital) : "—",
      cashAvailable: account ? formatInr(account.cashAvailable) : "—",
      cashReserved: account ? formatInr(account.cashReserved) : "—",
      realized: formatSignedInr(realized),
      trades,
      wins,
      losses,
      updatedAt: account?.updatedAt.toISOString() ?? null,
    });
  }
  return rows;
}

export async function allocateDemoCapital(actor: SessionUser, input: { userId: string; amountRupees: string; direction: "credit" | "debit"; reason: string; idempotencyKey: string }, ip?: string) {
  if (!can(actor.role, "funds.adjust")) throw new AppError("You cannot allocate demo capital.", 403);
  const amount = rupeesToPaise(input.amountRupees);
  if (amount <= 0n) throw new AppError("Enter an amount above zero.");
  const signed = input.direction === "debit" ? -amount : amount;
  const student = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!student || student.role !== "STUDENT") throw new AppError("Choose a student account.", 404);
  try {
    await adjustFunds(actor, student.id, signed, input.reason, ip, input.idempotencyKey);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { ok: true };
    throw error;
  }
  return { ok: true };
}

export async function resetDemoAccount(actor: SessionUser, userId: string, reason: string, ip?: string) {
  if (!can(actor.role, "accounts.reset")) throw new AppError("You cannot reset a demo account.", 403);
  const student = await prisma.user.findUnique({ where: { id: userId } });
  if (!student || student.role !== "STUDENT") throw new AppError("Choose a student account.", 404);
  await resetPracticePeriod(actor, userId, reason, ip);
  return { ok: true };
}

export async function capitalHistory(actor: SessionUser, userId: string) {
  if (!can(actor.role, "funds.adjust")) throw new AppError("You cannot read allocation history.", 403);
  const account = await prisma.virtualAccount.findUnique({ where: walletKey(userId, "DEMO") });
  if (!account) throw new AppError("Student account not found.", 404);
  const entries = await prisma.ledgerEntry.findMany({
    where: { accountId: account.id, type: { in: ["ADMIN_ADJUSTMENT", "RESET_OPENING", "OPENING_BALANCE"] } },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  return entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    amount: formatSignedInr(entry.cashDelta),
    cashAfter: formatInr(entry.cashAvailableAfter),
    reason: entry.reason,
    at: entry.createdAt.toISOString(),
  }));
}
