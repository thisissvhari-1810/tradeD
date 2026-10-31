import { describe, expect, it } from "vitest";
import { ALGO_STRATEGIES, isVariantStrategy, STRATEGY_NAME } from "../src/lib/algo/exclusive";
import { algoConfigProblems, readAlgoConfig } from "../src/lib/algo/config";
import {
  boxViolation, candleColor, directionOf, evaluatePair, HOURLY_SETTINGS_DEFAULTS, hourlyCandles, hourlyMidpointDecision, hourlySignal, longZone, oppositeOf, pairSchedule, positionBox, shortZone, skipViolation,
  type HourCandle,
} from "../src/lib/algo/hourly-zone";
import type { Candle } from "../src/lib/algo/lines";
import { createReplayAdapter, simulateSession, type ReplayChain } from "../src/lib/algo/replay-adapter";
import { advance, ALGO_DEFAULTS, initialState, lossLimit, MATHI_HOURLY_DEFAULTS, type AlgoConfig, type AlgoEvent, type AlgoState } from "../src/lib/algo/runner";
import { algoRequest } from "../src/lib/algo/request";
import { hourlyDrawings } from "../src/components/algo/algo-drawings";

/* Mathi Hourly Zone Strategy — 5%: the first two 1-hour NIFTY candles, ATM CALL / PUT, +5%, hourly midpoint exit. */

const DATE = "2026-10-26";
const OPEN = Date.UTC(2026, 9, 26, 3, 45) / 1000; // 09:15 IST
const HOUR = 3_600;
const hourStart = (index: number) => OPEN + index * HOUR;
const clock = (time: number) => new Date((time + 19_800) * 1000).toISOString().slice(11, 16);
const LOT = 65;
/** The rules as first written (no position box), for the tests of the zone, the pairs and the exits; the box is tested on its own. */
// The colour rules these tests were written for (the default strategy now takes CALL or PUT from the second candle's close).
const LEGACY = { ...HOURLY_SETTINGS_DEFAULTS, zoneMinPoints: 1, skipPart: "wick" as const, boxLongLowFree: true, boxCheck: "body" as const, maxRejectionWickPercent: 50, directionFrom: "color" as const, gapPoints: 0, longLowBelowBoxPoints: 10, referencePrice: "close" as const, boxMode: "wick" as const };
const RULES = { ...LEGACY, boxMode: "off" as const, referencePrice: "close" as const, skipPart: "off" as const };
const REPLAY: AlgoConfig = { ...MATHI_HOURLY_DEFAULTS, mode: "REPLAY", hourly: RULES };

type Shape = { open: number; close: number; high?: number; low?: number };

/** 60 one-minute candles for one hour: a straight walk from open to close, the hour's high at minute 20 and low at minute 40. */
function hourMinutes(index: number, shape: Shape): Candle[] {
  const list: Candle[] = [];
  let previous = shape.open;
  for (let minute = 0; minute < 60; minute += 1) {
    const close = shape.open + ((shape.close - shape.open) * (minute + 1)) / 60;
    const open = previous;
    let high = Math.max(open, close);
    let low = Math.min(open, close);
    if (minute === 20 && shape.high != null) high = Math.max(high, shape.high);
    if (minute === 40 && shape.low != null) low = Math.min(low, shape.low);
    list.push({ time: hourStart(index) + minute * 60, open, high, low, close });
    previous = close;
  }
  return list;
}

/** A session from hourly shapes (index 6 is the 15:15–15:30 remainder, 15 minutes). */
function session(shapes: Shape[]): Candle[] {
  return shapes.flatMap((shape, index) => hourMinutes(index, shape)).filter((candle) => candle.time < OPEN + 22_500);
}

/** NIFTY weekly strikes every 50; each option's premium moves 0.5 per NIFTY point from ₹100 at 23,990 (CE up, PE down). */
const CHAIN: ReplayChain = {
  symbol: "NIFTY", expiry: "2026-10-27", kind: "index", lotSize: LOT,
  strikes: Array.from({ length: 13 }, (_, index) => 23_700 + index * 50).map((strike) => ({ strike, ce: { securityId: `CE:${strike}` }, pe: { securityId: `PE:${strike}` } })),
};
const premium = (right: "CE" | "PE", spot: number) => Math.round((right === "CE" ? 100 + (spot - 23_990) * 0.5 : 100 - (spot - 23_990) * 0.5) * 100) / 100;
function tapes(candles: Candle[]) {
  return async (contract: { right: string }) => candles.map((candle) => {
    const right = contract.right === "PE" ? "PE" : "CE";
    const at = (spot: number) => premium(right, spot);
    const values = [at(candle.open), at(candle.high), at(candle.low), at(candle.close)];
    return { time: candle.time, open: values[0], high: Math.max(...values), low: Math.min(...values), close: values[3] };
  });
}

async function replay(candles: Candle[], config: AlgoConfig = REPLAY) {
  const adapter = createReplayAdapter({ candles, chain: CHAIN, config, capital: 100_000, tapeOf: tapes(candles) });
  return simulateSession({ sessionId: `${DATE}.hourly`, date: DATE, config, candles, lines: [], adapter, startNote: "test" });
}

const entries = (events: AlgoEvent[]) => events.filter((event) => event.kind === "ENTRY" && event.order?.status === "FILLED");
const exits = (events: AlgoEvent[]) => events.filter((event) => event.kind === "EXIT");

// Red 09:15 hour (ref 23,950), a 10:15 hour that stays above it and closes at 23,990 (LONG confirmed at 11:15).
const RED = { open: 24_000, close: 23_950, high: 24_010, low: 23_940 };
const HOLDS_ABOVE = { open: 23_955, close: 23_990, high: 23_995, low: 23_952 };
// 11:15 hour closes near its high (kept), 12:15 hour falls and closes in its lower half (midpoint exit at 13:15).
const UP_NO_TARGET = { open: 23_990, close: 23_997, high: 23_998, low: 23_985 };
const DOWN = { open: 23_997, close: 23_960, high: 23_999, low: 23_955 };
const FLAT = { open: 23_960, close: 23_961 };

describe("hourly candles on the 09:15 IST grid", () => {
  it("builds 09:15–10:15 and 10:15–11:15 from 1-minute candles; never a 10:00 or 11:00 boundary", () => {
    const candles = session([RED, HOLDS_ABOVE, UP_NO_TARGET]);
    const hours = hourlyCandles(candles, OPEN, hourStart(3));
    expect(hours.map((hour) => `${clock(hour.start)}–${clock(hour.end)}`)).toEqual(["09:15–10:15", "10:15–11:15", "11:15–12:15"]);
    expect(hours[0]).toMatchObject({ open: 24_000, close: 23_950, high: 24_010, low: 23_940, minutes: 60, complete: true });
    expect(hours[1]).toMatchObject({ open: 23_955, close: 23_990, complete: true });
  });

  it("does not use an incomplete candle: the 10:15 hour is not complete until its 11:14 minute has closed", () => {
    const candles = session([RED, HOLDS_ABOVE]);
    expect(hourlyCandles(candles, OPEN, hourStart(2) - 60)[1].complete).toBe(false);
    expect(hourlyCandles(candles, OPEN, hourStart(2))[1].complete).toBe(true);
  });
});

describe("1–2. no entry before the first two hourly candles are complete; the earliest entry is 11:15 IST", () => {
  it("gives no signal on any candle before 11:15 and one on the candle that completes the 10:15 hour", () => {
    const candles = session([RED, HOLDS_ABOVE, UP_NO_TARGET]);
    for (let index = 1; index < 120; index += 1) expect(hourlySignal(candles.slice(0, index), OPEN, RULES).signal).toBeNull();
    const decided = hourlySignal(candles.slice(0, 120), OPEN, RULES);
    expect(decided.signal).not.toBeNull();
    expect(clock(decided.signal!.time + 60)).toBe("11:15");
  });

  it("enters at 11:15 in the engine, and refuses settings that would enter earlier", async () => {
    const { events } = await replay(session([RED, HOLDS_ABOVE, UP_NO_TARGET, DOWN, FLAT, FLAT, FLAT]));
    expect(entries(events).map((event) => clock(event.time + 60))).toEqual(["11:15"]);
    expect(algoConfigProblems({ ...MATHI_HOURLY_DEFAULTS, entryStart: "11:00" }).join(" ")).toMatch(/before 11:15/);
    expect(algoConfigProblems(readAlgoConfig(JSON.parse(JSON.stringify(MATHI_HOURLY_DEFAULTS))))).toEqual([]);
  });
});

describe("3–4. candle colour → direction (options are only ever bought)", () => {
  it("maps red → LONG / ATM CALL, green → SHORT / ATM PUT, a doji → no direction", () => {
    expect(directionOf(candleColor({ open: 100, close: 90 }, 0))).toEqual({ direction: "LONG", side: "CALL" });
    expect(directionOf(candleColor({ open: 90, close: 100 }, 0))).toEqual({ direction: "SHORT", side: "PUT" });
    expect(candleColor({ open: 100, close: 100 }, 0)).toBe("DOJI");
    expect(candleColor({ open: 100, close: 100.5 }, 1)).toBe("DOJI");
    expect(directionOf("DOJI")).toBeNull();
  });

  it("buys the ATM CE after a red first candle and the ATM PE after a green one — never sells an option to open", async () => {
    const long = await replay(session([RED, HOLDS_ABOVE, UP_NO_TARGET, DOWN, FLAT, FLAT, FLAT]));
    expect(entries(long.events).map((event) => [event.side, event.contract?.right])).toEqual([["CALL", "CE"]]);
    const short = await replay(session([{ open: 23_950, close: 24_000, high: 24_010, low: 23_945 }, { open: 23_995, close: 23_960, high: 23_998, low: 23_955 }, { open: 23_960, close: 23_950, high: 23_965, low: 23_949 }, { open: 23_950, close: 23_990, high: 23_992, low: 23_948 }, FLAT, FLAT, FLAT]));
    expect(entries(short.events).map((event) => [event.side, event.contract?.right])).toEqual([["PUT", "PE"]]);
    // The exit sells the same bought option (a SELL of a long holding), never a fresh short.
    expect(exits(short.events)[0].contract?.right).toBe("PE");
  });
});

describe("5. the reference stays at the first candle's close", () => {
  it("never moves as later candles form", () => {
    const candles = session([RED, HOLDS_ABOVE, UP_NO_TARGET, DOWN, FLAT, FLAT]);
    for (const upTo of [60, 61, 90, 119, 120, 200, 300]) {
      const pair = hourlySignal(candles.slice(0, upTo), OPEN, RULES).state.pairs[0];
      expect(pair.reference).toBe(23_950);
    }
  });
});

