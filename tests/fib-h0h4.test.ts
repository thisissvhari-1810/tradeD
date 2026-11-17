import { describe, expect, it } from "vitest";
import {
  advanceH0H4, applyCeCandle, H0H4_1MIN, H0H4_3MIN, H0H4_H2_ANCHOR, atmStrike, createH0H4Session, fibFromAnchors, fiveMinuteCandles, h0h4Report, H0H4_V1_CLOSE_5M as H0H4_DEFAULTS, H0H4_DEFAULTS as CURRENT, progress, selectContract, sessionRow, tradeResult,
  type Bar, type H0H4Contract, type H0H4State,
} from "@/lib/algo/fib-h0h4";

const T = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
type OHLC = [number, number, number, number];

/** Five 1-minute bars per 5-minute candle whose aggregate is exactly (o, h, l, c): o → l → h → c. */
function minutes(start: string, candles: OHLC[], volume = 100): Bar[] {
  const bars: Bar[] = [];
  candles.forEach(([o, h, l, c], k) => {
    const t = T(start) + 5 * k;
    bars.push({ t, open: o, high: o, low: l, close: l, volume });
    bars.push({ t: t + 1, open: l, high: h, low: l, close: h, volume });
    bars.push({ t: t + 2, open: h, high: h, low: c, close: c, volume });
    bars.push({ t: t + 3, open: c, high: c, low: c, close: c, volume });
    bars.push({ t: t + 4, open: c, high: c, low: c, close: c, volume });
  });
  return bars;
}
/** A flat NIFTY tape with the given 09:15–09:20 candle, then flat to 15:29. */
function spot(open: OHLC): Bar[] {
  const rest: OHLC[] = Array.from({ length: 74 }, () => [open[3], open[3], open[3], open[3]]);
  return minutes("09:15", [open, ...rest]);
}
const contract = (strike: number): H0H4Contract => ({ underlying: "NIFTY", expiry: "2026-11-17", strike, right: "CE", symbol: `NIFTY 17-NOV-2026 ${strike} CE`, lotSize: 65 });

const GREEN: OHLC = [24300, 24345, 24290, 24337]; // close 24,337 → ATM 24,350 (spec example)
const H0_TO_H4: OHLC[] = [
  [105, 108, 104, 107], //  09:15 H0 = 108, Initial Low = 104
  [107, 109, 106, 107.5], // 09:20 wick above H0 only → no H1
  [107.5, 110, 107, 109], // 09:25 closes 109 > 108 → H1 = 110
  [109, 113, 108.5, 111], // 09:30 closes 111 > 110 → H2 = 113
  [111, 118, 110, 116], //   09:35 closes 116 > 113 → H3 = 118 → Fib 0.618 = 121.304
  [116, 120, 115, 119], //   09:40 closes 119 > 118 → H4 = 120 < 121.304 valid
];
const flat = (n: number, price: number): OHLC[] => Array.from({ length: n }, () => [price, price, price, price]);

/** Runs a whole session (backtest style) or up to `now` (paper style). */
function run(ce: OHLC[], options: { open?: OHLC; now?: number; state?: H0H4State; settings?: typeof H0H4_DEFAULTS; extraBars?: Bar[] } = {}) {
  const s = options.settings ?? H0H4_DEFAULTS;
  const now = options.now ?? 24 * 60;
  const spotBars = spot(options.open ?? GREEN);
  const ceBars = [...minutes("09:15", ce), ...(options.extraBars ?? [])];
  let state = options.state ?? createH0H4Session("2026-11-17");
  state = advanceH0H4(state, { now, spot: spotBars }, s);
  if (state.phase === "SELECTING_ATM") state = selectContract(state, contract(state.strike!), T("09:20"));
  return advanceH0H4(state, { now, spot: spotBars, ce: ceBars }, s);
}

describe("Fibonacci anchors (0.0 = Initial Low, 0.5 = H3, 0.618 = target)", () => {
  it("₹104 / ₹118 → 0.618 = ₹121.304 (not the illustration's ₹122.97)", () => {
    const fib = fibFromAnchors(104, 118);
    expect(fib.f0).toBe(104);
    expect(fib.f05).toBeCloseTo(118, 12);
    expect(fib.f0618).toBeCloseTo(121.304, 9);
    expect(fib.f0618).toBeCloseTo(104 + (118 - 104) * 1.236, 9);
    expect(fib.targetOrder).toBe(121.35); // first tradable tick at/above the target
  });
  it("ATM: nearest 50, half up", () => {
    expect(atmStrike(24337)).toBe(24350);
    expect(atmStrike(24325)).toBe(24350);
    expect(atmStrike(24324.95)).toBe(24300);
  });
});

