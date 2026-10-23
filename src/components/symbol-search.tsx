"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { api, moveOf, type Instrument, type Quote } from "@/components/api";
import { StockLogo } from "@/components/stock-identity";
import { cx } from "@/components/ui";
import { signedPercent } from "@/lib/format";

type Status = "idle" | "loading" | "ready" | "empty" | "error";

const TYPE_LABEL: Record<string, string> = { INDEX: "Index", EQ: "Equity" };

/** Recently opened symbols in this browser (the same list Markets shows). */
function readRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("td-recent") || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

/** Exact symbol first, then symbols that start with the query, then the rest (the server orders by name). */
export function rankInstruments(rows: Instrument[], query: string) {
  const q = query.trim().toUpperCase();
  const score = (row: Instrument) => (row.symbol === q ? 0 : row.symbol.startsWith(q) ? 1 : row.name.toUpperCase().startsWith(q) ? 2 : 3);
  const seen = new Set<string>();
  return rows
    .filter((row) => (seen.has(`${row.exchange}:${row.symbol}`) ? false : (seen.add(`${row.exchange}:${row.symbol}`), true)))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => score(a.row) - score(b.row) || a.index - b.index)
    .map((item) => item.row);
}

function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim();
  const at = q ? text.toUpperCase().indexOf(q.toUpperCase()) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark className="rounded-[0.125rem] bg-primary-soft text-primary">{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
}

/**
 * The chart's stock picker (opened from the symbol at the top left): a popover on desktop, a bottom
 * sheet on phones. Results come from the instrument master (/api/instruments); prices only from the
 * live quote feed, never invented.
 */
