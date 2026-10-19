import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { rupeesToPaise } from "@/lib/money";
import { findIndex, type IndexUnderlying } from "@/lib/market/indices";
import { optionLedgerSymbol } from "@/lib/options/contract";
import type { ChartSpan } from "@/lib/market/spans";
import { dhanOptionCandles, nseScrip } from "@/server/dhan-market";
import { optionLotSize } from "@/server/option-lots";
import { configuredProvider, getDhanAccessToken, getDhanClientId } from "@/server/settings";

export type ChainSide = {
  ltp: number | null;
  previousClose: number | null;
  oi: number | null;
  previousOi: number | null;
  oiChangePct: number | null;
  volume: number | null;
  iv: number | null;
  bid: number | null;
  ask: number | null;
  securityId: string | null;
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
const STALE_FALLBACK_MS = 90_000;
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
  let payload: unknown;
  try {
    payload = await paced(() => chainPost("/optionchain", { UnderlyingScrip: Number(resolved.id), UnderlyingSeg: resolved.segment, Expiry: chosen }));
  } catch (error) {
    // A recent snapshot keeps its original asOf, so the order records how old the price was.
    if (hit && Date.now() - hit.at < STALE_FALLBACK_MS) return hit.view;
    throw error;
  }
  const parsed = parseOptionChain(payload, chosen, null);
  let lotSize = parsed.lotSize;
  if (!lotSize) {
    const sample = parsed.strikes.find((row) => row.ce?.securityId || row.pe?.securityId);
    const securityId = sample?.ce?.securityId || sample?.pe?.securityId || "";
    lotSize = securityId ? await optionLotSize(securityId).catch(() => null) : null;
  }
  const view: OptionChainView = {
    symbol: resolved.symbol,
    name: resolved.name,
    kind: resolved.kind,
    available: parsed.strikes.length > 0,
    message: parsed.strikes.length
      ? lotSize
        ? "Option chain snapshot. A demo order fills at this snapshot and is not sent to a broker."
        : "Option chain snapshot. The contract master did not include a lot size, so a demo order cannot be sized."
      : `No strikes were returned for ${resolved.name} ${chosen}.`,
    asOf: now.toISOString(),
    spot: parsed.spot,
    expiry: chosen,
    expiries: upcoming,
    lotSize,
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
  let failure: unknown = null;
  for (const candidate of segments) {
    try {
      const payload = await paced(() => chainPost("/optionchain/expirylist", { UnderlyingScrip: Number(item.id), UnderlyingSeg: candidate }));
      const found = collectDates(payload).sort();
      if (found.length) {
        expiries = found;
        segment = candidate;
        break;
      }
    } catch (error) {
      failure = error;
    }
  }
  if (!expiries.length && failure) {
    if (hit?.expiries.length) return { segment: hit.segment, expiries: hit.expiries };
    throw failure;
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
  const clientId = await getDhanClientId();
  if (clientId) headers["client-id"] = clientId;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`https://api.dhan.co/v2${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
        cache: "no-store",
      });
    } catch {
      throw new AppError("The option price service did not respond. Wait a few seconds and refresh the price.", 503, "QUOTE_UNAVAILABLE");
    }
    const payload = (await response.json().catch(() => null)) as { errorMessage?: string; remarks?: string } | null;
    if (response.ok) return payload;
    if (response.status === 429 && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 3100));
      continue;
    }
    console.error(`option chain ${path} HTTP ${response.status}: ${payload?.errorMessage || payload?.remarks || "no message"}`);
    if (response.status === 429) throw new AppError("Option prices are being refreshed too often. Wait a few seconds and refresh the price.", 503, "QUOTE_RATE_LIMITED");
    if (response.status === 401 || response.status === 403) throw new AppError("The market-data connection was refused, so option prices are unavailable. An admin must renew the market-data token.", 503, "FEED_AUTH");
    throw new AppError("Option prices could not be loaded right now. Refresh the price and try again.", 503, "QUOTE_UNAVAILABLE");
  }
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
  const security = quote.security_id ?? quote.securityId;
  return {
    ltp,
    previousClose: numberAt(quote, ["previous_close_price", "previousClose"]),
    oi,
    previousOi,
    oiChangePct,
    volume: numberAt(quote, ["volume"]),
    iv: numberAt(quote, ["implied_volatility", "iv"]),
    bid: numberAt(quote, ["top_bid_price", "bid", "bestBid"]),
    ask: numberAt(quote, ["top_ask_price", "ask", "bestAsk"]),
    lotSize: numberAt(quote, ["lot_size", "lotSize"]),
    securityId: typeof security === "number" || typeof security === "string" ? String(security) : null,
  };
}

function publicSide(side: NonNullable<ReturnType<typeof sideOf>>): ChainSide {
  return { ltp: side.ltp, previousClose: side.previousClose, oi: side.oi, previousOi: side.previousOi, oiChangePct: side.oiChangePct, volume: side.volume, iv: side.iv, bid: side.bid, ask: side.ask, securityId: side.securityId };
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

export async function registerOptionContract(input: { underlying: string; expiry: string; strike: number; right: "CE" | "PE" }) {
  const chain = await loadOptionChain(input.underlying, input.expiry);
  if (!chain.available || chain.expiry !== input.expiry) throw new AppError(chain.message || "This expiry is not on the option chain.", 409);
  const row = chain.strikes.find((item) => item.strike === input.strike);
  const side = input.right === "CE" ? row?.ce : row?.pe;
  if (!row || !side?.securityId || !/^\d{1,12}$/.test(side.securityId)) throw new AppError("This contract has no market identifier, so it cannot be charted or saved.", 409);
  if (side.ltp == null || side.ltp <= 0) throw new AppError("This contract has no premium on the chain.", 409);
  if (!chain.lotSize) throw new AppError("The contract master did not include a lot size, so this contract cannot be saved.", 409);
  const base = Number(rupeesToPaise(side.ltp.toFixed(2)));
  if (!Number.isSafeInteger(base) || base <= 0 || base > 2_000_000_000) throw new AppError("This premium cannot be stored.", 409);
  const symbol = optionLedgerSymbol(chain.symbol, chain.expiry, row.strike, input.right);
  const name = `${chain.name} ${row.strike} ${input.right} · ${chain.expiry}`;
  await prisma.instrument.upsert({
    where: { symbol },
    update: { isActive: true, name, dhanSecurityId: side.securityId, ...(chain.lotSize ? { lotSize: chain.lotSize } : {}) },
    create: { symbol, name, exchange: "NSE", sector: "Option", lotSize: chain.lotSize, tickPaise: 5, isActive: true, dhanSecurityId: side.securityId, basePaise: base },
  });
  return { symbol, name, securityId: side.securityId, kind: chain.kind, ltp: side.ltp, expiry: chain.expiry, strike: row.strike, right: input.right, underlying: chain.symbol };
}

export async function loadOptionCandles(input: { securityId?: string | null; symbol?: string | null; kind?: string | null; timeframe: ChartSpan }) {
  if (configuredProvider() !== "dhan") throw new AppError("Option contract history is not available from the current market-data connection.", 503);
  let id = input.securityId?.trim() ?? "";
  let kind: "index" | "equity" = input.kind === "equity" ? "equity" : "index";
  if (!id && input.symbol) {
    const row = await prisma.instrument.findUnique({ where: { symbol: input.symbol } });
    const parts = input.symbol.split("|");
    if (row?.sector !== "Option" || !row.dhanSecurityId) throw new AppError("This option contract has no saved market identifier, so its chart cannot be loaded.", 404);
    id = row.dhanSecurityId;
    kind = findIndex(parts[0] ?? "") ? "index" : "equity";
  }
  if (!/^\d{1,12}$/.test(id)) throw new AppError("This option contract has no market identifier, so its chart cannot be loaded.", 404);
  const candles = await dhanOptionCandles(id, kind, input.timeframe, new Date());
  return {
    candles,
    mode: "HISTORICAL" as const,
    source: "market-data",
    message: "Candles for this option contract. They are not the underlying index, and they are not advanced by the replay clock.",
  };
}

export type { IndexUnderlying };
