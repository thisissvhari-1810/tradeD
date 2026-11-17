/**
 * Mathi Hourly Breakout — 1% (research version, 12 Nov 2026). A separate strategy from Mathi Hourly Zone Strategy — 5%:
 * none of that strategy's rules (colour → Long / Short, mid, 10-point zone, shape rules, waits, half lots, midpoint
 * exit, early exits, 5% target) are used here, and this file shares no settings with it.
 *
 * Rules:
 * 1. Hourly candles from completed 1-minute NIFTY spot candles on the 09:15 IST grid. Candle 2 = 10:15–11:15
 *    (its 60 minutes 10:15 … 11:14 must all be present).
 * 2. At 11:15: CALL level = candle 2 HIGH, PUT level = candle 2 LOW. Fixed for the session.
 * 3. From the 11:15 minute on, each COMPLETED 1-minute candle is checked (never a forming one):
 *    CALL: close > HIGH, body > 0 and (close − max(open, HIGH)) ≥ 20% × |close − open|.
 *    PUT:  close < LOW,  body > 0 and (min(open, LOW) − close) ≥ 20% × |close − open|.
 *    A wick-only break (close not beyond the level) is not a signal.
 * 4. The first valid breakout decides the side; one trade a session; nothing after the entry cutoff; no fallback.
 *
 * Execution (entry, 1% target, 15:20 square-off) is in the backtest script; this module is pure and unit-tested.
 */
import type { Candle } from "./lines";

export type BreakoutSettings = {
  /** Share of the 1-minute candle's real body that must be beyond the level (0.20 = 20%). */
  bodyShare: number;
  /** The last minute a breakout candle may CLOSE at (IST "HH:MM"); later breakouts are not traded. */
  entryCutoff: string;
  /** "fixed": candle 2's HIGH / LOW all session. "rolling" (user, 13 Nov 2026): candle 2's levels are watched during
   * 11:15–12:15; with no valid break, the 11:15–12:15 candle's levels during 12:15–13:15; then 12:15–13:15's during
   * 13:15–14:15 — each hour's levels only for the hour after it. */
  levels: "fixed" | "rolling";
  /** Experiment B+ (13 Nov 2026, rolling levels only): after the 20% breakout, price must come back to the level within
   * `retestMinutes` (low / high within `retestTolerancePercent` of it) without a close back through it, and a later
   * candle must close beyond the retest candle's high (CALL) / low (PUT): the entry. A close back through cancels it. */
  retest?: boolean;
  retestMinutes?: number;
  retestTolerancePercent?: number;
  /** EMA period on 5-minute NIFTY closes (0 = off): CALL needs close > EMA and EMA rising; PUT the mirror. */
  emaPeriod?: number;
  /** Late-entry protection (points, 0 = off): no entry when NIFTY's close is more than this beyond the level. */
  maxChasePoints?: number;
  /** Opposite-breakout handling (13 Nov 2026): a 20% breakout is a candidate; the NEXT completed candle must close beyond
   * the level (entry at its close). A close back inside cancels that direction for the day; only the opposite side can
   * trade after that (that same candle may be the opposite candidate). Both cancelled = no trade. */
  continuation?: boolean;
  /** Intrabar entry (13 Nov 2026): enter the moment the FORMING candle has 20% of its body beyond the level (no wait for
   * the close). From 1-minute OHLC: the trigger price where (p − max(open, level)) = 20% × (p − open) is reached when the
   * candle's high (CALL) / low (PUT) gets there. A candle reaching both triggers is skipped (order unknown). */
  intrabar?: boolean;
  /** ATR breakout buffer (13 Nov 2026; 0 = off): the close must also be beyond the level by at least this share of the
   * 1-minute ATR (`atrPeriod`, Wilder, from 09:15) as of the candle BEFORE the breakout candle. 0.2 = 20% of ATR. */
  atrBuffer?: number;
  atrPeriod?: number;
  /** Candidate state machine (13 Nov 2026, version F): a 20% break is a candidate; a later close beyond the level enters;
   * a weak close back inside (< 20% of its body inside) keeps the candidate; a strong one (≥ 20%, the 20% rule mirrored)
   * cancels it (a new 20% break can re-arm); a valid 20% break of the opposite level switches the candidate. */
  candidate?: boolean;
  /** F2 (13 Nov 2026, user, 23 Feb 2026 11:50 PUT): with `candidate`, a WEAK close back inside (< 20% of its body inside)
   * also counts as holding the break → entry at that close. A strong close inside still cancels. */
  weakEnters?: boolean;
  /** F3: the weak-close entry only when the breakout candle itself was strong (≥ this share of its body beyond). */
  weakEntersMinBreak?: number;
  /** H (13 Nov 2026, user): with `candidate`, these sides enter at the 20% breakout candle's close (no continuation
   * candle); the other side keeps F's rule. */
  immediateSides?: Array<"CALL" | "PUT">;
  /** Version G (13 Nov 2026, user): after a completed 20% breakout candle, enter INSIDE the next candle the moment it
   * trades beyond the breakout candle's LOW (PUT) / HIGH (CALL) — no wait for its close. Not crossed in that minute =
   * cancelled (that candle may itself be the next 20% breakout). */
  crossEntry?: boolean;
  /** F (13 Nov 2026): at the confirming close, NIFTY must be within this % of the day's high so far (CALL) / low (PUT);
   * otherwise that candidate is dropped and watching continues (the day is not skipped). 0 = off. */
  nearExtremePct?: number;
  /** What to do with a confirmed candidate that is far from the day's extreme: "drop" (watch on) or "opposite" (buy the
   * other side at that close). */
  farAction?: "drop" | "opposite" | "late-opposite";
  /** G-opp (13 Nov 2026, user): with `crossEntry`, when the 2nd candle does NOT cross, buy the OPPOSITE side at that
   * candle's close (known only once it completes). */
  oppositeOnNoCross?: boolean;
};

