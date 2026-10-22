import { requireUser } from "@/server/auth";
import { query } from "@/server/http";
import { auditLog } from "@/server/admin-users";

export const GET = query(async (request) => {
  const actor = await requireUser(["SUPER_ADMIN"]);
  const page = Number(new URL(request.url).searchParams.get("page") ?? 1) || 1;
  return Response.json({ entries: await auditLog(actor, page) }, { headers: { "Cache-Control": "no-store" } });
});
