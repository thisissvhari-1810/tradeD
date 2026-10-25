import { requireFeature } from "@/lib/auth/features";
import { viewModeOf } from "@/server/practice-account";
import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { listClosedTrades } from "@/server/closed-trades";

export const GET = query(async (request) => {
  const user = await requireUser();
  requireFeature(user, "orderHistory");
  const scope = new URL(request.url).searchParams.get("scope");
  return Response.json({ trades: await listClosedTrades(user, scope, viewModeOf(request)) });
});