/** Wilder ATR of 1-minute candles: map from a candle's time to the ATR of the candles up to and including it. */
export function atrSeries(candles: Candle[], period = 14): Map<number, number> {
  const ordered = [...candles].sort((a, b) => a.time - b.time);
  const out = new Map<number, number>();
  let atr: number | null = null;
  const seed: number[] = [];
  ordered.forEach((candle, index) => {
    const previous = index > 0 ? ordered[index - 1].close : null;
    const tr = previous == null ? candle.high - candle.low : Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous));
    if (atr == null) {
      seed.push(tr);
      if (seed.length === period) atr = seed.reduce((sum, value) => sum + value, 0) / period;
    } else atr = (atr * (period - 1) + tr) / period;
    if (atr != null) out.set(candle.time, atr);
  });
  return out;
}

/** The NIFTY price inside a forming candle at which the 20% body rule is first met (null: the candle cannot meet it there). */
export function intrabarTrigger(open: number, level: number, side: "CALL" | "PUT", bodyShare: number, tick = 0.05): number | null {
  if (side === "CALL") return open >= level ? Math.max(open, level) + tick : (level - bodyShare * open) / (1 - bodyShare);
  return open <= level ? Math.min(open, level) - tick : (level - bodyShare * open) / (1 - bodyShare);
}

export const BREAKOUT_DEFAULTS: BreakoutSettings = { bodyShare: 0.2, entryCutoff: "14:15", levels: "fixed" };

export type BreakoutLevels = { high: number; low: number; open: number; close: number; minutes: number };

export type BreakoutSignal = {
  side: "CALL" | "PUT";
  /** The breakout candle (its open time). It is complete at time + 60, the confirmation time. */
  candle: Candle;
  level: number;
  body: number;
  beyond: number;
  /** beyond / body × 100. */
  beyondPercent: number;
  /** Intrabar entry only: the NIFTY price where the rule was met inside `candle` (entry during that minute). */
  trigger?: number;
  /** Candidate versions (F): the 20% breakout candle (`candle` is then the confirming candle). */
  first?: Candle;
};

export type BreakoutDay = { levels: BreakoutLevels | null; signal: BreakoutSignal | null; reason: string };

const IST = 19_800;
/** Minutes since midnight IST of a unix time. */
export const istMinute = (time: number) => Math.floor(((time + IST) % 86_400) / 60);
export const clockOf = (time: number) => {
  const minute = istMinute(time);
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
};
const minuteOf = (clock: string) => +clock.slice(0, 2) * 60 + +clock.slice(3, 5);

const CANDLE2_START = minuteOf("10:15");
const CANDLE2_END = minuteOf("11:15");

/** Candle 2 (10:15–11:15) from 1-minute candles; null when any of its 60 minutes is missing (incomplete hour). */
export function candleTwo(candles: Candle[]): BreakoutLevels | null {
  return hourCandle(candles, CANDLE2_START);
}

