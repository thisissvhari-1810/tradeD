import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { createDhanClient } from "@/lib/dhan/client";
import { parseOptionLedgerSymbol } from "@/lib/options/contract";
import { marketDataEnabled } from "@/lib/security/flags";
import { requireUser } from "@/server/auth";
import { query } from "@/server/http";
import { configuredProvider, getDhanAccessToken, getDhanClientId } from "@/server/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

type Prices = { asOf: string; prices: Record<string, number> };

/**
 * Last traded prices for option contracts, so open paper positions revalue every couple of seconds.
 * Dhan's quote API allows about one request per second, so identical requests share a 1-second cache.
 */
const cache = new Map<string, { at: number; value: Prices }>();
const CACHE_MS = 1000;

function segmentFor(underlying: string) {
  return underlying === "SENSEX" || underlying === "BANKEX" ? "BSE_FNO" : "NSE_FNO";
}

export const GET = query(async (request) => {
  await requireUser();
  if (!marketDataEnabled() || configuredProvider() !== "dhan") throw new AppError("Live prices are not configured.", 503, "MARKET_DATA_DISABLED");
  const symbols = [...new Set(new URL(request.url).searchParams.getAll("s"))].filter((symbol) => parseOptionLedgerSymbol(symbol)).slice(0, 25);
  if (symbols.length === 0) return Response.json({ asOf: new Date().toISOString(), prices: {} } satisfies Prices);

  const key = [...symbols].sort().join(",");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Response.json(hit.value, { headers: { "Cache-Control": "no-store" } });

  const instruments = await prisma.instrument.findMany({ where: { symbol: { in: symbols } }, select: { symbol: true, dhanSecurityId: true } });
  const bySegment = new Map<string, Map<string, string>>();
  for (const row of instruments) {
    const contract = parseOptionLedgerSymbol(row.symbol);
    if (!contract || !/^\d{1,12}$/.test(row.dhanSecurityId)) continue;
    const segment = segmentFor(contract.underlying);
    if (!bySegment.has(segment)) bySegment.set(segment, new Map());
    bySegment.get(segment)!.set(row.dhanSecurityId, row.symbol);
  }
  const prices: Record<string, number> = {};
  if (bySegment.size > 0) {
    const clientId = await getDhanClientId();
    if (!clientId) throw new AppError("The market-data client id is not set.", 503, "MARKET_DATA_DISABLED");
    const client = createDhanClient({ clientId, accessToken: await getDhanAccessToken() }, { timeoutMs: 6000 });
    const body = Object.fromEntries([...bySegment].map(([segment, ids]) => [segment, [...ids.keys()].map(Number)]));
    const payload = await client.post<{ data?: Record<string, Record<string, { last_price?: number }>> }>("/marketfeed/ltp", body);
    for (const [segment, ids] of bySegment) {
      for (const [id, symbol] of ids) {
        const last = payload?.data?.[segment]?.[id]?.last_price;
        if (typeof last === "number" && Number.isFinite(last) && last > 0) prices[symbol] = last;
      }
    }
  }
  const value: Prices = { asOf: new Date().toISOString(), prices };
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
  return Response.json(value, { headers: { "Cache-Control": "no-store" } });
});
