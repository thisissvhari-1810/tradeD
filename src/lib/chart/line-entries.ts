/**
 * Line Strategy Draw entry points: where each strategy would BUY on a session, from NIFTY's 1-minute candles.
 *
 * Pure and read-only: it never places, changes or cancels an order and never changes a strategy. Each strategy's
 * entry uses that strategy's own rules:
 *  - Mathi Hourly Zone Strategy — 5% and Mathi Trend Channel: the app's own signal functions (hourlySignal,
 *    channelSignal) with their default settings, evaluated minute by minute exactly like the algo runner does.
 *  - Mathi Second Hour, Mathi 13:15 Minute and Mathi Breakout – 9:15: the research rules (PROJECT_NEXUS), ported
 *    one-to-one (Plan F candidate / confirmation, the first-hour 108.8-point filter, flip tiny, VIX rules A and B).
 *  - Mathi Strategy: not marked here. Its entries depend on its option-premium exits and the regime filter (the last
 *    30 trades), so only the Algo can know them; the Algo's own trade markers show them.
 *
 * Only trade 1 is marked: a second trade depends on when trade 1 exits on the option, which the index cannot show.
 * Every entry is computed from candles that had closed by then, so nothing is ever shown before it happened.
 */
import type { Candle } from "@/lib/algo/lines";
import { HOURLY_SETTINGS_DEFAULTS, hourlySignal } from "@/lib/algo/hourly-zone";
import { CHANNEL_SETTINGS_DEFAULTS, channelSignal } from "@/lib/algo/trend-channel";
import type { S1Data } from "@/lib/trading/s1";
import type { LineDay, LineStrategyId } from "./line-drawings";

export type Side = "CALL" | "PUT";

export type LineEntry = {
  /** The buy candle (its opening time); the buy is at its close (`at`). */
  time: number;
  at: number;
  /** NIFTY at the buy (the buy candle's close). */
  price: number;
  /** The breakout's direction, and the option bought (flip tiny buys the opposite one). */
  side: Side;
  option: "CE" | "PE";
  flip: boolean;
  /** The broken line, when there is one. */
  level: number | null;
  note: string;
};

/**
 * One session's result. `entry` is null when there is no trade (yet): `status` says why, and `decidedAt` is when that
 * became known (before it, the strategy is still watching).
 */
export type EntryResult = { entry: LineEntry | null; status: string; decidedAt: number | null; watching: string };

const IST = 19_800;
const FIRST_HOUR_MAX = 108.8;
const FLIP_TINY = 1.4;
const WED_MOMENTUM = 16.2;
const GAP_MIN = -0.5;

export const istMinute = (time: number) => Math.floor((((time + IST) % 86_400) + 86_400) % 86_400 / 60);
export const istClock = (time: number) => {
  const minute = istMinute(time);
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
};
const hm = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const round = (value: number) => Math.round(value * 100) / 100;
const fmt = (value: number) => value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday … 3 = Wednesday

/** The 20%-of-body breakout test (research body_break / TradeD bodyBreakout): points beyond, or null. */
export function bodyBreak(candle: Candle, side: Side, level: number, share = 0.2): number | null {
  const body = Math.abs(candle.close - candle.open);
  if (!(body > 0)) return null;
  const beyond = side === "CALL" ? candle.close - Math.max(candle.open, level) : Math.min(candle.open, level) - candle.close;
  const closed = side === "CALL" ? candle.close > level : candle.close < level;
  if (!closed || !(beyond > 0) || beyond < body * share - 1e-9) return null;
  return beyond;
}

/**
 * Plan F (research f_signal / minute_signal): a 20% body break is a candidate; the next candle closing beyond the line
 * confirms it. While waiting, a 20% break of the opposite line switches the candidate, and a strong close back inside
 * (the 20% rule mirrored on the same line) cancels it — that candle may start a new one.
 */
