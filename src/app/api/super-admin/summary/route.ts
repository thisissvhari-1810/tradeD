import { requireUser } from "@/server/auth";
import { query } from "@/server/http";
import { adminSummary } from "@/server/admin-users";

export const GET = query(async () => {
  const actor = await requireUser(["SUPER_ADMIN"]);
  return Response.json(await adminSummary(actor), { headers: { "Cache-Control": "no-store" } });
});
