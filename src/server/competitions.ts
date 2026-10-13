import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { maxDrawdownBps } from "@/lib/trading/accounting";
import { compositeScore } from "@/lib/trading/ranking";
import { paiseToRupees } from "@/lib/money";
import type { SessionUser } from "@/server/auth";

async function adminSince(practicePeriodId: string, since: Date): Promise<bigint> {
  const rows = await prisma.ledgerEntry.findMany({
    where: { practicePeriodId, type: "ADMIN_ADJUSTMENT", createdAt: { gte: since } },
    select: { cashDelta: true },
  });
  return rows.reduce((sum, row) => sum + row.cashDelta, 0n);
}

async function learningBps(userId: string): Promise<number> {
  const total = await prisma.lesson.count({ where: { published: true } });
  if (total === 0) return 0;
  const done = await prisma.lessonProgress.count({ where: { userId } });
  return Math.round((done / total) * 10_000);
}

export async function joinCompetition(user: SessionUser, competitionId: string) {
  if (user.role !== "STUDENT") throw new AppError("Only students can join a competition.", 403);
  const competition = await prisma.competition.findUnique({ where: { id: competitionId } });
  if (!competition || competition.status !== "ACTIVE") throw new AppError("This competition is not open.", 404);
  const now = new Date();
  if (now < competition.startsAt || now > competition.endsAt) throw new AppError("This competition is outside its entry window.");
  const account = await prisma.virtualAccount.findUnique({ where: { userId: user.id } });
  if (!account?.currentPeriodId) throw new AppError("Practice account not found.", 409);
  if (competition.classId) {
    const member = await prisma.classMembership.findUnique({ where: { classId_userId: { classId: competition.classId, userId: user.id } } });
    if (!member) throw new AppError("This competition is limited to a class you are not in.", 403);
  }
  const latest = await prisma.portfolioSnapshot.findFirst({ where: { accountId: account.id, practicePeriodId: account.currentPeriodId }, orderBy: { capturedAt: "desc" } });
  const equityAtJoin = latest?.equity ?? account.cashAvailable + account.cashReserved;
  const adminAtJoin = await adminSince(account.currentPeriodId, new Date(0));
  return prisma.competitionParticipant.create({
    data: {
      competitionId,
      userId: user.id,
      practicePeriodId: account.currentPeriodId,
      equityAtJoin,
      adminAdjustmentsAtJoin: adminAtJoin,
    },
  });
}

export async function refreshCompetition(competitionId: string) {
  const competition = await prisma.competition.findUnique({ where: { id: competitionId }, include: { participants: true } });
  if (!competition) throw new AppError("Competition not found.", 404);
  for (const participant of competition.participants) {
    if (participant.status === "DISQUALIFIED") continue;
    const period = await prisma.practicePeriod.findUnique({ where: { id: participant.practicePeriodId } });
    const account = await prisma.virtualAccount.findFirst({ where: { userId: participant.userId } });
    if (!account || !period) continue;
    const frozen = participant.status === "COMPLETED" || period.endedAt != null || account.currentPeriodId !== period.id;
    const snap = await prisma.portfolioSnapshot.findFirst({
      where: { practicePeriodId: period.id, capturedAt: { lte: period.endedAt ?? new Date() } },
      orderBy: { capturedAt: "desc" },
    });
    const equityNow = snap?.equity ?? participant.equityAtJoin;
    const adminNow = await adminSince(period.id, new Date(0));
    const snaps = await prisma.portfolioSnapshot.findMany({
      where: { practicePeriodId: period.id, capturedAt: { gte: participant.joinedAt } },
      orderBy: { capturedAt: "asc" },
    });
    const drawdownBps = maxDrawdownBps(snaps.map((item) => ({ equity: item.equity })));
    const score = compositeScore({
      equityNow,
      equityAtJoin: participant.equityAtJoin,
      adminNow,
      adminAtJoin: participant.adminAdjustmentsAtJoin,
      drawdownBps,
      learningBps: await learningBps(participant.userId),
      returnWeight: competition.returnWeight,
      drawdownWeight: competition.drawdownWeight,
      learningWeight: competition.learningWeight,
    });
    await prisma.competitionParticipant.update({
      where: { id: participant.id },
      data: {
        status: frozen ? "COMPLETED" : participant.status,
        finalReturnBps: score.returnBps,
        finalDrawdownBps: drawdownBps,
        learningScoreBps: await learningBps(participant.userId),
        compositeScoreBps: score.compositeBps,
        finalizedAt: frozen ? participant.finalizedAt ?? new Date() : null,
      },
    });
  }
  const ranked = await prisma.competitionParticipant.findMany({
    where: { competitionId, status: { not: "DISQUALIFIED" } },
    orderBy: { compositeScoreBps: "desc" },
  });
  await Promise.all(ranked.map((participant, index) => prisma.competitionParticipant.update({ where: { id: participant.id }, data: { rank: index + 1 } })));
  if (competition.endsAt.getTime() < Date.now() && competition.status === "ACTIVE") {
    await prisma.competition.update({ where: { id: competitionId }, data: { status: "COMPLETED" } });
  }
}

export async function listCompetitions(user: SessionUser) {
  const rows = await prisma.competition.findMany({
    where: user.role === "STUDENT" ? { status: { in: ["ACTIVE", "COMPLETED"] } } : {},
    include: { participants: { include: { user: { select: { id: true, name: true } } } }, class: true },
    orderBy: { startsAt: "desc" },
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    className: row.class?.name ?? "All students",
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    weights: { return: row.returnWeight, drawdown: row.drawdownWeight, learning: row.learningWeight },
    joined: row.participants.some((participant) => participant.userId === user.id),
    leaderboard: row.participants
      .filter((participant) => participant.rank != null)
      .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
      .map((participant) => ({
        rank: participant.rank,
        name: participant.user.name,
        you: participant.userId === user.id,
        returnPercent: participant.finalReturnBps == null ? "—" : `${(participant.finalReturnBps / 100).toFixed(2)}%`,
        drawdownPercent: participant.finalDrawdownBps == null ? "—" : `${(participant.finalDrawdownBps / 100).toFixed(2)}%`,
        learningPercent: participant.learningScoreBps == null ? "—" : `${(participant.learningScoreBps / 100).toFixed(2)}%`,
        score: participant.compositeScoreBps ?? "—",
        status: participant.status,
      })),
  }));
}

export function formatEquity(paise: bigint): string {
  return paiseToRupees(paise);
}
