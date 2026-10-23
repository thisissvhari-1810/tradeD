import { AppError } from "@/lib/http";
import { applyAdverseSlippage, rupeesToPaise } from "@/lib/money";
import { nseCashSession } from "@/lib/market/clock";
import type { Candle, DemoQuote } from "@/lib/market/demo";
import { foldSessions, istDateKey } from "@/lib/market/fold-sessions";
import { daysBefore, intradayEnds } from "@/lib/market/dhan-ranges";
import nseEquity from "@/lib/market/nse-eq.json";
import { findIndex } from "@/lib/market/indices";
import { DEFAULT_CHARGES } from "@/lib/trading/settings";
import { getDhanAccessToken, getDhanClientId } from "@/server/settings";
import { aggregateCount, aggregateMinutes, aggregatePeriod, type ChartSpan } from "@/lib/market/spans";

/** Kept for the renamed Tata Motors passenger-vehicle scrip. The live book is the Dhan NSE equity master. */
const SECURITY_ID: Record<string, string> = {
  TATAMOTORS: "3456",
};

const NSE_EQ = nseEquity as Record<string, { id: string; name: string }>;

export function nseScrip(symbol: string): { id: string; name: string } | null {
  const key = symbol.trim().toUpperCase();
  if (!key || key.includes("NSETEST")) return null;
  return NSE_EQ[key] ?? (SECURITY_ID[key] ? { id: SECURITY_ID[key], name: key } : null);
}

type Series = { open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[]; timestamp?: number[] };

function securityId(symbol: string, stored = "") {
  const id = stored.trim() || nseScrip(symbol)?.id;
  if (!id) throw new AppError(`${symbol} is not on the NSE equity list.`, 404);
  return id;
}

export function feedTarget(symbol: string, stored = ""): { securityId: string; segment: "IDX_I" | "NSE_EQ" } {
  const index = findIndex(symbol);
  if (index) return { securityId: index.id, segment: "IDX_I" };
  return { securityId: securityId(symbol, stored), segment: "NSE_EQ" };
}

function istStamp(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const day = `${read("year")}-${read("month")}-${read("day")}`;
  return { day, stamp: `${day} ${read("hour")}:${read("minute")}:${read("second")}` };
}

