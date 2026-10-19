import { z } from "zod";
import { clientIp, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation } from "@/server/http";
import { setAccountEnabled, setAccountNickname } from "@/server/live-orders";

const body = z.object({
  target: z.union([z.literal("server"), z.string().regex(/^c[a-z0-9]{20,32}$/, "Unknown account.")]),
  enabled: z.boolean().optional(),
  nickname: z.string().trim().min(1, "Enter a name.").max(40, "Use 40 characters or fewer.").regex(/^[\p{L}\p{N} ._'-]+$/u, "Use letters, numbers, spaces and . _ ' - only.").optional(),
}).strict().refine((value) => value.enabled !== undefined || value.nickname !== undefined, "Nothing to change.");

/** Switches one account in or out of live orders, or renames it. */
export const POST = mutation(async (request) => {
  const user = await requireUser();
  rateLimit(`broker-accounts:select:${user.id}`, 60, 60_000);
  const input = await readJson(request, body);
  const ctx = { ip: clientIp(request) };
  const renamed = input.nickname !== undefined ? await setAccountNickname(user, input.target, input.nickname, ctx) : null;
  const switched = input.enabled !== undefined ? await setAccountEnabled(user, input.target, input.enabled, ctx) : null;
  return Response.json({ target: input.target, ...renamed, ...switched });
});
