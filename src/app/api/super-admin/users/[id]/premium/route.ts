import { z } from "zod";
import { AppError, clientIp, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation, query, type RouteContext } from "@/server/http";
import { grantPremium, listPremium, revokePremium } from "@/server/premium-admin";
import { userIdParam } from "../../../schemas";

type Context = RouteContext<{ id: string }>;

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("grant"), plan: z.enum(["MONTHLY", "HALF_YEARLY", "YEARLY"]), note: z.string().trim().min(3, "Enter a reason for this grant.").max(200) }).strict(),
  z.object({ action: z.literal("revoke"), subscriptionId: z.string().min(10).max(40), note: z.string().trim().min(3, "Enter a reason for revoking.").max(200) }).strict(),
]);

async function idFrom(context: Context) {
  const parsed = userIdParam.safeParse((await context.params).id);
  if (!parsed.success) throw new AppError("User not found.", 404);
  return parsed.data;
}

/** A user's Premium history (Super Admin only). */
export const GET = query<Context>(async (_request, context) => {
  const actor = await requireUser(["SUPER_ADMIN"]);
  return Response.json(await listPremium(actor, await idFrom(context)), { headers: { "Cache-Control": "no-store" } });
});

/** Grant or revoke Premium (Super Admin only, audited). */
export const POST = mutation<Context>(async (request, context) => {
  const actor = await requireUser(["SUPER_ADMIN"]);
  const id = await idFrom(context);
  const input = await readJson(request, body);
  rateLimit(`super-admin:premium:${actor.id}`, 30, 60_000);
  const ip = clientIp(request);
  return Response.json(input.action === "grant" ? await grantPremium(actor, id, input, { ip }) : await revokePremium(actor, id, input, { ip }));
});
