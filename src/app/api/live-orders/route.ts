import { requireFeature } from "@/lib/auth/features";
import { z } from "zod";
import { clientIp, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation, query } from "@/server/http";
import { gateFor } from "@/server/live-gate";
import { cancelLiveOrder, listLiveOrders, placeLiveOrder, placeLiveOrders, previewLiveOrder, reconcileLiveOrder } from "@/server/live-orders";

export const maxDuration = 30;

const paise = z.number().int().positive().max(10_000_000_00);
const intent = z.object({
  exchangeSegment: z.enum(["NSE_EQ", "BSE_EQ", "NSE_FNO", "BSE_FNO"]),
  securityId: z.string().regex(/^\d{1,12}$/, "This instrument has no broker security id."),
  symbol: z.string().trim().min(1).max(80),
  side: z.enum(["BUY", "SELL"]),
  productType: z.enum(["CNC", "INTRADAY", "MARGIN"]),
  orderType: z.enum(["MARKET", "LIMIT"]),
  quantity: z.number().int().positive().max(100_000),
  lotSize: z.number().int().positive().max(100_000).nullable(),
  pricePaise: paise.nullable(),
  referencePaise: paise.nullable(),
}).strict();
const target = z.union([z.literal("server"), z.string().regex(/^c[a-z0-9]{20,32}$/, "Unknown account.")]);
const orderId = z.string().regex(/^c[a-z0-9]{20,32}$/, "Unknown order.");

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), intent }).strict(),
  z.object({ action: z.literal("place"), key: z.string().uuid("Missing request key."), intent, confirmed: z.literal(true, { message: "Confirm the order first." }) }).strict(),
  z.object({
    action: z.literal("placeMany"),
    key: z.string().uuid("Missing request key."),
    intent: intent.omit({ quantity: true }),
    legs: z.array(z.object({ accountId: target, quantity: z.number().int().positive().max(100_000) }).strict()).min(1, "Select at least one account.").max(8),
    confirmed: z.literal(true, { message: "Confirm the order first." }),
  }).strict(),
  z.object({ action: z.literal("reconcile"), orderId }).strict(),
  z.object({ action: z.literal("cancel"), orderId, confirmed: z.literal(true, { message: "Confirm the cancellation first." }) }).strict(),
]);

export const GET = query(async () => {
  const user = await requireUser();
  requireFeature(user, "multiAccount");
  const [orders, gate] = await Promise.all([listLiveOrders(user), gateFor(user)]);
  return Response.json({ orders, gate }, { headers: { "Cache-Control": "no-store" } });
});

export const POST = mutation(async (request) => {
  const user = await requireUser();
  requireFeature(user, "multiAccount");
  const input = await readJson(request, body);
  const ctx = { ip: clientIp(request) };
  switch (input.action) {
    case "preview":
      rateLimit(`live:preview:${user.id}`, 30, 60_000);
      return Response.json(await previewLiveOrder(user, input.intent));
    case "place":
      // Dhan caps orders at 10 per second; a person confirming orders by hand needs far fewer.
      rateLimit(`live:place:${user.id}`, 10, 60_000);
      return Response.json(await placeLiveOrder(user, { key: input.key, intent: input.intent }, ctx));
    case "placeMany":
      rateLimit(`live:place:${user.id}`, 10, 60_000);
      return Response.json({ results: await placeLiveOrders(user, { key: input.key, intent: input.intent, legs: input.legs }, ctx) });
    case "reconcile":
      rateLimit(`live:reconcile:${user.id}`, 60, 60_000);
      return Response.json(await reconcileLiveOrder(user, input.orderId, ctx));
    case "cancel":
      rateLimit(`live:cancel:${user.id}`, 20, 60_000);
      return Response.json(await cancelLiveOrder(user, input.orderId, ctx));
  }
});
