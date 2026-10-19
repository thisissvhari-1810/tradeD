import { clientIp, readJson } from "@/lib/http";
import { encryptionConfigured } from "@/lib/security/crypto";
import { liveOrdersStatus } from "@/lib/security/flags";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { createBrokerAccount, listBrokerAccounts, MAX_BROKER_ACCOUNTS } from "@/server/broker-accounts";
import { mutation, query } from "@/server/http";
import { createBody } from "./schemas";

export const maxDuration = 15;

export const GET = query(async () => {
  const user = await requireUser();
  const live = liveOrdersStatus();
  return Response.json(
    {
      accounts: await listBrokerAccounts(user),
      limit: MAX_BROKER_ACCOUNTS,
      capabilities: {
        // Per-holder broker authorization is not wired yet; see the connect action.
        connect: false,
        credentialStorage: encryptionConfigured(),
        liveOrders: live.enabled,
      },
      liveOrdersBlockedBy: live.reasons,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});

export const POST = mutation(async (request) => {
  const user = await requireUser();
  rateLimit(`broker-accounts:create:${user.id}`, 10, 60_000);
  const input = await readJson(request, createBody);
  return Response.json({ account: await createBrokerAccount(user, input, { ip: clientIp(request) }) }, { status: 201 });
});
