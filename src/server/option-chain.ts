import { findIndex, type IndexUnderlying } from "@/lib/market/indices";
import { nseScrip } from "@/server/dhan-market";
import { getDhanAccessToken } from "@/server/settings";

export type ChainSide = {
  ltp: number | null;
  oi: number | null;
  previousOi: number | null;
  oiChangePct: number | null;
  volume: number | null;
  iv: number | null;
  bid: number | null;
  ask: number | null;
};

export type ChainStrike = { strike: number; ce: ChainSide | null; pe: ChainSide | null };

export type OptionChainView = {
  symbol: string;
  name: string;
  kind: "index" | "equity";
  available: boolean;
  message: string;
  asOf: string;
  spot: number | null;
  expiry: string | null;
  expiries: string[];
  lotSize: number | null;
  daysToExpiry: number | null;
  pcr: number | null;
  atmStrike: number | null;
  atmIv: number | null;
  strikes: ChainStrike[];
};

const expiryCache = new Map<string, { at: number; segment: string; expiries: string[] }>();
const chainCache = new Map<string, { at: number; view: OptionChainView }>();
let nextSlot = 0;
let gate: Promise<void> = Promise.resolve();

export async function loadOptionChain(symbol: string, expiry: string | null, now = new Date()): Promise<OptionChainView> {
  const resolved = resolveUnderlying(symbol);
  if (!resolved) {
    return empty(symbol.toUpperCase(), symbol.toUpperCase(), "equity", "This symbol is not on the NSE equity or index list.");
  }
  const requested = expiry && /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry : "";
  const cached = chainCache.get(`${resolved.id}:${requested}`);
  if (cached && Date.now() - cached.at < 20_000) return cached.view;
  const book = await expiriesFor(resolved);
  resolved.segment = book.segment;
  const upcoming = book.expiries.filter((day) => day >= istDay(now)).sort();
  const chosen = upcoming.includes(requested) ? requested : upcoming[0] ?? null;
  if (!chosen) {
    const view = empty(resolved.symbol, resolved.name, resolved.kind, `${resolved.name} has no listed option expiry. The price list can still show the symbol.`);
    chainCache.set(`${resolved.id}:`, { at: Date.now(), view });
    return view;
  }
  const hit = chainCache.get(`${resolved.id}:${chosen}`);
  if (hit && Date.now() - hit.at < 20_000) return hit.view;
  const payload = await paced(() => chainPost("/optionchain", { UnderlyingScrip: Number(resolved.id), UnderlyingSeg: resolved.segment, Expiry: chosen }));
  const parsed = parseOptionChain(payload, chosen, null);
  const view: OptionChainView = {
    symbol: resolved.symbol,
    name: resolved.name,
    kind: resolved.kind,
    available: parsed.strikes.length > 0,
    message: parsed.strikes.length
      ? "Live option chain. This view does not send contract orders."
      : `No strikes were returned for ${resolved.name} ${chosen}.`,
    asOf: now.toISOString(),
    spot: parsed.spot,
    expiry: chosen,
    expiries: upcoming,
    lotSize: parsed.lotSize,
    daysToExpiry: daysUntil(chosen, now),
    pcr: parsed.pcr,
    atmStrike: parsed.atmStrike,
    atmIv: parsed.atmIv,
    strikes: parsed.strikes,
  };
  chainCache.set(`${resolved.id}:${chosen}`, { at: Date.now(), view });
  chainCache.set(`${resolved.id}:${requested}`, { at: Date.now(), view });
  return view;
}

export function parseOptionChain(payload: unknown, expiry: string, fallbackSpot: number | null) {
  const root = asRecord(payload);
  const data = asRecord(root.data ?? root);
  const spot = numberAt(data, ["last_price", "lastPrice", "underlyingValue"]) ?? fallbackSpot;
  const oc = asRecord(data.oc ?? data.optionChain ?? data.chain);
  const strikes: ChainStrike[] = [];
  let lotSize: number | null = null;
  let callOi = 0;
  let putOi = 0;
  for (const [strikeKey, row] of Object.entries(oc)) {
    const strike = Number(strikeKey);
    if (!Number.isFinite(strike)) continue;
    const record = asRecord(row);
    const ce = sideOf(asRecord(record.ce ?? record.CE));
    const pe = sideOf(asRecord(record.pe ?? record.PE));
    for (const side of [ce, pe]) {
      const lot = side?.lotSize;
      if (lot && lot > 0) lotSize = lot;
    }
    if (ce?.oi) callOi += ce.oi;
    if (pe?.oi) putOi += pe.oi;
    if (!ce && !pe) continue;
    strikes.push({ strike, ce: ce ? publicSide(ce) : null, pe: pe ? publicSide(pe) : null });
  }
  strikes.sort((a, b) => a.strike - b.strike);
  const atm = spot == null ? null : strikes.reduce<ChainStrike | null>((best, row) => {
    if (!best) return row;
    return Math.abs(row.strike - spot) < Math.abs(best.strike - spot) ? row : best;
  }, null);
  const atmIv = atm?.ce?.iv ?? atm?.pe?.iv ?? null;
  const pcr = callOi > 0 && putOi > 0 ? putOi / callOi : null;
  return { spot, strikes, lotSize, pcr, atmStrike: atm?.strike ?? null, atmIv };
}