describe("Test 1 — valid complete strategy", () => {
  const ce: OHLC[] = [...H0_TO_H4, [119, 121, 118.5, 120.5], [120.6, 122, 120, 121.8], ...flat(60, 121.8)];
  const state = run(ce);
  it("establishes every level from completed 5-minute candle highs", () => {
    expect(state.color).toBe("GREEN");
    expect(state.strike).toBe(24350);
    expect(state.levels.H0).toMatchObject({ price: 108, candle: T("09:15"), confirmedAt: T("09:20") });
    expect(state.initial!.low).toBe(104);
    expect(state.levels.H1).toMatchObject({ price: 110, candle: T("09:25") }); // the 09:20 wick did not count
    expect(state.levels.H2).toMatchObject({ price: 113, candle: T("09:30") });
    expect(state.levels.H3).toMatchObject({ price: 118, candle: T("09:35") });
    expect(state.fib!.f0618).toBeCloseTo(121.304, 9);
    expect(state.levels.H4).toMatchObject({ price: 120, candle: T("09:40") });
    expect(state.h4Valid).toBe(true);
  });
  it("buys only after a LATER candle closes above H4, at the next bar's open + slippage; sells at Fib 0.618", () => {
    expect(state.breakout).toMatchObject({ candle: T("09:45"), close: 120.5, signalAt: T("09:50") });
    expect(state.entry).toMatchObject({ time: T("09:50"), quoted: 120.6, price: 120.7, source: "BAR_OPEN", quantity: 65 });
    expect(state.exit).toMatchObject({ reason: "TARGET", price: 121.35 });
    expect(state.phase).toBe("TARGET_COMPLETED");
    expect(state.outcome).toBe("TRADE");
    const t = tradeResult(state)!;
    expect(t.gross).toBeCloseTo((121.35 - 120.7) * 65, 6);
    expect(t.net).toBeCloseTo(t.gross - t.charges, 6);
    expect(progress(state).every((p) => p.tone === "done")).toBe(true);
    const row = sessionRow(state);
    expect(row).toMatchObject({ h0: 108, h1: 110, h2: 113, h3: 118, h4: 120, h4Validation: "VALID", h4BreakoutTime: "09:50", entryTime: "09:50", exitReason: "TARGET" });
  });
});

