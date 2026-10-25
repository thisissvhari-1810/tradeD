"use client";

import { useLatest } from "@/components/use-hydrated";
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
  TickMarkType,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesMarkersPluginApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { bollinger, ema, macd, rsi, sma, supertrend, toLine, vwap } from "@/lib/market/indicators";
import { cx } from "@/components/ui";
import { axisFontSize, themeColor, withAlpha } from "@/lib/theme";
import { emptyAppearance, type ChartPaint } from "@/lib/color/appearance";

import { DrawingLayer } from "@/components/drawing-layer";
import type { CursorStyle, Drawing, DrawTool, MagnetMode } from "@/components/drawing-model";

export type { Drawing, DrawTool } from "@/components/drawing-model";
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type ChartReference = { price: number; title: string; color: string; style?: "dashed" | "dotted" };
/** A trade event on the chart (e.g. an algo entry or exit). Drawn on the displayed bar containing `time`. */
export type ChartMarker = { id: string; time: number; position: "aboveBar" | "belowBar"; shape: "arrowUp" | "arrowDown" | "circle" | "square"; color: string; text: string; size?: number };
export type ChartType = "candle" | "bar" | "line" | "area";

export type ChartHandle = { fit: () => void; reset: () => void; png: (name: string) => void; range: (bars: number | null) => void; zoom: (direction: -1 | 1) => void; focus?: (from: number, to: number) => void };
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
  span = "1d",
  focusId,
  scheme = "dark",
  onHover,
  follow = false,
  focusToken = 0,
  references = [],
  markers = [],
  onMarkerClick,
  onMarkerHover,
  paint,
  stay = false,
  overlays,
  lockAll = false,
  cursorStyle = "cross",
  pageScroll = false,
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
  magnet?: MagnetMode | boolean;
  stay?: boolean;
  /** Read-only strategy drawings (S1). */
  overlays?: Drawing[];
  lockAll?: boolean;
  cursorStyle?: CursorStyle;
  hidden?: boolean;
  command?: { id: number; name: "lock" | "trash" | "color" } | null;
  enabled?: boolean;
  onTool?: (tool: DrawTool) => void;
  onSelect?: (id: string | null) => void;
  span?: string;
  focusId?: string | null;
  scheme?: ChartScheme;
  onHover?: (candle: Candle | null) => void;
  follow?: boolean;
  focusToken?: number;
  references?: ChartReference[];
  markers?: ChartMarker[];
  /** A click on a bar that carries trade markers: their ids and the click point within the chart. */
  onMarkerClick?: (ids: string[], point: { x: number; y: number }) => void;
  /** The pointer is over a bar with trade markers (their ids and the point), or left it (null). */
  onMarkerHover?: (hit: { ids: string[]; x: number; y: number } | null) => void;
  paint?: ChartPaint;
  /** The chart sits in a scrolling page (Positions on phones): vertical swipes scroll the page, not the chart. */
  pageScroll?: boolean;
}) {
  const colors = paint ?? emptyAppearance(scheme === "light" ? "light" : "classic").chart;
  const paintRef = useLatest(colors);
  const paintKey = JSON.stringify(colors);
  const priceRef = useRef<HTMLDivElement>(null);
  const oscRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const oscChartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const overlaySeries = useRef<Array<ISeriesApi<SeriesType>>>([]);
  const referenceLines = useRef<IPriceLine[]>([]);
  const markerApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  // Which marker ids sit on which displayed bar (for clicks).
  const markerBars = useRef(new Map<number, string[]>());
  const onMarkerClickRef = useLatest(onMarkerClick);
  const onMarkerHoverRef = useLatest(onMarkerHover);
  const hoveredBar = useRef<number | null>(null);
  const oscSeries = useRef<Array<ISeriesApi<SeriesType>>>([]);
  const viewRef = useLatest({ showSma, showEma, showBands, showVwap, showSupertrend, oscillator, indicators });
  const candlesRef = useLatest(candles);
  const paintedBars = useRef<Candle[]>([]);
  const schemeRef = useLatest(scheme);
  const [hover, setHover] = useState<Candle | null>(null);
  const onHoverRef = useLatest(onHover);
  const focusedToken = useRef(0);
  const [chartEpoch, setChartEpoch] = useState(0);
  const loaded = candles.length > 0;
  const compareRef = useLatest(compare);
  const compareKey = compare.map((candle) => `${candle.time}:${candle.close}`).join("|");
  const referenceKey = references.map((item) => `${item.title}:${item.price}:${item.color}:${item.style ?? "dashed"}`).join("|");

  useEffect(() => {
    const rows = candlesRef.current;
    if (!priceRef.current || !rows.length) return;
    const chart = mountChart(priceRef.current, schemeRef.current);
    chartRef.current = chart;
    const series = addMainSeries(chart, chartType, paintRef.current);
    seriesRef.current = series;
    const bars = rows.map((candle) => ({ ...candle, time: candle.time as UTCTimestamp }));
    if (chartType === "line" || chartType === "area") series.setData(bars.map((bar) => ({ time: bar.time, value: bar.close })));
    else series.setData(bars);
    paintedBars.current = rows;

    const closes = rows.map((candle) => candle.close);
    const times = rows.map((candle) => candle.time);
    overlaySeries.current = [];
    oscSeries.current = [];
    const overlay = (color: string, values: Array<number | null>) => {
      const line = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      overlaySeries.current.push(line);
      line.setData(toLine(times, values).map((point) => ({ ...point, time: point.time as UTCTimestamp })));
    };
    const ink = paintRef.current;
    if (showSma) {
      overlay(ink.smaFast, sma(closes, Math.max(2, indicators.smaFast)));
      overlay(ink.smaSlow, sma(closes, Math.max(2, indicators.smaSlow)));
    }
    if (showEma) overlay(ink.ema, ema(closes, Math.max(2, indicators.ema)));
    if (showBands) {
      const bands = bollinger(closes, Math.max(2, indicators.bandsPeriod), indicators.bandsMult);
      overlay(ink.bands, bands.middle);
      overlay(ink.bands, bands.upper);
      overlay(ink.bands, bands.lower);
    }
    if (showVwap) overlay(ink.vwap, vwap(rows));
    if (showSupertrend) overlay(ink.smaSlow, supertrend(rows, Math.max(2, indicators.supertrendPeriod), indicators.supertrendMult));
    const compared = compareRef.current;
    if (compared.length) {
      const line = chart.addSeries(LineSeries, { color: "#F0B90B", lineWidth: 1, priceScaleId: "left", priceLineVisible: false, lastValueVisible: true });
      line.setData(compared.map((candle) => ({ time: candle.time as UTCTimestamp, value: candle.close })));
    }

    let oscillatorChart: IChartApi | null = null;
    if (oscillator !== "none" && oscRef.current) {
      oscillatorChart = mountChart(oscRef.current, schemeRef.current);
      if (oscillator === "rsi") {
        const line = oscillatorChart.addSeries(LineSeries, { color: paintRef.current.rsi, lineWidth: 1 });
        oscSeries.current.push(line);
        line.setData(toLine(times, rsi(closes, Math.max(2, indicators.rsi))).map((point) => ({ ...point, time: point.time as UTCTimestamp })));
        line.createPriceLine({ price: 70, color: themeColor("--muted", "#94A3B8"), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" });
        line.createPriceLine({ price: 30, color: themeColor("--muted", "#94A3B8"), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" });
      } else {
        const result = macd(closes, Math.max(2, indicators.macdFast), Math.max(3, indicators.macdSlow), Math.max(2, indicators.macdSignal));
        const line = oscillatorChart.addSeries(LineSeries, { color: paintRef.current.macd, lineWidth: 1 });
        const signal = oscillatorChart.addSeries(LineSeries, { color: paintRef.current.macdSignal, lineWidth: 1 });
        oscSeries.current.push(line, signal);
        line.setData(toLine(times, result.macd).map((point) => ({ ...point, time: point.time as UTCTimestamp })));
        signal.setData(toLine(times, result.signal).map((point) => ({ ...point, time: point.time as UTCTimestamp })));
      }
      oscillatorChart.timeScale().fitContent();
    }
    chart.applyOptions({ leftPriceScale: { visible: compareRef.current.length > 0, borderColor: chartPalette(schemeRef.current).border } });
    const lastBar = rows.length;
    // About 8px per candle: 140 candles on a wide chart, fewer (and readable) on a phone.
    const plotWidth = chart.timeScale().width() || 1120;
    const initialBars = Math.max(30, Math.min(140, Math.round(plotWidth / 8)));
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, lastBar - initialBars), to: lastBar + 2 });
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
        // Shows the bars from `from` to `to` (unix seconds) with some room either side; the data is untouched.
        focus: (from, to) => {
          const bars = candlesRef.current;
          if (!bars.length) return;
          const index = (time: number) => { let found = 0; for (let at = 0; at < bars.length; at += 1) if (bars[at].time <= time) found = at; return found; };
          const start = index(Math.min(from, to));
          const end = index(Math.max(from, to));
          const pad = Math.max(10, Math.round((end - start) * 0.6));
          chart.timeScale().setVisibleLogicalRange({ from: start - pad, to: end + pad });
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
      overlaySeries.current = [];
      oscSeries.current = [];
      chartRef.current = null;
      oscChartRef.current = null;
      seriesRef.current = null;
      markerApi.current = null;
      volumeRef.current = null;
    };
  }, [streamKey, loaded, chartType, compareKey, handleRef, oscillator, showBands, showEma, showSma, showVwap, showSupertrend, indicators, candlesRef, compareRef, paintRef, schemeRef]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!showVolume) {
      if (volumeRef.current) {
        chart.removeSeries(volumeRef.current);
        volumeRef.current = null;
      }
      return;
    }
    if (!volumeRef.current) {
      const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false });
      volumeRef.current = volume;
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }
    volumeRef.current.setData(candlesRef.current.map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.volume, color: volumeColor(bar, paintRef.current) })));
  }, [showVolume, chartEpoch, candlesRef, paintRef]);

  useEffect(() => {
    const series = seriesRef.current;
    const last = candles.at(-1);
    if (!series || !last) return;
    const paintStudies = (rows: Candle[]) => {
      const view = viewRef.current;
      const closes = rows.map((row) => row.close);
      const times = rows.map((row) => row.time);
      const draw = (values: Array<number | null>, line: ISeriesApi<SeriesType> | undefined) => {
        line?.setData(toLine(times, values).map((point) => ({ ...point, time: point.time as UTCTimestamp })));
      };
      const lines = overlaySeries.current;
      let index = 0;
      if (view.showSma) {
        draw(sma(closes, Math.max(2, view.indicators.smaFast)), lines[index++]);
        draw(sma(closes, Math.max(2, view.indicators.smaSlow)), lines[index++]);
      }
      if (view.showEma) draw(ema(closes, Math.max(2, view.indicators.ema)), lines[index++]);
      if (view.showBands) {
        const bands = bollinger(closes, Math.max(2, view.indicators.bandsPeriod), view.indicators.bandsMult);
        draw(bands.middle, lines[index++]);
        draw(bands.upper, lines[index++]);
        draw(bands.lower, lines[index++]);
      }
      if (view.showVwap) draw(vwap(rows), lines[index++]);
      if (view.showSupertrend) draw(supertrend(rows, Math.max(2, view.indicators.supertrendPeriod), view.indicators.supertrendMult), lines[index++]);
      const osc = oscSeries.current;
      if (view.oscillator === "rsi") draw(rsi(closes, Math.max(2, view.indicators.rsi)), osc[0]);
      if (view.oscillator === "macd") {
        const result = macd(closes, Math.max(2, view.indicators.macdFast), Math.max(3, view.indicators.macdSlow), Math.max(2, view.indicators.macdSignal));
        draw(result.macd, osc[0]);
        draw(result.signal, osc[1]);
      }
    };
    const time = last.time as UTCTimestamp;
    const previous = paintedBars.current;
    const sameBar = (left: Candle, right: Candle) => left.time === right.time && left.open === right.open && left.high === right.high && left.low === right.low && left.close === right.close && left.volume === right.volume;
    const appended = previous.length > 0 && candles.length === previous.length + 1 && previous.every((bar, index) => sameBar(bar, candles[index]));
    const lastOnly = previous.length > 0 && candles.length === previous.length && candles.slice(0, -1).every((bar, index) => sameBar(bar, previous[index]));
    try {
      if (!appended && !lastOnly) {
        const bars = candles.map((candle) => ({ ...candle, time: candle.time as UTCTimestamp }));
        if (chartType === "line" || chartType === "area") series.setData(bars.map((bar) => ({ time: bar.time, value: bar.close })));
        else series.setData(bars);
        if (volumeRef.current) volumeRef.current.setData(bars.map((bar) => ({ time: bar.time, value: bar.volume, color: volumeColor(bar, paintRef.current) })));
      } else {
        if (chartType === "line" || chartType === "area") series.update({ time, value: last.close });
        else series.update({ time, open: last.open, high: last.high, low: last.low, close: last.close });
        volumeRef.current?.update({ time, value: last.volume, color: volumeColor(last, paintRef.current) });
      }
      paintedBars.current = candles;
      paintStudies(candles);
    } catch { /* The chart was replaced while this tick arrived. */ }
  }, [candles, chartEpoch, chartType, paintRef, viewRef]);

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
    const paintNow = paintRef.current;
    const options = chartThemeOptions({ background: paintNow.background, text: paintNow.text, grid: paintNow.grid, border: paintNow.border, cross: paintNow.crosshair, label: paintNow.text });
    chartRef.current?.applyOptions(options);
    oscChartRef.current?.applyOptions(options);
    const seriesOptions = chartType === "line" || chartType === "area"
      ? { color: paintNow.bullBody, lineColor: paintNow.bullBody, topColor: withAlpha(paintNow.bullBody, 0.28), bottomColor: withAlpha(paintNow.bullBody, 0.02), priceLineVisible: true, priceLineColor: paintNow.priceLine }
      : candleOptions(paintNow);
    seriesRef.current?.applyOptions(seriesOptions as never);
    if (volumeRef.current) volumeRef.current.setData(candlesRef.current.map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.volume, color: volumeColor(bar, paintNow) })));
    const view = viewRef.current;
    const width = Math.min(4, Math.max(1, Math.round(paintNow.indicatorWidth))) as 1 | 2 | 3 | 4;
    const lineStyle = paintNow.indicatorStyle === "dashed" ? LineStyle.Dashed : paintNow.indicatorStyle === "dotted" ? LineStyle.Dotted : LineStyle.Solid;
    const ink = (color: string) => ({ color: withAlpha(color, paintNow.indicatorOpacity), lineWidth: width, lineStyle });
    const lines = overlaySeries.current;
    let index = 0;
    const paintLine = (color: string) => lines[index++]?.applyOptions(ink(color));
    if (view.showSma) { paintLine(paintNow.smaFast); paintLine(paintNow.smaSlow); }
    if (view.showEma) paintLine(paintNow.ema);
    if (view.showBands) { paintLine(paintNow.bands); paintLine(paintNow.bands); paintLine(paintNow.bands); }
    if (view.showVwap) paintLine(paintNow.vwap);
    if (view.showSupertrend) paintLine(paintNow.smaSlow);
    const osc = oscSeries.current;
    if (view.oscillator === "rsi") osc[0]?.applyOptions(ink(paintNow.rsi));
    if (view.oscillator === "macd") { osc[0]?.applyOptions(ink(paintNow.macd)); osc[1]?.applyOptions(ink(paintNow.macdSignal)); }
  }, [scheme, paintKey, chartEpoch, chartType, candlesRef, paintRef, viewRef]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const drop = () => {
      for (const line of referenceLines.current) {
        try { series.removePriceLine(line); } catch { /* The series was already removed. */ }
      }
      referenceLines.current = [];
    };
    drop();
    for (const item of references) {
      if (!Number.isFinite(item.price) || item.price <= 0) continue;
      referenceLines.current.push(series.createPriceLine({
        price: item.price,
        color: item.color,
        lineWidth: 1,
        lineStyle: item.style === "dotted" ? LineStyle.Dotted : LineStyle.Dashed,
        axisLabelVisible: true,
        title: item.title,
      }));
    }
    return drop;
  }, [referenceKey, chartEpoch, references]);

  // Trade markers follow the bars: each sits on the displayed bar that contains its time (any timeframe),
  // and one id is drawn once however often the same event arrives.
  const markerKey = markers.map((item) => `${item.id}:${item.time}:${item.text}:${item.color}:${item.size ?? 1}`).join("|");
  const barCount = candles.length;
  const firstBar = candles[0]?.time ?? 0;
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const bars = candlesRef.current;
    const seen = new Set<string>();
    const placed = [];
    markerBars.current = new Map();
    for (const item of markers) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      let bar: number | null = null;
      for (let low = 0, high = bars.length - 1; low <= high;) {
        const mid = (low + high) >> 1;
        if (bars[mid].time <= item.time) { bar = bars[mid].time; low = mid + 1; } else high = mid - 1;
      }
      if (bar == null) continue;
      markerBars.current.set(bar, [...(markerBars.current.get(bar) ?? []), item.id]);
      placed.push({ time: bar as UTCTimestamp, position: item.position, shape: item.shape, color: item.color, text: item.text, size: item.size ?? 1 });
    }
    placed.sort((a, b) => a.time - b.time);
    if (!markerApi.current) markerApi.current = createSeriesMarkers(series, placed);
    else markerApi.current.setMarkers(placed);
  }, [markerKey, chartEpoch, barCount, firstBar, markers, candlesRef]);

  useEffect(() => {
    const visible = cursorStyle === "cross";
    chartRef.current?.applyOptions({ crosshair: { vertLine: { visible, labelVisible: true }, horzLine: { visible, labelVisible: true } } });
  }, [cursorStyle, chartEpoch]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onMove = (param: MouseEventParams) => {
      const bar = typeof param.time === "number" ? candles.find((item) => item.time === param.time) ?? null : null;
      setHover(bar);
      onHoverRef.current?.(bar);
      // Trade markers carry no text: hovering their bar reports them for a small tooltip.
      const ids = typeof param.time === "number" ? markerBars.current.get(param.time) : undefined;
      const over = ids?.length && param.point ? (param.time as number) : null;
      if (over !== hoveredBar.current) {
        hoveredBar.current = over;
        onMarkerHoverRef.current?.(over != null && ids && param.point ? { ids, x: param.point.x, y: param.point.y } : null);
      }
    };
    const onClick = (param: MouseEventParams) => {
      const ids = typeof param.time === "number" ? markerBars.current.get(param.time) : undefined;
      if (ids?.length && param.point) onMarkerClickRef.current?.(ids, { x: param.point.x, y: param.point.y });
    };
    chart.subscribeCrosshairMove(onMove);
    chart.subscribeClick(onClick);
    return () => { chart.unsubscribeCrosshairMove(onMove); chart.unsubscribeClick(onClick); };
  }, [candles, chartType, compare, oscillator, showBands, showEma, showSma, showVolume, showVwap, showSupertrend, indicators, onHoverRef, onMarkerClickRef, onMarkerHoverRef]);

  useEffect(() => {
    // Side-to-side drag and pinch still move and zoom the chart; only vertical touch drags go to the page.
    chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: !pageScroll } });
  });

  if (!candles.length) return <div className="grid h-full min-h-64 place-items-center text-sm text-muted">No candles for this symbol and timeframe.</div>;
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-panel">
      <p className="sr-only">{hover ? candleCaption(hover, previousClose(candles, hover)) : "Chart"}</p>
      <div className="relative min-h-0 w-full flex-1 overflow-hidden">
        <div ref={priceRef} className={`absolute inset-0 chart-cursor-${cursorStyle}`} />
        <CandleReadout candles={candles} hover={hover} />
        <DrawingLayer chartRef={chartRef} seriesRef={seriesRef} candles={candles} drawings={drawings} onDrawings={onDrawings} tool={tool} magnet={magnet} hidden={hidden} annotation={annotation} command={command} enabled={enabled} onTool={onTool} onSelect={onSelect} ready={chartEpoch} span={span} focusId={focusId} stay={stay} lockAll={lockAll} overlays={overlays} />
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