describe("6. the second candle must close inside the configured zone (LONG and SHORT checked separately, symmetrically)", () => {
  const settings = { zoneMinPoints: 0, zoneMaxPoints: 0 };
  it("LONG: above the reference; SHORT: below it; exactly at it is outside both", () => {
    expect(longZone(101, 100, settings).ok).toBe(true);
    expect(longZone(100, 100, settings).ok).toBe(false);
    expect(longZone(99, 100, settings).ok).toBe(false);
    expect(shortZone(99, 100, settings).ok).toBe(true);
    expect(shortZone(100, 100, settings).ok).toBe(false);
    expect(shortZone(101, 100, settings).ok).toBe(false);
  });
  it("applies the configured minimum and maximum distance the same way on both sides", () => {
    const band = { zoneMinPoints: 5, zoneMaxPoints: 20 };
    for (const [distance, ok] of [[3, false], [4.95, false], [5, true], [20, true], [21, false]] as const) {
      expect(longZone(100 + distance, 100, band).ok).toBe(ok);
      expect(shortZone(100 - distance, 100, band).ok).toBe(ok);
    }
  });
  it("by default the 2nd candle must close at least 1 point past the drawn candle's close", () => {
    expect(LEGACY.zoneMinPoints).toBe(1);
    expect(longZone(23_950.95, 23_950, RULES).ok).toBe(false);
    expect(longZone(23_951, 23_950, RULES).ok).toBe(true);
    expect(shortZone(23_949.05, 23_950, RULES).ok).toBe(false);
    expect(shortZone(23_949, 23_950, RULES).ok).toBe(true);
    expect(longZone(23_952, 23_950, { zoneMinPoints: 2, zoneMaxPoints: 0 }).ok).toBe(true);
    expect(longZone(23_951.95, 23_950, { zoneMinPoints: 2, zoneMaxPoints: 0 }).ok).toBe(false);
    expect(longZone(23_960, 23_950, { zoneMinPoints: 10, zoneMaxPoints: 0 }).ok).toBe(true);
    expect(longZone(23_959.95, 23_950, { zoneMinPoints: 10, zoneMaxPoints: 0 }).ok).toBe(false);
    expect(longZone(23_950.5, 23_950, { zoneMinPoints: 0, zoneMaxPoints: 0 }).ok).toBe(true);
  });
  it("skips a red-first pair whose second candle closes below the reference", () => {
    const candles = session([RED, { open: 23_948, close: 23_930, high: 23_949, low: 23_925 }]);
    expect(hourlySignal(candles, OPEN, RULES).state.pairs[0]).toMatchObject({ status: "SKIPPED", direction: "LONG" });
  });
});

describe("7. invalid setups are skipped and logged with the exact OHLC values", () => {
  const first: HourCandle = { start: hourStart(0), end: hourStart(1), open: 24_000, high: 24_010, low: 23_940, close: 23_950, minutes: 60, complete: true };
  const dipping: HourCandle = { start: hourStart(1), end: hourStart(2), open: 23_955, high: 23_995, low: 23_945, close: 23_990, minutes: 60, complete: true };
  it("by default a LONG's wick may cross the mid by any amount; with the limit for both, 8 May 2026 (wick 30 points below) is skipped", () => {
    expect(LEGACY.skipPart).toBe("wick");
    const drawn = { ...first, open: 24_233.65, high: 24_253.8, low: 24_138.4, close: 24_211.3 };
    const next = { ...dipping, open: 24_213.8, high: 24_243.95, low: 24_181.25, close: 24_233 };
    expect(evaluatePair(drawn, next, { ...LEGACY, boxMode: "off" }).status).toBe("CONFIRMED");
    const may8 = evaluatePair(drawn, next, { ...LEGACY, boxMode: "off", skipPart: "wick", skipWickFor: "both" });
    expect(may8.status).toBe("SKIPPED");
    expect(may8.reasons.join(" ")).toMatch(/broke the wick rule: its wick reaches 24181\.25, 30\.05 points below the LONG reference 24211\.30 \(more than 4\.00\)/);
  });
  it("by default a SHORT's upper wick may go at most 4 points above the mid (21 Sep 2026: 6.55 → skipped)", () => {
    const green = { ...first, open: 23_397.65, high: 23_434.05, low: 23_385.8, close: 23_417.7 };
    const next = { ...dipping, open: 23_417.55, high: 23_424.25, low: 23_397.65, close: 23_409.2 };
    const rules = { ...LEGACY, boxMode: "off" as const };
    expect(evaluatePair(green, next, rules).reasons.join(" ")).toMatch(/its wick reaches 23424\.25, 6\.55 points above the SHORT reference 23417\.70 \(more than 4\.00\)/);
    expect(evaluatePair(green, { ...next, high: 23_421.7 }, rules).status).toBe("CONFIRMED");
  });
  it("a wick limit of 20 points (the default is 4, for SHORT only); the body never", () => {
    expect(LEGACY.skipWickPoints).toBe(4);
    expect(LEGACY.skipWickFor).toBe("short");
    const twenty = { skipPart: "wick" as const, skipSide: "against" as const, skipWickPoints: 20, skipWickFor: "both" as const };
    expect(skipViolation("LONG", { open: 105, high: 121, low: 80, close: 120 }, 100, twenty)).toBeNull();
    expect(skipViolation("LONG", { open: 105, high: 121, low: 79.95, close: 120 }, 100, twenty)).toMatch(/20\.05 points below/);
    expect(skipViolation("SHORT", { open: 95, high: 120, low: 79, close: 80 }, 100, twenty)).toBeNull();
    expect(skipViolation("SHORT", { open: 95, high: 121, low: 79, close: 80 }, 100, twenty)).toMatch(/21\.00 points above/);
    expect(skipViolation("LONG", { open: 99, high: 121, low: 98, close: 120 }, 100, twenty)).toMatch(/its body reaches 99\.00/);
    // SHORT only (the default): a LONG's wick may go any distance below the mid; its body still may not.
    const shortOnly = { ...twenty, skipWickFor: "short" as const };
    expect(skipViolation("LONG", { open: 105, high: 121, low: 40, close: 120 }, 100, shortOnly)).toBeNull();
    expect(skipViolation("LONG", { open: 99, high: 121, low: 40, close: 120 }, 100, shortOnly)).toMatch(/its body reaches 99\.00/);
    expect(skipViolation("SHORT", { open: 95, high: 121, low: 79, close: 80 }, 100, shortOnly)).toMatch(/21\.00 points above/);
  });
  it("or by a share of the wick (80% here)", () => {
    const rule = { skipPart: "wick" as const, skipSide: "against" as const, skipWickPercent: 80 };
    // LONG mid 100: body 105–120, lower wick to 90 (15 long, 10 below = 67%): allowed; to 101: not crossing at all.
    expect(skipViolation("LONG", { open: 105, high: 121, low: 90, close: 120 }, 100, rule)).toBeNull();
    expect(skipViolation("LONG", { open: 105, high: 121, low: 101, close: 120 }, 100, rule)).toBeNull();
    // to 85 (20 long, 15 below = 75%): allowed; to 80 (25 long, 20 below = 80%): allowed; to 79 (26 long, 21 below = 81%): skipped.
    expect(skipViolation("LONG", { open: 105, high: 121, low: 80, close: 120 }, 100, rule)).toBeNull();
    expect(skipViolation("LONG", { open: 105, high: 121, low: 79, close: 120 }, 100, rule)).toMatch(/81% of its lower wick/);
    // SHORT mirror: mid 100, body 80–95, upper wick to 125 (30 long, 25 above = 83%): skipped.
    expect(skipViolation("SHORT", { open: 95, high: 125, low: 79, close: 80 }, 100, rule)).toMatch(/83% of its upper wick/);
    // A body across the mid is always skipped.
    expect(skipViolation("LONG", { open: 99, high: 121, low: 98, close: 120 }, 100, rule)).toMatch(/its body reaches 99\.00/);
  });
  it("with the body rule, the 2nd candle's body must not cross the mid; its wick may", () => {
    const rules = { ...LEGACY, boxMode: "off" as const, skipPart: "body" as const };
    expect(evaluatePair(first, dipping, rules)).toMatchObject({ status: "CONFIRMED", side: "CALL" });
    // 16 Apr 2026: opened at 24,306.15, 1.45 points below the 24,307.60 mid, and closed above it.
    const red = { ...first, open: 24_385.2, high: 24_400.95, low: 24_264.4, close: 24_307.6 };
    const crossing = { ...dipping, open: 24_306.15, high: 24_333.2, low: 24_292.45, close: 24_313.9 };
    // By default the body may not cross at all: skipped. With a 2-point allowance it is a trade; 2.05 points is not.
    expect(LEGACY.bodyCrossPoints).toBe(0);
    expect(evaluatePair(red, crossing, rules).status).toBe("SKIPPED");
    expect(evaluatePair(red, crossing, { ...rules, bodyCrossPoints: 2 }).status).toBe("CONFIRMED");
    expect(evaluatePair(red, { ...crossing, open: 24_305.55 }, { ...rules, bodyCrossPoints: 2 }).reasons.join(" ")).toMatch(/its body reaches 24305\.55, 2\.05 points below the LONG reference 24307\.60 \(more than the 2\.00 points allowed\)/);
    const pair = evaluatePair(red, crossing, { ...rules, bodyCrossPoints: 0 });
    expect(pair.status).toBe("SKIPPED");
    expect(pair.reasons.join(" ")).toMatch(/broke the body rule: its body reaches 24306\.15, 1\.45 points below the LONG reference 24307\.60/);
  });
  it("the optional wick rule (second candle may not trade into the losing side) skips; the body rule does not", () => {
    const wick = { ...RULES, skipPart: "wick" as const, skipWickPercent: 0, skipWickPoints: 0, skipWickFor: "both" as const };
    expect(evaluatePair(first, dipping, wick)).toMatchObject({ status: "SKIPPED" });
    expect(evaluatePair(first, dipping, wick).reasons.join(" ")).toMatch(/broke the wick rule: its wick reaches 23945\.00, 5\.00 points below the LONG reference 23950\.00/);
    expect(evaluatePair(first, dipping, { ...RULES, skipPart: "body" }).status).toBe("CONFIRMED");
  });
  it("is configurable literally: 'above' on the first candle skips a red first candle whose body is above its close", () => {
    expect(skipViolation("LONG", first, 23_950, { skipPart: "body", skipSide: "above" })).toMatch(/above the LONG reference/);
    expect(skipViolation("LONG", first, 23_950, { skipPart: "body", skipSide: "against" })).toBeNull();
    expect(skipViolation("SHORT", { open: 23_950, high: 24_010, low: 23_945, close: 24_000 }, 24_000, { skipPart: "wick", skipSide: "against" })).toMatch(/above the SHORT reference/);
  });
  it("logs the skipped pair as REJECTED once, with every reason and both candles' OHLC", async () => {
    const candles = session([RED, { open: 23_948, close: 23_930, high: 23_952, low: 23_925 }, FLAT, FLAT, FLAT, FLAT, FLAT]);
    const { events } = await replay(candles);
    // The first pair is skipped at 11:15 (logged once); the flat 11:15 + 12:15 pair is skipped later, on its own.
    const skipped = events.filter((event) => event.kind === "REJECTED" && /SKIPPED/.test(event.message) && clock(event.time + 60) === "11:15");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reasons?.join(" ")).toMatch(/O 24000\.00 H 24010\.00 L 23940\.00 C 23950\.00/);
    expect(skipped[0].reasons?.join(" ")).toMatch(/O 23948\.00 H 23952\.00 L 23925\.00 C 23930\.00/);
    expect(skipped[0].reasons?.join(" ")).toMatch(/closed outside the LONG zone/);
    expect(entries(events).filter((event) => clock(event.time + 60) === "11:15")).toHaveLength(0);
  });
});

