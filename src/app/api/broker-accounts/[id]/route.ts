import { AppError, clientIp, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { disconnectBrokerAccount, getBrokerAccount, removeBrokerAccount, updateBrokerAccount, validateBrokerConnection } from "@/server/broker-accounts";
import { mutation, query, type RouteContext } from "@/server/http";
import { accountId, actionBody, updateBody } from "../schemas";

export const maxDuration = 20;

type Context = RouteContext<{ id: string }>;

async function idFrom(context: Context) {
  const parsed = accountId.safeParse((await context.params).id);
  if (!parsed.success) throw new AppError("Broker account not found.", 404, "ACCOUNT_NOT_FOUND");
  return parsed.data;
}

export const GET = query<Context>(async (_request, context) => {
  const user = await requireUser();
  return Response.json({ account: await getBrokerAccount(user, await idFrom(context)) }, { headers: { "Cache-Control": "no-store" } });
});

export const PATCH = mutation<Context>(async (request, context) => {
  const user = await requireUser();
  const id = await idFrom(context);
  const input = await readJson(request, updateBody);
  return Response.json({ account: await updateBrokerAccount(user, id, input, { ip: clientIp(request) }) });
});

export const DELETE = mutation<Context>(async (request, context) => {
  const user = await requireUser();
  return Response.json(await removeBrokerAccount(user, await idFrom(context), { ip: clientIp(request) }));
});

/** Account actions: refresh re-validates with the broker, disconnect forgets the credential. */
export const POST = mutation<Context>(async (request, context) => {
  const user = await requireUser();
  const id = await idFrom(context);
  const { action } = await readJson(request, actionBody);
  const ip = clientIp(request);
  switch (action) {
    case "refresh":
      // Dhan allows 20 non-trading requests per second per client; one manual refresh every few seconds is plenty.
      rateLimit(`broker-accounts:refresh:${user.id}:${id}`, 6, 60_000);
      return Response.json({ account: await validateBrokerConnection(user, id, { ip }) });
    case "disconnect":
      return Response.json({ account: await disconnectBrokerAccount(user, id, { ip }) });
    case "connect":
      await getBrokerAccount(user, id);
      throw new AppError(
        "Connecting accounts is not available yet. Each holder must authorize their own account through Dhan's login and consent page; TradeD will never ask for a password, OTP or token.",
        501,
        "BROKER_AUTH_NOT_CONFIGURED",
      );
  }
});
