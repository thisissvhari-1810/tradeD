import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAlgoConfig, algoConfigProblems } from "@/lib/algo/config";
import { ALL_LINE_TYPES, strategyLines, type AlgoLine, type Candle } from "@/lib/algo/lines";
import { atmStrike, candleExit, protectiveLevels, quoteExit, resolveAtm, strikeInterval, tradeStrike, type ChainInput } from "@/lib/algo/options";
import { advance, ALGO_DEFAULTS, initialState, regimeStatus, startExit, type AlgoConfig, type AlgoEvent, type AlgoState, type ContractRef, type ExecutionAdapter, type Fill, type Mark } from "@/lib/algo/runner";
import { bodyCross, consolidate, evaluateCandle } from "@/lib/algo/signals";
import type { S1Data } from "@/lib/trading/s1";

/* ---------------- fixtures ---------------- */

const DATE = "2026-10-26";
const OPEN = Date.UTC(2026, 9, 26, 3, 45) / 1000; // 09:15 IST
const at = (minute: number) => OPEN + minute * 60;
const bar = (minute: number, open: number, high: number, low: number, close: number): Candle => ({ time: at(minute), open, high, low, close });

const s1: S1Data = {
  symbol: "NIFTY",
  date: DATE,
  sessionOpen: OPEN,
  sessionClose: OPEN + 375 * 60,
  status: "ready",
  message: "",
  previous: { date: "2026-10-23", high: 24_000, low: 23_800, close: 23_950 } as S1Data["previous"],
  open: 23_990,
  firstMinute: { time: OPEN, open: 23_990, high: 24_020, low: 23_970 },
};
const lines = strategyLines(s1, [{ id: "extra", label: "My level", price: 23_700 }]);
const lineOf = (type: AlgoLine["type"]) => lines.find((line) => line.type === type)!;
const all = () => true;
const NOW = at(400);

/** A candle pair crossing `price` down (bearish) or up (bullish), from minute 30. */
function crossing(price: number, direction: "DOWN" | "UP", minute = 30): [Candle, Candle] {
  return direction === "DOWN"
    ? [bar(minute, price + 8, price + 10, price + 4, price + 6), bar(minute + 1, price + 5, price + 7, price - 9, price - 6)]
    : [bar(minute, price - 8, price - 4, price - 10, price - 6), bar(minute + 1, price - 5, price + 9, price - 7, price + 6)];
}

function decide(price: number, direction: "DOWN" | "UP", only?: AlgoLine) {
  const [previous, candle] = crossing(price, direction);
  return evaluateCandle({ previous, candle, lines: only ? [only] : lines, enabled: all, now: NOW });
}

/** A chain around 23,987 with 50-point strikes, lot size 75, fresh quotes. */
function chain(now: number, overrides: Partial<ChainInput> = {}): ChainInput {
  const strikes = Array.from({ length: 9 }, (_, index) => 23_800 + index * 50).map((strike) => ({
    strike,
    ce: { ltp: 100, bid: 100, ask: 101, securityId: `${strike}CE` },
    pe: { ltp: 100, bid: 100, ask: 101, securityId: `${strike}PE` },
  }));
  return { underlying: "NIFTY", spot: 23_987, expiry: "2026-10-28", asOf: new Date(now * 1000).toISOString(), lotSize: 75, strikes, ...overrides };
}

/** An in-memory execution adapter that records every order (and can be told to misbehave). */
function fakeAdapter(options: { cash?: number; bid?: number | null; candle?: Mark["candle"]; enter?: (key: string) => Fill; exit?: (key: string, quantity: number) => Fill; kind?: ExecutionAdapter["kind"]; orders?: Map<string, Fill>; chain?: (now: number) => ChainInput } = {}) {
  const orders = options.orders ?? new Map<string, Fill>();
  const calls = { enter: 0, exit: 0 };
  let cash = options.cash ?? 1_000_000;
  let clock = NOW;
  const adapter: ExecutionAdapter & { calls: typeof calls; orders: Map<string, Fill>; set: (patch: { bid?: number | null; candle?: Mark["candle"] }) => void; cashNow: () => number; tick: (now: number) => void } = {
    kind: options.kind ?? "paper",
    calls,
    orders,
    set(patch) { Object.assign(options, patch); },
    cashNow: () => cash,
    tick(now) { clock = now; },
    health: async () => ({ ok: true }),
    cash: async () => cash,
    charges: () => 20,
    chain: async () => (options.chain ?? ((now: number) => chain(now)))(clock),
    mark: async () => (options.bid === undefined && !options.candle ? { bid: 100, ask: 101, candle: null, asOf: clock } : options.bid === null ? null : { bid: options.bid ?? null, ask: options.bid ?? null, candle: options.candle ?? null, asOf: clock }),
    async enter(order) {
      calls.enter += 1;
      if (orders.has(order.key)) return orders.get(order.key)!;
      const fill = options.enter ? options.enter(order.key) : ({ status: "FILLED", quantity: order.quantity, price: order.price, charges: 20 } as Fill);
      if (fill.status !== "UNKNOWN") orders.set(order.key, fill);
      if (fill.status === "FILLED" || fill.status === "PARTIAL") cash -= fill.price * fill.quantity + fill.charges;
      return fill;
    },
    async exit(order) {
      calls.exit += 1;
      if (orders.has(order.key)) return orders.get(order.key)!;
      const fill = options.exit ? options.exit(order.key, order.quantity) : ({ status: "FILLED", quantity: order.quantity, price: order.price, charges: 20 } as Fill);
      if (fill.status !== "UNKNOWN") orders.set(order.key, fill);
      if (fill.status === "FILLED" || fill.status === "PARTIAL") cash += fill.price * fill.quantity - fill.charges;
      return fill;
    },
    lookup: async (key) => orders.get(key) ?? null,
  };
  return adapter;
}

