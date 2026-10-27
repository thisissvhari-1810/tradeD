import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/algo/lines";
import { runScheduledChecks } from "@/lib/algo/monitor";
import { advance, ALGO_DEFAULTS, initialState, type AlgoConfig, type AlgoEvent, type AlgoState, type ExecutionAdapter, type Fill, type OpenPosition } from "@/lib/algo/runner";

/* Paper-trading monitoring: targets reached between checks, stale data, restarts and duplicate scheduler passes.
   The 27 Oct 2026 case: 22700 PE bought at ₹68.40 (1,430 qty) on the 10:20 signal, target +3% = ₹70.45. */

const DATE = "2026-10-27";
const OPEN = Date.UTC(2026, 9, 27, 3, 45) / 1000; // 09:15 IST
const at = (minute: number) => OPEN + minute * 60; // minute 66 = 10:21 IST
const opt = (minute: number, open: number, high: number, low: number, close: number): Candle => ({ time: at(minute), open, high, low, close });
const CHARGES = 25;

const config = (patch: Partial<AlgoConfig> = {}): AlgoConfig => ({ ...ALGO_DEFAULTS, mode: "PAPER", maxHoldMinutes: 0, regime: { enabled: false, lookback: 30 }, ...patch });

function openPosition(patch: Partial<OpenPosition> = {}): OpenPosition {
  return {
    entryKey: "s1:entry:1", contract: { underlying: "NIFTY", expiry: DATE, strike: 22_700, right: "PE", securityId: "54321", lotSize: 65 }, side: "PUT", lots: 22, quantity: 1430, avg: 68.4,
    stop: 0, target: 70.45, entryCharges: CHARGES, openedAt: at(66) + 20, signalTime: at(65), lineIds: ["prev-high"], exit: null, exitAttempts: 0, ...patch,
  };
}

const holding = (patch: Partial<OpenPosition> = {}): AlgoState => ({ ...initialState(DATE), running: false, entries: false, status: "POSITION_OPEN", lastCandle: at(65), tradesToday: 1, position: openPosition(patch) });

type Feed = { bid: number | null; asOf?: number; candles?: Candle[] | null; down?: boolean };

/** A paper adapter whose market data the test controls; exits are idempotent by key, like the paper ledger. */
function paper(feed: Feed) {
  const orders = new Map<string, Fill>();
  let cash = 100_000;
  let exits = 0;
  const adapter: ExecutionAdapter = {
    kind: "paper",
    health: async () => ({ ok: true }),
    cash: async () => cash,
    charges: () => CHARGES,
    chain: async () => { throw new Error("no entries in these tests"); },
    mark: async (_contract, now) => {
      if (feed.down) throw new Error("market data disconnected");
      if (feed.bid == null && !feed.candles?.length) return null;
      return { bid: feed.bid, ask: feed.bid, candle: null, asOf: feed.asOf ?? now, ...(feed.candles ? { candles: feed.candles } : {}) };
    },
    enter: async () => { throw new Error("no entries in these tests"); },
    async exit(order) {
      const again = orders.get(order.key);
      if (again) return again;
      exits += 1;
      const fill: Fill = { status: "FILLED", quantity: order.quantity, price: order.price, charges: CHARGES };
      orders.set(order.key, fill);
      cash += order.price * order.quantity - CHARGES;
      return fill;
    },
    lookup: async (key) => orders.get(key) ?? null,
  };
  return { adapter, feed, exits: () => exits, cash: () => cash };
}

const check = (state: AlgoState, adapter: ExecutionAdapter, now: number, cfg = config()) => advance(state, { sessionId: "s1", sessionDate: DATE, config: cfg, candles: [], lines: [], now, adapter });
const exitOf = (events: AlgoEvent[]) => events.find((event) => event.kind === "EXIT");

// The real 22700 PE minutes after the entry: the whole 10:23 minute traded above the target.
const tape = [opt(66, 78.95, 84.25, 61.35, 65.3), opt(67, 65.4, 73.85, 60.1, 73.85), opt(68, 74.1, 78.45, 70.65, 75.05), opt(69, 74.65, 78.45, 68.9, 74.6), opt(70, 74.25, 74.6, 63.3, 63.3)];