describe("8. a skipped pair hands over to the next pair, under the same rules", () => {
  it("schedules 09:15+10:15, 11:15+12:15, 13:15+14:15 (next) or every following hour (sliding)", () => {
    expect(pairSchedule("next")).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(pairSchedule("sliding")).toEqual([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]);
  });
  const afterSkip = () => session([
    RED, { open: 23_948, close: 23_930, high: 23_952, low: 23_925 }, // 09:15 + 10:15 skipped: closes below 23,950; 10:15 is red (LONG ref 23,930)
    { open: 23_990, close: 23_970, high: 23_995, low: 23_965 }, // 11:15 closes above 23,930: the 10:15 + 11:15 pair is confirmed at 12:15
    { open: 23_972, close: 23_985, high: 23_988, low: 23_971 },
    { open: 23_985, close: 23_995, high: 23_996, low: 23_984 }, FLAT, FLAT,
  ]);
  it("by default moves one hour: the 10:15 + 11:15 pair, traded at 12:15", async () => {
    expect(LEGACY.pairStep).toBe("sliding");
    const { events, state } = await replay(afterSkip());
    expect(entries(events).map((event) => [clock(event.time + 60), event.side, event.setup?.level])).toEqual([["12:15", "CALL", 23_930]]);
    expect(state.analysis?.hourly?.pairs.slice(0, 2).map((pair) => [clock(pair.first.start), pair.status])).toEqual([["09:15", "SKIPPED"], ["10:15", "CONFIRMED"]]);
  });
  it("with 'next two hours' it waits for the 11:15 + 12:15 pair and trades at 13:15", async () => {
    const config: AlgoConfig = { ...REPLAY, hourly: { ...RULES, pairStep: "next" } };
    const { events } = await replay(afterSkip(), config);
    expect(entries(events).map((event) => [clock(event.time + 60), event.side, event.setup?.level])).toEqual([["13:15", "CALL", 23_970]]);
  });
});

describe("the position box: the 2nd candle's body and wick must stay inside it", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  const box = { ...RULES, boxMode: "range" as const, boxSize: 0.618, boxCheck: "wick" as const };
  it("builds the box the same distance above and below the reference", () => {
    expect(positionBox({ high: 24_100, low: 23_900 }, 23_900, box)).toEqual({ top: 24_023.6, bottom: 23_776.4, height: 123.6 });
    expect(positionBox({ high: 24_100, low: 23_900 }, 23_900, { boxMode: "points", boxSize: 50 })).toEqual({ top: 23_950, bottom: 23_850, height: 50 });
    expect(positionBox({ high: 24_100, low: 23_900 }, 23_900, { boxMode: "off", boxSize: 50 })).toBeNull();
    expect(boxViolation({ high: 23_960, low: 23_820 }, { top: 24_023.6, bottom: 23_776.4 })).toBeNull();
  });
  it("28 Oct chart: a red 1st candle; the 2nd candle's wick goes into the red zone but stays in the box and it closes above the mid → CALL", () => {
    const pair = evaluatePair(hour(0, { open: 24_100, high: 24_100, low: 23_900, close: 23_900 }), hour(1, { open: 23_905, high: 23_960, low: 23_820, close: 23_940 }), box);
    expect(pair).toMatchObject({ status: "CONFIRMED", direction: "LONG", side: "CALL", box: { top: 24_023.6, bottom: 23_776.4 } });
  });
  it("31st chart: the 2nd candle closes on the right side but its body and wick go out of the box → skipped", () => {
    const pair = evaluatePair(hour(0, { open: 23_880, high: 24_050, low: 23_770, close: 23_900 }), hour(1, { open: 23_895, high: 23_898, low: 23_650, close: 23_690 }), box);
    expect(pair).toMatchObject({ status: "SKIPPED", direction: "SHORT" });
    expect(pair.reasons.join(" ")).toMatch(/went out of the position box: its low 23650\.00 is below the box bottom 23726\.96/);
  });
  it("by default only the 2nd candle's body counts: it must stay inside the box and on the trade side; wicks are ignored", () => {
    expect(LEGACY.boxCheck).toBe("body");
    const points = { ...LEGACY, boxMode: "points" as const, boxSize: 50, skipPart: "body" as const, maxRejectionWickPercent: 0, longLowBelowBoxPoints: -1 };
    const drawnRed = hour(0, { open: 24_000, high: 24_000, low: 23_900, close: 23_900 });
    const drawnGreen = hour(0, { open: 23_900, high: 24_000, low: 23_900, close: 24_000 });
    // LONG mid 23,900, box 23,850–23,950: wicks to 23,990 and 23,700 are ignored; the body 23,905–23,940 is inside.
    expect(evaluatePair(drawnRed, hour(1, { open: 23_905, high: 23_990, low: 23_700, close: 23_940 }), points).status).toBe("CONFIRMED");
    // The body above the box top (close 23,960) is not.
    expect(evaluatePair(drawnRed, hour(1, { open: 23_905, high: 23_965, low: 23_890, close: 23_960 }), points).reasons.join(" ")).toMatch(/body went out of the position box: its body top 23960\.00 is above the box top 23950\.00/);
    // SHORT mid 24,000, box 23,950–24,050: an upper wick to 24,080 is ignored; the body 23,995–23,960 is inside.
    expect(evaluatePair(drawnGreen, hour(1, { open: 23_995, high: 24_080, low: 23_955, close: 23_960 }), points).status).toBe("CONFIRMED");
  });
  it("by default a LONG's lower wick may go below the box; its top and a SHORT's box are still checked", () => {
    expect(LEGACY.boxLongLowFree).toBe(true);
    const points = { ...LEGACY, boxMode: "points" as const, boxSize: 50, boxCheck: "wick" as const, longLowBelowBoxPoints: -1 };
    const drawnRed = hour(0, { open: 24_000, high: 24_000, low: 23_900, close: 23_900 });
    // LONG mid 23,900, box 23,850–23,950: the next candle's low 23,800 is below the box → still a trade.
    expect(evaluatePair(drawnRed, hour(1, { open: 23_905, high: 23_940, low: 23_800, close: 23_930 }), points).status).toBe("CONFIRMED");
    // ... but its high 23,960 above the box top is not.
    expect(evaluatePair(drawnRed, hour(1, { open: 23_905, high: 23_960, low: 23_890, close: 23_930 }), points).reasons.join(" ")).toMatch(/above the box top 23950\.00/);
    // With it off, the low below the box skips.
    expect(evaluatePair(drawnRed, hour(1, { open: 23_905, high: 23_940, low: 23_800, close: 23_930 }), { ...points, boxLongLowFree: false }).status).toBe("SKIPPED");
  });
  it("is symmetric for LONG and SHORT; the candle-wick box is the default", () => {
    expect(LEGACY.boxMode).toBe("wick");
    const long = evaluatePair(hour(0, { open: 24_000, high: 24_000, low: 23_900, close: 23_900 }), hour(1, { open: 23_905, high: 23_990, low: 23_895, close: 23_980 }), { ...RULES, boxMode: "points", boxSize: 50, boxCheck: "wick" });
    const short = evaluatePair(hour(0, { open: 23_900, high: 24_000, low: 23_900, close: 24_000 }), hour(1, { open: 23_995, high: 24_005, low: 23_910, close: 23_920 }), { ...RULES, boxMode: "points", boxSize: 50, boxCheck: "wick" });
    expect(long.reasons.join(" ")).toMatch(/high 23990\.00 is above the box top 23950\.00/);
    expect(short.reasons.join(" ")).toMatch(/low 23910\.00 is below the box bottom 23950\.00/);
  });
});

describe("optional box stop (a TradingView-style red edge)", () => {
  const boxed = (stop: boolean): AlgoConfig => ({ ...REPLAY, hourly: { ...RULES, boxMode: "points", boxSize: 60, boxStop: stop } });
  // Box 23,890–24,010 on the 23,950 reference; the 11:15 hour falls through the 23,890 red edge before it closes.
  const falling = () => session([RED, HOLDS_ABOVE, { open: 23_990, close: 23_880, high: 23_992, low: 23_878 }, FLAT, FLAT, FLAT, FLAT]);
  it("closes the CALL once a 1-minute NIFTY close is below the box bottom, before the hour ends", async () => {
    const { events, state } = await replay(falling(), boxed(true));
    const exit = exits(events)[0];
    expect(exit.message).toMatch(/^Exit \(BOX_STOP\).*below the box bottom 23890\.00/);
    expect(exit.time).toBeLessThan(hourStart(3));
    expect(state.hourly?.trades[0].status).toBe("BOX STOP");
  });
  it("is off by default: the same trade waits for the hour's close (midpoint exit at 12:15)", async () => {
    expect(LEGACY.boxStop).toBe(false);
    const exit = exits((await replay(falling(), boxed(false))).events)[0];
    expect(exit.message).toMatch(/^Exit \(MIDPOINT\)/);
    expect(clock(exit.time)).toBe("12:15");
    expect(algoConfigProblems({ ...MATHI_HOURLY_DEFAULTS, hourly: { ...RULES, boxStop: true } }).join(" ")).toMatch(/box stop needs a position box/);
  });
});

describe("box exits only (TradingView position: green edge target, red edge stop)", () => {
  const boxOnly: AlgoConfig = { ...REPLAY, target: { mode: "percent", value: 1_000 }, hourly: { ...RULES, boxMode: "points", boxSize: 60, boxStop: true, boxTarget: true, midpointExit: false } };
  it("sells the CALL when NIFTY reaches the green edge (24,010 on the 23,950 mid)", async () => {
    const { events, state } = await replay(session([RED, HOLDS_ABOVE, { open: 23_990, close: 24_015, high: 24_016, low: 23_988 }, FLAT, FLAT, FLAT, FLAT]), boxOnly);
    const exit = exits(events)[0];
    expect(exit.message).toMatch(/^Exit \(BOX_TARGET\).*at or above the box top 24010\.00/);
    expect(exit.time).toBeLessThan(hourStart(3));
    expect(state.hourly?.trades[0].status).toBe("BOX TARGET");
  });
  it("with the midpoint exit off, a weak hour does not close the trade; the red edge or 15:20 does", async () => {
    const { events } = await replay(session([RED, HOLDS_ABOVE, DOWN, FLAT, FLAT, FLAT, FLAT]), boxOnly);
    expect(exits(events)[0].message).toMatch(/^Exit \((BOX_STOP|SQUARE_OFF)\)/);
    expect(events.some((event) => /Hourly midpoint/.test(event.message))).toBe(false);
  });
});

