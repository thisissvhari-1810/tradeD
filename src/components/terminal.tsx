"use client";

import { useHydrated, useLatest } from "@/components/use-hydrated";
import { mayPractice } from "@/lib/auth/permissions";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ChartPanel, DEFAULT_INDICATORS, type Candle, type ChartHandle, type ChartType, type Drawing, type DrawTool, type IndicatorSettings } from "@/components/chart-panel";
import { loadDrawings, saveDrawings } from "@/components/drawing-model";
import { api, freshness, istTime, key, money, moveOf, tone, type Quote } from "@/components/api";
import { useDesk } from "@/components/shell";
import { calculateCharges } from "@/lib/trading/fees";
import { paiseToRupees, rupeesToPaise } from "@/lib/money";
import { DEFAULT_CHARGES } from "@/lib/trading/settings";
import { feedStatusLabel, useMarketStream } from "@/components/market-stream";
import { applyLiveTick, CHART_SPANS, type ChartSpan } from "@/lib/market/spans";
import { StockLogo } from "@/components/stock-identity";

type List = { id: string; name: string; items: Array<{ symbol: string; name: string; exchange: string }> };
type Book = {
  orders: Array<{ id: string; symbol: string; side: string; type: string; quantity: number; filledQuantity: number; status: string; limit: string | null; avgFill: string | null; reason: string | null; submittedAt: string }>;
};
type Holding = { symbol: string; name: string; quantity: number; averageCost: string; mark: string | null; marketValue: string | null; unrealized: string | null; realized: string };
type Portfolio = { cashAvailable: string; cashReserved: string; equity: string; unrealized: string; realized: string; positions: Holding[]; simulated?: boolean; valuationMessage?: string };
type Layout = { id: string; name: string; symbol: string; timeframe: ChartSpan; chartType: ChartType; indicators: IndicatorSettings; flags: Flags };
type Flags = { sma: boolean; ema: boolean; bands: boolean; vwap: boolean; volume: boolean; supertrend: boolean; oscillator: "none" | "rsi" | "macd" };

const TOOLS: Array<[DrawTool, string]> = [
  ["cursor", "Crosshair"],
  ["trend", "Trend line"],
  ["ray", "Ray"],
  ["hline", "Horizontal line"],
  ["vline", "Vertical line"],
  ["channel", "Parallel channel"],
  ["rect", "Rectangle"],
  ["text", "Text"],
];

const EMPTY_FLAGS: Flags = { sma: false, ema: false, bands: false, vwap: false, volume: false, supertrend: false, oscillator: "none" };

