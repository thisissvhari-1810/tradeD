import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getS1Data } from "@/server/market";
import { requirePremium } from "@/server/premium";

export const maxDuration = 30;

/** Strategy levels: today, or ?date=YYYY-MM-DD; ?previous=YYYY-MM-DD picks the previous day (else the last session before). */
export const GET = query(async (request) => {
  // The Strategy overlay is a Premium capability (checked here, not only by hiding the button).
  requirePremium(await requireUser(), "strategy");
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? "";
  const date = url.searchParams.get("date");
  const previous = url.searchParams.get("previous");
  return Response.json(await getS1Data(symbol, date || null, previous || null));
});
