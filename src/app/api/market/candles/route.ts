import { isChartSpan } from "@/lib/market/spans";
import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getCandles, getReplay } from "@/server/market";

export const maxDuration = 30;

export const GET = query(async (request) => {
  await requireUser();
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? "";
  const timeframe = url.searchParams.get("timeframe");
  const date = url.searchParams.get("date");
  if (date) return Response.json(await getReplay(symbol, date));
  return Response.json(await getCandles(symbol, isChartSpan(timeframe) ? timeframe : "1d"));
});
