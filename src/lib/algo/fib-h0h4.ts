/**
 * 5-Minute H0–H4 Fibonacci Breakout — NIFTY 50 ATM CE, CALL BUY only (user spec, 17 Nov 2026).
 *
 * An independent strategy: its own settings, state machine, persisted state and results. It shares no settings, state
 * or code path with Mathi v18 or any other strategy (it only REUSES the dated statutory charges, lot sizes and contract
 * naming from fib-breakout.ts). It never places a broker order: backtest, replay and paper only (`liveOrders` is false
 * and nothing in this module can send an order).
 *
 * CURRENT DEFAULT (user correction, 17 Nov 2026): 1-minute candles; a level is BROKEN when a later candle's HIGH trades above it
 * (H1 = HIGH of the first candle whose high is above H0, etc.); BUY the moment the price trades above H4 (stop-buy one tick
 * above it); SELL at Fib 0.618. The original spec below (5-minute, CLOSE breaks, buy after a close above H4) is H0H4_V1_CLOSE_5M.
 *
 * Original rules (every decision is on COMPLETED 5-minute candles; all times IST, minutes after midnight):
 *  1. NIFTY 09:15–09:20 candle: GREEN (close > open) continues; RED or NEUTRAL skips the session.
 *  2. ATM = that candle's CLOSE rounded to the nearest 50 (half up); the ATM CE of the nearest weekly expiry, kept all day.
 *  3. H0 = HIGH of the CE's own 09:15–09:20 candle; Initial Low (L) = its LOW (Fib 0.0).
 *  4. H1 = HIGH of the first later candle that CLOSES above H0; H2 above H1; H3 above H2 (a wick never counts).
 *  5. After H3: Fib 0.0 = L, Fib 0.5 = H3, Fib 0.618 = L + (H3 − L) × 0.618 / 0.5 = L + (H3 − L) × 1.236 (the target).
 *     Levels are locked; nothing is recalculated from later candles.
 *  6. H4 = HIGH of the first later candle that CLOSES above H3. H4 must be strictly below Fib 0.618, else the session is
 *     skipped (H4 = target / H4 > target).
 *  7. Entry: a LATER candle CLOSES above H4 → BUY at the next executable price. Skipped instead when Fib 0.618 was already
 *     reached (any candle high ≥ target after Fib was set, including the breakout candle itself, or a fill price at/above it).
 *  8. Exit: a resting SELL at Fib 0.618 (rounded up to the tick). No stop-loss, no trailing. Intraday: a position still
 *     open at 15:29 is squared off (open-spec choice, see docs/fib-h0h4-strategy.md).
 *
 * One trade per session at most. A level can never be set and broken by the same candle: each candle is processed once,
 * in one phase. The same `advanceH0H4` drives the backtest (whole day at once) and live paper trading (tick by tick, the
 * persisted state carried across ticks and restarts).
 */
import { contractSymbol, niftyLotSize, r2, STATUTORY_CHARGES, tradeCharges, type ChargeSettings } from "@/lib/algo/fib-breakout";

export { contractSymbol, niftyLotSize };

/** One 1-minute bar: covers [t, t + 1) minutes after midnight IST, known at t + 1. */
export type Bar = { t: number; open: number; high: number; low: number; close: number; volume?: number };
/** One 5-minute candle on the exchange grid (09:15, 09:20, …): covers [t, t + 5). */
export type Candle5 = { t: number; open: number; high: number; low: number; close: number; volume: number; minutes: number; firstMinute: number; lastMinute: number };

export type H0H4Phase =
  | "WAITING_FOR_OPEN" | "CHECKING_GREEN" | "SELECTING_ATM" | "WAITING_FOR_H0" | "WAITING_FOR_H1" | "WAITING_FOR_H2" | "WAITING_FOR_H3"
  | "CALCULATING_FIB" | "WAITING_FOR_H4" | "VALIDATING_H4" | "WAITING_FOR_H4_BREAK" | "ENTRY_PENDING" | "POSITION_OPEN" | "EXIT_PENDING"
  | "TARGET_COMPLETED" | "SESSION_SKIPPED" | "SESSION_COMPLETED";

export const H0H4_PHASES: H0H4Phase[] = [
  "WAITING_FOR_OPEN", "CHECKING_GREEN", "SELECTING_ATM", "WAITING_FOR_H0", "WAITING_FOR_H1", "WAITING_FOR_H2", "WAITING_FOR_H3", "CALCULATING_FIB",
  "WAITING_FOR_H4", "VALIDATING_H4", "WAITING_FOR_H4_BREAK", "ENTRY_PENDING", "POSITION_OPEN", "EXIT_PENDING", "TARGET_COMPLETED", "SESSION_SKIPPED", "SESSION_COMPLETED",
];

/** Why a session ended without a trade (SKIPPED = a rule cancelled it; NO_ENTRY = the market closed first). */
export type H0H4Reason =
  | "NIFTY_DATA_MISSING" | "RED_OPEN" | "NEUTRAL_OPEN" | "CONTRACT_UNAVAILABLE" | "CE_DATA_MISSING" | "INVALID_FIB"
  | "H4_AT_TARGET" | "H4_ABOVE_TARGET" | "TARGET_BEFORE_ENTRY" | "ENTRY_NOT_EXECUTED"
  | "H0_NEVER_BROKEN" | "H1_NEVER_BROKEN" | "H2_NEVER_BROKEN" | "H3_NEVER_BROKEN" | "H4_NEVER_BROKEN" | "BREAKOUT_AT_CLOSE";

export const REASON_TEXT: Record<H0H4Reason, string> = {
  NIFTY_DATA_MISSING: "NIFTY 09:15–09:20 candle unavailable or incomplete",
  RED_OPEN: "Opening NIFTY candle is RED",
  NEUTRAL_OPEN: "Opening NIFTY candle is NEUTRAL (close = open)",
  CONTRACT_UNAVAILABLE: "ATM CE contract unavailable",
  CE_DATA_MISSING: "First 5-minute CE candle unavailable (no 09:15 trade data)",
  INVALID_FIB: "Invalid Fibonacci range (H3 ≤ Initial Low)",
  H4_AT_TARGET: "H4 equals Fibonacci 0.618",
  H4_ABOVE_TARGET: "H4 above Fibonacci 0.618",
  TARGET_BEFORE_ENTRY: "Fibonacci 0.618 reached before the H4 breakout entry",
  ENTRY_NOT_EXECUTED: "BUY signal but no executable price before the last entry time",
  H0_NEVER_BROKEN: "H0 never broken (no later candle went above it)",
  H1_NEVER_BROKEN: "H1 never broken",
  H2_NEVER_BROKEN: "H2 never broken",
  H3_NEVER_BROKEN: "H3 never broken (H4 never formed)",
  H4_NEVER_BROKEN: "H4 established but never broken",
  BREAKOUT_AT_CLOSE: "H4 breakout candle closed at/after the last entry time",
};

