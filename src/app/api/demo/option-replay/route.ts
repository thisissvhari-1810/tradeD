import { requireFeature } from "@/lib/auth/features";
import { PRACTICE_ROLES } from "@/lib/auth/permissions";
import { z } from "zod";
import { AppError } from "@/lib/http";
import { paiseToRupees } from "@/lib/money";
import { REPLAY_SESSION_PATTERN } from "@/lib/options/replay-premium";
import { mutation } from "@/server/http";
import { requireUser } from "@/server/auth";
import { replayMarks, replayQuote } from "@/server/option-replay";
import { placeOptionReplay } from "@/server/trading";

const clock = {
  session: z.string().regex(REPLAY_SESSION_PATTERN, "This replay session is not recognised. Restart the replay."),
  // Playback advances in fractions of a second; the replay clock is whole seconds, so round down.
  cursor: z.number({ invalid_type_error: "The replay time is missing." }).finite("The replay time is missing.").transform((value) => Math.floor(value)),
};
const contract = {
  symbol: z.string().trim().min(1, "Choose an underlying.").max(20),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose an expiry from the option chain."),
  strike: z.number({ invalid_type_error: "Choose a strike." }).positive("Choose a strike."),
  right: z.enum(["CE", "PE"], { errorMap: () => ({ message: "Choose CE or PE." }) }),
};
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), ...contract, ...clock }),
  z.object({ action: z.literal("marks"), ...clock }),
  z.object({
    action: z.literal("order"),
    ...contract,
    ...clock,
    side: z.enum(["BUY", "SELL"], { errorMap: () => ({ message: "Choose Buy or Sell." }) }),
    lots: z.number({ invalid_type_error: "Enter the number of lots." }).int("Lots must be a whole number.").positive("Enter at least 1 lot.").max(50, "Enter at most 50 lots."),
    idempotencyKey: z.string().min(8).max(80),
    referencePremium: z.number().positive().optional(),
  }),
]);

export const POST = mutation(async (request) => {
  const user = await requireUser(PRACTICE_ROLES);
  requireFeature(user, "replay");
  requireFeature(user, "demoTrading");
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(issue?.message ?? "Check the replay order and try again.", 400, "INVALID_INPUT", { field: issue?.path.join(".") || undefined });
  }
  const input = parsed.data;
  if (input.action === "quote") {
    const { quote } = await replayQuote({ underlying: input.symbol, expiry: input.expiry, strike: input.strike, right: input.right, session: input.session, cursor: input.cursor });
    return Response.json(quote);
  }
  if (input.action === "marks") return Response.json(await replayMarks(user, input.session, input.cursor));
  const result = await placeOptionReplay(user, {
    symbol: input.symbol,
    expiry: input.expiry,
    strike: input.strike,
    right: input.right,
    action: input.side,
    lots: input.lots,
    session: input.session,
    cursor: input.cursor,
    idempotencyKey: input.idempotencyKey,
    referencePremium: input.referencePremium,
  });
  const order = result.order;
  const fill = order.executions[0];
  return Response.json({
    id: order.id,
    symbol: order.instrument.symbol,
    side: order.side,
    status: order.status,
    quantity: order.quantity,
    averageFill: order.avgFillPaise == null ? null : paiseToRupees(order.avgFillPaise),
    charges: paiseToRupees(order.chargesPaise),
    realized: fill ? paiseToRupees(fill.realizedPaise) : null,
    submittedAt: order.submittedAt.toISOString(),
    executedAt: fill?.executedAt.toISOString() ?? null,
    priceAsOf: fill?.priceAsOf.toISOString() ?? null,
    priceSource: fill?.priceSource ?? null,
    dataMode: fill?.dataMode ?? null,
    replayed: result.replayed,
    simulated: true,
    message: "Simulated replay option order filled from historical data. No order was sent to a broker.",
  });
});