describe("skips and no-entry sessions", () => {
  it("Test 2 — red opening candle skips the whole session", () => {
    const state = run(H0_TO_H4, { open: [24337, 24345, 24290, 24300] });
    expect(state.phase).toBe("SESSION_SKIPPED");
    expect(state.reason).toBe("RED_OPEN");
    expect(state.contract).toBeNull();
    expect(state.levels.H0).toBeNull();
  });
  it("neutral opening candle skips the session", () => {
    expect(run(H0_TO_H4, { open: [24300, 24345, 24290, 24300] }).reason).toBe("NEUTRAL_OPEN");
  });
  it("Test 3 — a wick above H0 never sets H1", () => {
    const state = run([H0_TO_H4[0], [107, 112, 106, 107.9], ...flat(70, 107)]);
    expect(state.levels.H1).toBeNull();
    expect(state.reason).toBe("H0_NEVER_BROKEN");
    expect(state.outcome).toBe("NO_ENTRY");
  });
  it("Test 4 — a wick above H4 is not a BUY signal", () => {
    const state = run([...H0_TO_H4, [119, 121, 118.5, 119.5], ...flat(60, 119)]);
    expect(state.breakout).toBeNull();
    expect(state.entry).toBeNull();
    expect(state.reason).toBe("H4_NEVER_BROKEN");
  });
  // Initial Low 100 and H3 125 put Fib 0.618 exactly on 130.90.
  const BIG: OHLC[] = [[101, 104, 100, 103], [103, 108, 102, 106], [106, 112, 105, 110], [110, 125, 109, 120]];
  it("Test 5 — H4 equal to the target is invalid", () => {
    expect(fibFromAnchors(100, 125).f0618).toBeCloseTo(130.9, 9);
    const state = run([...BIG, [120, 130.9, 119, 126], ...flat(60, 126)]);
    expect(state.levels.H4!.price).toBe(130.9);
    expect(state.h4Valid).toBe(false);
    expect(state.reason).toBe("H4_AT_TARGET");
    expect(state.phase).toBe("SESSION_SKIPPED");
  });
  it("Test 6 — H4 above the target is invalid", () => {
    const state = run([...BIG, [120, 131, 119, 126], ...flat(60, 126)]);
    expect(state.reason).toBe("H4_ABOVE_TARGET");
    expect(sessionRow(state).h4Validation).toBe("ABOVE_TARGET");
  });
  it("Test 7 — target reached before the H4 breakout cancels the setup", () => {
    const state = run([...H0_TO_H4, [119, 121.5, 118, 119], ...flat(60, 125)]);
    expect(state.reason).toBe("TARGET_BEFORE_ENTRY");
    expect(state.phase).toBe("SESSION_SKIPPED");
    expect(state.entry).toBeNull();
  });
  it("target already traded inside the breakout candle: cancelled by default, allowed by the research setting", () => {
    const ce: OHLC[] = [...H0_TO_H4, [119, 123, 118.5, 121], [120.9, 122, 120.5, 121.5], ...flat(60, 121.5)];
    expect(run(ce).reason).toBe("TARGET_BEFORE_ENTRY");
    const allowed = run(ce, { settings: { ...H0H4_DEFAULTS, breakoutTargetCheck: "allow" } });
    expect(allowed.entry).toMatchObject({ quoted: 120.9, price: 121 });
    expect(allowed.exit!.reason).toBe("TARGET");
  });
  it("a fill price already at/above the target is not executed", () => {
    const state = run([...H0_TO_H4, [119, 121, 118.5, 120.5], [121.4, 122, 121, 121.5], ...flat(60, 121.5)]);
    expect(state.reason).toBe("TARGET_BEFORE_ENTRY");
    expect(state.entry).toBeNull();
  });
  it("Test 8 — H4 never breaks: no trade", () => {
    const state = run([...H0_TO_H4, ...flat(68, 119)]);
    expect(state.levels.H4!.price).toBe(120);
    expect(state.outcome).toBe("NO_ENTRY");
    expect(state.reason).toBe("H4_NEVER_BROKEN");
  });
  it("target not reached: squared off at 15:29 (only non-target exit)", () => {
    const state = run([...H0_TO_H4, [119, 121, 118.5, 120.5], ...flat(68, 120.8)]);
    expect(state.exit).toMatchObject({ reason: "SQUARE_OFF", time: T("15:29"), quoted: 120.8, price: 120.7 });
    expect(state.phase).toBe("SESSION_COMPLETED");
    expect(tradeResult(state)!.target).toBe(false);
  });
  it("missing 09:15 CE data skips (never filled in)", () => {
    const bars = minutes("09:15", [...H0_TO_H4, ...flat(60, 119)]).filter((bar) => bar.t !== T("09:15"));
    let state = advanceH0H4(createH0H4Session("2026-11-17"), { now: 1440, spot: spot(GREEN) }, H0H4_DEFAULTS);
    state = selectContract(state, contract(24350), T("09:20"));
    state = advanceH0H4(state, { now: 1440, spot: spot(GREEN), ce: bars }, H0H4_DEFAULTS);
    expect(state.reason).toBe("CE_DATA_MISSING");
  });
  it("contract unavailable skips", () => {
    let state = advanceH0H4(createH0H4Session("2026-11-17"), { now: 1440, spot: spot(GREEN) }, H0H4_DEFAULTS);
    state = selectContract(state, null, T("09:21"), "not in the option chain");
    expect(state.reason).toBe("CONTRACT_UNAVAILABLE");
  });
});

