import { z } from "zod";
import { alertSchema } from "@/lib/schemas";
import { AppError } from "@/lib/http";
import { rupeesToPaise } from "@/lib/money";
import { mutation, query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { prisma } from "@/lib/prisma";

export const GET = query(async () => {
  const user = await requireUser();
  const [alerts, notifications] = await Promise.all([
    prisma.priceAlert.findMany({ where: { userId: user.id }, include: { instrument: true }, orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return Response.json({
    alerts: alerts.map((alert) => ({
      id: alert.id,
      symbol: alert.instrument.symbol,
      condition: alert.condition,
      target: (Number(alert.targetPaise) / 100).toFixed(2),
      status: alert.status,
      note: alert.note,
    })),
    notifications: notifications.map((note) => ({
      id: note.id,
      title: note.title,
      body: note.body,
      read: Boolean(note.readAt),
      createdAt: note.createdAt.toISOString(),
      // Only in-app links are passed on (never an outside URL).
      href: note.href.startsWith("/") && !note.href.startsWith("//") ? note.href : null,
    })),
  });
});

export const POST = mutation(async (request) => {
  const user = await requireUser();
  const body = await request.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action : "alert";
  if (action === "notification-read") {
    const id = typeof body.id === "string" ? body.id : "";
    if (id) await prisma.notification.updateMany({ where: { id, userId: user.id, readAt: null }, data: { readAt: new Date() } });
    else await prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    return Response.json({ ok: true });
  }
  if (action === "alert-cancel") {
    const id = z.string().parse(body.id);
    await prisma.priceAlert.updateMany({ where: { id, userId: user.id, status: "ACTIVE" }, data: { status: "CANCELLED" } });
    return Response.json({ ok: true });
  }
  const input = alertSchema.parse(body);
  const instrument = await prisma.instrument.findUnique({ where: { symbol: input.symbol.toUpperCase() } });
  if (!instrument) throw new AppError("Instrument not found.", 404);
  const alert = await prisma.priceAlert.create({
    data: {
      userId: user.id,
      instrumentId: instrument.id,
      condition: input.condition,
      targetPaise: rupeesToPaise(input.targetRupees),
      note: input.note ?? "",
    },
  });
  return Response.json({ id: alert.id, simulated: true });
});