describe("candle-wick box: the stop at the drawn candle's own low (LONG) / high (SHORT), the target 1 : 1", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  const wick = { ...RULES, boxMode: "wick" as const };
  it("red drawn candle → LONG: stop at its low, target the same distance above its close", () => {
    expect(positionBox({ high: 24_010, low: 23_920 }, 23_950, wick, "LONG")).toEqual({ top: 23_980, bottom: 23_920, height: 30 });
  });
  it("green drawn candle → SHORT: stop at its high, target the same distance below its close", () => {
    expect(positionBox({ high: 25_834, low: 25_770 }, 25_798.15, wick, "SHORT")).toEqual({ top: 25_834, bottom: 25_762.3, height: 35.85 });
  });
  it("with a minimum, a small wick is widened to it (and a big wick is kept)", () => {
    expect(positionBox({ high: 24_010, low: 23_940 }, 23_950, { ...wick, boxMinPoints: 30 }, "LONG")).toEqual({ top: 23_980, bottom: 23_920, height: 30 });
    expect(positionBox({ high: 24_010, low: 23_900 }, 23_950, { ...wick, boxMinPoints: 30 }, "LONG")).toEqual({ top: 24_000, bottom: 23_900, height: 50 });
    expect(positionBox({ high: 23_950, low: 23_900 }, 23_950, { ...wick, boxMinPoints: 30 }, "SHORT")).toEqual({ top: 23_980, bottom: 23_920, height: 30 });
  });
  it("a drawn candle with no wick on its stop side uses its body (open to close) for the box", () => {
    // Green, closed at its high (no upper wick): SHORT box = the 100-point body above and below the close.
    expect(positionBox({ open: 23_900, high: 24_000, low: 23_900, close: 24_000 }, 24_000, wick, "SHORT")).toEqual({ top: 24_100, bottom: 23_900, height: 100 });
    // Red, closed at its low (no lower wick): LONG box = the 50-point body.
    expect(positionBox({ open: 24_000, high: 24_010, low: 23_950, close: 23_950 }, 23_950, wick, "LONG")).toEqual({ top: 24_000, bottom: 23_900, height: 50 });
    const pair = evaluatePair(hour(0, { open: 23_900, high: 24_000, low: 23_900, close: 24_000 }), hour(1, { open: 23_995, high: 23_998, low: 23_960, close: 23_970 }), wick);
    expect(pair).toMatchObject({ status: "CONFIRMED", box: { top: 24_100, bottom: 23_900 } });
  });
  it("with the box skip off, the box only sets the exits", () => {
    const first = hour(0, { open: 24_000, high: 24_010, low: 23_920, close: 23_950 });
    const second = hour(1, { open: 23_955, high: 23_995, low: 23_952, close: 23_990 });
    expect(evaluatePair(first, second, wick).status).toBe("SKIPPED");
    expect(evaluatePair(first, second, { ...wick, boxSkip: false })).toMatchObject({ status: "CONFIRMED", box: { top: 23_980, bottom: 23_920 } });
  });
});

describe("the position's entry (mid): the drawn candle's close by default, or its open", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  it("default (close) on 16 Oct 2026 09:15: entry 23,094.30, stop at the high 23,094.70 = 8 ticks", () => {
    const pair = evaluatePair(hour(0, { open: 23_065.1, high: 23_094.7, low: 22_913.8, close: 23_094.3 }), null, LEGACY);
    expect(pair).toMatchObject({ direction: "SHORT", reference: 23_094.3, box: { top: 23_094.7, bottom: 23_093.9 } });
    expect(Math.round((pair.box!.top - pair.reference) * 20)).toBe(8);
  });
  it("at the open, 16 Oct 2026 09:15 (green → SHORT): entry 23,065.10 (open), stop at the high 23,094.70 = 29.60 points = 592 ticks, target 23,035.50", () => {
    expect(LEGACY.referencePrice).toBe("close");
    const atOpen = { ...LEGACY, referencePrice: "open" as const, skipPart: "body" as const };
    const pair = evaluatePair(hour(0, { open: 23_065.1, high: 23_094.7, low: 22_913.8, close: 23_094.3 }), hour(1, { open: 23_062, high: 23_094.5, low: 23_050, close: 23_060 }), atOpen);
    expect(pair).toMatchObject({ direction: "SHORT", reference: 23_065.1, box: { top: 23_094.7, bottom: 23_035.5 }, status: "CONFIRMED" });
    expect(Math.round((pair.box!.top - pair.reference) * 20)).toBe(592);
  });
  it("at the open, the next candle must close at least 2 points past the open: a red 1st candle needs a close 2 points above its open", () => {
    const first = hour(0, { open: 24_000, high: 24_010, low: 23_920, close: 23_950 });
    const atOpen = { ...LEGACY, referencePrice: "open" as const, skipPart: "body" as const };
    expect(evaluatePair(first, hour(1, { open: 23_950, high: 24_002, low: 23_945, close: 24_001 }), atOpen).status).toBe("SKIPPED");
    expect(evaluatePair(first, hour(1, { open: 24_001, high: 24_003, low: 23_945, close: 24_002 }), atOpen)).toMatchObject({ status: "CONFIRMED", reference: 24_000, box: { bottom: 23_920, top: 24_080 } });
  });
});

describe("rejection filter: the next candle's profit-side wick as a share of its range", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  const settings = { ...RULES, maxRejectionWickPercent: 30 };
  const red = hour(0, { open: 24_000, high: 24_010, low: 23_890, close: 23_900 });
  it("skips a LONG whose next candle's upper wick is more than 30% of the candle (28 Sep 2026 shape: 88%)", () => {
    // Range 100: body 23,905–23,915, upper wick to 24,000 (85 = 85%).
    const pair = evaluatePair(red, hour(1, { open: 23_905, high: 24_000, low: 23_900, close: 23_915 }), settings);
    expect(pair.status).toBe("SKIPPED");
    expect(pair.reasons.join(" ")).toMatch(/upper wick \(85\.00 of 100\.00 points, 85%\) is a rejection: more than 30%/);
  });
  it("keeps one at 30% or less, and mirrors it for a SHORT's lower wick", () => {
    expect(evaluatePair(red, hour(1, { open: 23_905, high: 23_975, low: 23_900, close: 23_960 }), settings).status).toBe("CONFIRMED");
    const green = hour(0, { open: 23_900, high: 24_010, low: 23_890, close: 24_000 });
    expect(evaluatePair(green, hour(1, { open: 23_995, high: 24_000, low: 23_900, close: 23_985 }), settings).reasons.join(" ")).toMatch(/lower wick .* is a rejection/);
    expect(LEGACY.maxRejectionWickPercent).toBe(50);
  });
});

describe("LONG: the next candle's low may break the box bottom by at most 10 points", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  // Red drawn candle, mid 23,900, low 23,850 → box 23,850–23,950.
  const red = hour(0, { open: 23_990, high: 23_995, low: 23_850, close: 23_900 });
  const settings = { ...LEGACY, maxRejectionWickPercent: 0 };
  it("allows a low 10 points below the box bottom and skips one 10.05 points below", () => {
    expect(LEGACY.longLowBelowBoxPoints).toBe(10);
    expect(evaluatePair(red, hour(1, { open: 23_905, high: 23_935, low: 23_840, close: 23_930 }), settings).status).toBe("CONFIRMED");
    const skipped = evaluatePair(red, hour(1, { open: 23_905, high: 23_935, low: 23_839.95, close: 23_930 }), settings);
    expect(skipped.status).toBe("SKIPPED");
    expect(skipped.reasons.join(" ")).toMatch(/low 23839\.95 is 10\.05 points below the box bottom 23850\.00 \(more than 10\.00\)/);
    expect(evaluatePair(red, hour(1, { open: 23_905, high: 23_935, low: 23_700, close: 23_930 }), { ...settings, longLowBelowBoxPoints: -1 }).status).toBe("CONFIRMED");
  });
});

describe("loss-side wick filter: the next candle's losing-side wick as a share of its range", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  const settings = { ...RULES, maxLossWickPercent: 30 };
  it("skips a LONG whose next candle's lower wick is more than 30% of the candle and keeps one at 30%", () => {
    const red = hour(0, { open: 24_000, high: 24_010, low: 23_890, close: 23_900 });
    // Range 100: body 23,940–23,990, lower wick 40 (40%).
    const pair = evaluatePair(red, hour(1, { open: 23_940, high: 24_000, low: 23_900, close: 23_990 }), settings);
    expect(pair.status).toBe("SKIPPED");
    expect(pair.reasons.join(" ")).toMatch(/lower wick \(40\.00 of 100\.00 points, 40%\) is more than 30% of the candle/);
    expect(evaluatePair(red, hour(1, { open: 23_930, high: 24_000, low: 23_900, close: 23_990 }), settings).status).toBe("CONFIRMED");
  });
  it("mirrors it for a SHORT's upper wick and is off by default", () => {
    const green = hour(0, { open: 23_900, high: 24_010, low: 23_890, close: 24_000 });
    expect(evaluatePair(green, hour(1, { open: 23_960, high: 24_000, low: 23_900, close: 23_910 }), settings).reasons.join(" ")).toMatch(/upper wick .* is more than 30%/);
    expect(LEGACY.maxLossWickPercent).toBe(0);
  });
});

describe("strong-candle filter: the next candle's body as a share of its range", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  const settings = { ...RULES, minSecondBodyPercent: 40, maxRejectionWickPercent: 0 };
  const red = hour(0, { open: 24_000, high: 24_010, low: 23_890, close: 23_900 });
  it("skips a next candle whose body is less than 40% of its range and keeps one at 40%", () => {
    // Range 100 (23,900–24,000): body 23,905–23,935 = 30%.
    const pair = evaluatePair(red, hour(1, { open: 23_905, high: 24_000, low: 23_900, close: 23_935 }), settings);
    expect(pair.status).toBe("SKIPPED");
    expect(pair.reasons.join(" ")).toMatch(/body \(30\.00 of 100\.00 points, 30%\) is less than 40% of the candle/);
    expect(evaluatePair(red, hour(1, { open: 23_905, high: 24_000, low: 23_900, close: 23_945 }), settings).status).toBe("CONFIRMED");
    expect(LEGACY.minSecondBodyPercent).toBe(0);
  });
});

