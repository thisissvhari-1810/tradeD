import { PRACTICE_ROLES } from "@/lib/auth/permissions";
import { z } from "zod";
import { paiseToRupees } from "@/lib/money";
import { AppError } from "@/lib/http";
import { mutation } from "@/server/http";
import { requireUser } from "@/server/auth";
import { placeReplayOrder, settleReplayOrders } from "@/server/trading";

const schema = z.object({
  action: z.literal("order").optional(),
  symbol: z.string().trim().min(1).max(20),
  side: z.enum(["BUY", "SELL"]),
  type: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]),
  quantity: z.number().int().positive(),
  limitRupees: z.string().optional(),
  stopRupees: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cursor: z.number(),
  timeframe: z.string().trim().min(1).max(12),
  idempotencyKey: z.string().min(8).max(80),
});

const settleSchema = z.object({
  action: z.literal("settle"),
  symbol: z.string().trim().min(1).max(20),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cursor: z.number(),
  timeframe: z.string().trim().min(1).max(12),
});

export const POST = mutation(async (request) => {
  const user = await requireUser(PRACTICE_ROLES);
  const body = await request.json().catch(() => null);
  if (body?.action === "settle") {
    const input = settleSchema.safeParse(body);
    if (!input.success) throw new AppError(input.error.issues[0]?.message ?? "Invalid input.");
    return Response.json({ ...(await settleReplayOrders(user, input.data)), simulated: true });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Invalid input.");
  const input = parsed.data;
  const result = await placeReplayOrder(user, input);
  const order = result.order;
  return Response.json({
    id: order.id,
    symbol: order.instrument.symbol,
    side: order.side,
    status: order.status,
    quantity: order.quantity,
    averageFill: order.avgFillPaise == null ? null : paiseToRupees(order.avgFillPaise),
    reason: order.rejectionReason,
    replayed: result.replayed,
    simulated: true,
    message: order.status === "FILLED"
      ? "Simulated replay order filled on this student's demo account. No order was sent to a broker."
      : order.status === "OPEN"
        ? "The replay order is waiting for the revealed range."
        : order.rejectionReason,
  });
});
