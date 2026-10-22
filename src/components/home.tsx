"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, CandlestickChart, ChevronDown, GitBranch, Layers, ListPlus, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { api, ApiError, moveOf, type Quote } from "@/components/api";
import { useDesk, type IndexQuote } from "@/components/shell";
import { StockLogo, StockSearchField, WatchStar } from "@/components/stock-identity";
import { Badge, Button, cx, PriceCell, SegmentedControl, Skeleton, Sparkline, Tabs, type Tone } from "@/components/ui";
import { compactVolume, inr, parseInr, signedNumber, signedPercent, signOf, splitInr } from "@/lib/format";

type List = { id: string; name: string; items: Array<{ symbol: string; name: string; exchange: string }> };
type Portfolio = {
  periodLabel?: string;
  startingCapital: string;
  allocatedCapital: string;
  cashAvailable: string;
  holdingsValue: string;
  equity: string;
  unrealized: string;
  realized: string;
  netPnl: string;
  performanceReturn: string;
  dailyReturn: string | null;
  completedTrades: number;
  winningTrades: number;
  losingTrades: number;
  stale?: boolean;
  equityCurve?: Array<{ at: string; equity: string }>;
  positions: Array<{ symbol: string }>;
};
type Hit = { symbol: string; name: string; exchange: string };
type Board = { gainers: Mover[]; losers: Mover[]; volume: Mover[]; message: string };
type Mover = { symbol: string; name: string; last: number; previous: number; change: number; percent: number; volume: number | null };
type Candle = { time: number; close: number };
type PortfolioState = "loading" | "ready" | "empty" | "forbidden" | "error";
type Range = "1D" | "1W" | "1M" | "ALL";

const SHORTCUTS = [
  { label: "Equities", body: "Order ticket and depth", href: "/terminal", icon: CandlestickChart },
  { label: "Option chain", body: "Strikes, greeks, lots", href: "/options", icon: GitBranch },
  { label: "Charts", body: "Indicators and drawings", href: "/chart", icon: BarChart3 },
  { label: "Positions", body: "Open book and exits", href: "/positions", icon: Layers },
] as const;

const UNAVAILABLE = [
  { label: "Mutual funds", note: "Mutual fund orders, fund-house logos, and NAVs are not on this ledger." },
  { label: "ETFs", note: "A separate ETF book is not returned by the current account." },
  { label: "Futures", note: "Futures orders are not available on this practice ledger." },
  { label: "Commodities", note: "Commodity orders are not available on this practice ledger." },
  { label: "Securities lending", note: "Securities lending is not available on this practice ledger." },
  { label: "Gold and silver", note: "A gold or silver product is not returned by the connected account." },
] as const;

const INDEX_CARDS = [
  { name: "Nifty 50", symbol: "NIFTY", label: "NIFTY 50", context: "NSE benchmark · 50 stocks", volatility: false },
  { name: "Nifty Bank", symbol: "BANKNIFTY", label: "BANK NIFTY", context: "Banking sector index", volatility: false },
  { name: "India VIX", symbol: "INDIAVIX", label: "INDIA VIX", context: "Expected 30-day volatility", volatility: true },
] as const;

const RANGE_MS: Record<Range, number> = { "1D": 864e5, "1W": 7 * 864e5, "1M": 30 * 864e5, ALL: Infinity };

