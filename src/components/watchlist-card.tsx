"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, ChevronDown, ListPlus, WifiOff } from "lucide-react";
import { api, moveOf, type Quote } from "@/components/api";
import { useDesk } from "@/components/shell";
import { StockLogo, StockSearchField, WatchStar } from "@/components/stock-identity";
import { cx, PriceCell, Skeleton } from "@/components/ui";
import { signedPercent } from "@/lib/format";

type List = { id: string; name: string; items: Array<{ symbol: string; name: string; exchange: string }> };
type Hit = { symbol: string; name: string; exchange: string };

const WATCH_PREVIEW = 8;

/**
 * The saved watchlists with live quotes, search-and-add and remove. Home shows it as a side card
 * (first rows, "View all"); the Watchlist page shows every row and fills the screen (`full`).
 */
export function WatchlistCard({ full = false, className }: { full?: boolean; className?: string }) {
  const desk = useDesk();
  const [lists, setLists] = useState<List[]>([]);
  const [listsState, setListsState] = useState<"loading" | "ready" | "error">("loading");
  const [listId, setListId] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState("");
  const [searchError, setSearchError] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    api<{ lists: List[] }>("/api/watchlists").then((data) => {
      setLists(data.lists);
      setListsState("ready");
      const saved = localStorage.getItem("td-watchlist");
      setListId(saved && data.lists.some((item) => item.id === saved) ? saved : data.lists[0]?.id ?? "");
    }).catch(() => setListsState("error"));
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

  const rows = useMemo(() => [...(list?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [list]);
  // Advancers and decliners in this watchlist, from the same live quotes as the rows.
  const breadth = useMemo(() => {
    let up = 0;
    let down = 0;
    for (const item of list?.items ?? []) {
      const move = moveOf(quotes[item.symbol]?.last, quotes[item.symbol]?.previousClose);
      if (move && move.abs > 0) up += 1;
      if (move && move.abs < 0) down += 1;
    }
    return { up, down };
  }, [list, quotes]);
  const visibleRows = full || showAll ? rows : rows.slice(0, WATCH_PREVIEW);

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
    <section className={cx("surface flex min-w-0 flex-col overflow-hidden", full ? "min-h-0 flex-1" : "min-h-[21.25rem]", className)} aria-label="Watchlist">
      <div className="px-3 pb-2 pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className={cx("font-semibold", full ? "text-title" : "text-dense")}>Watchlist</h2>
            <p className="text-micro text-muted">{list ? `${list.items.length} instrument${list.items.length === 1 ? "" : "s"}` : listsState === "error" ? "Unavailable" : "Loading…"}</p>
          </div>
          {lists.length > 1 ? (
            <label className="relative">
              <span className="sr-only">Choose watchlist</span>
              <select className="h-9 appearance-none py-0 pl-2 pr-6 text-data font-medium lg:h-7" value={list?.id ?? ""} onChange={(event) => { setListId(event.target.value); localStorage.setItem("td-watchlist", event.target.value); }}>
                {lists.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden />
            </label>
          ) : <Breadth up={breadth.up} down={breadth.down} />}
        </div>
        <StockSearchField
          query={query}
          onQuery={setQuery}
          hits={hits}
          status={searchStatus}
          watched={onList}
          placeholder="Search and add"
          onSelect={(hit) => { desk.openChart(hit.symbol); setQuery(""); setHits([]); }}
          onToggleWatch={(hit) => toggleWatch(hit.symbol, hit.name, hit.exchange)}
        />
        {lists.length > 1 ? <div className="mt-2 flex justify-end"><Breadth up={breadth.up} down={breadth.down} /></div> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain border-t border-border-soft px-1.5 py-1">
        {listsState === "loading" ? <WatchlistSkeleton /> : null}
        {listsState === "error" ? <InlineState icon={<WifiOff className="h-5 w-5" />} title="Watchlist unavailable" body="The saved watchlists could not be loaded. Refresh the page to retry." /> : null}
        {listsState === "ready" && rows.length === 0 ? (
          <InlineState icon={<ListPlus className="h-5 w-5" />} title="Your watchlist is empty" body="Search above and tap the star to track an instrument here." />
        ) : null}
        <ul>
          {visibleRows.map((item) => <WatchRow key={item.symbol} item={item} quote={quotes[item.symbol]} onOpen={() => desk.chooseSymbol(item.symbol)} onRemove={() => toggleWatch(item.symbol, item.name, item.exchange)} />)}
        </ul>
      </div>
      {!full && rows.length > WATCH_PREVIEW ? (
        <button type="button" className="h-11 shrink-0 border-t border-border-soft text-data font-medium text-primary transition-colors hover:bg-hover lg:h-9" onClick={() => setShowAll((value) => !value)} aria-expanded={showAll}>
          {showAll ? "Show fewer" : `View all ${rows.length}`}
        </button>
      ) : null}
    </section>
  );
}

function Breadth({ up, down }: { up: number; down: number }) {
  if (up + down === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-micro font-semibold" title={`${up} up, ${down} down today in this watchlist`}>
      <span className="num inline-flex items-center gap-0.5 rounded-sm bg-profit-soft px-1.5 py-0.5 text-profit"><ArrowUpRight className="h-3 w-3" aria-hidden />{up}</span>
      <span className="num inline-flex items-center gap-0.5 rounded-sm bg-loss-soft px-1.5 py-0.5 text-loss"><ArrowDownRight className="h-3 w-3" aria-hidden />{down}</span>
      <span className="sr-only">{up} up and {down} down today</span>
    </span>
  );
}

function WatchRow({ item, quote, onOpen, onRemove }: { item: List["items"][number]; quote?: Quote; onOpen: () => void; onRemove: () => void }) {
  const move = moveOf(quote?.last, quote?.previousClose);
  const last = quote ? Number(quote.last) : null;
  const tone = move == null || move.abs === 0 ? "text-muted" : move.abs > 0 ? "text-profit" : "text-loss";
  return (
    <li className="group flex items-center gap-0.5 rounded-md transition-colors hover:bg-hover focus-within:bg-hover">
      <button type="button" className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 rounded-md py-1.5 pl-1.5 text-left lg:min-h-0" onClick={onOpen} title={item.name}>
        <StockLogo symbol={item.symbol} name={item.name} size={26} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-data font-semibold leading-tight text-text">{item.symbol}</span>
          <span className="block truncate text-[0.6875rem] leading-tight text-muted">{item.name}</span>
        </span>
        <span className="shrink-0 text-right">
          {quote ? <PriceCell value={last} className="block text-data font-semibold leading-tight text-text" /> : <Skeleton className="ml-auto h-3.5 w-14" />}
          <span className={cx("num block whitespace-nowrap text-[0.6875rem] font-medium leading-tight", tone)}>
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
    <div className="space-y-1 p-1.5" aria-busy="true" aria-label="Loading watchlist">
      {[0, 1, 2, 3, 4, 5].map((item) => (
        <div key={item} className="flex items-center gap-2.5 py-1.5">
          <Skeleton className="h-[1.625rem] w-[1.625rem] rounded-[28%]" />
          <div className="flex-1"><Skeleton className="h-3 w-16" /><Skeleton className="mt-1.5 h-2.5 w-28" /></div>
          <div><Skeleton className="h-3 w-14" /><Skeleton className="ml-auto mt-1.5 h-2.5 w-10" /></div>
        </div>
      ))}
    </div>
  );
}

export function InlineState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-8 text-center">
      <span className="mb-3 grid h-10 w-10 place-items-center rounded-lg border border-border-soft bg-sunken text-muted">{icon}</span>
      <p className="text-dense font-semibold text-text">{title}</p>
      <p className="mt-1 max-w-xs text-data text-muted">{body}</p>
    </div>
  );
}
