import { z } from "zod";
import { clientIp, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation } from "@/server/http";
import { setAccountEnabled } from "@/server/live-orders";

const body = z.object({
  target: z.union([z.literal("server"), z.string().regex(/^c[a-z0-9]{20,32}$/, "Unknown account.")]),
  enabled: z.boolean(),
}).strict();

/** Switches one account in or out of live orders. */
export const POST = mutation(async (request) => {
  const user = await requireUser();
  rateLimit(`broker-accounts:select:${user.id}`, 60, 60_000);
  const input = await readJson(request, body);
  return Response.json(await setAccountEnabled(user, input.target, input.enabled, { ip: clientIp(request) }));
});
