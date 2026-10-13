"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { bollinger, ema, macd, rsi, sma, supertrend, toLine, vwap } from "@/lib/market/indicators";
import { themeColor, withAlpha } from "@/lib/theme";

import { DrawingLayer } from "@/components/drawing-layer";
import type { Drawing, DrawTool } from "@/components/drawing-model";

export type { Drawing, DrawTool } from "@/components/drawing-model";
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type ChartType = "candle" | "bar" | "line" | "area";

const UP = "#089981";
const DOWN = "#f23645";

export type ChartHandle = { fit: () => void; reset: () => void; png: (name: string) => void; range: (bars: number | null) => void; zoom: (direction: -1 | 1) => void };
export type ChartScheme = "dark" | "light";
export type IndicatorSettings = {
  smaFast: number;
  smaSlow: number;
  ema: number;
  bandsPeriod: number;
  bandsMult: number;
  rsi: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  supertrendPeriod: number;
  supertrendMult: number;
};

export const DEFAULT_INDICATORS: IndicatorSettings = {
  smaFast: 20,
  smaSlow: 50,
  ema: 21,
  bandsPeriod: 20,
  bandsMult: 2,
  rsi: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  supertrendPeriod: 10,
  supertrendMult: 3,
};

export function ChartPanel({
  candles,
  compare,
  chartType,
  showSma,
  showEma,
  showBands,
  showVwap,
  showVolume,
  showSupertrend = false,
  indicators = DEFAULT_INDICATORS,
  oscillator,
  tool,
  annotation,
  drawings,
  onDrawings,
  handleRef,
  streamKey = "chart",
  magnet = false,
  hidden = false,
  command = null,
  enabled = true,
  onTool = () => undefined,
  onSelect,
  scheme = "dark",
  onHover,
  follow = false,
  focusToken = 0,
}: {
  candles: Candle[];
  compare: Candle[];
  chartType: ChartType;
  showSma: boolean;
  showEma: boolean;
  showBands: boolean;
  showVwap: boolean;
  showVolume: boolean;
  showSupertrend?: boolean;
  indicators?: IndicatorSettings;
  oscillator: "none" | "rsi" | "macd";
  tool: DrawTool;
  annotation: string;
  drawings: Drawing[];
  onDrawings: (next: Drawing[], undo?: boolean) => void;
  handleRef?: { current: ChartHandle | null };
  streamKey?: string;
  magnet?: boolean;
  hidden?: boolean;
  command?: { id: number; name: "lock" | "trash" | "color" } | null;
  enabled?: boolean;
  onTool?: (tool: DrawTool) => void;
  onSelect?: (id: string | null) => void;
  scheme?: ChartScheme;
  onHover?: (candle: Candle | null) => void;
  follow?: boolean;
  focusToken?: number;
}) {
  const priceRef = useRef<HTMLDivElement>(null);
  const oscRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const oscChartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const candlesRef = useRef(candles);
  const paintedCount = useRef(0);
  const schemeRef = useRef(scheme);
  const [hover, setHover] = useState<Candle | null>(null);
  const onHoverRef = useRef(onHover);
  const focusedToken = useRef(0);
  onHoverRef.current = onHover;
  const [chartEpoch, setChartEpoch] = useState(0);
  schemeRef.current = scheme;
  candlesRef.current = candles;
  const loaded = candles.length > 0;
  const compareRef = useRef(compare);
  compareRef.current = compare;
  const compareKey = compare.map((candle) => `${candle.time}:${candle.close}`).join("|");

  useEffect(() => {
    const rows = candlesRef.current;
    if (!priceRef.current || !rows.length) return;
    const chart = mountChart(priceRef.current, schemeRef.current);
    chartRef.current = chart;
    const series = addMainSeries(chart, chartType);
    seriesRef.current = series;
    const bars = rows.map((candle) => ({ ...candle, time: candle.time as UTCTimestamp }));
    if (chartType === "line" || chartType === "area") series.setData(bars.map((bar) => ({ time: bar.time, value: bar.close })));
    else series.setData(bars);

    if (showVolume) {
      const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false });
      volumeRef.current = volume;
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volume.setData(bars.map((bar) => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)" })));
    }

    const closes = rows.map((candle) => candle.close);
    const times = rows.map((candle) => candle.time);
    const overlay = (color: string, values: Array<number | null>) => {
      const line = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      line.setData(toLine(times, values).map((point) => ({ ...point, time: point.time as UTCTimestamp })));
    };
    if (showSma) {
      overlay(themeColor("--primary", "#3B82F6"), sma(closes, Math.max(2, indicators.smaFast)));
      overlay("#F0B90B", sma(closes, Math.max(2, indicators.smaSlow)));
    }
    if (showEma) overlay("#B39DDB", ema(closes, Math.max(2, indicators.ema)));
    if (showBands) {
      const bands = bollinger(closes, Math.max(2, indicators.bandsPeriod), indicators.bandsMult);
      overlay("rgba(120,123,134,0.9)", bands.middle);
      overlay("rgba(120,123,134,0.9)", bands.upper);
      overlay("rgba(120,123,134,0.9)", bands.lower);
    }
    if (showVwap) overlay(themeColor("--profit", "#10B981"), vwap(rows));
    if (showSupertrend) overlay("#F0B90B", supertrend(rows, Math.max(2, indicators.supertrendPeriod), indicators.supertrendMult));
    const compared = compareRef.current;
    if (compared.length) {
      const line = chart.addSeries(LineSeries, { color: "#F0B90B", lineWidth: 1, priceScaleId: "left", priceLineVisible: false, lastValueVisible: true });
      line.setData(compared.map((candle) => ({ time: candle.time as UTCTimestamp, value: candle.close })));
    }

    let oscillatorChart: IChartApi | null = null;
    if (oscillator !== "none" && oscRef.current) {
      oscillatorChart = mountChart(oscRef.current, schemeRef.current);
      if (oscillator === "rsi") {
        const line = oscillatorChart.addSeries(LineSeries, { color: "#B39DDB", lineWidth: 1 });
        line.setData(toLine(times, rsi(closes, Math.max(2, indicators.rsi))).map((point) => ({ ...point, time: point.time as UTCTimestamp })));
        line.createPriceLine({ price: 70, color: themeColor("--muted", "#94A3B8"), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" });
        line.createPriceLine({ price: 30, color: themeColor("--muted", "#94A3B8"), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" });
      } else {
        const result = macd(closes, Math.max(2, indicators.macdFast), Math.max(3, indicators.macdSlow), Math.max(2, indicators.macdSignal));
        const line = oscillatorChart.addSeries(LineSeries, { color: themeColor("--primary", "#D4AF37"), lineWidth: 1 });
        const signal = oscillatorChart.addSeries(LineSeries, { color: "#F0B90B", lineWidth: 1 });
        line.setData(toLine(times, result.macd).map((point) => ({ ...point, time: point.time as UTCTimestamp })));
        signal.setData(toLine(times, result.signal).map((point) => ({ ...point, time: point.time as UTCTimestamp })));
      }
      oscillatorChart.timeScale().fitContent();
    }
    chart.applyOptions({ leftPriceScale: { visible: compareRef.current.length > 0, borderColor: chartPalette(schemeRef.current).border } });
    const lastBar = rows.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, lastBar - 140), to: lastBar + 2 });
    oscChartRef.current = oscillatorChart;
    setChartEpoch((value) => value + 1);
    if (handleRef) {
      handleRef.current = {
        fit: () => chart.timeScale().fitContent(),
        reset: () => {
          chart.timeScale().applyOptions({ barSpacing: 6 });
          chart.timeScale().fitContent();
        },
        png: (name: string) => { void saveChartImage(chart, priceRef.current?.parentElement ?? null, name); },
        range: (bars: number | null) => {
          if (bars == null) {
            chart.timeScale().fitContent();
            return;
          }
          const last = candlesRef.current.length;
          chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, last - bars), to: last + 1 });
        },
        zoom: (direction) => {
          const current = chart.timeScale().options().barSpacing ?? 9;
          const next = Math.min(48, Math.max(2, current * (direction > 0 ? 1.3 : 0.77)));
          chart.timeScale().applyOptions({ barSpacing: next });
        },
      };
    }

    return () => {
      chart.remove();
      oscillatorChart?.remove();
      chartRef.current = null;
      oscChartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
    };
  }, [streamKey, loaded, chartType, compareKey, handleRef, oscillator, showBands, showEma, showSma, showVolume, showVwap, showSupertrend, indicators]);

  useEffect(() => {
    const series = seriesRef.current;
    const last = candles.at(-1);
    if (!series || !last) return;
    const time = last.time as UTCTimestamp;
    const grewBy = candles.length - paintedCount.current;
    try {
      if (paintedCount.current > 0 && (grewBy > 1 || grewBy < 0)) {
        const bars = candles.map((candle) => ({ ...candle, time: candle.time as UTCTimestamp }));
        if (chartType === "line" || chartType === "area") series.setData(bars.map((bar) => ({ time: bar.time, value: bar.close })));
        else series.setData(bars);
        if (volumeRef.current) volumeRef.current.setData(bars.map((bar) => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)" })));
      } else {
        if (chartType === "line" || chartType === "area") series.update({ time, value: last.close });
        else series.update({ time, open: last.open, high: last.high, low: last.low, close: last.close });
        volumeRef.current?.update({ time, value: last.volume, color: last.close >= last.open ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)" });
      }
      paintedCount.current = candles.length;
    } catch { /* The chart was replaced while this tick arrived. */ }
  }, [candles, chartEpoch, chartType]);

  useEffect(() => {
    if (!follow) return;
    const chart = chartRef.current;
    if (!chart || candles.length < 2) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const span = range.to - range.from;
    if (span <= 0 || range.to < candles.length - 4) return;
    const edge = candles.length + 2;
    chart.timeScale().setVisibleLogicalRange({ from: edge - span, to: edge });
  }, [follow, candles, chartEpoch]);

  useEffect(() => {
    if (!focusToken || focusedToken.current === focusToken) return;
    const chart = chartRef.current;
    if (!chart || !candles.length) return;
    focusedToken.current = focusToken;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - 90), to: candles.length + 3 });
  }, [focusToken, chartEpoch, candles]);

  useEffect(() => {
    const options = chartThemeOptions(chartPalette(scheme));
    chartRef.current?.applyOptions(options);
    oscChartRef.current?.applyOptions(options);
  }, [scheme, chartEpoch]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onMove = (param: MouseEventParams) => {
      const bar = typeof param.time === "number" ? candles.find((item) => item.time === param.time) ?? null : null;
      setHover(bar);
      onHoverRef.current?.(bar);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
  }, [candles, chartType, compare, oscillator, showBands, showEma, showSma, showVolume, showVwap, showSupertrend, indicators]);

  if (!candles.length) return <div className="grid h-full min-h-64 place-items-center text-sm text-muted">No candles for this symbol and timeframe.</div>;
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-panel">
      <p className="sr-only">{hover ? candleCaption(hover, previousClose(candles, hover)) : "Chart"}</p>
      <div className="relative min-h-0 w-full flex-1 overflow-hidden">
        <div ref={priceRef} className="absolute inset-0" />
        <CandleReadout candles={candles} hover={hover} />
        <DrawingLayer chartRef={chartRef} seriesRef={seriesRef} candles={candles} drawings={drawings} onDrawings={onDrawings} tool={tool} magnet={magnet} hidden={hidden} annotation={annotation} command={command} enabled={enabled} onTool={onTool} onSelect={onSelect} ready={chartEpoch} />
      </div>
      {oscillator !== "none" ? <div ref={oscRef} className="h-28 w-full shrink-0 border-t border-border" /> : null}
    </div>
  );
}