/** The hourly candle starting at `start` (minutes since midnight IST); null when any of its 60 minutes is missing. */
export function hourCandle(candles: Candle[], start: number): BreakoutLevels | null {
  const inside = candles.filter((candle) => istMinute(candle.time) >= start && istMinute(candle.time) < start + 60).sort((a, b) => a.time - b.time);
  if (inside.length !== 60) return null;
  return {
    open: inside[0].open,
    close: inside.at(-1)!.close,
    high: Math.max(...inside.map((candle) => candle.high)),
    low: Math.min(...inside.map((candle) => candle.low)),
    minutes: inside.length,
  };
}

/** The 20% body test for one completed candle against one level. Null when it is not a valid breakout. */
export function bodyBreakout(candle: Candle, side: "CALL" | "PUT", level: number, bodyShare: number): Omit<BreakoutSignal, "candle"> | null {
  const body = Math.abs(candle.close - candle.open);
  if (!(body > 0)) return null;
  const beyond = side === "CALL" ? candle.close - Math.max(candle.open, level) : Math.min(candle.open, level) - candle.close;
  const closedBeyond = side === "CALL" ? candle.close > level : candle.close < level;
  if (!closedBeyond || !(beyond > 0) || beyond < body * bodyShare - 1e-9) return null;
  return { side, level, body: round2(body), beyond: round2(beyond), beyondPercent: Math.round((beyond / body) * 1000) / 10 };
}

/**
 * The session's first valid breakout. Only candles that open at or after 11:15 and close by the entry cutoff are read,
 * in time order; the first one passing either test decides, and later candles are never looked at.
 */
export function firstBreakout(candles: Candle[], settings: BreakoutSettings = BREAKOUT_DEFAULTS): BreakoutDay {
  if (settings.crossEntry) return crossBreakout(candles, settings);
  if (settings.candidate) return candidateBreakout(candles, settings);
  if (settings.intrabar) return intrabarBreakout(candles, settings);
  if (settings.continuation) return continuationBreakout(candles, settings);
  if (settings.levels === "rolling" &&(settings.retest || settings.emaPeriod || settings.maxChasePoints)) return filteredBreakout(candles, settings);
  if (settings.levels === "rolling") return rollingBreakout(candles, settings);
  const levels = candleTwo(candles);
  if (!levels) return { levels: null, signal: null, reason: "Candle 2 (10:15–11:15) incomplete: no trade." };
  const cutoff = minuteOf(settings.entryCutoff);
  const watch = candles.filter((candle) => istMinute(candle.time) >= CANDLE2_END && istMinute(candle.time) + 1 <= cutoff).sort((a, b) => a.time - b.time);
  for (const candle of watch) {
    const up = bodyBreakout(candle, "CALL", levels.high, settings.bodyShare);
    if (up) return { levels, signal: { ...up, candle }, reason: `CALL: ${clockOf(candle.time)} candle closed ${candle.close} above ${levels.high}, ${up.beyondPercent}% of its body beyond.` };
    const down = bodyBreakout(candle, "PUT", levels.low, settings.bodyShare);
    if (down) return { levels, signal: { ...down, candle }, reason: `PUT: ${clockOf(candle.time)} candle closed ${candle.close} below ${levels.low}, ${down.beyondPercent}% of its body beyond.` };
  }
  return { levels, signal: null, reason: `No valid breakout of ${levels.high} / ${levels.low} by ${settings.entryCutoff}: no trade.` };
}

