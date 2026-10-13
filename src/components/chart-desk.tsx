"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChartPanel, DEFAULT_INDICATORS, type Candle, type ChartHandle, type ChartType, type Drawing, type DrawTool, type IndicatorSettings } from "@/components/chart-panel";
import { loadDrawings, saveDrawings } from "@/components/drawing-model";
import { IconButton } from "@/components/icon-button";
import { DemoModeBadge, OrderStatus, StockLogo, StockSearchField, SymbolTitle, WatchStar } from "@/components/stock-identity";
import { api, freshness, istTime, money, moveOf, tone, type Quote } from "@/components/api";
import { useDesk } from "@/components/shell";
import { applyLiveTick, CHART_SPANS, SPAN_LABEL, type ChartSpan } from "@/lib/market/spans";
import {
  cancelDemoOrder,
  demoUnrealized,
  emptyDemoBook,
  firstCandleOn,
  formatDemoRupees,
  formatIst,
  loadDemoBook,
  placeDemoOrder,
  sessionDays,
  settleDemoOrders,
  sliceTo,
  stepPlayhead,
  type DemoBook,
} from "@/lib/trading/demo-replay";
import { rupeesToPaise } from "@/lib/money";
import { calculateCharges } from "@/lib/trading/fees";
import { DEFAULT_CHARGES } from "@/lib/trading/settings";
import {
  Activity,
  AreaChart,
  BarChart3,
  CandlestickChart,
  LineChart,
  Maximize2,
  Minimize2,
  Minus,
  MousePointer2,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Star,
  TrendingUp,
  Type,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

type Hit = { symbol: string; name: string; exchange: string };
type PracticePosition = {
  symbol: string;
  name: string;
  quantity: number;
  averageCost: string;
  mark: string | null;
  marketValue: string | null;
  unrealized: string | null;
  realized: string;
  mode?: string;
  asOf?: string | null;
};
type PracticeBook = {
  orders: Array<{ id: string; symbol: string; side: string; type: string; quantity: number; filledQuantity: number; status: string; avgFill: string | null; reason: string | null; submittedAt: string }>;
  executions: Array<{ id: string; symbol: string; side: string; quantity: number; price: string; charges: string; realized: string; mode: string; executedAt: string }>;
};
type Flags = { sma: boolean; ema: boolean; bands: boolean; vwap: boolean; volume: boolean; supertrend: boolean; oscillator: "none" | "rsi" | "macd" };
type Replay = { active: boolean; day: string; playhead: number | null; playing: boolean; speed: 1 | 2 | 4 | 8 };

const SPEEDS = [1, 2, 4, 8] as const;
const EMPTY_FLAGS: Flags = { sma: false, ema: false, bands: false, vwap: false, volume: true, supertrend: false, oscillator: "none" };
const DRAW_TOOLS: Array<{ id: DrawTool; label: string; icon: typeof MousePointer2 }> = [
  { id: "cursor", label: "Pointer", icon: MousePointer2 },
  { id: "trend", label: "Trend line", icon: TrendingUp },
  { id: "ray", label: "Ray", icon: Pencil },
  { id: "hline", label: "Horizontal line", icon: Minus },
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "text", label: "Text", icon: Type },
];
const CHART_TYPES: Array<{ id: ChartType; label: string; icon: typeof CandlestickChart }> = [
  { id: "candle", label: "Candles", icon: CandlestickChart },
  { id: "line", label: "Line", icon: LineChart },
  { id: "bar", label: "Bars", icon: BarChart3 },
  { id: "area", label: "Area", icon: AreaChart },
];

function brokerRows(payload: unknown): Array<{ symbol: string; qty: string; side: string; avg: string; pnl: string }> | null {
  if (payload && typeof payload === "object" && "error" in payload) return null;
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;
  if (!list) return null;
  return list.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const symbol = String(item.tradingSymbol ?? item.symbol ?? "");
    if (!symbol) return [];
    const net = Number(item.netQty ?? item.netQuantity ?? 0);
    return [{
      symbol,
      qty: String(item.netQty ?? item.netQuantity ?? "—"),
      side: Number.isFinite(net) && net < 0 ? "SELL" : "BUY",
      avg: String(item.buyAvg ?? item.costPrice ?? "—"),
      pnl: String(item.unrealizedProfit ?? "—"),
    }];
  });
}

