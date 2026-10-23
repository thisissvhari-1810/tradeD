"use client";

import { useHydrated } from "@/components/use-hydrated";
import { mayPractice } from "@/lib/auth/permissions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChartPanel, DEFAULT_INDICATORS, type Candle, type ChartHandle, type ChartReference, type ChartType, type Drawing, type DrawTool, type IndicatorSettings } from "@/components/chart-panel";
import { ChartHeaderTools } from "@/components/chart-header-tools";
import { ChartToolbar, FavouritesBar, type RemoveScope, type VisibilityAction } from "@/components/chart-toolbar";
import { useDrawingPrefs } from "@/components/drawing-prefs";
import { DrawingList } from "@/components/drawing-editor";
import { loadDrawings, saveDrawings } from "@/components/drawing-model";
import { STRATEGY_PREFIX, strategyView } from "@/components/strategy-overlay";
import { StrategyPanel } from "@/components/strategy-panel";
import { STRATEGY_DEFAULTS, loadStrategySettings, saveStrategySettings, type StrategySettings } from "@/components/strategy-settings";
import type { S1Data } from "@/lib/trading/s1";
import { IconButton } from "@/components/icon-button";
import { OptionChainPanel, type OptionChartRequest } from "@/components/option-chain-panel";
import { OptionBook, type BookPosition, type BookTrade } from "@/components/option-book";
import { newReplaySession, REPLAY_SESSION_PATTERN } from "@/lib/options/replay-premium";
import { draftKey, OptionOrderTicket, type OptionOrderDraft } from "@/components/option-order-ticket";
import { cx, EmptyState, Table, type Column } from "@/components/ui";
import { parseOptionLedgerSymbol } from "@/lib/options/contract";
import { type LedgerSnapshot } from "@/components/paper-panel";
import { findIndex } from "@/lib/market/indices";
import { ReplayBar } from "@/components/replay-bar";
import { OrderStatus, StockLogo, StockSearchField, SymbolTitle, WatchStar } from "@/components/stock-identity";
import { api, istTime, money, moveOf, tone, type Quote } from "@/components/api";
import { useDesk } from "@/components/shell";
import { feedStatusLabel, useMarketStream } from "@/components/market-stream";
import { kolkataParts } from "@/lib/market/clock";
import { applyLiveTick, CHART_SPANS, mergeLiveHistory, SPAN_LABEL, type ChartSpan } from "@/lib/market/spans";
import {
  buyingPower,
  cancelDemoOrder,
  demoUnrealized,
  emptyDemoBook,
  formatDemoRupees,
  formatIst,
  loadDemoBook,
  settleDemoOrders,
  type DemoBook,
} from "@/lib/trading/demo-replay";
import {
  advanceCursor,
  completedMinutes,
  isReplaySpeed,
  normalizeTape,
  previousWeekday,
  projectReplay,
  REPLAY_STATUS_LABEL,
  simulatedBar,
  stepCursor,
  type PreviousSession,
  type ReplaySpeed,
  type ReplayStatus,
} from "@/lib/trading/replay-engine";
import { formatPnl, formatSignedBps, rupeesToPaise } from "@/lib/money";
import { fromSummaryWire, newlyClosed, type ReplaySessionSummary, type ReplaySummaryWire } from "@/lib/trading/replay-summary";
import { replayChipLabel } from "@/lib/trading/position-view";
import { ReplaySummaryDialog } from "@/components/replay-summary-dialog";
import { PanelRightClose, PanelRightOpen, Star } from "lucide-react";

type Hit = { symbol: string; name: string; exchange: string };
type PracticePosition = {
  symbol: string;
  name: string;
  quantity: number;
  lotSize?: number | null;
  lots?: number | null;
  contract?: { underlying: string; expiry: string; strike: number; right: "CE" | "PE" } | null;
  averageCost: string;
  mark: string | null;
  marketValue: string | null;
  unrealized: string | null;
  realized: string;
  mode?: string;
  asOf?: string | null;
  status?: string;
  openedAt?: string | null;
  updatedAt?: string | null;
  replaySession?: string | null;
};
type ReplayMarkRow = { symbol: string; cursor: number; mark: string | null; marketValue: string | null; unrealized: string | null; asOf: string | null; stale: boolean; beforeEntry: boolean; openedAt: string | null; message: string };

/** The timeframe bar: one row of fixed ranges, no overflow menu. */
const PRIMARY_SPANS = new Set<ChartSpan>(["1m", "5m", "15m", "1h", "1d", "1w", "1y", "5y"]);

function optionSessionKey(email: string) {
  return `td-option-replay-sessions:${email}`;
}
function readOptionSessions(email: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(optionSessionKey(email)) || "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && REPLAY_SESSION_PATTERN.test(entry[1]) && entry[1].startsWith(`${entry[0]}.`)));
  } catch {
    return {};
  }
}
function signedRupees(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
type PracticeBook = {
  orders: Array<{ id: string; symbol: string; side: string; type: string; quantity: number; filledQuantity: number; status: string; avgFill: string | null; reason: string | null; submittedAt: string; filledAt?: string | null }>;
  executions: Array<{ id: string; symbol: string; side: string; quantity: number; price: string; charges: string; realized: string; mode: string; executedAt: string }>;
};
type Flags = { sma: boolean; ema: boolean; bands: boolean; vwap: boolean; volume: boolean; supertrend: boolean; oscillator: "none" | "rsi" | "macd" };
type Replay = {
  active: boolean;
  date: string;
  cursor: number | null;
  speed: ReplaySpeed;
  status: ReplayStatus;
  message: string;
  sessionOpen: number | null;
  sessionClose: number | null;
};

type ReplayPayload = {
  tape: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
  prior: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
  context?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
  previous?: PreviousSession | null;
  sessionOpen: number | null;
  sessionClose: number | null;
  message: string;
  unavailable: string | null;
};
function PreviousSessionStrip({ session }: { session: PreviousSession | null }) {
  if (!session) {
    return <p className="border-b border-border bg-panel px-3 py-1 text-[11px] text-warning">Previous session open and close were not returned.</p>;
  }
  return (
    <div className="no-scrollbar flex h-6 shrink-0 items-center gap-x-3 overflow-x-auto whitespace-nowrap border-b border-border bg-panel px-3 text-micro text-muted">
      <span className="font-semibold text-info">Prev session {session.date}</span>
      <span>Open <span className="num text-text">{session.open.toFixed(2)}</span></span>
      <span>Close <span className="num text-text">{session.close.toFixed(2)}</span></span>
      <span>High {session.high.toFixed(2)}</span>
      <span>Low {session.low.toFixed(2)}</span>
    </div>
  );
}

function bookStorageKey(email: string) {
  return email ? `td-replay-book:${email}` : "td-replay-book";
}

const EMPTY_FLAGS: Flags = { sma: false, ema: false, bands: false, vwap: false, volume: false, supertrend: false, oscillator: "none" };
const LABEL_TOOLS = new Set<DrawTool>(["text", "note", "price", "callout", "marker"]);

const NO_OVERLAY: never[] = [];

const NO_DRAWINGS: Drawing[] = [];

/** The candle series a request belongs to: a stock and timeframe, or an option contract and timeframe. */
function seriesKeyOf(symbol: string, timeframe: ChartSpan, contract: OptionChartRequest | null) {
  return contract ? `opt:${contract.securityId}:${contract.underlying}:${contract.expiry}:${contract.strike}:${contract.right}:${timeframe}` : `${symbol}:${timeframe}`;
}

/** A localStorage value, or null when storage is unavailable. */
function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The saved replay session (date, speed, whether it was running), cleaned; null when none. */
function readReplaySession(): Partial<Replay> & { active: boolean } | null {
  const raw = readStorage("td-replay-session");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Replay> & { day?: string; speed?: number };
    const speed = typeof parsed.speed === "number" && isReplaySpeed(parsed.speed) ? parsed.speed : 1;
    const date = typeof parsed.date === "string" ? parsed.date : typeof parsed.day === "string" ? parsed.day : "";
    const active = Boolean(parsed.active);
    return { active, date, cursor: null, speed, status: active ? "loading" : "idle", message: "", sessionOpen: null, sessionClose: null };
  } catch {
    return null;
  }
}

