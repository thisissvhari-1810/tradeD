import type { Candle } from "@/lib/market/demo";
import type { ChartSpan } from "@/lib/market/spans";

/** Holt linear exponential smoothing on closing prices. Not a machine-learning model. */
export const MODEL_NAME = "holt-linear";
export const MODEL_VERSION = "1";

export const HORIZONS = [
  { id: "15m", label: "Next 15 minutes", minutes: 15, days: 0 },
  { id: "30m", label: "Next 30 minutes", minutes: 30, days: 0 },
  { id: "1h", label: "Next 1 hour", minutes: 60, days: 0 },
  { id: "4h", label: "Next 4 hours", minutes: 240, days: 0 },
  { id: "session", label: "Next trading session", minutes: 0, days: 0 },
  { id: "1d", label: "Next 1 day", minutes: 0, days: 1 },
  { id: "3d", label: "Next 3 days", minutes: 0, days: 3 },
  { id: "5d", label: "Next 5 trading days", minutes: 0, days: 5 },
  { id: "1w", label: "Next 1 week", minutes: 0, days: 5 },
  { id: "1mo", label: "Next 1 month", minutes: 0, days: 21 },
] as const;

export type HorizonId = (typeof HORIZONS)[number]["id"];

export type ForecastPoint = {
  time: number;
  price: number;
  open: number | null;
  high: number | null;
  low: number | null;
  lower: number | null;
  upper: number | null;
};

export type ForecastValidation = {
  label: string;
  holdout: number;
  mae: number | null;
  rmse: number | null;
  directional: number | null;
};

export type ForecastResult = {
  status: "ready" | "insufficient" | "unavailable";
  message: string;
  model: typeof MODEL_NAME;
  modelVersion: typeof MODEL_VERSION;
  symbol: string;
  timeframe: ChartSpan;
  horizon: HorizonId;
  referencePrice: number | null;
  referenceTime: number | null;
  points: ForecastPoint[];
  endpoint: number | null;
  change: number | null;
  changePct: number | null;
  direction: "up" | "down" | "uncertain" | null;
  directionLabel: string;
  generatedAt: string;
  inputFrom: number | null;
  inputTo: number | null;
  inputCount: number;
  bands: boolean;
  stale: boolean;
  endTime: number | null;
  validation: ForecastValidation;
  warnings: string[];
  dataMode: string;
  dataMessage: string;
};

const MIN_BARS = 30;
const SESSION_OPEN = 9 * 60 + 15;
const SESSION_CLOSE = 15 * 60 + 30;
const SESSION_SECONDS = (SESSION_CLOSE - SESSION_OPEN) * 60;
const IST_OFFSET = 5.5 * 3600;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function istParts(time: number) {
  const shifted = new Date((time + IST_OFFSET) * 1000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    year,
    month,
    day,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: WEEKDAYS[shifted.getUTCDay()],
    dateKey: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
  };
}
const ALPHAS = [0.2, 0.4, 0.6, 0.8];
const BETAS = [0.1, 0.2, 0.4];

const BAR_SECONDS: Partial<Record<ChartSpan, number>> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
};

export function isHorizon(value: string | null): value is HorizonId {
  return HORIZONS.some((item) => item.id === value);
}

export function horizonLabel(id: HorizonId) {
  return HORIZONS.find((item) => item.id === id)?.label ?? id;
}

type Fit = { level: number; trend: number; sse: number; errors: number[] };

function fitHolt(values: number[], alpha: number, beta: number): Fit {
  let level = values[0];
  let trend = values.length > 1 ? values[1] - values[0] : 0;
  const errors: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const price = values[index];
    if (index > 0) errors.push(price - (level + trend));
    const nextLevel = alpha * price + (1 - alpha) * (level + trend);
    const nextTrend = beta * (nextLevel - level) + (1 - beta) * trend;
    level = nextLevel;
    trend = nextTrend;
  }
  const sse = errors.reduce((sum, error) => sum + error * error, 0);
  return { level, trend, sse, errors };
}