function previousClose(candles: Candle[], bar: Candle): number {
  const index = candles.findIndex((item) => item.time === bar.time);
  return index > 0 ? candles[index - 1].close : bar.open;
}

function candleCaption(bar: Candle, basis: number): string {
  const change = bar.close - basis;
  const percent = basis ? (change / basis) * 100 : 0;
  const when = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(bar.time * 1000));
  const sign = change > 0 ? "+" : "";
  return `${when} IST Open ${bar.open.toFixed(2)} High ${bar.high.toFixed(2)} Low ${bar.low.toFixed(2)} Close ${bar.close.toFixed(2)} Volume ${bar.volume} ${sign}${change.toFixed(2)} ${sign}${percent.toFixed(2)} percent`;
}

function CandleReadout({ candles, hover }: { candles: Candle[]; hover: Candle | null }) {
  const bar = hover ?? candles.at(-1);
  if (!bar) return null;
  const basis = previousClose(candles, bar);
  const change = bar.close - basis;
  const percent = basis ? (change / basis) * 100 : 0;
  const when = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(bar.time * 1000));
  const up = change > 0;
  const down = change < 0;
  const sign = up ? "+" : "";
  return (
    <div className="pointer-events-none absolute right-20 top-2 z-10 max-w-[16rem] border border-border bg-panel/95 px-2 py-1 font-mono text-[10px] leading-4 text-text">
      <p>{when} IST</p>
      <p><span className="text-muted">O</span> {bar.open.toFixed(2)} <span className="text-muted">H</span> {bar.high.toFixed(2)} <span className="text-muted">L</span> {bar.low.toFixed(2)} <span className="text-muted">C</span> {bar.close.toFixed(2)}</p>
      <p><span className="text-muted">Vol</span> {new Intl.NumberFormat("en-IN").format(bar.volume)} <span className={down ? "text-loss" : up ? "text-profit" : "text-muted"}>{sign}{change.toFixed(2)} ({sign}{percent.toFixed(2)}%)</span></p>
    </div>
  );
}