/** Rolling levels: each completed hour from 10:15 sets the HIGH / LOW watched only during the next hour. */
function rollingBreakout(candles: Candle[], settings: BreakoutSettings): BreakoutDay {
  const cutoff = minuteOf(settings.entryCutoff);
  let last: BreakoutLevels | null = null;
  const atr = settings.atrBuffer ? atrSeries(candles, settings.atrPeriod ?? 14) : null;
  const notes: string[] = [];
  // The ATR buffer: the close must be at least atrBuffer × ATR (of the candle before) beyond the level.
  const buffered = (candle: Candle, side: "CALL" | "PUT", level: number) => {
    if (!atr) return true;
    const before = atr.get(candle.time - 60);
    if (before == null) { notes.push(`${clockOf(candle.time)} ${side}: ATR not available.`); return false; }
    const need = settings.atrBuffer! * before;
    const beyond = side === "CALL" ? candle.close - level : level - candle.close;
    if (beyond + 1e-9 >= need) return true;
    notes.push(`${clockOf(candle.time)} ${side} 20% break rejected by the ATR buffer: ${beyond.toFixed(2)} pts beyond, needed ${need.toFixed(2)} (ATR ${before.toFixed(2)}).`);
    return false;
  };
  for (let start = CANDLE2_START; start + 60 < cutoff; start += 60) {
    const levels = hourCandle(candles, start);
    const label = `${clockOf(0 + start * 60 - IST)}–${clockOf((start + 60) * 60 - IST)}`;
    if (!levels) return { levels: last, signal: null, reason: `Hour ${label} incomplete: no trade.` };
    last = levels;
    const watch = candles.filter((candle) => istMinute(candle.time) >= start + 60 && istMinute(candle.time) < start + 120 && istMinute(candle.time) + 1 <= cutoff).sort((a, b) => a.time - b.time);
    for (const candle of watch) {
      const up = bodyBreakout(candle, "CALL", levels.high, settings.bodyShare);
      if (up && buffered(candle, "CALL", levels.high)) return { levels, signal: { ...up, candle }, reason: `CALL: ${clockOf(candle.time)} candle closed ${candle.close} above the ${label} HIGH ${levels.high}, ${up.beyondPercent}% of its body beyond. ${notes.join(" ")}` };
      const down = bodyBreakout(candle, "PUT", levels.low, settings.bodyShare);
      if (down && buffered(candle, "PUT", levels.low)) return { levels, signal: { ...down, candle }, reason: `PUT: ${clockOf(candle.time)} candle closed ${candle.close} below the ${label} LOW ${levels.low}, ${down.beyondPercent}% of its body beyond. ${notes.join(" ")}` };
    }
  }
  return { levels: last, signal: null, reason: `No valid breakout of any hour's HIGH / LOW by ${settings.entryCutoff}: no trade. ${notes.join(" ")}` };
}

/** EMA of completed 5-minute closes (09:15 grid) at `now` (unix, the decision time): the last two values. */
export function ema5(candles: Candle[], now: number, period: number): { value: number; previous: number } | null {
  const bars = new Map<number, number>();
  for (const candle of candles) {
    if (candle.time + 60 > now) continue;
    const minute = istMinute(candle.time);
    const bucket = Math.floor((minute - 555) / 5);
    // A 5-minute bar is complete once its last minute has closed (bucket end ≤ now).
    bars.set(bucket, candle.close);
  }
  const lastMinute = istMinute(now - 60);
  const complete = [...bars.entries()].filter(([bucket]) => 555 + (bucket + 1) * 5 - 1 <= lastMinute).sort((a, b) => a[0] - b[0]).map(([, close]) => close);
  if (complete.length < period + 1) return null;
  const k = 2 / (period + 1);
  let value = complete.slice(0, period).reduce((sum, close) => sum + close, 0) / period;
  let previous = value;
  for (const close of complete.slice(period)) { previous = value; value = close * k + value * (1 - k); }
  return { value, previous };
}

type Pending = { side: "CALL" | "PUT"; level: number; breakout: Candle; info: Omit<BreakoutSignal, "candle">; retest: Candle | null; label: string };

