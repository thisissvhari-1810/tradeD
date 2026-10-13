"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CandlestickChart, Gem, GitBranch, Layers, PieChart, Wheat } from "lucide-react";
import { api, money, moveOf, tone, type Quote } from "@/components/api";
import { useDesk } from "@/components/shell";
import { StockSearchField, SymbolTitle, WatchStar } from "@/components/stock-identity";

type List = { id: string; name: string; items: Array<{ symbol: string; name: string; exchange: string }> };
type Portfolio = {
  cashAvailable: string;
  holdingsValue: string;
  equity: string;
  unrealized: string;
  realized: string;
  dailyReturn: string | null;
  positions: Array<{ symbol: string }>;
};
type Hit = { symbol: string; name: string; exchange: string };
type Board = { gainers: Mover[]; losers: Mover[]; volume: Mover[]; message: string };
type Mover = { symbol: string; name: string; last: number; previous: number; change: number; percent: number; volume: number | null };

const PRODUCTS: Array<{ label: string; href?: string; note?: string; icon: typeof CandlestickChart; tint: string }> = [
  { label: "Equities", href: "/terminal", icon: CandlestickChart, tint: "bg-primary/10 text-primary" },
  { label: "Options", href: "/options", icon: GitBranch, tint: "bg-demo/10 text-demo" },
  { label: "Mutual Funds", note: "Mutual fund orders, fund-house logos, and NAVs are not on this ledger.", icon: PieChart, tint: "bg-info/10 text-info" },
  { label: "ETFs", note: "A separate ETF book is not returned by the current account.", icon: Layers, tint: "bg-primary/10 text-primary" },
  { label: "Futures", note: "Futures orders are not available on this practice ledger.", icon: CandlestickChart, tint: "bg-warning/10 text-warning" },
  { label: "Commodities", note: "Commodity orders are not available on this practice ledger.", icon: Wheat, tint: "bg-warning/10 text-warning" },
];