describe("live feed safety", () => {
  const ce: OHLC[] = [...H0_TO_H4, [119, 121, 118.5, 120.5], [120.6, 122, 120, 121.8], ...flat(60, 121.8)];
  it("never uses an incomplete candle (opening candle, lagging feed)", () => {
    const spotBars = spot(GREEN);
    expect(advanceH0H4(createH0H4Session("2026-11-17"), { now: T("09:19") + 0.5, spot: spotBars }, H0H4_DEFAULTS).phase).toBe("WAITING_FOR_OPEN");
    // 09:20:10 but the feed only has bars through 09:18: wait.
    const lag = spotBars.filter((bar) => bar.t <= T("09:18"));
    expect(advanceH0H4(createH0H4Session("2026-11-17"), { now: T("09:20") + 0.17, spot: lag }, H0H4_DEFAULTS).phase).toBe("WAITING_FOR_OPEN");
    const { candles, pending } = fiveMinuteCandles(minutes("09:15", ce), T("09:42"), H0H4_DEFAULTS);
    expect(candles.at(-1)!.t).toBe(T("09:35"));
    expect(pending!.t).toBe(T("09:40"));
  });
  it("Test 9 — duplicate / replayed candles create no duplicate breakout or order", () => {
    const bars = minutes("09:15", ce);
    const dup = [...bars, ...bars.slice(20, 40), ...bars.slice(0, 5)].reverse(); // duplicates, out of order
    const once = run(ce);
    let state = advanceH0H4(createH0H4Session("2026-11-17"), { now: 1440, spot: spot(GREEN) }, H0H4_DEFAULTS);
    state = selectContract(state, contract(24350), T("09:20"));
    state = advanceH0H4(state, { now: 1440, spot: spot(GREEN), ce: dup }, H0H4_DEFAULTS);
    const again = advanceH0H4(state, { now: 1440, spot: spot(GREEN), ce: dup }, H0H4_DEFAULTS);
    expect(state.entry).toEqual(once.entry);
    expect(again).toEqual(state);
    expect(state.events.filter((e) => e.phase === "ENTRY_PENDING")).toHaveLength(1);
    expect(state.events.filter((e) => e.phase === "POSITION_OPEN")).toHaveLength(1);
    // An old candle handed in directly is ignored.
    const mid = run(ce, { now: T("09:47") });
    const replay = applyCeCandle(mid, fiveMinuteCandles(bars).candles[2], H0H4_DEFAULTS);
    expect(replay.levels).toEqual(mid.levels);
    expect(replay.ignoredCandles).toBe(1);
  });
  it("Test 10 — restart during the setup restores the exact levels and state", () => {
    const before = run(ce, { now: T("09:43") }); // after H4 (09:40 candle not complete until a later bar or grace)
    const restored = JSON.parse(JSON.stringify(before)) as H0H4State;
    expect(restored).toEqual(before);
    expect(restored.levels.H3!.price).toBe(118);
    const resumed = run(ce, { state: restored });
    expect(resumed).toEqual(run(ce));
  });
  it("Test 11 — restart with an open paper position: continues target monitoring, never re-enters", () => {
    const open = run([...H0_TO_H4, [119, 121, 118.5, 120.5], ...flat(8, 120.8), [120.8, 122, 120.5, 121.6], ...flat(50, 121.6)], { now: T("09:56") });
    expect(open.phase).toBe("POSITION_OPEN");
    const restored = JSON.parse(JSON.stringify(open)) as H0H4State;
    const done = run([...H0_TO_H4, [119, 121, 118.5, 120.5], ...flat(8, 120.8), [120.8, 122, 120.5, 121.6], ...flat(50, 121.6)], { state: restored });
    expect(done.entry).toEqual(open.entry);
    expect(done.events.filter((e) => e.phase === "POSITION_OPEN")).toHaveLength(1);
    expect(done.exit).toMatchObject({ reason: "TARGET", price: 121.35, time: T("10:32") }); // the 10:31 bar trades 122
  });
  it("paper quotes: fills at the live ask when the signal is seen, exits when the bid reaches the resting sell", () => {
    const spotBars = spot(GREEN);
    const ceBars = minutes("09:15", ce.slice(0, 8));
    const at0947 = run(ce.slice(0, 8), { now: T("09:47") });
    expect(at0947.phase).toBe("WAITING_FOR_H4_BREAK");
    // 09:51:06 — the 09:50 bar is published, so the 09:45 candle is complete: signal, then BUY at the ask (not the past 09:50 open).
    let state = advanceH0H4(at0947, { now: T("09:51") + 0.1, spot: spotBars, ce: ceBars, quote: { bid: 120.4, ask: 120.55, at: T("09:51") + 0.1 } }, H0H4_DEFAULTS);
    expect(state.breakout!.signalAt).toBe(T("09:50"));
    expect(state.entry).toMatchObject({ price: 120.55, source: "LIVE_ASK", time: T("09:51") + 0.1 });
    state = advanceH0H4(state, { now: T("09:51") + 0.3, spot: spotBars, ce: ceBars.filter((bar) => bar.t < T("09:51")), quote: { bid: 120.9, ask: 121, at: T("09:51") + 0.3 } }, H0H4_DEFAULTS);
    expect(state.phase).toBe("POSITION_OPEN");
    state = advanceH0H4(state, { now: T("09:51") + 0.5, spot: spotBars, ce: ceBars.filter((bar) => bar.t < T("09:51")), quote: { bid: 121.35, ask: 121.45, at: T("09:51") + 0.5 } }, H0H4_DEFAULTS);
    expect(state.exit).toMatchObject({ reason: "TARGET", price: 121.35 });
  });
  it("without the CE tape nothing is finalised (no false end-of-day result)", () => {
    const mid = run(ce, { now: T("09:43") });
    expect(advanceH0H4(mid, { now: 1440, spot: spot(GREEN) }, H0H4_DEFAULTS)).toBe(mid);
  });
  it("a new session starts empty (no state leaks from an old one)", () => {
    const fresh = createH0H4Session("2026-11-18");
    expect(fresh.levels).toEqual({ H0: null, H1: null, H2: null, H3: null, H4: null });
    expect(fresh.entry).toBeNull();
    expect(fresh.events).toEqual([]);
  });
});

