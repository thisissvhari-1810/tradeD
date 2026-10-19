import { kolkataParts } from "@/lib/market/clock";
import type { Candle } from "@/lib/market/demo";
import { aggregateCount, aggregateMinutes, aggregatePeriod, type ChartSpan } from "@/lib/market/spans";
import { istDay } from "@/lib/trading/demo-replay";

/** One wall-clock second at 1x reveals one minute of the session. Speed scales time, not prices. */
export const REPLAY_MINUTE_MS = 1000;
export const REPLAY_SPEEDS = [0.5, 1, 2, 5, 10] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
export type ReplayStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "completed" | "error";

export const REPLAY_STATUS_LABEL: Record<ReplayStatus, string> = {
  idle: "Idle",
  loading: "Loading",
  ready: "Ready",
  playing: "Playing",
  paused: "Paused",
  completed: "Completed",
  error: "Error",
};

const MINUTE = 60;

export type SessionCheck =
  | { ok: true; open: number; close: number }
  | { ok: false; reason: "invalid" | "weekend" | "holiday" | "future"; message: string };

/** NSE cash session for a calendar date in Asia/Kolkata. 09:15 inclusive, 15:30 exclusive of new trades. */
export function describeSession(date: string, holidays: string[], today: string): SessionCheck {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, reason: "invalid", message: "Choose a session date." };
  }
  const [year, month, day] = date.split("-").map(Number);
  const open = Math.floor(Date.UTC(year, month - 1, day, 3, 45, 0) / 1000);
  const close = Math.floor(Date.UTC(year, month - 1, day, 10, 0, 0) / 1000);
  const parts = kolkataParts(new Date(open * 1000));
  if (parts.dateKey !== date) return { ok: false, reason: "invalid", message: "That date is not a real calendar day." };
  if (parts.weekday === "Sat" || parts.weekday === "Sun") {
    return { ok: false, reason: "weekend", message: `${date} is a ${parts.weekday === "Sat" ? "Saturday" : "Sunday"}. The cash session is closed, so no candles were loaded.` };
  }
  if (holidays.includes(date)) {
    return { ok: false, reason: "holiday", message: `${date} is an exchange holiday. No candles were loaded.` };
  }
  if (date > today) return { ok: false, reason: "future", message: `${date} is after the latest session. Pick a date that has already traded.` };
  return { ok: true, open, close };
}

export function previousWeekday(now: Date): string {
  const start = kolkataParts(now);
  const bounds = describeSession(start.dateKey, [], start.dateKey);
  let cursor = bounds.ok ? bounds.open : Math.floor(now.getTime() / 1000);
  for (let step = 0; step < 10; step += 1) {
    cursor -= 86_400;
    const parts = kolkataParts(new Date(cursor * 1000));
    if (parts.weekday !== "Sat" && parts.weekday !== "Sun") return parts.dateKey;
  }
  return start.dateKey;
}

export function isReplaySpeed(value: number): value is ReplaySpeed {
  return (REPLAY_SPEEDS as readonly number[]).includes(value);
}