const running = (patch: Partial<AlgoState> = {}): AlgoState => ({ ...initialState(DATE), running: true, entries: true, lastCandle: at(29), ...patch });
// The core engine's tests run with the entry filters and the structure stop off (they have their own tests).
const config = (patch: Partial<AlgoConfig> = {}): AlgoConfig => ({ ...ALGO_DEFAULTS, stopLoss: true, crossRule: "classic", crossPercent: 0, confirmation: { ...ALGO_DEFAULTS.confirmation, mode: "single" }, stopAtLimit: true, intrabar: false, risk: { ...ALGO_DEFAULTS.risk, stopAtTarget: false }, stop: { mode: "percent", value: 20 }, target: { mode: "percent", value: 40 }, lots: 1, sizing: "fixed", entryCutoff: "15:00", maxDailyLoss: 5_000, strategies: { line: true, trendline: true, w: true, m: true, orb: false, bounce: false, rejection: false }, cooldownMinutes: 0, filters: { levelBlockMinutes: 0, breakoutBufferPercent: 0, secondCandle: false, momentum: false }, structureStop: false, ...patch });

async function step(state: AlgoState, candles: Candle[], adapter: ReturnType<typeof fakeAdapter>, now = candles.at(-1)!.time + 60, cfg = config(), useLines = lines) {
  adapter.tick(now);
  return advance(state, { sessionId: "s1", sessionDate: DATE, config: cfg, candles, lines: useLines, now, adapter });
}

/* ---------------- 1-17: line discovery and crossing detection ---------------- */

describe("strategy lines", () => {
  it("monitors every strategy line type (plus extra levels) with stable ids and real prices", () => {
    expect(new Set(lines.map((line) => line.type))).toEqual(new Set([...ALL_LINE_TYPES, "custom"]));
    expect(lineOf("prev-box-mid").price).toBe(23_950); // midpoint = previous close
    expect(lineOf("prev-box-top").price).toBe(24_050);
    expect(lineOf("today-box-mid").price).toBe(23_990); // midpoint = today's open
    expect(lineOf("prev-mid").price).toBe(23_900);
    expect(lineOf("or-high").activeFrom).toBe(OPEN + 60); // known once the 09:15 candle finishes
    expect(strategyLines(s1).map((line) => line.id)).toEqual(strategyLines(s1).map((line) => line.id));
    expect(lineOf("prev-high").id).toBe(`${DATE}:prev-high`);
  });
});

describe("1-minute body crossings", () => {
  const cases: Array<[string, AlgoLine["type"]]> = [
    ["9:15 low line", "or-low"], ["9:15 high line", "or-high"], ["previous-day box midpoint", "prev-box-mid"], ["today's box midpoint", "today-box-mid"],
    ["previous-day box top", "prev-box-top"], ["previous-day box bottom", "prev-box-bottom"], ["today's box top", "today-box-top"], ["today's box bottom", "today-box-bottom"],
    ["today's open", "today-open"], ["previous close", "prev-close"], ["previous high", "prev-high"], ["previous low", "prev-low"], ["previous mid-range", "prev-mid"], ["extra level", "custom"],
  ];
  for (const [name, type] of cases) {
    it(`${name}: a downward body crossing is a PUT, an upward one a CALL`, () => {
      const line = lineOf(type);
      expect(decide(line.price, "DOWN", line).decision).toBe("PUT");
      expect(decide(line.price, "UP", line).decision).toBe("CALL");
    });
  }

  it("ignores disabled lines", () => {
    const line = lineOf("or-low");
    const [previous, candle] = crossing(line.price, "DOWN");
    expect(evaluateCandle({ previous, candle, lines: [line], enabled: () => false, now: NOW }).decision).toBe("NO_SIGNAL");
    const cfg = readAlgoConfig({ disabledLines: ["or-low", "bogus"] });
    expect(cfg.disabledLines).toEqual(["or-low"]);
  });

  it("does not signal while price stays below (or above) a line", () => {
    const line = lineOf("or-low");
    const below = evaluateCandle({ previous: bar(30, line.price - 20, line.price - 15, line.price - 30, line.price - 25), candle: bar(31, line.price - 25, line.price - 12, line.price - 40, line.price - 35), lines: [line], enabled: all, now: NOW });
    const above = evaluateCandle({ previous: bar(30, line.price + 20, line.price + 30, line.price + 15, line.price + 25), candle: bar(31, line.price + 25, line.price + 40, line.price + 12, line.price + 35), lines: [line], enabled: all, now: NOW });
    expect([below.decision, above.decision]).toEqual(["NO_SIGNAL", "NO_SIGNAL"]);
  });

  it("does not signal on a wick-only crossing", () => {
    const result = bodyCross({ close: 105 }, { open: 104, high: 106, low: 98, close: 103 }, 100);
    expect(result.kind).toBe("WICK");
  });

  it("never confirms a candle that is still forming", () => {
    const [previous, candle] = crossing(lineOf("or-low").price, "DOWN");
    expect(evaluateCandle({ previous, candle, lines, enabled: all, now: candle.time + 30 }).decision).toBe("FORMING");
  });

  it("treats exact line touches and gaps deterministically as no signal", () => {
    expect(bodyCross({ close: 100 }, { open: 101, high: 102, low: 97, close: 98 }, 100).kind).toBe("BOUNDARY");
    expect(bodyCross({ close: 102 }, { open: 100, high: 101, low: 97, close: 98 }, 100).kind).toBe("BOUNDARY");
    expect(bodyCross({ close: 102 }, { open: 101, high: 102, low: 99, close: 100 }, 100).kind).toBe("BOUNDARY");
    expect(bodyCross({ close: 102 }, { open: 98, high: 99, low: 96, close: 97 }, 100).kind).toBe("GAP");
    expect(bodyCross({ close: 100.01 }, { open: 100.02, high: 100.05, low: 99.9, close: 99.99 }, 100).direction).toBe("DOWN");
  });

  it("records every line crossed by one candle but makes one decision", () => {
    // One big bearish candle through the 9:15 low, today's open and today's box midpoint.
    const evaluation = evaluateCandle({ previous: bar(30, 24_010, 24_030, 24_000, 24_025), candle: bar(31, 24_024, 24_026, 23_940, 23_945), lines, enabled: all, now: NOW });
    expect(evaluation.events.length).toBeGreaterThan(2);
    expect(evaluation.events.every((event) => event.direction === "DOWN")).toBe(true);
    expect(evaluation.decision).toBe("PUT");
  });

  it("makes conflicting directions on one candle a CONFLICTING_SIGNAL with no entry", () => {
    const event = (direction: "UP" | "DOWN", label: string) => ({ lineId: label, lineType: "custom" as const, label, price: 100, direction });
    expect(consolidate([event("DOWN", "A"), event("DOWN", "B")]).decision).toBe("PUT");
    expect(consolidate([event("UP", "A")]).decision).toBe("CALL");
    const conflict = consolidate([event("DOWN", "Moved level"), event("UP", "Previous-day low")]);
    expect(conflict.decision).toBe("CONFLICTING_SIGNAL");
    expect(conflict.explanation).toMatch(/Conflict policy: no entry/);
    // With one session's fixed levels a single body cannot cross down and up at once.
    for (let level = 95; level <= 105; level += 0.5) {
      for (const candle of [{ open: 99, high: 104, low: 96, close: 103 }, { open: 103, high: 104, low: 96, close: 97 }]) {
        const kinds = [bodyCross({ close: 100.2 }, candle, level).direction, bodyCross({ close: 100.2 }, candle, level + 1).direction].filter(Boolean);
        expect(new Set(kinds).size).toBeLessThanOrEqual(1);
      }
    }
  });

  it("never pairs a session's first candle with the previous day (no artificial crossings at the open)", () => {
    const yesterday = { time: OPEN - 86_400 + 374 * 60, open: 24_100, high: 24_110, low: 24_090, close: 24_100 };
    const first = bar(0, 23_990, 24_020, 23_970, 24_000);
    expect(evaluateCandle({ previous: yesterday, candle: first, lines, enabled: all, now: NOW }).decision).toBe("NO_PREVIOUS");
    // A level not yet known when the previous candle formed is not compared (the 9:15 lines vs the 09:15 candle).
    const evaluation = evaluateCandle({ previous: bar(0, 23_990, 24_020, 23_970, 24_000), candle: bar(1, 23_999, 24_005, 23_960, 23_965), lines: [lineOf("or-low")], enabled: all, now: NOW });
    expect(evaluation.events).toHaveLength(0);
  });
});