describe("report", () => {
  it("counts the funnel, trades, wins and timings", () => {
    const win = run([...H0_TO_H4, [119, 121, 118.5, 120.5], [120.6, 122, 120, 121.8], ...flat(60, 121.8)]);
    const red = run(H0_TO_H4, { open: [24337, 24345, 24290, 24300] });
    const never = run([...H0_TO_H4, ...flat(68, 119)]);
    const r = h0h4Report([win, red, never]);
    expect(r.overall).toMatchObject({ sessions: 3, greenOpen: 2, redOpen: 1, h0: 2, h3: 2, h4: 2, validH4: 2, h4Breakout: 1, trades: 1, targetHits: 1, noEntrySessions: 2 });
    // ₹0.65 × 65 = ₹42.25 gross is less than the charges: a target hit can still be a net loss.
    expect(r.overall.wins + r.overall.losses).toBe(1);
    expect(r.analysis.h4NeverBroke).toBe(1);
    expect(r.analysis.avgH0toH1).toBe(10);
    expect(r.years).toHaveLength(1);
  });
});

describe("1-minute and 3-minute versions (research)", () => {
  /** n 1-minute bars per candle whose aggregate is exactly (o, h, l, c). */
  function bars(n: 1 | 3, candles: OHLC[]): Bar[] {
    return candles.flatMap(([o, h, l, c], k) => {
      const t = T("09:15") + n * k;
      return n === 1 ? [{ t, open: o, high: h, low: l, close: c, volume: 100 }]
        : [{ t, open: o, high: o, low: l, close: l, volume: 100 }, { t: t + 1, open: l, high: h, low: l, close: h, volume: 100 }, { t: t + 2, open: h, high: h, low: c, close: c, volume: 100 }];
    });
  }
  const path: OHLC[] = [...H0_TO_H4, [119, 121, 118.5, 120.5], [120.6, 122, 120, 121.8]];
  for (const [n, settings] of [[1, H0H4_1MIN], [3, H0H4_3MIN]] as const) {
    it(`${n}-minute: opening candle = 09:15–09:${15 + n}, same levels, entry after the ${n}-minute H4 breakout`, () => {
      const total = 375 / n;
      const spotBars = bars(n, [GREEN, ...Array.from({ length: total - 1 }, (): OHLC => [GREEN[3], GREEN[3], GREEN[3], GREEN[3]])]);
      const ce = bars(n, [...path, ...flat(total - path.length, 121.8)]);
      let state = advanceH0H4(createH0H4Session("2026-11-17"), { now: 1440, spot: spotBars }, settings);
      expect(state.strike).toBe(24350);
      state = selectContract(state, contract(24350), T("09:15") + n);
      state = advanceH0H4(state, { now: 1440, spot: spotBars, ce }, settings);
      expect([state.levels.H0!.price, state.levels.H1!.price, state.levels.H2!.price, state.levels.H3!.price, state.levels.H4!.price]).toEqual([108, 110, 113, 118, 120]);
      expect(state.levels.H1!.candle).toBe(T("09:15") + 2 * n);
      expect(state.breakout!.signalAt).toBe(T("09:15") + 7 * n);
      expect(state.entry).toMatchObject({ time: T("09:15") + 7 * n, quoted: 120.6, price: 120.7 });
      expect(state.exit!.reason).toBe("TARGET");
    });
  }
  it("an incomplete 1-minute NIFTY bar is never used", () => {
    expect(advanceH0H4(createH0H4Session("2026-11-17"), { now: T("09:15") + 0.5, spot: bars(1, [GREEN]) }, H0H4_1MIN).phase).toBe("WAITING_FOR_OPEN");
  });
});