export function SymbolSearch({ open, current, onSelect, onClose }: {
  open: boolean;
  current: { symbol: string; exchange: string };
  onSelect: (symbol: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ q: string; rows: Instrument[]; failed: boolean }>({ q: "", rows: [], failed: false });
  const [cursor, setCursor] = useState(0);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [recent, setRecent] = useState<string[]>([]);
  // Before typing: indices and every stock A–Z (from the instrument master), loaded a page at a time.
  const [browse, setBrowse] = useState<{ rows: Instrument[]; state: "idle" | "loading" | "ready" | "error"; done: boolean }>({ rows: [], state: "idle", done: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const requestId = useRef(0);
  const [retry, setRetry] = useState(0);

  // Each opening starts empty, with the recent list, and focuses the field.
  const [openedFor, setOpenedFor] = useState(false);
  if (open !== openedFor) {
    setOpenedFor(open);
    if (open) {
      setQuery("");
      setCursor(0);
      setRecent(readRecent());
      if (browse.state === "idle" || browse.state === "error") setBrowse({ rows: [], state: "loading", done: false });
    }
  }
  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const browseLoading = open && browse.state === "loading" && browse.rows.length === 0;
  useEffect(() => {
    if (!browseLoading) return;
    let stop = false;
    api<Instrument[]>("/api/instruments")
      .then((rows) => { if (!stop) setBrowse({ rows, state: "ready", done: rows.length < 50 }); })
      .catch(() => { if (!stop) setBrowse({ rows: [], state: "error", done: false }); });
    return () => { stop = true; };
  }, [browseLoading]);
  function loadMore() {
    if (browse.state === "loading" || browse.done) return;
    const skip = browse.rows.filter((row) => row.sector !== "INDEX").length;
    setBrowse((current) => ({ ...current, state: "loading" }));
    api<Instrument[]>(`/api/instruments?skip=${skip}`)
      .then((rows) => setBrowse((current) => {
        const seen = new Set(current.rows.map((row) => row.symbol));
        const fresh = rows.filter((row) => !seen.has(row.symbol));
        return { rows: [...current.rows, ...fresh], state: "ready", done: fresh.length === 0 || rows.length < 50 };
      }))
      .catch(() => setBrowse((current) => ({ ...current, state: "ready", done: true })));
  }

  // Debounced search; a slower, older answer never replaces a newer one.
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) return;
    const id = ++requestId.current;
    const timer = window.setTimeout(() => {
      api<Instrument[]>(`/api/instruments?q=${encodeURIComponent(q)}`)
        .then((rows) => { if (id === requestId.current) setResult({ q, rows: rankInstruments(rows, q), failed: false }); })
        .catch(() => { if (id === requestId.current) setResult({ q, rows: [], failed: true }); });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, open, retry]);

  const q = query.trim();
  // A new query starts the list at its first row (never keeps the previous list's scroll position).
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [q, open]);
  const status: Status = !q ? "idle" : result.q !== q ? "loading" : result.failed ? "error" : result.rows.length ? "ready" : "empty";
  const toRow = (row: Instrument) => ({ symbol: row.symbol, name: row.name, exchange: row.exchange, type: TYPE_LABEL[row.sector] ?? row.sector });
  // Before typing: the current stock first, then the other recent picks (newest first), then A–Z.
  const pinned = useMemo(() => [...new Set([current.symbol, ...recent].filter(Boolean))], [current.symbol, recent]);
  const recentRows = useMemo(() => pinned.map((symbol) => {
    const known = browse.rows.find((row) => row.symbol === symbol);
    return known ? toRow(known) : { symbol, name: "", exchange: "NSE", type: "" };
  }), [pinned, browse.rows]);
  const rows = useMemo<Array<{ symbol: string; name: string; exchange: string; type: string }>>(() => {
    if (!q) {
      const recentSet = new Set(pinned);
      return [...recentRows, ...browse.rows.filter((row) => !recentSet.has(row.symbol)).map(toRow)];
    }
    if (status !== "ready") return [];
    return result.rows.map(toRow);
  }, [q, pinned, recentRows, browse.rows, status, result.rows]);
  const recentCount = q ? 0 : recentRows.length;

  // Live price and change for the visible rows, when the feed has them.
  const quoted = rows.slice(0, 30).map((row) => row.symbol).join(",");
  useEffect(() => {
    if (!open || !quoted) return;
    let stop = false;
    api<{ quotes: Array<Quote | { symbol: string; error: string }> }>(`/api/market/quotes?symbols=${quoted}`)
      .then((data) => {
        if (stop) return;
        const next: Record<string, Quote> = {};
        for (const row of data.quotes) if ("last" in row) next[row.symbol] = row;
        setQuotes((current) => ({ ...current, ...next }));
      })
      .catch(() => undefined);
    return () => { stop = true; };
  }, [open, quoted]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const active = Math.min(cursor, Math.max(0, rows.length - 1));
  function choose(symbol: string) {
    onSelect(symbol);
    onClose();
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      const next = event.key === "ArrowDown" ? (active + 1) % rows.length : (active - 1 + rows.length) % rows.length;
      setCursor(next);
      listRef.current?.querySelectorAll("li")[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && rows[active]) {
      event.preventDefault();
      choose(rows[active].symbol);
    }
  }

  return (
    <div className="fixed inset-0 z-[75] lg:absolute lg:inset-auto lg:left-2 lg:top-[calc(100%+0.25rem)]">
      <button type="button" tabIndex={-1} className="anim-fade absolute inset-0 bg-[var(--scrim)] lg:fixed lg:bg-transparent" aria-label="Close stock search" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search stocks"
        className="surface-modal anim-fade absolute inset-x-0 top-0 flex max-h-[min(88dvh,42rem)] flex-col rounded-b-sheet pt-[env(safe-area-inset-top)] lg:relative lg:inset-auto lg:max-h-[min(70vh,34rem)] lg:w-[26rem] lg:rounded-card lg:pt-0"
      >
        <div className="flex items-center justify-between px-4 pb-1 pt-2 lg:px-3">
          <h2 className="text-title font-semibold lg:text-dense">Search stocks</h2>
          <button type="button" className="grid h-10 w-10 place-items-center rounded-input text-muted hover:bg-hover lg:h-8 lg:w-8" aria-label="Close" onClick={onClose}><X className="h-5 w-5 lg:h-4 lg:w-4" aria-hidden /></button>
        </div>
        <div className="relative px-4 pb-2 lg:px-3">
          <Search className="pointer-events-none absolute left-7 top-[calc(50%-0.25rem)] h-4 w-4 -translate-y-1/2 text-muted lg:left-6" aria-hidden />
          <input
            ref={inputRef}
            className="h-11 w-full rounded-input border border-border bg-sunken text-dense text-text lg:h-9"
            style={{ paddingLeft: "2.25rem", paddingRight: "2.5rem" }}
            value={query}
            placeholder="Search name or symbol"
            aria-label="Search name or symbol"
            aria-controls="td-symbol-results"
            aria-activedescendant={rows[active] ? `td-symbol-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
            onKeyDown={onKeyDown}
          />
          {query ? <button type="button" className="absolute right-6 top-[calc(50%-0.25rem)] grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-muted hover:text-text lg:right-5" aria-label="Clear search" onClick={() => { setQuery(""); inputRef.current?.focus(); }}><X className="h-4 w-4" aria-hidden /></button> : null}
        </div>
        <p className="px-4 pb-1 text-micro font-semibold uppercase tracking-wide text-muted lg:px-3">
          {status === "idle" ? (pinned.length ? "Recent" : "All stocks") : status === "loading" ? "Searching…" : status === "ready" ? `${rows.length} result${rows.length === 1 ? "" : "s"}` : ""}
        </p>
        <ul id="td-symbol-results" ref={listRef} role="listbox" aria-label="Stocks" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {status === "empty" ? <li className="px-3 py-6 text-center text-data text-muted">No stocks found. Try another name or symbol.</li> : null}
          {status === "error" ? (
            <li className="flex flex-col items-center gap-2 px-3 py-6 text-center text-data text-loss" role="alert">
              Search is unavailable right now. Check the connection and try again.
              <button type="button" className="h-9 rounded-input border border-border px-4 font-medium text-text hover:bg-hover" onClick={() => { setResult({ q: "", rows: [], failed: false }); setRetry((value) => value + 1); }}>Retry</button>
            </li>
          ) : null}
          {rows.map((row, index) => {
            const heading = !q && recentCount > 0 && index === recentCount ? <p className="px-2 pb-1 pt-3 text-micro font-semibold uppercase tracking-wide text-muted">All stocks</p> : null;
            const selected = row.symbol === current.symbol && row.exchange === current.exchange;
            const quote = quotes[row.symbol];
            const move = moveOf(quote?.last, quote?.previousClose);
            return (
              <li key={`${row.exchange}:${row.symbol}`} id={`td-symbol-${index}`} role="option" aria-selected={index === active}>
                {heading}
                <button
                  type="button"
                  className={cx("flex min-h-14 w-full items-center gap-3 rounded-md px-2 text-left lg:min-h-11", index === active ? "bg-hover" : "hover:bg-hover", selected && "ring-1 ring-primary/40")}
                  onMouseMove={() => setCursor(index)}
                  onClick={() => choose(row.symbol)}
                >
                  <StockLogo symbol={row.symbol} name={row.name || row.symbol} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-dense font-semibold text-text"><Highlight text={row.symbol} query={q} /></span>
                      {selected ? <span className="shrink-0 rounded-sm bg-primary-soft px-1 text-[0.625rem] font-semibold text-primary">Current</span> : null}
                    </span>
                    <span className="block truncate text-micro text-muted">
                      {row.name ? <Highlight text={row.name} query={q} /> : null}{row.name ? " · " : ""}{row.exchange}{row.type ? ` · ${row.type}` : ""}
                    </span>
                  </span>
                  {quote ? (
                    <span className="shrink-0 text-right">
                      <span className="num block text-data font-medium text-text">{Number(quote.last).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      {move ? <span className={cx("num block text-micro", move.abs > 0 ? "text-profit" : move.abs < 0 ? "text-loss" : "text-muted")}>{signedPercent(move.pct)}</span> : null}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
          {!q && browse.state === "loading" ? <li className="px-3 py-4 text-center text-data text-muted">Loading stocks…</li> : null}
          {!q && browse.state === "error" ? <li className="px-3 py-4 text-center text-data text-loss" role="alert">The stock list could not be loaded. Type to search instead.</li> : null}
          {!q && browse.state === "ready" && !browse.done ? (
            <li className="px-2 pt-1">
              <button type="button" className="h-11 w-full rounded-md border border-border-soft text-data font-medium text-primary hover:bg-hover lg:h-9" onClick={loadMore}>Show more stocks</button>
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