describe("opposite trade when a pair fails", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  const red = hour(0, { open: 24_000, high: 24_010, low: 23_890, close: 23_900 });
  const settings = { ...RULES, maxRejectionWickPercent: 0 };
  it("wrongSide: a LONG setup whose next candle closes below the mid buys a PUT; one failing another rule does not", () => {
    const wrong = evaluatePair(red, hour(1, { open: 23_895, high: 23_898, low: 23_850, close: 23_860 }), settings);
    expect(wrong.status).toBe("SKIPPED");
    expect(oppositeOf(wrong, { ...settings, oppositeOnFail: "wrongSide" })).toEqual({ direction: "SHORT", side: "PUT" });
    const body = evaluatePair(red, hour(1, { open: 23_905, high: 24_000, low: 23_900, close: 23_935 }), { ...settings, minSecondBodyPercent: 40 });
    expect(body.status).toBe("SKIPPED");
    expect(oppositeOf(body, { ...settings, oppositeOnFail: "wrongSide" })).toBeNull();
    expect(oppositeOf(body, { ...settings, oppositeOnFail: "anyRule" })).toEqual({ direction: "SHORT", side: "PUT" });
    expect(oppositeOf(wrong, settings)).toBeNull();
    expect(LEGACY.oppositeOnFail).toBe("off");
  });
});

describe("direction from the second candle's close (the drawn candle's colour not used)", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  const settings = { ...RULES, maxRejectionWickPercent: 0, directionFrom: "close" as const, zoneMinPoints: 0 };
  const red = hour(0, { open: 24_000, high: 24_010, low: 23_890, close: 23_900 });
  const green = hour(0, { open: 23_900, high: 24_010, low: 23_890, close: 24_000 });
  it("a close above the mid is a CALL and below it a PUT, whatever the drawn candle's colour", () => {
    const up = evaluatePair(green, hour(1, { open: 24_001, high: 24_040, low: 23_995, close: 24_030 }), settings);
    expect([up.status, up.direction, up.side]).toEqual(["CONFIRMED", "LONG", "CALL"]);
    const down = evaluatePair(red, hour(1, { open: 23_899, high: 23_905, low: 23_850, close: 23_860 }), settings);
    expect([down.status, down.direction, down.side]).toEqual(["CONFIRMED", "SHORT", "PUT"]);
  });
  it("a close exactly on the mid is no trade, and the pair waits until the second candle closes", () => {
    const flat = evaluatePair(red, hour(1, { open: 23_905, high: 23_930, low: 23_880, close: 23_900 }), settings);
    expect(flat.status).toBe("SKIPPED");
    expect(flat.reasons.join(" ")).toMatch(/closed exactly on the mid 23900\.00/);
    expect(evaluatePair(red, null, settings).status).toBe("WAITING");
    expect(LEGACY.directionFrom).toBe("color");
  });
});

describe("the default strategy: the position tool from the drawn candle, the trade from the second candle's side", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  // Red drawn: Long position, mid 24,000 (its close). Green drawn: Short position, mid 24,000 (its close).
  const red = hour(0, { open: 24_080, high: 24_090, low: 23_900, close: 24_000 });
  const green = hour(0, { open: 23_920, high: 24_100, low: 23_910, close: 24_000 });
  const above = hour(1, { open: 24_002, high: 24_060, low: 23_990, close: 24_050 });
  const below = hour(1, { open: 23_998, high: 24_010, low: 23_940, close: 23_950 });
  const trade = (drawn: HourCandle, next: HourCandle) => { const pair = evaluatePair(drawn, next, HOURLY_SETTINGS_DEFAULTS); return [pair.status, pair.side]; };
  it("has those defaults", () => {
    expect(HOURLY_SETTINGS_DEFAULTS).toMatchObject({ referencePrice: "close", directionFrom: "position", boxMode: "off", skipPart: "body", gapPoints: 0, dailyFallback: true, fallbackTime: "13:15", zoneMinPoints: 0, maxRejectionWickPercent: 0 });
  });
  it("Long position: above the mid → CALL, below → PUT", () => {
    expect(trade(red, above)).toEqual(["CONFIRMED", "CALL"]);
    expect(trade(red, below)).toEqual(["CONFIRMED", "PUT"]);
  });
  it("Short position: above the mid → PUT, below → CALL", () => {
    expect(trade(green, above)).toEqual(["CONFIRMED", "PUT"]);
    expect(trade(green, below)).toEqual(["CONFIRMED", "CALL"]);
  });
  it("27 Oct 2025 09:15 green + 10:15: closes above the mid 25,961.85 with its body above it → PUT at 11:15 (no box check)", () => {
    const drawn = hour(0, { open: 25_843.2, high: 25_975.55, low: 25_827, close: 25_961.85 });
    const pair = evaluatePair(drawn, hour(1, { open: 25_962.75, high: 25_981.7, low: 25_946.75, close: 25_976.3 }), HOURLY_SETTINGS_DEFAULTS);
    expect([pair.reference, pair.status, pair.side]).toEqual([25_961.85, "CONFIRMED", "PUT"]);
  });
  it("skips a body across the mid, a close exactly on it, and a doji drawn candle", () => {
    expect(trade(red, hour(1, { open: 23_995, high: 24_060, low: 23_990, close: 24_050 }))[0]).toBe("SKIPPED");
    expect(trade(red, hour(1, { open: 24_010, high: 24_020, low: 23_990, close: 24_000 }))[0]).toBe("SKIPPED");
    expect(trade(hour(0, { open: 24_000, high: 24_090, low: 23_900, close: 24_000 }), above)[0]).toBe("SKIPPED");
  });
});

describe("1-point difference rule: the second candle's body edge nearest the mid", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  // Green drawn candle, mid 24,000 (its close); box off so only this rule decides.
  const drawn = hour(0, { open: 23_900, high: 24_010, low: 23_890, close: 24_000 });
  const settings = { ...HOURLY_SETTINGS_DEFAULTS, boxMode: "off" as const, directionFrom: "close" as const, referencePrice: "close" as const, gapPoints: 1 };
  const status = (candle: { open: number; high: number; low: number; close: number }, extra = {}) => evaluatePair(drawn, hour(1, candle), { ...settings, ...extra });
  it("Long: a green second candle's open must be at least 1 point above the mid, a red one's close", () => {
    expect(status({ open: 24_001, high: 24_030, low: 24_001, close: 24_025 }).status).toBe("CONFIRMED");
    const near = status({ open: 24_000.95, high: 24_030, low: 24_000.5, close: 24_025 });
    expect(near.status).toBe("SKIPPED");
    expect(near.reasons.join(" ")).toMatch(/open 24000\.95 is 0\.95 points above the mid 24000\.00: less than the 1\.00-point difference above it/);
    expect(status({ open: 24_030, high: 24_035, low: 24_001, close: 24_001 }).status).toBe("CONFIRMED");
    expect(status({ open: 24_030, high: 24_035, low: 24_000.4, close: 24_000.5 }).status).toBe("SKIPPED");
  });
  it("Short: a red second candle's open, a green one's close must be at least 1 point below the mid", () => {
    expect(status({ open: 23_999, high: 23_999, low: 23_960, close: 23_970 }).status).toBe("CONFIRMED");
    expect(status({ open: 23_999.5, high: 23_999.5, low: 23_960, close: 23_970 }).status).toBe("SKIPPED");
    expect(status({ open: 23_960, high: 23_999, low: 23_955, close: 23_999 }).status).toBe("CONFIRMED");
    const green = status({ open: 23_960, high: 23_999.8, low: 23_955, close: 23_999.6 });
    expect(green.status).toBe("SKIPPED");
    expect(green.reasons.join(" ")).toMatch(/close 23999\.60 is 0\.40 points below the mid 24000\.00/);
  });
});

describe("daily trade: a failed setup at the daily-trade time is traded on its direction when nothing passed earlier", () => {
  it("signals a failed 14:15 pair on its direction only when the daily trade is on", () => {
    // 12:15 drawn red (Long), 13:15 closes above the mid but its high leaves the box → skipped; daily trade → CALL.
    const day = Math.floor(Date.parse("2026-10-27T09:15:00+05:30") / 1000);
    const minutes: Candle[] = [];
    const hourly = [
      { open: 24_000, high: 24_010, low: 23_990, close: 24_005 }, { open: 24_005, high: 24_015, low: 23_995, close: 24_008 },
      { open: 24_008, high: 24_020, low: 24_000, close: 24_012 }, { open: 24_080, high: 24_090, low: 23_900, close: 24_000 },
      { open: 24_002, high: 24_150, low: 24_001, close: 24_050 },
    ];
    hourly.forEach((h, index) => {
      for (let m = 0; m < 60; m += 1) {
        const t = day + index * 3600 + m * 60;
        const candle = m === 0 ? { open: h.open, high: h.open, low: h.open, close: h.open } : m === 30 ? { open: h.open, high: h.high, low: h.low, close: h.open } : m === 59 ? { open: h.open, high: h.open, low: h.open, close: h.close } : { open: h.open, high: h.open, low: h.open, close: h.open };
        minutes.push({ time: t, ...candle, high: Math.max(candle.high, candle.open, candle.close), low: Math.min(candle.low, candle.open, candle.close) });
      }
    });
    const rules = { ...HOURLY_SETTINGS_DEFAULTS, gapPoints: 0, dailyFallback: false, fallbackTime: "14:15", boxMode: "wick" as const };
    const off = hourlySignal(minutes, day, rules);
    expect(off.decided?.status).toBe("SKIPPED");
    expect(off.signal).toBeNull();
    const on = hourlySignal(minutes, day, { ...rules, dailyFallback: true });
    expect(on.signal?.direction).toBe("CALL");
    expect(on.signal?.reason).toMatch(/Daily trade at 14:15/);
    expect([HOURLY_SETTINGS_DEFAULTS.dailyFallback, HOURLY_SETTINGS_DEFAULTS.fallbackTime]).toEqual([true, "13:15"]);
  });
});

describe("day-trend filter: the trade goes with the day's move since the 09:15 open", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  const red = hour(0, { open: 24_080, high: 24_090, low: 23_900, close: 24_000 });
  const above = hour(1, { open: 24_002, high: 24_060, low: 23_990, close: 24_050 });
  const settings = { ...HOURLY_SETTINGS_DEFAULTS, trendFilter: true };
  it("keeps a CALL above the day's open and skips one below it", () => {
    expect(evaluatePair(red, above, settings, 24_020).status).toBe("CONFIRMED");
    const against = evaluatePair(red, above, settings, 24_100);
    expect(against.status).toBe("SKIPPED");
    expect(against.reasons.join(" ")).toMatch(/CALL is against the day's move: the second candle closed at 24050\.00, at or below the 09:15 open 24100\.00/);
    expect(evaluatePair(red, above, HOURLY_SETTINGS_DEFAULTS, 24_100).status).toBe("CONFIRMED");
    expect(HOURLY_SETTINGS_DEFAULTS.trendFilter).toBe(false);
  });
});