describe("opening colour modes (research)", () => {
  const RED: OHLC = [24337, 24345, 24290, 24300]; // close 24,300 → ATM 24,300
  it("default (spec): a red opening skips", () => {
    expect(advanceH0H4(createH0H4Session("2026-11-17"), { now: 1440, spot: spot(RED) }, H0H4_DEFAULTS).reason).toBe("RED_OPEN");
  });
  it("both-ce: a red opening also buys the ATM CE; both-pe: it buys the ATM PE; neutral still skips", () => {
    const ce = advanceH0H4(createH0H4Session("2026-11-17"), { now: 1440, spot: spot(RED) }, { ...H0H4_DEFAULTS, openColour: "both-ce" });
    expect(ce).toMatchObject({ phase: "SELECTING_ATM", color: "RED", right: "CE", strike: 24300 });
    const pe = advanceH0H4(createH0H4Session("2026-11-17"), { now: 1440, spot: spot(RED) }, { ...H0H4_DEFAULTS, openColour: "both-pe" });
    expect(pe).toMatchObject({ phase: "SELECTING_ATM", color: "RED", right: "PE" });
    expect(selectContract(pe, contract(24300), T("09:20")).reason).toBe("CONTRACT_UNAVAILABLE"); // a CE is refused on a PE day
    const put = selectContract(pe, { ...contract(24300), right: "PE", symbol: "NIFTY 17-NOV-2026 24300 PE" }, T("09:20"));
    expect(put.phase).toBe("WAITING_FOR_H0");
    const done = advanceH0H4(put, { now: 1440, spot: spot(RED), ce: minutes("09:15", [...H0_TO_H4, [119, 121, 118.5, 120.5], [120.6, 122, 120, 121.8], ...flat(60, 121.8)]) }, { ...H0H4_DEFAULTS, openColour: "both-pe" });
    expect(done.exit!.reason).toBe("TARGET");
    expect(advanceH0H4(createH0H4Session("2026-11-17"), { now: 1440, spot: spot([24300, 24345, 24290, 24300]) }, { ...H0H4_DEFAULTS, openColour: "both-pe" }).reason).toBe("NEUTRAL_OPEN");
  });
});

describe("H2 version — Fib 0.5 = H2, BUY on a close above 0.5, SELL at 0.618 (user, 17 Nov 2026)", () => {
  const UP_TO_H2 = H0_TO_H4.slice(0, 4); // H0 108, L 104, H1 110, H2 113 (09:30 candle)
  it("Fib from H2: 0.618 = 104 + (113 − 104) × 1.236 = 115.124; close above 113 → BUY, target fills", () => {
    const ce: OHLC[] = [...UP_TO_H2, [111, 114.5, 110.5, 114], [114, 115.5, 113.8, 115.3], ...flat(60, 115.3)];
    const state = run(ce, { settings: H0H4_H2_ANCHOR });
    expect(state.fib!.f05).toBeCloseTo(113, 12);
    expect(state.fib!.f0618).toBeCloseTo(115.124, 9);
    expect(state.fib!.targetOrder).toBe(115.15);
    expect(state.levels.H3).toBeNull();
    expect(state.levels.H4).toBeNull();
    expect(state.breakout).toMatchObject({ candle: T("09:35"), close: 114 });
    expect(state.entry).toMatchObject({ time: T("09:40"), price: 114.1 });
    expect(state.exit).toMatchObject({ reason: "TARGET", price: 115.15 });
    expect(state.phase).toBe("TARGET_COMPLETED");
  });
  it("the same tape on the spec (H3) version does not trade from H2", () => {
    const ce: OHLC[] = [...UP_TO_H2, [111, 114.5, 110.5, 114], [114, 115.5, 113.8, 115.3], ...flat(60, 115.3)];
    const state = run(ce);
    expect(state.levels.H3).toMatchObject({ price: 114.5 });
    expect(state.entry).toBeNull();
  });
  it("no close above H2 → no trade (H2_NEVER_BROKEN)", () => {
    const state = run([...UP_TO_H2, ...flat(70, 112)], { settings: H0H4_H2_ANCHOR });
    expect(state.outcome).toBe("NO_ENTRY");
    expect(state.reason).toBe("H2_NEVER_BROKEN");
  });
  it("0.618 reached before the 0.5 break (or on the breakout candle) → skipped", () => {
    const wick = run([...UP_TO_H2, [112, 115.2, 111.5, 112.5], ...flat(70, 114)], { settings: H0H4_H2_ANCHOR });
    expect(wick.reason).toBe("TARGET_BEFORE_ENTRY");
    const onBreak = run([...UP_TO_H2, [111, 118, 110, 116], ...flat(70, 116)], { settings: H0H4_H2_ANCHOR });
    expect(onBreak.reason).toBe("TARGET_BEFORE_ENTRY");
    expect(onBreak.entry).toBeNull();
  });
});