/** Rolling levels with the experiment filters: retest confirmation, EMA trend, late-entry protection. */
function filteredBreakout(candles: Candle[], settings: BreakoutSettings): BreakoutDay {
  const cutoff = minuteOf(settings.entryCutoff);
  const window = settings.retestMinutes ?? 15;
  const tolerance = (settings.retestTolerancePercent ?? 0.02) / 100;
  const ordered = [...candles].sort((a, b) => a.time - b.time);
  const notes: string[] = [];
  let pending: Pending | null = null;
  let levels: BreakoutLevels | null = null;
  let label = "";
  const accept = (side: "CALL" | "PUT", level: number, candle: Candle): string | null => {
    const now = candle.time + 60;
    if (settings.emaPeriod) {
      const ema = ema5(ordered, now, settings.emaPeriod);
      if (!ema) return "EMA not ready";
      const ok = side === "CALL" ? candle.close > ema.value && ema.value > ema.previous : candle.close < ema.value && ema.value < ema.previous;
      if (!ok) return `EMA ${settings.emaPeriod} against (${ema.value.toFixed(2)}, ${ema.value > ema.previous ? "rising" : "falling"})`;
    }
    if (settings.maxChasePoints) {
      const beyond = side === "CALL" ? candle.close - level : level - candle.close;
      if (beyond > settings.maxChasePoints) return `late entry: ${beyond.toFixed(2)} pts beyond the level (max ${settings.maxChasePoints})`;
    }
    return null;
  };
  for (const candle of ordered) {
    const minute = istMinute(candle.time);
    if (minute < CANDLE2_END || minute + 1 > cutoff) continue;
    // The levels of the hour before this candle's hour (10:15 hour during 11:15–12:15, and so on).
    const start = CANDLE2_START + Math.floor((minute - CANDLE2_END) / 60) * 60;
    if (!levels || label !== `${start}`) {
      const next = hourCandle(ordered, start);
      if (!next) return { levels, signal: null, reason: `Hour starting ${clockOf(start * 60 - IST)} incomplete: no trade.` };
      levels = next;
      label = `${start}`;
    }
    if (pending) {
      const back = pending.side === "CALL" ? candle.close < pending.level : candle.close > pending.level;
      if (back) { notes.push(`${pending.side} break at ${clockOf(pending.breakout.time)} cancelled: ${clockOf(candle.time)} closed back through ${pending.level}.`); pending = null; }
      else if (candle.time - pending.breakout.time > window * 60 && !pending.retest) { notes.push(`${pending.side} break at ${clockOf(pending.breakout.time)}: no retest within ${window} min.`); pending = null; }
      else if (!pending.retest) {
        const touched = pending.side === "CALL" ? candle.low <= pending.level * (1 + tolerance) : candle.high >= pending.level * (1 - tolerance);
        if (touched) pending.retest = candle;
        continue;
      } else {
        const moved = pending.side === "CALL" ? candle.close > pending.retest.high : candle.close < pending.retest.low;
        if (moved) {
          const why = accept(pending.side, pending.level, candle);
          if (!why) return { levels, signal: { ...pending.info, candle }, reason: `${pending.side}: break ${clockOf(pending.breakout.time)} of ${pending.level}, retest ${clockOf(pending.retest.time)}, entry candle ${clockOf(candle.time)}. ${notes.join(" ")}` };
          notes.push(`${pending.side} retest entry at ${clockOf(candle.time)} skipped: ${why}.`);
          pending = null;
        } else if (candle.time - pending.retest.time > window * 60) { notes.push(`${pending.side} retest at ${clockOf(pending.retest.time)} never moved on.`); pending = null; }
        continue;
      }
    }
    for (const side of ["CALL", "PUT"] as const) {
      const level = side === "CALL" ? levels.high : levels.low;
      const info = bodyBreakout(candle, side, level, settings.bodyShare);
      if (!info) continue;
      if (!settings.retest) {
        const why = accept(side, level, candle);
        if (!why) return { levels, signal: { ...info, candle }, reason: `${side}: ${clockOf(candle.time)} broke ${level}. ${notes.join(" ")}` };
        notes.push(`${side} break at ${clockOf(candle.time)} skipped: ${why}.`);
        break;
      }
      pending = { side, level, breakout: candle, info, retest: null, label };
      break;
    }
  }
  return { levels, signal: null, reason: `No confirmed entry by ${settings.entryCutoff}: no trade. ${notes.join(" ")}` };
}

/** Version G: 20% breakout candle, then entry inside the next minute once it crosses the breakout candle's low / high. */
function crossBreakout(candles: Candle[], settings: BreakoutSettings, tick = 0.05): BreakoutDay {
  const cutoff = minuteOf(settings.entryCutoff);
  const ordered = [...candles].sort((a, b) => a.time - b.time);
  const notes: string[] = [];
  let pending: (Omit<BreakoutSignal, "candle"> & { first: Candle }) | null = null;
  let levels: BreakoutLevels | null = null;
  let start = -1;
  for (const candle of ordered) {
    const minute = istMinute(candle.time);
    if (minute < CANDLE2_END || minute >= cutoff) continue;
    const hourStart = settings.levels === "rolling" ? CANDLE2_START + Math.floor((minute - CANDLE2_END) / 60) * 60 : CANDLE2_START;
    if (hourStart !== start) {
      const next = hourCandle(ordered, hourStart);
      if (!next) return { levels, signal: null, reason: `Hour starting ${clockOf(hourStart * 60 - IST)} incomplete: no trade. ${notes.join(" ")}` };
      levels = next;
      start = hourStart;
    }
    if (pending) {
      const put = pending.side === "PUT";
      const trigger = put ? pending.first.low - tick : pending.first.high + tick;
      const hit = put ? candle.low <= trigger + 1e-9 : candle.high >= trigger - 1e-9;
      if (hit) {
        // A gap through the trigger fills at the open.
        const at = Math.round((put ? Math.min(candle.open, trigger) : Math.max(candle.open, trigger)) * 100) / 100;
        const { first, ...info } = pending;
        return { levels, signal: { ...info, candle, trigger: at }, reason: `${pending.side}: ${clockOf(first.time)} broke ${pending.level} (${pending.beyondPercent}% body); inside ${clockOf(candle.time)} NIFTY crossed its ${put ? "low" : "high"} ${put ? first.low : first.high} at ${at} → entry. ${notes.join(" ")}` };
      }
      if (settings.oppositeOnNoCross) {
        const side = put ? "CALL" : "PUT";
        const { first, ...info } = pending;
        return { levels, signal: { ...info, side, candle }, reason: `${pending.side} break ${clockOf(first.time)} of ${pending.level}; ${clockOf(candle.time)} did not cross its ${put ? "low" : "high"} ${put ? first.low : first.high} → OPPOSITE ${side} at its close ${candle.close}. ${notes.join(" ")}` };
      }
      notes.push(`${pending.side} break ${clockOf(pending.first.time)}: ${clockOf(candle.time)} did not cross its ${put ? "low" : "high"} → cancelled.`);
      pending = null;
    }
    // A breakout candle must close by the cutoff, and the crossing must happen in a minute starting before it.
    if (minute + 1 >= cutoff) continue;
    for (const side of ["CALL", "PUT"] as const) {
      const info = bodyBreakout(candle, side, side === "CALL" ? levels!.high : levels!.low, settings.bodyShare);
      if (info) { pending = { ...info, first: candle }; break; }
    }
  }
  return { levels, signal: null, reason: `No crossed breakout by ${settings.entryCutoff}: no trade. ${notes.join(" ")}` };
}