describe("red–red cross: a red second candle opening above the mid, most of its body below → CALL", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  // 3 Jul 2026 at 11:15: 09:15 red, mid 24,330.60; 10:15 red O 24,332.00 H 24,354.00 L 24,315.40 C 24,322.70.
  const drawn = hour(0, { open: 24_375.65, high: 24_378.15, low: 24_295.15, close: 24_330.6 });
  const next = hour(1, { open: 24_332, high: 24_354, low: 24_315.4, close: 24_322.7 });
  it("is skipped by the body rule when off, a CALL at any hour with 'all', and marked for the daily trade with 'daily'", () => {
    expect(evaluatePair(drawn, next, HOURLY_SETTINGS_DEFAULTS).status).toBe("SKIPPED");
    const all = evaluatePair(drawn, next, { ...HOURLY_SETTINGS_DEFAULTS, crossFlip: "all" });
    expect([all.status, all.side, all.cross]).toEqual(["CONFIRMED", "CALL", true]);
    const daily = evaluatePair(drawn, next, { ...HOURLY_SETTINGS_DEFAULTS, crossFlip: "daily" });
    expect([daily.status, daily.side, daily.cross]).toEqual(["SKIPPED", "PUT", true]);
    // Most of the body above the mid: not the pattern.
    expect(evaluatePair(drawn, hour(1, { open: 24_345, high: 24_354, low: 24_315.4, close: 24_328 }), { ...HOURLY_SETTINGS_DEFAULTS, crossFlip: "all" }).cross).toBeUndefined();
    expect(HOURLY_SETTINGS_DEFAULTS.crossFlip).toBe("off");
  });
  it("8 Dec 2025: an open only 0.10 above the mid is not a cross with a 1-point allowance → the normal PUT", () => {
    const red = hour(0, { open: 26_160, high: 26_176, low: 26_068, close: 26_096.5 });
    const second = hour(1, { open: 26_096.6, high: 26_108, low: 26_053, close: 26_070.7 });
    const rules = { ...HOURLY_SETTINGS_DEFAULTS, crossFlip: "all" as const };
    expect(evaluatePair(red, second, rules).side).toBe("CALL");
    const allowed = evaluatePair(red, second, { ...rules, bodyCrossPoints: 1 });
    expect([allowed.status, allowed.side, allowed.cross]).toEqual(["CONFIRMED", "PUT", undefined]);
  });
  it("the red–red allowance makes 8 Dec 2025 a PUT without relaxing the body rule for other setups", () => {
    const red = hour(0, { open: 26_160, high: 26_176, low: 26_068, close: 26_096.5 });
    const rules = { ...HOURLY_SETTINGS_DEFAULTS, crossFlip: "all" as const, crossTolerance: 1 };
    const pair = evaluatePair(red, hour(1, { open: 26_096.6, high: 26_108, low: 26_053, close: 26_070.7 }), rules);
    expect([pair.status, pair.side, pair.cross]).toEqual(["CONFIRMED", "PUT", undefined]);
    // A green second candle opening 0.10 below the mid of a red drawn candle and closing above: still a body cross.
    expect(evaluatePair(red, hour(1, { open: 26_096.4, high: 26_140, low: 26_090, close: 26_130 }), rules).status).toBe("SKIPPED");
    // An open 1.40 above the mid is a real cross → CALL.
    expect(evaluatePair(red, hour(1, { open: 26_097.9, high: 26_108, low: 26_053, close: 26_070.7 }), rules).side).toBe("CALL");
  });
});

describe("daily-trade red flip: a CALL against the day's move on a red drawn candle becomes a PUT", () => {
  it("flips the 13:15 daily CALL to a PUT when the green second candle has a real body", () => {
    const day = Math.floor(Date.parse("2026-10-27T09:15:00+05:30") / 1000);
    const hourly = [
      { open: 24_200, high: 24_210, low: 24_100, close: 24_110 }, { open: 24_111, high: 24_155, low: 24_105, close: 24_150 },
      { open: 24_150, high: 24_160, low: 24_080, close: 24_090 }, { open: 24_091, high: 24_140, low: 24_085, close: 24_130 },
    ];
    const minutes: Candle[] = [];
    hourly.forEach((h, index) => {
      for (let m = 0; m < 60; m += 1) {
        const t = day + index * 3600 + m * 60;
        const close = m === 59 ? h.close : h.open;
        const extreme = m === 20 ? { high: h.high, low: h.open } : m === 40 ? { high: h.open, low: h.low } : { high: Math.max(h.open, close), low: Math.min(h.open, close) };
        minutes.push({ time: t, open: h.open, close, high: Math.max(extreme.high, h.open, close), low: Math.min(extreme.low, h.open, close) });
      }
    });
    // Every pair is against the day's move (NIFTY stays below the 09:15 open 24,200), so 13:15 is the daily trade.
    const rules = { ...HOURLY_SETTINGS_DEFAULTS, trendFilter: true };
    expect(hourlySignal(minutes, day, rules).signal?.direction).toBe("CALL");
    const flipped = hourlySignal(minutes, day, { ...rules, redAgainstFlip: 10 });
    expect(flipped.signal?.direction).toBe("PUT");
    expect(flipped.signal?.reason).toMatch(/CALL against the day's move .* flipped → ATM PUT/);
    expect(HOURLY_SETTINGS_DEFAULTS.redAgainstFlip).toBe(0);
  });
});

describe("green–red PUT: a red second candle opening just above a green drawn candle's mid, closing below → PUT", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  // 11 Jun 2026 shape: green drawn, mid 23,285.25; red 2nd O 23,287.55 (2.30 above) C 23,257.70.
  const green = hour(0, { open: 23_200, high: 23_300, low: 23_190, close: 23_285.25 });
  const next = hour(1, { open: 23_287.55, high: 23_327.45, low: 23_256.3, close: 23_257.7 });
  it("is a PUT at its hour with 'all', marked for the daily trade with 'daily', and not when the open is more than 3 above", () => {
    expect(evaluatePair(green, next, HOURLY_SETTINGS_DEFAULTS).status).toBe("SKIPPED");
    const all = evaluatePair(green, next, { ...HOURLY_SETTINGS_DEFAULTS, greenRedPut: 3, greenRedMode: "all" });
    expect([all.status, all.side, all.greenRed]).toEqual(["CONFIRMED", "PUT", true]);
    const daily = evaluatePair(green, next, { ...HOURLY_SETTINGS_DEFAULTS, greenRedPut: 3 });
    expect([daily.status, daily.side, daily.greenRed]).toEqual(["SKIPPED", "CALL", true]);
    expect(evaluatePair(green, hour(1, { open: 23_289, high: 23_327.45, low: 23_256.3, close: 23_257.7 }), { ...HOURLY_SETTINGS_DEFAULTS, greenRedPut: 3, greenRedMode: "all" }).greenRed).toBeUndefined();
    expect(HOURLY_SETTINGS_DEFAULTS.greenRedPut).toBe(0);
  });
});

describe("red–red bounce filter: a red PUT candle with a long lower wick is skipped", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  // 14 May 2026: 09:15 red, mid 23,495.80; 10:15 red O 23,496.80 H 23,537.50 L 23,426.55 C 23,459.15 (lower wick 32.60).
  const drawn = hour(0, { open: 23_560, high: 23_580, low: 23_480, close: 23_495.8 });
  const next = hour(1, { open: 23_496.8, high: 23_537.5, low: 23_426.55, close: 23_459.15 });
  it("skips 14 May with a 20-point limit and keeps it with the filter off", () => {
    const rules = { ...HOURLY_SETTINGS_DEFAULTS, crossTolerance: 2, crossFlip: "all" as const };
    expect(evaluatePair(drawn, next, rules).side).toBe("PUT");
    expect(evaluatePair(drawn, next, rules).status).toBe("CONFIRMED");
    const skipped = evaluatePair(drawn, next, { ...rules, redRedMaxLowerWick: 20 });
    expect(skipped.status).toBe("SKIPPED");
    expect(skipped.reasons.join(" ")).toMatch(/lower wick is 32\.60 points \(20\.00 or more\)/);
    expect(HOURLY_SETTINGS_DEFAULTS.redRedMaxLowerWick).toBe(0);
  });
});

describe("red–green wick CALL: the body above the mid, only the lower wick below it", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  // 23 Dec 2025: 09:15 red O 26,205.20 C 26,184.65; 10:15 green O 26,185.60 H 26,195.45 L 26,162.80 C 26,189.75.
  const drawn = hour(0, { open: 26_205.2, high: 26_206.55, low: 26_119.05, close: 26_184.65 });
  const next = hour(1, { open: 26_185.6, high: 26_195.45, low: 26_162.8, close: 26_189.75 });
  const rules = { ...HOURLY_SETTINGS_DEFAULTS, zoneMinPoints: 10, trendFilter: true };
  it("is a CALL with 'override' though the close is 5.10 points past the mid and below the day's open", () => {
    expect(evaluatePair(drawn, next, rules, 26_205.2).status).toBe("SKIPPED");
    const call = evaluatePair(drawn, next, { ...rules, wickCall: 60 }, 26_205.2);
    expect([call.status, call.side, call.wickCall]).toEqual(["CONFIRMED", "CALL", true]);
    expect(call.checks.join(" ")).toMatch(/96% of the lower wick/);
    // 'trend' keeps the day check: below the open → still skipped.
    expect(evaluatePair(drawn, next, { ...rules, wickCall: 60, wickCallMode: "trend" }, 26_205.2).status).toBe("SKIPPED");
    // …unless it is a Mon / Tue (the hour() helper starts on Monday 26 Oct 2026).
    const tuesday = evaluatePair(drawn, next, { ...rules, wickCall: 60, wickCallMode: "trend", wickCallAnyTrendDays: "Mon,Tue" }, 26_205.2);
    expect([tuesday.status, tuesday.side]).toEqual(["CONFIRMED", "CALL"]);
    // Less than 60% of the wick below the mid: not the pattern.
    expect(evaluatePair(drawn, hour(1, { open: 26_185.6, high: 26_195.45, low: 26_183.5, close: 26_189.75 }), { ...rules, wickCall: 60 }, 26_205.2).wickCall).toBeUndefined();
    expect(HOURLY_SETTINGS_DEFAULTS.wickCall).toBe(0);
  });
});