describe("paper monitoring: target reached between checks", () => {
  it("books the resting target at the minute it traded through, even when the next check sees a lower price", async () => {
    // First check at 10:22:05: only the entry minute has completed — its high (₹84.25, partly before the fill) is not used.
    const p = paper({ bid: 66, candles: tape.slice(0, 1) });
    const first = await check(holding(), p.adapter, at(67) + 5);
    expect(exitOf(first.events)).toBeUndefined();
    expect(first.state.position).not.toBeNull();
    // The browser was closed; the next check comes at 10:26:05, when the premium is back at ₹63.
    Object.assign(p.feed, { bid: 63, candles: tape });
    const second = await check(first.state, p.adapter, at(71) + 5);
    const exit = exitOf(second.events)!;
    expect(exit.message).toMatch(/^Exit \(TARGET\) 1430 @ ₹70\.4: Target reached between checks: the option traded up to ₹73\.85 in the 10:22 minute/);
    expect(exit.time).toBe(at(68)); // the end of the 10:22 minute, not the check time
    expect(exit.order?.price).toBe(70.4); // the ₹70.45 target less 1 tick of slippage — not the candle high
    // Capital, charges and history: one exit, realized = (70.40 − 68.40) × 1,430 − both legs' charges.
    expect(p.exits()).toBe(1);
    expect(second.state.position).toBeNull();
    expect(second.state.realizedToday).toBe(2860 - 2 * CHARGES);
    expect(exit.pnl).toBe(2860 - 2 * CHARGES);
    expect(p.cash()).toBe(100_000 + 70.4 * 1430 - CHARGES);
    expect(second.state.regime?.history.at(-1)).toBe(2860 - 2 * CHARGES);
  });

  it("a touch of the target alone is not a fill; one tick through it is", async () => {
    const p = paper({ bid: 69, candles: [opt(67, 69, 70.45, 68, 69)] });
    const touched = await check(holding(), p.adapter, at(68) + 5);
    expect(exitOf(touched.events)).toBeUndefined();
    expect(touched.state.monitor?.candlesThrough).toBe(at(67));
    Object.assign(p.feed, { candles: [opt(67, 69, 70.45, 68, 69), opt(68, 69, 70.5, 68.5, 69.5)] });
    const through = await check(touched.state, p.adapter, at(69) + 5);
    expect(exitOf(through.events)?.message).toMatch(/^Exit \(TARGET\)/);
  });

  it("the live quote still exits at once when it is at or above the target", async () => {
    const p = paper({ bid: 70.6, candles: [] });
    const result = await check(holding(), p.adapter, at(67) + 30);
    expect(exitOf(result.events)?.message).toMatch(/^Exit \(TARGET\) 1430 @ ₹70\.55/);
    expect(exitOf(result.events)?.time).toBe(at(67) + 30);
  });

  it("an unfinished minute is never used, however high it traded", async () => {
    const p = paper({ bid: 66, candles: [opt(67, 66, 90, 65, 66)] });
    // 10:22:30: the 10:22 candle is still forming.
    const result = await check(holding(), p.adapter, at(67) + 30);
    expect(exitOf(result.events)).toBeUndefined();
  });
});

describe("paper monitoring: unknown order inside one minute", () => {
  it("target and stop inside the same candle: the stop is taken (conservative) and the note says the order is unknown", async () => {
    const p = paper({ bid: 64, candles: [opt(67, 66, 74, 55, 64)] });
    const result = await check(holding({ stop: 61.56 }), p.adapter, at(68) + 5, config({ stopLoss: true, stop: { mode: "percent", value: 10 } }));
    const exit = exitOf(result.events)!;
    expect(exit.message).toMatch(/^Exit \(STOP\) 1430 @ ₹61\.51: Stop-loss and target both inside one candle: the order is unknown/);
  });
});

describe("paper monitoring: data problems", () => {
  it("disconnection: nothing is decided and the problem is recorded; after reconnecting, the gap's candles are checked", async () => {
    const p = paper({ bid: null, down: true });
    const down = await check(holding(), p.adapter, at(67) + 5);
    expect(exitOf(down.events)).toBeUndefined();
    expect(down.events.find((event) => event.kind === "ERROR")?.message).toMatch(/No quote for the open option/);
    expect(down.state.monitor).toMatchObject({ failures: 1, problem: expect.stringMatching(/could not be checked/) });
    Object.assign(p.feed, { down: false, bid: 63, candles: tape });
    const back = await check(down.state, p.adapter, at(71) + 5);
    expect(exitOf(back.events)?.time).toBe(at(68));
    expect(back.state.monitor?.failures).toBe(0);
  });

  it("an out-of-order quote (older than one already used) is ignored, even above the target", async () => {
    const p = paper({ bid: 66, asOf: at(67) + 50, candles: [] });
    const first = await check(holding(), p.adapter, at(67) + 55);
    Object.assign(p.feed, { bid: 72, asOf: at(67) + 20 });
    const second = await check(first.state, p.adapter, at(68) + 5);
    expect(exitOf(second.events)).toBeUndefined();
    expect(second.state.monitor?.problem).toMatch(/arrived after a newer one/);
  });

  it("candles from before the last checked minute are not checked again", async () => {
    const p = paper({ bid: 66, candles: [opt(67, 66, 69, 65, 66)] });
    const first = await check(holding(), p.adapter, at(68) + 5);
    // A late correction of the already-checked 10:22 candle does not reopen it.
    Object.assign(p.feed, { candles: [opt(67, 66, 75, 65, 66)] });
    const second = await check(first.state, p.adapter, at(68) + 50);
    expect(exitOf(second.events)).toBeUndefined();
  });
});

