import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getMarketMovers } from "@/server/market";

export const maxDuration = 30;

export const GET = query(async () => {
  await requireUser();
  return Response.json(await getMarketMovers());
});
