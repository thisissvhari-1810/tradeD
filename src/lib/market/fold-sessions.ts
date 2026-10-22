import type { Candle } from "@/lib/market/demo";

const istDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYY-MM-DD in IST for a UTC-seconds timestamp. */
export function istDateKey(seconds: number) {
  return istDate.format(new Date(seconds * 1000));
}

/** Folds intraday bars into one daily bar per IST date after `afterDay`. */
export function foldSessions(minutes: Candle[], afterDay: string, lastDailyTime: number | null): Candle[] {
  const midnight = (key: string) => {
    const [year, month, day] = key.split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 1000) - 19_800;
  };
  // Keep the provider's daily stamp convention (offset from IST midnight) when there is a daily bar.
  const offset = lastDailyTime != null ? lastDailyTime - midnight(istDateKey(lastDailyTime)) : 0;
  const days = new Map<string, Candle[]>();
  for (const bar of [...minutes].sort((a, b) => a.time - b.time)) {
    if (![bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)) continue;
    const day = istDateKey(bar.time);
    if (afterDay && day <= afterDay) continue;
    days.set(day, [...(days.get(day) ?? []), bar]);
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, bars]) => ({
    time: midnight(day) + offset,
    open: bars[0].open,
    high: Math.max(...bars.map((bar) => bar.high)),
    low: Math.min(...bars.map((bar) => bar.low)),
    close: bars[bars.length - 1].close,
    volume: bars.reduce((sum, bar) => sum + (Number.isFinite(bar.volume) ? bar.volume : 0), 0),
  }));
}

