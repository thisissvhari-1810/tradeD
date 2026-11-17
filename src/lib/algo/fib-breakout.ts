/**
 * 1-Hour Fibonacci Breakout Strategy — corrected rules (user, 17 Nov 2026). An independent strategy: it shares no settings,
 * state or code path with the Mathi strategies, and it never places an order. Backtest and paper only.
 *
 * 1. First hour = 09:15–10:15 IST. ATM = NIFTY spot's first-hour close (the 10:14 1-minute close) rounded to the strike
 *    step; the SAME strike for CE and PE, nearest weekly expiry.
 * 2. Each contract's own first-hour candle gives H, L, R = H − L and its colour: GREEN (close > open) or RED (close < open).
 *    GREEN: Fib 0 = L (bottom), 1 = H (top), price = L + R × level. Trigger 0.236, target 0.382.
 *    RED:   Fib 0 = H (top), 1 = L (bottom), price = H − R × level. Trigger 0.786, target 0.618.
 *    A doji (close = open) or R = 0 has no setup.
 * 3. Entry — live-price breakout ("Entry Method A"): from 10:15, BUY the moment the option's price crosses ABOVE the
 *    trigger from below. No candle close is awaited, no hourly confirmation, no fallback: if the cross never happens,
 *    NO ENTRY. One entry per contract per day.
 * 4. Exit: a resting sell at the target (rounded up to the tick); otherwise square-off at 15:29. No stop-loss.
 * 5. Optional, OFF by default (user: "no need", 17 Nov 2026) — rolling reference (`referenceHours` 4): with no entry from the 1st hour's levels by 11:15, the
 *    2nd hour's candle becomes the reference (11:15–12:15), then the 3rd (12:15–13:15), then the 4th (13:15–15:29).
 *
 * The engine reads a price tape of bars. Live/paper: feed each tick (or 1-second bar) as a bar with o = h = l = c and the
 * cross is exact. Backtest: only 1-minute OHLC exists, so a cross inside a minute is MODELLED (fill = the first tick price
 * above the trigger + slippage) and every entry says how it was derived:
 *   GAP_OPEN          the price before the minute was at/below the trigger and the minute OPENED above it → fill at the open.
 *   INTRAMINUTE       at/below the trigger at the minute's start (previous close, or an open at/below it), high above it:
 *                     the cross is certain; its price is modelled at the first tick above the trigger.
 *   INTRAMINUTE_ARMED the minute opened above the trigger, traded at/below it (low) and CLOSED above it: it certainly came
 *                     from below after the low; price modelled as above.
 *   Ambiguous minute  opened above, traded at/below and closed at/below: a cross back above may or may not have happened
 *                     inside it (unknown order) → no entry is assumed (conservative); listed in `ambiguousMinutes`.
 * After an intraminute fill the target is checked from the NEXT minute (the minute's high may have come before the fill);
 * after a GAP_OPEN fill from the same minute (its open came first).
 *
 * All times are minutes after midnight IST. A bar stamped `t` covers [t, t+1) and is known at t+1.
 */

export type Right = "CE" | "PE";
export type FibDirection = "GREEN" | "RED";

export type MinuteBar = { t: number; open: number; high: number; low: number; close: number; volume?: number };
export type HourCandle = { index: number; start: number; end: number; open: number; high: number; low: number; close: number; minutes: number; lastBar: number };

export type ChargeSettings = {
  /** ₹ per executed order. */
  brokeragePerOrder: number;
  /** STT on the SELL premium turnover; dated rates, the last whose `from` ≤ the trade date applies. */
  sttSell: { from: string; rate: number }[];
  /** NSE options transaction charge on premium turnover (both legs). */
  exchangeRate: number;
  /** Dated NSE transaction charges (the last whose `from` ≤ the trade date applies); `exchangeRate` when none applies. */
  exchangeRates?: { from: string; rate: number }[];
  /** SEBI fee, ₹ per crore of turnover. */
  sebiPerCrore: number;
  /** Stamp duty on the BUY premium turnover. */
  stampBuyRate: number;
  /** GST on brokerage + exchange + SEBI fees. */
  gstRate: number;
};