/** Version F: candidate → continuation, weak closes inside tolerated, strong closes inside cancel, opposite break switches. */
function candidateBreakout(candles: Candle[], settings: BreakoutSettings): BreakoutDay {
  const cutoff = minuteOf(settings.entryCutoff);
  const ordered = [...candles].sort((a, b) => a.time - b.time);
  const notes: string[] = [];
  let candidate: (Omit<BreakoutSignal, "candle"> & { breakout: Candle; weak: number }) | null = null;
  let lastFar: { side: "CALL" | "PUT"; info: Omit<BreakoutSignal, "candle"> & { breakout: Candle; weak: number }; at: Candle } | null = null;
  let lastCandle: Candle | null = null;
  let levels: BreakoutLevels | null = null;
  let start = -1;
  const opposite = (side: "CALL" | "PUT") => (side === "CALL" ? "PUT" : "CALL");
  for (const candle of ordered) {
    const minute = istMinute(candle.time);
    if (minute < CANDLE2_END || minute + 1 > cutoff) continue;
    const hourStart = settings.levels === "rolling" ? CANDLE2_START + Math.floor((minute - CANDLE2_END) / 60) * 60 : CANDLE2_START;
    if (hourStart !== start) {
      const next = hourCandle(ordered, hourStart);
      if (!next) return { levels, signal: null, reason: `Hour starting ${clockOf(hourStart * 60 - IST)} incomplete: no trade. ${notes.join(" ")}` };
      levels = next;
      start = hourStart;
    }
    const levelOf = (side: "CALL" | "PUT") => (side === "CALL" ? levels!.high : levels!.low);
    lastCandle = candle;
    if (candidate) {
      const beyond = candidate.side === "CALL" ? candle.close > candidate.level : candle.close < candidate.level;
      const sofar = ordered.filter((item) => item.time <= candle.time);
      const far = settings.nearExtremePct ? (candidate.side === "CALL" ? Math.max(...sofar.map((item) => item.high)) - candle.close : candle.close - Math.min(...sofar.map((item) => item.low))) / candle.close * 100 > settings.nearExtremePct : false;
      if (beyond && far && settings.farAction === "opposite") {
        const { breakout, weak, ...info } = candidate;
        void weak;
        const other = candidate.side === "CALL" ? "PUT" : "CALL";
        return { levels, signal: { ...info, side: other, candle, first: breakout }, reason: `FAR → OPPOSITE ${other}: ${candidate.side} confirmed ${clockOf(candle.time)} at ${candle.close}, more than ${settings.nearExtremePct}% from the day's ${candidate.side === "CALL" ? "high" : "low"}. ${notes.join(" ")}` };
      }
      if (beyond && far) {
        lastFar = { side: candidate.side, info: candidate, at: candle };
        notes.push(`${candidate.side} confirmed ${clockOf(candle.time)} but ${candle.close} is more than ${settings.nearExtremePct}% from the day's ${candidate.side === "CALL" ? "high" : "low"} → dropped, watching on.`);
        candidate = null;
        continue;
      }
      if (beyond) {
        const { breakout, weak, ...info } = candidate;
        return { levels, signal: { ...info, candle, first: breakout }, reason: `${candidate.side}: ${clockOf(breakout.time)} broke ${candidate.level} (${candidate.beyondPercent}% body); ${weak ? `${weak} weak close(s) inside tolerated; ` : ""}${clockOf(candle.time)} closed ${candle.close} beyond → entry. ${notes.join(" ")}` };
      }
      // Closed back inside: the opposite level's valid break switches the candidate.
      const other = opposite(candidate.side);
      const switched = bodyBreakout(candle, other, levelOf(other), settings.bodyShare);
      if (switched && settings.immediateSides?.includes(other)) {
        return { levels, signal: { ...switched, candle }, reason: `${other}: ${clockOf(candle.time)} broke ${levelOf(other)} (${switched.beyondPercent}% body) → immediate entry (${candidate.side} candidate ${clockOf(candidate.breakout.time)} dropped). ${notes.join(" ")}` };
      }
      if (switched) {
        notes.push(`${candidate.side} candidate ${clockOf(candidate.breakout.time)} replaced: ${clockOf(candle.time)} broke the ${other} level ${levelOf(other)}.`);
        candidate = { ...switched, breakout: candle, weak: 0 };
        continue;
      }
      // Strong close inside (the 20% rule mirrored on the candidate's level) cancels; a weak one is tolerated.
      const strong = bodyBreakout(candle, other, candidate.level, settings.bodyShare);
      if (strong) { notes.push(`${candidate.side} candidate ${clockOf(candidate.breakout.time)} cancelled: ${clockOf(candle.time)} closed ${candle.close} strongly back inside ${candidate.level} (${strong.beyondPercent}% of body).`); candidate = null; }
      else if (settings.weakEnters && candidate.beyondPercent >= (settings.weakEntersMinBreak ?? 0) * 100) {
        const { breakout, weak, ...info } = candidate;
        void weak;
        return { levels, signal: { ...info, candle }, reason: `${candidate.side}: ${clockOf(breakout.time)} broke ${candidate.level} (${candidate.beyondPercent}% body); ${clockOf(candle.time)} closed ${candle.close}, only weakly back inside → counted as holding, entry. ${notes.join(" ")}` };
      }
      else { candidate.weak += 1; continue; }
    }
    for (const side of ["CALL", "PUT"] as const) {
      const info = bodyBreakout(candle, side, levelOf(side), settings.bodyShare);
      if (info && settings.immediateSides?.includes(side)) return { levels, signal: { ...info, candle }, reason: `${side}: ${clockOf(candle.time)} broke ${levelOf(side)} (${info.beyondPercent}% body) → immediate entry. ${notes.join(" ")}` };
      if (info) { candidate = { ...info, breakout: candle, weak: 0 }; break; }
    }
  }
  if (settings.farAction === "late-opposite" && lastFar && lastCandle && istMinute(lastCandle.time) + 1 === cutoff) {
    const { breakout, weak, ...info } = lastFar.info;
    void weak;
    const other = opposite(lastFar.side);
    return { levels, signal: { ...info, side: other, candle: lastCandle, first: breakout }, reason: `LATE OPPOSITE ${other}: no near breakout by ${settings.entryCutoff}; last far ${lastFar.side} confirmed ${clockOf(lastFar.at.time)} → ${other} at ${clockOf(lastCandle.time)} close. ${notes.join(" ")}` };
  }
  return { levels, signal: null, reason: `No confirmed candidate by ${settings.entryCutoff}: no trade. ${notes.join(" ")}` };
}

