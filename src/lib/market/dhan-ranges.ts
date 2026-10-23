/**
 * End times to try for an intraday request, latest first: the requested end (never after now), then the
 * 15:30 close of that day and of up to three earlier days. Before 09:15 the provider refuses an end
 * on a day that has not opened ("Missing required fields, bad values for parameters", DH-905).
 */
export function intradayEnds(until: string): string[] {
  const ends = [until];
  const [year, month, day] = until.slice(0, 10).split("-").map(Number);
  for (let back = 0; back <= 3; back += 1) {
    const date = new Date(Date.UTC(year, month - 1, day - back)).toISOString().slice(0, 10);
    const close = `${date} 15:30:00`;
    if (close < ends[ends.length - 1]) ends.push(close);
  }
  return ends;
}

/** The IST date `days` calendar days before a "YYYY-MM-DD ..." stamp. */
export function daysBefore(stamp: string, days: number) {
  const [year, month, day] = stamp.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - days)).toISOString().slice(0, 10);
}
