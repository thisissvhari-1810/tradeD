import type { Candle } from "@/lib/market/demo";

export const CHART_SPANS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1mo", "1y", "5y"] as const;
export type ChartSpan = (typeof CHART_SPANS)[number];

export const SPAN_LABEL: Record<ChartSpan, string> = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1H",
  "2h": "2H",
  "4h": "4H",
  "1d": "1D",
  "1w": "1W",
  "1mo": "1M",
  "1y": "1Y",
  "5y": "5Y",
};

export function isChartSpan(value: string | null): value is ChartSpan {
  return CHART_SPANS.includes(value as ChartSpan);
}

const INTRADAY_SECONDS: Partial<Record<ChartSpan, number>> = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400 };

/** Move the forming candle with a real last price. Closed candles and after-hours gaps stay as history. */
export function applyLiveTick(candles: Candle[], span: ChartSpan, last: number, nowSec: number, marketOpen: boolean): Candle[] {
  if (!marketOpen || !candles.length || !Number.isFinite(last) || last <= 0) return candles;
  const width = INTRADAY_SECONDS[span];
  const lastBar = candles[candles.length - 1];
  if (!width) {
    if (last === lastBar.close && last <= lastBar.high && last >= lastBar.low) return candles;
    const next = candles.slice();
    next[next.length - 1] = { ...lastBar, high: Math.max(lastBar.high, last), low: Math.min(lastBar.low, last), close: last };
    return next;
  }
  const bucket = Math.floor(nowSec / width) * width;
  if (bucket < lastBar.time) return candles;
  if (bucket === lastBar.time) {
    if (last === lastBar.close && last <= lastBar.high && last >= lastBar.low) return candles;
    const next = candles.slice();
    next[next.length - 1] = { ...lastBar, high: Math.max(lastBar.high, last), low: Math.min(lastBar.low, last), close: last };
    return next;
  }
  const sameDay = istDate(bucket).day === istDate(lastBar.time).day && istDate(bucket).month === istDate(lastBar.time).month && istDate(bucket).year === istDate(lastBar.time).year;
  if (!sameDay || bucket - lastBar.time > 6 * 3600) return candles;
  return [...candles, { time: bucket, open: last, high: last, low: last, close: last, volume: 0 }];
}

export function aggregateMinutes(candles: Candle[], minutes: number): Candle[] {
  const width = minutes * 60;
  const groups = new Map<number, Candle>();
  for (const candle of candles) {
    const time = Math.floor(candle.time / width) * width;
    const existing = groups.get(time);
    if (!existing) {
      groups.set(time, { ...candle, time });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

/** Group consecutive same-day bars. Used for 2-hour and 4-hour charts built from 1-hour history. */
export function aggregateCount(candles: Candle[], count: number): Candle[] {
  const size = Math.max(1, Math.floor(count));
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const out: Candle[] = [];
  let bucket: Candle[] = [];
  let day = "";
  const flush = () => {
    if (!bucket.length) return;
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    out.push({
      time: first.time,
      open: first.open,
      high: Math.max(...bucket.map((item) => item.high)),
      low: Math.min(...bucket.map((item) => item.low)),
      close: last.close,
      volume: bucket.reduce((sum, item) => sum + item.volume, 0),
    });
    bucket = [];
  };
  for (const candle of sorted) {
    const key = `${istDate(candle.time).year}-${istDate(candle.time).month}-${istDate(candle.time).day}`;
    if (bucket.length && (key !== day || bucket.length >= size)) flush();
    day = key;
    bucket.push(candle);
  }
  flush();
  return out;
}

function istDate(time: number) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(time * 1000));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "01";
  return { year: Number(read("year")), month: Number(read("month")), day: Number(read("day")) };
}

export function aggregatePeriod(candles: Candle[], period: "week" | "month"): Candle[] {
  const groups = new Map<string, Candle>();
  for (const candle of [...candles].sort((a, b) => a.time - b.time)) {
    const date = istDate(candle.time);
    const key = period === "month" ? `${date.year}-${String(date.month).padStart(2, "0")}` : weekKey(date);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...candle });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
  }
  return [...groups.values()];
}

function weekKey(date: { year: number; month: number; day: number }) {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const weekday = utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  return utc.toISOString().slice(0, 10);
}
