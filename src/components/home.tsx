"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, CandlestickChart, GitBranch, History, Layers, ReceiptText, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { useDesk, type IndexQuote } from "@/components/shell";
import { StockLogo } from "@/components/stock-identity";
import { InlineState, WatchlistCard } from "@/components/watchlist-card";
import { useMobilePrefs } from "@/components/mobile-prefs";
import { Badge, Button, cx, PriceCell, SegmentedControl, Skeleton, Sparkline, type Tone } from "@/components/ui";
import { mayPractice } from "@/lib/auth/permissions";
import { parseOptionLedgerSymbol } from "@/lib/options/contract";
import { compactVolume, inr, parseInr, signedNumber, signedPercent, signOf, splitInr } from "@/lib/format";

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
type Board = { gainers: Mover[]; losers: Mover[]; volume: Mover[]; message: string };
type Mover = { symbol: string; name: string; last: number; previous: number; change: number; percent: number; volume: number | null };
type Candle = { time: number; close: number };
type PortfolioState = "loading" | "ready" | "empty" | "forbidden" | "error";
type Range = "1D" | "1W" | "1M" | "ALL";
type ActivityOrder = { id: string; symbol: string; side: string; quantity: number; filledQuantity: number; status: string; avgFill: string | null; limit: string | null; submittedAt: string; filledAt: string | null; executedAt: string | null };
type ClosedRow = { id: string; symbol: string; exitAt: string; net: string; profitable: boolean; loss: boolean };

const INDEX_CARDS = [
  { name: "Nifty 50", symbol: "NIFTY", label: "NIFTY 50", context: "NSE benchmark", volatility: false },
  { name: "Nifty Bank", symbol: "BANKNIFTY", label: "BANK NIFTY", context: "Banking index", volatility: false },
  { name: "India VIX", symbol: "INDIAVIX", label: "INDIA VIX", context: "Expected volatility", volatility: true },
] as const;

const ACTIONS = [
  { key: "chart", label: "Open chart", body: "Candles, indicators and drawings", href: "/chart", icon: CandlestickChart, tone: "bg-primary-soft text-primary" },
  { key: "options", label: "Explore options", body: "Option chain, greeks and lots", href: "/options", icon: GitBranch, tone: "bg-teal-soft text-teal" },
  { key: "replay", label: "Practice replay", body: "Trade a past session minute by minute", href: "/chart?replay=1", icon: History, tone: "bg-demo-soft text-demo" },
] as const;

const RANGE_MS: Record<Range, number> = { "1D": 864e5, "1W": 7 * 864e5, "1M": 30 * 864e5, ALL: Infinity };

