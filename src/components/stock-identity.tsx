"use client";

import { useEffect, useState } from "react";
import { Search, Star } from "lucide-react";
import { api, money, moveOf, tone } from "@/components/api";

/** Brand colours for well-known NSE symbols. The mark is an initials avatar, not a copied logo. */
const MARK: Record<string, string> = {
  RELIANCE: "#0c4a8a",
  HDFCBANK: "#004c8f",
  ICICIBANK: "#f58220",
  SBIN: "#22409a",
  TATAMOTORS: "#2e3192",
  TCS: "#0f3d7a",
  INFY: "#007cc3",
  WIPRO: "#5a2d82",
  BHARTIARTL: "#ed1c24",
  ITC: "#1f4e79",
  LT: "#004b93",
  AXISBANK: "#97144d",
  KOTAKBANK: "#c41230",
  ADANIENT: "#111827",
  MARUTI: "#1f4e9a",
  HINDUNILVR: "#0033a0",
  ASIANPAINT: "#e85d04",
  ZOMATO: "#e23744",
  ETERNAL: "#e23744",
  NIFTY: "#2563eb",
  NIFTY100: "#1d4ed8",
  NIFTYNXT50: "#1e40af",
  BANKNIFTY: "#1d4ed8",
  FINNIFTY: "#0369a1",
  MIDCPNIFTY: "#0f766e",
  INDIAVIX: "#d97706",
};

const PALETTE = ["#2563eb", "#7c3aed", "#0891b2", "#0f766e", "#b45309", "#be123c", "#4338ca", "#0369a1", "#047857", "#a16207"];

/** HTTPS directory of listed-company marks, one file per NSE symbol. Override with NEXT_PUBLIC_LOGO_BASE. */
const LOGO_BASE = process.env.NEXT_PUBLIC_LOGO_BASE || "https://cdn.jsdelivr.net/gh/dharunashokkumar/api.dharun.dev@main/data/logos/nse/NSE_";
const missingLogos = new Set<string>();

export function logoSrc(symbol: string) {
  const key = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!key || missingLogos.has(key)) return null;
  return `${LOGO_BASE}${key}.svg`;
}

export function markColor(symbol: string) {
  const key = symbol.replace(/\s+/g, "").toUpperCase();
  if (MARK[key]) return MARK[key];
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function markLetters(symbol: string, name?: string) {
  const words = (name || "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter((word) => word.length > 1);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  const clean = symbol.replace(/[^A-Za-z0-9]/g, "");
  return (clean.slice(0, 2) || "?").toUpperCase();
}

export function StockLogo({ symbol, name, size = 32 }: { symbol: string; name?: string; size?: number }) {
  const key = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const [src, setSrc] = useState<string | null>(() => logoSrc(symbol));
  const color = markColor(symbol);
  return (
    <span
      className="inline-grid shrink-0 place-items-center overflow-hidden rounded-[28%] font-semibold leading-none text-white ring-1 ring-border-soft"
      style={{ width: size, height: size, background: src ? "var(--elevated)" : color, fontSize: Math.max(10, Math.round(size * 0.34)) }}
      aria-hidden
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain p-0.5"
          onError={() => {
            missingLogos.add(key);
            setSrc(null);
          }}
        />
      ) : markLetters(symbol, name)}
    </span>
  );
}

export function SymbolTitle({ symbol, name, exchange, size = 32 }: { symbol: string; name?: string; exchange?: string; size?: number }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <StockLogo symbol={symbol} name={name} size={size} />
      <span className="min-w-0 text-left">
        <span className="block truncate font-medium">{name || symbol}</span>
        <span className="block truncate text-[11px] font-normal text-muted">{symbol}{exchange ? ` · ${exchange}` : ""}</span>
      </span>
    </span>
  );
}

export function WatchStar({ active, label, onToggle }: { active: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className="group/star grid h-8 w-8 shrink-0 place-items-center rounded-input text-muted transition-colors hover:bg-hover hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
      onClick={(event) => { event.stopPropagation(); onToggle(); }}
    >
      <Star className={`h-[15px] w-[15px] transition-colors ${active ? "fill-star/70 text-star/70 group-hover/star:fill-star group-hover/star:text-star" : ""}`} aria-hidden />
    </button>
  );
}

const ORDER_TONE: Record<string, string> = {
  FILLED: "border-profit/25 bg-profit-soft text-profit",
  REJECTED: "border-loss/25 bg-loss-soft text-loss",
  CANCELLED: "border-border bg-sunken text-muted",
};