export function candidateSignal(bars: Map<number, Candle>, minutes: number[], lines: { CALL: number; PUT: number }) {
  let cand: { side: Side; level: number; brk: Candle } | null = null;
  for (const minute of minutes) {
    const candle = bars.get(minute);
    if (!candle) continue;
    if (cand) {
      if (cand.side === "CALL" ? candle.close > cand.level : candle.close < cand.level) return { ...cand, conf: candle };
      const other: Side = cand.side === "CALL" ? "PUT" : "CALL";
      if (bodyBreak(candle, other, lines[other]) != null) {
        cand = { side: other, level: lines[other], brk: candle };
        continue;
      }
      if (bodyBreak(candle, other, cand.level) != null) cand = null;
      else continue;
    }
    for (const side of ["CALL", "PUT"] as const) {
      if (bodyBreak(candle, side, lines[side]) != null) {
        cand = { side, level: lines[side], brk: candle };
        break;
      }
    }
  }
  return null;
}

/** The session's 1-minute candles by IST minute (09:15 = 555). */
function byMinute(tape: Candle[], data: S1Data) {
  const bars = new Map<number, Candle>();
  for (const bar of tape) if (bar.time >= data.sessionOpen && bar.time < data.sessionClose) bars.set(istMinute(bar.time), bar);
  return bars;
}

function rangeOf(bars: Map<number, Candle>, from: number, to: number) {
  const inside = [...bars.entries()].filter(([minute]) => minute >= from && minute < to).map(([, bar]) => bar);
  if (!inside.length) return null;
  return { high: Math.max(...inside.map((bar) => bar.high)), low: Math.min(...inside.map((bar) => bar.low)), count: inside.length };
}

const minuteTime = (data: S1Data, minute: number) => data.sessionOpen + (minute - 555) * 60;
const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const optionOf = (side: Side, flip: boolean): "CE" | "PE" => ((side === "CALL") !== flip ? "CE" : "PE");

function entryOf(candle: Candle, side: Side, flip: boolean, level: number | null, note: string): LineEntry {
  return { time: candle.time, at: candle.time + 60, price: round(candle.close), side, option: optionOf(side, flip), flip, level: level == null ? null : round(level), note };
}

/** The first-hour (09:15–10:15) range filter shared by Second Hour and 13:15 Minute. */
function firstHourSkip(bars: Map<number, Candle>, data: S1Data): EntryResult | null {
  const first = rangeOf(bars, 555, 615);
  if (!first || first.count < 60) return null;
  const range = first.high - first.low;
  return range >= FIRST_HOUR_MAX ? { entry: null, status: `No trade today: first-hour range ${range.toFixed(1)} pts ≥ ${FIRST_HOUR_MAX}.`, decidedAt: minuteTime(data, 615), watching: "" } : null;
}

function secondHour(bars: Map<number, Candle>, data: S1Data): EntryResult {
  const watching = "Watching the 10:15–11:15 high / low from 11:15 to 12:10.";
  const skip = firstHourSkip(bars, data);
  if (skip) return skip;
  const hour = rangeOf(bars, 615, 675);
  if (!hour || hour.count !== 60) return { entry: null, status: hour ? "No trade: the 10:15–11:15 candle is missing minutes." : "", decidedAt: hour ? minuteTime(data, 675) : null, watching };
  const signal = candidateSignal(bars, span(675, 730), { CALL: hour.high, PUT: hour.low });
  if (!signal) return { entry: null, status: "No trade: no confirmed breakout by 12:10.", decidedAt: minuteTime(data, 731), watching };
  const sd = signal.side === "CALL" ? 1 : -1;
  const past = sd * (signal.brk.close - signal.level);
  const flip = past < FLIP_TINY;
  if (weekday(data.date) === 3) {
    const open = bars.get(555)?.open ?? null;
    const gap = open != null && data.previous ? (open / data.previous.close - 1) * 100 : 0;
    const before = bars.get(istMinute(signal.conf.time) - 15);
    const momentum = before ? sd * (signal.conf.close - before.close) : 0;
    if (!(gap > GAP_MIN && momentum >= WED_MOMENTUM)) {
      return { entry: null, status: `No trade: Wednesday ${gap <= GAP_MIN ? `gap down ${gap.toFixed(2)}%` : `momentum ${momentum.toFixed(1)} pts < ${WED_MOMENTUM}`}.`, decidedAt: signal.conf.time + 60, watching };
    }
  }
  const note = `${signal.side === "CALL" ? "High" : "Low"} ${fmt(signal.level)} broken at ${istClock(signal.brk.time)} (${past.toFixed(1)} pts past), confirmed at ${istClock(signal.conf.time)}${flip ? `; flip tiny (< ${FLIP_TINY} pts) buys the opposite option` : ""}.`;
  return { entry: entryOf(signal.conf, signal.side, flip, signal.level, note), status: "", decidedAt: signal.conf.time + 60, watching };
}

