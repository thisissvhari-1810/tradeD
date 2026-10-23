"use client";

import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from "react";
import { CandlestickChart, History, Search, X } from "lucide-react";
import { api, type Instrument } from "@/components/api";
import { cx } from "@/components/ui";

export type SearchPage = { href: string; label: string; icon: ComponentType<{ className?: string }> };

type Entry = { id: string; group: "Symbols" | "Pages"; label: string; hint?: string; icon: ComponentType<{ className?: string }>; run: () => void };

const PLACEHOLDER = "Search stocks, options, pages";

function readRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem("td-recent") || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** Top-bar search: inline field on desktop, icon button that opens a full-width panel on small screens. */
export function GlobalSearch({ pages, onSymbol, onPage }: { pages: SearchPage[]; onSymbol: (symbol: string) => void; onPage: (href: string) => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <>
      <div className="relative hidden w-[clamp(12.5rem,20vw,23.75rem)] shrink-0 md:block">
        <SearchField pages={pages} onSymbol={onSymbol} onPage={onPage} />
    </div>
      <button type="button" className="grid h-9 w-9 shrink-0 place-items-center rounded-input text-muted hover:bg-elevated hover:text-text md:hidden" aria-label="Search stocks, options and pages" onClick={() => setMobileOpen(true)}>
        <Search className="h-[1.125rem] w-[1.125rem]" aria-hidden />
      </button>
      {mobileOpen ? (
        <div className="fixed inset-0 z-[80] md:hidden">
          <button type="button" tabIndex={-1} aria-label="Close search" className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={() => setMobileOpen(false)} />
          <div className="anim-rise relative flex items-start gap-2 border-b border-border bg-panel p-2">
            <div className="relative min-w-0 flex-1">
              <SearchField pages={pages} onSymbol={onSymbol} onPage={onPage} autoFocus onDone={() => setMobileOpen(false)} />
            </div>
            <button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded-input text-muted hover:bg-elevated hover:text-text" aria-label="Close search" onClick={() => setMobileOpen(false)}>
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function SearchField({ pages, onSymbol, onPage, autoFocus, onDone }: { pages: SearchPage[]; onSymbol: (symbol: string) => void; onPage: (href: string) => void; autoFocus?: boolean; onDone?: () => void }) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(Boolean(autoFocus));
  const [recent, setRecent] = useState<string[]>([]);
  const [result, setResult] = useState<{ q: string; hits: Instrument[]; failed: boolean }>({ q: "", hits: [], failed: false });
  const [selected, setSelected] = useState(0);
  const q = query.trim();
  const settled = Boolean(q) && result.q === q;
  const hits = useMemo(() => (settled ? result.hits : []), [settled, result.hits]);
  const loading = Boolean(q) && !settled;

  useEffect(() => {
    if (!q) return;
    const handle = window.setTimeout(() => {
      api<Instrument[]>(`/api/instruments?q=${encodeURIComponent(q)}`)
        .then((rows) => setResult({ q, hits: rows.slice(0, 8), failed: false }))
        .catch(() => setResult({ q, hits: [], failed: true }));
    }, 160);
    return () => window.clearTimeout(handle);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const needle = q.toLowerCase();
    const symbols: Entry[] = q
      ? hits.map((hit) => ({ id: `sym-${hit.symbol}`, group: "Symbols", label: hit.symbol, hint: `${hit.name}${hit.sector === "INDEX" ? " · Index" : ` · ${hit.exchange}`}`, icon: CandlestickChart, run: () => onSymbol(hit.symbol) }))
      : recent.map((symbol) => ({ id: `recent-${symbol}`, group: "Symbols", label: symbol, hint: "Recently viewed", icon: History, run: () => onSymbol(symbol) }));
    const matched: Entry[] = pages
      .filter((page) => !needle || page.label.toLowerCase().includes(needle) || page.href.toLowerCase().includes(needle))
      .map((page) => ({ id: `page-${page.href}`, group: "Pages", label: page.label, hint: page.href === "/" ? "Dashboard" : undefined, icon: page.icon, run: () => onPage(page.href) }));
    return [...symbols, ...matched];
  }, [hits, onPage, onSymbol, pages, q, recent]);

  const active = Math.max(0, Math.min(selected, entries.length - 1));

  const pick = (entry: Entry | undefined) => {
    if (!entry) return;
    entry.run();
    setQuery("");
    setOpen(false);
    input.current?.blur();
    onDone?.();
  };

  const show = () => {
    setRecent(readRecent());
    setOpen(true);
  };

  const groups = (["Symbols", "Pages"] as const).map((group) => ({ group, rows: entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.group === group) }));

  return (
    <div ref={root} className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        ref={input}
        autoFocus={autoFocus}
        type="text"
        enterKeyHint="search"
        role="combobox"
        aria-label="Search stocks, options and pages"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && entries[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={PLACEHOLDER}
        value={query}
        onFocus={show}
        onClick={show}
        onChange={(event) => { setQuery(event.target.value); setSelected(0); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); if (query) setQuery(""); else { setOpen(false); onDone?.(); } }
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setSelected(Math.min(entries.length - 1, active + 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setSelected(Math.max(0, active - 1)); }
          if (event.key === "Enter" && open) { event.preventDefault(); pick(entries[active]); }
        }}
        className="top-search"
      />
      {open ? (
        <div id={listId} role="listbox" aria-label="Search results" className="surface-overlay anim-rise absolute left-0 right-0 top-[calc(100%+0.375rem)] z-50 max-h-[min(27.5rem,70vh)] overflow-y-auto rounded-card p-1.5 md:min-w-[21.25rem]">
          {groups.map(({ group, rows }) => {
            if (group === "Symbols" && q && rows.length === 0) {
              return loading ? <p key={group} className="px-3 py-2.5 text-data text-muted">Searching symbols…</p> : null;
            }
            if (rows.length === 0) return null;
            return (
              <div key={group} role="group" aria-label={group}>
                <p className="px-2.5 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">{group === "Symbols" && !q ? "Recent symbols" : group}</p>
                {rows.map(({ entry, index }) => {
                  const Icon = entry.icon;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={index === active}
                      onPointerMove={() => setSelected(index)}
                      onClick={() => pick(entry)}
                      className={cx("flex min-h-10 w-full items-center gap-3 rounded-input px-2.5 py-2 text-left", index === active ? "bg-primary-soft text-text" : "text-text-2 hover:bg-hover")}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.8125rem] font-medium">{entry.label}</span>
                        {entry.hint ? <span className="block truncate text-data text-muted">{entry.hint}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {q && !loading && entries.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <p className="text-[0.8125rem] font-medium text-text">No results</p>
              <p className="mt-0.5 text-data text-muted">{result.failed ? "Symbol search is unavailable right now. Try again shortly." : `Nothing matches “${q}”. Try a symbol like NIFTY or RELIANCE.`}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
