"use client";

import { useLatest } from "@/components/use-hydrated";
import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/components/chart-panel";
import type { ForecastPoint } from "@/lib/market/forecast";
import { axisFontSize } from "@/lib/theme";

/* Keep in sync with the --chart-* variables in src/app/tokens.css. */
const UP = "#089981";
const DOWN = "#F23645";
const FORECAST_UP = "#FACC15";
const FORECAST_DOWN = "#E879F9";

export function PredictionChart({
  candles,
  points,
  scheme,
  viewToken,
  marketOpen,
  fitKey,
}: {
  candles: Candle[];
  points: ForecastPoint[];
  scheme: "dark" | "light";
  viewToken: number;
  marketOpen: boolean;
  fitKey: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLParagraphElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const historyRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const forecastRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const markersRef = useRef<{ setMarkers: (markers: SeriesMarker<Time>[]) => void } | null>(null);
  const fittedRef = useRef("");
  const candlesRef = useLatest(candles);
  const pointsRef = useLatest(points);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const background = scheme === "light" ? "#FFFFFF" : "#101620";
    const text = scheme === "light" ? "#46546A" : "#B4C0D0";
    const grid = scheme === "light" ? "#EEF1F6" : "#161E29";
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: background }, textColor: text, fontSize: axisFontSize(), attributionLogo: false },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid, minimumWidth: 84, entireTextOnly: true },
      timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1, vertLine: { color: scheme === "light" ? "#8593A8" : "#5D6B80", style: LineStyle.Dashed, width: 1, labelBackgroundColor: text }, horzLine: { color: scheme === "light" ? "#8593A8" : "#5D6B80", style: LineStyle.Dashed, width: 1, labelBackgroundColor: text } },
      handleScroll: true,
      handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
    });
    const history = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: true,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const forecast = chart.addSeries(CandlestickSeries, {
      upColor: FORECAST_UP,
      downColor: FORECAST_DOWN,
      borderVisible: true,
      wickUpColor: FORECAST_UP,
      wickDownColor: FORECAST_DOWN,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chartRef.current = chart;
    historyRef.current = history;
    forecastRef.current = forecast;
    const markers = createSeriesMarkers(history, []);
    markersRef.current = markers;
    fittedRef.current = "";
    const historical = () => new Map(candlesRef.current.map((candle) => [candle.time, candle.close]));
    const onMove = (param: { time?: unknown }) => {
      const tip = tipRef.current;
      if (!tip) return;
      const time = typeof param.time === "number" ? param.time : null;
      if (time == null) {
        tip.hidden = true;
        return;
      }
      const when = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(time * 1000));
      const last = candlesRef.current[candlesRef.current.length - 1];
      const estimate = pointsRef.current.find((point) => point.time === time && point.open != null && last && point.time > last.time);
      if (estimate && estimate.open != null && estimate.high != null && estimate.low != null) {
        tip.textContent = `${when} IST · Forecast estimate O ${estimate.open.toFixed(2)} H ${estimate.high.toFixed(2)} L ${estimate.low.toFixed(2)} C ${estimate.price.toFixed(2)}`;
        tip.hidden = false;
      } else if (historical().has(time)) {
        tip.textContent = `${when} IST · Historical close ${historical().get(time)?.toFixed(2)}`;
        tip.hidden = false;
      } else tip.hidden = true;
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.remove();
      chartRef.current = null;
      historyRef.current = null;
      forecastRef.current = null;
      markersRef.current = null;
    };
  }, [scheme, candlesRef, pointsRef]);

  useEffect(() => {
    const chart = chartRef.current;
    const history = historyRef.current;
    const forecast = forecastRef.current;
    const markers = markersRef.current;
    if (!chart || !history || !forecast || !markers) return;
    const fit = applyPredictionData(chart, history, forecast, markers, candles, points, marketOpen, fitKey, fittedRef);
    if (!fit) return;
    const frame = window.requestAnimationFrame(() => chart.timeScale().fitContent());
    return () => window.cancelAnimationFrame(frame);
  }, [candles, points, marketOpen, fitKey]);

  useEffect(() => {
    if (viewToken === 0) return;
    chartRef.current?.timeScale().fitContent();
  }, [viewToken]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <div ref={hostRef} className="absolute inset-0" />
      <p ref={tipRef} hidden className="pointer-events-none absolute left-3 top-3 z-10 rounded-lg border border-border bg-panel/95 px-2 py-1 text-[0.6875rem]" />
    </div>
  );
}

function applyPredictionData(
  chart: IChartApi,
  history: ISeriesApi<SeriesType>,
  forecast: ISeriesApi<SeriesType>,
  markers: { setMarkers: (markers: SeriesMarker<Time>[]) => void },
  candles: Candle[],
  points: ForecastPoint[],
  marketOpen: boolean,
  fitKey: string,
  fittedRef: { current: string },
) {
  if (!candles.length) return false;
  const kept = chart.timeScale().getVisibleLogicalRange();
  history.setData(candles.map((candle, index) => {
    const rising = candle.close >= candle.open;
    const openBar = marketOpen && index === candles.length - 1;
    return {
      ...candle,
      time: candle.time as UTCTimestamp,
      borderColor: openBar ? "#d97706" : rising ? UP : DOWN,
      wickColor: openBar ? "#d97706" : rising ? UP : DOWN,
    };
  }));
  const last = candles[candles.length - 1];
  const future = points.filter((point): point is ForecastPoint & { open: number; high: number; low: number } => point.time > last.time && point.open != null && point.high != null && point.low != null);
  forecast.setData(future.map((point) => {
    const rising = point.price >= point.open;
    const color = rising ? FORECAST_UP : FORECAST_DOWN;
    return {
      time: point.time as UTCTimestamp,
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.price,
      color,
      borderColor: color,
      wickColor: color,
    };
  }));
  markers.setMarkers(future.length ? [{ time: last.time as UTCTimestamp, position: "aboveBar", color: FORECAST_UP, shape: "circle", text: "FORECAST START" }] : []);
  const signature = `${fitKey}|${candles.length}|${future.length}|${candles[0].time}|${last.time}`;
  if (fittedRef.current !== signature) {
    fittedRef.current = signature;
    return true;
  }
  if (kept) chart.timeScale().setVisibleLogicalRange(kept);
  return false;
}
