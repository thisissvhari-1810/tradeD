/**
 * S1 — Automatic Previous-Day and Opening-Range Strategy.
 *
 * Step 1: a box from the previous completed session's low to high (its full range).
 * Step 2: that box moved vertically so its midpoint sits on the previous close (height unchanged).
 * Step 3: a clone of the step-2 box moved so its midpoint sits on the session's opening price.
 * Step 4: the first completed 1-minute candle's high and low as horizontal lines.
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
  /** The session's opening price: the open of its first 1-minute candle. Null until that candle exists. */
  open: number | null;
  firstMinute: S1FirstMinute | null;
};

export type S1Box = { top: number; bottom: number; mid: number };

export type S1Levels = {
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

export function s1Levels(previous: PreviousSession | null, open: number | null, firstMinute: S1FirstMinute | null): S1Levels | null {
  if (!previous || !valid(previous.high) || !valid(previous.low) || !valid(previous.close) || previous.high < previous.low) return null;
  const rawBox: S1Box = { top: previous.high, bottom: previous.low, mid: (previous.high + previous.low) / 2 };
  const closeBox = centreOn(rawBox, previous.close);
  const openBox = valid(open) ? centreOn(closeBox, open) : null;
  const openingRange = firstMinute && valid(firstMinute.high) && valid(firstMinute.low) && firstMinute.high >= firstMinute.low
    ? { time: firstMinute.time, high: firstMinute.high, low: firstMinute.low }
    : null;
  return { range: previous.high - previous.low, rawBox, closeBox, openBox, openingRange };
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
