"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw, Search, Settings, X } from "lucide-react";
import { api, istTime } from "@/components/api";
import { OptionChainTable, type ChainActions, type ChainSide, type ChainStrike, type Right } from "@/components/option-chain-table";
import type { OptionOrderDraft } from "@/components/option-order-ticket";
import { cx } from "@/components/ui";
import { FEATURED_INDICES } from "@/lib/market/indices";

export type OptionChartRequest = {
  securityId: string;
  kind: "index" | "equity";
  underlying: string;
  name: string;
  expiry: string;
  strike: number;
  right: "CE" | "PE";
  ltp: number | null;
};

type Chain = {
  symbol: string;
  name: string;
  kind?: "index" | "equity";
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
type Hit = { symbol: string; name: string; exchange: string };
type Held = { symbol: string; quantity: number; averageCost: string };
type Lists = Array<{ id: string; items: Array<{ symbol: string }> }>;

const SETTINGS_KEY = "td-option-chain-panel";
const CHIPS = ["NIFTY", "BANKNIFTY", "FINNIFTY"];

export type ChainReplay = { date: string; session: string | null; cursor: number | null; spot: number | null; spotSymbol: string };

/** Docked to the left of the chart area so the order ticket on the right never covers it. */
export function OptionChainPanel({ symbol, replay, onClose, onOpenChart, onOrder, ledgerTick = 0, livePaper = false }: { livePaper?: boolean; symbol: string; replay: ChainReplay | null; onClose: () => void; onOpenChart: (contract: OptionChartRequest) => void; onOrder: (draft: OptionOrderDraft) => void; ledgerTick?: number }) {
  const [underlying, setUnderlying] = useState(symbol);
  const [shownSymbol, setShownSymbol] = useState(symbol);
  const [expiry, setExpiry] = useState("");
  const [chain, setChain] = useState<Chain | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saved] = useState(readSettings);
  const [around, setAround] = useState(saved.around);
  const [bidAsk, setBidAsk] = useState(saved.bidAsk);
  const [intervalSec, setIntervalSec] = useState(saved.intervalSec);
  const [reload, setReload] = useState(0);
  const [note, setNote] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [held, setHeld] = useState<Held[]>([]);
  const [quote, setQuote] = useState<{ last: string; previousClose: string } | null>(null);
  const [lists, setLists] = useState<Lists>([]);
  const [selected, setSelected] = useState<string | null>(null);

  if (shownSymbol !== symbol) {
    setShownSymbol(symbol);
    setUnderlying(symbol);
    setExpiry("");
  }

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ around, bidAsk, intervalSec }));
  }, [around, bidAsk, intervalSec]);

  useEffect(() => {
    let stop = false;
    const load = () => {
      setLoading(true);
      const expiryQuery = expiry ? `&expiry=${encodeURIComponent(expiry)}` : "";
      api<Chain>(`/api/options/chain?symbol=${encodeURIComponent(underlying)}${expiryQuery}`)
        .then((data) => {
          if (stop) return;
          setChain(data);
          setError("");
          if (!expiry && data.expiry) setExpiry(data.expiry);
        })
        .catch((caught: unknown) => {
          if (!stop) setError(caught instanceof Error ? caught.message : "Option chain unavailable.");
        })
        .finally(() => { if (!stop) setLoading(false); });
    };
    load();
    const timer = window.setInterval(load, intervalSec * 1000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [underlying, expiry, reload, intervalSec]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (!query.trim()) return setHits([]);
      api<Hit[]>(`/api/instruments?q=${encodeURIComponent(query)}`).then(setHits).catch(() => setHits([]));
    }, 160);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    api<{ positions: Held[] }>("/api/portfolio")
      .then((data) => setHeld(data.positions.filter((row) => row.symbol.startsWith(`${underlying}|`))))
      .catch(() => setHeld([]));
  }, [underlying, ledgerTick]);

  useEffect(() => {
    api<{ lists: Lists }>("/api/watchlists").then((data) => setLists(data.lists)).catch(() => undefined);
  }, []);

  useEffect(() => {
    api<{ last: string; previousClose: string }>(`/api/market/quote?symbol=${encodeURIComponent(underlying)}`).then(setQuote).catch(() => setQuote(null));
  }, [underlying, reload]);

  const replaying = replay != null;
  const replayDate = replay?.date ?? null;
  const replaySession = replay?.session ?? null;
  const replaySpot = replay && replay.spotSymbol === underlying ? replay.spot : null;
  const atmStrike = useMemo(() => {
    if (!replaying) return chain?.atmStrike ?? null;
    const strikes = chain?.strikes ?? [];
    if (replaySpot == null || !strikes.length) return null;
    return strikes.reduce((best, row) => Math.abs(row.strike - replaySpot) < Math.abs(best.strike - replaySpot) ? row : best).strike;
  }, [chain, replaying, replaySpot]);

  const rows = useMemo(() => {
    // During replay, the live snapshot (premium, OI, volume, contract id) is withheld so it cannot be mistaken for the replay price.
    const strikes = replaying ? (chain?.strikes ?? []).map((row) => ({ strike: row.strike, ce: row.ce ? blank : null, pe: row.pe ? blank : null })) : chain?.strikes ?? [];
    if (!atmStrike || around === 0) return strikes;
    const index = strikes.findIndex((row) => row.strike === atmStrike);
    if (index < 0) return strikes;
    return strikes.slice(Math.max(0, index - around), index + around + 1);
  }, [chain, around, replaying, atmStrike]);

  const contractKey = useCallback((right: Right, strike: number) => `${underlying}|${chain?.expiry}|${strike}|${right}`, [underlying, chain]);
  const heldRow = useCallback((right: Right, strike: number) => {
    const key = replaying ? (replaySession ? `${contractKey(right, strike)}|R:${replaySession}` : null) : contractKey(right, strike);
    return key ? held.find((item) => item.symbol === key) ?? null : null;
  }, [held, contractKey, replaying, replaySession]);
  const heldLots = useCallback((right: Right, strike: number) => {
    const row = heldRow(right, strike);
    if (!row) return 0;
    return chain?.lotSize ? Math.floor(row.quantity / chain.lotSize) : null;
  }, [heldRow, chain]);

  const actions = useMemo<ChainActions>(() => {
    const open = (action: "BUY" | "SELL") => (right: Right, strike: number, side: ChainSide) => {
      if (!chain?.expiry || (!replayDate && side.ltp == null)) return;
      const position = heldRow(right, strike);
      const avg = position ? Number(position.averageCost) : NaN;
      onOrder({
        underlying,
        name: chain.name || underlying,
        expiry: chain.expiry,
        strike,
        right,
        action,
        ltp: replayDate ? null : side.ltp,
        previousClose: replayDate ? null : side.previousClose ?? null,
        asOf: replayDate ? null : chain.asOf,
        lotSize: chain.lotSize,
        heldLots: heldLots(right, strike),
        avgCost: Number.isFinite(avg) ? avg : null,
        replay: replayDate ? { session: replaySession ?? "", date: replayDate } : null,
      });
    };
    return {
      ...(replayDate ? { canTrade: (_right: Right, _strike: number, side: ChainSide | null) => side != null } : {}),
      canSell: (right, strike) => (heldLots(right, strike) ?? 0) > 0,
      onBuy: open("BUY"),
      onSell: open("SELL"),
      onChart: (right, strike, side) => {
        if (!chain?.expiry || !side.securityId) return;
        setSelected(`${strike}|${right}`);
        onOpenChart({ securityId: side.securityId, kind: chain.kind === "equity" ? "equity" : "index", underlying, name: chain.name, expiry: chain.expiry, strike, right, ltp: side.ltp });
      },
      isWatched: (right, strike) => lists.some((list) => list.items.some((item) => item.symbol === contractKey(right, strike))),
      onWatch: (right, strike) => {
        if (!chain?.expiry) return;
        const list = lists[0];
        if (!list) return setNote({ tone: "error", text: "Create a watchlist before saving a contract." });
        const key = contractKey(right, strike);
        const present = list.items.some((item) => item.symbol === key);
        const request = present
          ? api("/api/watchlists", { action: "remove", id: list.id, symbol: key })
          : api("/api/watchlists", { action: "add-option", id: list.id, symbol: underlying, expiry: chain.expiry, strike, right });
        void request
          .then(() => api<{ lists: Lists }>("/api/watchlists"))
          .then((data) => { setLists(data.lists); setNote({ tone: "info", text: `${underlying} ${strike} ${right} ${present ? "removed from" : "saved to"} the watchlist.` }); })
          .catch((reason: unknown) => setNote({ tone: "error", text: reason instanceof Error ? reason.message : "The watchlist could not be updated." }));
      },
    };
  }, [chain, underlying, replayDate, replaySession, onOrder, onOpenChart, heldLots, heldRow, lists, contractKey]);

  const move = replaying ? null : spotMove(chain?.spot ?? null, quote);
  const spotShown = replaying ? replaySpot : chain?.spot ?? null;
  const daysToExpiry = replaying ? (chain?.expiry && replay?.date ? Math.round((Date.parse(`${chain.expiry}T00:00:00Z`) - Date.parse(`${replay.date}T00:00:00Z`)) / 86_400_000) : null) : chain?.daysToExpiry ?? null;
  const heldCount = replaying ? held.filter((row) => replay?.session && row.symbol.endsWith(`|R:${replay.session}`)).length : held.filter((row) => !row.symbol.includes("|R:")).length;
  const choose = (next: string) => { setUnderlying(next); setExpiry(""); setQuery(""); setHits([]); };

  return (
    <section className="anim-fade absolute inset-y-2 left-2 z-30 flex w-[min(760px,calc(100%-1rem))] flex-col overflow-hidden rounded-sheet border border-border bg-panel text-text shadow-e3" aria-label="Option chain">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="shrink-0 text-[15px] font-semibold">Option chain</h2>
        <div className="flex shrink-0 gap-1">
          {FEATURED_INDICES.filter((item) => CHIPS.includes(item.symbol)).map((item) => (
            <button key={item.symbol} type="button" aria-pressed={underlying === item.symbol} className={cx("h-7 rounded-input px-2.5 text-data font-semibold", underlying === item.symbol ? "bg-primary/15 text-primary" : "text-muted hover:bg-elevated hover:text-text")} onClick={() => choose(item.symbol)}>{item.symbol}</button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden />
          <input className="oc-search w-full min-w-0" value={query} placeholder="Search underlying" aria-label="Search underlying" onChange={(event) => setQuery(event.target.value)} />
          {query ? <button type="button" className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center text-muted hover:text-text" aria-label="Clear search" onClick={() => { setQuery(""); setHits([]); }}><X className="h-3 w-3" aria-hidden /></button> : null}
          {hits.length > 0 ? (
            <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-56 overflow-auto rounded-card border border-border bg-overlay p-1 shadow-e3">
              {hits.map((hit) => <button key={hit.symbol} type="button" className="flex w-full items-baseline gap-2 rounded-xs px-2 py-1.5 text-left hover:bg-elevated" onClick={() => choose(hit.symbol)}><span className="text-[13px] font-medium">{hit.symbol}</span><span className="truncate text-data text-muted">{hit.name}</span></button>)}
            </div>
          ) : null}
        </div>
        <select aria-label="Expiry" className="oc-select w-[7.5rem] shrink-0" value={expiry} onChange={(event) => setExpiry(event.target.value)}>
          {(chain?.expiries.length ? chain.expiries : expiry ? [expiry] : []).map((day) => <option key={day} value={day}>{day}</option>)}
        </select>
        <IconAction label={loading ? "Refreshing option chain" : "Refresh option chain"} onClick={() => setReload((value) => value + 1)}><RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} aria-hidden /></IconAction>
        <IconAction label="Option chain settings" active={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}><Settings className="h-4 w-4" aria-hidden /></IconAction>
        <IconAction label="Close option chain" onClick={onClose}><X className="h-4 w-4" aria-hidden /></IconAction>
      </header>

      {settingsOpen ? (
        <div className="flex flex-wrap items-center gap-4 border-b border-border bg-elevated px-3 py-2 text-data text-text-2">
          <label className="flex items-center gap-2">Strikes
            <select className="oc-select" value={around} onChange={(event) => setAround(Number(event.target.value))}><option value={8}>±8 around ATM</option><option value={12}>±12 around ATM</option><option value={20}>±20 around ATM</option><option value={0}>All strikes</option></select>
          </label>
          <label className="flex items-center gap-2"><input className="oc-check" type="checkbox" checked={bidAsk} onChange={(event) => setBidAsk(event.target.checked)} />Bid / ask</label>
          <label className="flex items-center gap-2">Refresh
            <select className="oc-select" value={intervalSec} onChange={(event) => setIntervalSec(Number(event.target.value))}><option value={20}>Every 20 s</option><option value={60}>Every 60 s</option></select>
          </label>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border px-3 py-2">
        <Stat label={`${chain?.name || underlying} spot${replaying ? " at replay" : ""}`} value={spotShown == null ? "—" : spotShown.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} extra={move ? <span className={cx("num ml-1.5 text-data", move.change > 0 ? "text-profit" : move.change < 0 ? "text-loss" : "text-muted")}>{move.text}</span> : null} />
        {replaying ? null : <Stat label="ATM IV" value={chain?.atmIv == null ? "N/A" : chain.atmIv.toFixed(2)} />}
        {replaying ? null : <Stat label="PCR" value={chain?.pcr == null ? "N/A" : chain.pcr.toFixed(2)} />}
        <Stat label="Lot" value={chain?.lotSize == null ? "N/A" : String(chain.lotSize)} />
        <Stat label="Days to expiry" value={daysToExpiry == null ? "N/A" : String(daysToExpiry)} />
        <span className="ml-auto text-[11px] text-muted" title={chain?.message}>{replaying ? `Replay ${replay?.date ?? ""} ${replay?.cursor == null ? "" : `${clock(replay.cursor)} IST`}` : chain?.asOf ? `Snapshot ${istTime(chain.asOf)}` : loading ? "Loading…" : ""}</span>
      </div>
      {replaying ? (
        <p className="border-b border-border bg-info/10 px-3 py-1.5 text-[11px] text-info">
          Historical replay. Live premiums, OI and volume are hidden. Choose a strike and the ticket prices it from 1-minute history at the replay time. Only currently listed expiries can be replayed.
          {replaySpot == null ? ` ATM is not marked because the chart is replaying ${replay?.spotSymbol ?? "another symbol"}, not ${underlying}.` : ""}
        </p>
      ) : null}

      <OptionChainTable
        strikes={rows}
        atmStrike={atmStrike}
        spot={spotShown}
        bidAsk={bidAsk}
        scrollKey={`${underlying}|${chain?.expiry ?? ""}|${around}`}
        loading={loading && !chain}
        selected={selected}
        actions={actions}
        empty={error ? <>{error} <button type="button" className="font-medium text-primary" onClick={() => setReload((value) => value + 1)}>Retry</button></> : chain?.message || "No contracts were returned for this instrument and expiry."}
      />

      {note ? <p className={cx("border-t border-border px-3 py-1.5 text-data", note.tone === "error" ? "text-loss" : "text-info")} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p> : null}
      <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted">{error && chain ? `${error} Showing the last snapshot. ` : ""}{livePaper ? "Paper trading at live prices: hover a row for Buy / Sell (virtual, nothing is sent to Dhan). Real orders: Accounts → Live." : replaying ? "Hover a row for Buy / Sell." : "Hover a row for Buy / Sell. Click a premium to chart that contract."}{heldCount ? ` Holding ${heldCount} contract${heldCount === 1 ? "" : "s"} on ${underlying}${replaying ? " in this replay session" : ""}.` : ""}</p>
    </section>
  );
}

const blank: ChainSide = { ltp: null, previousClose: null, oi: null, oiChangePct: null, volume: null, iv: null, bid: null, ask: null, securityId: null };

function clock(seconds: number) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(seconds * 1000));
}

function readSettings() {
  const fallback = { around: 12, bidAsk: false, intervalSec: 20 };
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as { around?: number; bidAsk?: boolean; intervalSec?: number };
    return {
      around: parsed.around === 8 || parsed.around === 12 || parsed.around === 20 || parsed.around === 0 ? parsed.around : fallback.around,
      bidAsk: typeof parsed.bidAsk === "boolean" ? parsed.bidAsk : fallback.bidAsk,
      intervalSec: parsed.intervalSec === 20 || parsed.intervalSec === 60 ? parsed.intervalSec : fallback.intervalSec,
    };
  } catch {
    localStorage.removeItem(SETTINGS_KEY);
    return fallback;
  }
}

function IconAction({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" title={label} aria-label={label} aria-pressed={active} className={cx("grid h-8 w-8 shrink-0 place-items-center rounded-input hover:bg-elevated hover:text-text", active ? "bg-elevated text-text" : "text-muted")} onClick={onClick}>{children}</button>;
}

function Stat({ label, value, extra }: { label: string; value: string; extra?: ReactNode }) {
  return <span className="flex flex-col"><span className="text-[11px] text-muted">{label}</span><span className="num text-[13px] font-semibold text-text">{value}{extra}</span></span>;
}

function spotMove(spot: number | null, quote: { last: string; previousClose: string } | null) {
  const previous = quote ? Number(quote.previousClose) : NaN;
  if (spot == null || !Number.isFinite(previous) || previous <= 0) return null;
  const change = spot - previous;
  const percent = (change / previous) * 100;
  return { change, text: `${change > 0 ? "▲ +" : change < 0 ? "▼ −" : ""}${Math.abs(change).toFixed(2)} (${Math.abs(percent).toFixed(2)}%)` };
}
