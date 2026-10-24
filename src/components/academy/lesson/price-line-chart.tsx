"use client";

import { useCallback, useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { GripHorizontal } from "lucide-react";
import type { Candle } from "@/lib/academy/types";

const DAY = 86_400;
const START = 1_767_225_600; // a fixed date: the example's dates are illustrative only
const TONE = { idle: "#ffc83d", correct: "#3fe08d", wrong: "#ff6b7a" } as const;

const snap = (price: number, step: number, [min, max]: [number, number]) => Math.min(max, Math.max(min, Math.round(price / step) * step));

/**
 * An educational chart with one price line the learner drags (a stop-loss, a target). Only the line's
 * handle captures touch, so the page still scrolls when the learner swipes elsewhere; a tap on the
 * chart moves the line there, and the handle is a keyboard slider. After the answer, `zone` shows the
 * accepted area from the server's verdict.
 */
export function PriceLineChart({ candles, price, step, range, onChange, tone = "idle", zone, label = "Stop-loss", height = 250 }: {
  candles: Candle[];
  price: number;
  step: number;
  range: [number, number];
  onChange?: (price: number) => void;
  tone?: keyof typeof TONE;
  zone?: [number, number] | null;
  label?: string;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const line = useRef<IPriceLine | null>(null);
  const zoneLines = useRef<IPriceLine[]>([]);
  const latest = useRef({ price, onChange, step, range });
  useEffect(() => { latest.current = { price, onChange, step, range }; });

  /** Puts the HTML handle on the line (after scale changes, resizes and moves). */
  const place = useCallback(() => {
    const y = series.current?.priceToCoordinate(latest.current.price);
    if (handle.current && y != null) handle.current.style.transform = `translateY(${y}px)`;
  }, []);

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
    // The scale always covers the whole drag range, so the line can never leave the chart.
    series.current = api.addSeries(CandlestickSeries, {
      upColor: "#2ebd85", downColor: "#f6465d", borderUpColor: "#2ebd85", borderDownColor: "#f6465d", wickUpColor: "#2ebd85", wickDownColor: "#f6465d",
      priceLineVisible: false, lastValueVisible: false,
      autoscaleInfoProvider: () => ({ priceRange: { minValue: latest.current.range[0], maxValue: latest.current.range[1] } }),
    });
    api.subscribeClick((param) => {
      const { onChange: change, step: s, range: r } = latest.current;
      if (!change || !param.point || !series.current) return;
      const at = series.current.coordinateToPrice(param.point.y);
      if (at != null) change(snap(at, s, r));
    });
    api.timeScale().subscribeSizeChange(() => requestAnimationFrame(place));
    chart.current = api;
    return () => { api.remove(); chart.current = null; series.current = null; line.current = null; zoneLines.current = []; };
  }, [place]);

  useEffect(() => {
    series.current?.setData(candles.map((candle, index) => ({ time: (START + index * DAY) as UTCTimestamp, ...candle })));
    chart.current?.timeScale().fitContent();
    requestAnimationFrame(place);
  }, [candles, place]);

  useEffect(() => {
    const current = series.current;
    if (!current) return;
    if (!line.current) line.current = current.createPriceLine({ price, color: TONE[tone], lineWidth: 3, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: label });
    else line.current.applyOptions({ price, color: TONE[tone] });
    place();
  }, [price, tone, label, place]);

  useEffect(() => {
    const current = series.current;
    if (!current) return;
    zoneLines.current.forEach((item) => current.removePriceLine(item));
    zoneLines.current = zone ? zone.map((edge) => current.createPriceLine({ price: edge, color: "#3fe08d", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" })) : [];
  }, [zone]);

  function drag(event: React.PointerEvent<HTMLDivElement>) {
    if (!onChange || !series.current || !box.current) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const top = box.current?.getBoundingClientRect().top ?? 0;
      const at = series.current?.coordinateToPrice(moveEvent.clientY - top);
      if (at != null) {
        const next = snap(at, step, range);
        if (next !== latest.current.price) latest.current.onChange?.(next);
      }
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function key(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!onChange) return;
    const moves: Record<string, number> = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: step * 5, PageDown: -step * 5 };
    if (event.key in moves) { event.preventDefault(); onChange(snap(price + moves[event.key], step, range)); }
    if (event.key === "Home") { event.preventDefault(); onChange(range[0]); }
    if (event.key === "End") { event.preventDefault(); onChange(range[1]); }
  }

  return (
    <figure className="relative overflow-hidden rounded-2xl border border-white/15 bg-[#0b1f3a]" style={{ cursor: onChange ? "ns-resize" : undefined }}>
      <div ref={box} style={{ height }} aria-hidden />
      <div
        ref={handle}
        role="slider"
        tabIndex={onChange ? 0 : -1}
        aria-label={`${label} price`}
        aria-valuemin={range[0]}
        aria-valuemax={range[1]}
        aria-valuenow={price}
        aria-valuetext={`₹${price.toFixed(1)}`}
        aria-disabled={!onChange}
        className="ax-line-handle"
        data-tone={tone}
        onPointerDown={drag}
        onKeyDown={key}
      >
        <span className="ax-line-grip"><GripHorizontal className="h-4 w-4" aria-hidden />₹{price.toFixed(1)}</span>
      </div>
      <figcaption className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-bold text-white/85">Educational example · made-up prices · drag the line</figcaption>
    </figure>
  );
}
