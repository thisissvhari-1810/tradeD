import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { autoStrategyDetail } from "@/server/auto/views";

export const GET = query(async (request) => {
  await requireUser(["SUPER_ADMIN"]);
  return Response.json(await autoStrategyDetail(new URL(request.url).searchParams.get("key") ?? ""), { headers: { "Cache-Control": "no-store" } });
});