export type H0H4Settings = {
  underlying: "NIFTY";
  right: "CE";
  /** Which opening candles trade (user, 17 Nov 2026): "green" = the spec (red/neutral skip); research: "both-ce" = red and green both
   * buy the ATM CE; "both-pe" = green buys the ATM CE, red buys the ATM PE (same H0–H4 rules on the PE premium). Neutral always skips. */
  openColour: "green" | "both-ce" | "both-pe";
  strikeStep: number;
  /** Fib 0.5 anchor (user, 17 Nov 2026): "H3" = the spec (H3 sets the Fib, then H4 must form and break); "H2" = research
   * version: Fib 0.0 = Initial Low, 0.5 = H2, 0.618 = L + (H2 − L) × 1.236; BUY when a later candle CLOSES above 0.5 (= H2),
   * SELL at 0.618. No H3/H4 step. Every other rule (target-before-entry skip, fill, square-off) is unchanged. */
  anchor: "H3" | "H2";
  /** Candle size the levels are built on: 5 = the spec (default); 1 and 3 = research comparisons (user, 17 Nov 2026). */
  candleMinutes: 1 | 3 | 5;
  /** 09:15 and 15:30 (minutes after midnight IST). */
  sessionOpen: number;
  sessionClose: number;
  /** No entry at/after this minute; an open position is squared off at the first price at/after `squareOffTime`. */
  lastEntryTime: number;
  squareOffTime: number;
  /** Fib 0.5 anchor = H3 and the target ratio: target = L + (H3 − L) × targetRatio / anchorRatio. */
  anchorRatio: number;
  targetRatio: number;
  lots: number;
  tick: number;
  /** Slippage per unit, in ticks, on a market buy / square-off filled from a candle price (a live ask already includes it). */
  slippageTicks: number;
  /** "trade-through": the resting target fills only when a traded candle goes one tick through it; "touch": reaching it. */
  targetFill: "trade-through" | "touch";
  /** The H4 breakout candle's own HIGH already at/above Fib 0.618 (its close above H4): "cancel" (default — the target
   * traded before the BUY could happen, so the session is skipped) or "allow" (the spec's ₹123-high example; research). */
  breakoutTargetCheck: "cancel" | "allow";
  /** Research (user, 17 Nov 2026 — "buy @100, sell @102"), 0 = off (the spec's Fib 0.618 target): the sell order is set at the
   * fill from the real buy price — `targetPct` % above it, or `targetPoints` above it — rounded up to the tick. The entry rules
   * (H4 < Fib 0.618, no entry once Fib 0.618 has traded) are unchanged. */
  targetPct: number;
  targetPoints: number;
  /** Research (same request): "close" = the spec (a later candle CLOSES above H4, buy at the next price); "touch" = a stop-buy
   * one tick above H4 from the candle after H4 — filled the moment a 1-minute bar trades through it (at that price + slippage,
   * or at the open when a bar opens above it). */
  entryMode: "close" | "touch";
  /** How a level is broken (user correction, 17 Nov 2026, from the 16 Nov example: H1 = 128.70 at 09:16 although that candle
   * closed at 101.60): "high" = a later candle's HIGH trades above the level (the default); "close" = it must CLOSE above
   * (the original spec, kept as H0H4_V1_CLOSE_5M). The new level is always that candle's HIGH. */
  breakMode: "close" | "high";
  /** Live feeds: a 5-minute candle counts as complete once a later 1-minute bar exists, or this long after its end. */
  graceMinutes: number;
  maxTradesPerSession: 1;
  /** Always false: this module has no live order path. Kept so the UI can state it. */
  liveOrders: false;
  charges: ChargeSettings;
};

const hm = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

export const H0H4_DEFAULTS: H0H4Settings = {
  underlying: "NIFTY",
  right: "CE",
  openColour: "green",
  anchor: "H3",
  strikeStep: 50,
  candleMinutes: 1,
  sessionOpen: hm("09:15"),
  sessionClose: hm("15:30"),
  lastEntryTime: hm("15:29"),
  squareOffTime: hm("15:29"),
  anchorRatio: 0.5,
  targetRatio: 0.618,
  lots: 1,
  tick: 0.05,
  slippageTicks: 2,
  targetFill: "trade-through",
  breakoutTargetCheck: "cancel",
  targetPct: 0,
  targetPoints: 0,
  entryMode: "touch",
  breakMode: "high",
  graceMinutes: 3,
  maxTradesPerSession: 1,
  liveOrders: false,
  charges: STATUTORY_CHARGES,
};

/** The ORIGINAL spec (17 Nov 2026, first version): 5-minute candles, a level breaks only on a CLOSE above it, BUY at the next
 * price after a candle closes above H4. Replaced as the default by the user's correction (1-minute, high breaks, buy on the
 * H4 touch); kept for comparison (backtest flag --v1). */
export const H0H4_V1_CLOSE_5M: H0H4Settings = { ...H0H4_DEFAULTS, candleMinutes: 5, breakMode: "close", entryMode: "close" };

/** Research versions of the original spec (user, 17 Nov 2026): the same close rules on 1-minute / 3-minute candles. The opening candle is then
 * 09:15–09:16 / 09:15–09:18 (its close sets the ATM), H0 is that candle's CE high, and every breakout is a 1-/3-minute close. */
export const H0H4_1MIN: H0H4Settings = { ...H0H4_V1_CLOSE_5M, candleMinutes: 1 };
export const H0H4_3MIN: H0H4Settings = { ...H0H4_V1_CLOSE_5M, candleMinutes: 3 };
/** Research version (user, 17 Nov 2026): Fib from H2 instead of H3; BUY on a close above 0.5 (= H2), SELL at 0.618. */
export const H0H4_H2_ANCHOR: H0H4Settings = { ...H0H4_V1_CLOSE_5M, anchor: "H2" };

export const H0H4_NAME = `${H0H4_DEFAULTS.candleMinutes}-Minute H0–H4 Fibonacci Breakout`;
export const H0H4_KEY = "FIB_H0H4_5M";

export type H0H4Contract = { underlying: "NIFTY"; expiry: string; strike: number; right: "CE" | "PE"; symbol: string; lotSize: number; securityId?: string };
export type H0H4Level = { name: "H0" | "H1" | "H2" | "H3" | "H4"; price: number; candle: number; confirmedAt: number; close: number };
export type H0H4Fib = { f0: number; f05: number; f0618: number; range: number; targetOrder: number; lockedAt: number };
/** BAR_OPEN: next 1-minute open after a close-confirmed breakout; LIVE_ASK: paper ask; STOP_TOUCH / GAP_OPEN: touch entry. */
export type EntrySource = "BAR_OPEN" | "LIVE_ASK" | "STOP_TOUCH" | "GAP_OPEN";
export type H0H4Event = { at: number; phase: H0H4Phase; message: string };

