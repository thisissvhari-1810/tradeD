import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getQuotes } from "@/server/market";
import { publicQuote } from "@/server/public-quote";

export const GET = query(async (request) => {
  await requireUser();
  const raw = new URL(request.url).searchParams.get("symbols") ?? "";
  const symbols = raw.split(",").map((symbol) => symbol.trim()).filter(Boolean);
  const rows = await getQuotes(symbols);
  return Response.json({
    quotes: rows.map((row) => ("error" in row ? { symbol: row.symbol, error: row.error } : publicQuote(row))),
  });
});