export type FibSettings = {
  underlying: "NIFTY";
  strikeStep: number;
  sides: Right[];
  lots: number;
  greenEntryLevel: number;
  greenTargetLevel: number;
  redEntryLevel: number;
  redTargetLevel: number;
  /** Session open and the length of the first-hour candle (09:15 + 60). */
  sessionOpen: number;
  hourMinutes: number;
  /** Reference candles: 1 = the first hour only; 4 = roll to the 2nd, 3rd and 4th hour while there is no entry. */
  referenceHours: number;
  /** Research options (17 Nov 2026), all OFF (0) by default: stop-loss % below the entry; time exit after N minutes in the
   * trade; no new entry at/after this minute of the day. */
  stopLossPct: number;
  maxHoldMinutes: number;
  lastEntryTime: number;
  /** Research (17 Nov 2026), off by default. "worst": a buy inside a minute fills at that minute's HIGH instead of the first
   * tick above the trigger. `ambiguousAsEntry`: a minute whose price order is unknown counts as a cross (optimistic bound). */
  fillModel: "trigger" | "worst";
  ambiguousAsEntry: boolean;
  /** Research (17 Nov 2026), 1 = off: sell once the price has gone this share of the way from the fill to the Fib target
   * (0.5 = half-way), rounded up to the tick. */
  targetFraction: number;
  /** Research (17 Nov 2026), 0 = off: once the price has gone this share of the way to the target, move the stop to the
   * entry price (armed from the NEXT minute; a fall back to the entry sells at it or a lower open, minus slippage). */
  breakevenAfterFraction: number;
  /** Research option, off (user undid it, 17 Nov 2026): no entry on the contract's expiry day (needs `context.dte`). */
  skipExpiryDay: boolean;
  /** Research option (undone by the user, 17 Nov 2026), 0 = off: sell at entry + this share of the reference candle's Fib range (High − Low), instead
   * of the Fib target level. 0.3 → e.g. range 10.15 pts, entry 222.60 → sell at 225.65 (rounded up to the tick). */
  targetRangeFraction: number;
  /** Skip the trade (NO ENTRY for the day) when, at the cross, the Fib target is less than this % above the buy price (0 = off). */
  minTargetPct: number;
  /** Square-off minute: entries only before it; an open position is sold at the first price at/after it (15:29). */
  squareOffTime: number;
  /** A first-hour contract candle needs at least this many of its 60 one-minute candles, incl. 09:15 and ≥ 10:13. */
  minFirstHourMinutes: number;
  tick: number;
  /** Slippage per unit, in ticks, on the market buy and the market square-off (the resting target has none). */
  slippageTicks: number;
  /** "trade-through": the target fills only when a candle with volume trades a tick through it; "touch": reaching it. */
  targetFill: "trade-through" | "touch";
  charges: ChargeSettings;
};

export const hhmm = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
export const clockOf = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Statutory F&O option charges (Finance Act 2026: option STT 0.15% from 1 Apr 2026; NSE 0.03503% since 1 Oct 2024). */
export const STATUTORY_CHARGES: ChargeSettings = {
  brokeragePerOrder: 20,
  // History (NIFTY APEX audit, 2026-11-15): STT 0.05% → 0.0625% (1-Apr-2023) → 0.1% (1-Oct-2024) → 0.15% (1-Apr-2026);
  // NSE 0.053% → 0.05% (1-Apr-2023) → 0.0495% (1-Apr-2024) → 0.03503% (1-Oct-2024).
  sttSell: [{ from: "2000-01-01", rate: 0.0005 }, { from: "2023-04-01", rate: 0.000625 }, { from: "2024-10-01", rate: 0.001 }, { from: "2026-04-01", rate: 0.0015 }],
  exchangeRate: 0.0003503,
  exchangeRates: [{ from: "2000-01-01", rate: 0.00053 }, { from: "2023-04-01", rate: 0.0005 }, { from: "2024-04-01", rate: 0.000495 }, { from: "2024-10-01", rate: 0.0003503 }],
  sebiPerCrore: 10,
  stampBuyRate: 0.00003,
  gstRate: 0.18,
};