function resolveUnderlying(symbol: string): { symbol: string; name: string; id: string; segment: string; kind: "index" | "equity" } | null {
  const index = findIndex(symbol);
  if (index) return { ...index, segment: "IDX_I", kind: "index" };
  const equity = nseScrip(symbol);
  if (!equity) return null;
  return { symbol: symbol.trim().toUpperCase(), name: equity.name, id: equity.id, segment: "NSE_FNO", kind: "equity" };
}

async function expiriesFor(item: { id: string; segment: string; kind: "index" | "equity" }): Promise<{ segment: string; expiries: string[] }> {
  const key = `${item.kind}:${item.id}`;
  const hit = expiryCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return { segment: hit.segment, expiries: hit.expiries };
  const segments = item.kind === "index" ? ["IDX_I"] : ["NSE_FNO", "NSE_EQ"];
  let expiries: string[] = [];
  let segment = item.segment;
  for (const candidate of segments) {
    try {
      const payload = await paced(() => chainPost("/optionchain/expirylist", { UnderlyingScrip: Number(item.id), UnderlyingSeg: candidate }));
      const found = collectDates(payload).sort();
      if (found.length) {
        expiries = found;
        segment = candidate;
        break;
      }
    } catch {
      expiries = [];
    }
  }
  expiryCache.set(key, { at: Date.now(), segment, expiries });
  return { segment, expiries };
}

async function chainPost(path: string, body: unknown) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "access-token": await getDhanAccessToken(),
  };
  const clientId = process.env.DHAN_CLIENT_ID?.trim();
  if (clientId) headers["client-id"] = clientId;
  const response = await fetch(`https://api.dhan.co/v2${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as { errorMessage?: string; remarks?: string } | null;
  if (!response.ok) throw new Error(payload?.errorMessage || payload?.remarks || "Option chain request failed.");
  return payload;
}

function paced<T>(task: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const wait = Math.max(0, nextSlot - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    nextSlot = Date.now() + 3100;
    return task();
  });
  gate = run.then(() => undefined, () => undefined);
  return run;
}

function sideOf(quote: Record<string, unknown>) {
  if (!Object.keys(quote).length) return null;
  const ltp = numberAt(quote, ["last_price", "lastPrice", "ltp"]);
  const oi = numberAt(quote, ["oi", "openInterest"]);
  const previousOi = numberAt(quote, ["previous_oi", "previousOi"]);
  const oiChangePct = oi != null && previousOi != null && previousOi > 0 ? ((oi - previousOi) / previousOi) * 100 : null;
  return {
    ltp,
    oi,
    previousOi,
    oiChangePct,
    volume: numberAt(quote, ["volume"]),
    iv: numberAt(quote, ["implied_volatility", "iv"]),
    bid: numberAt(quote, ["top_bid_price", "bid", "bestBid"]),
    ask: numberAt(quote, ["top_ask_price", "ask", "bestAsk"]),
    lotSize: numberAt(quote, ["lot_size", "lotSize"]),
  };
}

function publicSide(side: NonNullable<ReturnType<typeof sideOf>>): ChainSide {
  return { ltp: side.ltp, oi: side.oi, previousOi: side.previousOi, oiChangePct: side.oiChangePct, volume: side.volume, iv: side.iv, bid: side.bid, ask: side.ask };
}

function empty(symbol: string, name: string, kind: "index" | "equity", message: string): OptionChainView {
  return {
    symbol, name, kind, available: false, message, asOf: new Date().toISOString(), spot: null, expiry: null, expiries: [],
    lotSize: null, daysToExpiry: null, pcr: null, atmStrike: null, atmIv: null, strikes: [],
  };
}

function daysUntil(expiry: string, now: Date) {
  const start = Date.parse(`${istDay(now)}T00:00:00Z`);
  const end = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

function istDay(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberAt(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function collectDates(value: unknown): string[] {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(collectDates);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectDates);
  return [];
}

export type { IndexUnderlying };