describe("paper monitoring: 15:20 IST square-off", () => {
  it("closes an open position at 15:20 IST (09:50 UTC) at the live quote", async () => {
    const p = paper({ bid: 40, candles: [] });
    const before = await check(holding(), p.adapter, at(364) + 30); // 15:19:30 IST
    expect(exitOf(before.events)).toBeUndefined();
    const result = await check(before.state, p.adapter, at(365) + 2); // 15:20:02 IST
    expect(new Date((at(365) + 2) * 1000).toISOString().slice(11, 16)).toBe("09:50");
    expect(exitOf(result.events)?.message).toMatch(/^Exit \(SQUARE_OFF\) 1430 @ ₹39\.95: End-of-day square-off at 15:20 IST/);
  });
});

/* ---------------- the scheduler pass ---------------- */

type Row = { id: string; state: AlgoState };

/** An in-memory session store with the same lease rule as the database (one holder at a time). */
function store(rows: Row[]) {
  const table = new Map(rows.map((row) => [row.id, structuredClone(row)]));
  const held = new Set<string>();
  return {
    table,
    list: async () => [...table.values()].map((row) => structuredClone(row)),
    withLease: async <T,>(id: string, task: () => Promise<T>) => {
      if (held.has(id)) throw new Error("The algo is busy with another update. Try again in a moment.");
      held.add(id);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await task();
      } finally {
        held.delete(id);
      }
    },
    reload: async (id: string) => structuredClone(table.get(id)!),
  };
}

function scheduler(db: ReturnType<typeof store>, adapter: ExecutionAdapter, now: () => number) {
  return async () => runScheduledChecks(await db.list(), {
    id: (row) => row.id,
    strategies: ["MATHI"],
    stateOf: (row) => row.state,
    withLease: db.withLease,
    reload: db.reload,
    // The engine runs on the state read under the lease; the result is saved (JSON, as in the database).
    check: async (row, _strategy, state) => {
      const result = await check(state, adapter, now());
      db.table.set(row.id, { id: row.id, state: JSON.parse(JSON.stringify(result.state)) });
      return result.state;
    },
  });
}

describe("scheduler pass", () => {
  it("monitors an open position with no browser at all, and resumes after a restart from the saved state", async () => {
    const db = store([{ id: "s1", state: holding() }, { id: "idle", state: initialState(DATE) }]);
    // First pass at 10:23:05: the 10:22 minute stayed below the target.
    const p = paper({ bid: 66, candles: [tape[0], opt(67, 65.4, 69.9, 60.1, 66)] });
    let clock = at(68) + 5;
    const pass = scheduler(db, p.adapter, () => clock);
    const first = await pass();
    expect(first.checks).toEqual([{ session: "s1", strategy: "MATHI", ok: true, open: true, problem: null }]); // the idle session is skipped
    expect(db.table.get("s1")!.state.position?.checkedThrough).toBe(at(67));
    // "Restart": a new scheduler with nothing in memory; only the saved session remains.
    clock = at(71) + 5;
    Object.assign(p.feed, { bid: 63, candles: tape });
    const restarted = scheduler(db, p.adapter, () => clock);
    const second = await restarted();
    expect(second.checks[0]).toMatchObject({ ok: true, open: false });
    expect(p.exits()).toBe(1);
    expect(db.table.get("s1")!.state.realizedToday).toBe(2860 - 2 * CHARGES);
  });

  it("two passes at the same moment: one checks, the other is reported busy; one exit only", async () => {
    const db = store([{ id: "s1", state: holding() }]);
    const p = paper({ bid: 63, candles: tape });
    const pass = scheduler(db, p.adapter, () => at(71) + 5);
    const [a, b] = await Promise.all([pass(), pass()]);
    const outcomes = [a.checks[0], b.checks[0]];
    expect(outcomes.filter((item) => item.ok)).toHaveLength(1);
    expect(outcomes.find((item) => !item.ok)?.problem).toMatch(/busy/);
    expect(p.exits()).toBe(1);
  });

  it("a pass listed before another check closed the trade reads the session again under the lease and does nothing", async () => {
    const db = store([{ id: "s1", state: holding() }]);
    const p = paper({ bid: 63, candles: tape });
    const stale = await db.list(); // taken while the position was open
    await scheduler(db, p.adapter, () => at(71) + 5)();
    const late = await runScheduledChecks(stale, { id: (row) => row.id, strategies: ["MATHI"], stateOf: (row) => row.state, withLease: db.withLease, reload: db.reload, check: async (_row, _s, state) => (await check(state, p.adapter, at(71) + 30)).state });
    expect(late.checks[0]).toMatchObject({ ok: true, open: false });
    expect(p.exits()).toBe(1);
    expect(db.table.get("s1")!.state.realizedToday).toBe(2860 - 2 * CHARGES);
  });
});
