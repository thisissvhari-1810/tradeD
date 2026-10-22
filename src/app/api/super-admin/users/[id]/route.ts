import { AppError, clientIp, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation, query, type RouteContext } from "@/server/http";
import { adjustWallet, issuePasswordLink, updateUser, userDetail } from "@/server/admin-users";
import { appOrigin } from "../../origin";
import { updateUserBody, userActionBody, userIdParam } from "../../schemas";

type Context = RouteContext<{ id: string }>;

async function idFrom(context: Context) {
  const parsed = userIdParam.safeParse((await context.params).id);
  if (!parsed.success) throw new AppError("User not found.", 404);
  return parsed.data;
}

export const GET = query<Context>(async (_request, context) => {
  const actor = await requireUser(["SUPER_ADMIN"]);
  return Response.json(await userDetail(actor, await idFrom(context)), { headers: { "Cache-Control": "no-store" } });
});

/** Edit details, role, status (including archive = DISABLED) and permissions. */
export const PATCH = mutation<Context>(async (request, context) => {
  const actor = await requireUser(["SUPER_ADMIN"]);
  const id = await idFrom(context);
  const input = await readJson(request, updateUserBody);
  return Response.json(await updateUser(actor, id, input, { ip: clientIp(request) }));
});

/** Wallet credit/debit and password links. */
export const POST = mutation<Context>(async (request, context) => {
  const actor = await requireUser(["SUPER_ADMIN"]);
  const id = await idFrom(context);
  const input = await readJson(request, userActionBody);
  const ip = clientIp(request);
  if (input.action === "wallet") {
    rateLimit(`super-admin:wallet:${actor.id}`, 30, 60_000);
    return Response.json(await adjustWallet(actor, id, input, { ip }));
  }
  rateLimit(`super-admin:link:${actor.id}`, 20, 60_000);
  return Response.json(await issuePasswordLink(actor, id, { ip, origin: appOrigin(request) }));
});