/** HH:mm in Asia/Kolkata, suitable for a time input. */
export function clockLabel(cursor: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(cursor * 1000));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${read("hour").padStart(2, "0")}:${read("minute").padStart(2, "0")}`;
}

/** Place the replay clock at an IST time on the selected session date, clamped to the session. */
export function cursorFromClock(date: string, clock: string, sessionOpen: number, sessionClose: number): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !match) return null;
  const [year, month, day] = date.split("-").map(Number);
  const cursor = Math.floor(Date.UTC(year, month - 1, day, Number(match[1]) - 5, Number(match[2]) - 30, 0) / 1000);
  if (!Number.isFinite(cursor)) return null;
  return Math.min(sessionClose, Math.max(sessionOpen, cursor));
}

export function normalizeTape(candles: Candle[]): Candle[] {
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const candle of [...candles].sort((left, right) => left.time - right.time)) {
    if (seen.has(candle.time)) continue;
    if (![candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)) continue;
    seen.add(candle.time);
    out.push({ ...candle, volume: Number.isFinite(candle.volume) && candle.volume > 0 ? candle.volume : 0 });
  }
  return out;
}

/**
 * A one-minute bar's open is known at its start. High, low, close, and volume stay hidden until the minute ends.
 * Bars after the cursor are omitted. Nothing is interpolated into a gap.
 */
export function revealMinutes(tape: Candle[], cursor: number): Candle[] {
  const out: Candle[] = [];
  for (const bar of tape) {
    if (cursor < bar.time) break;
    if (cursor < bar.time + MINUTE) {
      out.push({ time: bar.time, open: bar.open, high: bar.open, low: bar.open, close: bar.open, volume: 0 });
    } else {
      out.push(bar);
    }
  }
  return out;
}

export function completedMinutes(tape: Candle[], cursor: number): Candle[] {
  return tape.filter((bar) => cursor >= bar.time + MINUTE);
}

function foldDay(bars: Candle[]): Candle {
  const first = bars[0];
  const last = bars[bars.length - 1];
  return {
    time: first.time,
    open: first.open,
    high: Math.max(...bars.map((bar) => bar.high)),
    low: Math.min(...bars.map((bar) => bar.low)),
    close: last.close,
    volume: bars.reduce((sum, bar) => sum + bar.volume, 0),
  };
}

export type PreviousSession = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

function priced(bar: Candle): boolean {
  return [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0);
}

/** Last completed daily session before the selected date. Weekends and holidays are skipped because they have no bar. */
export function previousSession(priorDaily: Candle[], date: string): PreviousSession | null {
  const prior = priorDaily.filter((bar) => istDay(bar.time) < date && priced(bar)).sort((left, right) => left.time - right.time);
  const last = prior.at(-1);
  if (!last) return null;
  return { date: istDay(last.time), open: last.open, high: last.high, low: last.low, close: last.close };
}

/** Same previous session, folded from completed one-minute bars when a daily bar was not returned. */
export function previousSessionFromMinutes(context: Candle[], date: string): PreviousSession | null {
  const prior = context.filter((bar) => istDay(bar.time) < date && priced(bar)).sort((left, right) => left.time - right.time);
  const last = prior.at(-1);
  if (!last) return null;
  const day = istDay(last.time);
  const bars = prior.filter((bar) => istDay(bar.time) === day);
  return {
    date: day,
    open: bars[0].open,
    high: Math.max(...bars.map((bar) => bar.high)),
    low: Math.min(...bars.map((bar) => bar.low)),
    close: bars[bars.length - 1].close,
  };
}

function earlierMinutes(context: Candle[], date: string): Candle[] {
  return context.filter((bar) => istDay(bar.time) < date && priced(bar));
}

/** Daily bars before the replay date. A session present only in the one-minute history is folded in so that day still appears. */
function dailyContext(priorDaily: Candle[], context: Candle[], date: string): Candle[] {
  const prior = priorDaily.filter((bar) => istDay(bar.time) < date && priced(bar));
  const seen = new Set(prior.map((bar) => istDay(bar.time)));
  const groups = new Map<string, Candle[]>();
  for (const bar of earlierMinutes(context, date)) {
    const day = istDay(bar.time);
    if (seen.has(day)) continue;
    const list = groups.get(day);
    if (list) list.push(bar);
    else groups.set(day, [bar]);
  }
  const filled = [...groups.values()].map((bars) => foldDay(bars));
  return [...prior, ...filled].sort((left, right) => left.time - right.time);
}

/** Prefer the later real session. A daily bar is kept when both sources describe the same date. */
export function selectPreviousSession(priorDaily: Candle[], context: Candle[], date: string): PreviousSession | null {
  const fromDaily = previousSession(priorDaily, date);
  const fromMinutes = previousSessionFromMinutes(context, date);
  if (!fromDaily) return fromMinutes;
  if (!fromMinutes) return fromDaily;
  return fromMinutes.date > fromDaily.date ? fromMinutes : fromDaily;
}

function joinContext(history: Candle[], replay: Candle[]): Candle[] {
  const seen = new Set(history.map((bar) => bar.time));
  const out = [...history];
  for (const bar of replay) {
    if (seen.has(bar.time)) continue;
    out.push(bar);
  }
  return out;
}

/**
 * Visible candles for the selected timeframe.
 * Completed sessions before the date stay on the chart. The selected session is folded only from minutes the cursor has reached.
 * The two layers are aggregated separately so a higher-timeframe bar cannot mix a finished session with a still-hidden minute.
 */
export function projectReplay(tape: Candle[], priorDaily: Candle[], timeframe: ChartSpan, cursor: number, date: string, context: Candle[] = []): Candle[] {
  const revealed = revealMinutes(tape, cursor);
  const history = earlierMinutes(context, date);
  if (timeframe === "1m") return joinContext(history, revealed);
  if (timeframe === "3m" || timeframe === "5m" || timeframe === "15m" || timeframe === "30m" || timeframe === "1h") {
    const minutes = timeframe === "3m" ? 3 : timeframe === "5m" ? 5 : timeframe === "15m" ? 15 : timeframe === "30m" ? 30 : 60;
    return joinContext(aggregateMinutes(history, minutes), aggregateMinutes(revealed, minutes));
  }
  if (timeframe === "2h" || timeframe === "4h") {
    const count = timeframe === "2h" ? 2 : 4;
    return joinContext(aggregateCount(aggregateMinutes(history, 60), count), aggregateCount(aggregateMinutes(revealed, 60), count));
  }
  const prior = dailyContext(priorDaily, context, date);
  const forming = revealed.length ? foldDay(revealed) : null;
  const daily = forming ? [...prior, forming] : prior;
  if (timeframe === "1w") return aggregatePeriod(daily, "week");
  if (timeframe === "1mo") return aggregatePeriod(daily, "month");
  return daily;
}

export function simulatedBar(tape: Candle[], cursor: number): Candle | null {
  return revealMinutes(tape, cursor).at(-1) ?? null;
}

/** Price a replay order may use. A forming minute exposes only its open. */
export function replayFillPrice(tape: Candle[], cursor: number): number | null {
  const bar = simulatedBar(tape, cursor);
  return bar && bar.close > 0 ? bar.close : null;
}

export function advanceCursor(cursor: number, sessionOpen: number, sessionClose: number, elapsedMs: number, speed: ReplaySpeed): { cursor: number; completed: boolean } {
  const delta = (elapsedMs / REPLAY_MINUTE_MS) * MINUTE * speed;
  const next = Math.min(sessionClose, Math.max(sessionOpen, cursor + delta));
  return { cursor: next, completed: next >= sessionClose };
}

export function stepCursor(cursor: number, sessionOpen: number, sessionClose: number, direction: -1 | 1): number {
  const next = cursor + direction * MINUTE;
  if (next < sessionOpen) return sessionOpen;
  if (next > sessionClose) return sessionClose;
  return next;
}

export function replayProgress(cursor: number, sessionOpen: number, sessionClose: number): number {
  if (sessionClose <= sessionOpen) return 0;
  return Math.min(1, Math.max(0, (cursor - sessionOpen) / (sessionClose - sessionOpen)));
}