export function OrderStatus({ status }: { status: string }) {
  const toneClass = ORDER_TONE[status] ?? "border-warning/30 bg-warning-soft text-warning";
  return (
    <span className={`inline-flex h-5 items-center gap-1.5 rounded-sm border px-1.5 text-micro font-semibold uppercase tracking-[0.04em] ${toneClass}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {status.replaceAll("_", " ")}
    </span>
  );
}

export function DemoModeBadge({ children = "DEMO" }: { children?: string }) {
  return <span className="inline-flex h-5 items-center rounded-sm border border-demo/30 bg-demo-soft px-1.5 text-micro font-semibold uppercase tracking-[0.04em] text-demo">{children}</span>;
}

type Hit = { symbol: string; name: string; exchange: string };

const NO_QUOTES: Record<string, { last: number; previousClose: number }> = {};

export function StockSearchField({
  id = "td-search",
  query,
  onQuery,
  hits,
  status,
  watched,
  onSelect,
  onToggleWatch,
  placeholder = "Search for companies to invest or trade",
}: {
  id?: string;
  query: string;
  onQuery: (value: string) => void;
  hits: Hit[];
  status: "idle" | "loading" | "empty" | "ready" | "error";
  watched: (symbol: string) => boolean;
  onSelect: (hit: Hit) => void;
  onToggleWatch?: (hit: Hit) => void;
  placeholder?: string;
}) {
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [fetched, setQuotes] = useState<Record<string, { last: number; previousClose: number }>>({});
  const symbols = hits.map((hit) => hit.symbol).join(",");
  // A new result list starts at its first row, and an empty list shows no prices (adjusted during render).
  const [cursorFor, setCursorFor] = useState(symbols);
  if (cursorFor !== symbols) {
    setCursorFor(symbols);
    setCursor(0);
  }
  const quotes = symbols ? fetched : NO_QUOTES;

  useEffect(() => {
    if (!symbols) return;
    let stop = false;
    api<{ quotes: Array<{ symbol: string; last?: number; previousClose?: number; error?: string }> }>(`/api/market/quotes?symbols=${symbols}`)
      .then((data) => {
        if (stop) return;
        const next: Record<string, { last: number; previousClose: number }> = {};
        for (const row of data.quotes) {
          if (typeof row.last === "number" && typeof row.previousClose === "number") next[row.symbol] = { last: row.last, previousClose: row.previousClose };
        }
        setQuotes(next);
      })
      .catch(() => { if (!stop) setQuotes({}); });
    return () => { stop = true; };
  }, [symbols]);

  const open = focused && status !== "idle";

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        id={id}
        value={query}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-label="Search instruments"
        placeholder={placeholder}
        className="search-field h-10 w-full rounded-input py-2 text-dense"
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 160)}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (!hits.length) return;
          if (event.key === "ArrowDown") { event.preventDefault(); setCursor((value) => Math.min(hits.length - 1, value + 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setCursor((value) => Math.max(0, value - 1)); }
          if (event.key === "Enter" && hits[cursor]) { event.preventDefault(); onSelect(hits[cursor]); }
        }}
      />
      {open ? (
        <div id={`${id}-list`} role="listbox" className="surface-overlay anim-rise absolute left-0 right-0 top-12 z-20 max-h-80 overflow-auto rounded-card p-1" onMouseDown={(event) => event.preventDefault()}>
          {status === "loading" ? <p className="px-3 py-2 text-xs text-muted">Searching…</p> : null}
          {status === "error" ? <p className="px-3 py-2 text-xs text-loss">Search is unavailable right now.</p> : null}
          {status === "empty" ? <p className="px-3 py-2 text-xs text-muted">No instrument matched that name or symbol.</p> : null}
          {hits.map((hit, index) => {
            const quote = quotes[hit.symbol];
            const move = moveOf(quote ? String(quote.last) : undefined, quote ? String(quote.previousClose) : undefined);
            const active = index === cursor;
            return (
              <div key={`${hit.exchange}-${hit.symbol}`} role="option" aria-selected={active} className={`flex items-center gap-2 rounded-input px-2 py-1.5 ${active ? "bg-primary-soft" : ""}`}>
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onMouseEnter={() => setCursor(index)} onClick={() => onSelect(hit)}>
                  <SymbolTitle symbol={hit.symbol} name={hit.name} exchange={hit.exchange} size={36} />
                  <span className="ml-auto shrink-0 text-right">
                    <span className={`num block whitespace-nowrap text-sm ${tone(move?.abs)}`}>{quote ? money(quote.last) : "…"}</span>
                    <span className={`num block whitespace-nowrap text-[11px] ${tone(move?.abs)}`}>{move ? `${move.abs >= 0 ? "+" : ""}${move.abs.toFixed(2)} (${move.pct.toFixed(2)}%)` : ""}</span>
                  </span>
                </button>
                {onToggleWatch ? <WatchStar active={watched(hit.symbol)} label={watched(hit.symbol) ? `Remove ${hit.symbol} from watchlist` : `Add ${hit.symbol} to watchlist`} onToggle={() => onToggleWatch(hit)} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