/** A localStorage value, or null when storage is unavailable. */
function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** A parsed localStorage JSON value, or null when missing or unreadable. */
function readJson<T>(key: string): T | null {
  const raw = readStorage(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function Terminal() {
  const desk = useDesk();
  const params = useSearchParams();
  const [lists, setLists] = useState<List[]>([]);
  const [listId, setListId] = useState("");
  const [listError, setListError] = useState("");
  const [sort, setSort] = useState<"custom" | "name" | "price" | "change">("custom");
  const [order, setOrder] = useState<string[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; symbol: string } | null>(null);
  const [timeframe, setTimeframe] = useState<ChartSpan>("1d");
  const [chartType, setChartType] = useState<ChartType>("candle");
  const [flags, setFlags] = useState<Flags>(EMPTY_FLAGS);
  const [indicators, setIndicators] = useState<IndicatorSettings>(DEFAULT_INDICATORS);
  const [tool, setTool] = useState<DrawTool>("cursor");
  const [annotation, setAnnotation] = useState("");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candleNote, setCandleNote] = useState("");
  const [chartError, setChartError] = useState("");
  // The chart's candles answer one symbol | timeframe; until that answer arrives the chart is loading.
  const [loadedChart, setLoadedChart] = useState<string | null>(null);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "TARGET">("MARKET");
  const [quantity, setQuantity] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [review, setReview] = useState(false);
  const [orderMessage, setOrderMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [dock, setDock] = useState<"positions" | "orders">("positions");
  const [panel, setPanel] = useState<"indicators" | "layouts" | null>(null);
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [layoutName, setLayoutName] = useState("");
  const [mobile, setMobile] = useState<"watch" | "chart" | "order">("chart");
  const [addQuery, setAddQuery] = useState("");
  const [addHits, setAddHits] = useState<Array<{ symbol: string; name: string; exchange: string }>>([]);
  const handleRef = useRef<ChartHandle | null>(null);
  const chartRequest = useRef(0);
  const symbol = desk.symbol;
  const list = lists.find((item) => item.id === listId) ?? lists[0];
  const timeframeRef = useLatest(timeframe);
  const lastTradeRef = useRef(0);
  const marketOpenRef = useLatest(quotes[symbol] ? quotes[symbol].marketOpen : true);
  const symbolRef = useLatest(symbol);
  const hydrated = useHydrated();
  const stream = useMarketStream(symbol, true, (tick) => {
    setCandles((current) => {
      const next = applyLiveTick(current, timeframeRef.current, tick.price, tick.time, marketOpenRef.current, tick.volumeDelta, lastTradeRef.current);
      if (tick.time >= lastTradeRef.current) lastTradeRef.current = tick.time;
      return next;
    });
    setQuotes((current) => {
      const row = current[symbol];
      if (!row || Date.parse(row.asOf) > tick.time * 1000) return current;
      return {
        ...current,
        [symbol]: {
          ...row,
          last: tick.price.toFixed(2),
          asOf: new Date(tick.time * 1000).toISOString(),
          volume: tick.dayVolume != null ? String(Math.round(tick.dayVolume)) : row.volume,
        },
      };
    });
  });

  const chooseSymbol = useLatest(desk.chooseSymbol);

  // Order side / type from the link (?side=BUY&type=LIMIT) apply when the link changes (during render);
  // the symbol goes through the desk.
  const paramKey = params.toString();
  const [paramsSeen, setParamsSeen] = useState<string | null>(null);
  if (paramsSeen !== paramKey) {
    setParamsSeen(paramKey);
    const fromSide = params.get("side");
    if (fromSide === "BUY" || fromSide === "SELL") setSide(fromSide);
    const fromType = params.get("type");
    if (fromType === "MARKET" || fromType === "LIMIT" || fromType === "STOP" || fromType === "STOP_LIMIT" || fromType === "TARGET") setOrderType(fromType);
    if (fromSide === "SELL" || fromSide === "BUY") setMobile("order");
  }
  useEffect(() => {
    const fromUrl = params.get("symbol");
    if (fromUrl) chooseSymbol.current(fromUrl);
  }, [params, chooseSymbol]);

  // Saved chart preferences, layouts and watchlist are restored once the page has hydrated.
  const [restored, setRestored] = useState(false);
  if (hydrated && !restored) {
    setRestored(true);
    const parsed = readJson<{ timeframe?: ChartSpan; chartType?: ChartType; flags?: Flags; indicators?: IndicatorSettings }>("td-chart-prefs");
    if (parsed?.timeframe && CHART_SPANS.includes(parsed.timeframe)) setTimeframe(parsed.timeframe);
    if (parsed?.chartType) setChartType(parsed.chartType);
    if (parsed?.flags) setFlags({ ...EMPTY_FLAGS, ...parsed.flags });
    if (parsed?.indicators) setIndicators({ ...DEFAULT_INDICATORS, ...parsed.indicators });
    const storedLayouts = readJson<Layout[]>("td-layouts");
    if (Array.isArray(storedLayouts)) setLayouts(storedLayouts);
    const savedList = readStorage("td-watchlist");
    if (savedList) setListId(savedList);
  }

  useEffect(() => {
    // Not before the restore, or the defaults would overwrite the saved preferences.
    if (!restored) return;
    localStorage.setItem("td-chart-prefs", JSON.stringify({ timeframe, chartType, flags, indicators }));
  }, [restored, timeframe, chartType, flags, indicators]);

  const reloadLists = () => api<{ lists: List[] }>("/api/watchlists").then((data) => {
    setLists(data.lists);
    setListError("");
    setListId((current) => current && data.lists.some((item) => item.id === current) ? current : data.lists[0]?.id ?? "");
  }).catch((error: unknown) => setListError(error instanceof Error ? error.message : "Watchlist failed."));

  useEffect(() => { void reloadLists(); }, []);
  useEffect(() => { if (listId) localStorage.setItem("td-watchlist", listId); }, [listId]);
  // The watchlist's saved row order, read when the list (or its items) changes.
  const listKey = list ? `${list.id}:${list.items.map((item) => item.symbol).join(",")}` : null;
  const [orderFor, setOrderFor] = useState<string | null>(null);
  if (hydrated && list && listKey && orderFor !== listKey) {
    setOrderFor(listKey);
    const saved = readJson<string[]>(`td-order:${list.id}`);
    setOrder(Array.isArray(saved) ? saved : list.items.map((item) => item.symbol));
  }

  // Each symbol has its own drawings; switching symbol returns to the cursor.
  const [drawingsFor, setDrawingsFor] = useState<string | null>(null);
  if (hydrated && drawingsFor !== symbol) {
    setDrawingsFor(symbol);
    setDrawings(loadDrawings(symbol));
    setTool("cursor");
  }

  // A new symbol | timeframe starts with an empty chart and no error.
  const chartKey = `${symbol}|${timeframe}`;
  const [chartFor, setChartFor] = useState<string | null>(null);
  if (chartFor !== chartKey) {
    setChartFor(chartKey);
    setCandles([]);
    setChartError("");
  }
  const chartLoading = loadedChart !== chartKey;

  useEffect(() => {
    const id = ++chartRequest.current;
    const key = `${symbol}|${timeframe}`;
    api<{ candles: Candle[]; mode: string; source: string; message: string }>(`/api/market/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`)
      .then((data) => {
        if (id !== chartRequest.current) return;
        setCandles(data.candles);
        setCandleNote(`${data.source} · ${data.mode} · ${data.message}`);
        setLoadedChart(key);
      })
      .catch((error: unknown) => {
        if (id !== chartRequest.current) return;
        setChartError(error instanceof Error ? error.message : "Candles failed.");
        setLoadedChart(key);
      });
  }, [symbol, timeframe]);

  const symbols = useMemo(() => [...new Set([symbol, ...(list?.items.map((item) => item.symbol) ?? [])])], [symbol, list]);
  useEffect(() => {
    if (!symbols.length) return;
    let stop = false;
    const load = () => {
      api<{ quotes: Array<Quote | { symbol: string; error: string }> }>(`/api/market/quotes?symbols=${symbols.join(",")}`)
        .then((data) => {
          if (stop) return;
          const own = data.quotes.find((row): row is Quote => "last" in row && row.symbol === symbolRef.current);
          if (own && own.mode === "DEMO") {
            setCandles((current) => applyLiveTick(current, timeframeRef.current, Number(own.last), Math.floor(Date.now() / 1000), own.marketOpen));
          }
          setQuotes((current) => {
            const next = { ...current };
            for (const row of data.quotes) {
              if (!("last" in row)) continue;
              const prior = current[row.symbol];
              next[row.symbol] = prior && prior.symbol === row.symbol && Date.parse(prior.asOf) > Date.parse(row.asOf)
                ? { ...row, last: prior.last, asOf: prior.asOf, volume: prior.volume || row.volume }
                : row;
            }
            return next;
          });
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [symbols, symbolRef, timeframeRef]);

  const quote = quotes[symbol] ?? null;
  useEffect(() => {
    lastTradeRef.current = 0;
  }, [symbol]);

  useEffect(() => {
    const load = () => {
      api<Portfolio>("/api/portfolio").then(setPortfolio).catch(() => setPortfolio(null));
      api<Book>("/api/orders").then(setBook).catch(() => setBook(null));
    };
    load();
    const timer = window.setInterval(load, 8000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (addQuery.trim().length < 1) { setAddHits([]); return; }
      api<Array<{ symbol: string; name: string; exchange: string }>>(`/api/instruments?q=${encodeURIComponent(addQuery)}`).then(setAddHits).catch(() => setAddHits([]));
    }, 160);
    return () => window.clearTimeout(handle);
  }, [addQuery]);

  const rows = useMemo(() => {
    const items = list?.items ?? [];
    const ranked = [...items];
    if (sort === "name") ranked.sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (sort === "price") ranked.sort((a, b) => Number(quotes[b.symbol]?.last ?? 0) - Number(quotes[a.symbol]?.last ?? 0));
    if (sort === "change") ranked.sort((a, b) => (moveOf(quotes[b.symbol]?.last, quotes[b.symbol]?.previousClose)?.pct ?? -999) - (moveOf(quotes[a.symbol]?.last, quotes[a.symbol]?.previousClose)?.pct ?? -999));
    if (sort === "custom") {
      ranked.sort((a, b) => {
        const ai = order.indexOf(a.symbol);
        const bi = order.indexOf(b.symbol);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
    }
    return ranked;
  }, [list, sort, order, quotes]);

  function persistOrder(next: string[]) {
    setOrder(next);
    if (list) localStorage.setItem(`td-order:${list.id}`, JSON.stringify(next));
  }

  function moveItem(item: string, direction: -1 | 1) {
    const current = rows.map((row) => row.symbol);
    const index = current.indexOf(item);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return;
    const next = [...current];
    const [picked] = next.splice(index, 1);
    next.splice(target, 0, picked);
    setSort("custom");
    persistOrder(next);
  }

  async function watchAction(action: string, extra: Record<string, string> = {}) {
    if (!list && action !== "create") return;
    await api("/api/watchlists", { action, id: list?.id, ...extra });
    await reloadLists();
  }

  const selectedMove = moveOf(quote?.last, quote?.previousClose);
  const priceForEstimate = orderType === "LIMIT" || orderType === "STOP_LIMIT" || orderType === "TARGET" ? limitPrice : quote?.last ?? "";
  const estimate = useMemo(() => {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0 || !priceForEstimate) return null;
    try {
      const notional = rupeesToPaise(priceForEstimate) * BigInt(qty);
      const charges = calculateCharges(side, notional, DEFAULT_CHARGES);
      return { notional: paiseToRupees(notional), charges: paiseToRupees(charges.total) };
    } catch {
      return null;
    }
  }, [quantity, priceForEstimate, side]);

  async function submitOrder() {
    setBusy(true);
    setOrderMessage("");
    try {
      const result = await api<{ status: string; message: string | null; simulated: boolean }>("/api/orders", {
        symbol,
        side,
        type: orderType,
        quantity: Number(quantity),
        limitRupees: limitPrice || undefined,
        stopRupees: stopPrice || undefined,
        idempotencyKey: key(),
      });
      setOrderMessage(`${result.simulated ? "Practice" : "Order"} status: ${result.status}. ${result.message ?? ""}`.trim());
      desk.toast(`${symbol} ${side} ${result.status}`);
      setReview(false);
      const [nextPortfolio, nextBook] = await Promise.all([api<Portfolio>("/api/portfolio"), api<Book>("/api/orders")]);
      setPortfolio(nextPortfolio);
      setBook(nextBook);
    } catch (error) {
      setOrderMessage(error instanceof Error ? error.message : "Order failed.");
    } finally {
      setBusy(false);
    }
  }

  const scheme = desk.theme;
  const state = freshness(quote, desk.online);
  const marketClosed = quote != null && !quote.marketOpen && quote.mode !== "DEMO";
  const useFeed = quote?.mode === "REALTIME" || quote?.mode === "HISTORICAL" || stream.status === "live" || stream.status === "delayed";
  const feedBadge = !useFeed ? state.toUpperCase() : marketClosed ? "Market closed" : feedStatusLabel(stream.status);
  // Paper orders work in both views; Live view only means live prices. Real orders go through Accounts.
  const canTrade = Boolean(desk.user && mayPractice(desk.user)) && desk.user?.tradingEnabled && desk.user.status === "ACTIVE";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex border-b border-border bg-panel lg:hidden">
        {(["watch", "chart", "order"] as const).map((item) => (
          <button key={item} className={`flex-1 py-2 text-xs ${mobile === item ? "text-primary" : "text-muted"}`} onClick={() => setMobile(item)}>{item}</button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
        <aside className={`${mobile === "watch" ? "flex" : "hidden"} min-h-0 flex-col border-r border-border bg-panel lg:flex`}>
          <div className="flex items-center gap-1 border-b border-border p-2">
            <select className="min-w-0 flex-1 py-1 text-xs" value={list?.id ?? ""} onChange={(event) => setListId(event.target.value)} aria-label="Watchlist">
              {lists.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button className="border border-border px-2 py-1 text-xs" title="New watchlist" onClick={() => { const name = window.prompt("Watchlist name"); if (name) void watchAction("create", { name }).catch((error: unknown) => desk.toast(error instanceof Error ? error.message : "Could not create.")); }}>+</button>
          </div>
          <div className="flex gap-1 border-b border-border px-2 py-1 text-[0.625rem] text-muted">
            {(["custom", "name", "price", "change"] as const).map((item) => (
              <button key={item} className={sort === item ? "text-text" : ""} onClick={() => setSort(item)}>{item}</button>
            ))}
            <button className="ml-auto" title="Rename" onClick={() => { const name = window.prompt("Rename watchlist", list?.name ?? ""); if (name && list) void watchAction("rename", { name, id: list.id }).catch((error: unknown) => desk.toast(error instanceof Error ? error.message : "Could not rename.")); }}>Rename</button>
            <button title="Delete watchlist" onClick={() => { if (list && window.confirm(`Delete ${list.name}?`)) void watchAction("delete").catch((error: unknown) => desk.toast(error instanceof Error ? error.message : "Could not delete.")); }}>Delete</button>
          </div>
          <div className="relative border-b border-border p-2">
            <input value={addQuery} onChange={(event) => setAddQuery(event.target.value)} placeholder="Add symbol or company" className="w-full py-1 text-xs" aria-label="Add instrument" />
            {addHits.length > 0 ? (
              <div className="absolute left-2 right-2 top-9 z-20 max-h-48 overflow-auto border border-border bg-panel">
                {addHits.map((hit) => (
                  <button key={`${hit.exchange}-${hit.symbol}`} className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-elevated" onClick={() => { void watchAction("add", { symbol: hit.symbol }).then(() => { setAddQuery(""); setAddHits([]); }); }}><StockLogo symbol={hit.symbol} name={hit.name} size={22} />{hit.symbol} · {hit.name} · {hit.exchange}</button>
                ))}
              </div>
            ) : null}
          </div>
          {listError ? <p className="p-2 text-xs text-loss">{listError}</p> : null}
          <div className="min-h-0 flex-1 overflow-auto">
            {!list ? <div className="space-y-2 p-2">{[0, 1, 2, 3].map((item) => <div key={item} className="skel h-8" />)}</div> : null}
            {list && rows.length === 0 ? <p className="p-3 text-xs text-muted">This watchlist is empty. Search above to add an instrument.</p> : null}
            {rows.map((item) => {
              const rowQuote = quotes[item.symbol];
              const move = moveOf(rowQuote?.last, rowQuote?.previousClose);
              const selected = item.symbol === symbol;
              return (
                <div key={item.symbol} className={`grid cursor-pointer grid-cols-[1fr_auto] gap-2 border-b border-border px-2 py-1.5 ${selected ? "bg-elevated" : "hover:bg-elevated/60"}`} onClick={() => desk.chooseSymbol(item.symbol)} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, symbol: item.symbol }); }}>
                  <div className="flex min-w-0 items-center gap-2">
                    <StockLogo symbol={item.symbol} name={item.name} size={28} />
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-2"><span className="font-medium">{item.symbol}</span><span className="truncate text-[0.625rem] text-muted">{item.exchange}</span></div>
                      <div className="truncate text-[0.625rem] text-muted">{item.name}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`num text-xs ${tone(move?.abs)}`}>{rowQuote ? money(rowQuote.last) : "…"}</div>
                    <div className={`num whitespace-nowrap text-[0.625rem] ${tone(move?.abs)}`}>{move ? `${move.abs >= 0 ? "+" : ""}${move.abs.toFixed(2)} (${move.pct.toFixed(2)}%)` : rowQuote ? "—" : ""}</div>
                    <div className="mt-0.5 flex justify-end gap-1 text-[0.625rem] text-muted">
                      <button title="Move up" onClick={(event) => { event.stopPropagation(); moveItem(item.symbol, -1); }}>↑</button>
                      <button title="Move down" onClick={(event) => { event.stopPropagation(); moveItem(item.symbol, 1); }}>↓</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
        <section className={`${mobile === "chart" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col lg:flex`}>
          <div className="flex flex-wrap items-center gap-1 border-b border-border bg-panel px-2 py-1">
            <div className="flex items-center gap-2">
              <StockLogo symbol={symbol} size={32} />
              <div className="text-sm font-semibold">{symbol}</div>
              <div className="whitespace-nowrap text-xs"><span className="num">{quote ? money(quote.last) : "—"}</span> {selectedMove ? <span className={`num ${tone(selectedMove.abs)}`}>{`${selectedMove.abs >= 0 ? "+" : ""}${selectedMove.abs.toFixed(2)} (${selectedMove.pct.toFixed(2)}%)`}</span> : null}</div>
            </div>
            <span className={`rounded px-1.5 py-0.5 text-[0.625rem] ${feedBadge === "Live" ? "bg-profit/15 text-profit" : "bg-elevated text-muted"}`} title={stream.detail || undefined}>{feedBadge}</span>
            <div className="ml-auto flex flex-wrap gap-1">
              {CHART_SPANS.map((span) => (
                <button key={span} className={`px-1.5 py-0.5 text-[0.6875rem] ${timeframe === span ? "bg-elevated text-text" : "text-muted"}`} onClick={() => setTimeframe(span)}>{span}</button>
              ))}
            </div>
            <select className="py-0.5 text-[0.6875rem]" value={chartType} aria-label="Chart type" onChange={(event) => setChartType(event.target.value as ChartType)}>
              <option value="candle">Candles</option>
              <option value="bar">OHLC</option>
              <option value="line">Line</option>
              <option value="area">Area</option>
            </select>
            <button className="border border-border px-2 py-0.5 text-[0.6875rem]" onClick={() => setPanel(panel === "indicators" ? null : "indicators")}>Indicators</button>
            <button className="border border-border px-2 py-0.5 text-[0.6875rem]" onClick={() => setPanel(panel === "layouts" ? null : "layouts")}>Layouts</button>
            <button className="border border-border px-2 py-0.5 text-[0.6875rem]" title="Reset chart" onClick={() => handleRef.current?.reset()}>Reset</button>
            <button className="border border-border px-2 py-0.5 text-[0.6875rem]" title="Export chart" onClick={() => handleRef.current?.png(symbol)}>Export</button>
          </div>
          {panel === "indicators" ? (
            <div className="grid gap-2 border-b border-border bg-elevated p-2 text-xs sm:grid-cols-2">
              <Flag label="SMA" on={flags.sma} toggle={() => setFlags({ ...flags, sma: !flags.sma })} extra={<span className="flex gap-1"><Num value={indicators.smaFast} set={(value) => setIndicators({ ...indicators, smaFast: value })} /><Num value={indicators.smaSlow} set={(value) => setIndicators({ ...indicators, smaSlow: value })} /></span>} />
              <Flag label="EMA" on={flags.ema} toggle={() => setFlags({ ...flags, ema: !flags.ema })} extra={<Num value={indicators.ema} set={(value) => setIndicators({ ...indicators, ema: value })} />} />
              <Flag label="Bollinger" on={flags.bands} toggle={() => setFlags({ ...flags, bands: !flags.bands })} extra={<span className="flex gap-1"><Num value={indicators.bandsPeriod} set={(value) => setIndicators({ ...indicators, bandsPeriod: value })} /><Num value={indicators.bandsMult} set={(value) => setIndicators({ ...indicators, bandsMult: value })} /></span>} />
              <Flag label="VWAP" on={flags.vwap} toggle={() => setFlags({ ...flags, vwap: !flags.vwap })} />
              <Flag label="Volume" on={flags.volume} toggle={() => setFlags({ ...flags, volume: !flags.volume })} />
              <Flag label="Supertrend" on={flags.supertrend} toggle={() => setFlags({ ...flags, supertrend: !flags.supertrend })} extra={<span className="flex gap-1"><Num value={indicators.supertrendPeriod} set={(value) => setIndicators({ ...indicators, supertrendPeriod: value })} /><Num value={indicators.supertrendMult} set={(value) => setIndicators({ ...indicators, supertrendMult: value })} /></span>} />
              <label className="flex items-center gap-2">Oscillator
                <select className="py-0.5" value={flags.oscillator} onChange={(event) => setFlags({ ...flags, oscillator: event.target.value as Flags["oscillator"] })}>
                  <option value="none">None</option>
                  <option value="rsi">RSI</option>
                  <option value="macd">MACD</option>
                </select>
                <Num value={indicators.rsi} set={(value) => setIndicators({ ...indicators, rsi: value })} />
                <Num value={indicators.macdFast} set={(value) => setIndicators({ ...indicators, macdFast: value })} />
                <Num value={indicators.macdSlow} set={(value) => setIndicators({ ...indicators, macdSlow: value })} />
                <Num value={indicators.macdSignal} set={(value) => setIndicators({ ...indicators, macdSignal: value })} />
              </label>
              <button className="justify-self-start border border-border px-2 py-1" onClick={() => { setFlags(EMPTY_FLAGS); setIndicators(DEFAULT_INDICATORS); }}>Reset indicators</button>
            </div>
          ) : null}
          {panel === "layouts" ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-elevated p-2 text-xs">
              <input value={layoutName} onChange={(event) => setLayoutName(event.target.value)} placeholder="Layout name" className="py-1" />
              <button className="border border-border px-2 py-1" onClick={() => {
                const name = layoutName.trim();
                if (!name) return;
                const next = [...layouts.filter((item) => item.name !== name), { id: key(), name, symbol, timeframe, chartType, indicators, flags }];
                setLayouts(next);
                localStorage.setItem("td-layouts", JSON.stringify(next));
                setLayoutName("");
              }}>Save</button>
              {layouts.map((layout) => (
                <span key={layout.id} className="flex items-center gap-1 border border-border px-1">
                  <button onClick={() => { desk.chooseSymbol(layout.symbol); setTimeframe(layout.timeframe); setChartType(layout.chartType); setIndicators(layout.indicators); setFlags(layout.flags); }}>{layout.name}</button>
                  <button title="Delete layout" onClick={() => { const next = layouts.filter((item) => item.id !== layout.id); setLayouts(next); localStorage.setItem("td-layouts", JSON.stringify(next)); }}>×</button>
                </span>
              ))}
              {layouts.length === 0 ? <span className="text-muted">No saved layouts.</span> : null}
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1">
            <div className="flex w-10 shrink-0 flex-col gap-1 border-r border-border bg-panel p-1">
              {TOOLS.map(([id, label]) => (
                <button key={id} title={label} aria-label={label} className={`h-7 text-[0.625rem] ${tool === id ? "bg-primary text-on-primary" : "text-muted"}`} onClick={() => { setTool(id); if (id === "text") setAnnotation("Note"); }}>{id.slice(0, 2).toUpperCase()}</button>
              ))}
              {tool === "text" ? <input value={annotation} onChange={(event) => setAnnotation(event.target.value)} className="w-full px-0.5 py-1 text-[0.625rem]" aria-label="Annotation text" /> : null}
            </div>
            <div className="relative min-h-0 min-w-0 flex-1">
              {chartLoading ? <div className="absolute inset-0 z-10 grid place-items-center bg-panel/70 text-xs text-muted">Loading {symbol} {timeframe}…</div> : null}
              {chartError ? <div className="grid h-full place-items-center p-6 text-center text-sm text-loss">{chartError}</div> : (
                <ChartPanel
                  candles={candles}
                  compare={[]}
                  chartType={chartType}
                  showSma={flags.sma}
                  showEma={flags.ema}
                  showBands={flags.bands}
                  showVwap={flags.vwap}
                  showVolume={flags.volume}
                  showSupertrend={flags.supertrend}
                  indicators={indicators}
                  oscillator={flags.oscillator}
                  tool={tool}
                  annotation={annotation}
                  drawings={drawings}
                  onDrawings={(next) => { setDrawings(next); saveDrawings(symbol, next); }}
                  onTool={setTool}
                  handleRef={handleRef}
                  scheme={scheme}
                  paint={desk.appearance.chart}
                  streamKey={`${symbol}:${timeframe}:${chartType}:${flags.oscillator}:${flags.sma}:${flags.ema}:${flags.bands}:${flags.vwap}:${flags.volume}:${flags.supertrend}:${indicators.smaFast}:${indicators.smaSlow}:${indicators.ema}:${indicators.bandsPeriod}:${indicators.bandsMult}:${indicators.rsi}:${indicators.macdFast}:${indicators.macdSlow}:${indicators.macdSignal}:${indicators.supertrendPeriod}:${indicators.supertrendMult}`}
                />
              )}
            </div>
          </div>
          <p className="truncate border-t border-border px-2 py-1 text-[0.625rem] text-muted">{candleNote || "Waiting for candle data."}</p>
          <div className="h-36 shrink-0 overflow-auto border-t border-border bg-panel">
            <div className="flex gap-2 border-b border-border px-2 py-1 text-xs">
              <button className={dock === "positions" ? "text-text" : "text-muted"} onClick={() => setDock("positions")}>Positions</button>
              <button className={dock === "orders" ? "text-text" : "text-muted"} onClick={() => setDock("orders")}>Orders</button>
              <span className="ml-auto text-[0.625rem] text-muted">Practice ledger</span>
            </div>
            {dock === "positions" ? (
              <table className="text-xs">
                <thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>LTP</th><th>P&L</th></tr></thead>
                <tbody>
                  {(portfolio?.positions.length ?? 0) === 0 ? <tr><td colSpan={5} className="text-muted">No open practice positions.</td></tr> : portfolio?.positions.map((row) => (
                    <tr key={row.symbol}><td>{row.symbol}</td><td className="num">{row.quantity}</td><td className="num">{row.averageCost}</td><td className="num">{row.mark ?? "—"}</td><td className="num">{row.unrealized ?? "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="text-xs">
                <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Status</th></tr></thead>
                <tbody>
                  {(book?.orders.length ?? 0) === 0 ? <tr><td colSpan={6} className="text-muted">No practice orders in this period.</td></tr> : book?.orders.slice(0, 8).map((row) => (
                    <tr key={row.id}><td>{istTime(row.submittedAt)}</td><td>{row.symbol}</td><td className={row.side === "BUY" ? "up" : "down"}>{row.side}</td><td>{row.type}</td><td className="num">{row.filledQuantity}/{row.quantity}</td><td>{row.status}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
        <aside className={`${mobile === "order" ? "flex" : "hidden"} min-h-0 flex-col border-l border-border bg-panel lg:flex`}>
          <div className="border-b border-border p-3 text-xs">
            <div className="flex items-baseline justify-between"><span className="text-sm font-semibold">{symbol}</span><span className="text-muted">{quote ? "NSE" : ""}</span></div>
            <div className={`num mt-1 text-lg ${tone(selectedMove?.abs)}`}>{quote ? money(quote.last) : "—"}</div>
            <div className={`num ${tone(selectedMove?.abs)}`}>{selectedMove ? `${selectedMove.abs >= 0 ? "+" : ""}${selectedMove.abs.toFixed(2)} (${selectedMove.pct.toFixed(2)}%)` : "Change unavailable"}</div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
              <Stat label="Open" value={quote ? money(quote.open) : "—"} />
              <Stat label="High" value={quote ? money(quote.high) : "—"} />
              <Stat label="Low" value={quote ? money(quote.low) : "—"} />
              <Stat label="Prev" value={quote ? money(quote.previousClose) : "—"} />
              <Stat label="Volume" value={quote?.volume && quote.volume !== "0" ? Number(quote.volume).toLocaleString("en-IN") : "Unavailable"} />
              <Stat label="Bid" value={quote ? money(quote.bid) : "—"} />
              <Stat label="Ask" value={quote ? money(quote.ask) : "—"} />
              <Stat label="As of" value={istTime(quote?.asOf)} />
            </dl>
            <p className="mt-2 text-[0.625rem] text-muted">{quote?.marketOpen ? "Cash session open" : "Cash session closed or unknown"} · {quote?.message || "No quote yet."}</p>
          </div>
          <form className="flex flex-1 flex-col gap-2 overflow-auto p-3 text-xs" onSubmit={(event) => { event.preventDefault(); if (canTrade) setReview(true); }}>
            <div className="grid grid-cols-2 gap-1">
              <button type="button" className={`py-2 ${side === "BUY" ? "bg-profit text-on-signal" : "border border-border"}`} onClick={() => setSide("BUY")}>Buy</button>
              <button type="button" className={`py-2 ${side === "SELL" ? "bg-loss text-on-signal" : "border border-border"}`} onClick={() => setSide("SELL")}>Sell</button>
            </div>
            <Field label="Instrument" value={symbol} readOnly />
            <Field label="Exchange / segment" value="NSE equity" readOnly />
            <Field label="Product" value="Practice delivery" readOnly />
            <label>Order type
              <select className="mt-1 w-full" value={orderType} onChange={(event) => setOrderType(event.target.value as typeof orderType)}>
                <option value="MARKET">Market</option>
                <option value="LIMIT">Limit</option>
                <option value="STOP">Stop-loss market</option>
                <option value="STOP_LIMIT">Stop-loss limit</option>
                <option value="TARGET">Target</option>
              </select>
            </label>
            <label>Quantity
              <input className="mt-1 w-full" inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
            </label>
            {orderType !== "MARKET" && orderType !== "STOP" ? <label>Limit price<input className="mt-1 w-full" value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} /></label> : null}
            {orderType === "STOP" || orderType === "STOP_LIMIT" ? <label>Trigger price<input className="mt-1 w-full" value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} /></label> : null}
            <Field label="Validity" value="Practice session" readOnly />
            <div className="border border-border p-2 text-[0.6875rem] text-muted">
              <div className="flex justify-between"><span>Estimated value</span><span className="num text-text">{estimate ? money(estimate.notional) : "—"}</span></div>
              <div className="mt-1 flex justify-between"><span>Illustrative charges</span><span className="num text-text">{estimate ? money(estimate.charges) : "—"}</span></div>
              <p className="mt-1">Charges follow the practice model, not a broker margin statement.</p>
            </div>
            {desk.mode === "live" ? <p className="text-warning">Paper order at live prices. Virtual money only; nothing is sent to Dhan. Real orders: Accounts → Live.</p> : null}
            {desk.user && !mayPractice(desk.user) ? <p className="text-muted">Practice orders are available on accounts with trading enabled.</p> : null}
            {orderMessage ? <p className="text-text">{orderMessage}</p> : null}
            <button className={`mt-auto py-2 text-white ${side === "BUY" ? "bg-profit" : "bg-loss"}`} disabled={!canTrade}>Review {side.toLowerCase()}</button>
          </form>
        </aside>
      </div>
      {menu ? (
        <div className="fixed z-40 min-w-36 border border-border bg-panel py-1 text-xs shadow-lg" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
          <button className="block w-full px-3 py-1 text-left hover:bg-elevated" onClick={() => { desk.chooseSymbol(menu.symbol); setMobile("chart"); setMenu(null); }}>Chart</button>
          <button className="block w-full px-3 py-1 text-left hover:bg-elevated" onClick={() => { desk.chooseSymbol(menu.symbol); setSide("BUY"); setMobile("order"); setMenu(null); }}>Buy</button>
          <button className="block w-full px-3 py-1 text-left hover:bg-elevated" onClick={() => { desk.chooseSymbol(menu.symbol); setSide("SELL"); setMobile("order"); setMenu(null); }}>Sell</button>
          <button className="block w-full px-3 py-1 text-left hover:bg-elevated" onClick={() => { void watchAction("remove", { symbol: menu.symbol }); setMenu(null); }}>Remove</button>
        </div>
      ) : null}
      {review ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-sm border border-border bg-panel p-4 text-sm">
            <h2 className="font-semibold">Confirm practice {side}</h2>
            <p className="mt-2 text-xs text-muted">This is a simulated order. Nothing is sent to a broker. The status you see next is the ledger result.</p>
            <dl className="mt-3 space-y-1 text-xs">
              <div className="flex justify-between"><dt>Symbol</dt><dd>{symbol}</dd></div>
              <div className="flex justify-between"><dt>Type</dt><dd>{orderType}</dd></div>
              <div className="flex justify-between"><dt>Quantity</dt><dd>{quantity}</dd></div>
              <div className="flex justify-between"><dt>Limit</dt><dd>{limitPrice || "—"}</dd></div>
              <div className="flex justify-between"><dt>Trigger</dt><dd>{stopPrice || "—"}</dd></div>
              <div className="flex justify-between"><dt>Estimate</dt><dd>{estimate ? money(estimate.notional) : "—"}</dd></div>
            </dl>
            <div className="mt-4 flex justify-end gap-2">
              <button className="border border-border px-3 py-1 text-xs" onClick={() => setReview(false)}>Back</button>
              <button className={`px-3 py-1 text-xs text-white ${side === "BUY" ? "bg-profit" : "bg-loss"}`} disabled={busy} onClick={() => void submitOrder()}>{busy ? "Sending…" : "Place practice order"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[0.625rem] text-muted">{label}</dt><dd className="num">{value}</dd></div>;
}

function Field({ label, value }: { label: string; value: string; readOnly?: boolean }) {
  return <label>{label}<input className="mt-1 w-full" value={value} readOnly /></label>;
}

function Flag({ label, on, toggle, extra }: { label: string; on: boolean; toggle: () => void; extra?: ReactNode }) {
  return <label className="flex items-center justify-between gap-2"><span><input type="checkbox" className="mr-2" checked={on} onChange={toggle} />{label}</span>{extra}</label>;
}

function Num({ value, set }: { value: number; set: (value: number) => void }) {
  return <input className="w-14 py-0.5" value={value} onChange={(event) => set(Number(event.target.value) || 0)} />;
}
