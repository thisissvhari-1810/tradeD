import { z } from "zod";
import { clientIp, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation, query } from "@/server/http";
import { createUser, listUsers } from "@/server/admin-users";
import { appOrigin } from "../origin";
import { createUserBody } from "../schemas";

const filter = z.object({
  q: z.string().max(120).optional(),
  role: z.enum(["SUPER_ADMIN", "STUDENT", "INSTRUCTOR"]).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
  multi: z.enum(["on", "off"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(5).max(100).optional(),
});

export const GET = query(async (request) => {
  const actor = await requireUser(["SUPER_ADMIN"]);
  const params = Object.fromEntries([...new URL(request.url).searchParams].filter(([, value]) => value !== ""));
  return Response.json(await listUsers(actor, filter.parse(params)), { headers: { "Cache-Control": "no-store" } });
});

export const POST = mutation(async (request) => {
  const actor = await requireUser(["SUPER_ADMIN"]);
  rateLimit(`super-admin:create:${actor.id}`, 20, 60_000);
  const input = await readJson(request, createUserBody);
  return Response.json(await createUser(actor, input, { ip: clientIp(request), origin: appOrigin(request) }), { status: 201 });
});