/* ---------------- 18-20: ATM option selection ---------------- */

describe("ATM option selection", () => {
  it("uses the chain's own strike interval and rounding policy", () => {
    expect(strikeInterval([23_800, 23_850, 23_900, 24_000])).toBe(50);
    expect(strikeInterval([51_000, 51_100, 51_200, 51_300])).toBe(100);
    expect(atmStrike([23_950, 24_000, 24_050], 23_987, "nearest")).toBe(24_000);
    expect(atmStrike([23_950, 24_000, 24_050], 23_987, "down")).toBe(23_950);
    expect(atmStrike([23_950, 24_000, 24_050], 23_975, "nearest")).toBe(23_950); // tie → lower strike
    const now = NOW;
    const call = resolveAtm(chain(now), "CE", { rounding: "nearest", maxQuoteAgeSeconds: 60, maxSpreadPercent: 5 }, new Date(now * 1000));
    const put = resolveAtm(chain(now), "PE", { rounding: "nearest", maxQuoteAgeSeconds: 60, maxSpreadPercent: 5 }, new Date(now * 1000));
    expect(call.ok && [call.contract.strike, call.contract.right, call.contract.securityId, call.contract.lotSize]).toEqual([24_000, "CE", "24000CE", 75]);
    expect(put.ok && [put.contract.strike, put.contract.right, put.contract.securityId]).toEqual([24_000, "PE", "24000PE"]);
  });

  it("moves one listed strike in the money when asked: a CALL's lower strike, a PUT's higher one", () => {
    const strikes = [23_900, 23_950, 24_000, 24_050, 24_100];
    expect(tradeStrike(strikes, 24_010, "nearest", "CE", 0)).toBe(24_000);
    expect(tradeStrike(strikes, 24_010, "nearest", "CE", 1)).toBe(23_950);
    expect(tradeStrike(strikes, 24_010, "nearest", "PE", 1)).toBe(24_050);
    expect(tradeStrike(strikes, 24_090, "nearest", "PE", 1)).toBeNull(); // not listed: no trade, never a silent ATM
  });

  it("rejects missing contracts, stale quotes, wide spreads and unknown lot sizes", () => {
    const limits = { rounding: "nearest" as const, maxQuoteAgeSeconds: 60, maxSpreadPercent: 5 };
    const now = new Date(NOW * 1000);
    const missing = chain(NOW);
    missing.strikes = missing.strikes.map((row) => (row.strike === 24_000 ? { ...row, pe: null } : row));
    expect(resolveAtm(missing, "PE", limits, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/not listed/) });
    expect(resolveAtm(chain(NOW - 600), "CE", limits, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/Stale option quote/) });
    const wide = chain(NOW);
    wide.strikes = wide.strikes.map((row) => ({ ...row, ce: row.ce && { ...row.ce, bid: 80, ask: 120 } }));
    expect(resolveAtm(wide, "CE", limits, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/spread/) });
    expect(resolveAtm(chain(NOW, { lotSize: 0 }), "CE", limits, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/lot size/) });
    expect(resolveAtm(chain(NOW, { spot: null }), "CE", limits, now)).toMatchObject({ ok: false });
  });

  it("rejects an entry the account cannot pay for, and invalid quantities", async () => {
    const adapter = fakeAdapter({ cash: 1_000 });
    const [previous, candle] = crossing(lineOf("or-low").price, "DOWN");
    const { state, events } = await step(running(), [previous, candle], adapter);
    expect(adapter.calls.enter).toBe(0);
    expect(state.position).toBeNull();
    expect(events.find((event) => event.kind === "REJECTED")?.message).toMatch(/Insufficient buying power/);
    expect(algoConfigProblems(readAlgoConfig({ lots: 1.5, settingsVersion: 7, sizing: "fixed" }))).toContain("Quantity must be 1 to 50 lots.");
    expect(algoConfigProblems(readAlgoConfig({ lots: 1.5, settingsVersion: 7, sizing: "risk" }))).toContain("Maximum lots must be 1 to 50.");
  });
});