/** The original V0 (fixed by the user earlier on 17 Nov 2026): full Fib target, trades on expiry day too. */
export const FIB_V0: FibSettings = {
  underlying: "NIFTY",
  strikeStep: 50,
  sides: ["CE", "PE"],
  lots: 1,
  greenEntryLevel: 0.236,
  greenTargetLevel: 0.382,
  redEntryLevel: 0.786,
  redTargetLevel: 0.618,
  sessionOpen: hhmm("09:15"),
  hourMinutes: 60,
  squareOffTime: hhmm("15:29"),
  referenceHours: 1,
  stopLossPct: 0,
  maxHoldMinutes: 0,
  lastEntryTime: 0,
  fillModel: "trigger",
  ambiguousAsEntry: false,
  targetFraction: 1,
  breakevenAfterFraction: 0,
  skipExpiryDay: false,
  targetRangeFraction: 0,
  minTargetPct: 0,
  minFirstHourMinutes: 54,
  tick: 0.05,
  slippageTicks: 2,
  targetFill: "trade-through",
  charges: STATUTORY_CHARGES,
};

/** Current configuration (user, 17 Nov 2026) — FIRST MINUTE, no filters: the 09:15 one-minute candle is the reference (ATM from
 * NIFTY's 09:15 close, monitoring from 09:16), V0 Fib levels, live-price entry, exit at the Fib target or 15:29; trades every
 * day incl. expiry days and small targets. Backtest 17 Nov 2021 – 16 Nov 2026: 2,086 trades, 1,891/195 (90.7%), net −₹1,11,104. */
export const FIB_DEFAULTS: FibSettings = { ...FIB_V0, hourMinutes: 1, minFirstHourMinutes: 1 };

/** Saved alternative — first minute + no expiry day + skip when the target is under 5% above the buy price
 * (5 years: 463 trades, 418/45, net +₹33,776). Backtest flag: --filtered. */
export const FIB_FIRST_MINUTE_FILTERED: FibSettings = { ...FIB_DEFAULTS, skipExpiryDay: true, minTargetPct: 5 };

/** NIFTY lot size by contract expiry (NSE circulars): 50 → 25 (after the 25-Apr-2024 expiry) → 75 (after 24-Dec-2024) → 65 (after 30-Dec-2025). */
export const niftyLotSize = (expiry: string) => (expiry <= "2024-04-25" ? 50 : expiry <= "2024-12-24" ? 25 : expiry <= "2025-12-30" ? 75 : 65);

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const contractSymbol = (underlying: string, expiry: string, strike: number, right: Right) =>
  `${underlying} ${expiry.slice(8, 10)}-${MONTHS[Number(expiry.slice(5, 7)) - 1]}-${expiry.slice(0, 4)} ${strike} ${right}`;

export const r2 = (value: number) => Math.round(value * 100) / 100;
const EPS = 1e-9;
const tickUp = (price: number, tick: number) => r2(Math.ceil(price / tick - EPS) * tick);
const tickDown = (price: number, tick: number) => r2(Math.floor(price / tick + EPS) * tick);

/** Every Fibonacci level of a first-hour candle, exact (unrounded) prices. */
export function fibLevels(high: number, low: number, direction: FibDirection, levels = [1, 0.786, 0.618, 0.5, 0.382, 0.236, 0]) {
  const range = high - low;
  return levels.map((level) => ({ level, price: direction === "GREEN" ? low + range * level : high - range * level }));
}
export const fibPrice = (high: number, low: number, direction: FibDirection, level: number) => fibLevels(high, low, direction, [level])[0].price;

/** ATM strike from the spot price at the first hour's close. */
export const atmStrike = (spot: number, step: number) => Math.round(spot / step) * step;

/** An hourly candle on the session grid from 1-minute candles. */
export function hourCandle(bars: MinuteBar[], start: number, end: number, index: number): HourCandle | null {
  const inside = bars.filter((bar) => bar.t >= start && bar.t < end);
  if (!inside.length) return null;
  return {
    index, start, end, open: inside[0].open, high: Math.max(...inside.map((bar) => bar.high)), low: Math.min(...inside.map((bar) => bar.low)),
    close: inside[inside.length - 1].close, minutes: inside.length, lastBar: inside[inside.length - 1].t,
  };
}

