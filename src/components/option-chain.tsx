"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw, Search } from "lucide-react";
import { api, istTime } from "@/components/api";
import { StockLogo } from "@/components/stock-identity";
import { OptionChainTable, type ChainActions, type ChainSide, type ChainStrike, type Right } from "@/components/option-chain-table";
import { draftKey, OptionOrderTicket, type OptionOrderDraft } from "@/components/option-order-ticket";
import { cx } from "@/components/ui";
import { FEATURED_INDICES } from "@/lib/market/indices";

type Chain = {
  symbol: string;
  name: string;
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
type Hit = { symbol: string; name: string; exchange: string; sector?: string };
type Held = { symbol: string; quantity: number };

export function OptionChainBoard() {
  const params = useSearchParams();
  const fromUrl = (params.get("symbol") || "NIFTY").toUpperCase();
  const [urlSymbol, setUrlSymbol] = useState(fromUrl);
  const [symbol, setSymbol] = useState(fromUrl);
  const [expiry, setExpiry] = useState("");
  const [chain, setChain] = useState<Chain | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ q: string; rows: Hit[] }>({ q: "", rows: [] });
  const [strikeQuery, setStrikeQuery] = useState("");
  const [allStrikes, setAllStrikes] = useState(false);
  const [reload, setReload] = useState(0);
  const [held, setHeld] = useState<Held[]>([]);
  const [ledgerTick, setLedgerTick] = useState(0);
  const [draft, setDraft] = useState<OptionOrderDraft | null>(null);
  const closeTicket = useCallback(() => setDraft(null), []);

  if (urlSymbol !== fromUrl) {
    setUrlSymbol(fromUrl);
    setSymbol(fromUrl);
    setExpiry("");
  }

  useEffect(() => {
    let stop = false;
    const load = () => {
      setLoading(true);
      const expiryQuery = expiry ? `&expiry=${encodeURIComponent(expiry)}` : "";
      api<Chain>(`/api/options/chain?symbol=${encodeURIComponent(symbol)}${expiryQuery}`)
        .then((data) => {
          if (stop) return;
          setChain(data);
          setError("");
          if (!expiry && data.expiry) setExpiry(data.expiry);
        })
        .catch((caught: unknown) => { if (!stop) setError(caught instanceof Error ? caught.message : "Option chain unavailable."); })
        .finally(() => { if (!stop) setLoading(false); });
    };
    load();
    const timer = window.setInterval(load, 20000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [symbol, expiry, reload]);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const handle = window.setTimeout(() => {
      api<Hit[]>(`/api/instruments?q=${encodeURIComponent(q)}`).then((rows) => setHits({ q, rows })).catch(() => setHits({ q, rows: [] }));
    }, 160);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    api<{ positions: Held[] }>("/api/portfolio")
      .then((data) => setHeld(data.positions.filter((row) => row.symbol.startsWith(`${symbol}|`))))
      .catch(() => setHeld([]));
  }, [symbol, ledgerTick]);

  const rows = useMemo(() => {
    const strikes = chain?.strikes ?? [];
    const needle = strikeQuery.trim();
    const filtered = needle ? strikes.filter((row) => String(row.strike).includes(needle)) : strikes;
    if (allStrikes || !chain?.atmStrike || needle) return filtered;
    const index = filtered.findIndex((row) => row.strike === chain.atmStrike);
    if (index < 0) return filtered;
    return filtered.slice(Math.max(0, index - 12), index + 13);
  }, [chain, allStrikes, strikeQuery]);

  const heldLots = useCallback((right: Right, strike: number) => {
    const row = held.find((item) => item.symbol === `${symbol}|${chain?.expiry}|${strike}|${right}`);
    if (!row) return 0;
    return chain?.lotSize ? Math.floor(row.quantity / chain.lotSize) : null;
  }, [held, symbol, chain]);

  const actions = useMemo<ChainActions>(() => {
    const open = (action: "BUY" | "SELL") => (right: Right, strike: number, side: ChainSide) => {
      if (!chain?.expiry || side.ltp == null) return;
      setDraft({ underlying: symbol, name: chain.name || symbol, expiry: chain.expiry, strike, right, action, ltp: side.ltp, previousClose: side.previousClose ?? null, asOf: chain.asOf, lotSize: chain.lotSize, heldLots: heldLots(right, strike), replay: null });
    };
    return { canSell: (right, strike) => (heldLots(right, strike) ?? 0) > 0, onBuy: open("BUY"), onSell: open("SELL") };
  }, [chain, symbol, heldLots]);

  function choose(next: string) {
    setSymbol(next.toUpperCase());
    setExpiry("");
    setQuery("");
    setStrikeQuery("");
    setAllStrikes(false);
  }

  const q = query.trim();
  const shownHits = q && hits.q === q ? hits.rows : [];

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-4 py-3">
          <h1 className="text-title font-semibold">Option chain</h1>
          <div className="relative min-w-[220px] max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a stock or index" aria-label="Search option underlying" className="search-field w-full bg-elevated py-2 text-sm" />
            {q && hits.q === q && shownHits.length === 0 ? <p className="absolute left-0 right-0 top-11 z-30 rounded-card border border-border bg-overlay px-3 py-2 text-data text-muted shadow-e3">No results. Try a company name or symbol such as RELIANCE.</p> : null}
            {shownHits.length > 0 ? (
              <div className="absolute left-0 right-0 top-11 z-30 max-h-64 overflow-auto rounded-card border border-border bg-overlay p-1 shadow-e3">
                {shownHits.map((hit) => (
                  <button key={`${hit.exchange}-${hit.symbol}`} type="button" className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left hover:bg-elevated" onClick={() => choose(hit.symbol)}>
                    <StockLogo symbol={hit.symbol} name={hit.name} size={24} />
                    <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{hit.name}</span><span className="text-[11px] text-muted">{hit.symbol} · {hit.sector || hit.exchange}</span></span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex gap-1">
            {FEATURED_INDICES.map((item) => (
              <button key={item.symbol} type="button" aria-pressed={symbol === item.symbol} className={cx("h-8 rounded-input px-2.5 text-data font-semibold", symbol === item.symbol ? "bg-primary/15 text-primary" : "text-muted hover:bg-elevated hover:text-text")} onClick={() => choose(item.symbol)}>{item.symbol}</button>
            ))}
          </div>
          <select aria-label="Option expiry" className="oc-select ml-auto w-[8rem]" value={expiry} onChange={(event) => setExpiry(event.target.value)}>
            {(chain?.expiries.length ? chain.expiries : expiry ? [expiry] : []).map((day) => <option key={day} value={day}>{day}</option>)}
          </select>
          <button type="button" aria-label={loading ? "Refreshing option chain" : "Refresh option chain"} title="Refresh" className="grid h-8 w-8 place-items-center rounded-input text-muted hover:bg-elevated hover:text-text" onClick={() => setReload((value) => value + 1)}>
            <RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} aria-hidden />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
          <Stat label={`${chain?.name || symbol} spot`} value={chain?.spot == null ? "—" : chain.spot.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
          <Stat label="ATM IV" value={chain?.atmIv == null ? "—" : chain.atmIv.toFixed(2)} />
          <Stat label="PCR" value={chain?.pcr == null ? "—" : chain.pcr.toFixed(2)} />
          <Stat label="Market lot" value={chain?.lotSize == null ? "—" : String(chain.lotSize)} />
          <Stat label="Days to expiry" value={chain?.daysToExpiry == null ? "—" : String(chain.daysToExpiry)} />
          <Stat label="Snapshot" value={chain?.asOf ? istTime(chain.asOf) : "—"} />
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
          <input value={strikeQuery} onChange={(event) => setStrikeQuery(event.target.value)} placeholder="Find a strike" aria-label="Filter strikes" inputMode="numeric" className="oc-search w-40 !pl-2" />
          <button type="button" className="text-data font-medium text-primary" onClick={() => setAllStrikes((value) => !value)}>{allStrikes ? "Show strikes near spot" : "Show every strike"}</button>
          <span className="ml-auto truncate text-[11px] text-muted">{error ? `${error}${chain ? " Showing the last snapshot." : ""}` : chain?.message}</span>
        </div>

        <OptionChainTable
          strikes={rows}
          atmStrike={chain?.atmStrike ?? null}
          spot={chain?.spot ?? null}
          bidAsk={false}
          scrollKey={`${symbol}|${chain?.expiry ?? ""}|${allStrikes}|${strikeQuery}`}
          loading={loading && !chain}
          actions={actions}
          className="bg-background"
          empty={error ? <>{error} <button type="button" className="font-medium text-primary" onClick={() => setReload((value) => value + 1)}>Retry</button></> : "No strikes to show for this expiry."}
        />
      </section>
      {draft ? <OptionOrderTicket key={draftKey(draft)} draft={draft} onClose={closeTicket} onFilled={() => { setLedgerTick((value) => value + 1); window.dispatchEvent(new Event("td-ledger")); }} /> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="bg-panel px-4 py-2.5"><div className="text-[11px] text-muted">{label}</div><div className="num mt-0.5 text-[15px] font-semibold">{value}</div></div>;
}
