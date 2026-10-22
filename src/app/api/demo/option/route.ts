import { practiceModeOf } from "@/server/practice-account";
import { PRACTICE_ROLES } from "@/lib/auth/permissions";
import { z } from "zod";
import { AppError } from "@/lib/http";
import { paiseToRupees } from "@/lib/money";
import { mutation } from "@/server/http";
import { requireUser } from "@/server/auth";
import { placeOptionDemo } from "@/server/trading";

const schema = z.object({
  symbol: z.string().trim().min(1, "Choose an underlying.").max(20),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose an expiry from the option chain."),
  strike: z.number({ invalid_type_error: "Choose a strike." }).positive("Choose a strike."),
  right: z.enum(["CE", "PE"], { errorMap: () => ({ message: "Choose CE or PE." }) }),
  action: z.enum(["BUY", "SELL"], { errorMap: () => ({ message: "Choose Buy or Sell." }) }),
  lots: z.number({ invalid_type_error: "Enter the number of lots." }).int("Lots must be a whole number.").positive("Enter at least 1 lot.").max(50, "Enter at most 50 lots."),
  idempotencyKey: z.string().min(8).max(80),
  referencePremium: z.number().positive().optional(),
});

export const POST = mutation(async (request) => {
  const user = await requireUser(PRACTICE_ROLES);
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(issue?.message ?? "Check the order details and try again.", 400, "INVALID_INPUT", { field: issue?.path.join(".") || undefined });
  }
  const result = await placeOptionDemo(user, parsed.data, practiceModeOf(request));
  const order = result.order;
  return Response.json({
    id: order.id,
    symbol: order.instrument.symbol,
    name: order.instrument.name,
    side: order.side,
    status: order.status,
    quantity: order.quantity,
    averageFill: order.avgFillPaise == null ? null : paiseToRupees(order.avgFillPaise),
    charges: paiseToRupees(order.chargesPaise),
    executedAt: order.executions[0]?.executedAt.toISOString() ?? order.filledAt?.toISOString() ?? null,
    priceAsOf: order.executions[0]?.priceAsOf.toISOString() ?? null,
    replayed: result.replayed,
    simulated: true,
    message: order.status === "FILLED"
      ? "Simulated option order filled on this student's demo account. No order was sent to a broker."
      : order.rejectionReason,
  });
});