export function tradeCharges(buy: number, sell: number, quantity: number, date: string, charges: ChargeSettings) {
  const buyTurnover = buy * quantity;
  const sellTurnover = sell * quantity;
  const sttRate = [...charges.sttSell].filter((row) => row.from <= date).pop()?.rate ?? 0;
  const brokerage = 2 * charges.brokeragePerOrder;
  const stt = sellTurnover * sttRate;
  const exchangeRate = [...(charges.exchangeRates ?? [])].filter((row) => row.from <= date).pop()?.rate ?? charges.exchangeRate;
  const exchange = (buyTurnover + sellTurnover) * exchangeRate;
  const sebi = ((buyTurnover + sellTurnover) * charges.sebiPerCrore) / 1e7;
  const stamp = buyTurnover * charges.stampBuyRate;
  const gst = charges.gstRate * (brokerage + exchange + sebi);
  return { brokerage: r2(brokerage), stt: r2(stt), exchange: r2(exchange), sebi: r2(sebi), stamp: r2(stamp), gst: r2(gst), total: r2(brokerage + stt + exchange + sebi + stamp + gst) };
}

export type ContractDayStatus =
  | "INCOMPLETE" // first-hour data missing / too thin: not evaluated
  | "NO_SETUP" // doji or zero range
  | "WAITING" // paper: setup pending or monitoring (only while `now` is before the square-off)
  | "NO_ENTRY" // the price never crossed above the trigger from below before the square-off
  | "NOT_EXECUTED" // entered but no premium after the entry (data gap): not counted
  | "OPEN" // paper: position open at `now`
  | "CLOSED";

export type EntryFill = "GAP_OPEN" | "INTRAMINUTE" | "INTRAMINUTE_ARMED" | "AMBIGUOUS";

export type ContractDayResult = {
  right: Right;
  status: ContractDayStatus;
  note: string;
  firstHour: { open: number; high: number; low: number; close: number; minutes: number } | null;
  /** The hourly candle whose Fibonacci levels are in force (the one that gave the entry, else the last one checked). */
  /** The sell price actually used (Fib target, a share of the way to it, or entry + a share of the range). */
  exitTarget?: number;
  /** Why a day has no entry because of a rule (not because the price never crossed). */
  skipReason?: "EXPIRY_DAY" | "SMALL_TARGET";
  reference: { hour: number; start: number; end: number; open: number; high: number; low: number; close: number; windowEnd: number } | null;
  direction: FibDirection | null;
  levels: { level: number; price: number }[];
  entryLevel: number | null;
  entryLevelPrice: number | null;
  targetLevel: number | null;
  targetLevelPrice: number | null;
  /** The buy trigger on the tick grid: the first tradable price ABOVE the Fib trigger. */
  triggerOrder: number | null;
  /** The resting sell price (target rounded up to the tick). */
  targetOrder: number | null;
  /** Hourly candles of the contract, for charts only (no decision uses them after the first hour). */
  hours: HourCandle[];
  /** Was the price at/below the trigger when monitoring started (the first-hour close)? */
  startedBelow: boolean | null;
  /** Minutes where a cross may have happened but the 1-minute OHLC order cannot tell (no entry assumed). */
  ambiguousMinutes: number[];
  entry: { time: number; price: number; barOpen: number; fill: EntryFill; aboveTarget: boolean } | null;
  exit: { time: number; price: number; reason: "TARGET" | "SQUARE_OFF" | "STOP_LOSS" | "TIME_EXIT" | "BREAKEVEN"; barPrice?: number; stale?: boolean } | null;
  maxHigh: number | null;
  minLow: number | null;
};

/**
 * Evaluates one contract for one session using only bars completed by `now` (default: the whole session).
 * Paper mode calls it with the live tape; the backtest calls it once with the full 1-minute tape.
 */