async function dhanPost(path: string, body: unknown) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "access-token": await getDhanAccessToken(),
  };
  const clientId = await getDhanClientId();
  if (clientId) headers["client-id"] = clientId;
  const response = await fetch(`https://api.dhan.co/v2${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as { errorMessage?: string; remarks?: string; errorCode?: string; errorType?: string } | null;
  if (!response.ok) {
    // Name the request (never the token) so a rejected parameter can be traced from the message on screen.
    const reason = payload?.errorMessage || payload?.remarks || `Market data returned ${response.status}.`;
    const detail = `${payload?.errorCode ?? `HTTP ${response.status}`} on ${path}: ${describeRequest(body)}`;
    console.error("[dhan] request refused", { path, status: response.status, errorCode: payload?.errorCode, errorType: payload?.errorType, reason, request: describeRequest(body) });
    throw new AppError(`${reason} (${detail})`, 502);
  }
  return payload;
}

/** The request's identifying fields for error messages: security, segment, interval and dates only. */
function describeRequest(body: unknown) {
  if (!body || typeof body !== "object") return "";
  const row = body as Record<string, unknown>;
  return ["securityId", "exchangeSegment", "instrument", "interval", "fromDate", "toDate"]
    .filter((key) => row[key] != null)
    .map((key) => `${key}=${String(row[key])}`)
    .join(" ");
}

function candlesFromSeries(series: Series): Candle[] {
  const times = series.timestamp ?? [];
  const candles: Candle[] = [];
  times.forEach((time, index) => {
    const open = series.open?.[index];
    const high = series.high?.[index];
    const low = series.low?.[index];
    const close = series.close?.[index];
    const seconds = time > 10_000_000_000 ? Math.floor(time / 1000) : time;
    if (open == null || high == null || low == null || close == null) return;
    if (![seconds, open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) return;
    candles.push({ time: seconds, open, high, low, close, volume: Math.max(0, Number(series.volume?.[index] ?? 0)) });
  });
  return candles;
}

/** End dates to try for a daily request: as asked, then today, then yesterday (each only if earlier). */
export function dailyEndDates(to: Date, now: Date): Date[] {
  const ends = [to];
  for (const candidate of [0, 1, 2, 3].map((days) => new Date(now.getTime() - days * 86_400_000))) {
    if (istStamp(candidate).day < istStamp(ends[ends.length - 1]).day) ends.push(candidate);
  }
  return ends;
}

async function dailyHistory(id: string, from: Date, to: Date, segment = "NSE_EQ", instrument = "EQUITY") {
  // The end date is exclusive, so callers pass tomorrow to include today. The provider has refused that
  // before the open, and has refused a 2005 start ("Missing required fields, bad values for
  // parameters", DH-905). So earlier ends are tried, and for each a start no older than 5 years, then
  // 1 year. Sessions an earlier end leaves out are folded from intraday bars by withRecentSessions.
  let failure: unknown = null;
  for (const end of dailyEndDates(to, new Date())) {
    for (const start of dailyStartDates(from, end)) {
      try {
        const series = (await dhanPost("/charts/historical", {
          securityId: id,
          exchangeSegment: segment,
          instrument,
          expiryCode: 0,
          oi: false,
          fromDate: istStamp(start).day,
          toDate: istStamp(end).day,
        })) as Series;
        return candlesFromSeries(series).sort((a, b) => a.time - b.time);
      } catch (error) {
        failure = error;
        if (!(error instanceof AppError)) throw error;
      }
    }
  }
  throw failure;
}

/** Start dates to try for a daily request: as asked, then 5 years and 1 year before the end (only if later). */
export function dailyStartDates(from: Date, end: Date): Date[] {
  const starts = [from];
  for (const years of [5, 1]) {
    const candidate = new Date(end.getTime() - years * 365 * 86_400_000);
    if (candidate.getTime() > starts[starts.length - 1].getTime()) starts.push(candidate);
  }
  return starts;
}

const sessionCloseCache = new Map<string, { close: number; at: number }>();

/** Prior session close. Live last price is measured against this so the percent is today's move. */
export async function sessionPreviousClose(id: string, now: Date): Promise<number | null> {
  const hit = sessionCloseCache.get(id);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.close;
  const from = new Date(now.getTime() - 12 * 86_400_000);
  const candles = await dailyHistory(id, from, new Date(now.getTime() + 86_400_000));
  if (!candles.length) return null;
  const today = istStamp(now).day;
  const lastBar = candles[candles.length - 1];
  const lastDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(lastBar.time * 1000));
  const close = lastDay === today && candles.length >= 2 ? candles[candles.length - 2].close : lastBar.close;
  if (!close || !Number.isFinite(close) || close <= 0) return null;
  sessionCloseCache.set(id, { close, at: Date.now() });
  return close;
}

async function intradayHistory(id: string, interval: "1" | "5" | "15" | "60", from: Date, to: Date, segment = "NSE_EQ", instrument = "EQUITY") {
  const now = new Date();
  const until = istStamp(to.getTime() > now.getTime() ? now : to).stamp;
  const first = `${istStamp(from).day} 09:15:00`;
  let failure: unknown = null;
  for (const end of intradayEnds(until)) {
    // The full range first; if refused, the last 5 days before that end.
    const short = `${daysBefore(end, 5)} 09:15:00`;
    for (const start of short > first ? [first, short] : [first]) {
      if (start >= end) continue;
      try {
        const series = (await dhanPost("/charts/intraday", {
          securityId: id,
          exchangeSegment: segment,
          instrument,
          interval,
          oi: false,
          fromDate: start,
          toDate: end,
        })) as Series;
        return candlesFromSeries(series).sort((a, b) => a.time - b.time);
      } catch (error) {
        failure = error;
        if (!(error instanceof AppError)) throw error;
      }
    }
  }
  throw failure ?? new AppError("No intraday range was available to request.", 502);
}

/**
 * The daily history can lag: the last session (and today's) may not be published yet. Sessions after
 * the last daily bar are folded from that session's 5-minute bars (open of the first, close of the
 * last, highest high, lowest low, summed volume) and stamped like the provider's daily bars.
 */
export async function withRecentSessions(daily: Candle[], id: string, segment: string, kind: string, now: Date): Promise<Candle[]> {
  const last = daily.at(-1);
  const lastDay = last ? istDateKey(last.time) : "";
  let minutes: Candle[] = [];
  try {
    minutes = await intradayHistory(id, "5", new Date(now.getTime() - 7 * 86_400_000), now, segment, kind);
  } catch {
    return daily;
  }
  return [...daily, ...foldSessions(minutes, lastDay, last?.time ?? null)];
}

export async function dhanSessionTape(symbol: string, storedSecurityId: string, open: number, close: number): Promise<Candle[]> {
  const index = findIndex(symbol);
  const id = index?.id ?? securityId(symbol, storedSecurityId);
  const segment = index ? "IDX_I" : "NSE_EQ";
  const kind = index ? "INDEX" : "EQUITY";
  // The history end is exclusive. Stopping at 15:30 drops that session, so the request runs through the next morning and the caller keeps one date.
  const to = new Date((close + 17 * 60 * 60) * 1000);
  // The start is sent as "<day> 09:15:00". Starting the request on the session day itself can leave the
  // 09:15 bar on the edge of the range (the first bar returned was 09:16), so it starts three days earlier
  // and the caller keeps only the selected date. If the provider refuses the wider range, the original
  // same-day request is used.
  try {
    return await intradayHistory(id, "1", new Date((open - 3 * 86_400) * 1000), to, segment, kind);
  } catch {
    return intradayHistory(id, "1", new Date(open * 1000), to, segment, kind);
  }
}

/** One-minute bars that end before the selected open. The selected session is not part of this request. */
export async function dhanContextMinutes(symbol: string, storedSecurityId: string, open: number): Promise<Candle[]> {
  const index = findIndex(symbol);
  const id = index?.id ?? securityId(symbol, storedSecurityId);
  const segment = index ? "IDX_I" : "NSE_EQ";
  const kind = index ? "INDEX" : "EQUITY";
  const from = new Date((open - 30 * 86_400) * 1000);
  return intradayHistory(id, "1", from, new Date(open * 1000), segment, kind);
}

export async function dhanPriorDaily(symbol: string, storedSecurityId: string, open: number): Promise<Candle[]> {
  const index = findIndex(symbol);
  const id = index?.id ?? securityId(symbol, storedSecurityId);
  const segment = index ? "IDX_I" : "NSE_EQ";
  const kind = index ? "INDEX" : "EQUITY";
  const end = new Date(open * 1000);
  const start = new Date(end.getTime() - 6 * 365 * 86_400_000);
  // The daily end date is exclusive. Ending on the previous calendar day drops that session, so the request includes the selected morning and the caller keeps earlier dates.
  // Sessions the daily history has not published yet are folded from intraday bars.
  return withRecentSessions(await dailyHistory(id, start, end, segment, kind), id, segment, kind, end);
}

/** One session of one-minute option candles for a single contract. */
export async function dhanOptionSession(id: string, kind: "index" | "equity", open: number, close: number) {
  if (!/^\d{1,12}$/.test(id)) throw new AppError("This option contract has no market identifier.", 404);
  const to = new Date((close + 17 * 60 * 60) * 1000);
  return intradayHistory(id, "1", new Date(open * 1000), to, "NSE_FNO", kind === "index" ? "OPTIDX" : "OPTSTK");
}

export async function dhanOptionCandles(id: string, kind: "index" | "equity", timeframe: ChartSpan, now: Date) {
  if (!/^\d{1,12}$/.test(id)) throw new AppError("This option contract has no market identifier.", 404);
  const segment = "NSE_FNO";
  const instrument = kind === "index" ? "OPTIDX" : "OPTSTK";
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (timeframe === "1m" || timeframe === "3m" || timeframe === "5m" || timeframe === "15m" || timeframe === "30m" || timeframe === "1h" || timeframe === "2h" || timeframe === "4h") {
    const days = timeframe === "1m" || timeframe === "3m" ? 30 : 90;
    const from = new Date(now.getTime() - days * 86_400_000);
    const interval = timeframe === "1h" || timeframe === "2h" || timeframe === "4h" ? "60" : timeframe === "15m" || timeframe === "30m" ? "15" : timeframe === "5m" ? "5" : "1";
    let candles = await intradayHistory(id, interval, from, now, segment, instrument);
    if (timeframe === "3m") candles = aggregateMinutes(candles, 3);
    if (timeframe === "30m") candles = aggregateMinutes(candles, 30);
    if (timeframe === "2h") candles = aggregateCount(candles, 2);
    if (timeframe === "4h") candles = aggregateCount(candles, 4);
    if (!candles.length) throw new AppError("Historical candles were not returned for this option contract.", 502);
    return candles;
  }
  const from = timeframe === "1y" ? new Date(now.getTime() - 370 * 86_400_000) : timeframe === "5y" ? new Date(now.getTime() - 5 * 365 * 86_400_000) : new Date(Date.UTC(2005, 0, 1));
  let candles = await dailyHistory(id, from, tomorrow, segment, instrument);
  if (timeframe === "1w") candles = aggregatePeriod(candles, "week");
  if (timeframe === "1mo") candles = aggregatePeriod(candles, "month");
  if (!candles.length) throw new AppError("Historical candles were not returned for this option contract.", 502);
  return candles;
}

export async function dhanCandles(symbol: string, storedSecurityId: string, timeframe: ChartSpan, now: Date) {
  const index = findIndex(symbol);
  const id = index?.id ?? securityId(symbol, storedSecurityId);
  const segment = index ? "IDX_I" : "NSE_EQ";
  const kind = index ? "INDEX" : "EQUITY";
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (timeframe === "1m" || timeframe === "3m" || timeframe === "5m" || timeframe === "15m" || timeframe === "30m" || timeframe === "1h" || timeframe === "2h" || timeframe === "4h") {
    const days = timeframe === "1m" || timeframe === "3m" ? 30 : 90;
    const from = new Date(now.getTime() - days * 86_400_000);
    const interval = timeframe === "1h" || timeframe === "2h" || timeframe === "4h" ? "60" : timeframe === "15m" || timeframe === "30m" ? "15" : timeframe === "5m" ? "5" : "1";
    let candles = await intradayHistory(id, interval, from, now, segment, kind);
    if (timeframe === "3m") candles = aggregateMinutes(candles, 3);
    if (timeframe === "30m") candles = aggregateMinutes(candles, 30);
    if (timeframe === "2h") candles = aggregateCount(candles, 2);
    if (timeframe === "4h") candles = aggregateCount(candles, 4);
    if (!candles.length) throw new AppError("Intraday candles were not returned for this symbol.", 502);
    const label = timeframe === "1m" ? "1-minute" : timeframe === "3m" ? "3-minute" : timeframe === "5m" ? "5-minute" : timeframe === "15m" ? "15-minute" : timeframe === "30m" ? "30-minute" : timeframe === "2h" ? "2-hour bars aggregated from 1-hour candles" : timeframe === "4h" ? "4-hour bars aggregated from 1-hour candles" : "1-hour";
    return { candles, mode: "HISTORICAL" as const, source: "dhan", message: `${label} for the last ${days} days. Practice orders stay on the virtual ledger.` };
  }
  const from = timeframe === "1y"
    ? new Date(now.getTime() - 370 * 86_400_000)
    : timeframe === "5y"
      ? new Date(now.getTime() - 5 * 365 * 86_400_000)
      : new Date(Date.UTC(2005, 0, 1));
  let candles = await withRecentSessions(await dailyHistory(id, from, tomorrow, segment, kind), id, segment, kind, now);
  if (timeframe === "1w") candles = aggregatePeriod(candles, "week");
  if (timeframe === "1mo") candles = aggregatePeriod(candles, "month");
  if (!candles.length) throw new AppError("Daily candles were not returned for this symbol.", 502);
  const span = timeframe === "1y" ? "one year" : timeframe === "5y" ? "five years" : timeframe === "1w" ? "weekly bars from the daily history" : timeframe === "1mo" ? "monthly bars from the daily history" : "the daily history since 2005";
  return { candles, mode: "HISTORICAL" as const, source: "dhan", message: `Candles for ${span}. Practice orders stay on the virtual ledger.` };
}

const INDEX_IDS = [
  { id: "13", name: "Nifty 50" },
  { id: "25", name: "Nifty Bank" },
  { id: "21", name: "India VIX" },
];

type IndexFeed = { last_price?: number; net_change?: number; ohlc?: { open?: number; close?: number; high?: number; low?: number } };

let indexCache: { at: number; value: { indices: Array<{ name: string; last: number; previous: number | null }>; message: string } } | null = null;

export async function dhanIndices() {
  if (indexCache && Date.now() - indexCache.at < 15000) return indexCache.value;
  const clientId = await getDhanClientId();
  if (!clientId) return { indices: [], message: "The account client id is required for the index strip." };
  let payload: { data?: { IDX_I?: Record<string, IndexFeed> } } | null = null;
  try {
    payload = (await dhanPost("/marketfeed/quote", { IDX_I: INDEX_IDS.map((item) => Number(item.id)) })) as { data?: { IDX_I?: Record<string, IndexFeed> } };
  } catch {
    payload = (await dhanPost("/marketfeed/ohlc", { IDX_I: INDEX_IDS.map((item) => Number(item.id)) })) as { data?: { IDX_I?: Record<string, IndexFeed> } };
  }
  const book = payload.data?.IDX_I ?? {};
  const now = new Date();
  const indices = [];
  for (const item of INDEX_IDS) {
    const row = book[item.id];
    const last = row?.last_price;
    if (!last || !Number.isFinite(last)) continue;
    let previous = indexPrevious(row, last);
    if (previous == null || Math.abs(previous - last) < 0.001) previous = await priorIndexClose(item.id, last, now);
    indices.push({ name: item.name, last, previous });
  }
  const value = { indices, message: indices.length ? "Index quote." : "Index prices were not returned." };
  indexCache = { at: Date.now(), value };
  return value;
}

function indexPrevious(row: IndexFeed | undefined, last: number): number | null {
  if (!row) return null;
  if (typeof row.net_change === "number" && Number.isFinite(row.net_change) && row.net_change !== 0) {
    const previous = last - row.net_change;
    return previous > 0 ? previous : null;
  }
  const close = row.ohlc?.close;
  if (close && Number.isFinite(close) && close > 0 && Math.abs(close - last) > 0.001) return close;
  return null;
}

const priorIndexMemo = new Map<string, { at: number; close: number | null }>();

async function priorIndexClose(id: string, last: number, now: Date): Promise<number | null> {
  const hit = priorIndexMemo.get(id);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.close;
  try {
    const from = new Date(now.getTime() - 14 * 86_400_000);
    const series = (await dhanPost("/charts/historical", {
      securityId: id,
      exchangeSegment: "IDX_I",
      instrument: "INDEX",
      expiryCode: 0,
      oi: false,
      fromDate: istStamp(from).day,
      toDate: istStamp(new Date(now.getTime() + 86_400_000)).day,
    })) as Series;
    const candles = candlesFromSeries(series).sort((a, b) => a.time - b.time);
    let close: number | null = null;
    for (let index = candles.length - 1; index >= 0; index -= 1) {
      if (Math.abs(candles[index].close - last) > Math.max(0.05, last * 0.00001)) {
        close = candles[index].close;
        break;
      }
    }
    if (close == null && candles.length >= 2) close = candles[candles.length - 2].close;
    priorIndexMemo.set(id, { at: Date.now(), close });
    return close;
  } catch {
    return null;
  }
}

export async function dhanIndexQuotes(symbols: string[], now: Date, holidays: string[]): Promise<DemoQuote[]> {
  const items = symbols.flatMap((symbol) => {
    const index = findIndex(symbol);
    return index ? [index] : [];
  });
  if (!items.length) return [];
  let book: Record<string, IndexFeed> = {};
  try {
    const payload = (await dhanPost("/marketfeed/quote", { IDX_I: items.map((item) => Number(item.id)) })) as { data?: { IDX_I?: Record<string, IndexFeed> } };
    book = payload.data?.IDX_I ?? {};
  } catch {
    const payload = (await dhanPost("/marketfeed/ohlc", { IDX_I: items.map((item) => Number(item.id)) })) as { data?: { IDX_I?: Record<string, IndexFeed> } };
    book = payload.data?.IDX_I ?? {};
  }
  const quotes: DemoQuote[] = [];
  for (const item of items) {
    const row = book[item.id];
    const last = row?.last_price;
    if (!last || !Number.isFinite(last)) continue;
    let previous = indexPrevious(row, last);
    if (previous == null) previous = await priorIndexClose(item.id, last, now);
    quotes.push(indexQuote(item.symbol, last, previous, row, now, holidays));
  }
  return quotes;
}

function indexQuote(symbol: string, last: number, previous: number | null, row: IndexFeed | undefined, now: Date, holidays: string[]): DemoQuote {
  const session = nseCashSession(now, holidays);
  const lastPaise = rupeesToPaise(last.toFixed(2));
  const spread = Math.max(1, DEFAULT_CHARGES.spreadBps);
  const price = (value: number | undefined) => (value && Number.isFinite(value) && value > 0 ? rupeesToPaise(value.toFixed(2)) : lastPaise);
  return {
    symbol,
    lastPaise,
    bidPaise: applyAdverseSlippage(lastPaise, "SELL", Math.floor(spread / 2), 5n),
    askPaise: applyAdverseSlippage(lastPaise, "BUY", Math.ceil(spread / 2), 5n),
    openPaise: price(row?.ohlc?.open),
    highPaise: price(row?.ohlc?.high),
    lowPaise: price(row?.ohlc?.low),
    previousClosePaise: previous && previous > 0 ? rupeesToPaise(previous.toFixed(2)) : lastPaise,
    volume: 0n,
    asOf: now,
    mode: "REALTIME",
    source: "dhan",
    marketOpen: session.open,
    message: "Index price. Practice orders stay on the virtual ledger.",
  };
}

export async function dhanQuote(symbol: string, storedSecurityId: string, now: Date, holidays: string[]): Promise<DemoQuote> {
  const index = findIndex(symbol);
  if (index) {
    const [quote] = await dhanIndexQuotes([index.symbol], now, holidays);
    if (!quote) throw new AppError("No index price was returned.", 502);
    return quote;
  }
  const id = securityId(symbol, storedSecurityId);
  const session = nseCashSession(now, holidays);
  const clientId = await getDhanClientId();
  const spread = Math.max(1, DEFAULT_CHARGES.spreadBps);
  if (!clientId) {
    const history = await dhanCandles(symbol, storedSecurityId, "1d", now);
    const last = history.candles.at(-1);
    const previous = history.candles.at(-2) ?? last;
    if (!last || !previous) throw new AppError("No price was returned for this symbol.", 502);
    const lastPaise = rupeesToPaise(last.close.toFixed(2));
    return {
      symbol,
      lastPaise,
      bidPaise: applyAdverseSlippage(lastPaise, "SELL", Math.floor(spread / 2), 5n),
      askPaise: applyAdverseSlippage(lastPaise, "BUY", Math.ceil(spread / 2), 5n),
      openPaise: rupeesToPaise(last.open.toFixed(2)),
      highPaise: rupeesToPaise(last.high.toFixed(2)),
      lowPaise: rupeesToPaise(last.low.toFixed(2)),
      previousClosePaise: rupeesToPaise(previous.close.toFixed(2)),
      volume: BigInt(Math.max(0, Math.round(last.volume))),
      asOf: new Date(last.time * 1000),
      mode: "HISTORICAL",
      source: "dhan",
      marketOpen: session.open,
      message: "Daily close. A client id with the access token is required for a live snapshot. Orders stay on the practice ledger.",
    };
  }
  const payload = (await dhanPost("/marketfeed/ohlc", { NSE_EQ: [Number(id)] })) as {
    data?: { NSE_EQ?: Record<string, { last_price?: number; ohlc?: { open?: number; high?: number; low?: number; close?: number } }> };
  };
  const row = payload.data?.NSE_EQ?.[id];
  const last = row?.last_price;
  if (!last || !Number.isFinite(last)) throw new AppError("No live price was returned for this symbol.", 502);
  const lastPaise = rupeesToPaise(last.toFixed(2));
  const price = (value: number | undefined, fallback: bigint) => (value && Number.isFinite(value) && value > 0 ? rupeesToPaise(value.toFixed(2)) : fallback);
  return {
    symbol,
    lastPaise,
    bidPaise: applyAdverseSlippage(lastPaise, "SELL", Math.floor(spread / 2), 5n),
    askPaise: applyAdverseSlippage(lastPaise, "BUY", Math.ceil(spread / 2), 5n),
    openPaise: price(row.ohlc?.open, lastPaise),
    highPaise: price(row.ohlc?.high, lastPaise),
    lowPaise: price(row.ohlc?.low, lastPaise),
    previousClosePaise: price(row.ohlc?.close, lastPaise),
    volume: 0n,
    asOf: now,
    mode: "REALTIME",
    source: "dhan",
    marketOpen: session.open,
    message: "Price snapshot. Practice orders stay on the virtual ledger.",
  };
}

type FeedRow = { last_price?: number; net_change?: number; volume?: number; ohlc?: { open?: number; high?: number; low?: number; close?: number } };

export async function dhanFeed(ids: number[]): Promise<Record<string, FeedRow>> {
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))].slice(0, 2000);
  const merged: Record<string, FeedRow> = {};
  for (let index = 0; index < unique.length; index += 1000) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1100));
    const chunk = unique.slice(index, index + 1000);
    const payload = (await dhanPost("/marketfeed/quote", { NSE_EQ: chunk })) as { data?: { NSE_EQ?: Record<string, FeedRow> } };
    Object.assign(merged, payload.data?.NSE_EQ ?? {});
  }
  return merged;
}

export function quoteFromFeed(symbol: string, id: string, row: FeedRow | undefined, now: Date, marketOpen: boolean): DemoQuote | null {
  const last = row?.last_price;
  if (!row || !last || !Number.isFinite(last) || last <= 0) return null;
  const lastPaise = rupeesToPaise(last.toFixed(2));
  const spread = Math.max(1, DEFAULT_CHARGES.spreadBps);
  const price = (value: number | undefined, fallback: bigint) => (value && Number.isFinite(value) && value > 0 ? rupeesToPaise(value.toFixed(2)) : fallback);
  const fromChange = typeof row.net_change === "number" && Number.isFinite(row.net_change) && row.net_change !== 0 ? last - row.net_change : null;
  const previous = fromChange && fromChange > 0 ? rupeesToPaise(fromChange.toFixed(2)) : price(row.ohlc?.close, lastPaise);
  return {
    symbol,
    lastPaise,
    bidPaise: applyAdverseSlippage(lastPaise, "SELL", Math.floor(spread / 2), 5n),
    askPaise: applyAdverseSlippage(lastPaise, "BUY", Math.ceil(spread / 2), 5n),
    openPaise: price(row.ohlc?.open, lastPaise),
    highPaise: price(row.ohlc?.high, lastPaise),
    lowPaise: price(row.ohlc?.low, lastPaise),
    previousClosePaise: previous,
    volume: BigInt(Math.max(0, Math.round(row.volume ?? 0))),
    asOf: now,
    mode: "REALTIME",
    source: "dhan",
    marketOpen,
    message: "Live quote. Orders stay on the practice ledger.",
  };
}

export type LiveMover = { symbol: string; name: string; last: number; previous: number; change: number; percent: number; volume: number | null };

export function rankFeed(items: Array<{ symbol: string; name: string; id: string }>, book: Record<string, FeedRow>): LiveMover[] {
  return items.flatMap((item) => {
    const row = book[item.id];
    const last = row?.last_price;
    const fromChange = typeof row?.net_change === "number" && Number.isFinite(row.net_change) && row.net_change !== 0 ? last! - row.net_change : null;
    const previous = fromChange && fromChange > 0 ? fromChange : row?.ohlc?.close;
    if (!last || !previous || !Number.isFinite(last) || !Number.isFinite(previous) || last <= 0 || previous <= 0) return [];
    const change = last - previous;
    return [{
      symbol: item.symbol,
      name: item.name,
      last,
      previous,
      change,
      percent: (change / previous) * 100,
      volume: row.volume != null && Number.isFinite(row.volume) ? row.volume : null,
    }];
  });
}