export function ChartDesk({ variant }: { variant: "chart" | "positions" }) {
  const desk = useDesk();
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
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [settings, setSettings] = useState(false);
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [full, setFull] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candleMeta, setCandleMeta] = useState({ mode: "", source: "", message: "" });
  const [chartError, setChartError] = useState("");
  const [loading, setLoading] = useState(true);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [lists, setLists] = useState<Array<{ id: string; name: string; items: Array<{ symbol: string; name: string; exchange: string }> }>>([]);
  const [sideQuotes, setSideQuotes] = useState<Record<string, Quote>>({});
  const [replay, setReplay] = useState<Replay>({ active: false, day: "", playhead: null, playing: false, speed: 1 });
  const [book, setBook] = useState<DemoBook>(emptyDemoBook());
  const [tradeOpen, setTradeOpen] = useState(false);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [quantity, setQuantity] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");
  const [tradeError, setTradeError] = useState("");
  const [restart, setRestart] = useState(false);
  const [dock, setDock] = useState<"open" | "closed" | "orders" | "history" | "replay">("open");
  const [dockOpen, setDockOpen] = useState(true);
  const [practice, setPractice] = useState<PracticePosition[] | null>(null);
  const [practiceError, setPracticeError] = useState("");
  const [activity, setActivity] = useState<PracticeBook | null>(null);
  const [brokerNote, setBrokerNote] = useState("");
  const [brokerPositions, setBrokerPositions] = useState<Array<{ symbol: string; qty: string; side: string; avg: string; pnl: string }> | null>(null);
  const [exitSymbol, setExitSymbol] = useState<PracticePosition | null>(null);
  const symbol = desk.symbol;

  useEffect(() => {
    const fromUrl = params.get("symbol");
    if (fromUrl) desk.chooseSymbol(fromUrl);
    const saved = localStorage.getItem("td-replay-session");
    const storedBook = localStorage.getItem("td-replay-book");
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<Replay>;
      setReplay((current) => ({
        ...current,
        active: Boolean(parsed.active),
        day: typeof parsed.day === "string" ? parsed.day : "",
        playhead: typeof parsed.playhead === "number" ? parsed.playhead : null,
        playing: false,
        speed: parsed.speed === 2 || parsed.speed === 4 || parsed.speed === 8 ? parsed.speed : 1,
      }));
    }
    setBook(loadDemoBook(storedBook));
    // The saved session is read once. Later symbol changes come from the desk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem("td-replay-session", JSON.stringify(replay));
  }, [replay]);

  useEffect(() => {
    localStorage.setItem("td-replay-book", JSON.stringify(book));
  }, [book]);

  useEffect(() => {
    setDrawings(loadDrawings(symbol));
    api<Quote>(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`).then((row) => { setQuote(row); setQuoteError(""); }).catch((error: unknown) => {
      setQuote(null);
      setQuoteError(error instanceof Error ? error.message : "Quote unavailable.");
    });
  }, [symbol]);

  useEffect(() => {
    if (query.trim().length < 1) {
      setHits([]);
      return;
    }
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
          setSideQuotes(next);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 8000);
    return () => window.clearInterval(timer);
  }, [lists]);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    api<{ candles: Candle[]; mode: string; source: string; message: string }>(`/api/market/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`)
      .then((data) => {
        if (id !== requestId.current) return;
        setCandles(data.candles);
        setCandleMeta({ mode: data.mode, source: data.source, message: data.message });
        setChartError("");
        setLoading(false);
        setRefreshing(false);
      })
      .catch((error: unknown) => {
        if (id !== requestId.current) return;
        setCandles([]);
        setChartError(error instanceof Error ? error.message : "Chart data unavailable.");
        setLoading(false);
        setRefreshing(false);
      });
  }, [symbol, timeframe, reload]);

  useEffect(() => {
    if (variant !== "positions") return;
    const load = () => {
      api<{ positions: PracticePosition[] }>("/api/portfolio").then((data) => { setPractice(data.positions); setPracticeError(""); }).catch((error: unknown) => {
        setPractice(null);
        setPracticeError(error instanceof Error ? error.message : "Practice positions unavailable.");
      });
      api<PracticeBook>("/api/orders").then(setActivity).catch(() => setActivity(null));
      if (desk.mode === "live") {
        api<{ broker: { positions: unknown; reason: string; liveOrders: string } }>("/api/account").then((data) => {
          setBrokerNote(data.broker.reason);
          setBrokerPositions(brokerRows(data.broker.positions));
        }).catch((error: unknown) => {
          setBrokerPositions(null);
          setBrokerNote(error instanceof Error ? error.message : "Broker positions unavailable.");
        });
      }
    };
    load();
    const timer = window.setInterval(load, 8000);
    return () => window.clearInterval(timer);
  }, [variant, desk.mode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setTradeOpen(false);
      setSettings(false);
      setRestart(false);
      setExitSymbol(null);
      setSearching(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const days = useMemo(() => sessionDays(candles), [candles]);

  useEffect(() => {
    if (!replay.active || !candles.length) return;
    const day = days.includes(replay.day) ? replay.day : days[days.length - 1] ?? "";
    const start = day ? firstCandleOn(candles, day) : null;
    const known = replay.playhead != null && candles.some((candle) => candle.time === replay.playhead);
    if (day === replay.day && (known || start == null)) return;
    setReplay((current) => ({ ...current, day, playhead: known ? current.playhead : start, playing: false }));
  }, [candles, days, replay.active, replay.day, replay.playhead]);

  useEffect(() => {
    if (!replay.active || !replay.playing || replay.playhead == null) return;
    const candle = candles.find((item) => item.time === replay.playhead);
    if (!candle) return;
    setBook((current) => settleDemoOrders(current, symbol, candle, replay.playhead as number, replay.playhead as number));
  }, [replay.active, replay.playing, replay.playhead, candles, symbol]);

  useEffect(() => {
    if (!replay.playing) return;
    const timer = window.setInterval(() => {
      setReplay((current) => {
        const limit = candles.at(-1)?.time ?? null;
        const next = stepPlayhead(candles, current.playhead, 1, limit);
        if (next == null || next === current.playhead) return { ...current, playing: false };
        return { ...current, playhead: next, day: formatDay(next) };
      });
    }, 1000 / replay.speed);
    return () => window.clearInterval(timer);
  }, [replay.playing, replay.speed, candles]);

  const shown = useMemo(() => {
    if (!replay.active) {
      const last = Number(quote?.last);
      return applyLiveTick(candles, timeframe, last, Math.floor(Date.now() / 1000), Boolean(quote?.marketOpen));
    }
    return sliceTo(candles, replay.playhead);
  }, [candles, replay.active, replay.playhead, quote, timeframe]);

  const playCandle = shown.at(-1) ?? null;
  const previous = shown.length > 1 ? shown[shown.length - 2].close : null;
  const replayMove = playCandle && previous != null ? playCandle.close - previous : null;
  const liveMove = moveOf(quote?.last, quote?.previousClose);
  const watched = lists.some((list) => list.items.some((item) => item.symbol === symbol));
  const rail = lists.find((item) => item.items.some((row) => row.symbol === symbol)) ?? lists[0];
  const practiceRow = practice?.find((row) => row.symbol === symbol) ?? null;
  const replayMark = replay.active && playCandle ? Number(rupeesToPaise(playCandle.close.toFixed(2))) : null;
  const openPositions = desk.mode === "live" ? brokerPositions : practice;

  function selectSymbol(next: string) {
    setQuery("");
    setHits([]);
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

  function submitDemo() {
    if (!replay.active || replay.playhead == null) {
      setTradeError("Turn Demo on and choose a historical date before submitting a demo order.");
      return;
    }
    const qty = Number(quantity);
    const limit = orderType === "LIMIT" ? Number(limitPrice) : null;
    const candle = replay.playhead == null ? null : candles.find((item) => item.time === replay.playhead) ?? null;
    const result = placeDemoOrder(book, {
      id: crypto.randomUUID(),
      symbol,
      side,
      type: orderType,
      quantity: qty,
      limitPrice: limit,
      candle,
      playheadTime: replay.playhead,
      revealTime: replay.playhead,
      paused: replay.active ? !replay.playing : true,
    });
    if (!result.ok) {
      setTradeError(result.error);
      return;
    }
    setBook(result.book);
    setTradeError("");
    desk.toast("Demo order updated the replay book only.");
  }

  const priceLabel = replay.active && playCandle ? money(playCandle.close) : quote ? money(quote.last) : "—";
  const changeLabel = replay.active
    ? replayMove == null ? "" : `${replayMove >= 0 ? "+" : ""}${replayMove.toFixed(2)}`
    : liveMove ? `${liveMove.abs >= 0 ? "+" : ""}${liveMove.abs.toFixed(2)} (${liveMove.pct.toFixed(2)}%)` : "";
  const changeTone = replay.active ? tone(replayMove) : tone(liveMove?.abs);
  const stamp = replay.active && playCandle ? `${formatIst(playCandle.time)} · simulated` : quote ? `${freshness(quote, desk.online)} · ${istTime(quote.asOf)}` : quoteError || "Quote unavailable";

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-panel px-3 py-2">
        <StockLogo symbol={symbol} name={rail?.items.find((item) => item.symbol === symbol)?.name} size={36} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span>{symbol}</span>
            <span className="text-[11px] font-normal text-muted">NSE</span>
            {replay.active ? <DemoModeBadge>SIMULATED</DemoModeBadge> : <span className="text-[10px] font-normal text-muted">{quote?.marketOpen ? "Live session" : "Latest available"}</span>}
          </div>
          <div className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="num text-xs">{priceLabel}</span>
            {changeLabel ? <span className={`num text-xs ${changeTone}`}>{changeLabel}</span> : null}
          </div>
          <div className="text-[10px] text-muted">{stamp}</div>
        </div>
        <IconButton label={watched ? "Remove from watchlist" : "Add to watchlist"} active={watched} onClick={toggleWatch}>
          <Star className={`h-4 w-4 ${watched ? "fill-current text-primary" : ""}`} aria-hidden />
        </IconButton>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="toolbar" aria-label="Timeframe">
          {CHART_SPANS.map((span) => (
            <button key={span} type="button" className={`shrink-0 rounded-lg px-2 py-1 text-[11px] ${timeframe === span ? "bg-elevated font-semibold text-text" : "text-muted hover:bg-elevated"}`} aria-pressed={timeframe === span} onClick={() => setTimeframe(span)}>{SPAN_LABEL[span]}</button>
          ))}
        </div>
        <button type="button" className={`rounded-full px-3 py-1 text-xs font-semibold ${replay.active ? "bg-demo text-white" : "border border-demo text-demo"}`} onClick={() => setReplay((current) => ({ ...current, active: !current.active, playing: false }))}>{replay.active ? "Exit demo" : "Demo"}</button>
        <button type="button" className="rounded-full border border-primary px-3 py-1 text-xs font-semibold text-primary" onClick={() => { setTradeOpen(true); setTradeError(""); }}>Demo Trade</button>
        {desk.mode === "live" ? null : <Link className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-white" href={`/terminal?symbol=${symbol}&side=BUY`}>Practice trade</Link>}
        <Link href={`/options?symbol=${encodeURIComponent(symbol)}`} title="Option chain" aria-label="Option chain" className="rounded-full border border-border px-3 py-1 text-xs font-semibold">Option chain</Link>
      </div>
      {settings ? (
        <div className="flex flex-wrap gap-3 border-b border-border bg-panel px-3 py-2 text-xs">
          {(["sma", "ema", "vwap", "volume", "supertrend"] as const).map((flag) => (
            <label key={flag} className="flex items-center gap-1"><input type="checkbox" checked={flags[flag]} onChange={() => setFlags((current) => ({ ...current, [flag]: !current[flag] }))} />{flag.toUpperCase()}</label>
          ))}
          <label>Oscillator <select className="ml-1 py-1" value={flags.oscillator} onChange={(event) => setFlags((current) => ({ ...current, oscillator: event.target.value as Flags["oscillator"] }))}><option value="none">Off</option><option value="rsi">RSI</option><option value="macd">MACD</option></select></label>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <nav className="flex h-12 shrink-0 gap-1 overflow-x-auto border-b border-border bg-panel p-1 lg:h-auto lg:w-12 lg:flex-col lg:items-center lg:overflow-y-auto lg:border-b-0 lg:border-r lg:py-2" aria-label="Chart tools">
          {DRAW_TOOLS.map(({ id, label, icon: Icon }) => (
            <IconButton key={id} label={label} active={tool === id} onClick={() => setTool(id)}><Icon className="h-4 w-4" aria-hidden /></IconButton>
          ))}
          <span className="mx-1 h-5 w-px shrink-0 bg-border lg:mx-0 lg:my-1 lg:h-px lg:w-5" />
          {CHART_TYPES.map(({ id, label, icon: Icon }) => (
            <IconButton key={id} label={label} active={chartType === id} onClick={() => setChartType(id)}><Icon className="h-4 w-4" aria-hidden /></IconButton>
          ))}
          <IconButton label={flags.volume ? "Hide volume" : "Show volume"} active={flags.volume} onClick={() => setFlags((current) => ({ ...current, volume: !current.volume }))}><BarChart3 className="h-4 w-4" aria-hidden /></IconButton>
          <IconButton label="Indicators" active={settings} onClick={() => setSettings((value) => !value)}><Activity className="h-4 w-4" aria-hidden /></IconButton>
          <IconButton label="Zoom in" onClick={() => handleRef.current?.zoom(1)}><ZoomIn className="h-4 w-4" aria-hidden /></IconButton>
          <IconButton label="Zoom out" onClick={() => handleRef.current?.zoom(-1)}><ZoomOut className="h-4 w-4" aria-hidden /></IconButton>
          <IconButton label="Reset chart view" onClick={() => handleRef.current?.reset()}><RotateCcw className="h-4 w-4" aria-hidden /></IconButton>
          <IconButton label={refreshing ? "Refreshing chart" : "Refresh chart"} disabled={refreshing} onClick={() => { setRefreshing(true); setReload((value) => value + 1); }}><RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden /></IconButton>
          <IconButton label={full ? "Exit full screen" : "Full screen"} onClick={() => {
            const node = rootRef.current;
            if (!node) return;
            if (document.fullscreenElement) {
              void document.exitFullscreen();
              setFull(false);
            } else {
              void node.requestFullscreen();
              setFull(true);
            }
          }}>
            {full ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
          </IconButton>
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {replay.active ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-primary/30 bg-cream px-3 py-2 text-xs">
          <DemoModeBadge>DEMO MODE</DemoModeBadge>
          <label>Date <select aria-label="Replay date" className="ml-1 bg-panel py-1" value={replay.day} onChange={(event) => {
            const day = event.target.value;
            setReplay((current) => ({ ...current, day, playhead: firstCandleOn(candles, day), playing: false }));
          }}>{days.map((day) => <option key={day} value={day}>{day}</option>)}</select></label>
          <span className="text-muted">{playCandle ? formatIst(playCandle.time) : "No bar on this date."}</span>
          <IconButton label={replay.playing ? "Pause replay" : "Play replay"} disabled={!playCandle} onClick={() => setReplay((current) => ({ ...current, playing: !current.playing }))}>{replay.playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}</IconButton>
          <IconButton label="Resume replay" disabled={replay.playing || !playCandle} onClick={() => setReplay((current) => ({ ...current, playing: true }))}><Play className="h-4 w-4" aria-hidden /></IconButton>
          <IconButton label="Restart replay" onClick={() => setRestart(true)}><RotateCcw className="h-4 w-4" aria-hidden /></IconButton>
          <label>Speed <select aria-label="Replay speed" className="ml-1 bg-panel py-1" value={replay.speed} onChange={(event) => setReplay((current) => ({ ...current, speed: Number(event.target.value) as Replay["speed"] }))}>{SPEEDS.map((speed) => <option key={speed} value={speed}>{speed}x</option>)}</select></label>
          <span className="text-muted">Replay starts at the first bar of the chosen date. The candle size stays {SPAN_LABEL[timeframe]}.</span>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
            {loading ? <p className="p-4 text-sm text-muted">Loading chart…</p> : null}
            {chartError ? <p className="p-4 text-sm text-loss">{chartError}</p> : null}
            {!loading && !chartError && shown.length === 0 ? <p className="p-4 text-sm text-muted">{replay.active ? "No candle is visible at this replay time." : "No candles were returned for this symbol and interval."}</p> : null}
            {shown.length > 0 ? (
              <ChartPanel
                candles={shown}
                compare={[]}
                chartType={chartType}
                showSma={flags.sma}
                showEma={flags.ema}
                showBands={flags.bands}
                showVwap={flags.vwap}
                showVolume={flags.volume}
                showSupertrend={flags.supertrend}
                indicators={indicators}
                oscillator={flags.oscillator}
                tool={tool}
                annotation=""
                drawings={drawings}
                onDrawings={(next) => { setDrawings(next); saveDrawings(symbol, next); }}
                handleRef={handleRef}
                scheme={desk.theme}
                streamKey={`${symbol}-${timeframe}-${replay.active ? "replay" : "live"}`}
              />
            ) : null}
          </div>
          <p className="border-t border-border px-3 py-1 text-[11px] text-muted">{stamp}{candleMeta.mode ? ` · ${candleMeta.mode}` : ""} {candleMeta.message}</p>
          {variant === "positions" ? (
            <section className="border-t border-border bg-panel">
              <div className="flex items-center gap-2 px-3 py-1 text-xs">
                {(["open", "closed", "orders", "history", "replay"] as const).map((tab) => (
                  <button key={tab} className={dock === tab ? "font-semibold text-text" : "text-muted"} onClick={() => { setDock(tab); setDockOpen(true); }}>{tab === "open" ? "Open" : tab === "closed" ? "Closed" : tab === "orders" ? "Orders" : tab === "history" ? "History" : "Replay book"}</button>
                ))}
                <button className="ml-auto text-muted" onClick={() => setDockOpen((value) => !value)}>{dockOpen ? "Collapse" : "Expand"}</button>
              </div>
              {dockOpen ? (
                <div className="max-h-52 overflow-auto px-3 pb-2">
                  {dock === "open" ? <OpenTable mode={desk.mode} practice={practice} practiceError={practiceError} broker={brokerPositions} brokerNote={brokerNote} onPick={selectSymbol} selected={symbol} /> : null}
                  {dock === "closed" ? <ClosedTable rows={(activity?.executions ?? []).filter((row) => Number(row.realized) !== 0)} onPick={selectSymbol} /> : null}
                  {dock === "orders" ? <OrderTable mode={desk.mode} rows={activity?.orders ?? []} note={brokerNote} onPick={selectSymbol} /> : null}
                  {dock === "history" ? <HistoryTable rows={activity?.executions ?? []} onPick={selectSymbol} /> : null}
                  {dock === "replay" ? <ReplayTable book={book} mark={replayMark} symbol={symbol} onPick={selectSymbol} onCancel={(id) => setBook((current) => cancelDemoOrder(current, id))} /> : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
        </div>
        <aside className="flex h-64 w-full shrink-0 flex-col overflow-hidden border-t border-border bg-panel lg:h-auto lg:w-72 lg:border-l lg:border-t-0">
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
            {searching && hits.length >= 50 ? <button className="mt-1 w-full px-3 py-1 text-left text-xs text-primary" onClick={() => setSkip((value) => value + 50)}>Load more</button> : null}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {(rail?.items.length ?? 0) === 0 ? <p className="p-3 text-xs text-muted">This watchlist has no symbols. Search above and use the star to add one.</p> : rail?.items.map((item) => {
              const rowQuote = sideQuotes[item.symbol];
              const move = moveOf(rowQuote?.last, rowQuote?.previousClose);
              const selected = item.symbol === symbol;
              return (
                <div key={item.symbol} className={`flex items-center gap-1 border-b border-border pr-1 ${selected ? "bg-elevated" : ""}`}>
                  <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left hover:bg-elevated" onClick={() => selectSymbol(item.symbol)}>
                    <SymbolTitle symbol={item.symbol} name={item.name} size={28} />
                    <span className="ml-auto shrink-0 text-right">
                      <span className={`num block whitespace-nowrap text-xs ${tone(move?.abs)}`}>{rowQuote ? money(rowQuote.last) : "…"}</span>
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
              <p className="mt-1 text-[11px] text-muted">{desk.mode === "live" ? "Read-only broker snapshot." : "Practice ledger. Long only. This is not a broker position."}</p>
              {desk.mode === "live" ? (
                openPositions && openPositions.length === 0 ? <EmptyPositions onTrade={() => setTradeOpen(true)} symbol={symbol} live /> : <BrokerDetail rows={brokerPositions} symbol={symbol} note={brokerNote} />
              ) : practiceRow ? <PracticeDetail row={practiceRow} onExit={() => setExitSymbol(practiceRow)} /> : (
                <div className="mt-3 text-sm">
                  <p>No open practice position for {symbol}.</p>
                  {practiceError ? <p className="mt-2 text-xs text-loss">{practiceError}</p> : null}
                </div>
              )}
            </div>
          ) : null}
        </aside>
      </div>
      {tradeOpen ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><StockLogo symbol={symbol} size={28} /> DEMO TRADE · {symbol}</h2>
              <button type="button" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-elevated" aria-label="Close demo trade" title="Close" onClick={() => setTradeOpen(false)}><X className="h-4 w-4" aria-hidden /></button>
            </div>
            <p className="mt-1 text-xs text-muted">This order stays in the browser replay book. It is not sent to the practice ledger or to a broker.</p>
            {!replay.active ? <p className="mt-2 text-xs text-loss">Turn Demo on and choose a historical date before a market order can fill.</p> : null}
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <button className={`rounded-full py-1 ${side === "BUY" ? "bg-profit text-white" : "border border-border"}`} onClick={() => setSide("BUY")}>Buy</button>
              <button className={`rounded-full py-1 ${side === "SELL" ? "bg-loss text-white" : "border border-border"}`} onClick={() => setSide("SELL")}>Sell</button>
              <label className="text-xs text-muted">Quantity<input className="mt-1 w-full" value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="numeric" /></label>
              <label className="text-xs text-muted">Type<select className="mt-1 w-full" value={orderType} onChange={(event) => setOrderType(event.target.value as "MARKET" | "LIMIT")}><option value="MARKET">Market</option><option value="LIMIT">Limit</option></select></label>
              {orderType === "LIMIT" ? <label className="col-span-2 text-xs text-muted">Limit price<input className="mt-1 w-full" value={limitPrice} onChange={(event) => setLimitPrice(event.target.value)} inputMode="decimal" /></label> : null}
            </div>
            <p className="mt-3 text-xs text-muted">Available ₹{formatDemoRupees(book.cashPaise)}. {estimate(orderType, side, quantity, limitPrice, playCandle?.close ?? null, book.cashPaise)} A market fill uses the replay candle close. A limit fill uses the limit only after that price trades on the revealed candle. Playback is {replay.playing ? "running" : "paused"}.</p>
            {tradeError ? <p className="mt-2 text-xs text-loss">{tradeError}</p> : null}
            <button className="mt-3 w-full rounded-full bg-demo py-2 text-sm font-semibold text-white" onClick={submitDemo}>Submit demo order</button>
          </div>
        </div>
      ) : null}
      {exitSymbol ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-4 text-sm">
            <h2 className="font-semibold">Exit {exitSymbol.symbol}?</h2>
            <p className="mt-2 text-xs text-muted">Places a practice market sell for {exitSymbol.quantity} shares. This uses the practice ledger, not the replay book, and it is not sent to a broker.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded-full border border-border px-3 py-1 text-xs" onClick={() => setExitSymbol(null)}>Back</button>
              <button className="rounded-full bg-loss px-3 py-1 text-xs text-white" onClick={() => {
                void api<{ status?: string; message?: string }>("/api/orders", { symbol: exitSymbol.symbol, side: "SELL", type: "MARKET", quantity: exitSymbol.quantity, idempotencyKey: crypto.randomUUID().replace(/-/g, "").slice(0, 20) })
                  .then((result) => { desk.toast(`${exitSymbol.symbol} ${result.status ?? "sent"}. ${result.message ?? ""}`); setExitSymbol(null); })
                  .catch((error: unknown) => desk.toast(error instanceof Error ? error.message : "Exit failed."));
              }}>Sell practice position</button>
            </div>
          </div>
        </div>
      ) : null}
      {restart ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-4 text-sm">
            <h2 className="font-semibold">Restart this replay?</h2>
            <p className="mt-2 text-xs text-muted">Returning to the session open keeps the demo book. Resetting the book clears this browser’s replay cash, positions, and orders. Neither action changes the practice ledger.</p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button className="rounded-full border border-border px-3 py-1 text-xs" onClick={() => setRestart(false)}>Cancel</button>
              <button className="rounded-full border border-border px-3 py-1 text-xs" onClick={() => { setReplay((current) => ({ ...current, playhead: firstCandleOn(candles, current.day), playing: false })); setRestart(false); }}>Return to start</button>
              <button className="rounded-full bg-loss px-3 py-1 text-xs text-white" onClick={() => { setBook(emptyDemoBook()); setReplay((current) => ({ ...current, playhead: firstCandleOn(candles, current.day), playing: false })); setRestart(false); }}>Reset demo book</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function estimate(type: "MARKET" | "LIMIT", side: "BUY" | "SELL", quantity: string, limit: string, close: number | null, cashPaise: number) {
  const qty = Number(quantity);
  const price = type === "LIMIT" ? Number(limit) : close;
  if (!Number.isInteger(qty) || qty <= 0 || price == null || !Number.isFinite(price) || price <= 0) return "Enter a quantity to estimate the order.";
  const paise = Number(rupeesToPaise(price.toFixed(2)));
  const notional = paise * qty;
  const charges = Number(calculateCharges(side, BigInt(paise) * BigInt(qty), DEFAULT_CHARGES).total);
  const remaining = side === "BUY" ? cashPaise - notional - charges : cashPaise + notional - charges;
  return `Estimated value ₹${formatDemoRupees(notional)}. Fees ₹${formatDemoRupees(charges)}. Remaining cash ₹${formatDemoRupees(remaining)}.`;
}

function formatDay(unix: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(unix * 1000));
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
    <button className="mt-3 rounded-full bg-loss px-3 py-1 text-xs text-white" onClick={onExit}>Exit practice position</button>
    </>
  );
}

function BrokerDetail({ rows, symbol, note }: { rows: Array<{ symbol: string; qty: string; side: string; avg: string; pnl: string }> | null; symbol: string; note: string }) {
  const row = rows?.find((item) => item.symbol === symbol) ?? null;
  if (!rows) return <p className="mt-3 text-xs text-muted">{note || "The broker did not return a position list."}</p>;
  if (!row) return <p className="mt-3 text-sm">No broker position is open for {symbol}.</p>;
  return (
    <dl className="mt-3 space-y-1 text-xs">
      <Row label="Symbol" value={row.symbol} />
      <Row label="Direction" value={row.side} />
      <Row label="Net quantity" value={row.qty} />
      <Row label="Average" value={row.avg} />
      <Row label="Unrealized" value={row.pnl} />
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3 border-b border-border py-1"><dt className="text-muted">{label}</dt><dd className="num text-right">{value}</dd></div>;
}

function OpenTable({ mode, practice, practiceError, broker, brokerNote, onPick, selected }: { mode: "demo" | "live"; practice: PracticePosition[] | null; practiceError: string; broker: Array<{ symbol: string; qty: string; side: string; avg: string; pnl: string }> | null; brokerNote: string; onPick: (symbol: string) => void; selected: string }) {
  if (mode === "live") {
    if (!broker) return <p className="py-3 text-xs text-muted">{brokerNote || "Broker positions are unavailable."}</p>;
    if (broker.length === 0) return <p className="py-3 text-xs text-muted">No open broker positions were returned.</p>;
    return (
      <table className="text-xs"><thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg</th><th>Unrealized</th></tr></thead><tbody>
        {broker.map((row) => <tr key={row.symbol} className={row.symbol === selected ? "bg-elevated" : ""}><td><button className="inline-flex items-center gap-2 text-primary" onClick={() => onPick(row.symbol)}><StockLogo symbol={row.symbol} size={22} />{row.symbol}</button></td><td>{row.side}</td><td className="num">{row.qty}</td><td className="num">{row.avg}</td><td className="num">{row.pnl}</td></tr>)}
      </tbody></table>
    );
  }
  if (practiceError) return <p className="py-3 text-xs text-loss">{practiceError}</p>;
  if (!practice) return <p className="py-3 text-xs text-muted">Loading practice positions…</p>;
  if (practice.length === 0) return <p className="py-3 text-xs text-muted">No open practice positions. Search a stock above, open its chart, or use Practice trade. Nothing here is a filled order until you confirm one.</p>;
  return (
    <table className="text-xs"><thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>Last</th><th>Unrealized</th></tr></thead><tbody>
      {practice.map((row) => <tr key={row.symbol} className={row.symbol === selected ? "bg-elevated" : ""}><td><button className="inline-flex items-center gap-2 text-primary" onClick={() => onPick(row.symbol)}><StockLogo symbol={row.symbol} name={row.name} size={22} />{row.symbol}</button></td><td className="num">{row.quantity}</td><td className="num">{row.averageCost}</td><td className="num">{row.mark ?? "—"}</td><td className="num">{row.unrealized ?? "—"}</td></tr>)}
    </tbody></table>
  );
}

function ClosedTable({ rows, onPick }: { rows: PracticeBook["executions"]; onPick: (symbol: string) => void }) {
  if (rows.length === 0) return <p className="py-3 text-xs text-muted">No closing fills are stored. The practice ledger keeps one long position and does not keep a separate closed-position book.</p>;
  return <HistoryTable rows={rows} onPick={onPick} />;
}

function OrderTable({ mode, rows, note, onPick }: { mode: "demo" | "live"; rows: PracticeBook["orders"]; note: string; onPick: (symbol: string) => void }) {
  if (mode === "live") return <p className="py-3 text-xs text-muted">Live broker orders stay unavailable. {note}</p>;
  if (rows.length === 0) return <p className="py-3 text-xs text-muted">No practice orders.</p>;
  return (
    <table className="text-xs"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Status</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}><td>{istTime(row.submittedAt)}</td><td><button className="inline-flex items-center gap-2 text-primary" onClick={() => onPick(row.symbol)}><StockLogo symbol={row.symbol} size={22} />{row.symbol}</button></td><td className={row.side === "BUY" ? "up" : "down"}>{row.side}</td><td className="num">{row.quantity}</td><td title={row.reason ?? ""}><OrderStatus status={row.status} /></td></tr>)}
    </tbody></table>
  );
}

function HistoryTable({ rows, onPick }: { rows: PracticeBook["executions"]; onPick: (symbol: string) => void }) {
  if (rows.length === 0) return <p className="py-3 text-xs text-muted">No practice fills.</p>;
  return (
    <table className="text-xs"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Realized</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}><td>{istTime(row.executedAt)}</td><td><button className="text-primary" onClick={() => onPick(row.symbol)}>{row.symbol}</button></td><td>{row.side}</td><td className="num">{row.quantity}</td><td className="num">{row.price}</td><td className="num">{row.realized}</td></tr>)}
    </tbody></table>
  );
}

function ReplayTable({ book, mark, symbol, onPick, onCancel }: { book: DemoBook; mark: number | null; symbol: string; onPick: (symbol: string) => void; onCancel: (id: string) => void }) {
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted">Cash ₹{formatDemoRupees(book.cashPaise)} · Realized ₹{formatDemoRupees(book.realizedPaise)}. This book is stored in this browser.</p>
      {book.positions.length === 0 ? <p className="text-muted">No replay positions.</p> : (
        <table><thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>Unrealized</th></tr></thead><tbody>
          {book.positions.map((row) => <tr key={row.symbol}><td><button className="text-primary" onClick={() => onPick(row.symbol)}>{row.symbol}</button></td><td className="num">{row.quantity}</td><td className="num">{formatDemoRupees(row.avgPaise)}</td><td className="num">{row.symbol === symbol && mark != null ? formatDemoRupees((mark - row.avgPaise) * row.quantity) : "—"}</td></tr>)}
        </tbody></table>
      )}
      {book.orders.filter((order) => order.status === "OPEN").map((order) => (
        <p key={order.id}>{order.side} {order.quantity} {order.symbol} {order.type} {order.reason} <button className="text-loss" onClick={() => onCancel(order.id)}>Cancel</button></p>
      ))}
    </div>
  );
}

function EmptyPositions({ onTrade, symbol, live }: { onTrade: () => void; symbol: string; live: boolean }) {
  return (
    <div className="mt-3 text-sm">
      <p>{live ? "No open broker positions were returned." : `No open position for ${symbol}.`}</p>
      <p className="mt-2 text-xs text-muted">Search a symbol above to load its chart. Opening a chart does not place an order.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="rounded-full border border-primary px-3 py-1 text-xs text-primary" onClick={onTrade}>Demo Trade</button>
        <Link className="rounded-full bg-primary px-3 py-1 text-xs text-white" href={`/terminal?symbol=${symbol}&side=BUY`}>Practice trade</Link>
      </div>
    </div>
  );
}