/* ---------------- 21-27: entries, exits and failures ---------------- */

async function opened(options: Parameters<typeof fakeAdapter>[0] = {}, cfg = config()) {
  const adapter = fakeAdapter(options);
  const [previous, candle] = crossing(lineOf("or-low").price, "DOWN");
  const result = await step(running(), [previous, candle], adapter, undefined, cfg);
  return { adapter, candles: [previous, candle], ...result };
}

describe("entries and protective exits", () => {
  it("enters the ATM PUT with stop and target from the fill premium", async () => {
    const { state, events, adapter } = await opened();
    expect(adapter.calls.enter).toBe(1);
    expect(state.position).toMatchObject({ side: "PUT", quantity: 75, avg: 101.05, stop: 80.84, target: 141.47 });
    expect(state.status).toBe("POSITION_OPEN");
    expect(events.find((event) => event.kind === "ENTRY")?.message).toMatch(/ATM PUT 24000 2026-10-28 selected\. Entry accepted/);
  });

  it("validates stop and target settings", () => {
    expect(protectiveLevels(100, { mode: "percent", value: 20 }, { mode: "percent", value: 50 })).toEqual({ ok: true, stop: 80, target: 150 });
    expect(protectiveLevels(100, { mode: "points", value: 15 }, { mode: "points", value: 30 })).toEqual({ ok: true, stop: 85, target: 130 });
    expect(protectiveLevels(10, { mode: "points", value: 12 }, { mode: "points", value: 5 }).ok).toBe(false);
    expect(protectiveLevels(10, { mode: "percent", value: 0 }, { mode: "percent", value: 5 }).ok).toBe(false);
    expect(protectiveLevels(10, { mode: "percent", value: 100 }, { mode: "percent", value: 5 }).ok).toBe(false);
  });

  it("exits at the stop-loss on the option's own premium", async () => {
    const { state, adapter, candles } = await opened();
    adapter.set({ bid: 80 });
    const next = await step(state, [...candles, bar(32, 23_900, 23_910, 23_890, 23_905)], adapter);
    expect(next.state.position).toBeNull();
    const exit = next.events.find((event) => event.kind === "EXIT")!;
    expect(exit.message).toMatch(/Exit \(STOP\)/);
    expect(exit.order?.price).toBe(79.95); // the bid less one tick of slippage, not the stop price
    expect(next.state.realizedToday).toBeLessThan(0);
  });

  it("exits at the target", async () => {
    const { state, adapter, candles } = await opened();
    adapter.set({ bid: 150 });
    const next = await step(state, [...candles, bar(32, 23_900, 23_910, 23_890, 23_905)], adapter);
    expect(next.events.find((event) => event.kind === "EXIT")?.message).toMatch(/Exit \(TARGET\)/);
    expect(next.state.realizedToday).toBeGreaterThan(0);
  });

  it("does not assume an ideal fill when the premium gaps through the stop", () => {
    expect(candleExit({ open: 60, high: 65, low: 55, close: 58 }, 80, 140)).toMatchObject({ reason: "STOP", price: 60 });
    expect(quoteExit(60, 80, 140)).toMatchObject({ reason: "STOP", price: 60 });
  });

  it("takes the stop when one replay candle reaches both stop and target (conservative rule)", () => {
    expect(candleExit({ open: 100, high: 150, low: 75, close: 120 }, 80, 140)).toMatchObject({ reason: "STOP", price: 80 });
  });

  it("keeps the rest of the position after a partial exit, then exits it", async () => {
    let first = true;
    const { state, adapter, candles } = await opened({ exit: (_key, quantity) => (first ? ((first = false), { status: "PARTIAL", quantity: Math.floor(quantity / 3), price: 79.95, charges: 10 }) : { status: "FILLED", quantity, price: 79.95, charges: 10 }) });
    adapter.set({ bid: 80 });
    const partial = await step(state, [...candles, bar(32, 23_900, 23_910, 23_890, 23_905)], adapter);
    expect(partial.state.position?.quantity).toBe(50);
    const rest = await step(partial.state, [...candles, bar(32, 23_900, 23_910, 23_890, 23_905), bar(33, 23_905, 23_910, 23_890, 23_900)], adapter);
    expect(rest.state.position).toBeNull();
    expect(adapter.calls.exit).toBe(2);
  });

  it("does not re-send an entry whose outcome was unknown: it reconciles it", async () => {
    const orders = new Map<string, Fill>();
    const { state, adapter, candles } = await opened({ orders, enter: () => ({ status: "UNKNOWN", reason: "timeout" }) });
    expect(state.status).toBe("RECOVERY_REQUIRED");
    expect(state.pending?.uncertain).toBe(true);
    // The order did reach the broker: it is found by its key on the next check.
    orders.set(state.pending!.key, { status: "FILLED", quantity: 75, price: 101.05, charges: 20 });
    const next = await step(state, [...candles, bar(32, 23_900, 23_910, 23_890, 23_905)], adapter);
    expect(next.state.position?.quantity).toBe(75);
    expect(next.state.recovery).toBeNull();
    expect(adapter.calls.enter).toBe(1);
  });

  it("moves a failed exit into a visible recovery state", async () => {
    const { state, adapter, candles } = await opened({ exit: () => ({ status: "REJECTED", reason: "exchange rejected" }) });
    adapter.set({ bid: 70 });
    const next = await step(state, [...candles, bar(32, 23_900, 23_910, 23_890, 23_905)], adapter);
    expect(next.state.status).toBe("RECOVERY_REQUIRED");
    expect(next.state.recovery).toMatch(/exchange rejected/);
    expect(next.state.position).not.toBeNull();
  });
});

