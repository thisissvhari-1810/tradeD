import { practiceModeOf } from "@/server/practice-account";
import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { listClosedTrades } from "@/server/closed-trades";

export const GET = query(async (request) => {
  const user = await requireUser();
  const scope = new URL(request.url).searchParams.get("scope");
  return Response.json({ trades: await listClosedTrades(user, scope, practiceModeOf(request)) });
});
