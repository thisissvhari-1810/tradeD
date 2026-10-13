import { isChartSpan } from "@/lib/market/spans";
import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getCandles } from "@/server/market";

export const GET = query(async (request) => {
  await requireUser();
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? "";
  const timeframe = url.searchParams.get("timeframe");
  return Response.json(await getCandles(symbol, isChartSpan(timeframe) ? timeframe : "1d"));
});