describe("fixed target and touch entry (research: buy @100 on the H4 break, sell @102)", () => {
  const ce: OHLC[] = [...H0_TO_H4, [119, 121, 118.5, 120.5], [120.6, 124, 120, 123.5], ...flat(60, 123.5)];
  it("close entry + 2%: sell order = buy price × 1.02, rounded up to the tick", () => {
    const state = run(ce, { settings: { ...H0H4_DEFAULTS, targetPct: 2 } });
    expect(state.entry).toMatchObject({ price: 120.7, source: "BAR_OPEN" });
    expect(state.sellOrder).toBe(123.15); // 120.70 × 1.02 = 123.114
    expect(state.exit).toMatchObject({ reason: "TARGET", price: 123.15 });
  });
  it("close entry + 2 points", () => {
    const state = run(ce, { settings: { ...H0H4_DEFAULTS, targetPoints: 2 } });
    expect(state.sellOrder).toBe(122.7);
    expect(state.exit!.price).toBe(122.7);
  });
  it("touch entry: stop-buy one tick above H4, filled inside the 09:46 bar; target counted from the next bar", () => {
    const state = run(ce, { settings: { ...H0H4_DEFAULTS, entryMode: "touch", targetPct: 2 } });
    expect(state.levels.H4!.price).toBe(120);
    expect(state.entry).toMatchObject({ time: T("09:46"), quoted: 120.05, price: 120.15, source: "STOP_TOUCH" });
    expect(state.sellOrder).toBe(122.6); // 120.15 × 1.02 = 122.553
    expect(state.exit).toMatchObject({ reason: "TARGET", price: 122.6, time: T("09:52") }); // the 09:51 bar trades 124
  });
  it("touch entry: a bar opening above H4 fills at its open; at/above Fib 0.618 it is skipped", () => {
    const gap = run([...H0_TO_H4, [120.5, 121, 120.2, 120.8], ...flat(60, 120.8)], { settings: { ...H0H4_DEFAULTS, entryMode: "touch" } });
    expect(gap.entry).toMatchObject({ source: "GAP_OPEN", quoted: 120.5, price: 120.6 });
    const late = run([...H0_TO_H4, [121.5, 122, 121, 121.5], ...flat(60, 121.5)], { settings: { ...H0H4_DEFAULTS, entryMode: "touch" } });
    expect(late.reason).toBe("TARGET_BEFORE_ENTRY");
  });
  it("defaults are unchanged: Fib 0.618 target, close entry", () => {
    expect(H0H4_DEFAULTS).toMatchObject({ targetPct: 0, targetPoints: 0, entryMode: "close" });
  });
});