function minute1315(bars: Map<number, Candle>, data: S1Data, vix: Candle[] | null): EntryResult {
  const watching = "Watching the 13:15 candle's high / low from 13:16 to 13:45.";
  const skip = firstHourSkip(bars, data);
  if (skip) return skip;
  const line = bars.get(795);
  if (!line) return { entry: null, status: "", decidedAt: null, watching };
  const signal = candidateSignal(bars, span(796, 825), { CALL: line.high, PUT: line.low });
  if (!signal) return { entry: null, status: "No trade: no confirmed 13:15-candle breakout by 13:45.", decidedAt: minuteTime(data, 826), watching };
  const at = signal.conf.time + 60;
  const sd = signal.side === "CALL" ? 1 : -1;
  const open = bars.get(555)?.open ?? null;
  const dayMove = open == null ? 0 : sd * (signal.conf.close - open);
  if (dayMove <= 0) return { entry: null, status: `No trade: breakout against the day direction (${dayMove.toFixed(1)} pts vs the 09:15 open).`, decidedAt: at, watching };
  const vixBar = vix?.find((bar) => istMinute(bar.time) === istMinute(signal.conf.time)) ?? null;
  const v = vixBar?.close ?? null;
  const past = sd * (signal.conf.close - signal.level);
  const wednesday = weekday(data.date) === 3;
  if (v != null && v <= 12) return { entry: null, status: `No trade: VIX ${v.toFixed(2)} ≤ 12.`, decidedAt: at, watching };
  if (v != null && v <= 12.5 && past < 4) return { entry: null, status: `No trade (rule A): VIX ${v.toFixed(2)} and only ${past.toFixed(1)} pts past the line.`, decidedAt: at, watching };
  if (wednesday && ((v != null && v <= 12.5) || istMinute(signal.conf.time) > hm("13:25"))) {
    return { entry: null, status: `No trade (rule B): Wednesday needs VIX > 12.5 and a buy by 13:25.`, decidedAt: at, watching };
  }
  const note = `${signal.side === "CALL" ? "High" : "Low"} ${fmt(signal.level)} broken at ${istClock(signal.brk.time)}, confirmed at ${istClock(signal.conf.time)}${v == null ? "; VIX not available, its rules were not checked" : `; VIX ${v.toFixed(2)}`}.`;
  return { entry: entryOf(signal.conf, signal.side, false, signal.level, note), status: "", decidedAt: at, watching };
}

function breakout0915(bars: Map<number, Candle>, data: S1Data): EntryResult {
  const watching = "Watching the 09:15 candle's high / low from 09:16 to 09:39.";
  const first = bars.get(555);
  if (!first) return { entry: null, status: "", decidedAt: null, watching };
  for (const minute of span(556, 579)) {
    const candle = bars.get(minute);
    if (!candle) continue;
    if (candle.close > first.high) return { entry: entryOf(candle, "CALL", false, first.high, `First close above the 09:15 high ${fmt(first.high)}.`), status: "", decidedAt: candle.time + 60, watching };
    if (candle.close < first.low) return { entry: entryOf(candle, "PUT", false, first.low, `First close below the 09:15 low ${fmt(first.low)}.`), status: "", decidedAt: candle.time + 60, watching };
  }
  return { entry: null, status: "No trade: no close beyond the 09:15 candle by 09:39.", decidedAt: minuteTime(data, 580), watching };
}