describe("Short position, second candle above the mid → PUT: the day-trend exemption", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  // 17 Jun 2026 at 11:15: 09:15 green O 24,044.50 C 24,047.70; 10:15 green O 24,048.25 H 24,097.40 L 24,046.45 C 24,081.70.
  const drawn = hour(0, { open: 24_044.5, high: 24_071.65, low: 23_969.7, close: 24_047.7 });
  const next = hour(1, { open: 24_048.25, high: 24_097.4, low: 24_046.45, close: 24_081.7 });
  const rules = { ...HOURLY_SETTINGS_DEFAULTS, zoneMinPoints: 10, trendFilter: true };
  it("is skipped by the day check, a PUT at 11:15 with 'first' or 'all'", () => {
    expect(evaluatePair(drawn, next, rules, 24_044.5).status).toBe("SKIPPED");
    const first = evaluatePair(drawn, next, { ...rules, shortAboveTrend: "first" }, 24_044.5);
    expect([first.status, first.side]).toEqual(["CONFIRMED", "PUT"]);
    // Not the first pair (the drawn candle is not the 09:15 one): 'first' still applies the day check.
    expect(evaluatePair(drawn, next, { ...rules, shortAboveTrend: "first" }, 24_000).status).toBe("SKIPPED");
    expect(evaluatePair(drawn, next, { ...rules, shortAboveTrend: "all" }, 24_000).status).toBe("CONFIRMED");
    expect(HOURLY_SETTINGS_DEFAULTS.shortAboveTrend).toBe("check");
  });
});

describe("green–red allowance: an open just above a green drawn candle's mid is not a cross", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  // 17 Apr 2026 at 13:15: 11:15 green O 24,264.65 C 24,285.60; 12:15 red O 24,286.20 (0.60 above) C 24,285.05.
  const drawn = hour(0, { open: 24_264.65, high: 24_323.1, low: 24_253.15, close: 24_285.6 });
  const next = hour(1, { open: 24_286.2, high: 24_293.7, low: 24_259.9, close: 24_285.05 });
  const rules = { ...HOURLY_SETTINGS_DEFAULTS, greenRedPut: 3, greenRedTolerance: 0.75 };
  it("keeps the normal CALL (not the green–red PUT) for an open 0.60 above the mid", () => {
    const pair = evaluatePair(drawn, next, rules);
    expect([pair.side, pair.greenRed]).toEqual(["CALL", undefined]);
    expect(pair.checks.join(" ")).toMatch(/Green–red allowance: the second candle opened 0\.60 points above the mid/);
    // Without the allowance it is the green–red pattern (the daily trade would buy the PUT).
    expect(evaluatePair(drawn, next, { ...rules, greenRedTolerance: 0 }).greenRed).toBe(true);
    // An open 1.00 above the mid is a cross: the green–red PUT.
    expect(evaluatePair(drawn, hour(1, { ...next, open: 24_286.6 }), rules).greenRed).toBe(true);
    // 'daily': the normal body rule stays strict (skipped), but it is not the green–red PUT, so the daily trade is a CALL.
    const daily = evaluatePair(drawn, next, { ...rules, greenRedToleranceMode: "daily" });
    expect([daily.status, daily.side, daily.greenRed]).toEqual(["SKIPPED", "CALL", undefined]);
    expect(daily.reasons.join(" ")).toMatch(/body rule/);
    expect(HOURLY_SETTINGS_DEFAULTS.greenRedTolerance).toBe(0);
  });
});

describe("thin-wick PUT: a green second candle above a red drawn candle's mid with no lower wick", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  // 10 Aug 2026: 09:15 red, mid 24,544.75; 10:15 green O 24,545.90 H 24,614.50 L 24,545.60 C 24,602.35 (lower wick 0.30).
  const drawn = hour(0, { open: 24_600, high: 24_610, low: 24_500, close: 24_544.75 });
  const next = hour(1, { open: 24_545.9, high: 24_614.5, low: 24_545.6, close: 24_602.35 });
  it("is a PUT with a 0.50-point limit and stays a CALL without it or with a bigger wick", () => {
    expect(evaluatePair(drawn, next, HOURLY_SETTINGS_DEFAULTS).side).toBe("CALL");
    const put = evaluatePair(drawn, next, { ...HOURLY_SETTINGS_DEFAULTS, thinWickPut: 0.5 });
    expect([put.status, put.side, put.thinWick]).toEqual(["CONFIRMED", "PUT", true]);
    expect(evaluatePair(drawn, hour(1, { ...next, low: 24_545 }), { ...HOURLY_SETTINGS_DEFAULTS, thinWickPut: 0.5 }).side).toBe("CALL");
    expect(HOURLY_SETTINGS_DEFAULTS.thinWickPut).toBe(0);
  });
});

describe("green–red CALL first: an open within 1 point of a green drawn candle's mid beats the day check", () => {
  const hour = (index: number, candle: { open: number; high: number; low: number; close: number }): HourCandle => ({ start: hourStart(index), end: hourStart(index + 1), ...candle, minutes: 60, complete: true });
  // 5 Oct 2026 at 11:15: 09:15 green O 22,532.40 C 22,543.75; 10:15 red O 22,543.65 (0.10 below) C 22,487.55.
  const drawn = hour(0, { open: 22_532.4, high: 22_621.8, low: 22_506.35, close: 22_543.75 });
  const next = hour(1, { open: 22_543.65, high: 22_560.5, low: 22_460.8, close: 22_487.55 });
  const rules = { ...HOURLY_SETTINGS_DEFAULTS, zoneMinPoints: 10, trendFilter: true, greenRedPut: 3, greenRedTolerance: 1 };
  it("is a CALL at 11:15 with the rule first, skipped by the day check without it", () => {
    expect(evaluatePair(drawn, next, rules, 22_532.4).status).toBe("SKIPPED");
    const call = evaluatePair(drawn, next, { ...rules, greenRedTrendFree: true }, 22_532.4);
    expect([call.status, call.side]).toEqual(["CONFIRMED", "CALL"]);
    expect(HOURLY_SETTINGS_DEFAULTS.greenRedTrendFree).toBe(false);
  });
});

describe("9. the target is exactly 5% above the option's entry premium", () => {
  it("sets the target from the executed premium (₹100.05 with one tick of slippage → ₹105.05), not from NIFTY", async () => {
    const { state, events } = await replay(session([RED, HOLDS_ABOVE, UP_NO_TARGET]));
    const entry = entries(events)[0];
    const price = entry.order!.price!;
    expect(price).toBe(100.05);
    expect(entry.target).toBe(Math.round(price * 1.05 * 100) / 100);
    expect(price * 1.05).toBeCloseTo(105.0525, 10);
    expect(entry.setup?.underlyingEntry).toBe(23_990); // the NIFTY close, recorded apart from the premium
    expect(entry.setup?.level).toBe(23_950); // the NIFTY reference
    expect(state.hourly?.trades[0]).toMatchObject({ premium: 100.05, target: 105.05, reference: 23_950 });
  });
  it("exits at the target when the premium reaches it inside an hour (before that hour's midpoint decision)", async () => {
    const { events } = await replay(session([RED, HOLDS_ABOVE, { open: 23_990, close: 23_995, high: 24_005, low: 23_985 }, FLAT, FLAT, FLAT, FLAT]));
    const exit = exits(events)[0];
    expect(exit.message).toMatch(/^Exit \(TARGET\)/);
    expect(exit.order?.price).toBe(105); // the target, less one tick of slippage
    expect(clock(exit.time)).toBe("11:36");
  });
});

describe("early exit: a trade still well below its entry is cut before the hourly midpoint exit", () => {
  // LONG entered at 11:15 (CALL ₹100 at 23,990); the 11:15 hour slides to 23,960, so the CALL is below ₹97 by 11:45.
  const SLIDE = { open: 23_990, close: 23_960, high: 23_991, low: 23_959 };
  const candles = session([RED, HOLDS_ABOVE, SLIDE, FLAT, FLAT, FLAT, FLAT]);
  const early = (extra: Partial<typeof RULES>): AlgoConfig => ({ ...REPLAY, hourly: { ...RULES, ...extra } });
  it("is off by default: the trade waits for the 12:15 midpoint exit", async () => {
    const exit = exits((await replay(candles)).events)[0];
    expect(exit.message).toMatch(/^Exit \(MIDPOINT\)/);
    expect(clock(exit.time)).toBe("12:15");
    expect(HOURLY_SETTINGS_DEFAULTS).toMatchObject({ earlyExitMinutes: 0, earlyExitPercent: 0, expiryEarlyExitMinutes: 0, expiryEarlyExitPercent: 0 });
  });
  it("30 minutes, 3%: sells at the premium once the CALL is still more than 3% down half an hour after the entry", async () => {
    const { events, state } = await replay(candles, early({ earlyExitMinutes: 30, earlyExitPercent: 3 }));
    const exit = exits(events)[0];
    expect(exit.message).toMatch(/^Exit \(EARLY_EXIT\).*Early exit — 30 minutes after the entry/);
    expect(clock(exit.time)).toBe("11:45");
    expect(state.hourly?.trades[0]).toMatchObject({ status: "EARLY EXIT" });
  });
  it("on the contract's expiry day the expiry setting applies (15 minutes); on other days it does not", async () => {
    const config = early({ earlyExitMinutes: 30, earlyExitPercent: 3, expiryEarlyExitMinutes: 15, expiryEarlyExitPercent: 3 });
    const onExpiry = createReplayAdapter({ candles, chain: { ...CHAIN, expiry: DATE }, config, capital: 100_000, tapeOf: tapes(candles) });
    const expiryRun = await simulateSession({ sessionId: `${DATE}.hourly`, date: DATE, config, candles, lines: [], adapter: onExpiry, startNote: "test" });
    const exit = exits(expiryRun.events)[0];
    expect(exit.message).toMatch(/expiry day/);
    expect(clock(exit.time)).toBe("11:30");
    expect(clock(exits((await replay(candles, config)).events)[0].time)).toBe("11:45");
  });
});