describe("CURRENT rules (user correction): 1-minute, a level breaks when a later HIGH goes above it, BUY on the H4 touch", () => {
  // Real 16 Nov 2026 NIFTY 17-NOV 25300 CE 1-minute candles (Dhan), 09:15–09:57.
  const NOV16: [string, number, number, number, number][] = [
    ["09:15", 85.45, 119.75, 85.0, 118.25],
    ["09:16", 120.35, 128.7, 101.6, 101.6],
    ["09:17", 101.05, 101.05, 83.6, 85.8],
    ["09:18", 86.55, 95.5, 85.1, 92.65],
    ["09:19", 93.95, 94.95, 87.8, 87.8],
    ["09:20", 88.9, 93.1, 86.1, 86.1],
    ["09:21", 86.25, 96.0, 85.6, 96.0],
    ["09:22", 95.2, 95.2, 80.4, 80.9],
    ["09:23", 82.55, 88.9, 82.55, 86.2],
    ["09:24", 87.7, 92.25, 84.1, 86.75],
    ["09:25", 85.55, 91.1, 84.55, 85.05],
    ["09:26", 85.75, 87.65, 78.0, 79.3],
    ["09:27", 78.65, 81.35, 73.5, 78.75],
    ["09:28", 80.8, 80.8, 73.2, 74.6],
    ["09:29", 75.0, 80.5, 71.7, 79.8],
    ["09:30", 80.85, 87.4, 80.85, 86.2],
    ["09:31", 84.75, 87.25, 82.5, 85.6],
    ["09:32", 86.25, 93.35, 83.85, 92.0],
    ["09:33", 93.35, 95.3, 86.35, 90.35],
    ["09:34", 89.45, 92.65, 88.2, 92.65],
    ["09:35", 93.25, 93.85, 88.6, 93.35],
    ["09:36", 93.8, 93.8, 89.7, 91.35],
    ["09:37", 90.35, 92.5, 89.3, 92.5],
    ["09:38", 93.8, 98.6, 92.2, 97.15],
    ["09:39", 97.1, 100.6, 95.4, 100.05],
    ["09:40", 101.9, 108.05, 100.2, 100.85],
    ["09:41", 101.0, 103.5, 96.55, 97.55],
    ["09:42", 98.55, 104.7, 97.65, 102.45],
    ["09:43", 100.7, 101.95, 98.0, 98.55],
    ["09:44", 98.95, 107.55, 98.65, 107.55],
    ["09:45", 106.65, 115.5, 106.65, 113.35],
    ["09:46", 113.25, 119.7, 112.9, 117.75],
    ["09:47", 116.15, 117.45, 110.45, 114.25],
    ["09:48", 115.0, 119.7, 114.75, 118.7],
    ["09:49", 119.3, 119.5, 113.85, 115.0],
    ["09:50", 115.7, 129.15, 115.45, 129.0],
    ["09:51", 128.55, 130.0, 121.0, 123.3],
    ["09:52", 122.05, 126.75, 119.15, 126.75],
    ["09:53", 126.95, 126.95, 122.2, 123.45],
    ["09:54", 123.2, 132.5, 123.15, 128.15],
    ["09:55", 126.6, 132.7, 123.65, 132.5],
    ["09:56", 133.25, 134.5, 126.0, 127.6],
    ["09:57", 127.7, 130.4, 126.8, 129.55],
  ];
  const ceBars: Bar[] = NOV16.map(([clock, open, high, low, close]) => ({ t: T(clock), open, high, low, close, volume: 1000 }));
  const spot1: Bar[] = [{ t: T("09:15"), open: 25206.15, high: 25293.45, low: 25195.35, close: 25292.35 }, ...Array.from({ length: 60 }, (_, k) => ({ t: T("09:16") + k, open: 25290, high: 25290, low: 25290, close: 25290 }))];
  it("defaults: 1-minute, high breaks, touch entry, Fib 0.618 target", () => {
    expect(CURRENT).toMatchObject({ candleMinutes: 1, breakMode: "high", entryMode: "touch", targetPct: 0, targetPoints: 0 });
  });
  it("16 Nov 2026 gives the user's levels: H0 119.75, H1 128.70 (09:16), H2 129.15 (09:50), H3 130.00 (09:51), H4 132.50 (09:54)", () => {
    let state = advanceH0H4(createH0H4Session("2026-11-16"), { now: T("09:58"), spot: spot1 }, CURRENT);
    expect(state).toMatchObject({ color: "GREEN", strike: 25300 });
    state = selectContract(state, { ...contract(25300), expiry: "2026-11-17", symbol: "NIFTY 17-NOV-2026 25300 CE" }, T("09:16"));
    state = advanceH0H4(state, { now: T("09:58"), spot: spot1, ce: ceBars }, CURRENT);
    const lv = state.levels;
    expect([lv.H0!.price, lv.H1!.price, lv.H2!.price, lv.H3!.price, lv.H4!.price]).toEqual([119.75, 128.7, 129.15, 130, 132.5]);
    expect([lv.H0!.candle, lv.H1!.candle, lv.H2!.candle, lv.H3!.candle, lv.H4!.candle]).toEqual([T("09:15"), T("09:16"), T("09:50"), T("09:51"), T("09:54")]);
    expect(state.initial!.low).toBe(85);
    expect(state.fib!.f0618).toBeCloseTo(85 + 45 * 1.236, 9); // 140.62
    expect(state.h4Valid).toBe(true);
    // 09:55 trades 132.70 > H4 132.50: stop-buy at 132.55 + 2 ticks.
    expect(state.entry).toMatchObject({ time: T("09:55"), quoted: 132.55, price: 132.65, source: "STOP_TOUCH" });
    expect(state.sellOrder).toBe(140.65);
    expect(state.phase).toBe("POSITION_OPEN");
  });
  it("paper: the touch is only known on the next tick, so it fills at the live ask (never a past price)", () => {
    let state = advanceH0H4(createH0H4Session("2026-11-16"), { now: T("09:55") + 0.1, spot: spot1 }, CURRENT);
    state = selectContract(state, { ...contract(25300), expiry: "2026-11-17" }, T("09:16"));
    const upTo = (m: number) => ceBars.filter((bar) => bar.t + 1 <= m);
    // 09:55:06: the 09:54 candle (H4) is not confirmed complete until the 09:55 bar is published — no H4 yet.
    state = advanceH0H4(state, { now: T("09:55") + 0.1, spot: spot1, ce: upTo(T("09:55") + 0.1), quote: { bid: 128, ask: 128.2, ltp: 128.15, at: T("09:55") + 0.1 } }, CURRENT);
    expect(state.phase).toBe("WAITING_FOR_H4");
    // 09:56:30: the 09:55 bar is published — it completes H4 (132.50) and shows the break (high 132.70): BUY at the live ask now.
    state = advanceH0H4(state, { now: T("09:56") + 0.5, spot: spot1, ce: upTo(T("09:56") + 0.5), quote: { bid: 132.55, ask: 132.6, ltp: 132.6, at: T("09:56") + 0.5 } }, CURRENT);
    expect(state.levels.H4!.price).toBe(132.5);
    expect(state.entry).toMatchObject({ source: "LIVE_ASK", price: 132.6 });
  });
});
