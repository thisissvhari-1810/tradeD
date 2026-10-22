import { z } from "zod";
import { clientIp, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { mutation } from "@/server/http";
import { completePasswordSetup } from "@/server/admin-users";

const body = z.object({ token: z.string().min(20).max(100), password: z.string().min(10, "Use at least 10 characters.").max(128) }).strict();

/** Public: completes a one-time invite or reset link. */
export const POST = mutation(async (request) => {
  rateLimit(`set-password:${clientIp(request)}`, 10, 15 * 60_000);
  const input = await readJson(request, body);
  return Response.json(await completePasswordSetup(input.token, input.password));
});