/**
 * One-line OHLC strip at the top left of the chart (Kite-style): the candle under the crosshair, or
 * the latest candle. High is green, low red, close green or red by the candle's direction.
 */
function CandleReadout({ candles, hover }: { candles: Candle[]; hover: Candle | null }) {
  const bar = hover ?? candles.at(-1);
  if (!bar) return null;
  const basis = previousClose(candles, bar);
  const change = bar.close - basis;
  const percent = basis ? (change / basis) * 100 : 0;
  const date = new Date(bar.time * 1000);
  const zone = { timeZone: "Asia/Kolkata" } as const;
  // Daily and longer candles are stamped at midnight IST: they show the date only.
  const daily = new Intl.DateTimeFormat("en-GB", { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date) === "00:00";
  const when = new Intl.DateTimeFormat("en-IN", daily ? { ...zone, day: "2-digit", month: "short", year: "numeric" } : { ...zone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  const closeTone = bar.close > bar.open ? "text-profit" : bar.close < bar.open ? "text-loss" : "text-text";
  const changeTone = change > 0 ? "text-profit" : change < 0 ? "text-loss" : "text-muted";
  const sign = change > 0 ? "+" : "";
  const value = (label: string, amount: number, tone: string) => (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-muted">{label}</span>
      <span className={cx("font-semibold", tone)}>{amount.toFixed(2)}</span>
    </span>
  );
  return (
    <div className="td-chart-legend no-scrollbar pointer-events-none absolute left-2 top-1.5 z-10 flex max-w-[calc(100%-3.75rem)] items-baseline gap-x-1.5 overflow-hidden whitespace-nowrap rounded-sm bg-panel/80 px-1 py-0.5 font-mono text-[0.625rem] sm:gap-x-2.5 sm:px-1.5 sm:text-[0.6875rem] leading-4 tabular-nums text-text backdrop-blur-[2px]">
      <span className="text-muted max-[380px]:hidden">{when}</span>
      {value("O", bar.open, "text-text")}
      {value("H", bar.high, "text-profit")}
      {value("L", bar.low, "text-loss")}
      {value("C", bar.close, closeTone)}
      {/* Phones show the change in the header already; the strip keeps to date and OHLC. */}
      <span className={cx("max-sm:hidden", changeTone)}>{sign}{change.toFixed(2)} ({sign}{percent.toFixed(2)}%)</span>
    </div>
  );
}

function candleOptions(paint: ChartPaint) {
  return {
    color: paint.bullBody,
    lineColor: paint.bullBody,
    topColor: withAlpha(paint.bullBody, 0.28),
    bottomColor: withAlpha(paint.bullBody, 0.02),
    upColor: paint.bullBody,
    downColor: paint.bearBody,
    borderVisible: true,
    borderUpColor: paint.bullBorder,
    borderDownColor: paint.bearBorder,
    wickUpColor: paint.bullWick,
    wickDownColor: paint.bearWick,
    priceLineVisible: true,
    priceLineColor: paint.priceLine,
  };
}

function volumeColor(bar: Candle, paint: ChartPaint) {
  return withAlpha(bar.close >= bar.open ? paint.volumeUp : paint.volumeDown, 0.45);
}

function addMainSeries(chart: IChartApi, chartType: ChartType, paint: ChartPaint): ISeriesApi<SeriesType> {
  const options = candleOptions(paint);
  if (chartType === "line") return chart.addSeries(LineSeries, { color: options.color, lineWidth: 2, priceLineVisible: true, priceLineColor: paint.priceLine });
  if (chartType === "area") return chart.addSeries(AreaSeries, { lineColor: options.lineColor, topColor: options.topColor, bottomColor: options.bottomColor, lineWidth: 2, priceLineVisible: true, priceLineColor: paint.priceLine });
  if (chartType === "bar") return chart.addSeries(BarSeries, { upColor: options.upColor, downColor: options.downColor, priceLineVisible: true, priceLineColor: paint.priceLine });
  return chart.addSeries(CandlestickSeries, options);
}

function chartPalette(scheme: ChartScheme) {
  if (scheme === "light") {
    return { background: "#FFFFFF", text: "#46546A", grid: "#EEF1F6", border: "#E0E6EF", cross: "#8593A8", label: "#172033" };
  }
  return { background: "#101620", text: "#B4C0D0", grid: "#161E29", border: "#283444", cross: "#5D6B80", label: "#202B39" };
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

function formatKolkata(time: Time, tickMarkType?: TickMarkType): string {
  if (typeof time !== "number") return "";
  const date = new Date(time * 1000);
  const zone = "Asia/Kolkata";
  if (tickMarkType === TickMarkType.Year) return new Intl.DateTimeFormat("en-IN", { timeZone: zone, year: "numeric" }).format(date);
  if (tickMarkType === TickMarkType.Month) return new Intl.DateTimeFormat("en-IN", { timeZone: zone, month: "short", year: "numeric" }).format(date);
  if (tickMarkType === TickMarkType.DayOfMonth) return new Intl.DateTimeFormat("en-IN", { timeZone: zone, day: "2-digit", month: "short" }).format(date);
  return new Intl.DateTimeFormat("en-IN", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

function mountChart(container: HTMLDivElement, scheme: ChartScheme) {
  const colors = chartPalette(scheme);
  return createChart(container, {
    autoSize: true,
    layout: { ...chartThemeOptions(colors).layout, fontFamily: getComputedStyle(document.body).fontFamily, fontSize: axisFontSize(), attributionLogo: false },
    grid: chartThemeOptions(colors).grid,
    localization: { timeFormatter: (time: Time) => formatKolkata(time) },
    crosshair: { mode: 1, vertLine: { ...chartThemeOptions(colors).crosshair.vertLine, style: LineStyle.Dashed, width: 1 }, horzLine: { ...chartThemeOptions(colors).crosshair.horzLine, style: LineStyle.Dashed, width: 1 } },
    // No minimum width: the scale is as wide as its labels, so no empty band is left at the right edge.
    rightPriceScale: { borderColor: colors.border, entireTextOnly: true },
    leftPriceScale: { visible: false, borderColor: colors.border },
    handleScroll: true,
    handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
    timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, barSpacing: 9, tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => formatKolkata(time, tickMarkType) },
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