export function Home() {
  const desk = useDesk();
  const [lists, setLists] = useState<List[]>([]);
  const [listId, setListId] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState("");
  const [searchError, setSearchError] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [filter, setFilter] = useState<"All" | "Stocks" | "Mutual Fund" | "ETFs">("All");
  const [sort, setSort] = useState<"name" | "price" | "change">("name");
  const [mover, setMover] = useState<"gainers" | "losers" | "volume">("gainers");
  const [notice, setNotice] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [boardError, setBoardError] = useState("");

  useEffect(() => {
    api<{ lists: List[] }>("/api/watchlists").then((data) => {
      setLists(data.lists);
      const saved = localStorage.getItem("td-watchlist");
      setListId(saved && data.lists.some((item) => item.id === saved) ? saved : data.lists[0]?.id ?? "");
    }).catch(() => undefined);
    api<Portfolio>("/api/portfolio").then(setPortfolio).catch(() => setPortfolio(null));
    const loadBoard = () => api<Board>("/api/market/movers").then((data) => { setBoard(data); setBoardError(""); }).catch((error: unknown) => setBoardError(error instanceof Error ? error.message : "Market movers unavailable."));
    loadBoard();
    const timer = window.setInterval(loadBoard, 20000);
    return () => window.clearInterval(timer);
  }, []);

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

  const boardRows = board?.[mover === "volume" ? "volume" : mover] ?? [];

  const stockView = filter === "All" || filter === "Stocks";
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

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto grid max-w-7xl gap-4 xl:grid-cols-[300px_minmax(0,1fr)_300px]">
        <aside className="card flex min-h-[640px] flex-col p-3">
          <StockSearchField
            query={query}
            onQuery={setQuery}
            hits={hits}
            status={searchStatus}
            watched={onList}
            onSelect={(hit) => { desk.openChart(hit.symbol); setQuery(""); setHits([]); }}
            onToggleWatch={(hit) => toggleWatch(hit.symbol, hit.name, hit.exchange)}
          />
          <div className="mt-2 min-h-0 flex-1 overflow-auto">
            {rows.length === 0 ? <p className="px-1 py-6 text-sm text-muted">This watchlist is empty. Search above to add a company from the terminal watchlist.</p> : null}
            {rows.map((item) => {
              const quote = quotes[item.symbol];
              const move = moveOf(quote?.last, quote?.previousClose);
              return (
                <div key={item.symbol} className="flex items-center gap-1 border-b border-border py-2">
                  <button className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left hover:bg-elevated" onClick={() => desk.chooseSymbol(item.symbol)}>
                    <SymbolTitle symbol={item.symbol} name={item.name} exchange={item.exchange} size={36} />
                    <span className="ml-auto shrink-0 text-right">
                      <span className={`num block whitespace-nowrap text-sm font-medium ${tone(move?.abs)}`}>{quote ? money(quote.last) : "…"}</span>
                      <span className={`num block whitespace-nowrap text-[11px] ${tone(move?.abs)}`}>{move ? `${move.abs >= 0 ? "+" : ""}${move.abs.toFixed(2)} (${move.pct.toFixed(2)}%)` : ""}</span>
                    </span>
                  </button>
                  <WatchStar active onToggle={() => toggleWatch(item.symbol, item.name, item.exchange)} label={`Remove ${item.symbol} from watchlist`} />
                </div>
              );
            })}
          </div>
          <div className="flex gap-4 border-t border-border px-1 pt-2 text-[11px] text-muted">
            <button className={sort === "name" ? "text-text" : ""} onClick={() => setSort("name")}>Name</button>
            <button className={sort === "price" ? "text-text" : ""} onClick={() => setSort("price")}>LTP</button>
            <button className={sort === "change" ? "text-text" : ""} onClick={() => setSort("change")}>LTP %</button>
          </div>
        </aside>

        <section className="space-y-4">
          <div className="card p-4">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-base font-semibold">My Portfolio</h1>
              {(["All", "Stocks", "Mutual Fund", "ETFs"] as const).map((item) => (
                <button key={item} className={`rounded-full px-3 py-1 text-xs ${filter === item ? "bg-elevated font-semibold text-text" : "text-muted"}`} onClick={() => setFilter(item)}>{item}</button>
              ))}
            </div>
            {stockView ? (
              desk.mode === "live" ? <LiveAccount /> : (
              <>
                <div className="mt-5 grid gap-4 sm:grid-cols-4">
                  <Stat label="Investment" value={portfolio?.holdingsValue ?? "—"} />
                  <Stat label="Current Value" value={portfolio?.equity ?? "—"} />
                  <Stat label="Overall Profits" value={portfolio?.unrealized ?? "—"} />
                  <Stat label="Today's Profit" value={portfolio?.dailyReturn ?? "—"} />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl bg-cream px-3 py-3 text-sm">
                  <span className="text-muted">Today's P&L: <span className="text-text">{portfolio?.dailyReturn ?? "—"}</span></span>
                  <span className="text-muted">Open Positions: <span className="text-text">{portfolio?.positions.length ?? 0}</span></span>
                  <span className="ml-auto text-muted">Available <span className="num ml-2 text-base font-semibold text-text">{portfolio?.cashAvailable ?? "—"}</span></span>
                  <button className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white" onClick={() => desk.toast("Practice capital is already on this account. TradeD does not collect a payment.")}>+ Top Up</button>
                </div>
                <p className="mt-2 text-[11px] text-muted">Practice ledger. Switch the header to Live to read the connected account. Realized {portfolio?.realized ?? "—"}.</p>
              </>
              )
            ) : <p className="mt-6 text-sm text-muted">{filter} holdings are not kept on this practice ledger.</p>}
          </div>

          <div className="card p-4">
            <h2 className="text-sm font-semibold">Invest / Trade on Stock Exchanges</h2>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {PRODUCTS.map((item) => {
                const Icon = item.icon;
                const body = (<><span className={`grid h-9 w-9 place-items-center rounded-xl ${item.tint}`}><Icon className="h-4 w-4" aria-hidden /></span><span className="text-sm">{item.label}</span></>);
                return item.href ? (
                  <Link key={item.label} href={item.href} className="flex items-center gap-3 rounded-xl border border-border px-3 py-3 hover:bg-elevated">{body}</Link>
                ) : (
                  <button key={item.label} className="flex items-center gap-3 rounded-xl border border-border px-3 py-3 text-left hover:bg-elevated" onClick={() => setNotice(item.note ?? "")}>{body}</button>
                );
              })}
            </div>
            {notice ? <p className="mt-3 text-xs text-muted">{notice}</p> : null}
            <div className="mt-3 space-y-2">
              <button className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-3 text-left text-sm" onClick={() => setNotice("Securities lending is not available on this practice ledger.")}>
                <span>Rent Stocks</span><span className="text-xs text-muted">Not on this ledger</span>
              </button>
              <button className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-3 text-left text-sm" onClick={() => setNotice("A gold or silver product is not returned by the connected account.")}>
                <span className="flex items-center gap-2"><Gem className="h-4 w-4 text-warning" aria-hidden />Gold and silver</span><span className="text-xs text-muted">Not available</span>
              </button>
            </div>
          </div>
        </section>

        <aside className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Market Movers</h2>
          </div>
          <p className="mt-1 text-[11px] text-muted">{board?.message || boardError || "Loading the live quote feed…"}</p>
          <div className="mt-3 flex gap-2 text-xs">
            <button className={`rounded-full px-3 py-1 ${mover === "gainers" ? "bg-cream text-primary" : "text-muted"}`} onClick={() => setMover("gainers")}>Gainers</button>
            <button className={`rounded-full px-3 py-1 ${mover === "losers" ? "bg-cream text-loss" : "text-muted"}`} onClick={() => setMover("losers")}>Losers</button>
            <button className={`rounded-full px-3 py-1 ${mover === "volume" ? "bg-elevated text-text" : "text-muted"}`} onClick={() => setMover("volume")}>Top volume</button>
          </div>
          <div className="mt-3">
            {boardRows.length === 0 ? <p className="py-6 text-sm text-muted">{boardError || "Movers have not been returned yet."}</p> : boardRows.map((row) => (
              <button key={row.symbol} className="flex w-full items-center justify-between gap-2 border-b border-border py-3 text-left" onClick={() => desk.chooseSymbol(row.symbol)}>
                <SymbolTitle symbol={row.symbol} name={row.name} exchange="NSE" size={32} />
                <span className="shrink-0 text-right">
                  <span className="num block whitespace-nowrap text-sm">{money(row.last)}</span>
                  <span className={`num block whitespace-nowrap text-[11px] ${tone(row.change)}`}>{row.change >= 0 ? "+" : ""}{row.change.toFixed(2)} ({row.percent >= 0 ? "+" : ""}{row.percent.toFixed(2)}%)</span>
                </span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

function inr(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `₹${number.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function holdingRows(payload: unknown): Array<{ symbol: string; qty: number; avg: number | null }> {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;
  if (!list) return [];
  return list.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const symbol = String(item.tradingSymbol ?? item.symbol ?? "");
    const qty = Number(item.totalQty ?? item.availableQty ?? item.quantity ?? 0);
    if (!symbol || !Number.isFinite(qty) || qty === 0) return [];
    const avg = Number(item.avgCostPrice ?? item.costPrice);
    return [{ symbol, qty, avg: Number.isFinite(avg) && avg > 0 ? avg : null }];
  });
}

function LiveAccount() {
  const [note, setNote] = useState("");
  const [available, setAvailable] = useState<string>("—");
  const [holdings, setHoldings] = useState<Array<{ symbol: string; qty: number; avg: number | null }>>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  useEffect(() => {
    api<{ broker: { funds: unknown; holdings: unknown; reason: string } }>("/api/account").then((data) => {
      setNote(data.broker.reason);
      const funds = data.broker.funds && typeof data.broker.funds === "object" ? data.broker.funds as Record<string, unknown> : null;
      if (funds && "error" in funds) setNote(String(funds.error));
      else setAvailable(inr(funds?.availabelBalance ?? funds?.availableBalance ?? funds?.withdrawableBalance));
      const rows = holdingRows(data.broker.holdings);
      setHoldings(rows);
      if (data.broker.holdings && typeof data.broker.holdings === "object" && "error" in data.broker.holdings) setNote(String((data.broker.holdings as { error: unknown }).error));
    }).catch((error: unknown) => setNote(error instanceof Error ? error.message : "Connected account unavailable."));
  }, []);
  useEffect(() => {
    if (!holdings.length) return;
    api<{ quotes: Array<Quote | { symbol: string; error: string }> }>(`/api/market/quotes?symbols=${holdings.map((row) => row.symbol).join(",")}`)
      .then((data) => {
        const next: Record<string, Quote> = {};
        for (const row of data.quotes) if ("last" in row) next[row.symbol] = row;
        setQuotes(next);
      })
      .catch(() => undefined);
  }, [holdings]);
  const invested = holdings.reduce((sum, row) => sum + (row.avg == null ? 0 : row.avg * row.qty), 0);
  const current = holdings.reduce((sum, row) => {
    const last = Number(quotes[row.symbol]?.last);
    return sum + (Number.isFinite(last) ? last * row.qty : 0);
  }, 0);
  const marked = holdings.filter((row) => Number.isFinite(Number(quotes[row.symbol]?.last))).length;
  const day = holdings.reduce((sum, row) => {
    const move = moveOf(quotes[row.symbol]?.last, quotes[row.symbol]?.previousClose);
    return sum + (move ? move.abs * row.qty : 0);
  }, 0);
  return (
    <>
      <div className="mt-5 grid gap-4 sm:grid-cols-4">
        <Stat label="Investment" value={holdings.some((row) => row.avg != null) ? inr(invested) : "—"} />
        <Stat label="Current Value" value={marked ? inr(current) : "—"} />
        <Stat label="Overall Profits" value={marked && holdings.some((row) => row.avg != null) ? inr(current - invested) : "—"} />
        <Stat label="Today's Profit" value={marked ? inr(day) : "—"} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl bg-cream px-3 py-3 text-sm">
        <span className="text-muted">Holdings: <span className="text-text">{holdings.length}</span></span>
        <span className="ml-auto text-muted">Available <span className="num ml-2 text-base font-semibold text-text">{available}</span></span>
      </div>
      <p className="mt-2 text-[11px] text-muted">{note || "Read-only connected account. TradeD does not place broker orders."}</p>
    </>
  );
}