/** Intrabar: the first minute (from 11:15, rolling or fixed levels) whose range reaches a 20% trigger; entry inside it. */
function intrabarBreakout(candles: Candle[], settings: BreakoutSettings): BreakoutDay {
  const cutoff = minuteOf(settings.entryCutoff);
  const ordered = [...candles].sort((a, b) => a.time - b.time);
  const notes: string[] = [];
  let levels: BreakoutLevels | null = null;
  let start = -1;
  for (const candle of ordered) {
    const minute = istMinute(candle.time);
    // The entry happens inside this minute, so the minute must START before the cutoff.
    if (minute < CANDLE2_END || minute >= cutoff) continue;
    const hourStart = settings.levels === "rolling" ? CANDLE2_START + Math.floor((minute - CANDLE2_END) / 60) * 60 : CANDLE2_START;
    if (hourStart !== start) {
      const next = hourCandle(ordered, hourStart);
      if (!next) return { levels, signal: null, reason: `Hour starting ${clockOf(hourStart * 60 - IST)} incomplete: no trade.` };
      levels = next;
      start = hourStart;
    }
    const call = intrabarTrigger(candle.open, levels!.high, "CALL", settings.bodyShare);
    const put = intrabarTrigger(candle.open, levels!.low, "PUT", settings.bodyShare);
    const up = call != null && candle.high >= call;
    const down = put != null && candle.low <= put;
    if (up && down) { notes.push(`${clockOf(candle.time)} reached both triggers (order unknown): skipped.`); continue; }
    if (!up && !down) continue;
    const side = up ? "CALL" : "PUT";
    const level = up ? levels!.high : levels!.low;
    const trigger = Math.round((up ? call! : put!) * 100) / 100;
    const closed = bodyBreakout(candle, side, level, settings.bodyShare);
    const body = Math.abs(trigger - candle.open);
    const beyond = side === "CALL" ? trigger - Math.max(candle.open, level) : Math.min(candle.open, level) - trigger;
    return {
      levels,
      signal: { side, level, body: round2(body), beyond: round2(beyond), beyondPercent: body > 0 ? Math.round((beyond / body) * 1000) / 10 : 0, candle, trigger },
      reason: `${side}: inside the ${clockOf(candle.time)} candle NIFTY reached ${trigger} (20% of the forming body beyond ${level}); the candle then closed ${candle.close} — ${closed ? "a valid 20% close too" : "NOT a valid 20% close"}. ${notes.join(" ")}`,
    };
  }
  return { levels, signal: null, reason: `No 20% trigger by ${settings.entryCutoff}: no trade. ${notes.join(" ")}` };
}

