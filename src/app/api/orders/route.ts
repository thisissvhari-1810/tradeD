import { requireFeature } from "@/lib/auth/features";
import { practiceModeOf } from "@/server/practice-account";
import { PRACTICE_ROLES } from "@/lib/auth/permissions";
import { paiseToRupees } from "@/lib/money";
import { orderSchema } from "@/lib/schemas";
import { readJson } from "@/lib/http";
import { mutation, query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { placeOrder } from "@/server/trading";
import { recentActivity } from "@/server/portfolio";

export const GET = query(async (request) => {
  const user = await requireUser(PRACTICE_ROLES);
  requireFeature(user, "orderHistory");
  return Response.json(await recentActivity(user.id, practiceModeOf(request)));
});

export const POST = mutation(async (request) => {
  const user = await requireUser(PRACTICE_ROLES);
  requireFeature(user, "demoTrading");
  const input = await readJson(request, orderSchema);
  const result = await placeOrder(user, input, practiceModeOf(request));
  const order = result.order;
  return Response.json({
    id: order.id,
    symbol: order.instrument.symbol,
    side: order.side,
    type: order.type,
    quantity: order.quantity,
    status: order.status,
    filledQuantity: order.filledQuantity,
    averageFill: order.avgFillPaise == null ? null : paiseToRupees(order.avgFillPaise),
    charges: paiseToRupees(order.chargesPaise),
    reason: order.rejectionReason,
    replayed: result.replayed,
    dataMode: order.executions[0]?.dataMode ?? null,
    priceSource: order.executions[0]?.priceSource ?? null,
    simulated: true,
    message:
      order.status === "FILLED"
        ? "Simulated order filled. No order was sent to a broker."
        : order.status === "OPEN"
          ? "Simulated order is resting until the reference price crosses."
          : order.status === "REJECTED"
            ? order.rejectionReason
            : order.rejectionReason,
  });
});
