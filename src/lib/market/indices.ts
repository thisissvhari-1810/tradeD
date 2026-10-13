import book from "@/lib/market/nse-indices.json";

export type IndexUnderlying = { symbol: string; name: string; id: string };

const ROWS = book as IndexUnderlying[];
const BY_SYMBOL = new Map(ROWS.map((row) => [row.symbol, row]));

const FEATURED = ["NIFTY", "NIFTY100", "NIFTYNXT50", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "INDIAVIX"];

export const FEATURED_INDICES: IndexUnderlying[] = FEATURED.flatMap((symbol) => {
  const row = BY_SYMBOL.get(symbol);
  return row ? [row] : [];
});

export function findIndex(symbol: string): IndexUnderlying | null {
  const key = symbol.trim().toUpperCase().replace(/\s+/g, "");
  return BY_SYMBOL.get(key) ?? null;
}

export function searchIndices(query: string): IndexUnderlying[] {
  const q = query.trim().toLowerCase();
  const compact = q.replace(/\s+/g, "");
  if (!q) return FEATURED_INDICES;
  if (compact === "index" || compact === "indices") return ROWS;
  return ROWS.filter((row) => {
    const symbol = row.symbol.toLowerCase();
    const name = row.name.toLowerCase().replace(/\s+/g, "");
    if (symbol.includes(compact) || name.includes(compact) || row.name.toLowerCase().includes(q)) return true;
    if (compact === "nifty50" && row.symbol === "NIFTY") return true;
    if (compact === "nifty100" && row.symbol === "NIFTY100") return true;
    return false;
  });
}
