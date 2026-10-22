/**
 * S1 — Automatic Previous-Day and Opening-Range Strategy.
 *
 * Step 1: a box from the previous completed session's low to high (its full range).
 * Step 2: that box moved vertically so its midpoint sits on the previous close (height unchanged).
 * Step 3: a clone of the step-2 box moved so its midpoint sits on the session's opening price.
 * Step 4: the 09:15 IST 1-minute candle's high and low as horizontal lines (never the 09:16 candle).
 *
 * Done as the manual drawing is done, in price space:
 *   original  = [previousLow, previousHigh], originalMid = (high + low) / 2
 *   shift1    = previousClose − originalMid      box 1 = original moved by shift1
 *   clone     = box 1,  shift2 = todayOpen − clone mid      box 2 = clone moved by shift2
 * Horizontally, box 1 spans from the session before the previous day to the current day (two daily
 * bars, centred on the previous candle) and box 2 is the same box one session to the right.
 */
import type { PreviousSession } from "@/lib/trading/replay-engine";

export type S1FirstMinute = { time: number; open: number; high: number; low: number };

/** What the server returns for one symbol and session date. Every price comes from exchange candles. */
export type S1Data = {
  symbol: string;
  /** The session the levels are for (IST date). */
  date: string;
  /** 09:15 and 15:30 IST of that date, in UTC seconds. */
  sessionOpen: number;
  sessionClose: number;
  /** ready: all four steps. waiting: session not open yet or first minute not complete. closed: no session that day. unavailable: data missing. */
  status: "ready" | "waiting" | "closed" | "unavailable";
  message: string;
  previous: PreviousSession | null;
  /** The session's opening price: its daily candle's open when the provider has it, else the 09:15 candle's open. */
  open: number | null;
  /** Where `open` came from. */
  openSource?: "daily" | "09:15" | null;
  /** The 09:15:00 IST 1-minute candle (time = its opening timestamp). Null if not returned or not finished. */
  firstMinute: S1FirstMinute | null;
  /** First 1-minute bar the provider returned for the session, for diagnosing a missing 09:15 bar. */
  firstBarTime?: number | null;
  /**
   * Daily-bar times (UTC seconds, the provider's daily stamps): the session before the previous day,
   * the previous day, the current day and one session after it. Box edges sit on these.
   */
  anchors?: { before: number; previous: number; day: number; after: number } | null;
};

export type S1Box = { top: number; bottom: number; mid: number };

export type S1Levels = {
  /** previousClose − originalMid: how far the original box moves to become box 1. */
  shift1: number;
  /** todayOpen − box 1 mid: how far the clone moves to become box 2. Null until the open is known. */
  shift2: number | null;
  /** Previous session's full range (high − low): the height of both boxes. */
  range: number;
  /** Step 1: the raw previous-day box. */
  rawBox: S1Box;
  /** Step 2: same height, midpoint on the previous close. */
  closeBox: S1Box;
  /** Step 3: same height, midpoint on the session open. Null until the open is known. */
  openBox: S1Box | null;
  /** Step 4: opening-range lines. Null until the first 1-minute candle is complete. */
  openingRange: { time: number; high: number; low: number } | null;
};

function valid(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Moves a box so its midpoint lands on `target`, keeping its height. */
export function centreOn(box: S1Box, target: number): S1Box {
  const shift = target - box.mid;
  return { top: box.top + shift, bottom: box.bottom + shift, mid: target };
}

/** Moves a box up or down by `shift` without changing its height. */
export function translate(box: S1Box, shift: number): S1Box {
  return { top: box.top + shift, bottom: box.bottom + shift, mid: (box.top + shift + box.bottom + shift) / 2 };
}

export function s1Levels(previous: PreviousSession | null, open: number | null, firstMinute: S1FirstMinute | null): S1Levels | null {
  if (!previous || !valid(previous.high) || !valid(previous.low) || !valid(previous.close) || previous.high < previous.low) return null;
  const range = previous.high - previous.low;
  // Step 1: the previous day's candle, high to low.
  const rawBox: S1Box = { top: previous.high, bottom: previous.low, mid: (previous.high + previous.low) / 2 };
  // Step 2: move that box so its midpoint is the previous close.
  const shift1 = previous.close - rawBox.mid;
  const closeBox = translate(rawBox, shift1);
  // Step 3: clone the moved box and move the clone so its midpoint is the open.
  const shift2 = valid(open) ? open - closeBox.mid : null;
  const openBox = shift2 != null ? translate({ ...closeBox }, shift2) : null;
  const openingRange = firstMinute && valid(firstMinute.high) && valid(firstMinute.low) && firstMinute.high >= firstMinute.low
    ? { time: firstMinute.time, high: firstMinute.high, low: firstMinute.low }
    : null;
  return { shift1, shift2, range, rawBox, closeBox, openBox, openingRange };
}

/**
 * The checks the levels must pass before anything is drawn. Returns the failures (empty when valid):
 * both boxes as tall as the previous range, centred on the close and the open, and the opening
 * candle stamped exactly at the session open.
 */
export function s1Checks(levels: S1Levels, previous: PreviousSession, open: number | null, sessionOpen: number) {
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9);
  const failures: string[] = [];
  const range = previous.high - previous.low;
  if (!close(levels.closeBox.top - levels.closeBox.bottom, range)) failures.push("Box 1 height differs from the previous range.");
  if (!close((levels.closeBox.top + levels.closeBox.bottom) / 2, previous.close)) failures.push("Box 1 midpoint is not the previous close.");
  if (levels.openBox && open != null) {
    if (!close(levels.openBox.top - levels.openBox.bottom, range)) failures.push("Box 2 height differs from the previous range.");
    if (!close((levels.openBox.top + levels.openBox.bottom) / 2, open)) failures.push("Box 2 midpoint is not the open.");
  }
  if (levels.openingRange && levels.openingRange.time !== sessionOpen) failures.push("The opening candle is not the 09:15 candle.");
  return failures;
}

/**
 * Which steps may be shown at a replay time, so nothing appears before it could have been known:
 * the open from 09:15, the opening-range lines once the first minute has finished. Live (cursor null) shows all.
 */
export function s1Reveal(data: Pick<S1Data, "sessionOpen">, levels: S1Levels, cursor: number | null) {
  return {
    openBox: levels.openBox != null && (cursor == null || cursor >= data.sessionOpen),
    openingRange: levels.openingRange != null && (cursor == null || cursor >= levels.openingRange.time + 60),
  };
}
