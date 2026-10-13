"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { api, freshness, istTime, money, moveOf, tone, type Quote } from "@/components/api";
import { useDesk } from "@/components/shell";
import { PredictionChart } from "@/components/prediction-chart";
import { IconButton } from "@/components/icon-button";
import { StockLogo, StockSearchField } from "@/components/stock-identity";
import { HORIZONS, horizonLabel, type ForecastResult, type HorizonId } from "@/lib/market/forecast";
import { SPAN_LABEL, type ChartSpan } from "@/lib/market/spans";
import type { Candle } from "@/components/chart-panel";

const HISTORY_KEY = "td-forecast-history";
const NO_POINTS: ForecastResult["points"] = [];
const TIMEFRAMES: ChartSpan[] = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1mo"];
const HISTORY_LABEL: Record<string, string> = {
  "1m": "1 minute",
  "3m": "3 minutes",
  "5m": "5 minutes",
  "15m": "15 minutes",
  "30m": "30 minutes",
  "1h": "1 hour",
  "4h": "4 hours",
  "1d": "1 day",
  "1w": "1 week",
  "1mo": "1 month",
};
const USES = [
  { id: "trading", label: "Trading", timeframe: "15m" as ChartSpan, horizon: "session" as HorizonId },
  { id: "long", label: "Long-term", timeframe: "1d" as ChartSpan, horizon: "1mo" as HorizonId },
] as const;

type SearchHit = { symbol: string; name: string; exchange: string };

type HistoryRow = {
  id: string;
  symbol: string;
  timeframe: ChartSpan;
  horizon: HorizonId;
  createdAt: string;
  reference: number;
  endpoint: number;
  endpointTime: number;
  model: string;
};

const STATUS_LABEL: Record<string, string> = {
  idle: "Not Generated",
  loading: "Generating",
  ready: "Prediction Ready",
  insufficient: "Insufficient Data",
  unavailable: "Prediction Unavailable",
  failed: "Prediction generation failed",
};

function loadHistory(): HistoryRow[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]") as HistoryRow[];
    return Array.isArray(parsed) ? parsed.slice(0, 30) : [];
  } catch {
    return [];
  }
}