/** Candidate → next-candle continuation, with a failed direction cancelled for the day (see `continuation`). */
function continuationBreakout(candles: Candle[], settings: BreakoutSettings): BreakoutDay {
  const cutoff = minuteOf(settings.entryCutoff);
  const ordered = [...candles].sort((a, b) => a.time - b.time);
  const cancelled = new Set<"CALL" | "PUT">();
  const notes: string[] = [];
  let candidate: (Omit<BreakoutSignal, "candle"> & { breakout: Candle }) | null = null;
  let levels: BreakoutLevels | null = null;
  let start = -1;
  for (const candle of ordered) {
    const minute = istMinute(candle.time);
    if (minute < CANDLE2_END || minute + 1 > cutoff) continue;
    const hourStart = settings.levels === "rolling" ? CANDLE2_START + Math.floor((minute - CANDLE2_END) / 60) * 60 : CANDLE2_START;
    if (hourStart !== start) {
      const next = hourCandle(ordered, hourStart);
      if (!next) return { levels, signal: null, reason: `Hour starting ${clockOf(hourStart * 60 - IST)} incomplete: no trade. ${notes.join(" ")}` };
      levels = next;
      start = hourStart;
    }
    if (candidate) {
      const holds = candidate.side === "CALL" ? candle.close > candidate.level : candle.close < candidate.level;
      if (holds) {
        const entry = { side: candidate.side, level: candidate.level, body: candidate.body, beyond: candidate.beyond, beyondPercent: candidate.beyondPercent };
        return { levels, signal: { ...entry, candle }, reason: `${candidate.side}: ${clockOf(candidate.breakout.time)} broke ${candidate.level} (${candidate.beyondPercent}% body), ${clockOf(candle.time)} closed ${candle.close} still beyond → entry. ${notes.join(" ")}` };
      }
      notes.push(`${candidate.side} break ${clockOf(candidate.breakout.time)} failed: ${clockOf(candle.time)} closed ${candle.close} back inside ${candidate.level} → ${candidate.side} cancelled for the day.`);
      cancelled.add(candidate.side);
      candidate = null;
      // Fall through: this same candle may break the opposite level.
    }
    if (cancelled.size === 2) break;
    for (const side of ["CALL", "PUT"] as const) {
      if (cancelled.has(side)) continue;
      const info = bodyBreakout(candle, side, side === "CALL" ? levels!.high : levels!.low, settings.bodyShare);
      if (info) { candidate = { ...info, breakout: candle }; break; }
    }
  }
  return { levels, signal: null, reason: `No confirmed breakout by ${settings.entryCutoff}${cancelled.size ? ` (cancelled: ${[...cancelled].join(", ")})` : ""}: no trade. ${notes.join(" ")}` };
}

const round2 = (value: number) => Math.round(value * 100) / 100;
