export type LinePoint = { time: number; value: number };

export function sma(values: number[], period: number): Array<number | null> {
  return values.map((_, index) => {
    if (index + 1 < period) return null;
    const slice = values.slice(index + 1 - period, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / period;
  });
}

export function rsi(values: number[], period = 14): Array<number | null> {
  const result: Array<number | null> = values.map(() => null);
  if (values.length <= period) return result;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): { macd: Array<number | null>; signal: Array<number | null>; histogram: Array<number | null> } {
  const ema = (period: number) => {
    const series: Array<number | null> = values.map(() => null);
    const k = 2 / (period + 1);
    let previous = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    series[period - 1] = previous;
    for (let i = period; i < values.length; i += 1) {
      previous = values[i] * k + previous * (1 - k);
      series[i] = previous;
    }
    return series;
  };
  const fastEma = ema(fast);
  const slowEma = ema(slow);
  const macdLine = values.map((_, index) => (fastEma[index] == null || slowEma[index] == null ? null : (fastEma[index] as number) - (slowEma[index] as number)));
  const signal: Array<number | null> = values.map(() => null);
  const histogram: Array<number | null> = values.map(() => null);
  const first = macdLine.findIndex((value) => value != null);
  if (first >= 0) {
    const seed = macdLine.slice(first, first + signalPeriod).filter((value): value is number => value != null);
    if (seed.length === signalPeriod) {
      let previous = seed.reduce((sum, value) => sum + value, 0) / signalPeriod;
      const start = first + signalPeriod - 1;
      signal[start] = previous;
      histogram[start] = (macdLine[start] as number) - previous;
      const k = 2 / (signalPeriod + 1);
      for (let i = start + 1; i < values.length; i += 1) {
        if (macdLine[i] == null) continue;
        previous = (macdLine[i] as number) * k + previous * (1 - k);
        signal[i] = previous;
        histogram[i] = (macdLine[i] as number) - previous;
      }
    }
  }
  return { macd: macdLine, signal, histogram };
}

export function ema(values: number[], period: number): Array<number | null> {
  const series: Array<number | null> = values.map(() => null);
  if (period < 1 || values.length < period) return series;
  const k = 2 / (period + 1);
  let previous = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  series[period - 1] = previous;
  for (let index = period; index < values.length; index += 1) {
    previous = values[index] * k + previous * (1 - k);
    series[index] = previous;
  }
  return series;
}

export function bollinger(values: number[], period = 20, multiplier = 2): { middle: Array<number | null>; upper: Array<number | null>; lower: Array<number | null> } {
  const middle = sma(values, period);
  const upper = middle.map((mid, index) => {
    if (mid == null) return null;
    const slice = values.slice(index + 1 - period, index + 1);
    const variance = slice.reduce((sum, value) => sum + (value - mid) ** 2, 0) / period;
    return mid + multiplier * Math.sqrt(variance);
  });
  const lower = middle.map((mid, index) => (mid == null || upper[index] == null ? null : mid - ((upper[index] as number) - mid)));
  return { middle, upper, lower };
}

export function vwap(bars: Array<{ high: number; low: number; close: number; volume: number }>): Array<number | null> {
  let priceVolume = 0;
  let volume = 0;
  return bars.map((bar) => {
    if (bar.volume <= 0) return null;
    priceVolume += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
    volume += bar.volume;
    return priceVolume / volume;
  });
}

export function supertrend(bars: Array<{ high: number; low: number; close: number }>, period = 10, multiplier = 3): Array<number | null> {
  const result: Array<number | null> = bars.map(() => null);
  if (period < 1 || bars.length <= period) return result;
  const tr = bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const previous = bars[index - 1].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
  });
  const atr: number[] = [];
  let seed = 0;
  for (let index = 0; index < period; index += 1) seed += tr[index];
  atr[period - 1] = seed / period;
  for (let index = period; index < bars.length; index += 1) atr[index] = (atr[index - 1] * (period - 1) + tr[index]) / period;
  let finalUpper = 0;
  let finalLower = 0;
  let up = true;
  for (let index = period - 1; index < bars.length; index += 1) {
    const mid = (bars[index].high + bars[index].low) / 2;
    const basicUpper = mid + multiplier * atr[index];
    const basicLower = mid - multiplier * atr[index];
    if (index === period - 1) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      result[index] = finalLower;
      continue;
    }
    finalUpper = basicUpper < finalUpper || bars[index - 1].close > finalUpper ? basicUpper : finalUpper;
    finalLower = basicLower > finalLower || bars[index - 1].close < finalLower ? basicLower : finalLower;
    if (up && bars[index].close < finalLower) up = false;
    else if (!up && bars[index].close > finalUpper) up = true;
    result[index] = up ? finalLower : finalUpper;
  }
  return result;
}

export function toLine(times: number[], series: Array<number | null>): LinePoint[] {
  return series.flatMap((value, index) => (value == null ? [] : [{ time: times[index], value }]));
}
