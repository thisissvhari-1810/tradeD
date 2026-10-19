export type TimeBar = { time: number };

/** Index of a timestamp on the current candle series, including the fraction between bars. */
export function timeToLogical(bars: TimeBar[], time: number): number | null {
  if (!bars.length || !Number.isFinite(time)) return null;
  if (bars.length === 1) return 0;
  if (time <= bars[0].time) return (time - bars[0].time) / edgeStep(bars, 0);
  const last = bars.length - 1;
  if (time >= bars[last].time) return last + (time - bars[last].time) / edgeStep(bars, last - 1);
  let low = 0;
  let high = last;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (bars[mid].time <= time) low = mid;
    else high = mid;
  }
  const span = bars[high].time - bars[low].time;
  if (span <= 0) return low;
  return low + (time - bars[low].time) / span;
}

/** Timestamp for a fractional candle index. This is the inverse of timeToLogical. */
export function logicalToTime(bars: TimeBar[], logical: number): number | null {
  if (!bars.length || !Number.isFinite(logical)) return null;
  if (bars.length === 1) return bars[0].time;
  if (logical <= 0) return bars[0].time + logical * edgeStep(bars, 0);
  const last = bars.length - 1;
  if (logical >= last) return bars[last].time + (logical - last) * edgeStep(bars, last - 1);
  const low = Math.floor(logical);
  const high = Math.min(last, low + 1);
  return bars[low].time + (bars[high].time - bars[low].time) * (logical - low);
}

/**
 * Screen X for a saved timestamp.
 * The chart library returns 0 for a fractional index, so the fraction is applied between the two integer indexes.
 */
export function timeToScreenX(logicalToCoordinate: (index: number) => number | null, bars: TimeBar[], time: number): number | null {
  const logical = timeToLogical(bars, time);
  if (logical == null) return null;
  const left = Math.floor(logical);
  const right = Math.ceil(logical);
  const start = logicalToCoordinate(left);
  const end = left === right ? start : logicalToCoordinate(right);
  if (start == null || end == null) return null;
  if (left === right) return start;
  return start + (end - start) * (logical - left);
}

export function screenXToTime(coordinateToLogical: (x: number) => number | null, bars: TimeBar[], x: number): number | null {
  const logical = coordinateToLogical(x);
  if (logical == null) return null;
  return logicalToTime(bars, logical);
}

function edgeStep(bars: TimeBar[], index: number) {
  const step = bars[index + 1].time - bars[index].time;
  return step > 0 ? step : 60;
}
