import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../src/lib/market/demo";
import type { OptionChainView } from "../src/server/option-chain";
import type { AlgoLine } from "../src/lib/algo/lines";
import { ALGO_DEFAULTS, initialState, type AlgoConfig, type AlgoState } from "../src/lib/algo/runner";
import { algoOrders, clampFill, minuteEnds, playGate, positionValuation, runStats, tradeMarkers } from "../src/lib/algo/chart-replay";
import { switchToChartReplay } from "../src/lib/algo/config";

/**
 * The Algo inside the chart's replay, end to end on the demo ledger: deterministic underlying candles,
 * strategy lines and option premiums; entries and exits go through the real historical replay order path
 * (placeOptionReplay) into an in-memory ledger. No live data, no broker.
 */

type Row = Record<string, unknown> & { id: string };

const db = vi.hoisted(() => {
  const state = {
    accounts: [] as Row[],
    orders: [] as Row[],
    instruments: [] as Row[],
    positions: [] as Row[],
    executions: [] as Row[],
    ledger: [] as Row[],
    quotes: [] as Row[],
    closed: [] as Row[],
    periods: [] as Row[],
    seq: 0,
  };
  const id = (prefix: string) => `${prefix}${++state.seq}`;
  type Key = { accountId_practicePeriodId_instrumentId: { accountId: string; practicePeriodId: string; instrumentId: string } };
  const findPosition = (where: Key) => {
    const key = where.accountId_practicePeriodId_instrumentId;
    return state.positions.find((row) => row.accountId === key.accountId && row.practicePeriodId === key.practicePeriodId && row.instrumentId === key.instrumentId) ?? null;
  };
  const withIncludes = (order: Row | undefined) => order && { ...order, instrument: state.instruments.find((row) => row.id === order.instrumentId), executions: state.executions.filter((row) => row.orderId === order.id) };
  const findOrder = (where: { id?: string; accountId_idempotencyKey?: { accountId: string; idempotencyKey: string } }) => where.id
    ? state.orders.find((row) => row.id === where.id)
    : state.orders.find((row) => row.accountId === where.accountId_idempotencyKey?.accountId && row.idempotencyKey === where.accountId_idempotencyKey?.idempotencyKey);
  type OrderWhere = { accountId?: string; practicePeriodId?: string; instrumentId?: string; side?: string; idempotencyKey?: { startsWith: string }; instrument?: { symbol: { endsWith: string } } };
  const symbolOf = (instrumentId: unknown) => String(state.instruments.find((row) => row.id === instrumentId)?.symbol ?? "");
  const fillsWhere = (where: { order: OrderWhere }) => state.executions.filter((fill) => {
    const order = state.orders.find((row) => row.id === fill.orderId);
    if (!order) return false;
    const want = where.order;
    if (want.accountId && order.accountId !== want.accountId) return false;
    if (want.practicePeriodId && order.practicePeriodId !== want.practicePeriodId) return false;
    if (want.instrumentId && order.instrumentId !== want.instrumentId) return false;
    if (want.side && order.side !== want.side) return false;
    if (want.idempotencyKey && !String(order.idempotencyKey).startsWith(want.idempotencyKey.startsWith)) return false;
    if (want.instrument && !symbolOf(order.instrumentId).endsWith(want.instrument.symbol.endsWith)) return false;
    return true;
  });
  const byTime = (rows: Row[], direction: "asc" | "desc") => [...rows].sort((a, b) => ((a.executedAt as Date).getTime() - (b.executedAt as Date).getTime()) * (direction === "asc" ? 1 : -1));
  const client = {
    $queryRaw: async () => [],
    appSetting: { findMany: async () => [], findUnique: async () => null },
    virtualAccount: {
      findUnique: async ({ where }: { where: { id?: string; userId?: string; userId_mode?: { userId: string; mode: string } } }) => state.accounts.find((row) => (where.id ? row.id === where.id : where.userId_mode ? row.userId === where.userId_mode.userId && ((row as { mode?: string }).mode ?? "DEMO") === where.userId_mode.mode : row.userId === where.userId)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(state.accounts.find((row) => row.id === where.id)!, data),
      create: async ({ data }: { data: Row }) => { const row = { ...data, id: id("acc") }; state.accounts.push(row as Row); return row; },
    },
    practicePeriod: { create: async ({ data }: { data: Row }) => { const row = { ...data, id: id("per") }; state.periods.push(row as Row); return row; } },
    watchlist: { create: async () => null },
    order: {
      findUnique: async ({ where, include }: { where: Parameters<typeof findOrder>[0]; include?: unknown }) => { const row = findOrder(where); return row ? (include ? withIncludes(row) : row) : null; },
      findUniqueOrThrow: async ({ where, include }: { where: Parameters<typeof findOrder>[0]; include?: unknown }) => { const row = findOrder(where); if (!row) throw new Error("not found"); return include ? withIncludes(row) : row; },
      create: async ({ data }: { data: Omit<Row, "id"> }) => { const row: Row = { filledQuantity: 0, reservedPaise: 0n, chargesPaise: 0n, avgFillPaise: null, filledAt: null, submittedAt: new Date(), ...data, id: id("ord") }; state.orders.push(row); return row; },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(state.orders.find((row) => row.id === where.id)!, data),
    },
    instrument: {
      upsert: async ({ where, create, update }: { where: { symbol: string }; create: Row; update: Row }) => {
        const found = state.instruments.find((row) => row.symbol === where.symbol);
        if (found) return Object.assign(found, update);
        const row = { ...create, id: id("ins") };
        state.instruments.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(state.instruments.find((row) => row.id === where.id)!, data),
      findUnique: async ({ where }: { where: { id?: string; symbol?: string } }) => state.instruments.find((row) => (where.id ? row.id === where.id : row.symbol === where.symbol)) ?? null,
    },
    position: {
      findUnique: async ({ where }: { where: Key }) => findPosition(where),
      findMany: async ({ where }: { where: { accountId: string; practicePeriodId: string; instrument: { symbol: { endsWith: string } } } }) => state.positions
        .filter((row) => row.accountId === where.accountId && row.practicePeriodId === where.practicePeriodId && (row.quantity as number) > 0)
        .map((row) => ({ ...row, instrument: state.instruments.find((item) => item.id === row.instrumentId)! }))
        .filter((row) => String(row.instrument.symbol).endsWith(where.instrument.symbol.endsWith)),
      upsert: async ({ where, create, update }: { where: Key; create: Row; update: Row }) => {
        const found = findPosition(where);
        if (found) return Object.assign(found, update, { updatedAt: new Date() });
        const row = { ...create, id: id("pos"), updatedAt: new Date() };
        state.positions.push(row as Row);
        return row;
      },
    },
    execution: {
      create: async ({ data }: { data: Row }) => { const row = { ...data, id: id("exe") }; state.executions.push(row as Row); return row; },
      findFirst: async ({ where, orderBy }: { where: { order: OrderWhere }; orderBy: { executedAt: "asc" | "desc" } }) => byTime(fillsWhere(where), orderBy.executedAt)[0] ?? null,
      findMany: async ({ where }: { where: { order: OrderWhere } }) => byTime(fillsWhere(where), "asc").map((fill) => {
        const order = state.orders.find((row) => row.id === fill.orderId)!;
        return { ...fill, order: { id: fill.orderId, side: order.side, instrument: { symbol: symbolOf(order.instrumentId) } } };
      }),
    },
    ledgerEntry: { create: async ({ data }: { data: Row }) => { const row = { ...data, id: id("led") }; state.ledger.push(row as Row); return row; } },
    quoteCache: {
      upsert: async ({ where, create, update }: { where: { instrumentId: string }; create: Row; update: Row }) => {
        const found = state.quotes.find((row) => row.instrumentId === where.instrumentId);
        if (found) return Object.assign(found, update);
        const row = { ...create, id: id("q") };
        state.quotes.push(row);
        return row;
      },
    },
    badge: { findUnique: async () => null },
    userBadge: { upsert: async () => null },
    notification: { create: async () => null },
    closedTrade: {
      findUnique: async () => null,
      create: async ({ data }: { data: Row }) => { const row = { ...data, id: id("ct") }; state.closed.push(row); return row; },
      findMany: async ({ where }: { where: { accountId: string; practicePeriodId: string; symbol: { endsWith: string } } }) => state.closed
        .filter((row) => row.accountId === where.accountId && row.practicePeriodId === where.practicePeriodId && String(row.symbol).endsWith(where.symbol.endsWith))
        .map((row) => ({ ...row, instrument: { lotSize: state.instruments.find((item) => item.id === row.instrumentId)?.lotSize ?? 1 } })),
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
  };
  return { state, client };
});

const OPEN = Date.UTC(2026, 9, 16, 3, 45) / 1000;
const CLOSE = OPEN + 375 * 60;
const DATE = "2026-10-16";
const SESSION = "2026-10-16.algo1234";
const NOW = new Date("2026-10-16T12:00:00.000Z");
const START = 10_000_000n; // ₹1,00,000
const DEMO_FUNDS = 500_000_000n; // ₹50,00,000 in a separate demo wallet
const LINE = 23_150;
/** Minute index → unix seconds. */
const m = (index: number) => OPEN + index * 60;

const feed = vi.hoisted(() => ({ premiums: [] as Candle[], missing: false }));

vi.mock("@/lib/prisma", () => ({ prisma: db.client }));
vi.mock("@/server/settings", async (original) => ({ ...(await original<typeof import("../src/server/settings")>()), configuredProvider: () => "dhan" }));
vi.mock("@/server/dhan-market", async (original) => ({
  ...(await original<typeof import("../src/server/dhan-market")>()),
  dhanOptionSession: async () => (feed.missing ? [] : feed.premiums),
}));
vi.mock("@/server/option-chain", () => ({
  loadOptionChain: async (): Promise<OptionChainView> => ({
    symbol: "NIFTY", name: "Nifty 50", kind: "index", available: true, message: "",
    asOf: "2026-10-16T16:11:00.000Z", spot: 23_150, expiry: "2026-10-20", expiries: ["2026-10-20"], lotSize: 75,
    daysToExpiry: 4, pcr: 1, atmStrike: 23_150, atmIv: 12,
    // The live snapshot premiums (999) must never be used for a replay fill.
    strikes: [{ strike: 23_150, ce: { ltp: 999, previousClose: 1, oi: 1, previousOi: 1, oiChangePct: 0, volume: 1, iv: 12, bid: 998, ask: 1000, securityId: "111" }, pe: { ltp: 999, previousClose: 1, oi: 1, previousOi: 1, oiChangePct: 0, volume: 1, iv: 12, bid: 998, ask: 1000, securityId: "222" } }],
  }),
}));

const { stepChartRun, exitChartRun } = await import("../src/server/algo-replay");
const { clearReplayTapes } = await import("../src/server/option-replay");
const { loadOptionChain } = await import("../src/server/option-chain");
const { ensurePracticeAccount, practiceModeOf, viewModeOf } = await import("../src/server/practice-account");
const { placeOptionReplay } = await import("../src/server/trading");

const student = { id: "u1", email: "student.demo@tradelab.local", name: "Student", role: "STUDENT" as const, status: "ACTIVE" as const, tradingEnabled: true, mfaEnabled: false, premium: { status: "free" as const, plan: null, endsAt: null, via: null }, features: { standardTrading: true, demoTrading: true, replay: true, multiAccount: true, brokerConnection: true, portfolio: true, orderHistory: true, analytics: true } };

const lines: AlgoLine[] = [{ id: `${DATE}:custom`, type: "custom", label: "Test line", price: LINE, activeFrom: OPEN, source: "custom" }];

/** Underlying: flat above the line, then one candle whose body crosses it (down or up) at `crossAt`. */
function underlying(direction: "DOWN" | "UP", crossAt = 30): Candle[] {
  const above = direction === "DOWN";
  const before = above ? LINE + 10 : LINE - 10;
  const after = above ? LINE - 10 : LINE + 10;
  const candles: Candle[] = [];
  for (let index = 0; index < 375; index += 1) {
    const close = index < crossAt ? before : after;
    const open = index === crossAt ? before - (above ? 2 : -2) : close;
    candles.push({ time: m(index), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 });
  }
  return candles;
}

/** Option premiums: 100 until `from`, then `shape(index)` gives {low, high, close}. */
function premiums(shape: (index: number) => { low: number; high: number; close: number } | null = () => null): Candle[] {
  const tape: Candle[] = [];
  for (let index = 0; index < 375; index += 1) {
    const custom = shape(index);
    const close = custom?.close ?? 100;
    tape.push({ time: m(index), open: close, high: custom?.high ?? close + 0.5, low: custom?.low ?? close - 0.5, close, volume: 100 });
  }
  return tape;
}

const config: AlgoConfig = { ...ALGO_DEFAULTS, mode: "REPLAY", stop: { mode: "percent", value: 20 }, target: { mode: "percent", value: 40 }, slippageTicks: 1, cooldownMinutes: 0 };

async function run(candles: Candle[], options: { state?: AlgoState; processedThrough?: number; cursor: number; config?: AlgoConfig }) {
  return stepChartRun({
    user: student, wallet: "ALGO", runId: "run1", session: SESSION, date: DATE, config: options.config ?? config, lines, candles, chain: await loadOptionChain("NIFTY", null), sessionOpen: OPEN, sessionClose: CLOSE, now: NOW,
    state: options.state ?? { ...initialState(DATE), running: true, entries: true }, processedThrough: options.processedThrough ?? OPEN, cursor: options.cursor,
  });
}

const cash = () => db.state.accounts[0].cashAvailable as bigint;
const buys = () => db.state.orders.filter((row) => row.side === "BUY");
const sells = () => db.state.orders.filter((row) => row.side === "SELL");

beforeEach(() => {
  Object.assign(db.state, { accounts: [], orders: [], instruments: [], positions: [], executions: [], ledger: [], quotes: [], closed: [], periods: [], seq: 0 });
  // The Algo wallet (₹1,00,000) and a separate ₹50,00,000 demo wallet that the Algo must never touch.
  db.state.accounts.push({ id: "acc1", userId: "u1", mode: "ALGO", currentPeriodId: "p1", cashAvailable: START, cashReserved: 0n });
  db.state.accounts.push({ id: "acc2", userId: "u1", mode: "DEMO", currentPeriodId: "p2", cashAvailable: DEMO_FUNDS, cashReserved: 0n });
  feed.premiums = premiums();
  feed.missing = false;
  clearReplayTapes();
});

describe("chart replay rules", () => {
  it("processes each completed minute once, in order, up to the cursor and the close", () => {
    expect(minuteEnds(OPEN, m(3) + 30, OPEN, CLOSE)).toEqual([m(1), m(2), m(3)]);
    expect(minuteEnds(m(3), m(3) + 59, OPEN, CLOSE)).toEqual([]);
    expect(minuteEnds(m(370), CLOSE + 600, OPEN, CLOSE).at(-1)).toBe(CLOSE);
  });

  it("asks for confirmation only when the algo is enabled", () => {
    expect(playGate({ algoEnabled: false, cursor: m(10), processedThrough: m(20) })).toEqual({ kind: "free" });
    expect(playGate({ algoEnabled: true, cursor: m(10), processedThrough: null })).toEqual({ kind: "confirm", skippedMinutes: 0 });
    expect(playGate({ algoEnabled: true, cursor: m(25), processedThrough: m(20) })).toEqual({ kind: "confirm", skippedMinutes: 4 });
  });

  it("refuses to resume behind the minutes already processed (seeking back needs a new session)", () => {
    expect(playGate({ algoEnabled: true, cursor: m(10), processedThrough: m(20) })).toEqual({ kind: "behind", processedThrough: m(20) });
  });

  it("keeps a requested fill inside the minute's real traded range", () => {
    expect(clampFill(80, { low: 90, high: 110 })).toBe(90);
    expect(clampFill(120, { low: 90, high: 110 })).toBe(110);
    expect(clampFill(100.07, { low: 90, high: 110 })).toBe(100.05);
  });
});

describe("algo orders on the demo ledger during chart replay", () => {
  it("a downward body crossing buys one ATM PUT at the replay-time premium", async () => {
    const result = await run(underlying("DOWN"), { cursor: m(40) });
    expect(buys()).toHaveLength(1);
    expect(String(db.state.instruments[0].symbol)).toBe(`NIFTY|2026-10-20|23150|PE|R:${SESSION}`);
    expect(result.state.position).toMatchObject({ side: "PUT", quantity: 75 });
    // Close 100 plus one tick of slippage, inside the minute's 99.5–100.5 range; never the live 999.
    expect(db.state.executions[0].pricePaise).toBe(10_005n);
    expect((db.state.executions[0].executedAt as Date).getTime()).toBe(m(31) * 1000);
  });

  it("an upward body crossing buys one ATM CALL", async () => {
    const result = await run(underlying("UP"), { cursor: m(40) });
    expect(buys()).toHaveLength(1);
    expect(String(db.state.instruments[0].symbol)).toContain("|CE|");
    expect(result.state.position?.side).toBe("CALL");
  });

  it("no crossing places no order", async () => {
    const flat = underlying("DOWN", 500);
    const result = await run(flat, { cursor: m(200) });
    expect(db.state.orders).toHaveLength(0);
    expect(result.state.position).toBeNull();
  });

  it("deducts the actual fill and charges from demo cash, once", async () => {
    await run(underlying("DOWN"), { cursor: m(40) });
    const fill = db.state.executions[0];
    expect(cash()).toBe(START - (fill.pricePaise as bigint) * 75n - (fill.chargesPaise as bigint));
  });

  it("reprocessing the same minutes (a repeated step or a seek back) never places the order twice", async () => {
    const first = await run(underlying("DOWN"), { cursor: m(40) });
    const again = await run(underlying("DOWN"), { cursor: m(40), state: { ...initialState(DATE), running: true, entries: true } });
    expect(buys()).toHaveLength(1);
    expect(db.state.executions).toHaveLength(1);
    expect(again.events.some((event) => event.reasons?.includes("Order already processed."))).toBe(true);
    expect(first.state.position).not.toBeNull();
  });

  it("rejects the entry when demo capital is insufficient and keeps cash unchanged", async () => {
    db.state.accounts[0].cashAvailable = 500_00n;
    const result = await run(underlying("DOWN"), { cursor: m(40) });
    expect(db.state.orders).toHaveLength(0);
    expect(cash()).toBe(500_00n);
    expect(result.state.lastOrder?.status).toBe("REJECTED");
    expect(result.state.lastOrder?.message).toMatch(/buying power/i);
  });

  it("missing historical premiums reject the entry instead of inventing a fill", async () => {
    feed.missing = true;
    const result = await run(underlying("DOWN"), { cursor: m(40) });
    expect(db.state.executions).toHaveLength(0);
    expect(result.state.position).toBeNull();
    expect(result.state.lastOrder?.status).toBe("REJECTED");
  });

  it("never fills from a premium candle that completes after the replay time", async () => {
    feed.premiums = premiums((index) => (index >= 31 ? { low: 4_999, high: 5_001, close: 5_000 } : null));
    await run(underlying("DOWN"), { cursor: m(31) });
    expect(db.state.executions[0].pricePaise).toBe(10_005n);
  });

  it("a stop-loss on the option premium closes the position on the ledger", async () => {
    // Entry ~100.05 → stop 80.04. Minute 35's premium trades down to 70.
    feed.premiums = premiums((index) => (index === 35 ? { low: 70, high: 100, close: 75 } : index > 35 ? { low: 74, high: 76, close: 75 } : null));
    const result = await run(underlying("DOWN"), { cursor: m(45) });
    expect(sells()).toHaveLength(1);
    expect(result.state.position).toBeNull();
    const exit = db.state.executions[1];
    expect(Number(exit.pricePaise)).toBeLessThanOrEqual(8_004);
    expect(Number(exit.pricePaise)).toBeGreaterThanOrEqual(7_000);
    expect(db.state.positions[0].quantity).toBe(0);
    expect(db.state.closed).toHaveLength(1);
    expect(result.events.find((event) => event.kind === "EXIT")?.message).toMatch(/^Exit \(STOP\)/);
  });

  it("a target closes the position", async () => {
    feed.premiums = premiums((index) => (index === 36 ? { low: 100, high: 150, close: 145 } : null));
    const result = await run(underlying("DOWN"), { cursor: m(45) });
    expect(result.events.find((event) => event.kind === "EXIT")?.message).toMatch(/^Exit \(TARGET\)/);
    expect(result.state.position).toBeNull();
    expect(cash()).toBeGreaterThan(START);
  });

  it("a candle reaching both stop and target takes the stop (conservative rule)", async () => {
    feed.premiums = premiums((index) => (index === 36 ? { low: 60, high: 160, close: 100 } : null));
    const result = await run(underlying("DOWN"), { cursor: m(45) });
    expect(result.events.find((event) => event.kind === "EXIT")?.message).toMatch(/^Exit \(STOP\)/);
  });

  it("a manual exit closes before either level at the last completed premium, and cannot run twice", async () => {
    feed.premiums = premiums((index) => (index >= 33 ? { low: 109.5, high: 110.5, close: 110 } : null));
    const opened = await run(underlying("DOWN"), { cursor: m(34) });
    const before = cash();
    const base = { user: student, wallet: "ALGO" as const, runId: "run1", session: SESSION, date: DATE, config, lines, candles: underlying("DOWN"), chain: await loadOptionChain("NIFTY", null), sessionOpen: OPEN, sessionClose: CLOSE, now: NOW };
    const exited = await exitChartRun({ ...base, state: opened.state, at: m(34), reason: "MANUAL" });
    expect(exited.state.position).toBeNull();
    expect(sells()).toHaveLength(1);
    const exit = db.state.executions[1];
    expect(exit.pricePaise).toBe(10_995n); // 110 less one tick of slippage
    expect(cash()).toBe(before + (exit.pricePaise as bigint) * 75n - (exit.chargesPaise as bigint));
    // A second click on the closed state is refused and changes nothing.
    await expect(exitChartRun({ ...base, state: exited.state, at: m(34), reason: "MANUAL" })).rejects.toThrow(/no open algo position/i);
    expect(sells()).toHaveLength(1);
    // Realized P&L in the run log equals the ledger's realized figure for the trade.
    const realized = Number(exit.realizedPaise) / 100;
    expect(exited.events.find((event) => event.kind === "EXIT")?.pnl).toBeCloseTo(realized, 0);
  });

  it("an exit already in progress refuses a duplicate", async () => {
    const opened = await run(underlying("DOWN"), { cursor: m(34) });
    const state = { ...opened.state, position: { ...opened.state.position!, exit: { key: "k", reason: "MANUAL", attempt: 1, uncertain: false } } };
    const base = { user: student, wallet: "ALGO" as const, runId: "run1", session: SESSION, date: DATE, config, lines, candles: underlying("DOWN"), chain: await loadOptionChain("NIFTY", null), sessionOpen: OPEN, sessionClose: CLOSE, now: NOW };
    await expect(exitChartRun({ ...base, state, at: m(34), reason: "MANUAL" })).rejects.toThrow(/already being processed/i);
  });

  it("entries off blocks new trades but the open position's stop is still enforced", async () => {
    feed.premiums = premiums((index) => (index === 40 ? { low: 50, high: 100, close: 60 } : null));
    const opened = await run(underlying("DOWN"), { cursor: m(34) });
    const off = { ...opened.state, running: false, entries: false };
    const later = await run(underlying("DOWN"), { state: off, processedThrough: m(34), cursor: m(45) });
    expect(later.state.position).toBeNull();
    expect(sells()).toHaveLength(1);
    expect(buys()).toHaveLength(1);
  });

  it("pausing (no steps) leaves the position open; resuming continues from the stored state", async () => {
    const opened = await run(underlying("DOWN"), { cursor: m(34) });
    const restored = JSON.parse(JSON.stringify(opened.state)) as AlgoState;
    expect(restored.position).toEqual(opened.state.position);
    const resumed = await run(underlying("DOWN"), { state: restored, processedThrough: opened.processedThrough, cursor: m(50) });
    expect(resumed.state.position).toEqual(opened.state.position);
    expect(buys()).toHaveLength(1);
  });

  it("processing in many small steps gives the same ledger as one large step", async () => {
    feed.premiums = premiums((index) => (index === 60 ? { low: 100, high: 150, close: 145 } : null));
    let state: AlgoState = { ...initialState(DATE), running: true, entries: true };
    let through = OPEN;
    for (let cursor = m(5); cursor <= m(70); cursor += 7 * 60 + 13) {
      const step = await run(underlying("DOWN"), { state: JSON.parse(JSON.stringify(state)) as AlgoState, processedThrough: through, cursor });
      state = step.state;
      through = step.processedThrough;
    }
    const stepped = { orders: db.state.orders.length, cash: cash() };
    Object.assign(db.state, { accounts: [{ id: "acc1", userId: "u1", mode: "ALGO", currentPeriodId: "p1", cashAvailable: START, cashReserved: 0n }], orders: [], instruments: [], positions: [], executions: [], ledger: [], quotes: [], closed: [], seq: 0 });
    await run(underlying("DOWN"), { cursor: through });
    expect({ orders: db.state.orders.length, cash: cash() }).toEqual(stepped);
  });

  it("squares off at the session close with a real ledger fill", async () => {
    const result = await run(underlying("DOWN", 300), { cursor: CLOSE + 30 });
    expect(result.ended).toBe(true);
    expect(result.state.position).toBeNull();
    expect(sells()).toHaveLength(1);
    expect(result.events.find((event) => event.kind === "EXIT")?.message).toMatch(/^Exit \(SESSION_END\)/);
  });

  it("session statistics come from the run's own log", async () => {
    feed.premiums = premiums((index) => (index === 36 ? { low: 100, high: 150, close: 145 } : null));
    const result = await run(underlying("DOWN"), { cursor: m(45) });
    const stats = runStats(result.events);
    expect(stats).toMatchObject({ signals: 1, accepted: 1, trades: 1, wins: 1, losses: 0 });
    expect(stats.exits.TARGET).toBe(1);
    expect(stats.realized).toBeGreaterThan(0);
  });
});

describe("no broker and no live data in chart replay", () => {
  const source = readFileSync("src/server/algo-replay.ts", "utf8");
  it("never imports a broker or live order path", () => {
    expect(source).not.toMatch(/live-orders|execution-client|dhan-account|multi-account-live/);
    expect(source).toMatch(/placeOptionReplay/);
  });
});

describe("chart wiring for the algo replay", () => {
  const desk = readFileSync("src/components/chart-desk.tsx", "utf8");
  const panel = readFileSync("src/components/algo/algo-replay-panel.tsx", "utf8");
  const hook = readFileSync("src/components/algo/use-chart-algo.ts", "utf8");

  it("Play goes through the algo gate, and only an enabled algo opens the confirmation", () => {
    expect(desk).toMatch(/onToggle=\{toggleReplay\}/);
    expect(desk).toMatch(/algo\.gate && algo\.gate\.kind !== "free"\) \{\s*setAlgoDialog\(true\);\s*return;/);
    expect(panel).toMatch(/Start Algo Trading Replay\?/);
    expect(panel).toMatch(/Start Algo &amp; Replay|Start Algo & Replay/);
  });

  it("starting arms the run on the server before playback begins", () => {
    const start = desk.slice(desk.indexOf("async function startAlgoReplay"), desk.indexOf("async function startAlgoReplay") + 600);
    expect(start.indexOf("algo.arm(")).toBeGreaterThan(-1);
    expect(start.indexOf("algo.arm(")).toBeLessThan(start.indexOf('status: "playing"'));
  });

  it("enabling the algo pauses a running replay; seeking with the algo on pauses too", () => {
    expect(hook).toMatch(/if \(next\) \{\s*callbacks\.current\.onPause\(\);/);
    expect(desk.match(/current\.status === "playing" && !algoHolds \? "playing" : "paused"/g)?.length).toBe(2);
  });

  it("the manual exit has its own confirmation, separate from Pause and Exit Replay", () => {
    expect(panel).toMatch(/Exit this position\?/);
    expect(panel).toMatch(/Confirm Exit/);
    expect(panel).toMatch(/disabled=\{Boolean\(algo\.busy\) \|\| Boolean\(position\.exit\)/);
  });

  it("leaving replay only stops new entries; it never claims the position closed", () => {
    expect(desk).toMatch(/function leaveReplay\(\) \{[\s\S]{0,400}algo\.disarm\(\)/);
    expect(desk).not.toMatch(/function leaveReplay\(\) \{[\s\S]{0,400}algo\.exit\(/);
  });

  it("trade markers are drawn on the chart from the run's entries and exits", () => {
    expect(desk).toMatch(/markers=\{algoMarkers\}/);
    expect(desk).toMatch(/tradeMarkers\(algoRun\.events, replay\.cursor\)/);
    expect(desk).toMatch(/onMarkerClick=/);
  });

  it("steps are sent one at a time with the replay clock, never the computer clock", () => {
    expect(hook).toMatch(/action: "chartStep", session, cursor/);
    expect(hook).not.toMatch(/Date\.now\(\)/);
  });
});

describe("the Algo's own ₹1,00,000 account", () => {
  const algoAccount = () => db.state.accounts.find((row) => row.mode === "ALGO")!;
  const demoAccount = () => db.state.accounts.find((row) => row.mode === "DEMO")!;
  const order = (lots: number, cursor: number, key: string) => placeOptionReplay(student, { symbol: "NIFTY", expiry: "2026-10-20", strike: 23_150, right: "PE", action: "BUY", lots, session: SESSION, cursor, idempotencyKey: key }, NOW, "ALGO");

  it("a new Algo account opens with exactly ₹1,00,000: cash 1,00,000, reserved 0, opening ledger entry", async () => {
    db.state.accounts = db.state.accounts.filter((row) => row.mode !== "ALGO");
    const opened = await ensurePracticeAccount("u1", "ALGO");
    expect(opened.cashAvailable).toBe(10_000_000n);
    expect(opened.cashReserved).toBe(0n);
    expect(db.state.periods.at(-1)?.startingCapital).toBe(10_000_000n);
    expect(db.state.ledger.find((row) => row.type === "OPENING_BALANCE")?.cashDelta).toBe(10_000_000n);
  });

  it("opening it again (refresh, restart, another replay date) never resets the balance", async () => {
    await run(underlying("DOWN"), { cursor: m(40) });
    const after = cash();
    const again = await ensurePracticeAccount("u1", "ALGO");
    expect(again.cashAvailable).toBe(after);
    expect(db.state.accounts.filter((row) => row.mode === "ALGO")).toHaveLength(1);
    expect(after).toBeLessThan(START);
  });

  it("algo orders use only the Algo account; the ₹50,00,000 demo wallet is untouched", async () => {
    await run(underlying("DOWN"), { cursor: m(40) });
    expect(demoAccount().cashAvailable).toBe(DEMO_FUNDS);
    expect(db.state.orders.every((row) => row.accountId === algoAccount().id)).toBe(true);
  });

  it("an entry costing more than ₹1,00,000 is rejected even though the demo wallet holds ₹50,00,000", async () => {
    feed.premiums = premiums(() => ({ low: 1_999, high: 2_001, close: 2_000 })); // 75 × ₹2,000 = ₹1,50,000
    const result = await run(underlying("DOWN"), { cursor: m(40) });
    expect(db.state.orders).toHaveLength(0);
    expect(result.state.lastOrder?.status).toBe("REJECTED");
    expect(cash()).toBe(START);
    expect(demoAccount().cashAvailable).toBe(DEMO_FUNDS);
  });

  it("several orders together cannot overspend the account", async () => {
    feed.premiums = premiums(() => ({ low: 599, high: 601, close: 600 })); // ₹45,000 a lot
    await order(1, m(31), "a");
    const second = await order(2, m(32), "b").catch((error: unknown) => error as { code?: string });
    expect((second as { code?: string }).code).toBe("INSUFFICIENT_FUNDS");
    expect(cash() > 0n).toBe(true);
    expect(db.state.executions).toHaveLength(1);
  });

  it("market fills reserve nothing; cash falls by exactly the fill plus charges, once", async () => {
    await order(1, m(31), "c");
    await order(1, m(31), "c"); // the same order event again
    const fill = db.state.executions[0];
    expect(db.state.executions).toHaveLength(1);
    expect(algoAccount().cashReserved).toBe(0n);
    expect(cash()).toBe(START - (fill.pricePaise as bigint) * 75n - (fill.chargesPaise as bigint));
  });

  it("equity = cash + reserved + open value, and unrealized = (premium − average) × quantity", async () => {
    await order(1, m(31), "d");
    const position = db.state.positions[0];
    const premium = 11_000n; // a later premium of ₹110
    const value = premium * BigInt(position.quantity as number);
    const unrealized = (premium - (position.avgCostPaise as bigint)) * BigInt(position.quantity as number);
    const equity = cash() + (algoAccount().cashReserved as bigint) + value;
    const fill = db.state.executions[0];
    // The ledger puts entry charges into the average cost, so unrealized P&L is already net of them and
    // equity − starting capital equals it (to under a paisa per unit of rounding in the average).
    const quantity = BigInt(position.quantity as number);
    const abs = (value: bigint) => (value < 0n ? -value : value);
    expect(abs((position.avgCostPaise as bigint) * quantity - ((fill.pricePaise as bigint) * quantity + (fill.chargesPaise as bigint))) <= quantity / 2n).toBe(true);
    expect(abs(equity - (START + unrealized)) <= quantity / 2n).toBe(true);
  });

  it("an exit adds the proceeds once, even when the exit event repeats", async () => {
    await order(1, m(31), "e");
    const sell = { symbol: "NIFTY", expiry: "2026-10-20", strike: 23_150, right: "PE" as const, action: "SELL" as const, lots: 1, session: SESSION, cursor: m(35), idempotencyKey: "e-exit" };
    await placeOptionReplay(student, sell, NOW, "ALGO");
    const after = cash();
    await placeOptionReplay(student, sell, NOW, "ALGO");
    expect(cash()).toBe(after);
    expect(db.state.executions).toHaveLength(2);
    expect(db.state.positions[0].quantity).toBe(0);
  });

  it("a new replay date (new session) continues from the same balance", async () => {
    await run(underlying("DOWN"), { cursor: m(40) });
    const after = cash();
    const other = await stepChartRun({
      user: student, wallet: "ALGO", runId: "run2", session: "2026-10-16.other999", date: DATE, config, lines, candles: underlying("UP"), chain: await loadOptionChain("NIFTY", null),
      sessionOpen: OPEN, sessionClose: CLOSE, now: NOW, state: { ...initialState(DATE), running: true, entries: true }, processedThrough: OPEN, cursor: m(40),
    });
    expect(other.state.position).not.toBeNull();
    expect(cash()).toBeLessThan(after);
    expect(db.state.accounts.filter((row) => row.mode === "ALGO")).toHaveLength(1);
  });

  it("a run started before the Algo account existed finishes on the demo wallet it began on", async () => {
    await stepChartRun({
      user: student, wallet: "DEMO", runId: "legacy", session: SESSION, date: DATE, config, lines, candles: underlying("DOWN"), chain: await loadOptionChain("NIFTY", null),
      sessionOpen: OPEN, sessionClose: CLOSE, now: NOW, state: { ...initialState(DATE), running: true, entries: true }, processedThrough: OPEN, cursor: m(40),
    });
    expect(db.state.orders[0].accountId).toBe(demoAccount().id);
    expect(cash()).toBe(START);
  });

  it("no request can pick the Algo account for an order; only read-only views can show it", () => {
    const request = (url: string, mode = "") => new Request(url, { headers: mode ? { "x-td-mode": mode } : {} });
    expect(practiceModeOf(request("http://x/api/orders?wallet=algo", "algo"))).toBe("DEMO");
    expect(viewModeOf(request("http://x/api/portfolio?wallet=algo"))).toBe("ALGO");
    for (const route of ["src/app/api/orders/route.ts", "src/app/api/demo/option/route.ts", "src/app/api/demo/option-replay/route.ts"]) {
      expect(readFileSync(route, "utf8")).not.toMatch(/viewModeOf|"ALGO"/);
    }
  });

  it("the Algo panel, Portfolio and Home read the same ledger summary; nothing shows the ₹50,00,000 options-desk balance", () => {
    const server = readFileSync("src/server/algo.ts", "utf8");
    expect(server).toMatch(/getStudentBundle\(userId, "ALGO"\)/);
    expect(server).not.toMatch(/paperCapitalPaise/);
    expect(readFileSync("src/app/api/portfolio/route.ts", "utf8")).toMatch(/getStudentBundle\(user\.id, mode\)/);
    const panel = readFileSync("src/components/algo/algo-panel.tsx", "utf8");
    expect(panel).not.toMatch(/Paper cash|data\.paper/);
    expect(panel).toMatch(/AlgoAccountFigures account=\{data\.account\}/);
    expect(readFileSync("src/components/home.tsx", "utf8")).toMatch(/<AlgoAccountCard \/>/);
    expect(readFileSync("src/components/screens.tsx", "utf8")).toMatch(/<AlgoAccountCard \/>/);
  });

  it("the options desk keeps its own paper account and is never opened for the Algo", () => {
    const server = readFileSync("src/server/algo.ts", "utf8");
    expect(server).not.toMatch(/optionPaperAccount\.upsert/);
    expect(readFileSync("src/server/options-paper.ts", "utf8")).toMatch(/export function paperCapitalPaise/);
  });
});

describe("CALL/PUT execution in chart replay: orders, P&L, markers", () => {
  it("an ATM option that did not trade in the signal minute still fills from its last fresh premium", async () => {
    // No PUT candle at minute 30 (the signal minute); the minute-29 candle (100) is the latest premium.
    feed.premiums = premiums().filter((candle) => candle.time !== m(30));
    const result = await run(underlying("DOWN"), { cursor: m(40) });
    expect(result.state.position).not.toBeNull();
    expect(db.state.executions).toHaveLength(1);
  });

  it("a stale option premium is a visible rejection with its reason, not a silent skip", async () => {
    feed.premiums = premiums().filter((candle) => candle.time < m(25)); // last trade 5 minutes before the signal
    const result = await run(underlying("DOWN"), { cursor: m(40) });
    expect(db.state.orders).toHaveLength(0);
    const rows = algoOrders(result.events, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ group: "rejected", status: "REJECTED", side: "PUT", action: "BUY" });
    expect(rows[0].reason).toMatch(/Stale option quote/);
  });

  it("missing option history is listed as a rejected order with the reason", async () => {
    feed.missing = true;
    const result = await run(underlying("DOWN"), { cursor: m(40) });
    const rejected = algoOrders(result.events, null).filter((row) => row.group === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.length).toBeGreaterThan(10);
  });

  it("the order list shows the open entry as active, then BUY and SELL as completed with realized P&L", async () => {
    feed.premiums = premiums((index) => (index === 36 ? { low: 100, high: 150, close: 145 } : null));
    const open = await run(underlying("DOWN"), { cursor: m(34) });
    const active = algoOrders(open.events, open.state.position!.entryKey);
    expect(active).toEqual([expect.objectContaining({ action: "BUY", side: "PUT", status: "FILLED", group: "active", quantity: 75 })]);
    const closed = await run(underlying("DOWN"), { state: open.state, processedThrough: open.processedThrough, cursor: m(45) });
    const rows = algoOrders([...open.events, ...closed.events], null);
    expect(rows.map((row) => `${row.action}:${row.group}`)).toEqual(["SELL:completed", "BUY:completed"]);
    expect(rows[0].pnl).toBeGreaterThan(0);
    expect(rows[0].reason).toBe("Target");
  });

  it("unrealized P&L follows the replay premium: quantity already includes the lot size (never multiplied twice)", () => {
    const position = { avg: 120, quantity: 75, entryCharges: 20 };
    expect(positionValuation(position, 135)).toEqual({ invested: 9_000, value: 10_125, unrealized: 1_105, unrealizedPercent: 12.28 });
    expect(positionValuation(position, 110).unrealized).toBe(-770);
    expect(positionValuation(position, null)).toMatchObject({ invested: 9_000, value: null, unrealized: null });
  });

  it("entry and exit markers sit at the simulated fill times, never past the replay time, once per event", async () => {
    feed.premiums = premiums((index) => (index === 36 ? { low: 100, high: 150, close: 145 } : null));
    const result = await run(underlying("DOWN"), { cursor: m(45) });
    const markers = tradeMarkers(result.events, m(45));
    expect(markers.map((marker) => [marker.kind, marker.time])).toEqual([["entry", m(31)], ["exit", m(37)]]);
    expect(markers[0]).toMatchObject({ side: "PUT" });
    expect(markers[0].text).toMatch(/^PUT BUY 23150PE @₹/);
    expect(markers[0].detail.join(" ")).toMatch(/Underlying at the signal: 23140\.00/);
    expect(markers[1].text).toMatch(/^EXIT Target \+₹/);
    // The same events again (a reprocessed candle) never add markers; before the exit time only the entry shows.
    expect(tradeMarkers([...result.events, ...result.events], m(45))).toHaveLength(2);
    expect(tradeMarkers(result.events, m(36))).toHaveLength(1);
  });

  it("switching the Algo to chart replay stops a live-price session and refuses while a position is open", () => {
    const paper = { ...config, mode: "PAPER" as const };
    expect(switchToChartReplay(paper, { running: true, entries: true, position: null, pending: null })).toMatchObject({ ok: true, stopped: true, config: { mode: "REPLAY" } });
    const opened = { running: true, entries: true, position: { entryKey: "k" } as unknown as AlgoState["position"], pending: null };
    expect(switchToChartReplay(paper, opened)).toMatchObject({ ok: false });
    expect(switchToChartReplay(config, opened)).toMatchObject({ ok: true, stopped: false });
  });

  it("the chart panel's switch is always shown in replay, and enabling it switches the mode on the server", () => {
    const panel = readFileSync("src/components/algo/algo-replay-panel.tsx", "utf8");
    const hook = readFileSync("src/components/algo/use-chart-algo.ts", "utf8");
    expect(panel).not.toMatch(/data && replayMode \? \(\s*<label/);
    expect(panel).toMatch(/aria-label="Enable Algo for this replay"/);
    expect(hook).toMatch(/action: "chartMode"/);
    expect(readFileSync("src/server/algo.ts", "utf8")).toMatch(/case "chartMode":/);
  });

  it("the right panel renders the run's real position, orders and rejections", () => {
    const panel = readFileSync("src/components/algo/algo-replay-panel.tsx", "utf8");
    expect(panel).toMatch(/algoOrders\(run\.events, position\?\.entryKey \?\? null\)/);
    expect(panel).toMatch(/"active", "completed", "rejected", "all"/);
    expect(panel).toMatch(/Last rejection/);
    expect(panel).not.toMatch(/sample|mock/i);
  });
});