export function evaluateContractDay(right: Right, tape: MinuteBar[], settings: FibSettings = FIB_DEFAULTS, now = 24 * 60, context: { dte?: number } = {}): ContractDayResult {
  const expirySkip = settings.skipExpiryDay && context.dte === 0;
  const s = settings;
  const bars = tape.filter((bar) => bar.t + 1 <= now).sort((a, b) => a.t - b.t);
  const result: ContractDayResult = {
    right, status: "INCOMPLETE", note: "", firstHour: null, reference: null, direction: null, levels: [], entryLevel: null, entryLevelPrice: null, targetLevel: null, targetLevelPrice: null,
    triggerOrder: null, targetOrder: null, hours: [], startedBelow: null, ambiguousMinutes: [], entry: null, exit: null, maxHigh: null, minLow: null,
  };
  const firstEnd = s.sessionOpen + s.hourMinutes;
  if (now < firstEnd) return { ...result, status: "WAITING", note: "First hour not complete yet." };
  const first = hourCandle(bars, s.sessionOpen, firstEnd, 1);
  const firstBars = bars.filter((bar) => bar.t >= s.sessionOpen && bar.t < firstEnd);
  if (!first) return { ...result, note: "No first-hour candles for this contract." };
  if (first.minutes < s.minFirstHourMinutes || firstBars[0].t !== s.sessionOpen || first.lastBar < firstEnd - 2) {
    return { ...result, note: `First hour incomplete: ${first.minutes}/60 one-minute candles, first ${clockOf(firstBars[0].t)}, last ${clockOf(first.lastBar)}.` };
  }
  result.firstHour = { open: first.open, high: first.high, low: first.low, close: first.close, minutes: first.minutes };
  for (let start = s.sessionOpen, index = 1; start < s.squareOffTime + 1; start += 60, index += 1) {   // display: hourly candles
    const hour = hourCandle(bars, start, Math.min(start + 60, s.squareOffTime + 1), index);
    if (hour) result.hours.push(hour);
  }
  // Reference candles (user, 17 Nov 2026): the 1st hour's levels are watched until the 2nd hour closes; with no entry by
  // then, the 2nd hour's own candle (its colour, high and low) becomes the reference for the next hour, then the 3rd, then
  // the `referenceHours`-th, whose levels are watched until the square-off. Same contract all day; one entry at most.
  let fillBar: MinuteBar | null = null;
  let fill = 0;
  let kind: EntryFill = "INTRAMINUTE";
  const checked: string[] = [];
  for (let k = 1; k <= Math.max(1, s.referenceHours) && !fillBar; k += 1) {
    const start = s.sessionOpen + (k - 1) * s.hourMinutes;
    const end = start + s.hourMinutes;
    if (end > now || end >= s.squareOffTime) break;
    const windowEnd = k < s.referenceHours ? Math.min(end + s.hourMinutes, s.squareOffTime) : s.squareOffTime;
    const candle = k === 1 ? first : hourCandle(bars, start, end, k);
    const label = `hour ${k} (${clockOf(start)}–${clockOf(end)})`;
    if (!candle || candle.minutes < s.minFirstHourMinutes || candle.lastBar < end - 2) { checked.push(`${label}: incomplete candle`); continue; }
    if (candle.close === candle.open || candle.high <= candle.low) { checked.push(`${label}: doji / no range`); continue; }
    const direction: FibDirection = candle.close > candle.open ? "GREEN" : "RED";
    const entryLevel = direction === "GREEN" ? s.greenEntryLevel : s.redEntryLevel;
    const targetLevel = direction === "GREEN" ? s.greenTargetLevel : s.redTargetLevel;
    const trigger = fibPrice(candle.high, candle.low, direction, entryLevel);
    const targetPrice = fibPrice(candle.high, candle.low, direction, targetLevel);
    // First tradable price strictly above the trigger.
    const stopPx = r2(tickDown(trigger, s.tick) + s.tick);
    Object.assign(result, {
      reference: { hour: k, start, end, open: candle.open, high: candle.high, low: candle.low, close: candle.close, windowEnd },
      direction, levels: fibLevels(candle.high, candle.low, direction, [...new Set([1, 0.786, 0.618, 0.5, 0.382, 0.236, 0, entryLevel, targetLevel])].sort((a, b) => b - a)), entryLevel, entryLevelPrice: trigger, targetLevel, targetLevelPrice: targetPrice,
      triggerOrder: stopPx, targetOrder: tickUp(targetPrice, s.tick), startedBelow: candle.close < stopPx,
    });
    // Entry: live-price cross above the trigger from below, during this reference's window. "Below" = under the first
    // tradable price above the trigger (stopPx); on the 0.05 grid that is the same as at/below the trigger.
    if (expirySkip) { checked.push("expiry day — no entry (rule)"); break; }
    let below = candle.close < stopPx;
    for (const bar of bars) {
      if (bar.t < end || bar.t >= windowEnd || (s.lastEntryTime > 0 && bar.t >= s.lastEntryTime)) continue;
      if (below && bar.open >= stopPx) { kind = "GAP_OPEN"; fill = bar.open; fillBar = bar; break; }
      if ((below || bar.open < stopPx) && bar.high >= stopPx) { kind = "INTRAMINUTE"; fill = s.fillModel === "worst" ? bar.high : stopPx; fillBar = bar; break; }
      if (!below && bar.open >= stopPx && bar.low < stopPx) {
        if (bar.close >= stopPx) { kind = "INTRAMINUTE_ARMED"; fill = s.fillModel === "worst" ? bar.high : stopPx; fillBar = bar; break; }
        if (s.ambiguousAsEntry) { kind = "AMBIGUOUS"; fill = s.fillModel === "worst" ? bar.high : stopPx; fillBar = bar; break; }
        result.ambiguousMinutes.push(bar.t);
      }
      below = bar.close < stopPx;
    }
    if (!fillBar) checked.push(`${label} ${direction}: no cross above Fib ${entryLevel} (${r2(trigger)}) ${clockOf(end)}–${clockOf(windowEnd)}`);
  }
  if (!result.direction && now >= s.squareOffTime) return { ...result, status: "NO_SETUP", note: checked.join("; ") || "No usable reference candle." };
  if (!fillBar) {
    const done = now >= s.squareOffTime;
    if (expirySkip) result.skipReason = "EXPIRY_DAY";
    return { ...result, status: done ? "NO_ENTRY" : "WAITING", note: done ? `NO ENTRY: ${checked.join("; ")}.${result.ambiguousMinutes.length ? ` ${result.ambiguousMinutes.length} ambiguous minute(s).` : ""}` : "Monitoring." };
  }
  const targetLevel = result.targetLevel!;
  const price = tickUp(fill + s.slippageTicks * s.tick, s.tick);
  // Minimum target (user, 17 Nov 2026): decided at the cross with the real buy price; too small → NO ENTRY for the day.
  if (s.minTargetPct > 0 && ((result.targetOrder! - price) / price) * 100 < s.minTargetPct) {
    return { ...result, status: "NO_ENTRY", skipReason: "SMALL_TARGET", note: `NO ENTRY: at ${clockOf(fillBar.t)} the buy price ${price} leaves the target ${result.targetOrder} only ${r2(((result.targetOrder! - price) / price) * 100)}% above (< ${s.minTargetPct}%).` };
  }
  // The sell order actually used: the Fib target, or a share of the way to it (research option).
  const range = result.reference ? result.reference.high - result.reference.low : 0;
  const exitTarget = s.targetRangeFraction > 0 ? Math.max(tickUp(price + s.targetRangeFraction * range, s.tick), r2(price + s.tick)) : s.targetFraction >= 1 ? result.targetOrder! : Math.max(tickUp(price + s.targetFraction * (result.targetOrder! - price), s.tick), r2(price + s.tick));
  const aboveTarget = s.targetRangeFraction > 0 ? false : price >= result.targetOrder!;
  result.exitTarget = exitTarget;
  result.entry = { time: fillBar.t, price, barOpen: fillBar.open, fill: kind, aboveTarget };

  // Exit: the resting target (same minute only after a GAP_OPEN fill), else the first price at/after the square-off.
  let maxHigh = price, minLow = price, last: MinuteBar | null = null;
  const through = s.targetFill === "trade-through" ? s.tick : 0;
  const firstExitBar = kind === "GAP_OPEN" ? fillBar.t : fillBar.t + 1;
  if (aboveTarget) {
    // The fill is already at/above the target: the resting sell executes at once (conservatively at the target price).
    result.exit = { time: fillBar.t + 1, price: result.targetOrder!, reason: "TARGET" };
  }
  let breakevenArmed = false;
  const breakevenTrigger = s.breakevenAfterFraction > 0 ? price + s.breakevenAfterFraction * (result.targetOrder! - price) : Infinity;
  for (const bar of bars) {
    if (result.exit) break;
    if (bar.t < fillBar.t) continue;
    if (bar.t >= s.squareOffTime) {
      result.exit = { time: bar.t, price: Math.max(s.tick, tickDown(bar.open - s.slippageTicks * s.tick, s.tick)), reason: "SQUARE_OFF", barPrice: bar.open };
      break;
    }
    if (bar.t >= firstExitBar) {
      // Time exit: at the first price once the trade is `maxHoldMinutes` old.
      if (s.maxHoldMinutes > 0 && bar.t >= fillBar.t + s.maxHoldMinutes) {
        result.exit = { time: bar.t, price: Math.max(s.tick, tickDown(bar.open - s.slippageTicks * s.tick, s.tick)), reason: "TIME_EXIT", barPrice: bar.open };
        break;
      }
      // Stop-loss: checked BEFORE the target in the same minute (conservative); filled at the stop or a lower open, minus slippage.
      const stop = s.stopLossPct > 0 ? r2(price * (1 - s.stopLossPct / 100)) : 0;
      if (stop > 0 && bar.low <= stop) {
        const at = Math.min(stop, bar.open);
        result.exit = { time: bar.t + 1, price: Math.max(s.tick, tickDown(at - s.slippageTicks * s.tick, s.tick)), reason: "STOP_LOSS", barPrice: at };
        break;
      }
      // Break-even stop: armed in an earlier minute, the price falls back to the entry.
      if (breakevenArmed && bar.low <= price) {
        const at = Math.min(price, bar.open);
        result.exit = { time: bar.t + 1, price: Math.max(s.tick, tickDown(at - s.slippageTicks * s.tick, s.tick)), reason: "BREAKEVEN", barPrice: at };
        break;
      }
      maxHigh = Math.max(maxHigh, bar.high);
      minLow = Math.min(minLow, bar.low);
      if ((s.targetFill === "touch" || (bar.volume ?? 1) > 0) && bar.high >= exitTarget + through - EPS) {
        result.exit = { time: bar.t + 1, price: exitTarget, reason: "TARGET" };
        break;
      }
      if (bar.high >= breakevenTrigger) breakevenArmed = true;
    }
    last = bar;
  }
  result.maxHigh = maxHigh;
  result.minLow = minLow;
  if (!result.exit) {
    if (now < s.squareOffTime + 1) return { ...result, status: "OPEN", note: "Position open." };
    if (!last) return { ...result, status: "NOT_EXECUTED", entry: null, note: "No premium after the entry: not counted." };
    // No candle at the square-off minute: the last known price before it.
    result.exit = { time: last.t + 1, price: Math.max(s.tick, tickDown(last.close - s.slippageTicks * s.tick, s.tick)), reason: "SQUARE_OFF", barPrice: last.close, stale: s.squareOffTime - (last.t + 1) > 10 };
  }
  return { ...result, status: "CLOSED", note: result.exit.reason === "TARGET" ? `Target Fib ${targetLevel} reached.` : result.exit.reason === "STOP_LOSS" ? `Stop-loss ${s.stopLossPct}% hit.` : result.exit.reason === "TIME_EXIT" ? `Time exit after ${s.maxHoldMinutes} min.` : result.exit.reason === "BREAKEVEN" ? "Break-even stop." : `Target not reached: squared off at ${clockOf(result.exit.time)}.` };
}