/* ---------------- 14-16, 28-31, 35: decisions over time, limits and restarts ---------------- */

describe("the algo over time", () => {
  it("places one order for one candle, however many lines it crosses or ticks repeat", async () => {
    const adapter = fakeAdapter();
    const candles = [bar(30, 24_010, 24_030, 24_000, 24_025), bar(31, 24_024, 24_026, 23_940, 23_945)];
    const first = await step(running(), candles, adapter);
    const again = await step(first.state, candles, adapter);
    // A second process with a stale copy of the state (a duplicate tick) finds the order by its key.
    const stale = await step(running(), candles, adapter);
    expect(adapter.calls.enter).toBe(1);
    expect(again.events.filter((event) => event.kind === "ENTRY")).toHaveLength(0);
    expect(stale.events.find((event) => event.kind === "REJECTED")?.message).toMatch(/Order already processed/);
  });

  it("blocks new entries at the trade-count limit and after the daily loss limit (risk lock)", async () => {
    const adapter = fakeAdapter();
    const candles = crossing(lineOf("or-low").price, "DOWN");
    const limited = await step(running({ tradesToday: 3 }), candles, adapter, undefined, config({ maxTrades: 3 }));
    expect(limited.events.find((event) => event.kind === "REJECTED")?.message).toMatch(/DAILY TRADE LIMIT REACHED — \d+\/\d+/);
    const locked = await step(running({ realizedToday: -6_000 }), candles, adapter, undefined, config({ maxDailyLoss: 5_000 }));
    expect(locked.state.riskLocked).toBe(true);
    expect(locked.state.status).toBe("RISK_LOCKED");
    expect(adapter.calls.enter).toBe(0);
  });

  it("blocks new entries from the 15:20 IST square-off, even inside a later entry window", async () => {
    const cfg = config({ entryCutoff: "15:30", squareOff: "15:20" });
    // Signal candle 15:18 (closes 15:19): entered. Signal candle 15:19 (closes 15:20): blocked by the square-off.
    const early = fakeAdapter();
    await step(running({ lastCandle: at(360) }), crossing(lineOf("or-low").price, "DOWN", 362), early, undefined, cfg);
    expect(early.calls.enter).toBe(1);
    const late = fakeAdapter();
    const blocked = await step(running({ lastCandle: at(361) }), crossing(lineOf("or-low").price, "DOWN", 363), late, undefined, cfg);
    expect(late.calls.enter).toBe(0);
    expect(blocked.events.find((event) => event.kind === "REJECTED")?.message).toMatch(/End-of-day square-off at 15:20 IST: no new entries/);
  });

  it("disabling entries blocks new trades but keeps protecting the open position", async () => {
    const { state, adapter, candles } = await opened();
    const disabled = { ...state, entries: false };
    adapter.set({ bid: 80 });
    const next = await step(disabled, [...candles, ...crossing(lineOf("or-high").price, "UP", 40).map((item) => item)], adapter);
    expect(next.events.some((event) => event.kind === "EXIT")).toBe(true);
    expect(adapter.calls.enter).toBe(1);
    expect(next.events.find((event) => event.kind === "REJECTED")?.message ?? "").toMatch(/disabled for new entries|Opposing|already open/);
  });

  it("never opens an opposing position: ignores it, or exits first and waits", async () => {
    const ignore = await opened();
    const up = crossing(lineOf("or-high").price, "UP", 40);
    const ignored = await step(ignore.state, [...ignore.candles, ...up], ignore.adapter);
    expect(ignored.state.position?.side).toBe("PUT");
    expect(ignore.adapter.calls.enter).toBe(1);
    const exitFirst = await opened({}, config({ opposingPolicy: "exit-first" }));
    const reversed = await step(exitFirst.state, [...exitFirst.candles, ...up], exitFirst.adapter, undefined, config({ opposingPolicy: "exit-first" }));
    expect(reversed.state.position).toBeNull(); // exited (confirmed)
    expect(exitFirst.adapter.calls.enter).toBe(1); // no reversal on the same candle
    expect(reversed.events.find((event) => event.kind === "REJECTED")?.message).toMatch(/exiting the open position first/);
  });

  it("restores and reconciles after a restart (state comes back from storage)", async () => {
    const orders = new Map<string, Fill>();
    const { state, candles } = await opened({ orders, exit: () => ({ status: "UNKNOWN", reason: "timeout" }) });
    const exiting = await step(state, [...candles, bar(32, 23_900, 23_910, 23_890, 23_905)], fakeAdapter({ orders, bid: 70, exit: () => ({ status: "UNKNOWN", reason: "timeout" }) }));
    expect(exiting.state.position?.exit?.uncertain).toBe(true);
    // Restart: the stored JSON is read back by a new process with a new adapter instance.
    const restored = JSON.parse(JSON.stringify(exiting.state)) as AlgoState;
    orders.set(restored.position!.exit!.key, { status: "FILLED", quantity: 75, price: 69.95, charges: 20 });
    const after = await step(restored, [...candles, bar(32, 23_900, 23_910, 23_890, 23_905), bar(33, 23_900, 23_910, 23_890, 23_905)], fakeAdapter({ orders }));
    expect(after.state.position).toBeNull();
    expect(after.state.recovery).toBeNull();
  });

  it("keeps cash, orders and realized P&L consistent from entry to exit", async () => {
    const { state, adapter, candles } = await opened({ cash: 100_000 });
    const afterEntry = adapter.cashNow();
    expect(afterEntry).toBeCloseTo(100_000 - 101.05 * 75 - 20, 2);
    adapter.set({ bid: 150 });
    const next = await step(state, [...candles, bar(32, 23_900, 23_910, 23_890, 23_905)], adapter);
    const pnl = next.state.realizedToday;
    expect(adapter.cashNow()).toBeCloseTo(100_000 + pnl, 2);
    expect(pnl).toBeCloseTo((149.95 - 101.05) * 75 - 20 - 20, 2);
  });

  it("starts a new day with fresh counters and never trades a signal evaluated late", async () => {
    const adapter = fakeAdapter();
    const yesterday = { ...running({ tradesToday: 3, realizedToday: -900, riskLocked: true }), sessionDate: "2026-10-23" };
    const candles = crossing(lineOf("or-low").price, "DOWN");
    const late = await step(yesterday, candles, adapter, candles[1].time + 60 + 600);
    expect([late.state.tradesToday, late.state.realizedToday, late.state.riskLocked]).toEqual([0, 0, false]);
    expect(adapter.calls.enter).toBe(0);
    expect(late.events.at(-1)?.message).toMatch(/evaluated late|No earlier completed candle|No new crossing/);
  });
});

