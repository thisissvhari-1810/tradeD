import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { applyAdverseSlippage, rupeesToPaise } from "@/lib/money";
import { DEMO_UNIVERSE, demoIntraday, demoDailyCandles, demoQuote, type Candle, type DemoQuote } from "@/lib/market/demo";
import { kolkataParts, nseCashSession } from "@/lib/market/clock";
import { dhanCandles, dhanContextMinutes, dhanFeed, dhanIndexQuotes, dhanPriorDaily, dhanQuote, dhanSessionTape, nseScrip, quoteFromFeed, rankFeed, sessionPreviousClose, type LiveMover } from "@/server/dhan-market";
import { findIndex, searchIndices } from "@/lib/market/indices";
import { LIQUID_NSE } from "@/lib/market/liquid";
import { aggregateCount, aggregateMinutes, aggregatePeriod, type ChartSpan } from "@/lib/market/spans";
import { describeSession, normalizeTape, selectPreviousSession, type PreviousSession } from "@/lib/trading/replay-engine";
import { istDay } from "@/lib/trading/demo-replay";
import { configuredProvider, getHolidays } from "@/server/settings";
import type { S1Data } from "@/lib/trading/s1";
import { DEFAULT_CHARGES } from "@/lib/trading/settings";
import type { DataMode } from "@prisma/client";

export type PublicQuote = DemoQuote & { symbolName?: string };

async function remember(quote: DemoQuote, instrumentId?: string) {
  if (!instrumentId) return;
  await prisma.quoteCache.upsert({
    where: { instrumentId },
    create: {
      instrumentId,
      lastPaise: quote.lastPaise,
      bidPaise: quote.bidPaise,
      askPaise: quote.askPaise,
      openPaise: quote.openPaise,
      highPaise: quote.highPaise,
      lowPaise: quote.lowPaise,
      previousClosePaise: quote.previousClosePaise,
      volume: quote.volume,
      asOf: quote.asOf,
      mode: quote.mode as DataMode,
      source: quote.source,
      marketOpen: quote.marketOpen,
      message: quote.message,
    },
    update: {
      lastPaise: quote.lastPaise,
      bidPaise: quote.bidPaise,
      askPaise: quote.askPaise,
      openPaise: quote.openPaise,
      highPaise: quote.highPaise,
      lowPaise: quote.lowPaise,
      previousClosePaise: quote.previousClosePaise,
      volume: quote.volume,
      asOf: quote.asOf,
      mode: quote.mode as DataMode,
      source: quote.source,
      marketOpen: quote.marketOpen,
      message: quote.message,
    },
  });
}

async function markStatus(mode: DataMode, message: string, error?: string) {
  await prisma.marketDataStatus.upsert({
    where: { id: "primary" },
    create: {
      id: "primary",
      provider: configuredProvider(),
      mode,
      lastSuccessAt: error ? null : new Date(),
      lastErrorAt: error ? new Date() : null,
      lastError: error ?? "",
      message,
    },
    update: {
      provider: configuredProvider(),
      mode,
      lastSuccessAt: error ? undefined : new Date(),
      lastErrorAt: error ? new Date() : undefined,
      lastError: error ?? "",
      message,
    },
  });
}

function toPaise(value: unknown): bigint | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return rupeesToPaise(number.toFixed(2));
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!response.ok) throw new AppError(`Market data provider returned ${response.status}.`, 502);
  return response.json();
}

