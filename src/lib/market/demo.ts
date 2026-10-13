import { applyAdverseSlippage } from "@/lib/money";
import { kolkataParts, nseCashSession } from "@/lib/market/clock";
import type { DataModeName } from "@/lib/trading/decide";

export type DemoInstrument = {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  basePaise: number;
  tickPaise: number;
};

export const DEMO_UNIVERSE: DemoInstrument[] = [
  { symbol: "RELIANCE", name: "Reliance Industries", exchange: "NSE", sector: "Energy", basePaise: 245000, tickPaise: 5 },
  { symbol: "TCS", name: "Tata Consultancy Services", exchange: "NSE", sector: "Technology", basePaise: 389000, tickPaise: 5 },
  { symbol: "INFY", name: "Infosys", exchange: "NSE", sector: "Technology", basePaise: 152000, tickPaise: 5 },
  { symbol: "HDFCBANK", name: "HDFC Bank", exchange: "NSE", sector: "Financials", basePaise: 168000, tickPaise: 5 },
  { symbol: "ICICIBANK", name: "ICICI Bank", exchange: "NSE", sector: "Financials", basePaise: 112000, tickPaise: 5 },
  { symbol: "ITC", name: "ITC", exchange: "NSE", sector: "Consumer", basePaise: 45000, tickPaise: 5 },
  { symbol: "SBIN", name: "State Bank of India", exchange: "NSE", sector: "Financials", basePaise: 78000, tickPaise: 5 },
  { symbol: "TATAMOTORS", name: "Tata Motors", exchange: "NSE", sector: "Automobile", basePaise: 92000, tickPaise: 5 },
  { symbol: "ASIANPAINT", name: "Asian Paints", exchange: "NSE", sector: "Materials", basePaise: 285000, tickPaise: 5 },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", exchange: "NSE", sector: "Telecom", basePaise: 154000, tickPaise: 5 },
];

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type DemoQuote = {
  symbol: string;
  lastPaise: bigint;
  bidPaise: bigint;
  askPaise: bigint;
  openPaise: bigint;
  highPaise: bigint;
  lowPaise: bigint;
  previousClosePaise: bigint;
  volume: bigint;
  asOf: Date;
  mode: DataModeName;
  source: string;
  marketOpen: boolean;
  message: string;
};

const SESSION_BARS = 75;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tradingDayIndex(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const start = Date.UTC(2024, 0, 1);
  const days = Math.floor((utc - start) / 86_400_000);
  let index = 0;
  for (let i = 0; i <= days; i += 1) {
    const weekday = new Date(start + i * 86_400_000).getUTCDay();
    if (weekday !== 0 && weekday !== 6) index += 1;
  }
  return index;
}

function dailyClose(symbol: string, basePaise: number, dayIndex: number): number {
  const rand = mulberry32(hashString(`${symbol}:daily`));
  let price = basePaise;
  for (let i = 0; i < dayIndex; i += 1) {
    const shock = (rand() - 0.48) * 0.018;
    price = Math.max(basePaise * 0.2, Math.min(basePaise * 4, price * (1 + shock)));
  }
  return Math.max(100, Math.round(price / 5) * 5);
}

function istToUtc(dateKey: string, hour: number, minute: number): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day, hour - 5, minute - 30, 0);
}

export function demoDailyCandles(symbol: string, basePaise: number, now: Date, count = 120): Candle[] {
  const today = kolkataParts(now).dateKey;
  const todayIndex = tradingDayIndex(today);
  const candles: Candle[] = [];
  for (let offset = count; offset >= 1; offset -= 1) {
    const dayIndex = Math.max(1, todayIndex - offset);
    const close = dailyClose(symbol, basePaise, dayIndex);
    const open = dailyClose(symbol, basePaise, dayIndex - 1);
    const high = Math.max(open, close) + Math.round(Math.abs(close - open) * 0.35 + basePaise * 0.002);
    const low = Math.min(open, close) - Math.round(Math.abs(close - open) * 0.35 + basePaise * 0.002);
    const date = new Date(Date.UTC(2024, 0, 1) + (dayIndex - 1) * 86_400_000);
    candles.push({
      time: Math.floor(date.getTime() / 1000),
      open: open / 100,
      high: Math.max(high, open, close) / 100,
      low: Math.max(100, low) / 100,
      close: close / 100,
      volume: 100000 + (hashString(`${symbol}:${dayIndex}`) % 900000),
    });
  }
  return candles;
}

