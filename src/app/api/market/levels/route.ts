import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getReplay, getS1Data } from "@/server/market";

export const maxDuration = 30;

/**
 * Session price levels for Line Strategy Draw (previous day high / low / close, the open, the 09:15 candle): the same
 * exchange data and server cache the Strategy uses (getS1Data), returned read-only. Any signed-in user may draw these
 * levels; the automatic Strategy overlay and algo remain Premium (/api/market/s1).
 *   ?date=YYYY-MM-DD      the current day (default: the latest session)
 *   ?previous=YYYY-MM-DD  the previous day (default: the session before the current day)
 *   ?tape=1               also the current day's 1-minute candles (hourly, 13:15 and channel lines)
 */
export const GET = query(async (request) => {
  await requireUser();
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") ?? "";
  const date = url.searchParams.get("date");
  const previous = url.searchParams.get("previous");
  const data = await getS1Data(symbol, date || null, previous || null);
  if (url.searchParams.get("tape") !== "1" || data.status === "unavailable" || data.status === "closed") return Response.json(data);
  // The day the levels are for (before 09:15 that can be the last session): its own candles only.
  const tape = await getReplay(symbol, data.date).then((replay) => replay.tape).catch(() => []);
  return Response.json({ ...data, tape });
});