/** The app's own signal functions, called on each completed minute in turn like the algo runner; the first signal. */
function firstAppSignal(tape: Candle[], data: S1Data, strategy: "hourly_zone" | "trend_channel"): EntryResult {
  const candles = tape.filter((bar) => bar.time >= data.sessionOpen && bar.time < data.sessionClose).sort((a, b) => a.time - b.time);
  const prevClose = data.previous?.close ?? null;
  const start = data.sessionOpen + (strategy === "hourly_zone" ? 7_200 - 60 : 0);
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.time < start) continue;
    const upTo = candles.slice(0, index + 1);
    const signal = strategy === "hourly_zone"
      ? hourlySignal(upTo, data.sessionOpen, HOURLY_SETTINGS_DEFAULTS).signal
      : channelSignal(upTo, data.sessionOpen, CHANNEL_SETTINGS_DEFAULTS, candle.time + 60, prevClose).signal;
    if (signal) {
      const note = signal.reason.length > 220 ? `${signal.reason.slice(0, 217)}…` : signal.reason;
      return { entry: { time: candle.time, at: candle.time + 60, price: round(candle.close), side: signal.direction, option: signal.direction === "CALL" ? "CE" : "PE", flip: false, level: round(signal.level), note }, status: "", decidedAt: candle.time + 60, watching: "" };
    }
  }
  const complete = candles.length && candles.at(-1)!.time + 60 >= data.sessionClose - 60;
  return { entry: null, status: complete ? "No trade this session." : "", decidedAt: complete ? data.sessionClose : null, watching: strategy === "hourly_zone" ? "Watching from 11:15 (default settings)." : "Watching the 3-minute channel (default settings)." };
}

/** The whole session's trade-1 entry for one strategy (computed once per session's data; filter by the clock with entryAt). */
export function strategyEntry(strategy: LineStrategyId, data: S1Data | null, tape: Candle[] | null, vix: Candle[] | null = null): EntryResult {
  if (strategy === "mathi") return { entry: null, status: "", decidedAt: null, watching: "Its entries depend on the +3% option exit and the regime filter, so the Algo marks them (Algo trade)." };
  if (!data || !tape?.length) return { entry: null, status: "", decidedAt: null, watching: data ? "Waiting for the session's candles." : "" };
  const bars = byMinute(tape, data);
  if (strategy === "second_hour") return secondHour(bars, data);
  if (strategy === "minute_1315") return minute1315(bars, data, vix);
  if (strategy === "breakout_0915") return breakout0915(bars, data);
  return firstAppSignal(tape, data, strategy);
}

/** The result as known at `clock` (replay cursor or now): nothing after it. */
export function entryAt(result: EntryResult, clock: number): EntryResult {
  if (result.entry && result.entry.at > clock) return { ...result, entry: null, status: "", decidedAt: null };
  if (!result.entry && result.decidedAt != null && result.decidedAt > clock) return { ...result, status: "", decidedAt: null };
  return result;
}

/** One line for the panel and the marker tooltip. */
export function entryText(entry: LineEntry) {
  return `BUY ATM ${entry.option === "CE" ? "CALL (CE)" : "PUT (PE)"} at the ${istClock(entry.time)} candle close · NIFTY ${fmt(entry.price)}`;
}

const cache = new WeakMap<LineDay, Map<LineStrategyId, EntryResult>>();

/** strategyEntry for one loaded session, computed once per strategy (the session object changes when it reloads). */
export function sessionEntry(strategy: LineStrategyId, day: LineDay | null): EntryResult {
  if (!day) return strategyEntry(strategy, null, null);
  let byStrategy = cache.get(day);
  if (!byStrategy) cache.set(day, (byStrategy = new Map()));
  let result = byStrategy.get(strategy);
  if (!result) byStrategy.set(strategy, (result = strategyEntry(strategy, day.data, day.tape, day.vix ?? null)));
  return result;
}
