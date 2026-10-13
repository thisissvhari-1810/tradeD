"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw, Search } from "lucide-react";
import { api, istTime } from "@/components/api";
import { StockLogo } from "@/components/stock-identity";
import { IconButton } from "@/components/icon-button";
import { FEATURED_INDICES } from "@/lib/market/indices";

type Side = { ltp: number | null; oi: number | null; oiChangePct: number | null; volume: number | null; iv: number | null };
type Strike = { strike: number; ce: Side | null; pe: Side | null };
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
  strikes: Strike[];
};
type Hit = { symbol: string; name: string; exchange: string; sector?: string };

export function OptionChainBoard() {
  const params = useSearchParams();
  const [symbol, setSymbol] = useState((params.get("symbol") || "NIFTY").toUpperCase());
  const [expiry, setExpiry] = useState("");
  const [chain, setChain] = useState<Chain | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [looked, setLooked] = useState("");
  const [strikeQuery, setStrikeQuery] = useState("");
  const [allStrikes, setAllStrikes] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const next = params.get("symbol");
    if (next) {
      setSymbol(next.toUpperCase());
      setExpiry("");
    }
  }, [params]);

  useEffect(() => {
    let stop = false;
    const load = () => {
      const expiryQuery = expiry ? `&expiry=${encodeURIComponent(expiry)}` : "";
      api<Chain>(`/api/options/chain?symbol=${encodeURIComponent(symbol)}${expiryQuery}`)
        .then((data) => {
          if (stop) return;
          setChain(data);
          setError("");
          setLoading(false);
          if (!expiry && data.expiry) setExpiry(data.expiry);
        })
        .catch((caught: unknown) => {
          if (stop) return;
          setError(caught instanceof Error ? caught.message : "Option chain unavailable.");
          setLoading(false);
        });
    };
    setLoading(true);
    load();
    const timer = window.setInterval(load, 20000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [symbol, expiry, reload]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (!query.trim()) {
        setHits([]);
        setLooked("");
        return;
      }
      api<Hit[]>(`/api/instruments?q=${encodeURIComponent(query)}`).then((rows) => { setHits(rows); setLooked(query); }).catch(() => { setHits([]); setLooked(query); });
    }, 160);
    return () => window.clearTimeout(handle);
  }, [query]);

  const rows = useMemo(() => {
    const strikes = chain?.strikes ?? [];
    const filtered = strikeQuery.trim()
      ? strikes.filter((row) => String(row.strike).includes(strikeQuery.trim()))
      : strikes;
    if (allStrikes || !chain?.atmStrike || strikeQuery.trim()) return filtered;
    const atm = chain.atmStrike;
    const index = filtered.findIndex((row) => row.strike === atm);
    if (index < 0) return filtered;
    return filtered.slice(Math.max(0, index - 12), index + 13);
  }, [chain, allStrikes, strikeQuery]);

  const maxOi = Math.max(1, ...rows.flatMap((row) => [row.ce?.oi ?? 0, row.pe?.oi ?? 0]));

  function choose(next: string) {
    setSymbol(next.toUpperCase());
    setExpiry("");
    setQuery("");
    setHits([]);
    setStrikeQuery("");
    setAllStrikes(false);
  }

  return (
    <section className="border border-border bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-3">
        <h1 className="text-base font-semibold">Option chain</h1>
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a stock or index" aria-label="Search option underlying" className="search-field w-full bg-elevated py-2 text-sm" />
          {query.trim() && looked === query && hits.length === 0 ? <p className="absolute left-0 right-0 top-11 z-20 rounded-xl border border-border bg-panel px-3 py-2 text-xs text-muted shadow-lg">No match. Try a company name, symbol, Nifty 50, or Nifty 100.</p> : null}
          {hits.length > 0 ? (
            <div className="absolute left-0 right-0 top-11 z-20 max-h-64 overflow-auto rounded-xl border border-border bg-panel shadow-lg">
              {hits.map((hit) => (
                <button key={`${hit.exchange}-${hit.symbol}`} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-elevated" onClick={() => choose(hit.symbol)}>
                  <StockLogo symbol={hit.symbol} name={hit.name} size={28} />
                  <span className="min-w-0"><span className="block truncate text-sm font-medium">{hit.name}</span><span className="text-[11px] text-muted">{hit.symbol} · {hit.sector || hit.exchange}</span></span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <label className="text-xs text-muted">Expiry
          <select aria-label="Option expiry" className="ml-2 bg-elevated py-1 text-xs" value={expiry} onChange={(event) => setExpiry(event.target.value)}>
            {(chain?.expiries.length ? chain.expiries : expiry ? [expiry] : []).map((day) => <option key={day} value={day}>{day}</option>)}
          </select>
        </label>
        <IconButton label={loading ? "Refreshing option chain" : "Refresh option chain"} disabled={loading} onClick={() => setReload((value) => value + 1)}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
        </IconButton>
      </div>
      <div className="flex gap-1 overflow-x-auto px-3 py-2">
        {FEATURED_INDICES.map((item) => (
          <button key={item.symbol} type="button" className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs ${symbol === item.symbol ? "bg-primary text-white" : "bg-elevated text-muted"}`} onClick={() => choose(item.symbol)}><StockLogo symbol={item.symbol} name={item.name} size={18} />{item.name}</button>
        ))}
      </div>
      <div className="grid gap-3 px-3 pb-3 sm:grid-cols-2 lg:grid-cols-6">
        <Stat label={chain?.name || symbol} value={chain?.spot == null ? "—" : money(chain.spot)} />
        <Stat label="ATM IV" value={chain?.atmIv == null ? "—" : chain.atmIv.toFixed(2)} />
        <Stat label="IV change" value="—" title="This feed does not send the previous implied volatility." />
        <Stat label="PCR" value={chain?.pcr == null ? "—" : chain.pcr.toFixed(2)} />
        <Stat label="Market lot" value={chain?.lotSize == null ? "—" : String(chain.lotSize)} />
        <Stat label="Days to expiry" value={chain?.daysToExpiry == null ? "—" : String(chain.daysToExpiry)} />
      </div>
      <p className="px-3 pb-2 text-[11px] text-muted">{error || chain?.message || "Loading the option chain…"} {chain?.asOf ? `· ${istTime(chain.asOf)}` : ""}</p>
      <div className="flex items-center gap-2 px-3 pb-2">
        <input value={strikeQuery} onChange={(event) => setStrikeQuery(event.target.value)} placeholder="Find a strike" aria-label="Filter strikes" className="w-40 bg-elevated py-1 text-xs" />
        <button type="button" className="text-xs text-primary" onClick={() => setAllStrikes((value) => !value)}>{allStrikes ? "Show strikes near spot" : "Show every strike"}</button>
      </div>
      <div className="overflow-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th>Call OI</th><th>OI change</th><th>Volume</th><th>Call LTP</th>
              <th>Strike</th>
              <th>Put LTP</th><th>Volume</th><th>OI change</th><th>Put OI</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={9} className="text-muted">{loading ? "Loading strikes…" : "No strikes to show."}</td></tr> : null}
            {rows.map((row) => {
              const atm = row.strike === chain?.atmStrike;
              return (
                <tr key={row.strike} className={atm ? "bg-cream" : ""}>
                  <OiCell value={row.ce?.oi ?? null} max={maxOi} side="call" />
                  <td className={`num ${tone(row.ce?.oiChangePct)}`}>{pct(row.ce?.oiChangePct ?? null)}</td>
                  <td className="num">{count(row.ce?.volume ?? null)}</td>
                  <td className="num font-medium">{price(row.ce?.ltp ?? null)}</td>
                  <td className={`num text-center font-semibold ${atm ? "text-primary" : ""}`}>{row.strike.toLocaleString("en-IN")}{atm && chain?.spot != null ? <span className="mt-0.5 block text-[10px] font-normal text-primary">{money(chain.spot)}</span> : null}</td>
                  <td className="num font-medium">{price(row.pe?.ltp ?? null)}</td>
                  <td className="num">{count(row.pe?.volume ?? null)}</td>
                  <td className={`num ${tone(row.pe?.oiChangePct)}`}>{pct(row.pe?.oiChangePct ?? null)}</td>
                  <OiCell value={row.pe?.oi ?? null} max={maxOi} side="put" />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div title={title}><div className="text-[10px] uppercase tracking-wide text-muted">{label}</div><div className="num mt-1 text-sm font-medium">{value}</div></div>;
}

function OiCell({ value, max, side }: { value: number | null; max: number; side: "call" | "put" }) {
  const width = value == null ? 0 : Math.max(4, Math.round((value / max) * 100));
  const color = side === "call" ? "rgba(27,143,78,0.18)" : "rgba(224,79,79,0.16)";
  return <td className="num" style={{ backgroundImage: `linear-gradient(to ${side === "call" ? "left" : "right"}, ${color}, ${color} ${width}%, transparent ${width}%)` }}>{count(value)}</td>;
}

function money(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function price(value: number | null) {
  return value == null ? "—" : value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function count(value: number | null) {
  return value == null ? "—" : value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}
function pct(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}
function tone(value: number | null | undefined) {
  if (value == null || value === 0 || !Number.isFinite(value)) return "flat";
  return value > 0 ? "up" : "down";
}
