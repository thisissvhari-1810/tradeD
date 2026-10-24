"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "@/lib/academy/types";

const HIGHLIGHT = { open: "#38bdf8", high: "#3fe08d", low: "#ff6b7a", close: "#ffc83d" } as const;
const DAY = 86_400;
const START = 1_767_225_600; // a fixed date: the example's dates are illustrative only

/**
 * An educational candlestick chart on the app's chart engine (lightweight-charts): made-up candles,
 * clearly labelled as such, with an optional highlighted price (open / high / low / close).
 */
export function EduChart({ candles, highlight, height = 240, label = "Educational example · made-up prices" }: {
  candles: Candle[];
  highlight?: keyof typeof HIGHLIGHT;
  height?: number;
  label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const line = useRef<IPriceLine | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const api = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#c9d6e6", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "rgba(255,255,255,.06)" }, horzLines: { color: "rgba(255,255,255,.06)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,.15)" },
      timeScale: { borderColor: "rgba(255,255,255,.15)", visible: false },
      crosshair: { mode: 1 },
      handleScroll: false,
      handleScale: false,
    });
    series.current = api.addSeries(CandlestickSeries, { upColor: "#2ebd85", downColor: "#f6465d", borderUpColor: "#2ebd85", borderDownColor: "#f6465d", wickUpColor: "#2ebd85", wickDownColor: "#f6465d", priceLineVisible: false, lastValueVisible: false });
    chart.current = api;
    return () => {
      api.remove();
      chart.current = null;
      series.current = null;
      line.current = null;
    };
  }, []);

  useEffect(() => {
    series.current?.setData(candles.map((candle, index) => ({ time: (START + index * DAY) as UTCTimestamp, ...candle })));
    chart.current?.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    const current = series.current;
    if (!current) return;
    if (line.current) { current.removePriceLine(line.current); line.current = null; }
    const last = candles.at(-1);
    if (!highlight || !last) return;
    line.current = current.createPriceLine({ price: last[highlight], color: HIGHLIGHT[highlight], lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: highlight.toUpperCase() });
  }, [highlight, candles]);

  return (
    <figure className="relative overflow-hidden rounded-2xl border border-white/15 bg-[#0b1f3a]/70">
      <div ref={box} style={{ height }} aria-hidden />
      <figcaption className="absolute left-2 top-2 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-bold text-white/85">{label}</figcaption>
      <p className="sr-only">{candles.length} candles. {highlight && candles.at(-1) ? `${highlight}: ₹${candles.at(-1)![highlight]}` : ""}</p>
    </figure>
  );
}
