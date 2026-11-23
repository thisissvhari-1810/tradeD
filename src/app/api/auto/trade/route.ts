import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { autoTradeDetail } from "@/server/auto/views";

export const GET = query(async (request) => {
  await requireUser(["SUPER_ADMIN"]);
  return Response.json(await autoTradeDetail(new URL(request.url).searchParams.get("id") ?? ""), { headers: { "Cache-Control": "no-store" } });
});
