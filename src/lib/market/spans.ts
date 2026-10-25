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

export const INTRADAY_SECONDS: Partial<Record<ChartSpan, number>> = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400 };

/** Move the forming candle with a traded price. Closed candles and after-hours gaps stay as history. */
export function applyLiveTick(candles: Candle[], span: ChartSpan, last: number, nowSec: number, marketOpen: boolean, volumeDelta = 0, previousTradeTime = 0): Candle[] {
  if (!marketOpen || !candles.length || !Number.isFinite(last) || last <= 0 || !Number.isFinite(nowSec)) return candles;
  const width = INTRADAY_SECONDS[span];
  const lastBar = candles[candles.length - 1];
  const stale = previousTradeTime > 0 && nowSec < previousTradeTime;
  if (!width) {
    if (!sameCandlePeriod(span, lastBar.time, nowSec)) {
      if (stale) return candles;
      const opened = sessionOpenUnix(nowSec);
      if (opened <= lastBar.time) return candles;
      return [...candles, { time: opened, open: last, high: last, low: last, close: last, volume: tradedVolume(volumeDelta) }];
    }
    return stale ? widen(candles, lastBar, last) : paint(candles, lastBar, last, volumeDelta);
  }
  const phase = ((lastBar.time % width) + width) % width;
  const bucket = Math.floor((nowSec - phase) / width) * width + phase;
  if (bucket < lastBar.time) return candles;
  if (bucket === lastBar.time) return stale ? widen(candles, lastBar, last) : paint(candles, lastBar, last, volumeDelta);
  if (stale) return candles;
  const left = istDate(bucket);
  const right = istDate(lastBar.time);
  const sameDay = left.day === right.day && left.month === right.month && left.year === right.year;
  if (!sameDay || bucket - lastBar.time > 6 * 3600) return candles;
  return [...candles, { time: bucket, open: last, high: last, low: last, close: last, volume: tradedVolume(volumeDelta) }];
}

function tradedVolume(delta: number) {
  return delta > 0 && Number.isFinite(delta) ? Math.round(delta) : 0;
}

function paint(candles: Candle[], lastBar: Candle, last: number, volumeDelta = 0) {
  const volume = lastBar.volume + tradedVolume(volumeDelta);
  if (last === lastBar.close && last <= lastBar.high && last >= lastBar.low && volume === lastBar.volume) return candles;
  const next = candles.slice();
  next[next.length - 1] = { ...lastBar, high: Math.max(lastBar.high, last), low: Math.min(lastBar.low, last), close: last, volume };
  return next;
}

function widen(candles: Candle[], lastBar: Candle, last: number) {
  if (last <= lastBar.high && last >= lastBar.low) return candles;
  const next = candles.slice();
  next[next.length - 1] = { ...lastBar, high: Math.max(lastBar.high, last), low: Math.min(lastBar.low, last) };
  return next;
}

/** Keep the forming bar when a history refresh overlaps prices already applied from the feed. */
export function mergeLiveHistory(previous: Candle[], incoming: Candle[]): Candle[] {
  if (!previous.length || !incoming.length) return incoming.length ? incoming : previous;
  const liveByTime = new Map(previous.map((bar) => [bar.time, bar]));
  const merged = incoming.map((bar) => {
    const live = liveByTime.get(bar.time);
    if (!live) return bar;
    const liveAhead = live.high > bar.high || live.low < bar.low || live.volume > bar.volume;
    return {
      ...bar,
      high: Math.max(bar.high, live.high),
      low: Math.min(bar.low, live.low),
      close: liveAhead ? live.close : bar.close,
      volume: Math.max(bar.volume, live.volume),
    };
  });
  const lastHistory = incoming[incoming.length - 1].time;
  const extra = previous.filter((bar) => bar.time > lastHistory);
  return extra.length ? [...merged, ...extra] : merged;
}

function sameCandlePeriod(span: ChartSpan, lastTime: number, nowSec: number) {
  const left = istDate(lastTime);
  const right = istDate(nowSec);
  if (span === "1mo") return left.year === right.year && left.month === right.month;
  if (span === "1w") return weekKey(left) === weekKey(right);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function sessionOpenUnix(nowSec: number) {
  const parts = istDate(nowSec);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day, 9, 15) / 1000) - 5.5 * 3600;
}

const IST_OFFSET = 19_800;
const SESSION_OPEN = 9 * 3600 + 15 * 60;

/** Bucket a timestamp onto the cash-session grid that opens at 09:15 IST. */
export function sessionBucket(time: number, width: number) {
  const ist = time + IST_OFFSET;
  const day = Math.floor(ist / 86_400) * 86_400;
  const seconds = ist - day;
  if (seconds < SESSION_OPEN) return time;
  return day + SESSION_OPEN + Math.floor((seconds - SESSION_OPEN) / width) * width - IST_OFFSET;
}

export function aggregateMinutes(candles: Candle[], minutes: number): Candle[] {
  const width = minutes * 60;
  const groups = new Map<number, Candle>();
  for (const candle of candles) {
    const time = sessionBucket(candle.time, width);
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
