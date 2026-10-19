import { AppError, clientIp, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { configureBrokerAccount, disconnectBrokerAccount, getBrokerAccount, removeBrokerAccount, startBrokerConsent, updateBrokerAccount, validateBrokerConnection } from "@/server/broker-accounts";
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

/**
 * Account actions: configure stores the holder's Dhan client id, API key/secret and static IP; connect starts
 * Dhan's consent login; refresh re-validates with the broker; disconnect forgets the credential.
 */
export const POST = mutation<Context>(async (request, context) => {
  const user = await requireUser();
  const id = await idFrom(context);
  const input = await readJson(request, actionBody);
  const ip = clientIp(request);
  switch (input.action) {
    case "refresh":
      // Dhan allows 20 non-trading requests per second per client; one manual refresh every few seconds is plenty.
      rateLimit(`broker-accounts:refresh:${user.id}:${id}`, 6, 60_000);
      return Response.json({ account: await validateBrokerConnection(user, id, { ip }) });
    case "disconnect":
      return Response.json({ account: await disconnectBrokerAccount(user, id, { ip }) });
    case "configure":
      rateLimit(`broker-accounts:configure:${user.id}`, 20, 60_000);
      return Response.json({ account: await configureBrokerAccount(user, id, { clientId: input.clientId, appId: input.appId, appSecret: input.appSecret, staticIp: input.staticIp, ipConfirmed: input.ipConfirmed }, { ip }) });
    case "connect":
      // Dhan allows 25 consent ids per day per client.
      rateLimit(`broker-accounts:connect:${user.id}:${id}`, 5, 10 * 60_000);
      return Response.json(await startBrokerConsent(user, id, { ip }));
  }
});