function bestHolt(values: number[]): Fit {
  let best = fitHolt(values, ALPHAS[0], BETAS[0]);
  for (const alpha of ALPHAS) {
    for (const beta of BETAS) {
      const fit = fitHolt(values, alpha, beta);
      if (fit.sse < best.sse) best = fit;
    }
  }
  return best;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Recent wick size from real candles, so a forecast bar has a high and low without inventing a new price. */
function typicalWicks(rows: Candle[]) {
  const sample = rows.slice(-60);
  const upper: number[] = [];
  const lower: number[] = [];
  for (const row of sample) {
    const top = Math.max(row.open, row.close);
    const bottom = Math.min(row.open, row.close);
    upper.push(Math.max(0, row.high - top));
    lower.push(Math.max(0, bottom - row.low));
  }
  return { upper: median(upper), lower: median(lower) };
}

function sampleStdev(values: number[]) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function cleanCandles(candles: Candle[]): { rows: Candle[]; warnings: string[] } {
  const warnings: string[] = [];
  const sorted = [...candles].filter((row) => Number.isFinite(row.time) && Number.isFinite(row.close) && row.close > 0 && row.high >= row.low);
  sorted.sort((a, b) => a.time - b.time);
  const rows: Candle[] = [];
  for (const row of sorted) {
    if (rows.length && rows[rows.length - 1].time === row.time) {
      rows[rows.length - 1] = row;
      continue;
    }
    if (rows.length && row.time < rows[rows.length - 1].time) continue;
    rows.push(row);
  }
  if (rows.length !== candles.length) warnings.push("Duplicate or invalid candles were left out of the fit.");
  return { rows, warnings };
}

function closedDay(time: number, holidays: string[]) {
  const parts = istParts(time);
  return parts.weekday === "Sat" || parts.weekday === "Sun" || holidays.includes(parts.dateKey);
}

function atIst(year: number, month: number, day: number, hour: number, minute: number) {
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute) / 1000) - IST_OFFSET;
}

function nextOpen(time: number, holidays: string[]) {
  const start = istParts(time);
  const minutes = start.hour * 60 + start.minute;
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  if (!closedDay(time, holidays) && minutes < SESSION_OPEN) {
    return atIst(start.year, start.month, start.day, 9, 15);
  }
  for (let step = 1; step <= 14; step += 1) {
    const day = new Date(cursor + step * 86400000);
    const stamp = atIst(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 9, 15);
    if (!closedDay(stamp, holidays)) return stamp;
  }
  return time + 86400;
}

function nextBar(time: number, timeframe: ChartSpan, holidays: string[]) {
  const step = BAR_SECONDS[timeframe];
  if (step) {
    const ahead = time + step;
    const parts = istParts(ahead);
    const minutes = parts.hour * 60 + parts.minute;
    if (!closedDay(ahead, holidays) && minutes >= SESSION_OPEN && minutes < SESSION_CLOSE) return ahead;
    return nextOpen(ahead, holidays);
  }
  if (timeframe === "1w") return time + 7 * 86400;
  if (timeframe === "1mo") return time + 30 * 86400;
  let cursor = time + 86400;
  for (let step = 0; step < 14; step += 1) {
    if (!closedDay(cursor, holidays)) return cursor;
    cursor += 86400;
  }
  return cursor;
}

function horizonBudget(id: HorizonId, lastTime: number, holidays: string[]) {
  const spec = HORIZONS.find((item) => item.id === id)!;
  if (spec.days > 0) return { days: spec.days, seconds: spec.days * SESSION_SECONDS };
  if (id === "session") {
    const parts = istParts(lastTime);
    const minutes = parts.hour * 60 + parts.minute;
    const remaining = !closedDay(lastTime, holidays) && minutes >= SESSION_OPEN && minutes < SESSION_CLOSE ? (SESSION_CLOSE - minutes) * 60 : SESSION_SECONDS;
    return { days: 0, seconds: Math.max(60, remaining) };
  }
  return { days: 0, seconds: spec.minutes * 60 };
}

function barDays(timeframe: ChartSpan) {
  if (timeframe === "1d") return 1;
  if (timeframe === "1w") return 5;
  if (timeframe === "1mo") return 21;
  return 0;
}

