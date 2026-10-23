import { requireFeature } from "@/lib/auth/features";
import { isHorizon, buildForecast } from "@/lib/market/forecast";
import { isChartSpan } from "@/lib/market/spans";
import { AppError } from "@/lib/http";
import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getCandles } from "@/server/market";
import { getHolidays } from "@/server/settings";
import { requirePremium } from "@/server/premium";

export const maxDuration = 30;

export const GET = query(async (request) => {
  const user = await requireUser();
  requireFeature(user, "analytics");
  requirePremium(user, "analytics");
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  const timeframe = url.searchParams.get("timeframe");
  const horizon = url.searchParams.get("horizon");
  if (!symbol || !isChartSpan(timeframe) || !isHorizon(horizon)) throw new AppError("Choose a symbol, a supported timeframe, and a forecast horizon.", 400);
  const book = await getCandles(symbol, timeframe);
  if (book.mode === "DEMO" || book.source === "tradelab-demo") {
    const blocked = buildForecast({ symbol, timeframe, horizon, candles: [], dataMode: book.mode, dataMessage: book.message });
    return Response.json({ ...blocked, status: "unavailable", message: "These candles are synthetic. A forecast is not generated from synthetic history.", candles: [] });
  }
  const holidays = await getHolidays();
  const result = buildForecast({
    symbol,
    timeframe,
    horizon,
    candles: book.candles,
    holidays,
    dataMode: book.mode,
    dataMessage: book.message,
  });
  return Response.json({ ...result, candles: book.candles });
});
