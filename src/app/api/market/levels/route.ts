import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getS1Data } from "@/server/market";

export const maxDuration = 30;

/**
 * Session price levels for Line Strategy Draw (previous day high / low / close, the open, the 09:15 candle): the same
 * exchange data and server cache the Strategy uses (getS1Data), returned read-only. Any signed-in user may draw these
 * levels; the automatic Strategy overlay and algo remain Premium (/api/market/s1). ?date=YYYY-MM-DD for a past session.
 */
export const GET = query(async (request) => {
  await requireUser();
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? "";
  const date = url.searchParams.get("date");
  return Response.json(await getS1Data(symbol, date || null, null));
});