async function twelveQuote(symbol: string, exchange: string, now: Date, holidays: string[]): Promise<DemoQuote> {
  const key = process.env.MARKET_DATA_API_KEY;
  if (!key) throw new AppError("MARKET_DATA_API_KEY is not configured.", 503);
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}&apikey=${encodeURIComponent(key)}`;
  const payload = (await fetchJson(url)) as Record<string, unknown>;
  if (payload.status === "error" || payload.code) throw new AppError(String(payload.message ?? "Twelve Data request failed."), 502);
  const last = toPaise(payload.close);
  if (!last) throw new AppError("Twelve Data did not return a price.", 502);
  const session = nseCashSession(now, holidays);
  const explicit = typeof payload.is_market_open === "boolean" ? payload.is_market_open : session.open;
  const spread = Math.max(1, DEFAULT_CHARGES.spreadBps);
  return {
    symbol,
    lastPaise: last,
    bidPaise: applyAdverseSlippage(last, "SELL", Math.floor(spread / 2), 5n),
    askPaise: applyAdverseSlippage(last, "BUY", Math.ceil(spread / 2), 5n),
    openPaise: toPaise(payload.open) ?? last,
    highPaise: toPaise(payload.high) ?? last,
    lowPaise: toPaise(payload.low) ?? last,
    previousClosePaise: toPaise(payload.previous_close) ?? last,
    volume: BigInt(Math.max(0, Math.round(Number(payload.volume) || 0))),
    asOf: payload.datetime ? new Date(String(payload.datetime)) : now,
    mode: process.env.MARKET_DATA_MODE === "realtime" ? "REALTIME" : "DELAYED",
    source: "twelvedata",
    marketOpen: explicit,
    message: process.env.MARKET_DATA_MODE === "realtime" ? "Provider marked as real-time by server configuration." : "Delayed or end-of-day provider data. Not a brokerage quote.",
  };
}

async function alphaQuote(symbol: string, now: Date, holidays: string[]): Promise<DemoQuote> {
  const key = process.env.MARKET_DATA_API_KEY;
  if (!key) throw new AppError("MARKET_DATA_API_KEY is not configured.", 503);
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
  const payload = (await fetchJson(url)) as { ["Global Quote"]?: Record<string, string>; Note?: string; Information?: string };
  if (payload.Note || payload.Information) throw new AppError(payload.Note ?? payload.Information ?? "Alpha Vantage limit reached.", 429);
  const quote = payload["Global Quote"] ?? {};
  const last = toPaise(quote["05. price"]);
  if (!last) throw new AppError("Alpha Vantage did not return a price for this symbol.", 502);
  const session = nseCashSession(now, holidays);
  return {
    symbol,
    lastPaise: last,
    bidPaise: last,
    askPaise: last,
    openPaise: toPaise(quote["02. open"]) ?? last,
    highPaise: toPaise(quote["03. high"]) ?? last,
    lowPaise: toPaise(quote["04. low"]) ?? last,
    previousClosePaise: toPaise(quote["08. previous close"]) ?? last,
    volume: BigInt(Math.max(0, Math.round(Number(quote["06. volume"]) || 0))),
    asOf: quote["07. latest trading day"] ? new Date(`${quote["07. latest trading day"]}T00:00:00Z`) : now,
    mode: "DELAYED",
    source: "alphavantage",
    marketOpen: session.open,
    message: "Alpha Vantage global quote. Treat as delayed or end-of-day, not a live Indian exchange feed.",
  };
}

export async function getQuote(symbol: string): Promise<DemoQuote> {
  const key = symbol.toUpperCase();
  const index = findIndex(key);
  const instrument = await prisma.instrument.findUnique({ where: { symbol: key } });
  if ((!instrument || !instrument.isActive) && !index) throw new AppError("Instrument is not available.", 404);
  const holidays = await getHolidays();
  const now = new Date();
  const provider = configuredProvider();
  try {
    let quote: DemoQuote;
    if (provider === "demo") {
      if (!instrument) throw new AppError("Instrument is not available.", 404);
      quote = demoQuote({ symbol: instrument.symbol, name: instrument.name, exchange: instrument.exchange, sector: instrument.sector, basePaise: instrument.basePaise, tickPaise: instrument.tickPaise }, now, holidays);
    } else if (provider === "twelvedata") {
      if (!instrument) throw new AppError("Instrument is not available.", 404);
      quote = await twelveQuote(instrument.symbol, instrument.exchange, now, holidays);
    } else if (provider === "dhan") {
      quote = await dhanQuote(index?.symbol ?? instrument?.symbol ?? key, instrument?.dhanSecurityId ?? "", now, holidays);
    } else {
      if (!instrument) throw new AppError("Instrument is not available.", 404);
      quote = await alphaQuote(instrument.symbol, now, holidays);
    }
    if (instrument) await remember(quote, instrument.id);
    await markStatus(quote.mode, quote.message);
    return quote;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Market data failed.";
    await markStatus("UNAVAILABLE", message, message);
    throw error;
  }
}

function demoSpan(symbol: string, basePaise: number, now: Date, timeframe: ChartSpan): Candle[] {
  if (timeframe === "4h") return aggregateCount(demoIntraday(symbol, basePaise, now, 60), 4);
  if (timeframe === "2h") return aggregateCount(demoIntraday(symbol, basePaise, now, 60), 2);
  if (timeframe === "1h") return demoIntraday(symbol, basePaise, now, 60);
  if (timeframe === "30m") return aggregateMinutes(demoIntraday(symbol, basePaise, now, 15), 30);
  if (timeframe === "15m") return demoIntraday(symbol, basePaise, now, 15);
  if (timeframe === "1m" || timeframe === "3m" || timeframe === "5m") return demoIntraday(symbol, basePaise, now, 5);
  const count = timeframe === "1y" ? 252 : timeframe === "5y" ? 1260 : 1500;
  const daily = demoDailyCandles(symbol, basePaise, now, count);
  if (timeframe === "1w") return aggregatePeriod(daily, "week");
  if (timeframe === "1mo") return aggregatePeriod(daily, "month");
  return daily;
}

export type ReplaySession = {
  tape: Candle[];
  prior: Candle[];
  context: Candle[];
  previous: PreviousSession | null;
  sessionOpen: number | null;
  sessionClose: number | null;
  message: string;
  unavailable: null | "invalid" | "weekend" | "holiday" | "future" | "nodata" | "synthetic" | "unsupported";
  mode: string;
  source: string;
};

const replayCache = new Map<string, { at: number; value: ReplaySession }>();

function replayResult(input: Omit<ReplaySession, "tape" | "prior" | "context" | "previous" | "mode" | "source"> & Partial<Pick<ReplaySession, "tape" | "prior" | "context" | "previous" | "mode" | "source">>): ReplaySession {
  return {
    tape: input.tape ?? [],
    prior: input.prior ?? [],
    context: input.context ?? [],
    previous: input.previous ?? null,
    sessionOpen: input.sessionOpen,
    sessionClose: input.sessionClose,
    message: input.message,
    unavailable: input.unavailable,
    mode: input.mode ?? "HISTORICAL",
    source: input.source ?? "session",
  };
}

/** One cash session of 1-minute history, plus completed daily candles from before that date. */
export async function getReplay(symbol: string, date: string): Promise<ReplaySession> {
  const today = kolkataParts(new Date()).dateKey;
  const holidays = await getHolidays();
  const session = describeSession(date, holidays, today);
  if (!session.ok) return replayResult({ sessionOpen: null, sessionClose: null, message: session.message, unavailable: session.reason });
  const key = symbol.trim().toUpperCase();
  const index = findIndex(key);
  const instrument = await prisma.instrument.findUnique({ where: { symbol: key } });
  if (!instrument && !index) throw new AppError("Instrument is not available.", 404);
  const provider = configuredProvider();
  if (provider === "demo") {
    return replayResult({
      sessionOpen: session.open,
      sessionClose: session.close,
      unavailable: "synthetic",
      message: "Historical replay needs exchange candles. This data source is synthetic, so this date was not replayed.",
    });
  }
  if (provider !== "dhan") {
    return replayResult({
      sessionOpen: session.open,
      sessionClose: session.close,
      unavailable: "unsupported",
      message: "This data source does not provide a one-day intraday session, so the date was not replayed.",
    });
  }
  const cacheKey = `${key}|${date}`;
  const hit = replayCache.get(cacheKey);
  if (hit && Date.now() - hit.at < (hit.value.tape.length ? 10 * 60 * 1000 : 60 * 1000)) return hit.value;
  const stored = instrument?.dhanSecurityId ?? "";
  const name = index?.symbol ?? instrument!.symbol;
  let tape: Candle[] = [];
  let context: Candle[] = [];
  let prior: Candle[] = [];
  try {
    const [sessionBars, earlierMinutes, earlierDaily] = await Promise.all([
      dhanSessionTape(name, stored, session.open, session.close),
      dhanContextMinutes(name, stored, session.open).catch(() => [] as Candle[]),
      dhanPriorDaily(name, stored, session.open).catch(() => [] as Candle[]),
    ]);
    tape = normalizeTape(sessionBars.filter((bar) => istDay(bar.time) === date && bar.time >= session.open && bar.time < session.close));
    context = normalizeTape(earlierMinutes.filter((bar) => istDay(bar.time) < date && bar.time < session.open));
    prior = normalizeTape(earlierDaily.filter((bar) => istDay(bar.time) < date)).slice(-1600);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The historical session could not be loaded.";
    return replayResult({ sessionOpen: session.open, sessionClose: session.close, unavailable: "nodata", message: `${message} This date was not replaced with another session.` });
  }
  if (!tape.length) {
    const value = replayResult({
      sessionOpen: session.open,
      sessionClose: session.close,
      unavailable: "nodata",
      message: `No 1-minute candles were returned for ${key} on ${date}. This date was not replaced with another session.`,
    });
    replayCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
  const previous = selectPreviousSession(prior, context, date);
  const availableClose = Math.min(session.close, tape[tape.length - 1].time + 60);
  const previousNote = previous
    ? `Previous session ${previous.date}: open ${previous.open}, close ${previous.close}.`
    : "Previous session open and close were not returned.";
  const value = replayResult({
    tape,
    prior,
    context,
    previous,
    sessionOpen: session.open,
    sessionClose: availableClose,
    unavailable: null,
    message: `Session ${date}, 09:15–15:30 IST. Replay uses this session only. ${context.length} earlier one-minute candles and ${prior.length} daily candles are chart context and do not advance playback. ${previousNote} A minute's high, low, close, and volume stay hidden until that minute ends.`,
  });
  replayCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export async function getCandles(symbol: string, timeframe: ChartSpan): Promise<{ candles: Candle[]; mode: string; source: string; message: string }> {
  const key = symbol.toUpperCase();
  const index = findIndex(key);
  const instrument = await prisma.instrument.findUnique({ where: { symbol: key } });
  if (!instrument && !index) throw new AppError("Instrument is not available.", 404);
  const provider = configuredProvider();
  const now = new Date();
  if (provider === "dhan") return dhanCandles(index?.symbol ?? instrument!.symbol, instrument?.dhanSecurityId ?? "", timeframe, now);
  if (!instrument) throw new AppError("Index candles are available from the live feed only.", 404);
  if (provider === "demo") {
    const candles = demoSpan(instrument.symbol, instrument.basePaise, now, timeframe);
    const coarse = timeframe === "1m" || timeframe === "3m";
    return {
      candles,
      mode: "DEMO",
      source: "tradelab-demo",
      message: coarse
        ? "Demo candles are synthetic. This provider has no 1-minute history, so 1m and 3m use the synthetic 5-minute series."
        : "Demo candles are synthetic. They are not exchange history.",
    };
  }
  const apiKey = process.env.MARKET_DATA_API_KEY;
  if (!apiKey) throw new AppError("MARKET_DATA_API_KEY is not configured.", 503);
  if (provider === "twelvedata") {
    const interval = timeframe === "1h" || timeframe === "2h" || timeframe === "4h" ? "1h" : timeframe === "30m" ? "30min" : timeframe === "15m" ? "15min" : timeframe === "5m" ? "5min" : timeframe === "1m" || timeframe === "3m" ? "1min" : "1day";
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(instrument.symbol)}&exchange=${encodeURIComponent(instrument.exchange)}&interval=${interval}&outputsize=180&apikey=${encodeURIComponent(apiKey)}`;
    const payload = (await fetchJson(url)) as { values?: Array<Record<string, string>>; status?: string; message?: string };
    if (!payload.values) throw new AppError(payload.message ?? "No candle data returned.", 502);
    const candles = payload.values
      .map((row) => ({
        time: Math.floor(new Date(row.datetime).getTime() / 1000),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      }))
      .filter((row) => Number.isFinite(row.time) && Number.isFinite(row.close))
      .reverse();
    const grouped = timeframe === "4h" ? aggregateCount(candles, 4) : timeframe === "2h" ? aggregateCount(candles, 2) : candles;
    const note = timeframe === "2h" || timeframe === "4h" ? " 2-hour and 4-hour bars are grouped from the 1-hour series." : "";
    return { candles: grouped, mode: process.env.MARKET_DATA_MODE === "realtime" ? "REALTIME" : "DELAYED", source: "twelvedata", message: `Provider candles. Check your plan's delay and redistribution rights.${note}` };
  }
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(instrument.symbol)}&apikey=${encodeURIComponent(apiKey)}`;
  const payload = (await fetchJson(url)) as { ["Time Series (Daily)"]?: Record<string, Record<string, string>>; Note?: string };
  if (payload.Note) throw new AppError(payload.Note, 429);
  const series = payload["Time Series (Daily)"] ?? {};
  const candles = Object.entries(series)
    .map(([day, row]) => ({
      time: Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000),
      open: Number(row["1. open"]),
      high: Number(row["2. high"]),
      low: Number(row["3. low"]),
      close: Number(row["4. close"]),
      volume: Number(row["5. volume"]),
    }))
    .sort((a, b) => a.time - b.time);
  return { candles, mode: "HISTORICAL", source: "alphavantage", message: "Daily historical candles from Alpha Vantage. Intraday charts require a provider plan that includes them; this adapter returns the daily series." };
}

export async function searchInstruments(query: string, skip = 0) {
  const q = query.trim();
  const rows = await prisma.instrument.findMany({
    where: q
      ? { isActive: true, OR: [{ symbol: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] }
      : { isActive: true, sector: "EQ" },
    orderBy: { name: "asc" },
    skip: Math.max(0, skip),
    take: 50,
    select: { symbol: true, name: true, exchange: true, sector: true, lotSize: true, tickPaise: true },
  });
  const indices = skip === 0 ? searchIndices(q).map((item) => ({ symbol: item.symbol, name: item.name, exchange: "NSE", sector: "INDEX", lotSize: 1, tickPaise: 5 })) : [];
  const seen = new Set(indices.map((item) => item.symbol));
  const equities = rows.filter((row) => !seen.has(row.symbol));
  return [...indices, ...equities].sort((a, b) => Number(a.sector !== "INDEX") - Number(b.sector !== "INDEX") || Number(/^\d/.test(a.symbol)) - Number(/^\d/.test(b.symbol)) || a.name.localeCompare(b.name)).slice(0, 60);
}

const quoteMemo = new Map<string, { at: number; quote: DemoQuote }>();

export async function getQuotes(symbols: string[]) {
  const unique = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].slice(0, 40);
  if (configuredProvider() === "dhan") return dhanQuoteBatch(unique);
  const rows: Array<DemoQuote | { symbol: string; error: string }> = [];
  for (const symbol of unique) {
    const hit = quoteMemo.get(symbol);
    if (hit && Date.now() - hit.at < 4000) {
      rows.push(hit.quote);
      continue;
    }
    try {
      const quote = await getQuote(symbol);
      quoteMemo.set(symbol, { at: Date.now(), quote });
      rows.push(quote);
    } catch (error) {
      rows.push({ symbol, error: error instanceof Error ? error.message : "Quote failed." });
    }
  }
  return rows;
}

async function dhanQuoteBatch(symbols: string[]): Promise<Array<DemoQuote | { symbol: string; error: string }>> {
  const fresh: string[] = [];
  const rows: Array<DemoQuote | { symbol: string; error: string }> = [];
  for (const symbol of symbols) {
    const hit = quoteMemo.get(symbol);
    if (hit && Date.now() - hit.at < 4000) rows.push(hit.quote);
    else fresh.push(symbol);
  }
  if (!fresh.length) return rows;
  const indexSymbols = fresh.filter((symbol) => findIndex(symbol));
  const equitySymbols = fresh.filter((symbol) => !findIndex(symbol));
  const now = new Date();
  const holidays = await getHolidays();
  if (indexSymbols.length) {
    try {
      const indexQuotes = await dhanIndexQuotes(indexSymbols, now, holidays);
      const found = new Set(indexQuotes.map((quote) => quote.symbol));
      for (const quote of indexQuotes) {
        quoteMemo.set(quote.symbol, { at: Date.now(), quote });
        rows.push(quote);
      }
      for (const symbol of indexSymbols) if (!found.has(symbol)) rows.push({ symbol, error: "No index price was returned." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Index quote failed.";
      for (const symbol of indexSymbols) rows.push({ symbol, error: message });
    }
  }
  if (!equitySymbols.length) return rows;
  const instruments = await prisma.instrument.findMany({ where: { symbol: { in: equitySymbols }, isActive: true }, select: { symbol: true, dhanSecurityId: true } });
  const known = new Map(instruments.map((item) => [item.symbol, item.dhanSecurityId]));
  const priced = equitySymbols.flatMap((symbol) => {
    if (!known.has(symbol)) return [];
    const id = known.get(symbol)?.trim() || nseScrip(symbol)?.id;
    return id ? [{ symbol, id }] : [];
  });
  const session = nseCashSession(now, holidays);
  let book: Awaited<ReturnType<typeof dhanFeed>> = {};
  try {
    book = priced.length ? await dhanFeed(priced.map((item) => Number(item.id))) : {};
  } catch (error) {
    // Dhan rate-limits bursts. Serve the last real quote this instance saw rather than blanking the row.
    const message = error instanceof Error ? error.message : "Quote request failed.";
    return [...rows, ...equitySymbols.map((symbol) => quoteMemo.get(symbol)?.quote ?? { symbol, error: message })];
  }
  const bySymbol = new Map(priced.map((item) => [item.symbol, item.id]));
  const built: Array<{ quote: DemoQuote; id: string }> = [];
  for (const symbol of equitySymbols) {
    const id = bySymbol.get(symbol);
    if (!id) {
      rows.push({ symbol, error: known.has(symbol) ? `${symbol} is not on the NSE equity list.` : "Instrument is not available." });
      continue;
    }
    const quote = quoteFromFeed(symbol, id, book[id], now, session.open);
    if (!quote) {
      rows.push({ symbol, error: "No live price was returned for this symbol." });
      continue;
    }
    built.push({ quote, id });
  }
  const flat = built.filter((item) => item.quote.previousClosePaise === item.quote.lastPaise);
  let cursor = 0;
  async function fillOne() {
    while (cursor < flat.length) {
      const item = flat[cursor];
      cursor += 1;
      try {
        const prior = await sessionPreviousClose(item.id, now);
        if (prior && prior > 0) item.quote.previousClosePaise = rupeesToPaise(prior.toFixed(2));
      } catch {
        // Keep the live last price even when the prior close is missing.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, flat.length) }, () => fillOne()));
  for (const item of built) {
    quoteMemo.set(item.quote.symbol, { at: Date.now(), quote: item.quote });
    rows.push(item.quote);
  }
  return rows;
}

let moverCache: { at: number; gainers: LiveMover[]; losers: LiveMover[]; volume: LiveMover[]; scanned: number; message: string } | null = null;

export async function getMarketMovers() {
  if (configuredProvider() !== "dhan") {
    return { gainers: [], losers: [], volume: [], scanned: 0, message: "Market movers need the live quote feed. The configured provider is not returning them, so this list is empty." };
  }
  if (moverCache && Date.now() - moverCache.at < 60000) return { gainers: moverCache.gainers, losers: moverCache.losers, volume: moverCache.volume, scanned: moverCache.scanned, message: moverCache.message };
  const wanted = new Set<string>(LIQUID_NSE);
  const instruments = await prisma.instrument.findMany({
    where: { isActive: true, symbol: { in: [...wanted] } },
    select: { symbol: true, name: true, dhanSecurityId: true, exchange: true },
  });
  const bySymbol = new Map(instruments.map((item) => [item.symbol, item]));
  const items = LIQUID_NSE.flatMap((symbol) => {
    const item = bySymbol.get(symbol);
    if (!item || item.exchange !== "NSE") return [];
    const id = item.dhanSecurityId.trim() || nseScrip(item.symbol)?.id;
    return id ? [{ symbol: item.symbol, name: item.name, id }] : [];
  });
  if (!items.length) return { gainers: [], losers: [], volume: [], scanned: 0, message: "No NSE equities in the instrument master matched the live scrip list." };
  let book: Awaited<ReturnType<typeof dhanFeed>>;
  try {
    book = await dhanFeed(items.map((item) => Number(item.id)));
  } catch (error) {
    if (moverCache) return { gainers: moverCache.gainers, losers: moverCache.losers, volume: moverCache.volume, scanned: moverCache.scanned, message: moverCache.message };
    throw error;
  }
  const ranked = rankFeed(items, book);
  const gainers = [...ranked].sort((a, b) => b.percent - a.percent).slice(0, 20);
  const losers = [...ranked].sort((a, b) => a.percent - b.percent).slice(0, 20);
  const volume = [...ranked].filter((item) => item.volume != null).sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)).slice(0, 20);
  const message = `Live quotes for ${ranked.length} of ${items.length} NSE equities. Prices are the feed, not practice marks.`;
  moverCache = { at: Date.now(), gainers, losers, volume, scanned: ranked.length, message };
  return { gainers, losers, volume, scanned: ranked.length, message };
}

export { DEMO_UNIVERSE };

// v4: exact 09:15 bar; daily-bar anchors; open from the daily candle when published.
const s1Cache = new Map<string, { at: number; value: S1Data }>();

/**
 * S1 levels for one symbol and session date (today when no date is given).
 * Previous session: the last completed daily bar before the date (weekends and holidays have no bar),
 * folded from 1-minute bars if the daily bar is missing. Open and first minute: the session's first
 * 1-minute candle, used only once that minute has finished. Nothing is substituted when data is missing.
 */
export async function getS1Data(symbol: string, date?: string | null, previousDate?: string | null): Promise<S1Data> {
  const now = Math.floor(Date.now() / 1000);
  const today = kolkataParts(new Date()).dateKey;
  const day = date ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError("Choose a valid session date.", 400);
  const key = symbol.trim().toUpperCase();
  const [year, month, dom] = day.split("-").map(Number);
  const dayOpen = Math.floor(Date.UTC(year, month - 1, dom, 3, 45, 0) / 1000);
  const dayClose = Math.floor(Date.UTC(year, month - 1, dom, 10, 0, 0) / 1000);
  const base = { symbol: key, date: day, sessionOpen: dayOpen, sessionClose: dayClose, previous: null, open: null, firstMinute: null };
  if (day > today) return { ...base, status: "unavailable", message: `${day} has not traded yet.` };
  if (previousDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(previousDate)) throw new AppError("Choose a valid previous-day date.", 400);
  if (previousDate != null && previousDate >= day) return { ...base, status: "unavailable", message: `The previous day (${previousDate}) must be before the current day (${day}).` };
  const index = findIndex(key);
  const instrument = await prisma.instrument.findUnique({ where: { symbol: key } });
  if (!instrument && !index) throw new AppError("Instrument is not available.", 404);
  if (configuredProvider() !== "dhan") return { ...base, status: "unavailable", message: "S1 needs exchange candles. This data source is not Dhan, so no levels were drawn." };
  const cacheKey = `${key}|${day}|${previousDate ?? "auto"}`;
  const hit = s1Cache.get(cacheKey);
  // A stand-in latest session (before today's open) is kept briefly so today takes over right after 09:16.
  if (hit && Date.now() - hit.at < (hit.value.firstMinute && hit.value.date === day ? 30 * 60_000 : 45_000)) return hit.value;

  const holidays = await getHolidays();
  const session = describeSession(day, holidays, today);
  const stored = instrument?.dhanSecurityId ?? "";
  const name = index?.symbol ?? instrument!.symbol;
  const [daily, minutes] = await Promise.all([
    // Through the next morning so the selected day's own daily candle (its open) is included when published.
    dhanPriorDaily(name, stored, dayOpen + 86_400).catch(() => [] as Candle[]),
    dhanContextMinutes(name, stored, dayOpen).catch(() => [] as Candle[]),
  ]);
  // A chosen previous day must be a session that traded: its own daily bar, or its own 1-minute bars.
  // Automatic: the last completed session before the current day.
  const upTo = previousDate ?? day;
  const until = previousDate ? (bar: Candle) => istDay(bar.time) === previousDate : (bar: Candle) => istDay(bar.time) < day;
  const previous = selectPreviousSession(
    normalizeTape(daily.filter(until)),
    normalizeTape(minutes.filter(until)),
    previousDate ? nextDay(upTo) : day,
  );

  // Automatic day before today's open (or on a weekend / holiday): the latest session that has traded is
  // the current day, so its open and 9:15 lines show instead of waiting on a session that has not started.
  if (date == null && previous && (!session.ok || now < session.open + 60) && (previousDate == null || previousDate < previous.date)) {
    const latest = await getS1Data(symbol, previous.date, previousDate);
    const why = session.ok ? `${day} has not opened yet` : `${day} has no session`;
    const shown = { ...latest, message: `${why}, so the latest session (${previous.date}) is shown. ${latest.message}` };
    s1Cache.set(cacheKey, { at: Date.now(), value: shown });
    return shown;
  }

  // Box edges sit on the provider's own daily-bar stamps (the same bars the daily chart draws).
  let anchors: S1Data["anchors"] = null;
  if (previous) {
    const midnight = (key: string) => {
      const [y, m, d] = key.split("-").map(Number);
      return Math.floor(Date.UTC(y, m - 1, d) / 1000) - 19_800;
    };
    const bars = normalizeTape(daily.filter((bar) => istDay(bar.time) <= previous.date));
    const previousBar = bars.filter((bar) => istDay(bar.time) === previous.date).at(-1);
    const offset = previousBar ? previousBar.time - midnight(previous.date) : 0;
    const previousTime = midnight(previous.date) + offset;
    const dayTime = midnight(day) + offset;
    const beforeBar = bars.filter((bar) => istDay(bar.time) < previous.date).at(-1);
    anchors = {
      before: beforeBar ? beforeBar.time : previousTime - (dayTime - previousTime),
      previous: previousTime,
      day: dayTime,
      after: dayTime + (dayTime - previousTime),
    };
  }

  let first: Candle | null = null;
  let firstBarTime: number | null = null;
  if (session.ok) {
    // Sorted and de-duplicated, then only this session's bars.
    const tape = normalizeTape((await dhanSessionTape(name, stored, session.open, session.close).catch(() => [] as Candle[]))
      .filter((bar) => istDay(bar.time) === day && bar.time >= session.open && bar.time < session.close));
    firstBarTime = tape[0]?.time ?? null;
    // The candle that opens at exactly 09:15:00 IST (it covers 09:15:00-09:15:59). Never the 09:16 candle,
    // and only once that minute has finished.
    const opening = tape.find((bar) => bar.time === session.open) ?? null;
    if (opening && opening.time + 60 <= now) first = opening;
  }

  // Today's open: the selected day's daily candle (as the daily chart shows it), else the 09:15 candle's open.
  const dayBar = normalizeTape(daily.filter((bar) => istDay(bar.time) === day)).at(-1) ?? null;
  const openPrice = session.ok && dayBar ? dayBar.open : first ? first.open : null;
  const openSource: S1Data["openSource"] = session.ok && dayBar ? "daily" : first ? "09:15" : null;

  let status: S1Data["status"];
  let message: string;
  if (!previous) {
    status = "unavailable";
    message = previousDate
      ? `No session data for ${previousDate} (weekend, holiday or not returned). Choose another previous day.`
      : `The previous completed session before ${day} was not returned, so nothing was drawn.`;
  } else if (!session.ok) {
    status = "closed";
    message = `${session.message} Showing the previous session (${previous.date}) range only.`;
  } else if (!first) {
    const clock = (seconds: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(seconds * 1000));
    if (now < session.open + 60) {
      status = "waiting";
      message = `Waiting for the 09:15 candle of ${day} to finish. Previous session ${previous.date} is drawn.`;
    } else if (firstBarTime != null && firstBarTime !== session.open) {
      status = "unavailable";
      message = `The 09:15 candle of ${day} was not returned (first bar: ${clock(firstBarTime)} IST). The open and 9:15 lines are not drawn; no other candle is substituted.`;
    } else {
      status = "waiting";
      message = `The 09:15 candle of ${day} was not returned yet. Previous session ${previous.date} is drawn.`;
    }
  } else {
    status = "ready";
    message = `Previous session ${previous.date}: H ${previous.high} L ${previous.low} C ${previous.close}. ${day} 09:15 candle: open ${first.open}, high ${first.high}, low ${first.low}.`;
  }
  const value: S1Data = {
    ...base,
    sessionOpen: session.ok ? session.open : dayOpen,
    sessionClose: session.ok ? session.close : dayClose,
    status,
    message,
    previous,
    open: openPrice,
    openSource,
    firstMinute: first ? { time: first.time, open: first.open, high: first.high, low: first.low } : null,
    firstBarTime,
    anchors,
  };
  s1Cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** The calendar day after an IST date key. */
function nextDay(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
