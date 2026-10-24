"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "@/lib/academy/types";

const HIGHLIGHT = { open: "#38bdf8", high: "#3fe08d", low: "#ff6b7a", close: "#ffc83d" } as const;
const DAY = 86_400;
const START = 1_767_225_600; // a fixed date: the example's dates are illustrative only
const timeOf = (index: number) => (START + index * DAY) as UTCTimestamp;

/**
 * An educational candlestick chart on the app's chart engine (lightweight-charts): made-up candles,
 * clearly labelled as such, with an optional highlighted price (open / high / low / close). With
 * `onSelect` the candles can be tapped (numbered, the pick outlined); `result` marks the right one.
 */
export function EduChart({ candles, highlight, height = 240, label = "Educational example · made-up prices", onSelect, numbered = false, selected = null, result }: {
  candles: Candle[];
  highlight?: keyof typeof HIGHLIGHT;
  height?: number;
  label?: string;
  onSelect?: (index: number) => void;
  /** Number the candles and mark the pick (stays on after the answer is checked, when taps are off). */
  numbered?: boolean;
  selected?: number | null;
  result?: { correct: number | null };
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const line = useRef<IPriceLine | null>(null);
  const select = useRef(onSelect);
  const count = useRef(candles.length);
  useEffect(() => { select.current = onSelect; count.current = candles.length; });
  const selectable = Boolean(onSelect) || numbered;

  useEffect(() => {
    if (!box.current) return;
    const api = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#c9d6e6", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "rgba(255,255,255,.06)" }, horzLines: { color: "rgba(255,255,255,.06)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,.15)", scaleMargins: { top: 0.16, bottom: 0.16 } },
      timeScale: { borderColor: "rgba(255,255,255,.15)", visible: false },
      crosshair: { mode: 1 },
      handleScroll: false,
      handleScale: false,
    });
    series.current = api.addSeries(CandlestickSeries, { upColor: "#2ebd85", downColor: "#f6465d", borderUpColor: "#2ebd85", borderDownColor: "#f6465d", wickUpColor: "#2ebd85", wickDownColor: "#f6465d", priceLineVisible: false, lastValueVisible: false });
    markers.current = createSeriesMarkers(series.current, []);
    // A tap anywhere in a candle's column picks that candle (a generous target on phones).
    api.subscribeClick((param) => {
      if (param.time == null || !select.current) return;
      const index = Math.round((Number(param.time) - START) / DAY);
      if (index >= 0 && index < count.current) select.current(index);
    });
    chart.current = api;
    return () => {
      api.remove();
      chart.current = null;
      series.current = null;
      markers.current = null;
      line.current = null;
    };
  }, []);

  useEffect(() => {
    series.current?.setData(candles.map((candle, index) => ({
      time: timeOf(index),
      ...candle,
      // The picked candle is outlined in white.
      ...(selectable && index === selected ? { borderColor: "#ffffff", wickColor: "#ffffff" } : {}),
    })));
    chart.current?.timeScale().fitContent();
    const list: SeriesMarker<Time>[] = [];
    if (selectable) {
      candles.forEach((_, index) => list.push({ time: timeOf(index), position: "belowBar", shape: "circle", color: "rgba(201,214,230,.55)", text: String(index + 1), size: 0.6 }));
      const correct = result?.correct ?? null;
      if (selected != null) list.push({ time: timeOf(selected), position: "aboveBar", shape: "arrowDown", color: correct == null ? "#ffc83d" : correct === selected ? "#3fe08d" : "#ff6b7a", text: correct == null ? "Your pick" : correct === selected ? "Correct" : "Your pick" });
      if (correct != null && correct !== selected) list.push({ time: timeOf(correct), position: "aboveBar", shape: "arrowDown", color: "#3fe08d", text: "Answer" });
      list.sort((a, b) => Number(a.time) - Number(b.time));
    }
    markers.current?.setMarkers(list);
  }, [candles, selectable, selected, result?.correct]);

  useEffect(() => {
    const current = series.current;
    if (!current) return;
    if (line.current) { current.removePriceLine(line.current); line.current = null; }
    const last = candles.at(-1);
    if (!highlight || !last) return;
    line.current = current.createPriceLine({ price: last[highlight], color: HIGHLIGHT[highlight], lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: highlight.toUpperCase() });
  }, [highlight, candles]);

  return (
    <figure className="relative overflow-hidden rounded-2xl border border-white/15 bg-[#0b1f3a]" style={{ cursor: selectable ? "pointer" : undefined }}>
      <div ref={box} style={{ height }} aria-hidden />
      <figcaption className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-bold text-white/85">{label}</figcaption>
      <p className="sr-only">{candles.length} candles. {highlight && candles.at(-1) ? `${highlight}: ₹${candles.at(-1)![highlight]}` : ""}</p>
    </figure>
  );
}