export function PredictionDesk() {
  const desk = useDesk();
  const symbol = desk.symbol;
  const [timeframe, setTimeframe] = useState<ChartSpan>("1d");
  const [horizon, setHorizon] = useState<HorizonId>("5d");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [name, setName] = useState("");
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [status, setStatus] = useState<string>("idle");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [full, setFull] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [viewToken, setViewToken] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [lists, setLists] = useState<Array<{ id: string; items: Array<{ symbol: string; name: string; exchange: string }> }>>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const bookKey = useRef("");

  useEffect(() => {
    setHistory(loadHistory());
    api<{ lists: Array<{ id: string; items: Array<{ symbol: string; name: string; exchange: string }> }> }>("/api/watchlists").then((data) => setLists(data.lists)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let stop = false;
    const handle = window.setTimeout(() => {
      api<SearchHit[]>(`/api/instruments?q=${encodeURIComponent(query)}`).then((rows) => { if (!stop) setHits(rows); }).catch(() => { if (!stop) setHits([]); }).finally(() => { if (!stop) setSearching(false); });
    }, 160);
    return () => { stop = true; window.clearTimeout(handle); };
  }, [query]);

  useEffect(() => {
    let stop = false;
    api<Quote>(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`).then((row) => { if (!stop) setQuote(row); }).catch(() => { if (!stop) setQuote(null); });
    api<Array<{ symbol: string; name: string }>>(`/api/instruments?q=${encodeURIComponent(symbol)}`).then((rows) => {
      if (!stop) setName(rows.find((row) => row.symbol === symbol)?.name ?? symbol);
    }).catch(() => { if (!stop) setName(symbol); });
    return () => { stop = true; };
  }, [symbol]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => setNonce((value) => value + 1), 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);

  useEffect(() => {
    const id = ++requestId.current;
    const nextKey = `${symbol}|${timeframe}`;
    if (bookKey.current !== nextKey) {
      bookKey.current = "";
      setCandles([]);
    }
    setForecast(null);
    setStatus(symbol ? "loading" : "idle");
    setError(symbol ? "" : "Select a stock before generating a prediction.");
    if (!symbol) return;
    const timer = window.setTimeout(() => {
      api<ForecastResult & { candles?: Candle[] }>(`/api/market/forecast?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&horizon=${horizon}`)
        .then((result) => {
          if (id !== requestId.current || result.symbol !== symbol || result.timeframe !== timeframe || result.horizon !== horizon) return;
          bookKey.current = nextKey;
          setForecast(result);
          setCandles(result.candles ?? []);
          setStatus(result.status === "ready" ? "ready" : result.status);
          setError(result.status === "ready" ? "" : result.message);
          if (result.status === "ready" && result.endpoint != null && result.referencePrice != null && result.endTime != null) {
            const row: HistoryRow = {
              id: `${symbol}-${result.generatedAt}`,
              symbol,
              timeframe,
              horizon,
              createdAt: result.generatedAt,
              reference: result.referencePrice,
              endpoint: result.endpoint,
              endpointTime: result.endTime,
              model: `${result.model} ${result.modelVersion}`,
            };
            setHistory((current) => {
              const next = [row, ...current.filter((item) => item.id !== row.id)].slice(0, 30);
              localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
              return next;
            });
          }
        })
        .catch((caught: unknown) => {
          if (id !== requestId.current) return;
          bookKey.current = "";
          setForecast(null);
          setCandles([]);
          setStatus("failed");
          setError(caught instanceof Error ? caught.message : "Prediction generation failed.");
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [symbol, timeframe, horizon, nonce]);

  const move = moveOf(quote?.last, quote?.previousClose);
  const endLabel = forecast?.endTime ? istTime(new Date(forecast.endTime * 1000).toISOString()) : "—";
  const stale = Boolean(forecast?.stale);
  const activeUse = USES.find((item) => item.timeframe === timeframe && item.horizon === horizon)?.id ?? "";

  function selectSymbol(hit: SearchHit) {
    setQuery("");
    setHits([]);
    setName(hit.name);
    desk.chooseSymbol(hit.symbol);
  }

  function toggleWatch(hit: SearchHit) {
    const list = lists[0];
    if (!list) {
      desk.toast("No watchlist is available for this account.");
      return;
    }
    const active = list.items.some((row) => row.symbol === hit.symbol);
    void api("/api/watchlists", { action: active ? "remove" : "add", id: list.id, symbol: hit.symbol }).then(() => {
      setLists((current) => current.map((item) => item.id === list.id
        ? { ...item, items: active ? item.items.filter((row) => row.symbol !== hit.symbol) : [...item.items, hit] }
        : item));
    }).catch((caught: unknown) => desk.toast(caught instanceof Error ? caught.message : "Watchlist update failed."));
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="relative z-30 shrink-0 border-b border-border bg-panel">
        <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        <StockLogo symbol={symbol} name={name} size={36} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-sm font-semibold">Prediction Chart</h1>
            <span className="text-sm font-semibold">{symbol}</span>
            <span className="text-[11px] text-muted">{name} · NSE</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${status === "ready" ? "bg-demo/15 text-demo" : status === "loading" ? "bg-warning/15 text-warning" : "bg-elevated text-muted"}`}>{STATUS_LABEL[status] ?? status}</span>
            {stale && status === "ready" ? <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">Stale Data</span> : null}
          </div>
          <p className="whitespace-nowrap text-xs">
            <span className="num">{quote ? money(quote.last) : "—"}</span>
            {move ? <span className={`num ml-2 ${tone(move.abs)}`}>{move.abs >= 0 ? "+" : ""}{move.abs.toFixed(2)} ({move.pct.toFixed(2)}%)</span> : null}
            <span className="ml-2 text-muted">{quote ? `${freshness(quote, desk.online)} · ${istTime(quote.asOf)}` : ""}</span>
          </p>
        </div>
          <div className="min-w-[220px] flex-1">
            <StockSearchField
              id="td-prediction-search"
              query={query}
              onQuery={setQuery}
              hits={query.trim() ? hits : []}
              status={!query.trim() ? "idle" : searching ? "loading" : hits.length === 0 ? "empty" : "ready"}
              watched={(next) => lists.some((list) => list.items.some((row) => row.symbol === next))}
              onSelect={selectSymbol}
              onToggleWatch={toggleWatch}
              placeholder="Search a stock to predict"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          {USES.map((item) => (
            <button key={item.id} type="button" className={`rounded-full px-3 py-1 text-xs font-semibold ${activeUse === item.id ? "bg-primary/10 text-primary" : "border border-border text-muted"}`} onClick={() => { setTimeframe(item.timeframe); setHorizon(item.horizon); }}>{item.label}</button>
          ))}
          <label className="text-[11px] text-muted">Candle size
            <select className="ml-1 py-1 text-xs" aria-label="Historical timeframe" value={timeframe} onChange={(event) => setTimeframe(event.target.value as ChartSpan)}>
              {TIMEFRAMES.map((span) => <option key={span} value={span}>{HISTORY_LABEL[span]}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-muted">How far ahead
            <select className="ml-1 py-1 text-xs" aria-label="Forecast horizon" value={horizon} onChange={(event) => setHorizon(event.target.value as HorizonId)}>
              {HORIZONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-[11px] text-muted">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            Refresh every 15 minutes
          </label>
          <button type="button" className="rounded-full bg-[#f23645] px-3 py-1 text-xs font-semibold text-white" onClick={() => setNonce((value) => value + 1)}>Generate Prediction</button>
          <IconButton label="Refresh prediction" onClick={() => setNonce((value) => value + 1)}><RefreshCw className="h-4 w-4" aria-hidden /></IconButton>
          <IconButton label="Reset chart view" onClick={() => setViewToken((value) => value + 1)}><RotateCcw className="h-4 w-4" aria-hidden /></IconButton>
          <button type="button" className="rounded-full border border-border px-3 py-1 text-xs" onClick={() => {
            const node = rootRef.current;
            if (!node) return;
            if (document.fullscreenElement) { void document.exitFullscreen(); setFull(false); }
            else { void node.requestFullscreen(); setFull(true); }
          }}>{full ? "Exit full screen" : "Full screen"}</button>
          <p className="w-full text-[11px] text-muted">{settingNote(timeframe, horizon)}</p>
        </div>
      </header>
      {error ? <p className="border-b border-border bg-panel px-3 py-2 text-xs text-loss">{error} <button className="ml-2 text-primary" onClick={() => setNonce((value) => value + 1)}>Retry</button></p> : null}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 flex-wrap gap-3 border-b border-border px-3 py-1 text-[11px] text-muted">
            <span className="text-text">Historical candles</span>
            {quote?.marketOpen ? <span className="text-warning">Open candle</span> : null}
            <span className="text-[#FACC15]">Forecast bull</span>
            <span className="text-[#E879F9]">Forecast bear</span>
            <span>Forecast end {endLabel}</span>
          </div>
          <div className="relative min-h-0 w-full flex-1 overflow-hidden">
            {status === "loading" && !candles.length ? <p className="p-4 text-sm text-muted">Generating…</p> : null}
            {candles.length ? <PredictionChart candles={candles} points={forecast?.status === "ready" ? forecast.points : NO_POINTS} scheme={desk.theme} viewToken={viewToken} marketOpen={Boolean(quote?.marketOpen)} fitKey={`${symbol}|${timeframe}|${horizon}`} /> : null}
            {!candles.length && status !== "loading" ? <p className="p-4 text-sm text-muted">{symbol ? "Select Generate Prediction after a stock is chosen." : "Select a stock before generating a prediction."}</p> : null}
          </div>
          <p className="shrink-0 border-t border-border px-3 py-1 text-[11px] text-muted">{forecast?.message || "A forecast is an estimate from past closes. It does not place an order."}</p>
        </div>
        <aside className="flex max-h-80 shrink-0 flex-col gap-3 overflow-auto border-t border-border bg-panel p-3 text-xs lg:max-h-none lg:w-80 lg:border-l lg:border-t-0">
          <section>
            <h2 className="text-sm font-semibold">How to use</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted">
              <li>Search a stock. The star adds it to your watchlist.</li>
              <li><span className="text-text">Trading</span> uses 15-minute candles and estimates the rest of this session. For a quicker view, set how far ahead to 15 minutes, 30 minutes, or 1 hour.</li>
              <li><span className="text-text">Long-term</span> uses daily candles and estimates the next month. Weekly or monthly candles give a slower view of the same horizon.</li>
              <li>Candle size is the history the model reads. How far ahead is only the future length. A forecast shorter than one candle is not drawn.</li>
              <li>Yellow candles are the bull estimate. Pink candles are the bear estimate. The endpoint is an estimate. This page does not place an order.</li>
            </ol>
          </section>
          <section>
            <h2 className="text-sm font-semibold">Estimate</h2>
            <p className="mt-1 text-muted">The endpoint is a model estimate, not a guaranteed future price.</p>
            <dl className="mt-2 space-y-1">
              <Row label="Reference close" value={forecast?.referencePrice != null ? money(forecast.referencePrice) : "—"} />
              <Row label="Forecast endpoint" value={forecast?.endpoint != null ? money(forecast.endpoint) : "—"} />
              <Row label="Estimated change" value={forecast?.change != null && forecast.changePct != null ? `${forecast.change >= 0 ? "+" : ""}${forecast.change.toFixed(2)} (${forecast.changePct.toFixed(2)}%)` : "—"} />
              <Row label="Horizon" value={horizonLabel(horizon)} />
              <Row label="Model" value={forecast ? "Holt linear smoothing v1" : "—"} />
              <Row label="Scenario" value={forecast?.directionLabel ?? "—"} />
              <Row label="Endpoint band" value={forecast?.bands ? bandLabel(forecast) : "—"} />
              <Row label="Data" value={forecast?.dataMode || "—"} />
              <Row label="Generated" value={forecast?.generatedAt ? istTime(forecast.generatedAt) : "—"} />
            </dl>
            {forecast?.warnings.length ? <ul className="mt-2 list-disc pl-4 text-muted">{forecast.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
          </section>
          <section>
            <h2 className="text-sm font-semibold">Walk-forward check</h2>
            <p className="mt-1 text-muted">{forecast?.validation.label ?? "Accuracy not yet established"}</p>
            <dl className="mt-2 space-y-1">
              <Row label="Holdout bars" value={forecast ? String(forecast.validation.holdout) : "—"} />
              <Row label="MAE" value={forecast?.validation.mae != null ? forecast.validation.mae.toFixed(2) : "—"} />
              <Row label="RMSE" value={forecast?.validation.rmse != null ? forecast.validation.rmse.toFixed(2) : "—"} />
              <Row label="Direction match" value={forecast?.validation.directional != null ? `${forecast.validation.directional.toFixed(1)}% of evaluated steps` : "—"} />
            </dl>
          </section>
          <section>
            <h2 className="text-sm font-semibold">Prediction history</h2>
            <p className="mt-1 text-muted">Saved in this browser. An actual error is shown only after the horizon time is inside the loaded candles.</p>
            <ul className="mt-2 space-y-2">
              {history.length === 0 ? <li className="text-muted">No forecast has been saved in this browser yet.</li> : history.map((row) => {
                const comparable = row.symbol === symbol && row.timeframe === timeframe;
                const actual = comparable ? candles.find((candle) => candle.time >= row.endpointTime) : undefined;
                const scored = Boolean(actual) && Date.now() / 1000 >= row.endpointTime;
                const errorValue = scored && actual ? actual.close - row.endpoint : null;
                return (
                  <li key={row.id} className="border-b border-border pb-2">
                    <p className="font-medium">{row.symbol} · {SPAN_LABEL[row.timeframe]} · {horizonLabel(row.horizon)}</p>
                    <p className="text-muted">{istTime(row.createdAt)} · {row.model}</p>
                    <p>Estimate {money(row.endpoint)} from {money(row.reference)}</p>
                    <p className="text-muted">{errorValue == null || !actual ? "Waiting for the horizon to finish." : `Observed close ${money(actual.close)} · error ${errorValue >= 0 ? "+" : ""}${errorValue.toFixed(2)}`}</p>
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function settingNote(timeframe: ChartSpan, horizon: HorizonId) {
  if (timeframe === "15m" && horizon === "session") return "Trading: the model reads 15-minute candles and estimates the rest of this session.";
  if (timeframe === "1d" && horizon === "1mo") return "Long-term: the model reads daily candles and estimates the next month.";
  return `Custom: the model reads ${HISTORY_LABEL[timeframe] ?? timeframe} candles and estimates ${horizonLabel(horizon).replace(/^Next /i, "the next ")}.`;
}

function bandLabel(forecast: ForecastResult) {
  const last = forecast.points[forecast.points.length - 1];
  if (!last || last.lower == null || last.upper == null) return "—";
  return `${money(last.lower)} – ${money(last.upper)}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-muted">{label}</dt><dd className="num text-right">{value}</dd></div>;
}