function addMainSeries(chart: IChartApi, chartType: ChartType): ISeriesApi<SeriesType> {
  const accent = "#2962ff";
  if (chartType === "line") return chart.addSeries(LineSeries, { color: accent, lineWidth: 2, priceLineVisible: false });
  if (chartType === "area") return chart.addSeries(AreaSeries, { lineColor: accent, topColor: withAlpha(accent, 0.28), bottomColor: withAlpha(accent, 0.02), lineWidth: 2, priceLineVisible: false });
  if (chartType === "bar") return chart.addSeries(BarSeries, { upColor: UP, downColor: DOWN, priceLineVisible: false });
  return chart.addSeries(CandlestickSeries, {
    upColor: UP,
    downColor: DOWN,
    borderVisible: false,
    wickUpColor: UP,
    wickDownColor: DOWN,
    priceLineVisible: false,
  });
}

function chartPalette(scheme: ChartScheme) {
  if (scheme === "light") {
    return { background: "#ffffff", text: "#131722", grid: "#f0f3fa", border: "#e0e3eb", cross: "#9598a1", label: "#131722" };
  }
  return { background: "#131722", text: "#d1d4dc", grid: "#2a2e39", border: "#2a2e39", cross: "#758696", label: "#363a45" };
}

function chartThemeOptions(colors: ReturnType<typeof chartPalette>) {
  return {
    layout: { background: { type: ColorType.Solid, color: colors.background }, textColor: colors.text },
    grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
    crosshair: {
      vertLine: { color: colors.cross, labelBackgroundColor: colors.label },
      horzLine: { color: colors.cross, labelBackgroundColor: colors.label },
    },
    rightPriceScale: { borderColor: colors.border },
    leftPriceScale: { borderColor: colors.border },
    timeScale: { borderColor: colors.border },
  };
}

