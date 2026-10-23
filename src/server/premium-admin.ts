import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { planById, planEnd, type PremiumPlanId } from "@/lib/premium/plans";
import type { SessionUser } from "@/server/auth";

/**
 * Super Admin control of TradeD Premium while no payment provider is configured: grant a plan
 * (it starts when the current access ends, so renewals stack) or revoke one. Every change is
 * audited. A payment integration will create the same Subscription rows after verified payment.
 */
function assertSuperAdmin(actor: SessionUser) {
  if (actor.role !== "SUPER_ADMIN" || actor.status !== "ACTIVE") throw new AppError("Only an active Super Admin can do this.", 403);
}

function present(row: { id: string; plan: PremiumPlanId; status: string; startsAt: Date; endsAt: Date; source: string; note: string; createdAt: Date }, now = Date.now()) {
  const state = row.status !== "ACTIVE" ? "Cancelled" : row.endsAt.getTime() <= now ? "Expired" : row.startsAt.getTime() > now ? "Scheduled" : "Active";
  return { id: row.id, plan: row.plan, label: planById(row.plan)?.label ?? row.plan, state, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), source: row.source, note: row.note, createdAt: row.createdAt.toISOString() };
}

export async function listPremium(actor: SessionUser, userId: string) {
  assertSuperAdmin(actor);
  const rows = await prisma.subscription.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50 });
  return { subscriptions: rows.map((row) => present(row)) };
}

export async function grantPremium(actor: SessionUser, userId: string, input: { plan: PremiumPlanId; note: string }, ctx: { ip: string | null }) {
  assertSuperAdmin(actor);
  const plan = planById(input.plan);
  if (!plan) throw new AppError("Choose a plan.", 400, "INVALID_INPUT", { field: "plan" });
  const note = input.note.trim();
  if (note.length < 3) throw new AppError("Enter a reason for this grant.", 400, "INVALID_INPUT", { field: "note" });
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!target) throw new AppError("User not found.", 404);
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const latest = await tx.subscription.findFirst({ where: { userId, status: "ACTIVE", endsAt: { gt: now } }, orderBy: { endsAt: "desc" } });
    const startsAt = latest ? latest.endsAt : now;
    const row = await tx.subscription.create({ data: { userId, plan: plan.id, startsAt, endsAt: planEnd(plan, startsAt), source: "ADMIN", grantedById: actor.id, note } });
    await audit(tx, actor, "premium.grant", userId, { reason: note, after: { plan: plan.id, startsAt: row.startsAt, endsAt: row.endsAt }, ip: ctx.ip });
    return present(row);
  });
}

export async function revokePremium(actor: SessionUser, userId: string, input: { subscriptionId: string; note: string }, ctx: { ip: string | null }) {
  assertSuperAdmin(actor);
  const note = input.note.trim();
  if (note.length < 3) throw new AppError("Enter a reason for revoking.", 400, "INVALID_INPUT", { field: "note" });
  return prisma.$transaction(async (tx) => {
    const row = await tx.subscription.findFirst({ where: { id: input.subscriptionId, userId } });
    if (!row) throw new AppError("Subscription not found.", 404);
    if (row.status === "CANCELLED") return present(row);
    const next = await tx.subscription.update({ where: { id: row.id }, data: { status: "CANCELLED", note: `${row.note}${row.note ? " · " : ""}Revoked: ${note}` } });
    await audit(tx, actor, "premium.revoke", userId, { reason: note, before: { plan: row.plan, endsAt: row.endsAt }, ip: ctx.ip });
    return present(next);
  });
}

async function audit(tx: Prisma.TransactionClient, actor: SessionUser, action: string, targetId: string, data: { reason: string; before?: unknown; after?: unknown; ip: string | null }) {
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      action,
      targetType: "User",
      targetId,
      reason: data.reason,
      before: data.before === undefined ? undefined : (JSON.parse(JSON.stringify(data.before)) as Prisma.InputJsonValue),
      after: data.after === undefined ? undefined : (JSON.parse(JSON.stringify(data.after)) as Prisma.InputJsonValue),
      ipAddress: data.ip,
    },
  });
}