export function ChartDesk({ variant }: { variant: "chart" | "positions" }) {
  const desk = useDesk();
  const notify = desk.toast;
  const params = useSearchParams();
  const rootRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ChartHandle | null>(null);
  const requestId = useRef(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [skip, setSkip] = useState(0);
  const [timeframe, setTimeframe] = useState<ChartSpan>("1d");
  const [chartType, setChartType] = useState<ChartType>("candle");
  const [flags, setFlags] = useState<Flags>(EMPTY_FLAGS);
  const [indicators] = useState<IndicatorSettings>(DEFAULT_INDICATORS);
  const [tool, setTool] = useState<DrawTool>("cursor");
  // Drawings of the charted stock / option contract (keyed by drawingStore, set below).
  const [drawingState, setDrawingState] = useState<{ key: string | null; list: Drawing[] }>({ key: null, list: [] });
  const drawPrefs = useDrawingPrefs();
  const [drawingsHidden, setDrawingsHidden] = useState(false);
  const [indicatorsHidden, setIndicatorsHidden] = useState(false);
  const [lockAll, setLockAll] = useState(false);
  const [objectsOpen, setObjectsOpen] = useState(false);
  const [selectedDrawing, setSelectedDrawing] = useState<string | null>(null);
  const [annotation, setAnnotation] = useState("");
  const [historyTick, setHistoryTick] = useState(0);
  const drawingsRef = useRef<Drawing[]>([]);
  const pastRef = useRef<Drawing[][]>([]);
  const futureRef = useRef<Drawing[][]>([]);
  const [settings, setSettings] = useState(false);
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [full, setFull] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candleMeta, setCandleMeta] = useState({ mode: "", source: "", message: "" });
  const [chartError, setChartError] = useState("");
  // The request the chart's candles answer (stock or contract | timeframe | refresh count).
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [lists, setLists] = useState<Array<{ id: string; name: string; items: Array<{ symbol: string; name: string; exchange: string }> }>>([]);
  const [sideQuotes, setSideQuotes] = useState<Record<string, Quote>>({});
  const [replay, setReplay] = useState<Replay>({ active: false, date: "", cursor: null, speed: 1, status: "idle", message: "", sessionOpen: null, sessionClose: null });
  // Replay is a demo tool: its controls are hidden in Live mode and it never runs there.
  const live = desk.mode === "live";
  // Standing rule, checked every render: while Live, replay is off. This also catches a replay restored
  // from storage after the page opened in Live mode. Converges in one extra render.
  // Permissions from the Super Admin: replay and demo orders can be switched off per user.
  const canReplay = desk.user?.features?.replay !== false;
  const canPaperTrade = desk.user?.features?.demoTrading !== false && desk.user?.tradingEnabled !== false;
  if ((live || !canReplay) && replay.active) setReplay((current) => (current.active ? { ...current, active: false, status: "idle" } : current));
  const replayRef = useRef(replay);
  const tapeRef = useRef<Candle[]>([]);
  const priorRef = useRef<Candle[]>([]);
  const contextRef = useRef<Candle[]>([]);
  const [prior, setPrior] = useState<{ date: string; session: PreviousSession | null } | null>(null);
  const replayFetch = useRef(0);
  const settledThrough = useRef(0);
  replayRef.current = replay;
  const [book, setBook] = useState<DemoBook>(emptyDemoBook());
  const [chainOpen, setChainOpen] = useState(false);
  const [orderDraft, setOrderDraft] = useState<OptionOrderDraft | null>(null);
  const [ledgerTick, setLedgerTick] = useState(0);
  const [optionSessions, setOptionSessions] = useState<Record<string, string>>({});
  const [replayMarks, setReplayMarks] = useState<Record<string, ReplayMarkRow>>({});
  const [sessionSummary, setSessionSummary] = useState<ReplaySessionSummary | null>(null);
  const announcedTrades = useRef(new Map<string, Set<string>>());
  const [closedHighlight, setClosedHighlight] = useState<string | null>(null);
  const [summaryRequested, setSummaryRequested] = useState(false);
  const [summaryShownFor, setSummaryShownFor] = useState<string | null>(null);
  const closeTicket = useCallback(() => setOrderDraft(null), []);
  // The chart opens on the watchlist; Positions is one click away (and opens itself after a fill).
  const [sideRail, setSideRail] = useState<"watch" | "positions">("watch");
  // The chart opens with the side panel closed (the Watchlist button opens it); the Positions page needs it open.
  const [railCollapsed, setRailCollapsed] = useState(variant !== "positions");
  const [closedTrades, setClosedTrades] = useState<BookTrade[]>([]);
  const refreshPractice = useRef<() => void>(() => undefined);
  const [optionView, setOptionView] = useState<OptionChartRequest | null>(null);
  // Strategy: settings (on / off, styles) are remembered; levels are fetched per symbol and session (live or the replay date).
  const [strategy, setStrategy] = useState<StrategySettings>(STRATEGY_DEFAULTS);
  const [strategyOpen, setStrategyOpen] = useState(false);
  // The Strategy panel opens below its button: the button's left edge within the chart area (px).
  const [strategyLeft, setStrategyLeft] = useState<number | null>(null);
  const strategyButtonRef = useRef<HTMLButtonElement | null>(null);
  const chartAreaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const area = chartAreaRef.current;
    if (!strategyOpen || !area) return;
    const place = () => {
      const button = strategyButtonRef.current;
      if (!button) return;
      const box = area.getBoundingClientRect();
      const width = Math.min(340, box.width - 16);
      const left = button.getBoundingClientRect().left - box.left;
      setStrategyLeft(Math.max(8, Math.min(left, box.width - width - 8)));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(area);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [strategyOpen]);
  /** Chosen sessions for the strategy; empty = automatic (live day or replay date, and the session before it). */
  const [strategyDates, setStrategyDates] = useState({ current: "", previous: "" });
  const [s1, setS1] = useState<{ key: string; data: S1Data | null; error: string } | null>(null);
  // Drawings belong to what is charted: the stock, or the option contract when one is open.
  const drawingStore = optionView ? `${optionView.underlying}|${optionView.expiry}|${optionView.strike}|${optionView.right}` : desk.symbol;
  const saveTimer = useRef<number | null>(null);
  const pendingSave = useRef<{ key: string; drawings: Drawing[] } | null>(null);
  const hydrated = useHydrated();
  if (hydrated && drawingState.key !== drawingStore) setDrawingState({ key: drawingStore, list: loadDrawings(drawingStore) });
  const drawings = drawingState.key === drawingStore ? drawingState.list : NO_DRAWINGS;
  function setDrawings(next: Drawing[]) {
    drawingsRef.current = next;
    setDrawingState({ key: drawingStore, list: next });
  }
  useEffect(() => {
    drawingsRef.current = drawings;
  }, [drawings]);
  // Undo history belongs to one chart: a new stock / contract starts with none.
  useEffect(() => {
    flushDrawings();
    pastRef.current = [];
    futureRef.current = [];
  }, [drawingStore]);
  useEffect(() => () => flushDrawings(), []);
  const optionViewRef = useRef<OptionChartRequest | null>(null);
  optionViewRef.current = optionView;
  const [ledger, setLedger] = useState<(LedgerSnapshot & { realizedToday?: string }) | null>(null);
  const settledMinute = useRef(-1);
  // Paper trading is open to students and the trading-enabled owner (see mayPractice).
  const practises = desk.user ? mayPractice(desk.user) : false;
  const practiseRef = useRef(practises);
  practiseRef.current = practises;
  const [restart, setRestart] = useState(false);
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  const [startRupees, setStartRupees] = useState("1000000");
  const [dock, setDock] = useState<"open" | "closed" | "orders" | "history" | "replay">("open");
  const [dockOpen, setDockOpen] = useState(true);
  const [practice, setPractice] = useState<PracticePosition[] | null>(null);
  const [practiceError, setPracticeError] = useState("");
  const [activity, setActivity] = useState<PracticeBook | null>(null);
  const [exitSymbol, setExitSymbol] = useState<PracticePosition | null>(null);
  const symbol = desk.symbol;
  const timeframeRef = useRef(timeframe);
  const marketOpenRef = useRef(true);
  const lastTradeRef = useRef(0);
  const candleModeRef = useRef("");
  timeframeRef.current = timeframe;
  marketOpenRef.current = quote ? quote.marketOpen : true;
  candleModeRef.current = candleMeta.mode;
  const stream = useMarketStream(symbol, !replay.active && !optionView, (tick) => {
    if (candleModeRef.current === "DEMO") return;
    setCandles((current) => {
      const next = applyLiveTick(current, timeframeRef.current, tick.price, tick.time, marketOpenRef.current, tick.volumeDelta, lastTradeRef.current);
      if (tick.time >= lastTradeRef.current) lastTradeRef.current = tick.time;
      return next;
    });
    setQuote((current) => {
      if (!current || current.symbol !== symbol) return current;
      if (Date.parse(current.asOf) > tick.time * 1000) return current;
      return {
        ...current,
        last: tick.price.toFixed(2),
        asOf: new Date(tick.time * 1000).toISOString(),
        volume: tick.dayVolume != null ? String(Math.round(tick.dayVolume)) : current.volume,
      };
    });
  });

  useEffect(() => {
    lastTradeRef.current = 0;
  }, [symbol]);

  // The symbol from the link goes through the desk (once, at start).
  useEffect(() => {
    const fromUrl = params.get("symbol");
    if (fromUrl) desk.chooseSymbol(fromUrl);
    // The link is read once. Later symbol changes come from the desk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saved strategy settings and replay session are restored once the page has hydrated (during render).
  const [restored, setRestored] = useState(false);
  if (hydrated && !restored) {
    setRestored(true);
    setStrategy(loadStrategySettings());
    const saved = readReplaySession();
    const live = readStorage("td-mode") === "live";
    if (saved) setReplay((current) => ({ ...current, ...saved, active: saved.active && !live }));
    // Home's "Practice replay" links here with ?replay=1. Live view and accounts without the Replay
    // permission never start it (the canReplay guard above switches it off again).
    if (params.get("replay") === "1" && !live) {
      setReplay((current) => ({ ...current, active: true, status: "loading", cursor: null, date: current.date || previousWeekday(new Date()) }));
    }
  }

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem("td-replay-session", JSON.stringify({ active: replay.active, date: replay.date, speed: replay.speed }));
  }, [restored, replay.active, replay.date, replay.speed]);

  // The replay practice book and option sessions belong to the signed-in user.
  const bookUser = desk.user?.email ?? "";
  const [bookOwner, setBookOwner] = useState<string | null>(null);
  if (hydrated && bookOwner !== bookUser) {
    setBookOwner(bookUser);
    setOptionSessions(readOptionSessions(bookUser));
    const saved = readStorage(bookStorageKey(bookUser)) ?? (bookUser ? readStorage("td-replay-book") : null);
    setBook(loadDemoBook(saved));
  }
  useEffect(() => {
    if (bookOwner !== bookUser) return;
    localStorage.setItem(bookStorageKey(bookUser), JSON.stringify(book));
  }, [book, bookOwner, bookUser]);

  useEffect(() => {
    if (replay.active) return;
    let stop = false;
    const load = () => {
      api<Quote>(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`).then((row) => {
        if (stop) return;
        setQuote((current) => {
          if (current && current.symbol === row.symbol && Date.parse(current.asOf) > Date.parse(row.asOf)) {
            return { ...row, last: current.last, asOf: current.asOf, volume: current.volume || row.volume };
          }
          return row;
        });
        setQuoteError("");
      }).catch((error: unknown) => {
        if (stop) return;
        setQuoteError(error instanceof Error ? error.message : "Quote unavailable.");
      });
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [symbol, replay.active]);

  useEffect(() => {
    if (query.trim().length < 1) return;
    const handle = window.setTimeout(() => {
      api<Hit[]>(`/api/instruments?q=${encodeURIComponent(query)}&skip=${skip}`).then(setHits).catch(() => setHits([]));
    }, 160);
    return () => window.clearTimeout(handle);
  }, [query, skip]);

  useEffect(() => {
    api<{ lists: Array<{ id: string; name: string; items: Array<{ symbol: string; name: string; exchange: string }> }> }>("/api/watchlists").then((data) => setLists(data.lists)).catch(() => undefined);
  }, [symbol]);

  useEffect(() => {
    const symbols = [...new Set(lists.flatMap((list) => list.items.map((item) => item.symbol)))].slice(0, 40);
    if (!symbols.length) return;
    const load = () => {
      api<{ quotes: Array<Quote | { symbol: string; error: string }> }>(`/api/market/quotes?symbols=${symbols.join(",")}`)
        .then((data) => {
          const next: Record<string, Quote> = {};
          for (const row of data.quotes) if ("last" in row) next[row.symbol] = row;
          setSideQuotes((current) => ({ ...current, ...next }));
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 8000);
    return () => window.clearInterval(timer);
  }, [lists]);

  const seriesKey = useRef("");
  function candlePath(span: ChartSpan, contract: OptionChartRequest | null) {
    if (!contract) return `/api/market/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${span}`;
    if (contract.securityId) return `/api/options/candles?securityId=${encodeURIComponent(contract.securityId)}&kind=${contract.kind}&timeframe=${span}`;
    const ledger = `${contract.underlying}|${contract.expiry}|${contract.strike}|${contract.right}`;
    return `/api/options/candles?symbol=${encodeURIComponent(ledger)}&timeframe=${span}`;
  }
  const candleRequest = `${seriesKeyOf(symbol, timeframe, optionView)}|${reload}`;
  const loading = loadedFor !== candleRequest;
  useEffect(() => {
    const id = ++requestId.current;
    const contract = optionView;
    const key = seriesKeyOf(symbol, timeframe, contract);
    const request = `${key}|${reload}`;
    const merge = seriesKey.current === key;
    seriesKey.current = key;
    api<{ candles: Candle[]; mode: string; source: string; message: string }>(candlePath(timeframe, contract))
      .then((data) => {
        if (id !== requestId.current) return;
        setCandles((current) => merge ? mergeLiveHistory(current, data.candles) : data.candles);
        setCandleMeta({ mode: data.mode, source: data.source, message: data.message });
        setChartError("");
        setLoadedFor(request);
        setRefreshing(false);
      })
      .catch((error: unknown) => {
        if (id !== requestId.current) return;
        setLoadedFor(request);
        setRefreshing(false);
        if (replayRef.current.active && !optionViewRef.current) return;
        setCandles([]);
        setChartError(error instanceof Error ? error.message : "Chart data unavailable.");
      });
  }, [symbol, timeframe, reload, optionView]);

  useEffect(() => {
    if (replay.active && !optionView) return;
    const timer = window.setInterval(() => {
      const id = requestId.current;
      api<{ candles: Candle[]; mode: string; source: string; message: string }>(candlePath(timeframe, optionView))
        .then((data) => {
          if (id !== requestId.current) return;
          setCandles((current) => mergeLiveHistory(current, data.candles));
          setCandleMeta({ mode: data.mode, source: data.source, message: data.message });
        })
        .catch(() => undefined);
    }, 20000);
    return () => window.clearInterval(timer);
  }, [symbol, timeframe, replay.active, optionView]);

  useEffect(() => {
    if (!practises) return;
    const load = () => {
      api<LedgerSnapshot & { positions: PracticePosition[]; realizedToday?: string }>("/api/portfolio").then((data) => { setLedger(data); setPractice(data.positions); setPracticeError(""); }).catch((error: unknown) => {
        setPracticeError(error instanceof Error ? error.message : "Practice positions unavailable.");
      });
      api<PracticeBook>("/api/orders").then(setActivity).catch(() => undefined);
      api<{ trades: BookTrade[] }>("/api/trades").then((data) => setClosedTrades(data.trades)).catch(() => undefined);
    };
    refreshPractice.current = load;
    load();
    const timer = window.setInterval(load, 20000);
    window.addEventListener("td-ledger", load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("td-ledger", load);
      refreshPractice.current = () => undefined;
    };
  }, [practises]);

  useEffect(() => {
    if (variant !== "positions") return;
    const load = () => {
      api<{ positions: PracticePosition[] }>("/api/portfolio").then((data) => { setPractice(data.positions); setPracticeError(""); }).catch((error: unknown) => {
        setPractice(null);
        setPracticeError(error instanceof Error ? error.message : "Practice positions unavailable.");
      });
      api<PracticeBook>("/api/orders").then(setActivity).catch(() => setActivity(null));

    };
    load();
    const timer = window.setInterval(load, 8000);
    return () => window.clearInterval(timer);
  }, [variant, desk.mode]);

  function rememberDrawings(next: Drawing[], record?: boolean) {
    if (record) {
      pastRef.current = [...pastRef.current, drawingsRef.current].slice(-40);
      futureRef.current = [];
      setHistoryTick((value) => value + 1);
    }
    setDrawings(next);
    persistDrawings(next);
  }

  // Saves are batched: a drag changes the drawing on every pointer move, storage is written once it settles.
  function persistDrawings(next: Drawing[]) {
    const key = drawingStore;
    pendingSave.current = { key, drawings: next };
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushDrawings, 300);
  }

  function flushDrawings() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const pending = pendingSave.current;
    pendingSave.current = null;
    if (pending) saveDrawings(pending.key, pending.drawings);
  }

  function applyVisibility(action: VisibilityAction) {
    setDrawingsHidden(action === "drawings" || action === "all");
    setIndicatorsHidden(action === "indicators" || action === "all");
  }

  function removeObjects(scope: RemoveScope) {
    const lockedCount = drawingsRef.current.filter((drawing) => drawing.locked).length;
    const kept = lockedCount ? ` ${lockedCount} locked drawing${lockedCount === 1 ? "" : "s"} will stay.` : "";
    const message = scope === "drawings"
      ? `Remove all drawings on ${symbol}?${kept}`
      : scope === "indicators"
        ? "Turn off every indicator on this chart?"
        : `Remove all drawings on ${symbol} and turn off every indicator?${kept}`;
    if (scope !== "indicators" && lockAll) {
      desk.toast("Drawings are locked. Unlock all drawings to remove them.");
      if (scope === "drawings") return;
    }
    if (!window.confirm(message)) return;
    if (scope !== "indicators" && !lockAll) rememberDrawings(drawingsRef.current.filter((drawing) => drawing.locked), true);
    if (scope !== "drawings") setFlags((current) => ({ ...current, sma: false, ema: false, bands: false, vwap: false, supertrend: false, oscillator: "none" }));
  }

  function toggleFullScreen() {
    const node = rootRef.current;
    if (!node) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      setFull(false);
    } else {
      void node.requestFullscreen();
      setFull(true);
    }
  }

  function undoDrawings() {
    const previous = pastRef.current.pop();
    if (!previous) return;
    futureRef.current.push(drawingsRef.current);
    setHistoryTick((value) => value + 1);
    setDrawings(previous);
    persistDrawings(previous);
  }

  function redoDrawings() {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current.push(drawingsRef.current);
    setHistoryTick((value) => value + 1);
    setDrawings(next);
    persistDrawings(next);
  }

  // Undo / redo read the latest functions (they save under the current symbol).
  const historyKeys = useRef({ undo: undoDrawings, redo: redoDrawings });
  useEffect(() => {
    historyKeys.current = { undo: undoDrawings, redo: redoDrawings };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) { event.preventDefault(); historyKeys.current.undo(); }
      else if ((key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey)) { event.preventDefault(); historyKeys.current.redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setStrategyOpen(false);
      setOrderDraft(null);
      setSettings(false);
      setRestart(false);
      setExitSymbol(null);
      setSearching(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!replay.active || !replay.date) return;
    const id = ++replayFetch.current;
    const requested = replay.date;
    tapeRef.current = [];
    priorRef.current = [];
    contextRef.current = [];
    const setPriorSession = (session: PreviousSession | null) => setPrior({ date: requested, session });
    api<ReplayPayload>(`/api/market/candles?symbol=${encodeURIComponent(symbol)}&timeframe=1m&date=${encodeURIComponent(requested)}`)
      .then((data) => {
        if (id !== replayFetch.current) return;
        tapeRef.current = normalizeTape(data.tape ?? []);
        priorRef.current = normalizeTape(data.prior ?? []);
        contextRef.current = normalizeTape(data.context ?? []);
        if (data.unavailable || data.sessionOpen == null || data.sessionClose == null) {
          tapeRef.current = [];
          priorRef.current = [];
          contextRef.current = [];
          setPriorSession(null);
          setReplay((current) => current.date === requested ? { ...current, status: "error", cursor: null, sessionOpen: data.sessionOpen, sessionClose: data.sessionClose, message: data.message || "This session is not available." } : current);
          return;
        }
        settledThrough.current = data.sessionOpen;
        setPriorSession(data.previous ?? null);
        setReplay((current) => current.date === requested ? {
          ...current,
          status: "ready",
          cursor: data.sessionOpen,
          sessionOpen: data.sessionOpen,
          sessionClose: data.sessionClose,
          message: data.message,
        } : current);
      })
      .catch((error: unknown) => {
        if (id !== replayFetch.current) return;
        tapeRef.current = [];
        priorRef.current = [];
        contextRef.current = [];
        setPriorSession(null);
        setReplay((current) => current.date === requested ? { ...current, status: "error", cursor: null, message: error instanceof Error ? error.message : "This session could not be loaded." } : current);
      });
  }, [replay.active, replay.date, symbol]);

  useEffect(() => {
    if (replay.status !== "playing") return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - last;
      last = now;
      const current = replayRef.current;
      if (current.cursor == null || current.sessionOpen == null || current.sessionClose == null) return;
      const moved = advanceCursor(current.cursor, current.sessionOpen, current.sessionClose, elapsed, current.speed);
      setBook((bookNow) => settleReplayBook(bookNow, moved.cursor, current.date));
      const minute = Math.floor(moved.cursor / 60);
      if (minute !== settledMinute.current && practiseRef.current) {
        settledMinute.current = minute;
        void api<{ filled: number }>("/api/demo/replay", { action: "settle", symbol, date: current.date, cursor: moved.cursor, timeframe: SPAN_LABEL[timeframeRef.current] })
          .then((data) => (data.filled > 0 ? api<LedgerSnapshot>("/api/portfolio").then(setLedger) : undefined))
          .catch(() => undefined);
      }
      setReplay((state) => state.status === "playing" ? { ...state, cursor: moved.cursor, status: moved.completed ? "completed" : "playing", message: moved.completed ? "Replay completed at the session close." : state.message } : state);
    }, 100);
    return () => window.clearInterval(timer);
  }, [replay.status, symbol]);

  const held = book.positions.find((item) => item.symbol === symbol) ?? null;
  const sessionLevels = useMemo<ChartReference[]>(() => {
    const levels: ChartReference[] = [];
    if (replay.active && held?.stopPaise) levels.push({ price: held.stopPaise / 100, title: "Stop", color: desk.appearance.tokens.loss, style: "dashed" });
    if (replay.active && held?.targetPaise) levels.push({ price: held.targetPaise / 100, title: "Target", color: desk.appearance.tokens.profit, style: "dotted" });
    return levels;
  }, [desk.appearance.tokens.loss, desk.appearance.tokens.profit, held, replay.active]);

  const shown = useMemo(() => {
    if (optionView) return candles;
    if (replay.active) return replay.cursor == null ? [] : projectReplay(tapeRef.current, priorRef.current, timeframe, replay.cursor, replay.date, contextRef.current);
    if (quote?.mode === "DEMO") {
      const last = Number(quote.last);
      return applyLiveTick(candles, timeframe, last, Math.floor(Date.now() / 1000), Boolean(quote.marketOpen));
    }
    return candles;
  }, [candles, optionView, replay.active, replay.cursor, replay.date, quote, timeframe]);

  const playCandle = shown.at(-1) ?? null;
  const previous = shown.length > 1 ? shown[shown.length - 2].close : null;
  const replayMove = playCandle && previous != null ? playCandle.close - previous : null;
  const liveMove = moveOf(quote?.last, quote?.previousClose);
  const watched = lists.some((list) => list.items.some((item) => item.symbol === symbol));
  const rail = lists.find((item) => item.items.some((row) => row.symbol === symbol)) ?? lists[0];
  const practiceRow = practice?.find((row) => row.symbol === symbol) ?? null;
  const replayMark = replay.active && playCandle ? Number(rupeesToPaise(playCandle.close.toFixed(2))) : null;
  const paperPnl = held && replayMark != null ? demoUnrealized(book, { [symbol]: replayMark }) : null;

  // Replay option positions belong to one replay session per date. A session missing from this browser is adopted from the ledger.
  const adoptedSession = replay.active && replay.date ? practice?.find((row) => row.replaySession?.startsWith(`${replay.date}.`))?.replaySession ?? null : null;
  const optionSession = replay.active && replay.date ? optionSessions[replay.date] ?? adoptedSession : null;
  const sessionOpenCount = optionSession ? (practice ?? []).filter((row) => row.replaySession === optionSession).length : 0;
  const markMinute = replay.active && replay.cursor != null ? Math.floor(replay.cursor / 60) : null;

  useEffect(() => {
    const cursor = replayRef.current.cursor;
    if (!optionSession || markMinute == null || cursor == null || !practiseRef.current) return;
    let stop = false;
    api<{ marks: ReplayMarkRow[]; summary: ReplaySummaryWire | null }>("/api/demo/option-replay", { action: "marks", session: optionSession, cursor })
      .then((data) => {
        if (stop) return;
        setReplayMarks(Object.fromEntries(data.marks.map((row) => [row.symbol, row])));
        if (!data.summary) return;
        const summary = fromSummaryWire(data.summary);
        setSessionSummary(summary);
        const seen = announcedTrades.current.get(summary.session);
        if (!seen) {
          announcedTrades.current.set(summary.session, new Set(summary.trades.map((trade) => trade.id)));
          return;
        }
        const fresh = newlyClosed(seen, summary);
        fresh.forEach((trade) => {
          seen.add(trade.id);
          notify(`Trade closed: ${formatPnl(trade.netPaise)} (${formatSignedBps(trade.returnBps)})`, { tone: trade.netPaise > 0n ? "success" : trade.netPaise < 0n ? "warning" : "info" });
        });
        const last = fresh[fresh.length - 1];
        if (last) setClosedHighlight(last.id);
      })
      .catch(() => undefined);
    return () => { stop = true; };
  }, [optionSession, markMinute, sessionOpenCount, ledgerTick, notify]);

  // Live revaluation: open option paper positions follow every trade from the market feed.
  const liveSymbols = useMemo(() => (practice ?? []).filter((row) => row.contract && row.quantity > 0 && !row.replaySession).map((row) => row.symbol).sort().join(","), [practice]);
  const [livePrices, setLivePrices] = useState<{ asOf: string; prices: Record<string, number> } | null>(null);
  useEffect(() => {
    if (replay.active || !practises || !liveSymbols) return;
    let stop = false;
    let busy = false;
    const query = liveSymbols.split(",").map((symbol) => `s=${encodeURIComponent(symbol)}`).join("&");
    const merge = (prices: Record<string, number>, asOf: string) => setLivePrices((current) => ({ asOf, prices: { ...(current?.prices ?? {}), ...prices } }));
    // Primary: every trade from Dhan's WebSocket feed. EventSource reconnects by itself when the server
    // rotates the connection (under 60 seconds on Vercel).
    const source = new EventSource(`/api/market/option-stream?${query}`);
    source.addEventListener("tick", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as { symbol?: string; price?: number; time?: number };
        if (!stop && data.symbol && typeof data.price === "number" && data.price > 0) merge({ [data.symbol]: data.price }, new Date((data.time ?? Date.now() / 1000) * 1000).toISOString());
      } catch { /* ignore a malformed event */ }
    });
    // Backup: a REST snapshot every 10 seconds (Dhan's quote API is limited to about one call per second).
    const snapshot = () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      api<{ asOf: string; prices: Record<string, number> }>(`/api/market/option-ltp?${query}`)
        .then((data) => { if (!stop && Object.keys(data.prices).length) merge(data.prices, data.asOf); })
        .catch(() => undefined)
        .finally(() => { busy = false; });
    };
    snapshot();
    const timer = window.setInterval(snapshot, 10000);
    return () => { stop = true; source.close(); window.clearInterval(timer); };
  }, [liveSymbols, replay.active, practises]);

  const bookRows = useMemo<BookPosition[]>(() => {
    const rows = practice ?? [];
    if (!replay.active) {
      if (!livePrices) return rows;
      return rows.map((row) => {
        const last = livePrices.prices[row.symbol];
        const avg = Number(row.averageCost);
        if (last == null || !row.contract || row.quantity <= 0 || !Number.isFinite(avg)) return row;
        return { ...row, mark: last.toFixed(2), marketValue: (last * row.quantity).toFixed(2), unrealized: ((last - avg) * row.quantity).toFixed(2), asOf: livePrices.asOf, mode: "REALTIME", stale: false };
      });
    }
    const cursor = replay.cursor;
    return rows.filter((row) => row.contract && row.replaySession && row.replaySession === optionSession).map((row) => {
      const beforeEntry = cursor != null && row.openedAt != null && cursor * 1000 < Date.parse(row.openedAt);
      const live = replayMarks[row.symbol];
      // A mark taken later than the replay clock (after seeking back) is never shown.
      const usable = live && cursor != null && Math.floor(live.cursor / 60) <= Math.floor(cursor / 60) ? live : null;
      if (beforeEntry) return { ...row, beforeEntry: true, mark: null, marketValue: null, unrealized: null, note: "Replay time is before this position's entry fill." };
      if (usable) return { ...row, mark: usable.mark, marketValue: usable.marketValue, unrealized: usable.unrealized, asOf: usable.asOf, mode: usable.mark == null ? "UNAVAILABLE" : "HISTORICAL", stale: usable.stale, note: usable.mark == null ? usable.message : "" };
      const serverUsable = row.asOf != null && cursor != null && Date.parse(row.asOf) <= cursor * 1000;
      return serverUsable ? row : { ...row, mark: null, marketValue: null, unrealized: null, mode: "UNAVAILABLE", pending: true, note: "Loading the replay premium…" };
    });
  }, [practice, replay.active, replay.cursor, optionSession, replayMarks, livePrices]);
  const liveTotals = useMemo(() => {
    if (replay.active || !livePrices || !ledger) return null;
    let valueShift = 0;
    let pnlShift = 0;
    for (const row of practice ?? []) {
      const live = bookRows.find((item) => item.symbol === row.symbol);
      if (!live || live === row) continue;
      valueShift += Number(live.marketValue ?? 0) - Number(row.marketValue ?? 0);
      pnlShift += Number(live.unrealized ?? 0) - Number(row.unrealized ?? 0);
    }
    // Ledger totals arrive formatted ("+₹1,234.50"); keep that format for the panel.
    const parse = (text: string) => Number(String(text).replace(/[₹,+\s]/g, "").replace("−", "-"));
    const format = (value: number, signed: boolean) => `${value < 0 ? "-" : signed && value > 0 ? "+" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const holdings = parse(ledger.holdingsValue);
    const unrealized = parse(ledger.unrealized);
    if (!Number.isFinite(holdings) || !Number.isFinite(unrealized)) return null;
    return { holdings: format(holdings + valueShift, false), unrealized: format(unrealized + pnlShift, true) };
  }, [replay.active, livePrices, ledger, practice, bookRows]);
  const currentSummary = replay.active && sessionSummary && sessionSummary.session === optionSession ? sessionSummary : null;
  const summaryHasActivity = Boolean(currentSummary && (currentSummary.trades.length > 0 || currentSummary.openCount > 0 || currentSummary.waitingCount > 0));
  const completionKey = replay.active && replay.status === "completed" && summaryHasActivity ? optionSession : null;
  const summaryOpen = Boolean(currentSummary) && (summaryRequested || (completionKey != null && completionKey !== summaryShownFor));
  const closeSummary = useCallback(() => {
    setSummaryRequested(false);
    if (completionKey) setSummaryShownFor(completionKey);
  }, [completionKey]);

  function leaveReplay() {
    setReplay((current) => ({ ...current, active: false, status: "idle" }));
  }

  function requestExitReplay() {
    if (summaryHasActivity) setSummaryRequested(true);
    else leaveReplay();
  }

  function returnToStart() {
    settledThrough.current = replay.sessionOpen ?? 0;
    if (!sessionOpenCount && replay.date) ensureOptionSession(replay.date, true);
    setReplay((current) => ({ ...current, cursor: current.sessionOpen, status: "ready" }));
  }
  const hiddenBookRows = (practice ?? []).filter((row) => row.contract).length - bookRows.filter((row) => row.contract).length;
  const replayTotals = useMemo(() => {
    if (!replay.active) return null;
    let unrealized = 0;
    let value = 0;
    for (const row of bookRows) {
      if (row.unrealized != null) unrealized += Number(row.unrealized) || 0;
      if (row.marketValue != null) value += Number(row.marketValue) || 0;
    }
    return { unrealized: signedRupees(unrealized), holdings: `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` };
  }, [bookRows, replay.active]);

  function ensureOptionSession(date: string, rotate = false) {
    const existing = rotate ? null : optionSessions[date] ?? (date === replay.date ? adoptedSession : null);
    if (existing) return existing;
    const created = newReplaySession(date);
    const next = { ...optionSessions, [date]: created };
    setOptionSessions(next);
    setReplayMarks({});
    localStorage.setItem(optionSessionKey(desk.user?.email ?? ""), JSON.stringify(next));
    return created;
  }

  function orderFromChain(draft: OptionOrderDraft) {
    if (!draft.replay) return setOrderDraft(draft);
    setOrderDraft({ ...draft, replay: { date: draft.replay.date, session: draft.replay.session || ensureOptionSession(draft.replay.date) } });
  }

  function exitBlock(row: BookPosition) {
    if (!row.replaySession) return replay.active ? "Exit replay to close a live-snapshot position." : null;
    if (!replay.active || row.replaySession !== optionSession) return `Open replay ${row.replaySession.slice(0, 10)} to close this position at its replay price.`;
    if (row.beforeEntry) return "Move the replay past this position's entry time to trade it.";
    return null;
  }

  const ticketDraft = orderDraft && (orderDraft.replay ? replay.active && orderDraft.replay.date === replay.date : !replay.active) ? orderDraft : null;

  function selectSymbol(next: string) {
    setQuery("");
    setHits([]);
    const contract = parseOptionLedgerSymbol(next);
    if (contract) {
      setOptionView({
        securityId: "",
        kind: findIndex(contract.underlying) ? "index" : "equity",
        underlying: contract.underlying,
        name: contract.underlying,
        expiry: contract.expiry,
        strike: contract.strike,
        right: contract.right,
        ltp: null,
      });
      setChainOpen(true);
      return;
    }
    setOptionView(null);
    desk.chooseSymbol(next);
  }

  function toggleSymbol(next: string, name = next, exchange = "NSE") {
    const list = lists[0];
    if (!list) {
      desk.toast("No watchlist is available for this account.");
      return;
    }
    const active = list.items.some((row) => row.symbol === next);
    void api("/api/watchlists", { action: active ? "remove" : "add", id: list.id, symbol: next }).then(() => {
      setLists((current) => current.map((item) => item.id === list.id
        ? { ...item, items: active ? item.items.filter((row) => row.symbol !== next) : [...item.items, { symbol: next, name, exchange }] }
        : item));
    }).catch((error: unknown) => desk.toast(error instanceof Error ? error.message : "Watchlist update failed."));
  }

  function toggleWatch() {
    const named = rail?.items.find((item) => item.symbol === symbol);
    toggleSymbol(symbol, named?.name ?? symbol, named?.exchange ?? "NSE");
  }

  function settleReplayBook(currentBook: DemoBook, cursor: number, date: string): DemoBook {
    const freshly = completedMinutes(tapeRef.current, cursor).filter((bar) => bar.time + 60 > settledThrough.current && bar.time + 60 <= cursor);
    let next = currentBook;
    for (const bar of freshly) next = settleDemoOrders(next, symbol, bar, bar.time + 60, bar.time + 60, date);
    if (freshly.length) settledThrough.current = cursor;
    const forming = simulatedBar(tapeRef.current, cursor);
    if (forming && cursor < forming.time + 60) next = settleDemoOrders(next, symbol, forming, cursor, cursor, date);
    return next === currentBook ? currentBook : next;
  }

  function openExit(row: BookPosition) {
    const contract = row.contract;
    if (!contract) return;
    setOrderDraft({
      underlying: contract.underlying,
      name: row.name,
      expiry: contract.expiry,
      strike: contract.strike,
      right: contract.right,
      action: "SELL",
      ltp: row.replaySession || row.mark == null ? null : Number(row.mark),
      asOf: row.replaySession ? null : row.asOf ?? null,
      lotSize: row.lotSize ?? null,
      heldLots: row.lots ?? null,
      avgCost: Number.isFinite(Number(row.averageCost)) ? Number(row.averageCost) : null,
      replay: row.replaySession ? { session: row.replaySession, date: row.replaySession.slice(0, 10) } : null,
    });
  }

  const priceLabel = optionView && playCandle ? money(playCandle.close) : replay.active && playCandle ? money(playCandle.close) : quote ? money(quote.last) : "—";
  const changeLabel = optionView || replay.active
    ? replayMove == null ? "" : `${replayMove >= 0 ? "+" : ""}${replayMove.toFixed(2)}`
    : liveMove ? `${liveMove.abs >= 0 ? "+" : ""}${liveMove.abs.toFixed(2)} (${liveMove.pct.toFixed(2)}%)` : "";
  const changeTone = optionView || replay.active ? tone(replayMove) : tone(liveMove?.abs);
  const marketClosed = !replay.active && quote != null && !quote.marketOpen && quote.mode !== "DEMO";
  const feedLabel = optionView ? "Contract history" : replay.active ? "Simulated" : marketClosed ? "Market closed" : feedStatusLabel(stream.status);
  const feedStamp = stream.updatedAt ? istTime(new Date(stream.updatedAt * 1000).toISOString()) : quote ? istTime(quote.asOf) : "";
  const stamp = optionView
    ? ["Contract history", optionView.expiry, candleMeta.message].filter(Boolean).join(" · ")
    : replay.active
    ? [REPLAY_STATUS_LABEL[replay.status], replay.cursor != null ? formatIst(replay.cursor) : replay.date, "simulated"].filter(Boolean).join(" · ")
    : [feedLabel, feedStamp, stream.detail].filter(Boolean).join(" · ") || quoteError || "Quote unavailable";

  const s1Session = strategyDates.current || (replay.active && replay.date ? replay.date : "live");
  const s1Key = optionView ? null : `${symbol}|${s1Session}|${strategyDates.previous || "auto"}`;
  const s1Current = s1 && s1.key === s1Key ? s1 : null;
  const strategyOn = strategy.enabled && !optionView;
  // In replay, nothing after the replay clock is shown (a missing cursor counts as before the open).
  const strategyResult = useMemo(
    // The replay clock limits only the replayed session; another chosen day shows everything it has.
    () => (strategyOn && s1Current?.data ? strategyView(s1Current.data, replay.active && s1Current.data.date === replay.date ? (replay.cursor ?? 0) : null, strategy) : null),
    [strategyOn, s1Current, replay.active, replay.cursor, replay.date, strategy],
  );
  const strategyOverlay = strategyResult?.drawings ?? NO_OVERLAY;
  // Strategy drawings are derived, not stored: each refresh reconciles to the same ids. The log below
  // shows that (created / updated / retained / removed). On in development, or with
  // localStorage "td-debug-strategy" = "1"; it runs only when the strategy result changes.
  const strategyLog = useRef(new Map<string, string>());
  useEffect(() => {
    let wanted = process.env.NODE_ENV !== "production";
    try { wanted ||= localStorage.getItem("td-debug-strategy") === "1"; } catch { /* storage unavailable */ }
    const before = strategyLog.current;
    const after = new Map(strategyOverlay.map((drawing) => [drawing.id, JSON.stringify(drawing.points)]));
    strategyLog.current = after;
    if (!wanted) return;
    const ids = new Set([...before.keys(), ...after.keys()]);
    const lifecycle = [...ids].map((id) => ({
      id,
      action: !before.has(id) ? "created" : !after.has(id) ? "removed (strategy off, hidden, or session / symbol changed)" : before.get(id) === after.get(id) ? "retained" : "updated",
    }));
    const trace = strategyResult?.trace;
    const data = s1Current?.data;
    if (trace && data) {
      console.info("[TradeD Strategy] Rectangle A", {
        symbol, session: data.date, previous: trace.previous,
        originalTop: trace.original.top, originalBottom: trace.original.bottom, originalMid: trace.original.mid, originalHeight: trace.original.height,
        translationA: trace.shiftA, top: trace.boxA.top, bottom: trace.boxA.bottom, mid: trace.boxA.mid, height: trace.boxA.height,
        midMinusClose: trace.boxA.mid - trace.previous.close,
      });
      console.info("[TradeD Strategy] Rectangle B", {
        open: trace.open, openSource: data.openSource, cloneOf: `${STRATEGY_PREFIX}${data.symbol}:${data.date}:close-box`, cloneId: `${STRATEGY_PREFIX}${data.symbol}:${data.date}:open-box`,
        cloneMidBefore: trace.cloneMidBefore, translationB: trace.shiftB, top: trace.boxB?.top, bottom: trace.boxB?.bottom, mid: trace.boxB?.mid, height: trace.boxB?.height,
        midMinusOpen: trace.boxB && trace.open != null ? trace.boxB.mid - trace.open : null,
      });
    }
    if (strategyResult?.failures.length) console.warn("[TradeD Strategy] validation failed", strategyResult.failures);
    console.info("[TradeD Strategy] lifecycle", {
      rectanglesBefore: [...before.keys()].filter((id) => id.endsWith("-box")).length,
      rectanglesAfter: strategyOverlay.filter((drawing) => drawing.kind === "rect").length,
      drawingsRendered: strategyOverlay.length,
      lifecycle,
    });
  }, [strategyOverlay, strategyResult, symbol, s1Current]);
  const strategyDot = !s1Current ? "animate-pulse bg-muted" : s1Current.error || s1Current.data?.status === "unavailable" || strategyResult?.failures.length ? "bg-loss" : s1Current.data?.status === "ready" ? "bg-profit" : "bg-warning";

  useEffect(() => {
    if (!strategyOn) return;
    let stop = false;
    const session = strategyDates.current || (replay.active && replay.date ? replay.date : "live");
    const previous = strategyDates.previous;
    const key = `${symbol}|${session}|${previous || "auto"}`;
    const load = () => {
      api<S1Data>(`/api/market/s1?symbol=${encodeURIComponent(symbol)}${session === "live" ? "" : `&date=${encodeURIComponent(session)}`}${previous ? `&previous=${encodeURIComponent(previous)}` : ""}`)
        .then((data) => { if (!stop) setS1({ key, data, error: "" }); })
        .catch((reason: unknown) => {
          if (!stop) setS1((current) => ({ key, data: current?.key === key ? current.data : null, error: reason instanceof Error ? reason.message : "Strategy levels could not be loaded." }));
        });
    };
    load();
    // Live: refresh each minute so the open and 9:15 lines appear once they exist (the server caches).
    const timer = session === "live" ? window.setInterval(load, 60_000) : null;
    return () => {
      stop = true;
      if (timer) window.clearInterval(timer);
    };
  }, [strategyOn, symbol, replay.active, replay.date, strategyDates]);

  function changeStrategy(next: StrategySettings) {
    setStrategy(next);
    saveStrategySettings(next);
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* One compact row: identity never shrinks; only the tool strip scrolls when space runs out. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-panel pl-2 pr-1">
        <div className="flex shrink-0 items-center gap-2" title={stamp}>
          <StockLogo symbol={symbol} name={rail?.items.find((item) => item.symbol === symbol)?.name} size={26} />
          <div className="flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="text-dense font-semibold">{optionView ? `${optionView.underlying} ${optionView.strike.toLocaleString("en-IN")} ${optionView.right}` : symbol}</span>
            <span className="text-micro text-muted">{optionView ? optionView.expiry : "NSE"}</span>
            <span className="num text-dense font-semibold">{priceLabel}</span>
            {changeLabel ? <span className={`num text-data ${changeTone}`}>{changeLabel}</span> : null}
          </div>
          {replay.active
            ? <span className="inline-flex items-center gap-1 rounded-pill bg-demo-soft px-2 py-0.5 text-micro font-medium text-demo"><span className="h-1.5 w-1.5 rounded-full bg-demo" aria-hidden />Replay</span>
            : <span className={`hidden items-center gap-1 whitespace-nowrap text-micro 2xl:inline-flex ${feedLabel === "Live" ? "text-profit" : "text-muted"}`} title={stamp}><span className={`h-1.5 w-1.5 rounded-full ${feedLabel === "Live" ? "bg-profit" : "bg-muted"}`} aria-hidden />{feedLabel}</span>}
          {optionView ? <button type="button" className="rounded-full border border-border px-2 py-0.5 text-micro text-muted" onClick={() => setOptionView(null)}>Back to {optionView.underlying}</button> : null}
          <IconButton label={watched ? "Remove from watchlist" : "Add to watchlist"} active={watched} onClick={toggleWatch}>
            <Star className={`h-4 w-4 ${watched ? "fill-current text-primary" : ""}`} aria-hidden />
          </IconButton>
        </div>
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <div className="flex shrink-0 items-center gap-0.5 rounded-input bg-sunken p-0.5" role="toolbar" aria-label="Timeframe">
          {CHART_SPANS.map((span) => (
            <button key={span} type="button" className={cx("h-7 shrink-0 rounded-xs px-2 text-data", !PRIMARY_SPANS.has(span) && timeframe !== span && "hidden", timeframe === span ? "bg-panel font-semibold text-text shadow-e1" : "text-muted hover:text-text")} aria-pressed={timeframe === span} onClick={() => setTimeframe(span)}>{SPAN_LABEL[span]}</button>
          ))}
        </div>
        <ChartHeaderTools
          chartType={chartType}
          onChartType={setChartType}
          indicatorsOpen={settings}
          onIndicators={() => setSettings((value) => !value)}
          canUndo={historyTick >= 0 && pastRef.current.length > 0}
          canRedo={futureRef.current.length > 0}
          onUndo={undoDrawings}
          onRedo={redoDrawings}
          volumeVisible={flags.volume}
          onToggleVolume={() => setFlags((current) => ({ ...current, volume: !current.volume }))}
          onZoom={(direction) => handleRef.current?.zoom(direction)}
          onReset={() => handleRef.current?.reset()}
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); setReload((value) => value + 1); }}
          full={full}
          onFull={toggleFullScreen}
        >
          <button
            type="button"
            aria-pressed={!railCollapsed}
            aria-label="Watchlist"
            title={railCollapsed ? "Show the watchlist and positions panel" : "Hide the watchlist and positions panel"}
            className={cx("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-input px-2.5 text-data font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]", !railCollapsed ? "bg-primary-soft text-primary hover:brightness-110" : "border border-border text-text-2 hover:bg-elevated hover:text-text")}
            onClick={() => setRailCollapsed((value) => !value)}
          >
            <PanelRightOpen className="h-4 w-4" aria-hidden />
            Watchlist
          </button>
          <button
            type="button"
            aria-pressed={strategy.enabled}
            ref={strategyButtonRef}
            aria-expanded={strategyOpen}
            aria-label="Strategy"
            title="Automatic Trading Strategy"
            className={cx("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-input px-2.5 text-data font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]", strategy.enabled ? "bg-primary-soft text-primary hover:brightness-110" : "border border-border text-text-2 hover:bg-elevated hover:text-text")}
            onClick={() => setStrategyOpen((value) => !value)}
          >
            Strategy
            {strategyOn ? <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", strategyDot)} /> : null}
          </button>
          {live || !canReplay ? null : <button type="button" aria-pressed={replay.active} className={cx("h-8 shrink-0 rounded-input px-2.5 text-data font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] motion-reduce:transition-none", replay.active ? "bg-demo-soft text-demo hover:brightness-110" : "border border-border text-text-2 hover:bg-elevated hover:text-text")} onClick={() => (replay.active ? requestExitReplay() : setReplay((current) => ({ ...current, active: true, status: "loading", cursor: null, date: current.date || previousWeekday(new Date()) })))}>{replay.active ? "Exit replay" : "Replay"}</button>}
          {replay.active && replay.date ? <span className="num hidden shrink-0 whitespace-nowrap rounded-full bg-demo-soft px-2.5 py-1 text-micro font-medium text-demo xl:inline" title="Replay date and time (IST)">{replayChipLabel(replay.date, replay.cursor)}</span> : null}
          <button type="button" aria-label="Option chain" aria-pressed={chainOpen} className={cx("h-8 shrink-0 rounded-input px-2.5 text-data font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] motion-reduce:transition-none", chainOpen ? "bg-primary text-on-primary" : "border border-primary/40 text-primary hover:bg-primary/10")} onClick={() => setChainOpen((value) => !value)}>Option chain</button>
        </ChartHeaderTools>
        </div>
      </div>
      {LABEL_TOOLS.has(tool) ? (
        <label className="flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-xs text-muted">
          Label
          <input className="min-w-0 flex-1 bg-transparent text-text" value={annotation} placeholder={tool === "price" ? "Uses the clicked price when empty" : "Note"} onChange={(event) => setAnnotation(event.target.value)} />
        </label>
      ) : null}
      {settings ? (
        <div className="flex flex-wrap gap-3 border-b border-border bg-panel px-3 py-2 text-xs">
          {(["sma", "ema", "vwap", "volume", "supertrend"] as const).map((flag) => (
            <label key={flag} className="flex items-center gap-1"><input type="checkbox" checked={flags[flag]} onChange={() => setFlags((current) => ({ ...current, [flag]: !current[flag] }))} />{flag.toUpperCase()}</label>
          ))}
          <label>Oscillator <select className="ml-1 py-1" value={flags.oscillator} onChange={(event) => setFlags((current) => ({ ...current, oscillator: event.target.value as Flags["oscillator"] }))}><option value="none">Off</option><option value="rsi">RSI</option><option value="macd">MACD</option></select></label>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <ChartToolbar
          tool={tool}
          onTool={setTool}
          lockAll={lockAll}
          onLockAll={() => setLockAll((value) => !value)}
          drawingsHidden={drawingsHidden}
          indicatorsHidden={indicatorsHidden}
          onVisibility={applyVisibility}
          onRemove={removeObjects}
          objectsOpen={objectsOpen}
          onObjects={() => setObjectsOpen((value) => !value)}
        />
        {objectsOpen ? (
          <aside className="max-h-48 shrink-0 overflow-auto border-b border-border bg-panel lg:max-h-none lg:w-52 lg:border-b-0 lg:border-r">
            <p className="px-3 pt-2 text-[11px] font-semibold text-muted">Drawings</p>
            <DrawingList drawings={drawings} selectedId={selectedDrawing} onSelect={setSelectedDrawing} onChange={rememberDrawings} lockAll={lockAll} onClearAll={() => removeObjects("drawings")} />
          </aside>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {replay.active && (replay.status === "ready" || replay.status === "playing" || replay.status === "paused" || replay.status === "completed") ? <PreviousSessionStrip session={prior?.date === replay.date ? prior.session : null} /> : null}
      {replay.active && held ? <p className="border-b border-border bg-panel px-3 py-1 text-[11px] text-muted">{held.quantity > 0 ? "Long" : "Short"} {Math.abs(held.quantity)} {symbol} · Avg ₹{formatDemoRupees(held.avgPaise)} · Unrealized <span className={paperPnl == null ? "text-muted" : paperPnl > 0 ? "text-profit" : paperPnl < 0 ? "text-loss" : "text-muted"}>{paperPnl == null ? "—" : `₹${formatDemoRupees(paperPnl)}`}</span> · Buying power ₹{formatDemoRupees(buyingPower(book, replayMark == null ? {} : { [symbol]: replayMark }))}</p> : null}
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={chartAreaRef} className="relative flex min-h-0 flex-1 flex-col">
            {!replay.active && loading ? <p className="p-4 text-sm text-muted">Loading chart…</p> : null}
            {replay.active && replay.status === "loading" ? <p className="p-4 text-sm text-info">Loading the selected session…</p> : null}
            {(!replay.active || optionView) && chartError ? (
              <div className="m-4 max-w-xl rounded-md border border-loss/30 bg-loss-soft p-3 text-sm" role="alert">
                <p className="font-semibold text-loss">Chart data is unavailable</p>
                <p className="mt-1 text-text-2">{chartError}</p>
                <button type="button" className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-input bg-primary px-3 text-data font-semibold text-on-primary hover:bg-primary-hover" onClick={() => { setRefreshing(true); setReload((value) => value + 1); }}>Retry</button>
              </div>
            ) : null}
            {((!optionView && replay.active && replay.status !== "loading") || ((!replay.active || optionView) && !loading && !chartError)) && shown.length === 0 ? <p className="p-4 text-sm text-muted">{optionView ? "Historical candles were not returned for this option contract." : replay.active ? replay.message || "No candle is visible at this replay time." : "No candles were returned for this symbol and interval."}</p> : null}
            {shown.length > 0 ? (
              <ChartPanel
                candles={shown}
                compare={[]}
                chartType={chartType}
                showSma={flags.sma && !indicatorsHidden}
                showEma={flags.ema && !indicatorsHidden}
                showBands={flags.bands && !indicatorsHidden}
                showVwap={flags.vwap && !indicatorsHidden}
                showVolume={flags.volume}
                showSupertrend={flags.supertrend && !indicatorsHidden}
                indicators={indicators}
                oscillator={indicatorsHidden ? "none" : flags.oscillator}
                tool={tool}
                annotation={annotation}
                magnet={drawPrefs.magnet}
                stay={drawPrefs.stay}
                lockAll={lockAll}
                cursorStyle={drawPrefs.cursor}
                hidden={drawingsHidden}
                onTool={setTool}
                onSelect={setSelectedDrawing}
                span={timeframe}
                focusId={selectedDrawing}
                drawings={drawings}
                overlays={strategyOverlay}
                onDrawings={rememberDrawings}
                handleRef={handleRef}
                scheme={desk.theme}
                paint={desk.appearance.chart}
                streamKey={`${optionView ? `opt-${optionView.securityId || optionView.underlying}-${optionView.expiry}-${optionView.strike}-${optionView.right}` : symbol}-${timeframe}-${optionView ? "contract" : replay.active ? `replay-${replay.date}` : "live"}`}
                references={sessionLevels}
              />
            ) : null}
            {shown.length > 0 ? <FavouritesBar tool={tool} onTool={setTool} /> : null}
            {strategyOpen ? (
              <StrategyPanel
                settings={strategy}
                onChange={changeStrategy}
                data={strategyOn ? s1Current?.data ?? null : null}
                view={strategyResult}
                loading={strategyOn && !s1Current}
                error={s1Current?.error ?? ""}
                disabledReason={optionView ? "The strategy works on the stock or index chart, not on an option contract." : ""}
                dates={strategyDates}
                onDates={setStrategyDates}
                today={kolkataParts(new Date()).dateKey}
                autoCurrent={replay.active && replay.date ? replay.date : s1Current?.data?.date ?? kolkataParts(new Date()).dateKey}
                manualRectangles={drawings.filter((drawing) => drawing.kind === "rect" || drawing.kind === "rrect").length}
                onClose={() => setStrategyOpen(false)}
                left={strategyLeft}
              />
            ) : null}
            {chainOpen ? (
              <OptionChainPanel
                symbol={symbol}
                replay={replay.active ? { date: replay.date, session: optionSession, cursor: replay.cursor, spot: playCandle?.close ?? null, spotSymbol: symbol } : null}
                onClose={() => setChainOpen(false)}
                onOpenChart={(contract) => setOptionView(contract)}
                onOrder={orderFromChain}
                livePaper={live}
                allowOrders={canPaperTrade}
                ledgerTick={ledgerTick}
              />
            ) : null}
          </div>
      {replay.active ? (
        <ReplayBar
          date={replay.date}
          today={kolkataParts(new Date()).dateKey}
          cursor={replay.cursor}
          sessionOpen={replay.sessionOpen}
          sessionClose={replay.sessionClose}
          status={replay.status}
          speed={replay.speed}
          timeframe={timeframe}
          message={replay.status === "loading" ? "Loading the session…" : replay.message}
          onDate={(date) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date === replay.date) return;
            const dirty = sessionOpenCount > 0 || book.positions.length > 0 || book.fills.length > 0 || book.trades.length > 0 || book.orders.some((order) => order.status === "OPEN");
            if (dirty) {
              setPendingDate(date);
              return;
            }
            setReplay((current) => ({ ...current, date, status: "loading", cursor: null }));
          }}
          onToggle={() => setReplay((current) => {
            if (current.status === "playing") return { ...current, status: "paused" };
            if (current.status === "ready" || current.status === "paused") return { ...current, status: "playing" };
            return current;
          })}
          onStep={(direction) => setReplay((current) => {
            if (current.cursor == null || current.sessionOpen == null || current.sessionClose == null) return current;
            const cursor = stepCursor(current.cursor, current.sessionOpen, current.sessionClose, direction);
            setBook((bookNow) => settleReplayBook(bookNow, cursor, current.date));
            return { ...current, cursor, status: cursor >= current.sessionClose ? "completed" : current.status === "playing" ? "playing" : "paused" };
          })}
          onSeek={(next) => setReplay((current) => {
            if (current.sessionOpen == null || current.sessionClose == null || !Number.isFinite(next)) return current;
            const cursor = Math.min(current.sessionClose, Math.max(current.sessionOpen, next));
            if (cursor < settledThrough.current) settledThrough.current = cursor;
            setBook((bookNow) => settleReplayBook(bookNow, cursor, current.date));
            return { ...current, cursor, status: cursor >= current.sessionClose ? "completed" : current.status === "playing" ? "playing" : "paused" };
          })}
          onReset={() => setRestart(true)}
          onSpeed={(speed) => setReplay((current) => ({ ...current, speed }))}
        />
      ) : null}
          {replay.active ? null : <p className="truncate border-t border-border px-3 py-0.5 text-micro text-muted" title={`${stamp} ${candleMeta.message}`}>{`${stamp}${candleMeta.mode ? ` · ${candleMeta.mode}` : ""} ${candleMeta.message}`}</p>}
          {variant === "positions" ? (
            <section className="border-t border-border bg-panel">
              <div className="flex h-10 items-center gap-1 border-b border-border px-2" role="tablist" aria-label="Positions and orders">
                {(["open", "closed", "orders", "history", "replay"] as const).map((tab) => (
                  <button key={tab} type="button" role="tab" aria-selected={dock === tab} className={cx("relative h-10 px-3 text-[13px] font-medium", dock === tab ? "text-text after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary" : "text-muted hover:text-text")} onClick={() => { setDock(tab); setDockOpen(true); }}>{tab === "open" ? "Open" : tab === "closed" ? "Closed" : tab === "orders" ? "Orders" : tab === "history" ? "History" : "Replay book"}</button>
                ))}
                <button type="button" className="ml-auto h-7 rounded-input px-2 text-data text-muted hover:bg-elevated hover:text-text" onClick={() => setDockOpen((value) => !value)}>{dockOpen ? "Collapse" : "Expand"}</button>
              </div>
              {dockOpen ? (
                <div className="flex max-h-60 min-h-0 flex-col">
                  {dock === "open" ? <OpenTable mode="demo" practice={practice} practiceError={practiceError} broker={null} brokerNote="" onPick={selectSymbol} /> : null}
                  {dock === "closed" ? <ClosedTable rows={(activity?.executions ?? []).filter((row) => Number(row.realized) !== 0)} onPick={selectSymbol} /> : null}
                  {dock === "orders" ? <OrderTable mode="demo" rows={activity?.orders ?? []} note="" onPick={selectSymbol} /> : null}
                  {dock === "history" ? <HistoryTable rows={activity?.executions ?? []} onPick={selectSymbol} /> : null}
                  {dock === "replay" ? <ReplayTable book={book} mark={replayMark} symbol={symbol} onPick={selectSymbol} onCancel={(id) => setBook((current) => cancelDemoOrder(current, id))} /> : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
        </div>
        {ticketDraft ? (
          <OptionOrderTicket
            key={draftKey(ticketDraft)}
            draft={ticketDraft}
            replayCursor={replay.active ? replay.cursor : null}
            onClose={closeTicket}
            onFilled={() => {
              setSideRail("positions");
              setRailCollapsed(false);
              setLedgerTick((value) => value + 1);
              refreshPractice.current();
              window.dispatchEvent(new Event("td-ledger"));
            }}
          />
        ) : null}
        <aside className={`flex w-full shrink-0 flex-col overflow-hidden border-t border-border bg-panel lg:h-auto lg:border-l lg:border-t-0 ${ticketDraft ? "lg:hidden" : ""} ${railCollapsed ? "hidden" : sideRail === "positions" ? "h-[min(48vh,32rem)] lg:w-[clamp(17rem,24vw,21rem)]" : "h-64 lg:w-[clamp(16rem,20vw,18rem)]"}`}>
          <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border px-1.5" role="tablist" aria-label="Side panel">
            {railCollapsed ? null : (["watch", "positions"] as const).map((item) => {
              const count = item === "positions" && practice ? bookRows.filter((row) => row.quantity > 0).length : 0;
              return (
                <button key={item} type="button" role="tab" aria-selected={sideRail === item} className={cx("relative h-10 px-2.5 text-data font-medium transition-colors", sideRail === item ? "text-text after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary" : "text-muted hover:text-text")} onClick={() => setSideRail(item)}>
                  {item === "watch" ? "Watchlist" : "Positions"}{count > 0 ? <span className="num ml-1 rounded-pill bg-primary-soft px-1.5 text-micro text-primary">{count}</span> : null}
                </button>
              );
            })}
            <button type="button" className="ml-auto grid h-7 w-7 place-items-center rounded-input text-muted hover:bg-hover hover:text-text" title="Close side panel" aria-label="Close side panel" aria-expanded={!railCollapsed} onClick={() => setRailCollapsed((value) => !value)}>{railCollapsed ? <PanelRightOpen className="h-4 w-4" aria-hidden /> : <PanelRightClose className="h-4 w-4" aria-hidden />}</button>
          </div>
          {railCollapsed ? null : sideRail === "positions" ? (
            <OptionBook
              buyingPower={ledger?.cashAvailable ?? "—"}
              reserved={ledger?.cashReserved ?? "—"}
              holdings={replayTotals?.holdings ?? liveTotals?.holdings ?? ledger?.holdingsValue ?? "—"}
              unrealized={replayTotals?.unrealized ?? liveTotals?.unrealized ?? ledger?.unrealized ?? "—"}
              realized={ledger?.realized ?? "—"}
              realizedToday={ledger?.realizedToday ?? "—"}
              positions={bookRows}
              summary={currentSummary}
              highlightTradeId={replay.active ? closedHighlight : null}
              onDismissHighlight={() => setClosedHighlight(null)}
              context={replay.active ? { mode: "replay", date: replay.date, cursor: replay.cursor, sessionOpen: replay.sessionOpen } : { mode: desk.mode === "live" ? "live" : "demo" }}
              exitBlock={exitBlock}
              hiddenCount={hiddenBookRows}
              orders={activity?.orders ?? []}
              trades={closedTrades}
              error={practiceError}
              onOpenChain={() => setChainOpen(true)}
              onViewChart={selectSymbol}
              onExit={openExit}
            />
          ) : <>
          <div className="border-b border-border p-2">
            <StockSearchField
              query={query}
              onQuery={(value) => { setQuery(value); setSkip(0); setSearching(true); }}
              hits={searching && query.trim() ? hits : []}
              status={!searching || !query.trim() ? "idle" : hits.length === 0 ? "empty" : "ready"}
              watched={(next) => lists.some((list) => list.items.some((row) => row.symbol === next))}
              onSelect={(hit) => selectSymbol(hit.symbol)}
              onToggleWatch={(hit) => toggleSymbol(hit.symbol, hit.name, hit.exchange)}
            />
            {searching && query.trim() && hits.length >= 50 ? <button className="mt-1 w-full px-3 py-1 text-left text-xs text-primary" onClick={() => setSkip((value) => value + 50)}>Load more</button> : null}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {(rail?.items.length ?? 0) === 0 ? <p className="p-3 text-xs text-muted">This watchlist has no symbols. Search above and use the star to add one.</p> : rail?.items.map((item) => {
              const rowQuote = sideQuotes[item.symbol];
              const move = moveOf(rowQuote?.last, rowQuote?.previousClose);
              const selected = item.symbol === symbol;
              return (
                <div key={item.symbol} className={`flex items-center gap-0.5 pr-1 transition-colors hover:bg-hover ${selected ? "bg-primary-soft/50" : ""}`}>
                  <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left" onClick={() => selectSymbol(item.symbol)} title={item.name}>
                    <SymbolTitle symbol={item.symbol} name={item.name} size={24} />
                    <span className="ml-auto shrink-0 text-right">
                      <span className={`num block whitespace-nowrap text-xs ${tone(move?.abs)}`}>{rowQuote ? money(rowQuote.last) : "—"}</span>
                      <span className={`num block whitespace-nowrap text-[10px] ${tone(move?.abs)}`}>{move ? `${move.abs >= 0 ? "+" : ""}${move.abs.toFixed(2)} (${move.pct.toFixed(2)}%)` : ""}</span>
                    </span>
                  </button>
                  <WatchStar active label={`Remove ${item.symbol} from watchlist`} onToggle={() => toggleSymbol(item.symbol, item.name, item.exchange)} />
                </div>
              );
            })}
          </div>
          {variant === "positions" ? (
            <div className="max-h-64 overflow-auto border-t border-border p-3">
              <h2 className="text-sm font-semibold">Position</h2>
              <p className="mt-1 text-[11px] text-muted">{desk.mode === "live" ? "Live paper wallet. Not a broker position." : "Practice ledger. Long only. This is not a broker position."}</p>
              {practiceRow ? <PracticeDetail row={practiceRow} onExit={() => setExitSymbol(practiceRow)} /> : (
                <div className="mt-3 text-sm">
                  <p>No open practice position for {symbol}.</p>
                  {practiceError ? <p className="mt-2 text-xs text-loss">{practiceError}</p> : null}
                </div>
              )}
            </div>
          ) : null}
          </>}
        </aside>
      </div>
      {exitSymbol ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-4 text-sm">
            <h2 className="font-semibold">Exit {exitSymbol.symbol}?</h2>
            <p className="mt-2 text-xs text-muted">Places a practice market sell for {exitSymbol.quantity} shares. This uses the practice ledger, not the replay book, and it is not sent to a broker.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded-full border border-border px-3 py-1 text-xs" onClick={() => setExitSymbol(null)}>Back</button>
              <button className="rounded-full bg-loss px-3 py-1 text-xs text-on-signal" onClick={() => {
                void api<{ status?: string; message?: string }>("/api/orders", { symbol: exitSymbol.symbol, side: "SELL", type: "MARKET", quantity: exitSymbol.quantity, idempotencyKey: crypto.randomUUID().replace(/-/g, "").slice(0, 20) })
                  .then((result) => { desk.toast(`${exitSymbol.symbol} ${result.status ?? "sent"}. ${result.message ?? ""}`); setExitSymbol(null); })
                  .catch((error: unknown) => desk.toast(error instanceof Error ? error.message : "Exit failed."));
              }}>Sell practice position</button>
            </div>
          </div>
        </div>
      ) : null}
      {currentSummary ? (
        <ReplaySummaryDialog
          open={summaryOpen}
          reason={summaryRequested ? "exit" : "completed"}
          date={replay.date}
          summary={currentSummary}
          onKeepReviewing={closeSummary}
          onRestart={() => { closeSummary(); returnToStart(); }}
          onBackToLive={() => { closeSummary(); leaveReplay(); }}
        />
      ) : null}
      {pendingDate ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-4 text-sm">
            <h2 className="font-semibold">Change the replay date?</h2>
            <p className="mt-2 text-xs text-muted">The paper book already has trades. Continue keeps this virtual account and its history. A fresh book starts again at the chosen balance and removes the current paper trades from this browser.</p>
            {sessionOpenCount ? <p className="mt-2 text-xs text-warning">You hold {sessionOpenCount} replay option position{sessionOpenCount === 1 ? "" : "s"} from {replay.date}. They stay open on the practice ledger at their last replay mark. Come back to {replay.date} to close them.</p> : null}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button className="rounded-full border border-border px-3 py-1 text-xs" onClick={() => setPendingDate(null)}>Cancel</button>
              <button className="rounded-full border border-border px-3 py-1 text-xs" onClick={() => { const date = pendingDate; setPendingDate(null); setReplay((current) => ({ ...current, date, status: "loading", cursor: null })); }}>Continue this account</button>
              <button className="rounded-full bg-loss px-3 py-1 text-xs text-on-signal" onClick={() => { const date = pendingDate; setPendingDate(null); setBook(emptyDemoBook(book.startPaise)); setReplay((current) => ({ ...current, date, status: "loading", cursor: null })); }}>Fresh paper book</button>
            </div>
          </div>
        </div>
      ) : null}
      {restart ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-4 text-sm">
            <h2 className="font-semibold">Restart this replay?</h2>
            <p className="mt-2 text-xs text-muted">Returning to the session open keeps the paper book. Resetting the book starts a new practice balance and keeps this browser’s previous trades only until you confirm the reset. Neither action changes the practice ledger.</p>
            <p className="mt-2 text-xs text-muted">{sessionOpenCount
              ? `You hold ${sessionOpenCount} replay option position${sessionOpenCount === 1 ? "" : "s"} in this session. They stay open, and new option orders are accepted only at or after your last option fill time. Close them to start a fresh option session.`
              : "Option trades from this replay stay in Orders and History. A fresh option session starts from the session open."}</p>
            <label className="mt-3 block text-xs text-muted">Starting virtual balance, rupees<input className="mt-1 w-full" value={startRupees} onChange={(event) => setStartRupees(event.target.value)} inputMode="decimal" /></label>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button className="rounded-full border border-border px-3 py-1 text-xs" onClick={() => setRestart(false)}>Cancel</button>
              <button className="rounded-full border border-border px-3 py-1 text-xs" onClick={() => { returnToStart(); setRestart(false); }}>Return to start</button>
              <button className="rounded-full bg-loss px-3 py-1 text-xs text-on-signal" onClick={() => {
                let start = book.startPaise;
                try { start = Number(rupeesToPaise(startRupees)); } catch { desk.toast("Enter a starting balance in rupees."); return; }
                if (start <= 0) { desk.toast("Enter a starting balance above zero."); return; }
                settledThrough.current = replay.sessionOpen ?? 0;
                if (!sessionOpenCount && replay.date) ensureOptionSession(replay.date, true);
                setBook(emptyDemoBook(start));
                setReplay((current) => ({ ...current, cursor: current.sessionOpen, status: "ready" }));
                setRestart(false);
              }}>Reset paper book</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PracticeDetail({ row, onExit }: { row: PracticePosition; onExit: () => void }) {
  const avg = Number(row.averageCost);
  const mark = row.mark == null ? null : Number(row.mark);
  const pct = mark != null && avg ? ((mark - avg) / avg) * 100 : null;
  return (
    <>
    <dl className="mt-3 space-y-1 text-xs">
      <Row label="Symbol" value={`${row.name} · ${row.symbol}`} />
      <Row label="Direction" value="BUY · long" />
      <Row label="Quantity" value={String(row.quantity)} />
      <Row label="Average" value={row.averageCost} />
      <Row label="Last" value={row.mark ?? "unavailable"} />
      <Row label="Value" value={row.marketValue ?? "unavailable"} />
      <Row label="Unrealized" value={row.unrealized ?? "unavailable"} />
      <Row label="Unrealized %" value={pct == null ? "unavailable" : `${pct.toFixed(2)}%`} />
      <Row label="Realized" value={row.realized} />
      <Row label="Mark time" value={row.asOf ? istTime(row.asOf) : "unavailable"} />
    </dl>
    <button className="mt-3 rounded-full bg-loss px-3 py-1 text-xs text-on-signal" onClick={onExit}>Exit practice position</button>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3 border-b border-border py-1"><dt className="text-muted">{label}</dt><dd className="num text-right">{value}</dd></div>;
}

type BrokerRow = { symbol: string; qty: string; side: string; avg: string; pnl: string };
type OrderRowData = PracticeBook["orders"][number];
type FillRow = PracticeBook["executions"][number];

function pnlClass(value: string | number | null | undefined) {
  if (value == null || value === "" || value === "—") return "text-muted";
  const text = String(value).trim();
  const number = Number(text.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(number) || number === 0) return "text-text";
  return text.startsWith("-") || text.startsWith("−") || number < 0 ? "text-loss" : "text-profit";
}

function displaySymbol(symbol: string) {
  const option = parseOptionLedgerSymbol(symbol);
  return option ? `${option.underlying} ${option.strike} ${option.right}` : symbol;
}

function SymbolCell({ symbol, name, onPick }: { symbol: string; name?: string; onPick: (symbol: string) => void }) {
  const option = parseOptionLedgerSymbol(symbol);
  return (
    <button type="button" className="inline-flex max-w-[16rem] items-center gap-2 text-left font-medium text-text hover:text-primary" onClick={() => onPick(symbol)}>
      <StockLogo symbol={option?.underlying ?? symbol} name={name} size={20} />
      <span className="min-w-0 truncate">{displaySymbol(symbol)}{option ? <span className="ml-1.5 text-[11px] font-normal text-muted">{option.expiry}</span> : null}</span>
    </button>
  );
}

function SideText({ side }: { side: string }) {
  return <span className={cx("font-semibold", side === "BUY" ? "text-profit" : side === "SELL" ? "text-loss" : "text-text-2")}>{side}</span>;
}

function DockEmpty({ title, body }: { title: string; body?: string }) {
  return <EmptyState title={title} body={body} />;
}

function OpenTable({ mode, practice, practiceError, broker, brokerNote, onPick }: { mode: "demo" | "live"; practice: PracticePosition[] | null; practiceError: string; broker: BrokerRow[] | null; brokerNote: string; onPick: (symbol: string) => void }) {
  if (mode === "live") {
    if (!broker) return <DockEmpty title="Broker positions are unavailable" body={brokerNote || undefined} />;
    const columns: Column<BrokerRow>[] = [
      { key: "symbol", header: "Symbol", render: (row) => <SymbolCell symbol={row.symbol} onPick={onPick} /> },
      { key: "side", header: "Side", render: (row) => <SideText side={row.side} /> },
      { key: "qty", header: "Qty", numeric: true, render: (row) => row.qty },
      { key: "avg", header: "Avg", numeric: true, render: (row) => row.avg },
      { key: "pnl", header: "Unrealized", numeric: true, render: (row) => <span className={pnlClass(row.pnl)}>{row.pnl}</span> },
    ];
    return <Table label="Broker positions" dense columns={columns} rows={broker} rowKey={(row) => row.symbol} empty={<DockEmpty title="No open broker positions" />} />;
  }
  if (practiceError) return <p className="px-3 py-4 text-data text-loss" role="alert">{practiceError}</p>;
  if (!practice) return <p className="px-3 py-4 text-data text-muted">Loading practice positions…</p>;
  const columns: Column<PracticePosition>[] = [
    { key: "symbol", header: "Instrument", render: (row) => <SymbolCell symbol={row.symbol} name={row.name} onPick={onPick} /> },
    { key: "lots", header: "Lots", numeric: true, render: (row) => row.lots ?? "—" },
    { key: "qty", header: "Qty", numeric: true, render: (row) => row.quantity.toLocaleString("en-IN") },
    { key: "avg", header: "Avg", numeric: true, render: (row) => row.averageCost },
    { key: "ltp", header: "LTP", numeric: true, render: (row) => row.mark ?? "—" },
    { key: "value", header: "Value", numeric: true, render: (row) => row.marketValue ?? "—" },
    { key: "pnl", header: "Unrealized", numeric: true, render: (row) => <span className={cx("font-semibold", pnlClass(row.unrealized))}>{row.unrealized ?? "—"}</span> },
  ];
  return <Table label="Open positions" dense columns={columns} rows={practice} rowKey={(row) => row.symbol} empty={<DockEmpty title="No open positions" body="Buy a contract from the option chain and it appears here." />} />;
}

function ClosedTable({ rows, onPick }: { rows: FillRow[]; onPick: (symbol: string) => void }) {
  if (rows.length === 0) return <DockEmpty title="No closed positions yet" body="Closing fills with realized P&L appear here." />;
  return <HistoryTable rows={rows} onPick={onPick} />;
}

function OrderTable({ mode, rows, note, onPick }: { mode: "demo" | "live"; rows: OrderRowData[]; note: string; onPick: (symbol: string) => void }) {
  if (mode === "live") return <DockEmpty title="Live broker orders are not shown" body={`TradeD is read-only in live view. ${note}`.trim()} />;
  const columns: Column<OrderRowData>[] = [
    { key: "time", header: "Time", render: (row) => <span className="num text-text-2">{istTime(row.submittedAt)}</span> },
    { key: "symbol", header: "Instrument", render: (row) => <SymbolCell symbol={row.symbol} onPick={onPick} /> },
    { key: "side", header: "Side", render: (row) => <SideText side={row.side} /> },
    { key: "type", header: "Type", render: (row) => <span className="text-text-2">{row.type}</span> },
    { key: "qty", header: "Qty", numeric: true, render: (row) => `${row.filledQuantity}/${row.quantity}` },
    { key: "avg", header: "Avg fill", numeric: true, render: (row) => row.avgFill ?? "—" },
    { key: "status", header: "Status", align: "right", render: (row) => <span title={row.reason ?? undefined}><OrderStatus status={row.status} /></span> },
  ];
  return <Table label="Orders" dense columns={columns} rows={rows} rowKey={(row) => row.id} empty={<DockEmpty title="No orders yet" body="Orders you place from the ticket are listed here." />} />;
}

function HistoryTable({ rows, onPick }: { rows: FillRow[]; onPick: (symbol: string) => void }) {
  const columns: Column<FillRow>[] = [
    { key: "time", header: "Time", render: (row) => <span className="num text-text-2">{istTime(row.executedAt)}</span> },
    { key: "symbol", header: "Instrument", render: (row) => <SymbolCell symbol={row.symbol} onPick={onPick} /> },
    { key: "side", header: "Side", render: (row) => <SideText side={row.side} /> },
    { key: "qty", header: "Qty", numeric: true, render: (row) => row.quantity.toLocaleString("en-IN") },
    { key: "price", header: "Price", numeric: true, render: (row) => row.price },
    { key: "charges", header: "Charges", numeric: true, render: (row) => <span className="text-text-2">{row.charges}</span> },
    { key: "realized", header: "Realized", numeric: true, render: (row) => <span className={cx("font-semibold", pnlClass(row.realized))}>{row.realized}</span> },
  ];
  return <Table label="Fills" dense columns={columns} rows={rows} rowKey={(row) => row.id} empty={<DockEmpty title="No fills yet" />} />;
}

function ReplayTable({ book, mark, symbol, onPick, onCancel }: { book: DemoBook; mark: number | null; symbol: string; onPick: (symbol: string) => void; onCancel: (id: string) => void }) {
  type ReplayRow = DemoBook["positions"][number];
  const open = book.orders.filter((order) => order.status === "OPEN");
  const columns: Column<ReplayRow>[] = [
    { key: "symbol", header: "Symbol", render: (row) => <SymbolCell symbol={row.symbol} onPick={onPick} /> },
    { key: "qty", header: "Qty", numeric: true, render: (row) => row.quantity.toLocaleString("en-IN") },
    { key: "avg", header: "Avg", numeric: true, render: (row) => formatDemoRupees(row.avgPaise) },
    { key: "pnl", header: "Unrealized", numeric: true, render: (row) => {
      if (row.symbol !== symbol || mark == null) return <span className="text-muted">—</span>;
      const pnl = (mark - row.avgPaise) * row.quantity;
      return <span className={cx("font-semibold", pnl > 0 ? "text-profit" : pnl < 0 ? "text-loss" : "text-text")}>{formatDemoRupees(pnl)}</span>;
    } },
  ];
  return (
    <div className="flex min-h-0 flex-col">
      <p className="border-b border-border px-3 py-1.5 text-[11px] text-muted">Cash <span className="num text-text">₹{formatDemoRupees(book.cashPaise)}</span> · Realized <span className={cx("num", book.realizedPaise > 0 ? "text-profit" : book.realizedPaise < 0 ? "text-loss" : "text-text")}>₹{formatDemoRupees(book.realizedPaise)}</span> · Stored in this browser, separate from your demo account.</p>
      <Table label="Replay positions" dense columns={columns} rows={book.positions} rowKey={(row) => row.symbol} empty={<DockEmpty title="No replay positions" />} />
      {open.map((order) => (
        <div key={order.id} className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-data">
          <SideText side={order.side} />
          <span className="num">{order.quantity}</span>
          <span className="font-medium">{order.symbol}</span>
          <span className="text-muted">{order.type} {order.reason}</span>
          <button type="button" className="ml-auto h-7 rounded-input px-2 font-medium text-loss hover:bg-loss/10" onClick={() => onCancel(order.id)}>Cancel</button>
        </div>
      ))}
    </div>
  );
}