function mountChart(container: HTMLDivElement, scheme: ChartScheme) {
  const colors = chartPalette(scheme);
  return createChart(container, {
    autoSize: true,
    layout: { ...chartThemeOptions(colors).layout, fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 10, attributionLogo: false },
    grid: chartThemeOptions(colors).grid,
    localization: {
      timeFormatter: (time: Time) => (typeof time === "number"
        ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(time * 1000))
        : ""),
    },
    crosshair: { mode: 1, vertLine: { ...chartThemeOptions(colors).crosshair.vertLine, style: LineStyle.Dashed, width: 1 }, horzLine: { ...chartThemeOptions(colors).crosshair.horzLine, style: LineStyle.Dashed, width: 1 } },
    rightPriceScale: { borderColor: colors.border, minimumWidth: 84, entireTextOnly: true },
    leftPriceScale: { visible: false, borderColor: colors.border },
    handleScroll: true,
    handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
    timeScale: { borderColor: colors.border, timeVisible: true, barSpacing: 9 },
  });
}

async function saveChartImage(chart: IChartApi, host: HTMLElement | null, name: string) {
  const shot = chart.takeScreenshot();
  const svg = host?.querySelector("svg");
  if (svg && host) {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const box = host.getBoundingClientRect();
    clone.setAttribute("width", String(Math.max(1, box.width)));
    clone.setAttribute("height", String(Math.max(1, box.height)));
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" }));
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Drawing export failed"));
        img.src = url;
      });
      shot.getContext("2d")?.drawImage(img, 0, 0, shot.width, shot.height);
    } catch {
      // The candle image still downloads if the drawing overlay cannot be painted.
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const link = document.createElement("a");
  link.href = shot.toDataURL("image/png");
  link.download = `${name}.png`;
  link.click();
}