function istDay(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function Home() {
  const desk = useDesk();
  const [lists, setLists] = useState<List[]>([]);
  const [listsState, setListsState] = useState<"loading" | "ready" | "error">("loading");
  const [listId, setListId] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState("");
  const [searchError, setSearchError] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [portfolioState, setPortfolioState] = useState<PortfolioState>("loading");
  const [sort, setSort] = useState<"name" | "price" | "change">("name");
  const [mover, setMover] = useState<"gainers" | "losers" | "volume">("gainers");
  const [board, setBoard] = useState<Board | null>(null);
  const [boardError, setBoardError] = useState("");

  const loadPortfolio = useCallback(() => api<Portfolio>("/api/portfolio").then((data) => { setPortfolio(data); setPortfolioState("ready"); }).catch((error: unknown) => {
    setPortfolio(null);
    const status = error instanceof ApiError ? error.status : 0;
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    setPortfolioState(status === 404 || message.includes("not found") ? "empty" : status === 403 ? "forbidden" : "error");
  }), []);

  useEffect(() => {
    api<{ lists: List[] }>("/api/watchlists").then((data) => {
      setLists(data.lists);
      setListsState("ready");
      const saved = localStorage.getItem("td-watchlist");
      setListId(saved && data.lists.some((item) => item.id === saved) ? saved : data.lists[0]?.id ?? "");
    }).catch(() => setListsState("error"));
    void loadPortfolio();
    const loadBoard = () => api<Board>("/api/market/movers").then((data) => { setBoard(data); setBoardError(""); }).catch((error: unknown) => setBoardError(error instanceof Error ? error.message : "Market movers unavailable."));
    loadBoard();
    const timer = window.setInterval(loadBoard, 60000);
    const refreshLedger = () => api<Portfolio>("/api/portfolio").then((data) => { setPortfolio(data); setPortfolioState("ready"); }).catch(() => undefined);
    window.addEventListener("td-ledger", refreshLedger);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("td-ledger", refreshLedger);
    };
  }, [loadPortfolio]);

  const list = lists.find((item) => item.id === listId) ?? lists[0];
  const symbols = useMemo(() => list?.items.map((item) => item.symbol) ?? [], [list]);

  useEffect(() => {
    if (!symbols.length) return;
    let stop = false;
    const load = () => {
      api<{ quotes: Array<Quote | { symbol: string; error: string }> }>(`/api/market/quotes?symbols=${symbols.join(",")}`)
        .then((data) => {
          if (stop) return;
          const next: Record<string, Quote> = {};
          for (const row of data.quotes) if ("last" in row) next[row.symbol] = row;
          setQuotes(next);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [symbols]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (query.trim().length < 1) { setHits([]); setSearched(""); return; }
      api<Hit[]>(`/api/instruments?q=${encodeURIComponent(query)}`).then((rows) => { setHits(rows); setSearched(query); setSearchError(false); }).catch(() => { setHits([]); setSearched(query); setSearchError(true); });
    }, 160);
    return () => window.clearTimeout(handle);
  }, [query]);

  const rows = useMemo(() => {
    const items = [...(list?.items ?? [])];
    if (sort === "name") items.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "price") items.sort((a, b) => Number(quotes[b.symbol]?.last ?? 0) - Number(quotes[a.symbol]?.last ?? 0));
    if (sort === "change") items.sort((a, b) => (moveOf(quotes[b.symbol]?.last, quotes[b.symbol]?.previousClose)?.pct ?? -999) - (moveOf(quotes[a.symbol]?.last, quotes[a.symbol]?.previousClose)?.pct ?? -999));
    return items;
  }, [list, sort, quotes]);

  const searchStatus = query.trim().length < 1 ? "idle" : searched !== query ? "loading" : searchError ? "error" : hits.length === 0 ? "empty" : "ready";
  const onList = (symbol: string) => Boolean(list?.items.some((item) => item.symbol === symbol));

  function toggleWatch(symbol: string, name: string, exchange: string) {
    const target = list ?? lists[0];
    if (!target) {
      desk.toast("No watchlist is available for this account.");
      return;
    }
    const active = target.items.some((item) => item.symbol === symbol);
    void api("/api/watchlists", { action: active ? "remove" : "add", id: target.id, symbol }).then(() => {
      setLists((current) => current.map((item) => item.id === target.id
        ? { ...item, items: active ? item.items.filter((row) => row.symbol !== symbol) : [...item.items, { symbol, name, exchange }] }
        : item));
    }).catch((error: unknown) => desk.toast(error instanceof Error ? error.message : "Watchlist update failed."));
  }

  const firstName = desk.user?.name?.split(" ")[0];

  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="mx-auto grid max-w-[1680px] gap-4 p-3 sm:p-4 lg:gap-5 lg:p-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4 lg:gap-5">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">{desk.mode === "demo" ? "Practice account" : "Connected account · read only"}</p>
              <h1 className="mt-1 text-page font-semibold">{firstName ? `Welcome back, ${firstName}` : "Overview"}</h1>
            </div>
            <MarketStatus />
          </header>

          <PortfolioHero state={portfolioState} portfolio={portfolio} onRetry={() => { setPortfolioState("loading"); void loadPortfolio(); }} />

          <IndexCards indices={desk.indices} note={desk.indexNote} onOpen={desk.openChart} />

          <div className="grid min-w-0 gap-4 lg:gap-5 2xl:grid-cols-[minmax(0,1fr)_320px]">
            <MarketMovers board={board} error={boardError} mover={mover} onMover={setMover} onPick={desk.chooseSymbol} />
            <Shortcuts />
          </div>
        </div>

        <aside className="surface flex min-h-[520px] min-w-0 flex-col overflow-hidden xl:sticky xl:top-6 xl:max-h-[calc(100dvh-var(--topbar)-48px)] xl:self-start">
          <div className="border-b border-border-soft p-4 pb-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-title font-semibold">Watchlist</h2>
                <p className="text-data text-muted">{list ? `${list.items.length} instrument${list.items.length === 1 ? "" : "s"}` : listsState === "error" ? "Unavailable" : "Loading…"}</p>
              </div>
              {lists.length > 1 ? (
                <label className="relative">
                  <span className="sr-only">Choose watchlist</span>
                  <select className="h-8 appearance-none py-0 pl-2.5 pr-7 text-data font-medium" value={list?.id ?? ""} onChange={(event) => { setListId(event.target.value); localStorage.setItem("td-watchlist", event.target.value); }}>
                    {lists.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden />
                </label>
              ) : null}
            </div>
            <StockSearchField
              query={query}
              onQuery={setQuery}
              hits={hits}
              status={searchStatus}
              watched={onList}
              placeholder="Search and add instruments"
              onSelect={(hit) => { desk.openChart(hit.symbol); setQuery(""); setHits([]); }}
              onToggleWatch={(hit) => toggleWatch(hit.symbol, hit.name, hit.exchange)}
            />
          </div>
          <div className="flex items-center justify-between gap-2 px-4 py-2">
            <span className="eyebrow">Sort</span>
            <SegmentedControl size="sm" label="Sort watchlist" value={sort} onChange={setSort} options={[{ id: "name", label: "Name" }, { id: "price", label: "LTP" }, { id: "change", label: "% Chg" }]} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
            {listsState === "loading" ? <WatchlistSkeleton /> : null}
            {listsState === "error" ? <InlineState icon={<WifiOff className="h-5 w-5" />} title="Watchlist unavailable" body="The saved watchlists could not be loaded. Refresh the page to retry." /> : null}
            {listsState === "ready" && rows.length === 0 ? (
              <InlineState icon={<ListPlus className="h-5 w-5" />} title="Your watchlist is empty" body="Search above and tap the star to track an instrument here." />
            ) : null}
            <ul>
              {rows.map((item) => <WatchRow key={item.symbol} item={item} quote={quotes[item.symbol]} onOpen={() => desk.chooseSymbol(item.symbol)} onRemove={() => toggleWatch(item.symbol, item.name, item.exchange)} />)}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MarketStatus() {
  const desk = useDesk();
  const mode = desk.health?.marketMode;
  const label = !desk.online ? "Disconnected" : mode === "REALTIME" ? "Live market data" : mode === "DELAYED" ? "Delayed market data" : mode === "UNAVAILABLE" ? "Market data unavailable" : mode ? `${mode.toLowerCase()} data` : "Connecting…";
  const tone = !desk.online || mode === "UNAVAILABLE" ? "bg-loss" : mode === "REALTIME" ? "bg-profit" : mode === "DELAYED" ? "bg-warning" : "bg-muted";
  return (
    <span className="inline-flex items-center gap-2 rounded-pill border border-border-soft bg-panel px-3 py-1.5 text-data font-medium text-text-2 shadow-e1" title={desk.health?.marketMessage}>
      <span className={cx("h-2 w-2 rounded-full", tone, mode === "REALTIME" && desk.online && "live-dot text-profit")} aria-hidden />
      {label}
    </span>
  );
}

function PortfolioHero({ state, portfolio, onRetry }: { state: PortfolioState; portfolio: Portfolio | null; onRetry: () => void }) {
  const [range, setRange] = useState<Range>("ALL");
  const curve = useMemo(() => (portfolio?.equityCurve ?? []).flatMap((point) => {
    const value = parseInr(point.equity);
    const at = new Date(point.at).getTime();
    return value == null || !Number.isFinite(at) ? [] : [{ at, value }];
  }), [portfolio?.equityCurve]);
  const latest = curve.length ? curve[curve.length - 1].at : 0;
  const shown = useMemo(() => (range === "ALL" ? curve : curve.filter((point) => point.at >= latest - RANGE_MS[range])), [curve, range, latest]);
  const ranges = (["1D", "1W", "1M", "ALL"] as const).filter((item) => item === "ALL" || (curve.length > 2 && curve[0].at < latest - RANGE_MS[item] && curve.filter((point) => point.at >= latest - RANGE_MS[item]).length >= 2));

  if (state === "loading") return <HeroSkeleton />;
  if (state !== "ready" || !portfolio) {
    const copy = {
      empty: { icon: <Layers className="h-5 w-5" />, title: "No demo capital assigned yet", body: "An administrator allocates practice capital from Demo Capital Management. Your portfolio appears here as soon as it is assigned." },
      forbidden: { icon: <ShieldAlert className="h-5 w-5" />, title: "Practice portfolios belong to student accounts", body: "This account role does not hold a demo ledger. Use Admin to manage student capital, or switch to Live view to read the connected broker account." },
      error: { icon: <WifiOff className="h-5 w-5" />, title: "The demo account could not be retrieved", body: "The portfolio service did not respond. Your ledger is unchanged." },
      loading: { icon: null, title: "", body: "" },
      ready: { icon: null, title: "", body: "" },
    }[state];
    return (
      <section className="hero-surface flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:p-7">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-border bg-elevated text-primary shadow-e1">{copy.icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-section font-semibold">{copy.title}</h2>
          <p className="mt-1 max-w-2xl text-dense text-muted">{copy.body}</p>
        </div>
        {state === "error" ? <Button icon={<RefreshCw className="h-4 w-4" />} onClick={onRetry}>Retry</Button> : null}
      </section>
    );
  }

  const first = shown[0]?.value;
  const last = shown[shown.length - 1]?.value;
  const curveTone: Tone = first == null || last == null || last === first ? "primary" : last > first ? "profit" : "loss";
  const pnlTone = signOf(portfolio.netPnl);
  const dayTone = signOf(portfolio.dailyReturn);
  const { prefix, body } = splitInr(portfolio.equity);

  return (
    <section className="hero-surface p-5 sm:p-6 lg:p-7" aria-label="Portfolio summary">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="eyebrow">Portfolio equity</span>
            <Badge tone="demo">Practice</Badge>
            {portfolio.periodLabel ? <span className="text-data text-muted">{portfolio.periodLabel}</span> : null}
            {portfolio.stale ? <Badge tone="warning" title="One or more marks are missing or stale. Equity excludes unknown marks.">Stale marks</Badge> : null}
          </div>
          <p className="num mt-3 flex items-baseline gap-1 font-semibold leading-none tracking-[-0.03em] text-text">
            <span className="text-[clamp(22px,2.4vw,30px)] text-text-2">{prefix}</span>
            <span className="text-[clamp(34px,4.2vw,48px)]">{body}</span>
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <DeltaPill tone={pnlTone} label="Net P&L" value={portfolio.netPnl} extra={portfolio.performanceReturn} />
            {portfolio.dailyReturn ? <DeltaPill tone={dayTone} label="Today" value={portfolio.dailyReturn} /> : null}
          </div>
        </div>
        {curve.length >= 2 ? (
          <SegmentedControl size="sm" label="Equity range" value={range} onChange={setRange} options={ranges.map((item) => ({ id: item, label: item === "ALL" ? "All" : item }))} />
        ) : null}
      </div>

      <div className="mt-5 h-24 sm:h-28">
        {shown.length >= 2 ? (
          <Sparkline values={shown.map((point) => point.value)} tone={curveTone} width={800} height={112} className="h-full w-full" label={`Equity from ${inr(first)} to ${inr(last)}`} />
        ) : (
          <div className="grid h-full place-items-center rounded-md border border-dashed border-border bg-sunken/40 px-4 text-center text-data text-muted">
            {curve.length < 2 ? "The equity curve appears once two snapshots exist. A snapshot is stored at most every 15 minutes while the account is open." : "No snapshots in this range."}
          </div>
        )}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border-soft pt-5 md:grid-cols-4">
        <Metric label="Buying power" value={portfolio.cashAvailable} />
        <Metric label="Holdings value" value={portfolio.holdingsValue} />
        <Metric label="Realized P&L" value={portfolio.realized} tone={signOf(portfolio.realized)} />
        <Metric label="Unrealized P&L" value={portfolio.unrealized} tone={signOf(portfolio.unrealized)} />
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 text-data text-muted">
        <span>Allocated <span className="num font-medium text-text-2">{portfolio.allocatedCapital}</span></span>
        <span>Open <span className="num font-medium text-text-2">{portfolio.positions.length}</span></span>
        <span>Closed <span className="num font-medium text-text-2">{portfolio.completedTrades}</span> · <span className="text-profit">{portfolio.winningTrades}W</span> / <span className="text-loss">{portfolio.losingTrades}L</span></span>
        <div className="ml-auto flex gap-2">
          <Link href="/positions" className="inline-flex h-[34px] items-center gap-1.5 rounded-input border border-border bg-elevated px-3.5 text-dense font-semibold text-text shadow-e1 transition-colors hover:border-border-strong hover:bg-hover">Positions</Link>
          <Link href="/terminal" className="inline-flex h-[34px] items-center gap-1.5 rounded-input bg-primary px-3.5 text-dense font-semibold text-on-primary shadow-e1 transition-colors hover:bg-primary-hover">Trade <ArrowRight className="h-4 w-4" aria-hidden /></Link>
        </div>
      </div>
      <p className="mt-4 text-micro text-muted">Practice ledger. Demo capital is allocated by an admin. Open-position marks use the latest quote, not the replay cursor.</p>
    </section>
  );
}

function DeltaPill({ tone, label, value, extra }: { tone: "profit" | "loss" | "neutral"; label: string; value: string; extra?: string }) {
  const style = tone === "profit" ? "border-profit/25 bg-profit-soft text-profit" : tone === "loss" ? "border-loss/25 bg-loss-soft text-loss" : "border-border bg-sunken text-text-2";
  const Arrow = tone === "profit" ? ArrowUpRight : tone === "loss" ? ArrowDownRight : null;
  return (
    <span className={cx("inline-flex h-8 items-center gap-1.5 rounded-pill border px-3 text-data font-semibold", style)}>
      <span className="font-medium opacity-80">{label}</span>
      {Arrow ? <Arrow className="h-3.5 w-3.5" aria-hidden /> : null}
      <span className="num">{value}</span>
      {extra && extra !== "—" ? <span className="num opacity-80">({extra})</span> : null}
    </span>
  );
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "profit" | "loss" | "neutral" }) {
  return (
    <div className="min-w-0">
      <dt className="text-data text-muted">{label}</dt>
      <dd className={cx("num mt-1 truncate text-title font-semibold", tone === "profit" ? "text-profit" : tone === "loss" ? "text-loss" : "text-text")}>{value}</dd>
    </div>
  );
}

function HeroSkeleton() {
  return (
    <section className="hero-surface p-5 sm:p-6 lg:p-7" aria-busy="true" aria-label="Loading portfolio">
      <Skeleton className="h-3 w-32" />
      <Skeleton className="mt-4 h-11 w-64" />
      <div className="mt-4 flex gap-2"><Skeleton className="h-8 w-48 rounded-pill" /><Skeleton className="h-8 w-28 rounded-pill" /></div>
      <Skeleton className="mt-5 h-24 w-full rounded-md" />
      <div className="mt-5 grid grid-cols-2 gap-6 border-t border-border-soft pt-5 md:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div key={item}><Skeleton className="h-3 w-20" /><Skeleton className="mt-2 h-5 w-28" /></div>)}
      </div>
    </section>
  );
}

function IndexCards({ indices, note, onOpen }: { indices: IndexQuote[]; note: string; onOpen: (symbol: string) => void }) {
  const [series, setSeries] = useState<Record<string, number[] | "error">>({});
  useEffect(() => {
    let stop = false;
    const load = () => {
      for (const card of INDEX_CARDS) {
        api<{ candles: Candle[] }>(`/api/market/candles?symbol=${card.symbol}&timeframe=5m`)
          .then((data) => {
            if (stop) return;
            const candles = data.candles.filter((candle) => Number.isFinite(candle.close));
            const day = candles.length ? istDay(candles[candles.length - 1].time) : "";
            setSeries((current) => ({ ...current, [card.symbol]: candles.filter((candle) => istDay(candle.time) === day).map((candle) => candle.close) }));
          })
          .catch(() => { if (!stop) setSeries((current) => ({ ...current, [card.symbol]: "error" })); });
      }
    };
    load();
    const timer = window.setInterval(load, 60000);
    return () => { stop = true; window.clearInterval(timer); };
  }, []);

  return (
    <section aria-label="Market indices">
      <div className="no-scrollbar -mx-3 flex snap-x gap-3 overflow-x-auto px-3 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-4 sm:overflow-visible sm:px-0">
        {INDEX_CARDS.map((card) => {
          const quote = indices.find((item) => item.name === card.name);
          const points = series[card.symbol];
          return <IndexCard key={card.symbol} card={card} quote={quote} points={points} note={note} onOpen={() => onOpen(card.symbol)} />;
        })}
      </div>
    </section>
  );
}

function IndexCard({ card, quote, points, note, onOpen }: { card: (typeof INDEX_CARDS)[number]; quote?: IndexQuote; points?: number[] | "error"; note: string; onOpen: () => void }) {
  const change = quote && quote.previous != null ? quote.last - quote.previous : null;
  const pct = change != null && quote?.previous ? (change / quote.previous) * 100 : null;
  const direction = change == null || change === 0 ? "flat" : change > 0 ? "up" : "down";
  const tone: Tone = card.volatility || direction === "flat" ? "info" : direction === "up" ? "profit" : "loss";
  const textTone = card.volatility || direction === "flat" ? "text-text-2" : direction === "up" ? "text-profit" : "text-loss";
  const Arrow = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : null;
  return (
    <button type="button" onClick={onOpen} className="surface surface-interactive group flex min-w-[240px] snap-start flex-col p-4 text-left sm:min-w-0" aria-label={`Open ${card.label} chart`}>
      <div className="flex w-full items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-dense font-semibold tracking-[0.01em] text-text">{card.label}</p>
          <p className="truncate text-micro text-muted">{card.context}</p>
        </div>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
      </div>
      {quote ? (
        <>
          <PriceCell value={quote.last} className="mt-3 -ml-0.5 text-hero font-semibold text-text" />
          <p className={cx("num mt-0.5 flex items-center gap-1 text-data font-medium", textTone)}>
            {Arrow ? <Arrow className="h-3.5 w-3.5" aria-hidden /> : null}
            {change != null && pct != null ? `${signedNumber(change)} (${signedPercent(pct)})` : "Change unavailable"}
          </p>
        </>
      ) : (
        <div className="mt-3">
          {note && !note.toLowerCase().includes("loading") ? <p className="text-data text-muted">{note}</p> : <><Skeleton className="h-7 w-32" /><Skeleton className="mt-2 h-3 w-24" /></>}
        </div>
      )}
      <div className="mt-3 h-11 w-full">
        {Array.isArray(points) && points.length >= 2 ? (
          <Sparkline values={points} tone={tone} width={300} height={44} baseline={quote?.previous ?? null} className="h-full w-full" label={`${card.label} intraday trend`} />
        ) : points === "error" || (Array.isArray(points) && points.length < 2) ? (
          <p className="flex h-full items-end text-micro text-muted">Intraday trend unavailable</p>
        ) : <Skeleton className="h-full w-full rounded-sm" />}
      </div>
      {card.volatility && quote ? <p className="mt-2 text-micro text-muted">Higher readings mean larger expected swings, not gains.</p> : null}
    </button>
  );
}

function MarketMovers({ board, error, mover, onMover, onPick }: { board: Board | null; error: string; mover: "gainers" | "losers" | "volume"; onMover: (next: "gainers" | "losers" | "volume") => void; onPick: (symbol: string) => void }) {
  const rows = board?.[mover] ?? [];
  const scale = mover === "volume" ? Math.max(1, ...rows.map((row) => row.volume ?? 0)) : Math.max(0.01, ...rows.map((row) => Math.abs(row.percent)));
  return (
    <section className="surface flex min-w-0 flex-col overflow-hidden" aria-label="Market movers">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 px-4 pt-4">
        <div className="min-w-0">
          <h2 className="text-title font-semibold">Market movers</h2>
          <p className="mt-0.5 text-data text-muted">{board?.message || error || "Loading the live quote feed…"}</p>
        </div>
      </div>
      <Tabs
        className="mt-2 border-border-soft px-2"
        label="Mover type"
        value={mover}
        onChange={onMover}
        items={[{ id: "gainers", label: "Top gainers" }, { id: "losers", label: "Top losers" }, { id: "volume", label: "Most active" }]}
      />
      <div className="min-h-[240px] px-2 py-2">
        {!board && !error ? (
          <div className="space-y-1 p-2">{[0, 1, 2, 3, 4, 5].map((item) => <Skeleton key={item} className="h-9 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <InlineState icon={<BarChart3 className="h-5 w-5" />} title="No movers returned" body={error || "The feed has not returned movers for this view yet."} />
        ) : (
          <ol className="grid gap-x-6 md:grid-cols-2">
            {rows.slice(0, 10).map((row, index) => {
              const up = row.change > 0;
              const down = row.change < 0;
              const ratio = mover === "volume" ? (row.volume ?? 0) / scale : Math.abs(row.percent) / scale;
              return (
                <li key={row.symbol}>
                  <button type="button" onClick={() => onPick(row.symbol)} className="group grid w-full grid-cols-[18px_28px_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-hover">
                    <span className="num text-micro text-muted">{index + 1}</span>
                    <StockLogo symbol={row.symbol} name={row.name} size={28} />
                    <span className="min-w-0">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-dense font-semibold text-text">{row.symbol}</span>
                        <span className="num shrink-0 text-dense text-text-2">{inr(row.last).replace("₹", "")}</span>
                      </span>
                      <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-sunken" aria-hidden>
                        <span className={cx("block h-full rounded-full", mover === "volume" ? "bg-info/70" : up ? "bg-profit/75" : down ? "bg-loss/75" : "bg-muted/50")} style={{ width: `${Math.max(4, Math.min(100, ratio * 100))}%` }} />
                      </span>
                    </span>
                    <span className={cx("num w-[72px] text-right text-data font-semibold", mover === "volume" ? "text-text-2" : up ? "text-profit" : down ? "text-loss" : "text-muted")}>
                      {mover === "volume" ? compactVolume(row.volume) : signedPercent(row.percent)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

function Shortcuts() {
  const [open, setOpen] = useState(false);
  return (
    <section className="surface flex flex-col p-4" aria-label="Trade shortcuts">
      <h2 className="text-title font-semibold">Trade</h2>
      <p className="mt-0.5 text-data text-muted">Practice orders stay on the demo ledger.</p>
      <div className="mt-3 grid grid-cols-2 gap-2 2xl:grid-cols-1">
        {SHORTCUTS.map(({ label, body, href, icon: Icon }) => (
          <Link key={href} href={href} className="group flex items-center gap-3 rounded-md border border-border-soft bg-sunken/40 p-3 transition-colors hover:border-border hover:bg-hover">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-input bg-primary-soft text-primary"><Icon className="h-[18px] w-[18px]" aria-hidden /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-dense font-semibold text-text">{label}</span>
              <span className="block truncate text-micro text-muted">{body}</span>
            </span>
            <ArrowRight className="hidden h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 sm:block" aria-hidden />
          </Link>
        ))}
      </div>
      <button type="button" className="mt-3 flex items-center justify-between rounded-input px-1 py-1.5 text-left text-data text-muted transition-colors hover:text-text" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>Not on this practice ledger</span>
        <ChevronDown className={cx("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <ul className="anim-rise mt-1 space-y-2 border-t border-border-soft pt-3">
          {UNAVAILABLE.map((item) => (
            <li key={item.label} className="text-data">
              <span className="font-medium text-text-2">{item.label}</span>
              <span className="block text-micro text-muted">{item.note}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function WatchRow({ item, quote, onOpen, onRemove }: { item: List["items"][number]; quote?: Quote; onOpen: () => void; onRemove: () => void }) {
  const move = moveOf(quote?.last, quote?.previousClose);
  const last = quote ? Number(quote.last) : null;
  const low = Number(quote?.low);
  const high = Number(quote?.high);
  const position = last != null && Number.isFinite(low) && Number.isFinite(high) && high > low ? Math.min(1, Math.max(0, (last - low) / (high - low))) : null;
  const tone = move == null || move.abs === 0 ? "text-muted" : move.abs > 0 ? "text-profit" : "text-loss";
  return (
    <li className="group flex items-center gap-1 rounded-md transition-colors hover:bg-hover focus-within:bg-hover">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-2 pl-2 text-left" onClick={onOpen}>
        <StockLogo symbol={item.symbol} name={item.name} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-dense font-semibold text-text">{item.symbol}</span>
          <span className="block truncate text-micro text-muted">{item.name}</span>
        </span>
        {position != null ? (
          <span className="hidden w-10 shrink-0 sm:block" title={`Day range ${low.toFixed(2)} – ${high.toFixed(2)}`}>
            <span className="relative block h-1 rounded-full bg-sunken">
              <span className="absolute top-1/2 h-2 w-0.5 -translate-y-1/2 rounded-full bg-text-2" style={{ left: `calc(${position * 100}% - 1px)` }} />
            </span>
            <span className="sr-only">Day range position {Math.round(position * 100)}%</span>
          </span>
        ) : null}
        <span className="shrink-0 text-right">
          {quote ? <PriceCell value={last} className="block text-dense font-semibold text-text" /> : <Skeleton className="ml-auto h-4 w-16" />}
          <span className={cx("num mt-0.5 block whitespace-nowrap text-micro font-medium", tone)}>
            {move ? `${move.abs > 0 ? "▲" : move.abs < 0 ? "▼" : ""} ${signedPercent(move.pct)}` : quote ? "—" : ""}
          </span>
        </span>
      </button>
      <span className="opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <WatchStar active onToggle={onRemove} label={`Remove ${item.symbol} from watchlist`} />
      </span>
    </li>
  );
}

function WatchlistSkeleton() {
  return (
    <div className="space-y-1 p-2" aria-busy="true" aria-label="Loading watchlist">
      {[0, 1, 2, 3, 4, 5, 6].map((item) => (
        <div key={item} className="flex items-center gap-3 py-1.5">
          <Skeleton className="h-8 w-8 rounded-[28%]" />
          <div className="flex-1"><Skeleton className="h-3.5 w-20" /><Skeleton className="mt-1.5 h-2.5 w-32" /></div>
          <div><Skeleton className="h-3.5 w-16" /><Skeleton className="ml-auto mt-1.5 h-2.5 w-10" /></div>
        </div>
      ))}
    </div>
  );
}

function InlineState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span className="mb-3 grid h-11 w-11 place-items-center rounded-lg border border-border-soft bg-sunken text-muted">{icon}</span>
      <p className="text-dense font-semibold text-text">{title}</p>
      <p className="mt-1 max-w-xs text-data text-muted">{body}</p>
    </div>
  );
}

