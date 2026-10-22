import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getS1Data } from "@/server/market";

export const maxDuration = 30;

/** S1 strategy levels for a symbol: today, or ?date=YYYY-MM-DD for a replay session. */
export const GET = query(async (request) => {
  await requireUser();
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? "";
  const date = url.searchParams.get("date");
  return Response.json(await getS1Data(symbol, date || null));
});