function takeSteps<T>(items: T[], max: number) {
  if (items.length <= max) return items;
  const picked: T[] = [];
  const used = new Set<number>();
  for (let index = 0; index < max; index += 1) {
    const at = index === max - 1 ? items.length - 1 : Math.round((index * (items.length - 1)) / (max - 1));
    if (used.has(at)) continue;
    used.add(at);
    picked.push(items[at]);
  }
  return picked;
}

function dataIsStale(lastTime: number, timeframe: ChartSpan, now: Date) {
  const age = Math.floor(now.getTime() / 1000) - lastTime;
  const width = BAR_SECONDS[timeframe];
  if (width) return age > Math.max(width * 8, 2 * 86400);
  if (timeframe === "1w") return age > 21 * 86400;
  if (timeframe === "1mo") return age > 70 * 86400;
  return age > 6 * 86400;
}

export function buildForecast(input: {
  symbol: string;
  timeframe: ChartSpan;
  horizon: HorizonId;
  candles: Candle[];
  holidays?: string[];
  dataMode?: string;
  dataMessage?: string;
  now?: Date;
}): ForecastResult {
  const holidays = input.holidays ?? [];
  const generatedAt = (input.now ?? new Date()).toISOString();
  const base: ForecastResult = {
    status: "insufficient",
    message: "",
    model: MODEL_NAME,
    modelVersion: MODEL_VERSION,
    symbol: input.symbol,
    timeframe: input.timeframe,
    horizon: input.horizon,
    referencePrice: null,
    referenceTime: null,
    points: [],
    endpoint: null,
    change: null,
    changePct: null,
    direction: null,
    directionLabel: "Direction uncertain",
    generatedAt,
    inputFrom: null,
    inputTo: null,
    inputCount: 0,
    bands: false,
    stale: false,
    endTime: null,
    validation: { label: "Accuracy not yet established", holdout: 0, mae: null, rmse: null, directional: null },
    warnings: [],
    dataMode: input.dataMode ?? "",
    dataMessage: input.dataMessage ?? "",
  };
  const { rows, warnings } = cleanCandles(input.candles);
  base.warnings = warnings;
  base.inputCount = rows.length;
  if (rows.length < MIN_BARS) {
    base.message = `Insufficient historical data for this forecast. At least ${MIN_BARS} closing prices are required, and ${rows.length} usable bars were returned.`;
    return base;
  }
  const bar = barDays(input.timeframe);
  const budget = horizonBudget(input.horizon, rows[rows.length - 1].time, holidays);
  if (bar > 0 && budget.days > 0 && budget.days < bar) {
    base.status = "unavailable";
    base.message = "This forecast horizon is shorter than one bar of the selected historical timeframe. Choose a finer timeframe or a longer horizon.";
    return base;
  }
  if (bar > 0 && budget.days === 0) {
    base.status = "unavailable";
    base.message = "An intraday horizon cannot be drawn on daily, weekly, or monthly bars. Choose an intraday historical timeframe.";
    return base;
  }
  const width = BAR_SECONDS[input.timeframe] ?? 0;
  if (width > 0 && budget.days === 0 && budget.seconds < width) {
    base.status = "unavailable";
    base.message = "This forecast horizon is shorter than one bar of the selected historical timeframe. Choose a finer timeframe or a longer horizon.";
    return base;
  }

  const closes = rows.map((row) => row.close);
  const fit = bestHolt(closes);
  const sigma = sampleStdev(fit.errors);
  const showBands = fit.errors.length >= 8 && sigma > 0;
  const last = rows[rows.length - 1];
  const schedule: Array<{ time: number; step: number }> = [];
  let cursor = last.time;
  let spentSeconds = 0;
  let spentDays = 0;
  for (let guard = 0; guard < 9000; guard += 1) {
    const ahead = nextBar(cursor, input.timeframe, holidays);
    if (ahead <= cursor) break;
    cursor = ahead;
    schedule.push({ time: cursor, step: schedule.length + 1 });
    if (bar > 0) {
      spentDays += bar;
      if (spentDays >= budget.days) break;
    } else {
      spentSeconds += width || 86400;
      if (spentSeconds >= budget.seconds) break;
    }
  }
  if (!schedule.length) {
    base.status = "unavailable";
    base.message = "No future session time could be placed for this horizon.";
    return base;
  }
  const plotted = takeSteps(schedule, 159);
  if (plotted.length < schedule.length) base.warnings.push(`The chart draws ${plotted.length} of ${schedule.length} forecast steps. The endpoint is still the horizon estimate.`);

  const wicks = typicalWicks(rows);
  const points: ForecastPoint[] = [{ time: last.time, price: last.close, open: null, high: null, low: null, lower: showBands ? last.close : null, upper: showBands ? last.close : null }];
  let previous = last.close;
  for (const item of plotted) {
    const price = fit.level + item.step * fit.trend;
    if (!(price > 0)) {
      base.warnings.push("The linear trend left the positive price range, so the path stops before that step.");
      break;
    }
    const open = previous;
    const high = Math.max(open, price) + wicks.upper;
    const low = Math.min(open, price) - wicks.lower;
    if (!(low > 0)) {
      base.warnings.push("The linear trend left the positive price range, so the path stops before that step.");
      break;
    }
    const band = showBands ? 1.96 * sigma * Math.sqrt(item.step) : 0;
    points.push({
      time: item.time,
      price,
      open,
      high,
      low,
      lower: showBands ? Math.max(0.01, price - band) : null,
      upper: showBands ? price + band : null,
    });
    previous = price;
  }
  if (points.length < 2) {
    base.status = "unavailable";
    base.message = "The fitted trend did not produce a usable positive price path.";
    return base;
  }

  const endpoint = points[points.length - 1];
  const change = endpoint.price - last.close;
  const changePct = (change / last.close) * 100;
  const halfBand = endpoint.upper != null && endpoint.lower != null ? (endpoint.upper - endpoint.lower) / 2 : 0;
  const direction = Math.abs(changePct) < 0.15 || halfBand > Math.abs(change) ? "uncertain" : change > 0 ? "up" : "down";
  const validation = walkForward(closes);
  const now = input.now ?? new Date();
  const stale = dataIsStale(last.time, input.timeframe, now);
  if (stale) base.warnings.push("The last historical candle is older than the freshness window for this timeframe.");
  if (!showBands) base.warnings.push("Residual bands are omitted because the one-step error sample is too small.");

  return {
    ...base,
    status: "ready",
    message: "Forecast candles use Holt linear smoothing on past closes. Each bar opens at the previous estimate and takes its wick from recent historical candles. These are estimates, not traded prices, and not financial advice.",
    referencePrice: last.close,
    referenceTime: last.time,
    points,
    endpoint: endpoint.price,
    change,
    changePct,
    direction,
    directionLabel: direction === "up" ? "Model-estimated upward scenario" : direction === "down" ? "Model-estimated downward scenario" : "Direction uncertain",
    inputFrom: rows[0].time,
    inputTo: last.time,
    bands: showBands,
    stale,
    endTime: endpoint.time,
    validation,
  };
}

function walkForward(closes: number[]): ForecastValidation {
  const start = Math.max(MIN_BARS, closes.length - 30);
  const errors: number[] = [];
  let directionalHits = 0;
  let directionalTried = 0;
  for (let index = start; index < closes.length; index += 1) {
    const fit = bestHolt(closes.slice(0, index));
    const predicted = fit.level + fit.trend;
    const actual = closes[index];
    errors.push(predicted - actual);
    const forecastMove = predicted - closes[index - 1];
    const actualMove = actual - closes[index - 1];
    if (actualMove !== 0) {
      directionalTried += 1;
      if (Math.sign(forecastMove) === Math.sign(actualMove)) directionalHits += 1;
    }
  }
  if (errors.length < 8) return { label: "Accuracy not yet established", holdout: errors.length, mae: null, rmse: null, directional: null };
  const mae = errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length;
  const rmse = Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length);
  return {
    label: "Walk-forward check on the loaded history. It does not guarantee the next forecast.",
    holdout: errors.length,
    mae,
    rmse,
    directional: directionalTried >= 8 ? (directionalHits / directionalTried) * 100 : null,
  };
}