describe("10–11. the hourly midpoint rule (completed hours only)", () => {
  it("keeps a LONG only while the hour closes above its midpoint, a SHORT only while it closes below", () => {
    expect(hourlyMidpointDecision("CALL", { high: 110, low: 100, close: 106 })).toMatchObject({ keep: true, mid: 105 });
    expect(hourlyMidpointDecision("CALL", { high: 110, low: 100, close: 105 }).keep).toBe(false);
    expect(hourlyMidpointDecision("CALL", { high: 110, low: 100, close: 104 }).keep).toBe(false);
    expect(hourlyMidpointDecision("PUT", { high: 110, low: 100, close: 104 }).keep).toBe(true);
    expect(hourlyMidpointDecision("PUT", { high: 110, low: 100, close: 105 }).keep).toBe(false);
    expect(hourlyMidpointDecision("PUT", { high: 110, low: 100, close: 106 }).keep).toBe(false);
  });
  it("LONG: holds through the 11:15 hour (close above its midpoint), exits at 13:15 when the 12:15 hour closes below it", async () => {
    const { events, state } = await replay(session([RED, HOLDS_ABOVE, UP_NO_TARGET, DOWN, FLAT, FLAT, FLAT]));
    expect(events.some((event) => /Hourly midpoint: HOLD — the 11:15–12:15 hour/.test(event.message))).toBe(true);
    const exit = exits(events)[0];
    expect(exit.message).toMatch(/^Exit \(MIDPOINT\).*12:15–13:15 hour closed at 23960\.00, below its midpoint/);
    expect(clock(exit.time)).toBe("13:15");
    // The exit decision used the completed hour only: nothing before its close at 13:15.
    expect(events.filter((event) => event.kind === "EXIT" && event.time < hourStart(4))).toHaveLength(0);
    expect(state.hourly?.trades[0]).toMatchObject({ status: "MIDPOINT EXIT" });
    expect(state.hourly?.trades[0].midpoints.map((item) => item.keep)).toEqual([true, false]);
  });
  it("SHORT: the mirror — held while hours close below their midpoint, out when one closes above it", async () => {
    const { events } = await replay(session([
      { open: 23_950, close: 24_000, high: 24_010, low: 23_945 }, { open: 23_995, close: 23_960, high: 23_998, low: 23_955 },
      // Below its midpoint (held; the PUT stays short of its +5% target), then a close above the midpoint (out).
      { open: 23_960, close: 23_957, high: 23_963, low: 23_956 }, { open: 23_957, close: 23_990, high: 23_992, low: 23_956 }, FLAT, FLAT, FLAT,
    ]));
    expect(events.some((event) => /HOLD — the 11:15–12:15 hour closed at 23957\.00, below its midpoint/.test(event.message))).toBe(true);
    expect(exits(events)[0].message).toMatch(/^Exit \(MIDPOINT\).*12:15–13:15 hour closed at 23990\.00, above its midpoint/);
  });
  it("closes a trade still open at the 15:20 square-off (never carried overnight)", async () => {
    const rising = (index: number) => ({ open: 23_990 + index, close: 23_991 + index, high: 23_991 + index, low: 23_989.5 + index });
    const { events, state } = await replay(session([RED, HOLDS_ABOVE, rising(0), rising(1), rising(2), rising(3), rising(4)]));
    expect(exits(events)[0].message).toMatch(/^Exit \(SQUARE_OFF\)/);
    expect(clock(exits(events)[0].time)).toBe("15:20");
    expect(state.position).toBeNull();
    expect(state.hourly?.trades[0].status).toBe("SESSION CLOSED");
  });
});

describe("12. no fixed stop-loss order", () => {
  it("opens with no stop level, places no exit before the target / midpoint / square-off, and refuses a stop-loss setting", async () => {
    const candles = session([RED, HOLDS_ABOVE, { open: 23_990, close: 23_991, high: 23_992, low: 23_900 }, FLAT, FLAT, FLAT, FLAT]);
    const adapter = createReplayAdapter({ candles, chain: CHAIN, config: REPLAY, capital: 100_000, tapeOf: tapes(candles) });
    let state: AlgoState = { ...initialState(DATE), running: true, entries: true };
    const exitTimes: number[] = [];
    for (const candle of candles) {
      adapter.setClock(candle.time + 60);
      const result = await advance(state, { sessionId: `${DATE}.stop`, sessionDate: DATE, config: REPLAY, candles, lines: [], now: candle.time + 60, adapter });
      state = result.state;
      if (state.position && clock(candle.time + 60) === "11:15") expect(state.position.stop).toBe(0);
      exitTimes.push(...result.events.filter((event) => event.kind === "EXIT").map((event) => event.time));
    }
    // NIFTY fell 90 points inside the 11:15 hour (the premium −45) and recovered: no stop exit. Every hour then closed
    // above its midpoint, so the only exit is the 15:20 square-off.
    expect(exitTimes.map(clock)).toEqual(["15:20"]);
    expect(algoConfigProblems({ ...MATHI_HOURLY_DEFAULTS, stopLoss: true }).join(" ")).toMatch(/no fixed stop-loss/);
  });
  it("has its session-loss safety limit off by default; set, it stops new entries", () => {
    expect(lossLimit(MATHI_HOURLY_DEFAULTS)).toBe(Infinity);
    expect(lossLimit({ ...MATHI_HOURLY_DEFAULTS, hourly: { ...RULES, maxSessionLoss: 3_000 } })).toBe(3_000);
  });
});

describe("13. no duplicate trades from one signal", () => {
  it("repeated checks, a reconnect and a rerun at the same time place the entry once", async () => {
    const candles = session([RED, HOLDS_ABOVE, UP_NO_TARGET]);
    const adapter = createReplayAdapter({ candles, chain: CHAIN, config: REPLAY, capital: 100_000, tapeOf: tapes(candles) });
    const now = hourStart(2);
    adapter.setClock(now);
    const start: AlgoState = { ...initialState(DATE), running: true, entries: true, lastCandle: now - 120 };
    const once = await advance(start, { sessionId: `${DATE}.dup`, sessionDate: DATE, config: REPLAY, candles, lines: [], now, adapter });
    const twice = await advance(once.state, { sessionId: `${DATE}.dup`, sessionDate: DATE, config: REPLAY, candles, lines: [], now, adapter });
    // A restart without the stored state (lastCandle unknown) evaluates only the latest candle, and the order key is known.
    const again = await advance({ ...start, lastCandle: null }, { sessionId: `${DATE}.dup`, sessionDate: DATE, config: REPLAY, candles, lines: [], now, adapter });
    expect(entries(once.events)).toHaveLength(1);
    expect(entries(twice.events)).toHaveLength(0);
    expect(entries(again.events)).toHaveLength(0);
    expect(again.events.some((event) => /already processed/i.test(event.message))).toBe(true);
  });
  it("one trade a session by default: a second confirmed pair is not traded", async () => {
    const candles = session([RED, HOLDS_ABOVE, { open: 23_990, close: 23_995, high: 24_005, low: 23_985 }, { open: 23_996, close: 24_010, high: 24_012, low: 23_995 }, FLAT, FLAT, FLAT]);
    const { events } = await replay(candles);
    expect(entries(events)).toHaveLength(1);
  });
});

describe("14. replay and live paper make the same decisions on the same data", () => {
  it("gives the same entries, exits and skip logs minute by minute with a paper adapter as the replay", async () => {
    const candles = session([RED, HOLDS_ABOVE, UP_NO_TARGET, DOWN, FLAT, FLAT, FLAT]);
    const replayed = await replay(candles);
    const base = createReplayAdapter({ candles, chain: CHAIN, config: REPLAY, capital: 100_000, tapeOf: tapes(candles) });
    const paper = { ...base, kind: "paper" as const };
    const config: AlgoConfig = { ...MATHI_HOURLY_DEFAULTS, mode: "PAPER", hourly: RULES };
    let state: AlgoState = { ...initialState(DATE), running: true, entries: true };
    const live: AlgoEvent[] = [];
    for (const candle of candles) {
      const now = candle.time + 60 + 5; // a live check runs a few seconds after each minute closes
      base.setClock(candle.time + 60);
      const seen = candles.filter((item) => item.time + 60 <= now);
      const result = await advance(state, { sessionId: `${DATE}.hourly`, sessionDate: DATE, config, candles: seen, lines: [], now, adapter: paper });
      state = result.state;
      live.push(...result.events);
      if (!state.position && state.tradesToday >= config.maxTrades) break;
    }
    const summary = (events: AlgoEvent[]) => events.filter((event) => event.kind === "ENTRY" || event.kind === "EXIT").map((event) => [event.kind, event.side, clock(event.kind === "ENTRY" ? event.time + 60 : event.time), event.order?.price]);
    expect(summary(live)).toEqual(summary(replayed.events));
    expect(summary(live)).toHaveLength(2);
  });
});

describe("chart: the reference as a position zone, with its status", () => {
  it("draws one locked Long position at the reference with its status and the option target; midpoints as dashed lines", async () => {
    const { state } = await replay(session([RED, HOLDS_ABOVE, UP_NO_TARGET, DOWN, FLAT, FLAT, FLAT]));
    const drawings = hourlyDrawings(state.analysis?.hourly, hourStart(6), { neckline: "#aa0", resistance: "#a00", support: "#0a0" });
    const zone = drawings.find((item) => item.kind === "long")!;
    expect(zone.locked).toBe(true);
    expect(zone.points[0].price).toBe(23_950);
    expect(zone.text).toMatch(/^LONG ref 23,950\.00 · MIDPOINT EXIT · CALL ₹100\.05 → ₹105\.05 \(\+5%\)/);
    expect(drawings.filter((item) => item.kind === "trend" && item.dash === "dashed")).toHaveLength(2);
  });
});

describe("15. Mathi Strategy is unchanged", () => {
  it("keeps Mathi Strategy's defaults and engine", () => {
    expect(ALGO_DEFAULTS).toMatchObject({ engine: "existing", target: { mode: "percent", value: 3 }, maxTrades: 3, entryStart: "09:15", maxDailyLoss: 2_000, regime: { enabled: true, lookback: 30 }, confirmation: { mode: "retest" } });
    expect("hourly" in ALGO_DEFAULTS).toBe(false);
    expect("hourly" in readAlgoConfig(JSON.parse(JSON.stringify(ALGO_DEFAULTS)))).toBe(false);
    expect(lossLimit(ALGO_DEFAULTS)).toBe(2_000);
  });
  it("is its own strategy: listed, a variant with its own live commands, settings and replay", () => {
    expect(ALGO_STRATEGIES).toContain("MATHI_HOURLY");
    expect(isVariantStrategy("MATHI_HOURLY")).toBe(true);
    expect(STRATEGY_NAME.MATHI_HOURLY).toBe("Mathi Hourly Zone Strategy — 5%");
    for (const op of ["start", "stop", "tick", "exit"]) expect(algoRequest.safeParse({ action: "variant", strategy: "MATHI_HOURLY", op }).success).toBe(true);
    expect(algoRequest.safeParse({ action: "save", strategy: "MATHI_HOURLY", config: {} }).success).toBe(true);
    expect(algoRequest.safeParse({ action: "chartArm", session: "2026-10-26.abcd", cursor: 1, strategy: "MATHI_HOURLY" }).success).toBe(true);
    const saved = readAlgoConfig(JSON.parse(JSON.stringify(MATHI_HOURLY_DEFAULTS)));
    expect(saved).toMatchObject({ engine: "hourly", target: { value: 5 }, stopLoss: false, maxTrades: 1, entryStart: "11:15", hourly: MATHI_HOURLY_DEFAULTS.hourly, regime: { enabled: false } });
  });
});