export function demoIntraday(symbol: string, basePaise: number, now: Date, barMinutes: 5 | 15 | 60): Candle[] {
  const parts = kolkataParts(now);
  const dayIndex = tradingDayIndex(parts.dateKey);
  const open = dailyClose(symbol, basePaise, dayIndex - 1);
  const close = dailyClose(symbol, basePaise, dayIndex);
  const rand = mulberry32(hashString(`${symbol}:${parts.dateKey}:intra`));
  const fives: Candle[] = [];
  for (let i = 0; i < SESSION_BARS; i += 1) {
    const progress = (i + 1) / SESSION_BARS;
    const noise = (rand() - 0.5) * open * 0.004;
    const value = Math.round((open + (close - open) * progress + noise) / 5) * 5;
    const minute = 9 * 60 + 15 + i * 5;
    const time = Math.floor(istToUtc(parts.dateKey, Math.floor(minute / 60), minute % 60) / 1000);
    const prev = i === 0 ? open : Math.round(fives[i - 1].close * 100);
    fives.push({
      time,
      open: prev / 100,
      high: Math.max(prev, value) / 100 + 0.05,
      low: Math.max(1, Math.min(prev, value) / 100 - 0.05),
      close: value / 100,
      volume: 1000 + Math.round(rand() * 20000),
    });
  }
  if (barMinutes === 5) return fives;
  const group = barMinutes === 15 ? 3 : 12;
  const aggregated: Candle[] = [];
  for (let i = 0; i < fives.length; i += group) {
    const slice = fives.slice(i, i + group);
    if (!slice.length) continue;
    aggregated.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map((bar) => bar.high)),
      low: Math.min(...slice.map((bar) => bar.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((sum, bar) => sum + bar.volume, 0),
    });
  }
  return aggregated;
}

export function demoQuote(instrument: DemoInstrument, now: Date, holidays: string[] = [], spreadBps = 2): DemoQuote {
  const session = nseCashSession(now, holidays);
  const parts = kolkataParts(now);
  const dayIndex = tradingDayIndex(parts.dateKey);
  const previousClose = BigInt(dailyClose(instrument.symbol, instrument.basePaise, dayIndex - 1));
  const todayClose = BigInt(dailyClose(instrument.symbol, instrument.basePaise, dayIndex));
  const minutes = parts.hour * 60 + parts.minute;
  const openMinutes = 9 * 60 + 15;
  const barIndex = Math.min(SESSION_BARS - 1, Math.max(0, Math.floor((minutes - openMinutes) / 5)));
  let last = todayClose;
  let high = todayClose > previousClose ? todayClose : previousClose;
  let low = todayClose < previousClose ? todayClose : previousClose;
  if (session.open) {
    const bars = demoIntraday(instrument.symbol, instrument.basePaise, now, 5);
    const bar = bars[barIndex];
    last = BigInt(Math.round(bar.close * 100));
    high = BigInt(Math.round(Math.max(...bars.slice(0, barIndex + 1).map((item) => item.high)) * 100));
    low = BigInt(Math.round(Math.min(...bars.slice(0, barIndex + 1).map((item) => item.low)) * 100));
  } else if (minutes < openMinutes) {
    last = previousClose;
    high = previousClose;
    low = previousClose;
  }
  const bid = applyAdverseSlippage(last, "SELL", Math.max(1, Math.floor(spreadBps / 2)), BigInt(instrument.tickPaise));
  const ask = applyAdverseSlippage(last, "BUY", Math.max(1, Math.ceil(spreadBps / 2)), BigInt(instrument.tickPaise));
  return {
    symbol: instrument.symbol,
    lastPaise: last,
    bidPaise: bid,
    askPaise: ask,
    openPaise: previousClose,
    highPaise: high,
    lowPaise: low,
    previousClosePaise: previousClose,
    volume: BigInt(100000 + (hashString(`${instrument.symbol}:${parts.dateKey}`) % 500000)),
    asOf: now,
    mode: "DEMO",
    source: "tradelab-demo",
    marketOpen: session.open,
    message: "Demo data. These prices are synthetic and are not live or delayed exchange prices.",
  };
}