function istDay(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function greeting() {
  const hour = Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

export function Home() {
  const desk = useDesk();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [portfolioState, setPortfolioState] = useState<PortfolioState>("loading");
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

  const user = desk.user;
  const mobile = useMobilePrefs();
  const live = desk.mode === "live";
  const replayAllowed = user?.features?.replay !== false;
  const activityAllowed = user ? mayPractice(user) && user.features?.orderHistory !== false : null;
  const historyHref = user?.features?.portfolio === false ? "/orders" : "/holdings#trade-history";

  return (
    <div className="h-full min-h-0 overflow-auto">
      {/* Phones and small tablets: one column in priority order (account, watchlist, market, activity,
          shortcuts); the column wrappers dissolve (contents) so each card can take its place. */}
      <div className="mx-auto grid max-w-[102.5rem] gap-3 p-3 sm:gap-4 sm:p-4 lg:p-5 xl:grid-cols-[minmax(0,1fr)_minmax(17.5rem,19.75rem)]">
        <div className="flex min-w-0 flex-col gap-4 max-lg:contents">
          <div className="min-w-0 max-lg:order-1"><WelcomeHero name={user?.name?.split(" ")[0]} live={live} indices={desk.indices} note={desk.indexNote} onOpen={desk.openChart} /></div>

          <div className="grid min-w-0 gap-4 max-lg:contents lg:grid-cols-[minmax(0,1.65fr)_minmax(16.875rem,1fr)]">
            <div className="min-w-0 max-lg:order-2 lg:contents"><AccountCard state={portfolioState} portfolio={portfolio} live={live} onRetry={() => { setPortfolioState("loading"); void loadPortfolio(); }} /></div>
            <div className="min-w-0 max-lg:hidden lg:contents"><MarketPulse indices={desk.indices} note={desk.indexNote} onOpen={desk.openChart} /></div>
          </div>

          <div className={cx("min-w-0 max-lg:order-7", !mobile.homeMarketCards && "max-lg:hidden")}><QuickActions live={live} replayAllowed={replayAllowed} /></div>

          <div className={cx("min-w-0 max-lg:order-5", !mobile.homeMarketCards && "max-lg:hidden")}><MarketMovers board={board} error={boardError} mover={mover} onMover={setMover} onPick={desk.chooseSymbol} /></div>
        </div>

        <aside className="flex min-w-0 flex-col gap-4 max-lg:contents xl:sticky xl:top-5 xl:max-h-[calc(100dvh-var(--topbar)-40px)] xl:self-start">
          <WatchlistCard className="max-lg:order-3 xl:min-h-[16.25rem] xl:flex-1" />

          <div className="min-w-0 max-lg:order-6"><RecentActivity allowed={activityAllowed} historyHref={historyHref} /></div>
        </aside>
      </div>
    </div>
  );
}

function WelcomeHero({ name, live, indices, note, onOpen }: { name?: string; live: boolean; indices: IndexQuote[]; note: string; onOpen: (symbol: string) => void }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1.5">
      <div className="min-w-0 max-lg:w-full">
        {/* Phones and tablets: a compact greeting with the inline index strip right under it. */}
        <p className="text-title font-semibold text-text lg:hidden" suppressHydrationWarning>{greeting()}{name ? `, ${name}` : ""}</p>
        <div className="lg:hidden"><IndexStrip indices={indices} note={note} onOpen={onOpen} /></div>
        <p className="eyebrow max-lg:hidden" suppressHydrationWarning>
          {greeting()}{name ? `, ${name}` : ""} · {live ? "Live prices · paper wallet" : "Practice account"}
        </p>
        <h1 className="mt-1 hidden text-[clamp(1.375rem,2.1vw,1.75rem)] sm:block font-semibold leading-tight tracking-[-0.03em] text-text">
          Your market. <span className="bg-gradient-to-r from-primary to-demo bg-clip-text text-transparent">Your edge.</span>
        </h1>
        <p className="mt-0.5 hidden text-data text-muted sm:block">A smarter view of your trading day.</p>
      </div>
      <div className="max-lg:hidden"><MarketStatus /></div>
    </header>
  );
}

const STRIP_LABEL: Record<string, string> = { "Nifty 50": "NIFTY 50", "Nifty Bank": "BANKNIFTY", "India VIX": "INDIA VIX" };
const STRIP_ORDER = ["Nifty 50", "Nifty Bank"];

/**
 * Dhan-style inline indices: name, price and change on one line per index, all in one row that
 * scrolls sideways inside itself when it does not fit. Prices come from the shell's index feed.
 */
function IndexStrip({ indices, note, onOpen }: { indices: IndexQuote[]; note: string; onOpen: (symbol: string) => void }) {
  const rows = [...indices].sort((a, b) => {
    const rank = (name: string) => { const at = STRIP_ORDER.indexOf(name); return at < 0 ? STRIP_ORDER.length : at; };
    return rank(a.name) - rank(b.name);
  });
  if (!rows.length) return <p className="mt-1 truncate text-data text-muted">{note || "Loading index prices…"}</p>;
  return (
    <div className="no-scrollbar relative -mx-3 mt-1 flex overflow-x-auto px-3 sm:-mx-4 sm:px-4" role="list" aria-label="Market indices">
      {rows.map((item) => {
        const change = item.previous == null ? null : item.last - item.previous;
        const pct = item.previous ? (change! / item.previous) * 100 : null;
        const tone = change == null || change === 0 ? "text-muted" : change > 0 ? "text-profit" : "text-loss";
        const Arrow = change == null || change === 0 ? null : change > 0 ? ArrowUpRight : ArrowDownRight;
        const card = INDEX_CARDS.find((entry) => entry.name === item.name);
        return (
          <button
            key={item.name}
            type="button"
            role="listitem"
            className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap border-r border-border-soft py-1 pr-3 last:border-r-0 [&+&]:pl-3"
            onClick={() => card && onOpen(card.symbol)}
            aria-label={`${STRIP_LABEL[item.name] ?? item.name} ${item.last.toLocaleString("en-IN", { minimumFractionDigits: 2 })}${pct != null ? `, ${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(2)} percent` : ""}`}
          >
            <span className="text-micro font-semibold tracking-[0.02em] text-text-2">{STRIP_LABEL[item.name] ?? item.name}</span>
            <span className="num text-data font-semibold text-text">{item.last.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            <span className={cx("num inline-flex items-center gap-0.5 text-micro font-semibold", tone)}>
              {Arrow ? <Arrow className="h-3 w-3 self-center" aria-hidden /> : null}
              {pct == null ? "–" : `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%`}
            </span>
          </button>
        );
      })}
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

function AccountCard({ state, portfolio, live, onRetry }: { state: PortfolioState; portfolio: Portfolio | null; live: boolean; onRetry: () => void }) {
  const [range, setRange] = useState<Range>("ALL");
  const curve = useMemo(() => (portfolio?.equityCurve ?? []).flatMap((point) => {
    const value = parseInr(point.equity);
    const at = new Date(point.at).getTime();
    return value == null || !Number.isFinite(at) ? [] : [{ at, value }];
  }), [portfolio?.equityCurve]);
  const latest = curve.length ? curve[curve.length - 1].at : 0;
  const shown = useMemo(() => (range === "ALL" ? curve : curve.filter((point) => point.at >= latest - RANGE_MS[range])), [curve, range, latest]);
  // A range is offered only when the history actually reaches back that far.
  const ranges = (["1D", "1W", "1M", "ALL"] as const).filter((item) => item === "ALL" || (curve.length > 2 && curve[0].at < latest - RANGE_MS[item] && curve.filter((point) => point.at >= latest - RANGE_MS[item]).length >= 2));

  if (state === "loading") return <AccountSkeleton />;
  if (state !== "ready" || !portfolio) {
    const copy = {
      empty: { icon: <Layers className="h-5 w-5" />, title: "No practice capital yet", body: "A Super Admin assigns virtual capital to this wallet. Your account appears here as soon as it is funded." },
      forbidden: { icon: <ShieldAlert className="h-5 w-5" />, title: "No practice wallet on this account", body: "Paper trading is not enabled for this sign-in. A Super Admin can turn on Standard Trading for it." },
      error: { icon: <WifiOff className="h-5 w-5" />, title: "The practice account could not be loaded", body: "The portfolio service did not respond. Your ledger is unchanged." },
      loading: { icon: null, title: "", body: "" },
      ready: { icon: null, title: "", body: "" },
    }[state];
    return (
      <section className="account-surface flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center" aria-label="Practice account">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-border bg-elevated text-primary">{copy.icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-title font-semibold">{copy.title}</h2>
          <p className="mt-0.5 text-data text-muted">{copy.body}</p>
        </div>
        {state === "error" ? <Button size="sm" icon={<RefreshCw className="h-4 w-4" />} onClick={onRetry}>Retry</Button> : null}
      </section>
    );
  }

  const first = shown[0]?.value;
  const last = shown[shown.length - 1]?.value;
  const curveTone: Tone = first == null || last == null || last === first ? "primary" : last > first ? "profit" : "loss";
  const { prefix, body } = splitInr(portfolio.equity);

  return (
    <section className="account-surface flex min-w-0 flex-col p-4 sm:p-5" aria-label="Practice account">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow text-text-2">{live ? "Paper wallet · live prices" : "Practice account"}</span>
        <Badge tone="demo" title="Virtual money on the practice ledger. This is not brokerage cash.">Virtual funds</Badge>
        {portfolio.periodLabel ? <span className="hidden text-micro text-muted sm:inline">{portfolio.periodLabel}</span> : null}
        {portfolio.stale ? <Badge tone="warning" title="One or more marks are missing or stale. Value excludes unknown marks.">Stale marks</Badge> : null}
        {curve.length >= 2 && ranges.length > 1 ? (
          <span className="ml-auto"><SegmentedControl size="sm" label="Equity range" value={range} onChange={setRange} options={ranges.map((item) => ({ id: item, label: item }))} /></span>
        ) : null}
      </div>

      <div className="mt-3 grid min-w-0 gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-end">
        <div className="min-w-0">
          <p className="text-data text-muted">Account value</p>
          <p className="num mt-1 flex items-baseline gap-0.5 font-semibold leading-none tracking-[-0.03em] text-text">
            <span className="text-[1.25rem] text-text-2">{prefix}</span>
            <span className="text-[clamp(1.75rem,2.8vw,2.25rem)]">{body}</span>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <DeltaPill tone={signOf(portfolio.netPnl)} label="Net P&L" value={portfolio.netPnl} extra={portfolio.performanceReturn} />
            {portfolio.dailyReturn ? <DeltaPill tone={signOf(portfolio.dailyReturn)} label="Today" value={portfolio.dailyReturn} /> : null}
          </div>
        </div>
        <div className="h-16 min-w-0 sm:h-[4.75rem]">
          {shown.length >= 2 ? (
            <Sparkline values={shown.map((point) => point.value)} tone={curveTone} width={520} height={76} className="h-full w-full" label={`Account value from ${inr(first)} to ${inr(last)}`} />
          ) : (
            <p className="flex h-full items-end text-micro text-muted sm:justify-end sm:text-right">{curve.length < 2 ? "The value curve appears once two snapshots exist (one at most every 15 minutes)." : "No snapshots in this range."}</p>
          )}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border-soft pt-3 md:grid-cols-4">
        <Metric label="Buying power" value={portfolio.cashAvailable} />
        <Metric label="Holdings value" value={portfolio.holdingsValue} />
        <Metric label="Realized P&L" value={portfolio.realized} tone={signOf(portfolio.realized)} />
        <Metric label="Unrealized P&L" value={portfolio.unrealized} tone={signOf(portfolio.unrealized)} />
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-muted">
        <span>Allocated <span className="num font-medium text-text-2">{portfolio.allocatedCapital}</span></span>
        <span>Open <span className="num font-medium text-text-2">{portfolio.positions.length}</span></span>
        <span>Closed <span className="num font-medium text-text-2">{portfolio.completedTrades}</span> · <span className="text-profit">{portfolio.winningTrades}W</span> / <span className="text-loss">{portfolio.losingTrades}L</span></span>
        <Link href="/positions" className="ml-auto inline-flex items-center gap-1 text-data font-medium text-primary hover:underline">Positions <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
      </div>
    </section>
  );
}

function DeltaPill({ tone, label, value, extra }: { tone: "profit" | "loss" | "neutral"; label: string; value: string; extra?: string }) {
  const style = tone === "profit" ? "border-profit/25 bg-profit-soft text-profit" : tone === "loss" ? "border-loss/25 bg-loss-soft text-loss" : "border-border bg-sunken text-text-2";
  const Arrow = tone === "profit" ? ArrowUpRight : tone === "loss" ? ArrowDownRight : null;
  return (
    <span className={cx("inline-flex h-7 items-center gap-1.5 rounded-pill border px-2.5 text-data font-semibold", style)}>
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
      <dt className="text-micro text-muted">{label}</dt>
      <dd className={cx("num mt-0.5 truncate text-dense font-semibold", tone === "profit" ? "text-profit" : tone === "loss" ? "text-loss" : "text-text")} title={value}>{value}</dd>
    </div>
  );
}

function AccountSkeleton() {
  return (
    <section className="account-surface p-4 sm:p-5" aria-busy="true" aria-label="Loading practice account">
      <Skeleton className="h-3 w-36" />
      <div className="mt-4 grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
        <div><Skeleton className="h-3 w-24" /><Skeleton className="mt-2 h-9 w-52" /><Skeleton className="mt-3 h-7 w-44 rounded-pill" /></div>
        <Skeleton className="h-[4.75rem] w-full rounded-md" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border-soft pt-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div key={item}><Skeleton className="h-2.5 w-16" /><Skeleton className="mt-1.5 h-4 w-24" /></div>)}
      </div>
    </section>
  );
}

function MarketPulse({ indices, note, onOpen }: { indices: IndexQuote[]; note: string; onOpen: (symbol: string) => void }) {
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
    <section className="surface flex min-w-0 flex-col p-1.5" aria-label="Market pulse">
      <div className="flex items-center justify-between gap-2 px-2.5 pb-1 pt-2">
        <h2 className="text-dense font-semibold">Market pulse</h2>
        <span className="text-micro text-muted">Today · 5-min</span>
      </div>
      <ul className="flex flex-1 flex-col">
        {INDEX_CARDS.map((card, index) => (
          <li key={card.symbol} className={cx("flex flex-1", index > 0 && "border-t border-border-soft")}>
            <PulseRow card={card} quote={indices.find((item) => item.name === card.name)} points={series[card.symbol]} note={note} onOpen={() => onOpen(card.symbol)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PulseRow({ card, quote, points, note, onOpen }: { card: (typeof INDEX_CARDS)[number]; quote?: IndexQuote; points?: number[] | "error"; note: string; onOpen: () => void }) {
  const change = quote && quote.previous != null ? quote.last - quote.previous : null;
  const pct = change != null && quote?.previous ? (change / quote.previous) * 100 : null;
  const direction = change == null || change === 0 ? "flat" : change > 0 ? "up" : "down";
  const tone: Tone = card.volatility || direction === "flat" ? "info" : direction === "up" ? "profit" : "loss";
  const textTone = card.volatility || direction === "flat" ? "text-text-2" : direction === "up" ? "text-profit" : "text-loss";
  const Arrow = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : null;
  const detail = change != null && pct != null ? `${card.label} ${signedNumber(change)} (${signedPercent(pct)}) vs previous close` : card.label;
  return (
    <button type="button" onClick={onOpen} title={card.volatility ? `${detail}. Higher readings mean larger expected swings, not gains.` : detail} aria-label={`Open ${card.label} chart`} className="group grid w-full grid-cols-[minmax(0,1fr)_72px_auto] items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-hover">
      <span className="min-w-0">
        <span className="block truncate text-data font-semibold tracking-[0.01em] text-text">{card.label}</span>
        <span className="block truncate text-micro text-muted">{card.context}</span>
      </span>
      <span className="h-7 w-[4.5rem]">
        {Array.isArray(points) && points.length >= 2 ? (
          <Sparkline values={points} tone={tone} width={72} height={28} baseline={quote?.previous ?? null} className="h-full w-full" label={`${card.label} intraday trend`} />
        ) : points === undefined ? <Skeleton className="h-full w-full rounded-sm" /> : <span className="flex h-full items-center justify-center text-micro text-muted">—</span>}
      </span>
      <span className="min-w-[5.5rem] text-right">
        {quote ? (
          <>
            <PriceCell value={quote.last} className="block text-dense font-semibold leading-tight text-text" />
            <span className={cx("num inline-flex items-center gap-0.5 text-micro font-semibold", textTone)}>
              {Arrow ? <Arrow className="h-3 w-3" aria-hidden /> : null}
              {pct != null ? signedPercent(pct) : "—"}
            </span>
          </>
        ) : note && !note.toLowerCase().includes("loading") ? <span className="text-micro text-muted">Unavailable</span> : <><Skeleton className="ml-auto h-3.5 w-16" /><Skeleton className="ml-auto mt-1 h-2.5 w-10" /></>}
      </span>
    </button>
  );
}

function QuickActions({ live, replayAllowed }: { live: boolean; replayAllowed: boolean }) {
  return (
    <section aria-label="Jump back in">
      <div className="mb-2 flex items-end justify-between gap-2">
        <h2 className="text-dense font-semibold">Jump back in</h2>
        <Link href="/terminal" className="inline-flex items-center gap-1 text-data font-medium text-muted transition-colors hover:text-text">Equity order ticket <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {ACTIONS.map(({ key, label, body, href, icon: Icon, tone }) => {
          const blocked = key === "replay" && (live || !replayAllowed);
          const content = (
            <>
              <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-lg", tone)}><Icon className="h-5 w-5" aria-hidden /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-dense font-semibold text-text">{label}</span>
                <span className="block truncate text-micro text-muted">{blocked ? (live ? "Switch to Demo view to replay" : "Not enabled for this account") : body}</span>
              </span>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-text" aria-hidden />
            </>
          );
          return blocked ? (
            <div key={key} className="surface flex items-center gap-3 p-3 opacity-60" aria-disabled="true" title={live ? "Replay is a Demo view feature." : "Historical Replay is not enabled for this account."}>{content}</div>
          ) : (
            <Link key={key} href={href} className="surface surface-interactive group flex items-center gap-3 p-3">{content}</Link>
          );
        })}
      </div>
    </section>
  );
}

function MarketMovers({ board, error, mover, onMover, onPick }: { board: Board | null; error: string; mover: "gainers" | "losers" | "volume"; onMover: (next: "gainers" | "losers" | "volume") => void; onPick: (symbol: string) => void }) {
  const rows = board?.[mover] ?? [];
  const message = board?.message || error || "Loading the live quote feed…";
  return (
    <section className="surface flex min-w-0 flex-col overflow-hidden" aria-label="Market movers">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-soft px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-dense font-semibold">Market movers</h2>
          <p className="max-w-md truncate text-micro text-muted" title={message}>{message}</p>
        </div>
        <SegmentedControl size="sm" label="Mover type" value={mover} onChange={onMover} options={[{ id: "gainers", label: "Gainers" }, { id: "losers", label: "Losers" }, { id: "volume", label: "Most active" }]} />
      </div>
      <div className="px-2 py-1.5">
        {!board && !error ? (
          <div className="grid gap-x-4 gap-y-1 p-1 md:grid-cols-2">{[0, 1, 2, 3, 4, 5].map((item) => <Skeleton key={item} className="h-9 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <InlineState icon={<BarChart3 className="h-5 w-5" />} title="No movers returned" body={error || "The feed has not returned movers for this view yet."} />
        ) : (
          <ol className="grid gap-x-4 md:grid-cols-2">
            {rows.slice(0, 10).map((row, index) => {
              const up = row.change > 0;
              const down = row.change < 0;
              return (
                <li key={row.symbol}>
                  <button type="button" onClick={() => onPick(row.symbol)} title={`Open ${row.symbol} chart`} className="grid w-full grid-cols-[14px_24px_minmax(0,1fr)_auto_66px] items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover">
                    <span className="num text-micro text-muted">{index + 1}</span>
                    <StockLogo symbol={row.symbol} name={row.name} size={24} />
                    <span className="min-w-0">
                      <span className="block truncate text-data font-semibold leading-tight text-text">{row.symbol}</span>
                      <span className="block truncate text-[0.6875rem] leading-tight text-muted">{row.name}</span>
                    </span>
                    <span className="num text-right text-data text-text-2">{inr(row.last).replace("₹", "")}</span>
                    <span className={cx("num rounded-sm px-1.5 py-0.5 text-right text-micro font-semibold", mover === "volume" ? "bg-sunken text-text-2" : up ? "bg-profit-soft text-profit" : down ? "bg-loss-soft text-loss" : "bg-sunken text-muted")}>
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

function RecentActivity({ allowed, historyHref }: { allowed: boolean | null; historyHref: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [orders, setOrders] = useState<ActivityOrder[]>([]);
  const [closed, setClosed] = useState<ClosedRow[]>([]);

  useEffect(() => {
    if (!allowed) return;
    let stop = false;
    const load = () => {
      Promise.all([
        api<{ orders: ActivityOrder[] }>("/api/orders"),
        api<{ trades: ClosedRow[] }>("/api/trades").catch(() => ({ trades: [] as ClosedRow[] })),
      ]).then(([activity, trades]) => {
        if (stop) return;
        setOrders(activity.orders);
        setClosed(trades.trades);
        setState("ready");
      }).catch(() => { if (!stop) setState("error"); });
    };
    load();
    window.addEventListener("td-ledger", load);
    return () => { stop = true; window.removeEventListener("td-ledger", load); };
  }, [allowed]);

  const rows = orders.slice(0, 4);
  return (
    <section className="surface flex min-w-0 shrink-0 flex-col overflow-hidden" aria-label="Recent activity">
      <div className="flex items-center justify-between gap-2 border-b border-border-soft px-3 py-2.5">
        <h2 className="text-dense font-semibold">Recent activity</h2>
        {allowed ? <Link href={historyHref} className="inline-flex items-center gap-1 text-data font-medium text-primary hover:underline">View history <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link> : null}
      </div>
      {allowed === false ? (
        <p className="px-3 py-4 text-data text-muted">Order history is not enabled for this account.</p>
      ) : allowed === null || state === "loading" ? (
        <div className="space-y-2 p-3">{[0, 1, 2].map((item) => <Skeleton key={item} className="h-8 w-full" />)}</div>
      ) : state === "error" ? (
        <p className="px-3 py-4 text-data text-muted">Recent activity could not be loaded.</p>
      ) : rows.length === 0 ? (
        <div className="flex items-center justify-between gap-3 px-3 py-4">
          <p className="text-data text-muted">No trades yet.</p>
          <Link href="/chart" className="inline-flex h-7 items-center gap-1 rounded-input bg-primary px-2.5 text-data font-semibold text-on-primary hover:bg-primary-hover"><ReceiptText className="h-3.5 w-3.5" aria-hidden /> Open chart</Link>
        </div>
      ) : (
        <ul className="divide-y divide-border-soft">
          {rows.map((order) => <ActivityRow key={order.id} order={order} closed={closed} />)}
        </ul>
      )}
    </section>
  );
}

function ActivityRow({ order, closed }: { order: ActivityOrder; closed: ClosedRow[] }) {
  const option = parseOptionLedgerSymbol(order.symbol);
  const label = option ? `${option.underlying} ${option.strike.toLocaleString("en-IN")} ${option.right}` : order.symbol;
  const at = order.executedAt ?? order.filledAt ?? order.submittedAt;
  const stamp = new Date(at).getTime();
  // Realized P&L is shown only when this fill closed a round trip (same symbol, same moment).
  const trade = order.status === "FILLED" ? closed.find((row) => row.symbol === order.symbol && Math.abs(new Date(row.exitAt).getTime() - stamp) < 5000) : undefined;
  const sell = order.side === "SELL";
  const price = order.avgFill ?? order.limit;
  const status = order.status.charAt(0) + order.status.slice(1).toLowerCase().replaceAll("_", " ");
  const statusTone = order.status === "FILLED" ? "text-text-2" : order.status === "REJECTED" ? "text-loss" : "text-warning";
  return (
    <li className="flex items-center gap-2.5 px-3 py-2" title={`${order.side} ${order.quantity} ${order.symbol} · ${status}`}>
      <span className={cx("w-9 shrink-0 rounded-sm py-0.5 text-center text-[0.625rem] font-bold tracking-wide", sell ? "bg-loss-soft text-loss" : "bg-profit-soft text-profit")}>{sell ? "SELL" : "BUY"}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-data font-semibold leading-tight text-text">{label}</span>
        <span className="block truncate text-[0.6875rem] leading-tight text-muted">
          <span className="num">{order.filledQuantity || order.quantity}</span>{price ? <> @ <span className="num">{inr(price).replace("₹", "")}</span></> : null} · <span className={statusTone}>{status}</span>
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="num block text-[0.6875rem] leading-tight text-muted">{timeLabel(at)}</span>
        {trade ? <span className={cx("num block text-[0.6875rem] font-semibold leading-tight", trade.profitable ? "text-profit" : trade.loss ? "text-loss" : "text-muted")}>{trade.net}</span> : null}
      </span>
    </li>
  );
}

function timeLabel(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const zone = { timeZone: "Asia/Kolkata" } as const;
  const sameDay = date.toLocaleDateString("en-CA", zone) === new Date().toLocaleDateString("en-CA", zone);
  return sameDay
    ? date.toLocaleTimeString("en-IN", { ...zone, hour: "2-digit", minute: "2-digit", hour12: false })
    : date.toLocaleDateString("en-IN", { ...zone, day: "numeric", month: "short" });
}