/* ---------------- 32-33, 36: modes ---------------- */

describe("execution modes", () => {
  const server = readFileSync(join(process.cwd(), "src/server/algo.ts"), "utf8");

  it("historical replay only ever uses the replay adapter", () => {
    // The day simulation shared by the quick backtest and the multi-day backtest.
    const replay = server.slice(server.indexOf("async function simulateDay"), server.indexOf("async function runReplay"));
    expect(replay).toMatch(/replayAdapter\(/);
    expect(replay).not.toMatch(/paperAdapter\(|liveAdapter\(|callWorker|placeLiveOrder/);
    expect(replay).toMatch(/if \(adapter\.kind !== "replay"\) throw/);
  });

  it("signals always use completed 1-minute candles, whatever the chart shows", () => {
    expect(readAlgoConfig({ timeframe: "5m" }).timeframe).toBe("1m");
    expect(server).toMatch(/sessionMinuteTape\(config\.underlying, today\)/);
  });

  it("keeps live execution unavailable without a validated, authorized broker path", async () => {
    expect(server).toMatch(/env\.ALGO_LIVE_ENABLED !== "1"/);
    expect(server).toMatch(/if \(next\.mode === "LIVE"\) throw new AppError/);
    expect(server).not.toMatch(/callWorker|placeLiveOrder/);
    const { liveAdapter } = await import("@/lib/algo/live");
    const live = liveAdapter(["Automatic live orders are switched off."]);
    expect(await live.health()).toMatchObject({ ok: false });
    const contract: ContractRef = { underlying: "NIFTY", expiry: "2026-10-28", strike: 24_000, right: "CE", securityId: "1", lotSize: 75 };
    expect(await live.enter({ key: "k", contract, quantity: 75, price: 100, now: NOW })).toMatchObject({ status: "REJECTED" });
  });

  it("an emergency exit closes the position through the same adapter", async () => {
    const { state, adapter } = await opened();
    const events: unknown[] = [];
    await startExit(state, { sessionId: "s1", sessionDate: DATE, config: config(), candles: [], lines: [], now: NOW, adapter }, "EMERGENCY", null, (event) => events.push(event));
    expect(state.position).toBeNull();
    expect(adapter.calls.exit).toBe(1);
  });
});

/* ---------------- trend-aware exit management (optional; fixed time limit by default) ---------------- */

describe("trend exit management at the time checkpoint", async () => {
  const { EXIT_MANAGEMENT_DEFAULTS, fiveMinute, trendExitDecision, trendVerdict } = await import("@/lib/algo/trend-exit");
  const trend = { ...EXIT_MANAGEMENT_DEFAULTS, mode: "trend" as const, maxHoldMinutes: 90, minScore: 4 };
  /** Minute candles from `from` for `count` minutes, moving `step` points a minute from `start`, with volume. */
  const series = (from: number, count: number, start: number, step: number): Candle[] =>
    Array.from({ length: count }, (_, i) => {
      const open = start + step * i;
      const close = open + step;
      return { time: at(from + i), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 };
    });

  it("scores the five checks from completed candles only; a falling market agrees with a PUT and is against a CALL", () => {
    const down = series(0, 40, 24_000, -3);
    const put = trendVerdict(down, "PUT", OPEN);
    expect(put.score).toBe(5);
    expect(put.checks.map((check) => check.name)).toEqual(["1-min EMA", "5-min EMA", "VWAP", "Momentum", "Swing structure"]);
    expect(trendVerdict(down, "CALL", OPEN)).toMatchObject({ score: 0, against: 5 });
    // Too few candles: the checks are unknown, never assumed.
    expect(trendVerdict(down.slice(0, 5), "PUT", OPEN).checks.filter((check) => check.agrees === null).length).toBeGreaterThanOrEqual(3);
    // Only whole 5-minute candles count; without volume the session average replaces VWAP.
    expect(fiveMinute(down.slice(0, 12), OPEN)).toHaveLength(2);
    expect(trendVerdict(down.map((candle) => ({ ...candle, volume: 0 })), "PUT", OPEN).checks[2].detail).toMatch(/session average \(no volume\)/);
  });

  it("decides: hold before the checkpoint, then exit at the maximum holding time, on a reversal, a trailing stop, a recovery, or an unconfirmed trend", () => {
    const valid = trendVerdict(series(0, 40, 24_000, -3), "PUT", OPEN);
    const reversed = trendVerdict(series(0, 40, 24_000, 3), "PUT", OPEN);
    const common = { settings: trend, side: "PUT" as const, checkpointMinutes: 30, premium: 90, entry: 100, chargesPerUnit: 0.5, highestSinceCheckpoint: 92, dailyLossExceeded: false };
    expect(trendExitDecision({ ...common, elapsedMinutes: 20, verdict: reversed }).action).toBe("hold");
    expect(trendExitDecision({ ...common, elapsedMinutes: 20, verdict: reversed, settings: { ...trend, reversalBeforeCheckpoint: true } })).toMatchObject({ action: "exit", reason: "REVERSAL" });
    expect(trendExitDecision({ ...common, elapsedMinutes: 30, verdict: valid })).toMatchObject({ action: "hold" });
    expect(trendExitDecision({ ...common, elapsedMinutes: 90, verdict: valid })).toMatchObject({ action: "exit", reason: "MAX_HOLD" });
    expect(trendExitDecision({ ...common, elapsedMinutes: 30, verdict: valid, dailyLossExceeded: true })).toMatchObject({ action: "exit", reason: "RISK" });
    expect(trendExitDecision({ ...common, elapsedMinutes: 30, verdict: reversed })).toMatchObject({ action: "exit", reason: "REVERSAL" });
    expect(trendExitDecision({ ...common, elapsedMinutes: 40, verdict: valid, premium: 82, settings: { ...trend, trailPercent: 10 } })).toMatchObject({ action: "exit", reason: "TRAIL" });
    expect(trendExitDecision({ ...common, elapsedMinutes: 40, verdict: valid, premium: 100.6, settings: { ...trend, recoveryExit: true } })).toMatchObject({ action: "exit", reason: "RECOVERY" });
    const weak = { ...valid, score: 3, against: 2 };
    expect(trendExitDecision({ ...common, elapsedMinutes: 30, verdict: weak })).toMatchObject({ action: "exit", reason: "TIME" });
  });

  it("in the engine: the fixed limit exits at 30 minutes; trend mode holds while the trend agrees and exits when it turns; the stop-loss always comes first", async () => {
    // A PUT entered at minute 32 (after the 9:15-low crossing at 30–31), then NIFTY keeps falling to minute 61.
    const [previous, candle] = crossing(lineOf("or-low").price, "DOWN");
    const falling = series(32, 30, candle.close, -3);
    const rising = series(62, 30, falling.at(-1)!.close, 6);
    const candles = [previous, candle, ...falling, ...rising];
    const open = async (cfg: AlgoConfig) => {
      const adapter = fakeAdapter({ bid: 100 });
      const first = await step({ ...initialState(DATE), running: true, entries: true, lastCandle: at(29) }, [previous, candle], adapter, at(32), cfg);
      // New entries off, so only the exit logic acts from here.
      return { adapter, state: { ...first.state, running: false } };
    };
    const fixed = config({ maxHoldMinutes: 30, exitManagement: { ...trend, mode: "fixed" } });
    const a = await open(fixed);
    expect((await step(a.state, candles, a.adapter, at(62), fixed)).events.find((event) => event.kind === "EXIT")?.message).toMatch(/^Exit \(TIME\)/);

    const managed = config({ maxHoldMinutes: 30, exitManagement: trend });
    const b = await open(managed);
    const at30 = await step(b.state, candles, b.adapter, at(62), managed);
    expect(at30.state.position).not.toBeNull();
    expect(at30.events.find((event) => event.key.startsWith("extend:"))?.message).toMatch(/^Held past the 30-min checkpoint: trend confirmed \(5\/5/);
    let state = at30.state;
    let exit: AlgoEvent | undefined;
    for (let minute = 63; minute <= 92 && !exit; minute += 1) {
      const next = await step(state, candles, b.adapter, at(minute), managed);
      state = next.state;
      exit = next.events.find((event) => event.kind === "EXIT");
    }
    expect(exit?.message).toMatch(/^Exit \((TIME|REVERSAL)\)/);
    expect(exit!.time).toBeLessThan(at(92));

    // Past the checkpoint with the trend still valid, the stop-loss is hit: the stop wins over the extension.
    const c = await open(managed);
    c.adapter.set({ bid: 70 });
    expect((await step(c.state, candles, c.adapter, at(62), managed)).events.find((event) => event.kind === "EXIT")?.message).toMatch(/^Exit \(STOP\)/);
  });

  it("settings: Mathi holds while the trend agrees by default (version 15; saved settings move once), saved values read back, invalid ones reported", () => {
    expect(ALGO_DEFAULTS.exitManagement).toMatchObject({ mode: "trend", maxHoldMinutes: 90, minScore: 4, trailPercent: 0, recoveryExit: false, reversalBeforeCheckpoint: false });
    expect(readAlgoConfig({ settingsVersion: 14 }).exitManagement?.mode).toBe("trend");
    expect(readAlgoConfig({ settingsVersion: 14, exitManagement: { mode: "fixed", maxHoldMinutes: 60 } }).exitManagement).toMatchObject({ mode: "trend", maxHoldMinutes: 60 });
    expect(readAlgoConfig({ settingsVersion: 15, exitManagement: { mode: "fixed" } }).exitManagement?.mode).toBe("fixed");
    // Version 16: the checkpoint moves from the old default 30 to 45 minutes once; another saved value, or 30 chosen since, is kept.
    expect(ALGO_DEFAULTS.maxHoldMinutes).toBe(45);
    expect(readAlgoConfig({ settingsVersion: 15, maxHoldMinutes: 30 }).maxHoldMinutes).toBe(45);
    expect(readAlgoConfig({ settingsVersion: 15, maxHoldMinutes: 20 }).maxHoldMinutes).toBe(20);
    expect(readAlgoConfig({ settingsVersion: 16, maxHoldMinutes: 30 }).maxHoldMinutes).toBe(30);
    expect(readAlgoConfig({ engine: "primary", settingsVersion: 14 }).exitManagement?.mode).toBe("fixed");
    expect(readAlgoConfig({ settingsVersion: 14, exitManagement: { mode: "trend", maxHoldMinutes: 120, minScore: 3, trailPercent: 8, recoveryExit: true } }).exitManagement).toMatchObject({ mode: "trend", maxHoldMinutes: 120, minScore: 3, trailPercent: 8, recoveryExit: true, reversalBeforeCheckpoint: false });
    expect(algoConfigProblems({ ...ALGO_DEFAULTS, exitManagement: { ...trend, maxHoldMinutes: 20 } })).toContain("The maximum holding time must be after the checkpoint and at most 375 minutes.");
    expect(algoConfigProblems({ ...ALGO_DEFAULTS, exitManagement: { ...trend, minScore: 6 } })).toContain("The trend checks needed to hold must be 1 to 5.");
  });
});

describe("optional premium limit: an ATM option above the limit is not bought", () => {
  it("rejects the entry with the reason when the ATM premium is above the limit; 0 turns it off", async () => {
    const [previous, candle] = crossing(lineOf("or-low").price, "DOWN");
    const blocked = await step(running(), [previous, candle], fakeAdapter(), undefined, config({ filters: { ...config().filters, maxEntryPremium: 100 } }));
    expect(blocked.state.position).toBeNull();
    expect(blocked.events.find((event) => event.kind === "REJECTED")?.message).toMatch(/PREMIUM ABOVE LIMIT — ATM PE 24000 costs ₹101\.05, above the ₹100 limit/);
    const allowed = await step(running(), [previous, candle], fakeAdapter(), undefined, config({ filters: { ...config().filters, maxEntryPremium: 0 } }));
    expect(allowed.state.position).not.toBeNull();
    const roomy = await step(running(), [previous, candle], fakeAdapter(), undefined, config({ filters: { ...config().filters, maxEntryPremium: 150 } }));
    expect(roomy.state.position).not.toBeNull();
  });

  it("is off by default (any premium is bought); a saved limit is kept; Algo - Primary Strategy has none", () => {
    expect(ALGO_DEFAULTS.filters.maxEntryPremium).toBe(0);
    expect(readAlgoConfig({ settingsVersion: 16, filters: {} }).filters.maxEntryPremium).toBe(0);
    expect(readAlgoConfig({ settingsVersion: 17, filters: { maxEntryPremium: 0 } }).filters.maxEntryPremium).toBe(0);
    expect(readAlgoConfig({ settingsVersion: 17, filters: { maxEntryPremium: 200 } }).filters.maxEntryPremium).toBe(200);
    expect(readAlgoConfig({ engine: "primary", settingsVersion: 16 }).filters.maxEntryPremium).toBe(0);
  });
});

describe("regime switch (version 18): real entries only while the last trades made money", () => {
  const [previous, candle] = crossing(lineOf("or-low").price, "DOWN");
  const cfg = config({ regime: { enabled: true, lookback: 3 } });

  it("with a losing record the signal is followed as a SHADOW trade: no order, no money, but its result is recorded", async () => {
    const adapter = fakeAdapter();
    const losing = await step(running({ regime: { history: [-5_000, 1_000, 1_000] } }), [previous, candle], adapter, undefined, cfg);
    expect(adapter.calls.enter).toBe(0);
    expect(losing.state.position).toMatchObject({ shadow: true, side: "PUT" });
    const entry = losing.events.find((event) => event.kind === "ENTRY")!;
    expect(entry.shadow).toBe(true);
    expect(entry.message).toMatch(/^REGIME SWITCH OFF — The last 3 trades total ₹-3000 \(not positive\)/);
    adapter.set({ bid: 150 });
    const exited = await step(losing.state, [previous, candle, bar(32, 23_900, 23_910, 23_890, 23_905)], adapter, undefined, cfg);
    expect(adapter.calls.exit).toBe(0);
    const exit = exited.events.find((event) => event.kind === "EXIT")!;
    expect(exit.shadow).toBe(true);
    expect(exit.message).toMatch(/^SHADOW Exit \(TARGET\).*Shadow result \(no money\)/);
    expect(exited.state.realizedToday).toBe(0);
    expect(exited.state.shadowToday).toBeGreaterThan(0);
    expect(exited.state.regime?.history.at(-1)).toBe(exit.pnl);
  });

  it("with a winning record (or fewer trades than the look-back) it trades for real", async () => {
    const adapter = fakeAdapter();
    const winning = await step(running({ regime: { history: [2_000, -1_000, 2_000] } }), [previous, candle], adapter, undefined, cfg);
    expect(adapter.calls.enter).toBe(1);
    expect(winning.state.position?.shadow).toBeUndefined();
    const fresh = await step(running(), [previous, candle], fakeAdapter(), undefined, cfg);
    expect(fresh.state.position?.shadow).toBeUndefined();
    expect(regimeStatus({ regime: { history: [1, 2] } }, cfg)).toMatchObject({ on: true });
    expect(regimeStatus({ regime: { history: [-1, -2, 1] } }, cfg)).toMatchObject({ on: false, total: -2 });
    expect(regimeStatus({ regime: { history: [-9, -9, -9] } }, config({ regime: { enabled: false, lookback: 3 } }))).toMatchObject({ on: true });
  });

  it("is on (30 trades) by default for Mathi Strategy; saved settings move once; a later choice is kept; Primary has none", () => {
    expect(ALGO_DEFAULTS.regime).toEqual({ enabled: true, lookback: 30 });
    expect(readAlgoConfig({ settingsVersion: 17 }).regime).toEqual({ enabled: true, lookback: 30 });
    expect(readAlgoConfig({ settingsVersion: 18, regime: { enabled: false, lookback: 20 } }).regime).toEqual({ enabled: false, lookback: 20 });
    expect(readAlgoConfig({ engine: "primary", settingsVersion: 17 }).regime?.enabled).toBe(false);
    expect(algoConfigProblems({ ...ALGO_DEFAULTS, regime: { enabled: true, lookback: 1 } })).toContain("The regime switch look-back must be 3 to 100 trades.");
  });
});