export type H0H4State = {
  version: 1;
  strategy: typeof H0H4_KEY;
  date: string;
  phase: H0H4Phase;
  outcome: "TRADE" | "SKIPPED" | "NO_ENTRY" | null;
  reason: H0H4Reason | null;
  note: string;
  open: { open: number; high: number; low: number; close: number; minutes: number } | null;
  color: "GREEN" | "RED" | "NEUTRAL" | null;
  strike: number | null;
  /** The option bought today (absent in states saved before 17 Nov 2026 = CE). */
  right?: "CE" | "PE";
  contract: H0H4Contract | null;
  initial: Candle5 | null;
  levels: { H0: H0H4Level | null; H1: H0H4Level | null; H2: H0H4Level | null; H3: H0H4Level | null; H4: H0H4Level | null };
  fib: H0H4Fib | null;
  h4Valid: boolean | null;
  breakout: { candle: number; close: number; high: number; signalAt: number } | null;
  entry: { time: number; price: number; quoted: number; source: EntrySource; quantity: number; lots: number } | null;
  /** The resting sell order actually used (Fib 0.618 rounded up, or the fixed % / points target); absent = fib.targetOrder. */
  sellOrder?: number;
  exit: { time: number; price: number; reason: "TARGET" | "SQUARE_OFF"; quoted: number; stale?: boolean } | null;
  /** The last 5-minute CE candle processed (its start): later duplicates / out-of-order candles are ignored. */
  lastCandle: number | null;
  /** The last 1-minute bar checked for the target while the position is open. */
  checkedThrough: number | null;
  /** Highest / lowest traded price while in the trade. */
  maxHigh: number | null;
  minLow: number | null;
  ignoredCandles: number;
  dataWarnings: string[];
  events: H0H4Event[];
};

