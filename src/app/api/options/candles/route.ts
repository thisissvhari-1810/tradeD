import { isChartSpan } from "@/lib/market/spans";
import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { loadOptionCandles } from "@/server/option-chain";

export const maxDuration = 30;

export const GET = query(async (request) => {
  await requireUser();
  const url = new URL(request.url);
  const timeframe = url.searchParams.get("timeframe");
  return Response.json(await loadOptionCandles({
    securityId: url.searchParams.get("securityId"),
    symbol: url.searchParams.get("symbol"),
    kind: url.searchParams.get("kind"),
    timeframe: isChartSpan(timeframe) ? timeframe : "1d",
  }));
});
