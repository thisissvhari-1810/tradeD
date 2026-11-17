"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries, ColorType, LineSeries, LineStyle, TickMarkType, createChart, createSeriesMarkers,
  type IChartApi, type SeriesMarker, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { axisFontSize } from "@/lib/theme";
import { clock, type Candle5, type H0H4State } from "@/lib/algo/fib-h0h4";

/* Keep in sync with the --chart-* variables in src/app/tokens.css. */
const UP = "#089981";
const DOWN = "#F23645";
/** Level colours: confirmed H0–H3 green family, Fib anchors grey/blue, H4 purple, target gold (distinct). */
export const LEVEL_COLOR = { H0: "#2E7D32", H1: "#43A047", H2: "#66BB6A", H3: "#00897B", F0: "#78909C", F05: "#1E88E5", F618: "#E6A700", H4: "#8B5CF6" } as const;

const unix = (date: string, minute: number) => (Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000 + Math.round(minute * 60) - 19_800) as UTCTimestamp;
function ist(time: Time, type?: TickMarkType) {
  if (typeof time !== "number") return "";
  const date = new Date(time * 1000);
  if (type === TickMarkType.DayOfMonth || type === TickMarkType.Month || type === TickMarkType.Year) return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }).format(date);
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

/**
 * The selected ATM CE's real candles (the strategy's candle size) with the strategy's levels. Each level is a horizontal segment at its exact
 * price from the candle that established it to the right edge, labelled with its name, price and confirmation time.
 */
export function H0H4Chart({ state, candles, scheme, candleMinutes = 1 }: { state: H0H4State | null; candles: Candle5[]; scheme: "dark" | "light"; candleMinutes?: number }) {
  const bucket = (minute: number) => 555 + Math.floor((Math.floor(minute) - 555) / candleMinutes) * candleMinutes;
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !state || !candles.length) return;
    const background = scheme === "light" ? "#FFFFFF" : "#101620";
    const text = scheme === "light" ? "#46546A" : "#B4C0D0";
    const grid = scheme === "light" ? "#EEF1F6" : "#161E29";
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: background }, textColor: text, fontSize: axisFontSize(), attributionLogo: false },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      localization: { timeFormatter: (time: Time) => ist(time) },
      rightPriceScale: { borderColor: grid, entireTextOnly: true },
      timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false, barSpacing: 10, tickMarkFormatter: (time: Time, type: TickMarkType) => ist(time, type) },
      crosshair: { mode: 1, vertLine: { style: LineStyle.Dashed, width: 1, labelBackgroundColor: text }, horzLine: { style: LineStyle.Dashed, width: 1, labelBackgroundColor: text } },
    });
    chartRef.current = chart;
    const series = chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: true, priceLineVisible: false, lastValueVisible: true });
    series.setData(candles.map((c) => ({ time: unix(state.date, c.t), open: c.open, high: c.high, low: c.low, close: c.close })));
    const lastTime = unix(state.date, candles[candles.length - 1].t);
    const segment = (label: string, price: number, fromMinute: number, color: string, at: string, style = LineStyle.Solid, width: 1 | 2 = 1) => {
      const from = unix(state.date, fromMinute);
      const line = chart.addSeries(LineSeries, { color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, title: `${label} ${price.toFixed(2)} @${at}` });
      line.setData(from < lastTime ? [{ time: from, value: price }, { time: lastTime, value: price }] : [{ time: from, value: price }]);
    };
    const markers: SeriesMarker<Time>[] = [];
    const lv = state.levels;
    if (state.initial) markers.push({ time: unix(state.date, state.initial.t), position: "aboveBar", color: LEVEL_COLOR.H0, shape: "circle", text: "First 5m CE" });
    for (const name of ["H0", "H1", "H2", "H3"] as const) {
      const level = lv[name];
      if (!level) continue;
      segment(name, level.price, level.candle, LEVEL_COLOR[name], clock(level.confirmedAt));
      if (name !== "H0") markers.push({ time: unix(state.date, level.candle), position: "aboveBar", color: LEVEL_COLOR[name], shape: "arrowDown", text: name });
    }
    if (state.fib) {
      const from = state.levels.H3!.candle;
      segment("Fib 0.0", state.fib.f0, state.initial?.t ?? from, LEVEL_COLOR.F0, clock(state.fib.lockedAt), LineStyle.Dashed);
      segment("Fib 0.5", state.fib.f05, from, LEVEL_COLOR.F05, clock(state.fib.lockedAt), LineStyle.Dashed);
      segment("Fib 0.618 TARGET", state.fib.f0618, from, LEVEL_COLOR.F618, clock(state.fib.lockedAt), LineStyle.Solid, 2);
    }
    if (lv.H4) {
      segment("H4", lv.H4.price, lv.H4.candle, LEVEL_COLOR.H4, clock(lv.H4.confirmedAt), LineStyle.Solid, 2);
      markers.push({ time: unix(state.date, lv.H4.candle), position: "aboveBar", color: LEVEL_COLOR.H4, shape: "arrowDown", text: "H4" });
    }
    if (state.breakout) markers.push({ time: unix(state.date, state.breakout.candle), position: "aboveBar", color: LEVEL_COLOR.H4, shape: "square", text: "H4 break" });
    if (state.entry) markers.push({ time: unix(state.date, bucket(state.entry.time)), position: "belowBar", color: UP, shape: "arrowUp", text: `BUY ${state.entry.price.toFixed(2)}` });
    if (state.exit) markers.push({ time: unix(state.date, bucket(Math.min(state.exit.time, 929))), position: "aboveBar", color: state.exit.reason === "TARGET" ? LEVEL_COLOR.F618 : DOWN, shape: "arrowDown", text: `SELL ${state.exit.price.toFixed(2)}` });
    markers.sort((a, b) => Number(a.time) - Number(b.time));
    createSeriesMarkers(series, markers);
    chart.timeScale().fitContent();
    return () => { chart.remove(); chartRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bucket only depends on candleMinutes
  }, [state, candles, scheme, candleMinutes]);

  if (!state || !candles.length) {
    return <div className="grid h-[22rem] place-items-center rounded-md border border-border-soft text-dense text-muted">{state?.contract ? "Waiting for the first completed CE candle." : "The chart appears once the ATM CE is selected (green opening candle)."}</div>;
  }
  return <div ref={hostRef} className="h-[24rem] w-full overflow-hidden rounded-md border border-border-soft max-sm:h-[18rem]" role="img" aria-label={`${state.contract?.symbol ?? "ATM CE"} ${candleMinutes}-minute candles with H0–H4 and Fibonacci levels`} />;
}