const EPS = 1e-9;
const tickUp = (price: number, tick: number) => r2(Math.ceil(price / tick - EPS) * tick);
const tickDown = (price: number, tick: number) => r2(Math.floor(price / tick + EPS) * tick);
/** "09:15" for a minute of the day; "09:15:30" when it has seconds. */
export function clock(minute: number) {
  const whole = Math.floor(minute + EPS);
  const seconds = Math.round((minute - whole) * 60);
  const base = `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
  return seconds > 0 && seconds < 60 ? `${base}:${String(seconds).padStart(2, "0")}` : base;
}
const money = (value: number) => value.toFixed(2);

export const atmStrike = (spot: number, step = 50) => Math.round(spot / step) * step;

/** Fib 0.0 / 0.5 / 0.618 from the Initial Low and H3 (0.5 = H3 by construction), full precision. */
export function fibFromAnchors(low: number, h3: number, s: Pick<H0H4Settings, "anchorRatio" | "targetRatio" | "tick"> = H0H4_DEFAULTS) {
  const range = h3 - low;
  const f0618 = low + range * (s.targetRatio / s.anchorRatio);
  return { f0: low, f05: low + range * (s.anchorRatio / s.anchorRatio), f0618, range, targetOrder: tickUp(f0618, s.tick) };
}

export function isTerminal(phase: H0H4Phase) {
  return phase === "TARGET_COMPLETED" || phase === "SESSION_SKIPPED" || phase === "SESSION_COMPLETED";
}

export function createH0H4Session(date: string): H0H4State {
  return {
    version: 1, strategy: H0H4_KEY, date, phase: "WAITING_FOR_OPEN", outcome: null, reason: null, note: "Waiting for first 5-minute candle.",
    open: null, color: null, strike: null, contract: null, initial: null, levels: { H0: null, H1: null, H2: null, H3: null, H4: null }, fib: null, h4Valid: null,
    breakout: null, entry: null, exit: null, lastCandle: null, checkedThrough: null, maxHigh: null, minLow: null, ignoredCandles: 0, dataWarnings: [], events: [],
  };
}

function log(state: H0H4State, at: number, phase: H0H4Phase, message: string): H0H4State {
  return { ...state, phase, note: message, events: [...state.events, { at, phase, message }] };
}
function warn(state: H0H4State, message: string): H0H4State {
  return state.dataWarnings.includes(message) ? state : { ...state, dataWarnings: [...state.dataWarnings, message].slice(-50) };
}
function stop(state: H0H4State, at: number, outcome: "SKIPPED" | "NO_ENTRY", reason: H0H4Reason, detail = ""): H0H4State {
  const message = `Session ${outcome === "SKIPPED" ? "skipped" : "completed without a trade"}: ${REASON_TEXT[reason]}${detail ? ` — ${detail}` : ""}.`;
  return { ...log(state, at, outcome === "SKIPPED" ? "SESSION_SKIPPED" : "SESSION_COMPLETED", message), outcome, reason };
}

/**
 * 1-minute bars → 5-minute candles on the exchange grid (09:15, 09:20, …, 15:25). Bars are de-duplicated by minute
 * (the last copy wins) and sorted; bars outside the session and minutes not yet finished at `now` are dropped. A candle is
 * returned only when it is COMPLETE: its 5 minutes are over and (a later bar exists, or `grace` minutes have passed — for
 * live feeds that lag). Nothing is filled in: a minute without a trade is simply absent.
 */
export function fiveMinuteCandles(bars: Bar[], now = 24 * 60, s: Pick<H0H4Settings, "sessionOpen" | "sessionClose" | "candleMinutes" | "graceMinutes"> = H0H4_DEFAULTS) {
  const byMinute = new Map<number, Bar>();
  let duplicates = 0;
  for (const bar of bars) {
    if (!Number.isFinite(bar.t) || bar.t < s.sessionOpen || bar.t >= s.sessionClose || bar.t + 1 > now + EPS) continue;
    if (!(bar.high >= bar.low) || !(bar.close > 0)) continue;
    if (byMinute.has(bar.t)) duplicates += 1;
    byMinute.set(bar.t, bar);
  }
  const minutes = [...byMinute.values()].sort((a, b) => a.t - b.t);
  const lastBar = minutes.at(-1)?.t ?? -1;
  const buckets = new Map<number, Bar[]>();
  for (const bar of minutes) {
    const start = s.sessionOpen + Math.floor((bar.t - s.sessionOpen) / s.candleMinutes) * s.candleMinutes;
    (buckets.get(start) ?? buckets.set(start, []).get(start)!).push(bar);
  }
  const candles: Candle5[] = [];
  let pending: Candle5 | null = null;
  for (const [start, inside] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const end = start + s.candleMinutes;
    const candle: Candle5 = {
      t: start, open: inside[0].open, high: Math.max(...inside.map((bar) => bar.high)), low: Math.min(...inside.map((bar) => bar.low)), close: inside[inside.length - 1].close,
      volume: inside.reduce((sum, bar) => sum + (bar.volume ?? 0), 0), minutes: inside.length, firstMinute: inside[0].t, lastMinute: inside[inside.length - 1].t,
    };
    const complete = now + EPS >= end && (lastBar >= end || now + EPS >= end + s.graceMinutes || end >= s.sessionClose && now + EPS >= s.sessionClose + s.graceMinutes);
    if (complete) candles.push(candle);
    else pending = candle;
  }
  const gaps: number[] = [];
  for (let k = 1; k < candles.length; k += 1) for (let t = candles[k - 1].t + s.candleMinutes; t < candles[k].t; t += s.candleMinutes) gaps.push(t);
  return { candles, pending, duplicates, gaps, minutes };
}

/** Step 1 + ATM: the completed NIFTY 09:15–09:20 candle decides the colour and the strike. */
export function applyNiftyOpen(state: H0H4State, candle: Candle5 | null, s: H0H4Settings = H0H4_DEFAULTS): H0H4State {
  if (state.phase !== "WAITING_FOR_OPEN") return state;
  const at = s.sessionOpen + s.candleMinutes;
  if (!candle || candle.t !== s.sessionOpen || candle.firstMinute !== s.sessionOpen || candle.lastMinute !== s.sessionOpen + s.candleMinutes - 1) {
    return stop(state, at, "SKIPPED", "NIFTY_DATA_MISSING", candle ? `${candle.minutes}/5 one-minute bars, ${clock(candle.firstMinute)}–${clock(candle.lastMinute)}` : "no candle");
  }
  let next = log({ ...state, open: { open: candle.open, high: candle.high, low: candle.low, close: candle.close, minutes: candle.minutes } }, at, "CHECKING_GREEN",
    `First NIFTY ${s.candleMinutes}-minute candle O ${money(candle.open)} H ${money(candle.high)} L ${money(candle.low)} C ${money(candle.close)}.`);
  if (candle.close === candle.open) return stop({ ...next, color: "NEUTRAL" }, at, "SKIPPED", "NEUTRAL_OPEN");
  const red = candle.close < candle.open;
  const openColour = s.openColour ?? "green";
  if (red && openColour === "green") return stop({ ...next, color: "RED" }, at, "SKIPPED", "RED_OPEN");
  const right: "CE" | "PE" = red && openColour === "both-pe" ? "PE" : "CE";
  const strike = atmStrike(candle.close, s.strikeStep);
  next = log({ ...next, color: red ? "RED" : "GREEN", right }, at, "CHECKING_GREEN", red ? `Opening candle is red: trading the ATM ${right} (${openColour} rule).` : "Opening candle is green.");
  return log({ ...next, strike }, at, "SELECTING_ATM", `ATM strike ${strike} (NIFTY close ${money(candle.close)} → nearest ${s.strikeStep}).`);
}

/** The ATM CE of the nearest weekly expiry (kept all session), or a skip when it cannot be found. */
export function selectContract(state: H0H4State, contract: H0H4Contract | null, at: number, detail = ""): H0H4State {
  if (state.phase !== "SELECTING_ATM") return state;
  const right = state.right ?? "CE";
  if (!contract || contract.strike !== state.strike || contract.right !== right) return stop(state, at, "SKIPPED", "CONTRACT_UNAVAILABLE", detail || `strike ${state.strike} ${right}`);
  return log({ ...state, contract }, at, "WAITING_FOR_H0", `ATM ${right} selected: ${contract.symbol} (lot ${contract.lotSize}).`);
}

const LEVEL_PHASE: Partial<Record<H0H4Phase, { from: "H0" | "H1" | "H2"; set: "H1" | "H2" | "H3"; next: H0H4Phase; label: string }>> = {
  WAITING_FOR_H1: { from: "H0", set: "H1", next: "WAITING_FOR_H2", label: "H1 breakout confirmed" },
  WAITING_FOR_H2: { from: "H1", set: "H2", next: "WAITING_FOR_H3", label: "H2 breakout confirmed" },
  WAITING_FOR_H3: { from: "H2", set: "H3", next: "CALCULATING_FIB", label: "H3 breakout confirmed" },
};

/** One COMPLETED 5-minute CE candle through the level state machine (H0 … H4 breakout). */
export function applyCeCandle(state: H0H4State, c: Candle5, s: H0H4Settings = H0H4_DEFAULTS): H0H4State {
  const phase = state.phase;
  if (!["WAITING_FOR_H0", "WAITING_FOR_H1", "WAITING_FOR_H2", "WAITING_FOR_H3", "WAITING_FOR_H4", "WAITING_FOR_H4_BREAK"].includes(phase)) return state;
  if (state.lastCandle != null && c.t <= state.lastCandle) {
    return { ...warn(state, `Duplicate or out-of-order ${s.candleMinutes}-minute candle ${clock(c.t)} ignored.`), ignoredCandles: state.ignoredCandles + 1 };
  }
  const end = c.t + s.candleMinutes;
  let next: H0H4State = { ...state, lastCandle: c.t };
  const level = (name: H0H4Level["name"]): H0H4Level => ({ name, price: c.high, candle: c.t, confirmedAt: end, close: c.close });
  /** Broken = this candle's HIGH (default) or CLOSE (original spec) is above the level. */
  const breaks = (price: number) => (s.breakMode === "close" ? c.close : c.high) - price > EPS;
  const by = s.breakMode === "close" ? `close ${money(c.close)}` : `high ${money(c.high)}`;

  if (phase === "WAITING_FOR_H0") {
    if (c.t !== s.sessionOpen || c.firstMinute !== s.sessionOpen) return stop(next, end, "SKIPPED", "CE_DATA_MISSING", `first CE candle ${clock(c.t)}, first trade ${clock(c.firstMinute)}`);
    next = { ...next, initial: c, levels: { ...next.levels, H0: level("H0") } };
    return log(next, end, "WAITING_FOR_H1", `H0 established: ${money(c.high)} (Initial Low ${money(c.low)}).`);
  }
  const step = LEVEL_PHASE[phase];
  if (step) {
    const from = next.levels[step.from]!;
    if (!breaks(from.price)) return next;
    next = { ...next, levels: { ...next.levels, [step.set]: level(step.set) } };
    next = log(next, end, step.next, `${step.label}: ${by} > ${step.from} ${money(from.price)} → ${step.set} = ${money(c.high)}.`);
    const anchor = s.anchor ?? "H3";
    if (step.set !== anchor) return next;
    // Fibonacci: 0.0 = Initial Low, 0.5 = the anchor (H3, or H2 in the H2 version), 0.618 = target. Locked from here on.
    const low = next.initial!.low;
    const top = c.high;
    if (!(top - low > EPS)) return stop(next, end, "SKIPPED", "INVALID_FIB", `${anchor} ${money(top)}, Initial Low ${money(low)}`);
    const fib = { ...fibFromAnchors(low, top, s), lockedAt: end };
    next = log({ ...next, fib }, end, "CALCULATING_FIB", `Fibonacci calculated: 0.0 = ${money(fib.f0)}, 0.5 = ${money(fib.f05)} (${anchor}), 0.618 = ${fib.f0618.toFixed(3)} (sell order ${money(fib.targetOrder)}).`);
    if (anchor === "H2") return log(next, end, "WAITING_FOR_H4_BREAK", "Waiting for a close above Fib 0.5 (H2).");
    return log(next, end, "WAITING_FOR_H4", "Waiting for H4.");
  }
  const fib = next.fib!;
  if (phase === "WAITING_FOR_H4") {
    const h3 = next.levels.H3!;
    if (breaks(h3.price)) {
      next = log({ ...next, levels: { ...next.levels, H4: level("H4") } }, end, "VALIDATING_H4", `H4 established: ${by} > H3 ${money(h3.price)} → H4 = ${money(c.high)}.`);
      if (Math.abs(c.high - fib.f0618) <= EPS) return stop({ ...next, h4Valid: false }, end, "SKIPPED", "H4_AT_TARGET", `H4 ${money(c.high)} = ${fib.f0618.toFixed(3)}`);
      if (c.high > fib.f0618) return stop({ ...next, h4Valid: false }, end, "SKIPPED", "H4_ABOVE_TARGET", `H4 ${money(c.high)} > ${fib.f0618.toFixed(3)}`);
      return log({ ...next, h4Valid: true }, end, "WAITING_FOR_H4_BREAK", `H4 ${money(c.high)} < Fib 0.618 ${fib.f0618.toFixed(3)}: valid. Waiting for H4 breakout.`);
    }
    if (c.high >= fib.f0618 - EPS) return stop(next, end, "SKIPPED", "TARGET_BEFORE_ENTRY", `${clock(c.t)} high ${money(c.high)} before H4 formed`);
    return next;
  }
  // WAITING_FOR_H4_BREAK (H2 version: the break level is Fib 0.5 = H2)
  const h2Version = (s.anchor ?? "H3") === "H2";
  const h4 = h2Version ? next.levels.H2! : next.levels.H4!;
  const breakName = h2Version ? "Fib 0.5 (H2)" : "H4";
  const reached = c.high >= fib.f0618 - EPS;
  if (reached && !(breaks(h4.price) && s.breakoutTargetCheck === "allow")) {
    return stop(next, end, "SKIPPED", "TARGET_BEFORE_ENTRY", `${clock(c.t)} high ${money(c.high)}${breaks(h4.price) ? " on the breakout candle itself" : ""}`);
  }
  if (!breaks(h4.price)) return next;
  next = { ...next, breakout: { candle: c.t, close: c.close, high: c.high, signalAt: end } };
  if (end >= s.lastEntryTime) return stop(next, end, "NO_ENTRY", "BREAKOUT_AT_CLOSE", `breakout candle ${clock(c.t)}`);
  return log(next, end, "ENTRY_PENDING", `${breakName} breakout confirmed – BUY signal: ${by} > ${breakName} ${money(h4.price)}.`);
}

/**
 * The paper BUY for a pending signal at an executable price. `quoted` is the price seen (a live ask, or the open of the
 * first 1-minute bar after the breakout candle); `slippage` adds the settings' ticks (a candle open; not a live ask).
 * Refused (session skipped) when the price is already at/above Fib 0.618 or leaves no room below the sell order.
 */
export function fillEntry(state: H0H4State, input: { at: number; quoted: number; source: EntrySource }, s: H0H4Settings = H0H4_DEFAULTS): H0H4State {
  if (state.phase !== "ENTRY_PENDING" || state.entry || !state.fib || !state.contract) return state;
  if (input.at >= s.lastEntryTime) return stop(state, input.at, "NO_ENTRY", "ENTRY_NOT_EXECUTED", `no price before ${clock(s.lastEntryTime)}`);
  if (input.quoted >= state.fib.f0618 - EPS) return stop(state, input.at, "SKIPPED", "TARGET_BEFORE_ENTRY", `executable price ${money(input.quoted)} already at/above the target`);
  const price = input.source === "LIVE_ASK" ? tickUp(input.quoted, s.tick) : tickUp(input.quoted + s.slippageTicks * s.tick, s.tick);
  const fixed = (s.targetPct ?? 0) > 0 || (s.targetPoints ?? 0) > 0;
  if (!fixed && price >= state.fib.targetOrder) return stop(state, input.at, "SKIPPED", "TARGET_BEFORE_ENTRY", `fill ${money(price)} would be at/above the sell order ${money(state.fib.targetOrder)}`);
  const sellOrder = !fixed ? state.fib.targetOrder : Math.max(r2(price + s.tick), (s.targetPct ?? 0) > 0 ? tickUp(price * (1 + s.targetPct / 100), s.tick) : tickUp(price + s.targetPoints, s.tick));
  const quantity = s.lots * state.contract.lotSize;
  const next = { ...state, entry: { time: input.at, price, quoted: input.quoted, source: input.source, quantity, lots: s.lots }, sellOrder, maxHigh: price, minLow: price };
  const how = input.source === "LIVE_ASK" ? "live ask" : input.source === "STOP_TOUCH" ? `stop-buy above the level at ${money(input.quoted)} + ${s.slippageTicks} ticks` : input.source === "GAP_OPEN" ? `opened above the level at ${money(input.quoted)} + ${s.slippageTicks} ticks` : `next bar open ${money(input.quoted)} + ${s.slippageTicks} ticks`;
  return log(next, input.at, "POSITION_OPEN", `BUY ${state.contract.symbol} × ${quantity} @ ${money(price)} (${how}). Position open; target ${money(sellOrder)}${fixed ? ` (${(s.targetPct ?? 0) > 0 ? `+${s.targetPct}%` : `+${s.targetPoints} pts`})` : ""}.`);
}

/** Closes the open position (target or square-off). */
export function exitPosition(state: H0H4State, input: { at: number; price: number; quoted: number; reason: "TARGET" | "SQUARE_OFF"; stale?: boolean }): H0H4State {
  if (state.phase !== "POSITION_OPEN" || !state.entry || state.exit) return state;
  const pending = log(state, input.at, "EXIT_PENDING", input.reason === "TARGET" ? "Target reached – SELL." : `Square-off at ${clock(input.at)} – SELL.`);
  const done = { ...pending, exit: { time: input.at, price: input.price, reason: input.reason, quoted: input.quoted, ...(input.stale ? { stale: true } : {}) }, outcome: "TRADE" as const };
  return input.reason === "TARGET"
    ? log(done, input.at, "TARGET_COMPLETED", `SELL @ ${money(input.price)}: target filled. Trade completed.`)
    : log(done, input.at, "SESSION_COMPLETED", `SELL @ ${money(input.price)}: target not reached, squared off${input.stale ? " (stale last price)" : ""}.`);
}

/** Checks the open position against one completed 1-minute CE bar (the resting target, then the square-off time). */
export function applyPositionBar(state: H0H4State, bar: Bar, s: H0H4Settings = H0H4_DEFAULTS): H0H4State {
  if (state.phase !== "POSITION_OPEN" || !state.entry || !state.fib) return state;
  // A bar-open fill is at the start of bar `entry.time`, so that bar's high/low come after it; a live fill inside a minute only counts later bars.
  // A STOP_TOUCH fill happens inside its minute: that minute's high may have come first, so the target counts from the next bar.
  const first = state.entry.source === "BAR_OPEN" || state.entry.source === "GAP_OPEN" ? state.entry.time : Math.floor(state.entry.time) + 1;
  if (bar.t < first || (state.checkedThrough != null && bar.t <= state.checkedThrough)) return state;
  let next: H0H4State = { ...state, checkedThrough: bar.t };
  if (bar.t >= s.squareOffTime) {
    return exitPosition(next, { at: bar.t, price: Math.max(s.tick, tickDown(bar.open - s.slippageTicks * s.tick, s.tick)), quoted: bar.open, reason: "SQUARE_OFF" });
  }
  next = { ...next, maxHigh: Math.max(next.maxHigh ?? bar.high, bar.high), minLow: Math.min(next.minLow ?? bar.low, bar.low) };
  const through = s.targetFill === "trade-through" ? s.tick : 0;
  const traded = s.targetFill === "touch" || bar.volume == null || bar.volume > 0;
  const sell = state.sellOrder ?? state.fib.targetOrder;
  if (traded && bar.high >= sell + through - EPS) {
    return exitPosition(next, { at: bar.t + 1, price: sell, quoted: bar.high, reason: "TARGET" });
  }
  return next;
}

export type H0H4Feed = {
  /** Minutes after midnight IST (fractions = seconds). The backtest passes 24 × 60. */
  now: number;
  /** NIFTY 50 spot 1-minute bars of the session (any order; duplicates allowed). */
  spot: Bar[];
  /** The selected CE's 1-minute bars (once a contract is selected). */
  ce?: Bar[];
  /** Live executable prices of the selected CE (paper mode only). */
  quote?: { bid: number | null; ask: number | null; ltp?: number | null; at: number } | null;
};

/**
 * Advances a session as far as the data known at `feed.now` allows. Pure and idempotent: calling it again with the same
 * or more data never repeats a level, a signal or an order. Contract selection (SELECTING_ATM) is done by the caller with
 * `selectContract`, then `advanceH0H4` is called again with the CE tape.
 */
export function advanceH0H4(input: H0H4State, feed: H0H4Feed, s: H0H4Settings = H0H4_DEFAULTS): H0H4State {
  let state = input;
  if (isTerminal(state.phase)) return state;
  const now = feed.now;
  if (state.phase === "WAITING_FOR_OPEN") {
    const spot = fiveMinuteCandles(feed.spot, now, s);
    const first = spot.candles.find((candle) => candle.t === s.sessionOpen) ?? null;
    if (!first) {
      if (now + EPS >= s.sessionOpen + s.candleMinutes + s.graceMinutes + 2 && (spot.candles.length || now >= s.sessionClose)) {
        return applyNiftyOpen(state, spot.candles[0] ?? null, s);
      }
      return now >= s.sessionClose ? applyNiftyOpen(state, null, s) : state;
    }
    state = applyNiftyOpen(state, first, s);
  }
  // Once a contract is selected, nothing changes without its tape (never finalise a session on missing CE data).
  if (state.phase === "SELECTING_ATM" || isTerminal(state.phase) || !state.contract || !feed.ce) return state;

  const ce = feed.ce ?? [];
  const built = fiveMinuteCandles(ce, now, s);
  if (built.duplicates) state = warn(state, `${built.duplicates} duplicate 1-minute CE bar(s) merged.`);
  for (const gap of built.gaps.filter((t) => state.lastCandle == null || t > state.lastCandle)) state = warn(state, `No CE trades in the ${clock(gap)} ${s.candleMinutes}-minute candle (nothing filled in).`);
  for (const candle of built.candles) {
    if (!["WAITING_FOR_H0", "WAITING_FOR_H1", "WAITING_FOR_H2", "WAITING_FOR_H3", "WAITING_FOR_H4", "WAITING_FOR_H4_BREAK"].includes(state.phase)) break;
    if (state.phase === "WAITING_FOR_H4_BREAK" && s.entryMode === "touch") break;
    if (state.lastCandle != null && candle.t <= state.lastCandle) continue;
    state = applyCeCandle(state, candle, s);
  }
  // No CE trade at all by the close (a later first candle is already rejected by applyCeCandle).
  if (state.phase === "WAITING_FOR_H0" && now >= s.sessionClose + s.graceMinutes) state = stop(state, s.sessionClose, "SKIPPED", "CE_DATA_MISSING", "no CE trades in the session");

  const bars = built.minutes;
  // Touch entry (research): a stop-buy one tick above H4 (H2 in the H2 version), live from the minute after the level's candle.
  if (state.phase === "WAITING_FOR_H4_BREAK" && s.entryMode === "touch") {
    const level = (s.anchor ?? "H3") === "H2" ? state.levels.H2! : state.levels.H4!;
    const stopPx = r2(tickDown(level.price, s.tick) + s.tick);
    const bucketOf = (t: number) => s.sessionOpen + Math.floor((Math.floor(t) - s.sessionOpen) / s.candleMinutes) * s.candleMinutes;
    const hit = bars.find((bar) => bar.t >= level.confirmedAt && bar.t < s.lastEntryTime && (bar.open >= stopPx - EPS || bar.high >= stopPx - EPS)) ?? null;
    const q = feed.quote;
    const liveCross = q && q.at >= level.confirmedAt && q.at < s.lastEntryTime && q.ask != null && q.ask > 0 && (hit != null || (q.ltp ?? 0) >= stopPx - EPS);
    if (liveCross) {
      // Paper: the break is only known now, so the stop-buy fills at the live ask (never at a past bar's price).
      state = log({ ...state, breakout: { candle: bucketOf(hit?.t ?? q.at), close: hit?.close ?? q.ltp ?? q.ask!, high: hit?.high ?? q.ltp ?? q.ask!, signalAt: hit?.t ?? q.at } }, q.at, "ENTRY_PENDING", `${level.name} ${money(level.price)} traded through – BUY signal (live).`);
      state = fillEntry(state, { at: q.at, quoted: q.ask!, source: "LIVE_ASK" }, s);
    } else if (hit && !q) {
      const gap = hit.open >= stopPx - EPS;
      state = log({ ...state, breakout: { candle: bucketOf(hit.t), close: hit.close, high: hit.high, signalAt: hit.t } }, hit.t, "ENTRY_PENDING", `${level.name} ${money(level.price)} traded through at ${clock(hit.t)} – BUY signal (touch entry).`);
      state = fillEntry(state, { at: hit.t, quoted: gap ? hit.open : stopPx, source: gap ? "GAP_OPEN" : "STOP_TOUCH" }, s);
    }
  }
  if (state.phase === "ENTRY_PENDING") {
    const signalAt = state.breakout!.signalAt;
    const ask = feed.quote?.ask;
    const bar = bars.find((item) => item.t >= signalAt && item.t < s.lastEntryTime);
    // Paper (live quotes): the ask when the signal is seen — a published 1-minute bar is already in the past. Backtest
    // (no quotes): the open of the first 1-minute bar after the breakout candle + slippage.
    if (feed.quote && ask != null && ask > 0 && feed.quote.at >= signalAt) state = fillEntry(state, { at: feed.quote.at, quoted: ask, source: "LIVE_ASK" }, s);
    else if (bar) state = fillEntry(state, { at: bar.t, quoted: bar.open, source: "BAR_OPEN" }, s);
    else if (now >= s.lastEntryTime) state = stop(state, now, "NO_ENTRY", "ENTRY_NOT_EXECUTED", `no CE price between ${clock(signalAt)} and ${clock(s.lastEntryTime)}`);
  }
  if (state.phase === "POSITION_OPEN") {
    for (const bar of bars) {
      if (state.phase !== "POSITION_OPEN") break;
      state = applyPositionBar(state, bar, s);
    }
    // Live: a bid at/above the resting sell fills it; the square-off uses the bid once its time has come.
    const bid = feed.quote?.bid;
    if (state.phase === "POSITION_OPEN" && feed.quote && bid != null && bid > 0 && feed.quote.at > state.entry!.time) {
      const sell = state.sellOrder ?? state.fib!.targetOrder;
      if (bid >= sell) state = exitPosition(state, { at: feed.quote.at, price: sell, quoted: bid, reason: "TARGET" });
      else if (feed.quote.at >= s.squareOffTime) state = exitPosition(state, { at: feed.quote.at, price: Math.max(s.tick, tickDown(bid, s.tick)), quoted: bid, reason: "SQUARE_OFF" });
    }
    if (state.phase === "POSITION_OPEN" && now >= s.sessionClose + s.graceMinutes) {
      const last = bars.filter((bar) => bar.t >= state.entry!.time).at(-1) ?? bars.at(-1);
      if (last) state = exitPosition(state, { at: last.t + 1, price: Math.max(s.tick, tickDown(last.close - s.slippageTicks * s.tick, s.tick)), quoted: last.close, reason: "SQUARE_OFF", stale: s.squareOffTime - (last.t + 1) > 10 });
    }
  }
  // Market closed before the setup completed.
  if (!isTerminal(state.phase) && state.phase !== "POSITION_OPEN" && now >= s.sessionClose + s.graceMinutes) {
    const reason: Partial<Record<H0H4Phase, H0H4Reason>> = { WAITING_FOR_H1: "H0_NEVER_BROKEN", WAITING_FOR_H2: "H1_NEVER_BROKEN", WAITING_FOR_H3: "H2_NEVER_BROKEN", WAITING_FOR_H4: "H3_NEVER_BROKEN", WAITING_FOR_H4_BREAK: "H4_NEVER_BROKEN", ENTRY_PENDING: "ENTRY_NOT_EXECUTED" };
    const code = state.phase === "WAITING_FOR_H4_BREAK" && (s.anchor ?? "H3") === "H2" ? "H2_NEVER_BROKEN" : reason[state.phase];
    if (code) state = stop(state, s.sessionClose, "NO_ENTRY", code);
  }
  return state;
}

/* ---------------- results ---------------- */

export type H0H4TradeResult = { quantity: number; gross: number; charges: number; net: number; slippage: number; win: boolean; target: boolean; chargesDetail: ReturnType<typeof tradeCharges> };

/** Gross / charges / net of a closed trade (dated statutory charges + ₹20 per order). */
export function tradeResult(state: H0H4State, s: H0H4Settings = H0H4_DEFAULTS): H0H4TradeResult | null {
  if (!state.entry || !state.exit) return null;
  const quantity = state.entry.quantity;
  const gross = r2((state.exit.price - state.entry.price) * quantity);
  const chargesDetail = tradeCharges(state.entry.price, state.exit.price, quantity, state.date, s.charges);
  const net = r2(gross - chargesDetail.total);
  const slippage = r2(((state.entry.price - state.entry.quoted) + (state.exit.reason === "SQUARE_OFF" ? state.exit.quoted - state.exit.price : 0)) * quantity);
  return { quantity, gross, charges: chargesDetail.total, net, slippage, win: net > 0, target: state.exit.reason === "TARGET", chargesDetail };
}

/** Unrealised P&L of an open position at a price (before exit charges). */
export const unrealized = (state: H0H4State, price: number | null) => (state.entry && price != null ? r2((price - state.entry.price) * state.entry.quantity) : null);

/** Which progress step each phase has reached (GREEN OPEN → … → TARGET) and its colour. */
export const PROGRESS_STEPS = ["GREEN OPEN", "ATM CE", "H0", "H1", "H2", "H3", "FIB", "H4", "BREAK H4", "BUY", "TARGET"] as const;
export type ProgressTone = "done" | "waiting" | "failed" | "idle";
export function progress(state: H0H4State): { step: (typeof PROGRESS_STEPS)[number]; tone: ProgressTone }[] {
  const done = [
    state.strike != null, Boolean(state.contract), Boolean(state.levels.H0), Boolean(state.levels.H1), Boolean(state.levels.H2), Boolean(state.levels.H3),
    Boolean(state.fib), Boolean(state.levels.H4 && state.h4Valid), Boolean(state.breakout), Boolean(state.entry), state.exit?.reason === "TARGET",
  ];
  const failed = state.outcome === "SKIPPED" || state.outcome === "NO_ENTRY" || (state.exit != null && state.exit.reason !== "TARGET");
  const firstOpen = done.findIndex((ok) => !ok);
  return PROGRESS_STEPS.map((step, index) => ({ step, tone: done[index] ? "done" : index === firstOpen ? (failed ? "failed" : "waiting") : "idle" }));
}

/** A flat record of one session for reports and CSV (prices full precision where calculated). */
export function sessionRow(state: H0H4State, s: H0H4Settings = H0H4_DEFAULTS) {
  const t = tradeResult(state, s);
  const lv = state.levels;
  return {
    date: state.date,
    niftyOpen: state.open?.open ?? null, niftyHigh: state.open?.high ?? null, niftyLow: state.open?.low ?? null, niftyClose: state.open?.close ?? null, openColour: state.color,
    sellOrder: state.sellOrder ?? state.fib?.targetOrder ?? null, entrySource: state.entry?.source ?? null,
    atmStrike: state.strike, right: state.contract?.right ?? state.right ?? null, ceSymbol: state.contract?.symbol ?? null, expiry: state.contract?.expiry ?? null, lotSize: state.contract?.lotSize ?? null,
    ceOpen: state.initial?.open ?? null, ceHigh: state.initial?.high ?? null, ceLow: state.initial?.low ?? null, ceClose: state.initial?.close ?? null,
    h0: lv.H0?.price ?? null, h1: lv.H1?.price ?? null, h1Time: lv.H1 ? clock(lv.H1.confirmedAt) : null, h2: lv.H2?.price ?? null, h2Time: lv.H2 ? clock(lv.H2.confirmedAt) : null,
    h3: lv.H3?.price ?? null, h3Time: lv.H3 ? clock(lv.H3.confirmedAt) : null, fib0: state.fib?.f0 ?? null, fib05: state.fib?.f05 ?? null, fib0618: state.fib ? Number(state.fib.f0618.toFixed(6)) : null,
    targetOrder: state.fib?.targetOrder ?? null, h4: lv.H4?.price ?? null, h4Time: lv.H4 ? clock(lv.H4.confirmedAt) : null,
    h4Validation: state.h4Valid == null ? null : state.h4Valid ? "VALID" : state.reason === "H4_AT_TARGET" ? "EQUAL_TO_TARGET" : "ABOVE_TARGET",
    h4BreakoutTime: state.breakout ? clock(state.breakout.signalAt) : null,
    entryPrice: state.entry?.price ?? null, entryTime: state.entry ? clock(state.entry.time) : null, entryQuoted: state.entry?.quoted ?? null,
    exitPrice: state.exit?.price ?? null, exitTime: state.exit ? clock(state.exit.time) : null, exitReason: state.exit?.reason ?? null,
    quantity: t?.quantity ?? null, gross: t?.gross ?? null, charges: t?.charges ?? null, net: t?.net ?? null,
    result: t ? (t.win ? "WIN" : "LOSS") : null, status: state.phase, outcome: state.outcome, reason: state.reason, reasonText: state.reason ? REASON_TEXT[state.reason] : null,
    warnings: state.dataWarnings.length,
  };
}
export type H0H4Row = ReturnType<typeof sessionRow>;

const avg = (values: number[]) => (values.length ? r2(values.reduce((a, b) => a + b, 0) / values.length) : null);
const mins = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null ? b - a : null);

/** The strategy's performance report from session states (overall, year-wise, month-wise, timing analysis). */
export function h0h4Report(states: H0H4State[], s: H0H4Settings = H0H4_DEFAULTS) {
  const sorted = [...states].sort((a, b) => a.date.localeCompare(b.date));
  const trades = sorted.flatMap((state) => { const t = tradeResult(state, s); return t ? [{ state, t }] : []; });
  let equity = 0, peak = 0, maxDrawdown = 0, run = 0, maxWins = 0, maxLosses = 0;
  for (const { t } of trades) {
    equity += t.net; peak = Math.max(peak, equity); maxDrawdown = Math.min(maxDrawdown, equity - peak);
    run = t.win ? (run > 0 ? run + 1 : 1) : (run < 0 ? run - 1 : -1);
    maxWins = Math.max(maxWins, run); maxLosses = Math.max(maxLosses, -run);
  }
  const count = (fn: (state: H0H4State) => boolean) => sorted.filter(fn).length;
  const wins = trades.filter((x) => x.t.win).length;
  const sum = (key: "gross" | "charges" | "net") => r2(trades.reduce((acc, x) => acc + x.t[key], 0));
  const group = (key: (date: string) => string) => {
    const out = new Map<string, { period: string; trades: number; wins: number; losses: number; winRate: number; gross: number; net: number }>();
    for (const { state, t } of trades) {
      const k = key(state.date);
      const row = out.get(k) ?? { period: k, trades: 0, wins: 0, losses: 0, winRate: 0, gross: 0, net: 0 };
      row.trades += 1; row.wins += t.win ? 1 : 0; row.losses += t.win ? 0 : 1; row.gross = r2(row.gross + t.gross); row.net = r2(row.net + t.net);
      row.winRate = r2((row.wins / row.trades) * 100);
      out.set(k, row);
    }
    return [...out.values()].sort((a, b) => a.period.localeCompare(b.period));
  };
  const reasons: Record<string, number> = {};
  for (const state of sorted) if (state.reason) reasons[state.reason] = (reasons[state.reason] ?? 0) + 1;
  return {
    overall: {
      sessions: sorted.length,
      greenOpen: count((x) => x.color === "GREEN"),
      redOpen: count((x) => x.color === "RED"),
      neutralOpen: count((x) => x.color === "NEUTRAL"),
      h0: count((x) => Boolean(x.levels.H0)),
      h1: count((x) => Boolean(x.levels.H1)),
      h2: count((x) => Boolean(x.levels.H2)),
      h3: count((x) => Boolean(x.levels.H3)),
      h4: count((x) => Boolean(x.levels.H4)),
      validH4: count((x) => x.h4Valid === true),
      h4Breakout: count((x) => Boolean(x.breakout)),
      trades: trades.length,
      targetHits: trades.filter((x) => x.t.target).length,
      nonTargetExits: trades.filter((x) => !x.t.target).length,
      noEntrySessions: sorted.length - trades.length,
      wins, losses: trades.length - wins, winRate: trades.length ? r2((wins / trades.length) * 100) : 0,
      grossProfit: sum("gross"), charges: sum("charges"), netProfit: sum("net"), avgPerTrade: trades.length ? r2(sum("net") / trades.length) : 0,
      maxDrawdown: r2(maxDrawdown), maxConsecutiveWins: maxWins, maxConsecutiveLosses: maxLosses,
      ambiguousTrades: 0,
    },
    years: group((date) => date.slice(0, 4)),
    months: group((date) => date.slice(0, 7)),
    analysis: {
      avgH0toH1: avg(sorted.flatMap((x) => { const d = mins(x.levels.H0?.confirmedAt, x.levels.H1?.confirmedAt); return d == null ? [] : [d]; })),
      avgH1toH2: avg(sorted.flatMap((x) => { const d = mins(x.levels.H1?.confirmedAt, x.levels.H2?.confirmedAt); return d == null ? [] : [d]; })),
      avgH2toH3: avg(sorted.flatMap((x) => { const d = mins(x.levels.H2?.confirmedAt, x.levels.H3?.confirmedAt); return d == null ? [] : [d]; })),
      avgH3toH4: avg(sorted.flatMap((x) => { const d = mins(x.levels.H3?.confirmedAt, x.levels.H4?.confirmedAt); return d == null ? [] : [d]; })),
      avgH4toEntry: avg(sorted.flatMap((x) => { const d = mins(x.levels.H4?.confirmedAt, x.entry?.time); return d == null ? [] : [d]; })),
      avgEntryToTarget: avg(trades.flatMap((x) => (x.t.target ? [x.state.exit!.time - x.state.entry!.time] : []))),
      h4NeverBroke: count((x) => x.reason === "H4_NEVER_BROKEN"),
      targetBeforeEntry: count((x) => x.reason === "TARGET_BEFORE_ENTRY"),
      invalidH4: count((x) => x.reason === "H4_AT_TARGET" || x.reason === "H4_ABOVE_TARGET"),
      reasons,
    },
  };
}
export type H0H4Report = ReturnType<typeof h0h4Report>;

/* ---------------- calendar ---------------- */

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const isTradingDay = (date: string, holidays: ReadonlySet<string>) => { const d = new Date(`${date}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6 && !holidays.has(date); };

/**
 * NIFTY's nearest weekly expiry for a session by the NSE rule (as the backtest exporter's --expiry-rule): Thursday up to
 * 31 Aug 2025, Tuesday from 1 Sep 2025; an expiry weekday that is a holiday moves to the previous trading day.
 */
export function weeklyExpiryByRule(date: string, holidays: Iterable<string> = []): string {
  const off = new Set(holidays);
  for (let k = 0; k < 14; k += 1) {
    const day = addDays(date, k);
    const weekday = day <= "2025-08-31" ? 4 : 2;
    if (new Date(`${day}T00:00:00Z`).getUTCDay() !== weekday) continue;
    let expiry = day;
    while (!isTradingDay(expiry, off) && expiry > date) expiry = addDays(expiry, -1);
    if (expiry >= date && isTradingDay(expiry, off)) return expiry;
  }
  return addDays(date, 7);
}

/** IST minute of the day of a unix time (seconds). */
export const istMinute = (unixSeconds: number) => (((unixSeconds + 19_800) % 86_400) + 86_400) % 86_400 / 60;
