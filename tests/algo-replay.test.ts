import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../src/lib/market/demo";
import type { OptionChainView } from "../src/server/option-chain";
import type { AlgoLine } from "../src/lib/algo/lines";
import { ALGO_DEFAULTS, initialState, type AlgoConfig, type AlgoState } from "../src/lib/algo/runner";
import { activityFeed, algoOrders, algoTrades, clampFill, minuteEnds, playGate, positionValuation, runDiagnostics, runStats, sessionComplete, skippedSignals, tradeMarkers, tradeSlots, tradeTimeline } from "../src/lib/algo/chart-replay";
import { algoChartMarkers, MARKER_SIZE, SELECTED_MARKER_SIZE } from "../src/components/algo/algo-markers";
import { money, rupeesOf } from "../src/components/algo/live-value";
import { tradeSummary } from "../src/components/algo/algo-trade-drawer";
import { algoConfigProblems, readAlgoConfig, switchToChartReplay } from "../src/lib/algo/config";
import { algoRequest } from "../src/lib/algo/request";
import { algoReportCsv, algoReportName, csvCell } from "../src/lib/algo/report";
import { callPutBreakdown } from "../src/lib/algo/breakdown";

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
    practicePeriod: {
      create: async ({ data }: { data: Row }) => { const row = { ...data, id: id("per") }; state.periods.push(row as Row); return row; },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        let row = state.periods.find((item) => item.id === where.id);
        if (!row) { row = { id: where.id, sequence: 1 } as Row; state.periods.push(row); }
        return Object.assign(row, data);
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => state.periods.find((item) => item.id === where.id) ?? { id: where.id, sequence: 1 },
    },
    watchlist: { create: async () => null },
    order: {
      findUnique: async ({ where, include }: { where: Parameters<typeof findOrder>[0]; include?: unknown }) => { const row = findOrder(where); return row ? (include ? withIncludes(row) : row) : null; },
      findUniqueOrThrow: async ({ where, include }: { where: Parameters<typeof findOrder>[0]; include?: unknown }) => { const row = findOrder(where); if (!row) throw new Error("not found"); return include ? withIncludes(row) : row; },
      create: async ({ data }: { data: Omit<Row, "id"> }) => { const row: Row = { filledQuantity: 0, reservedPaise: 0n, chargesPaise: 0n, avgFillPaise: null, filledAt: null, submittedAt: new Date(), ...data, id: id("ord") }; state.orders.push(row); return row; },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(state.orders.find((row) => row.id === where.id)!, data),
      count: async ({ where }: { where: { accountId: string; practicePeriodId?: string } }) => state.orders.filter((row) => row.accountId === where.accountId && (!where.practicePeriodId || row.practicePeriodId === where.practicePeriodId)).length,
      findMany: async ({ where }: { where: { accountId: string; status?: string } }) => state.orders.filter((row) => row.accountId === where.accountId && (!where.status || row.status === where.status)),
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
const { placeOptionReplay, startAlgoPeriod } = await import("../src/server/trading");

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

// The engine's replay tests run with the entry filters and the structure stop off; the filters have their own tests.
const config: AlgoConfig = { ...ALGO_DEFAULTS, lots: 1, sizing: "fixed", entryCutoff: "15:00", maxDailyLoss: 5_000, strategies: { line: true, trendline: true, w: true, m: true, orb: false, bounce: false, rejection: false }, mode: "REPLAY", stop: { mode: "percent", value: 20 }, target: { mode: "percent", value: 40 }, slippageTicks: 1, cooldownMinutes: 0, filters: { levelBlockMinutes: 0, breakoutBufferPercent: 0, secondCandle: false, momentum: false }, structureStop: false };

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
    expect(panel).toMatch(/disabled=\{Boolean\(algo\.busy\) \|\| cursor == null \|\| Boolean\(position\.exit\)\}/);
  });

  it("leaving replay never closes a position by itself: Exit Replay archives the session first, explicitly", () => {
    expect(desk).toMatch(/function leaveReplay\(\) \{\s*setReplay\(\(current\) => \(\{ \.\.\.current, active: false, status: "idle" \}\)\);\s*\}/);
    expect(desk).not.toMatch(/function leaveReplay\(\) \{[\s\S]{0,200}algo\.(exit|finalize)\(/);
  });

  it("trade markers are drawn on the chart from the run's entries and exits", () => {
    expect(desk).toMatch(/markers=\{algoMarkers\}/);
    expect(desk).toMatch(/tradeMarkers\(algoRun\.events, replay\.cursor, \{ max: algoRun\.config\.maxTrades, open: algoOpen \}\)/);
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

  // In the app every new session first opens a fresh period (startAlgoPeriod, tested below); without that
  // step two runs share one period's ledger, and neither ever creates a second Algo account.
  it("two runs on the same period share its ledger and the one Algo account", async () => {
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
    expect(markers[0].text).toMatch(/^T1\/3 PUT BUY 23150PE @₹/);
    expect(markers[0].detail.join(" ")).toMatch(/Underlying at the signal: 23140\.00/);
    expect(markers[1].text).toMatch(/^T1\/3 EXIT Target \+₹/);
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
    expect(panel).toMatch(/algoTrades\(run\.events/);
    expect(panel).toMatch(/skippedSignals\(run\.events\)/);
    expect(panel).toMatch(/Last rejection/);
    expect(panel).not.toMatch(/sample|mock/i);
  });
});

describe("replay clock, validation and the trade pipeline end to end", () => {
  /** Flat, a down crossing at `down`, flat, then an up crossing at `up`. */
  function twoCrossings(down: number, up: number): Candle[] {
    const candles: Candle[] = [];
    for (let index = 0; index < 375; index += 1) {
      const close = index < down ? LINE + 10 : index < up ? LINE - 10 : LINE + 10;
      const open = index === down ? LINE + 8 : index === up ? LINE - 8 : close;
      candles.push({ time: m(index), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 });
    }
    return candles;
  }

  it("the fractional replay clock is accepted and taken to the whole second (the 'Expected integer, received float' fix)", () => {
    const parsed = algoRequest.safeParse({ action: "chartStep", session: SESSION, cursor: m(31) + 0.437 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "cursor" in parsed.data ? parsed.data.cursor : null).toBe(m(31));
    const missing = algoRequest.safeParse({ action: "chartStep", session: SESSION });
    expect(missing.success).toBe(false);
    expect(missing.success ? "" : missing.error.issues[0].path.join(".")).toBe("cursor");
  });

  it("the client sends whole-second replay times", () => {
    const hook = readFileSync("src/components/algo/use-chart-algo.ts", "utf8");
    expect(hook).toMatch(/action: "chartStep", session, cursor: Math\.floor\(cursor\)/);
    expect(hook).toMatch(/action: "chartArm", session: id, cursor: Math\.floor\(at\)/);
    expect(hook).toMatch(/\(field: \$\{error\.field\}\)/);
  });

  it("fractional premiums are accepted; fractional quantities are refused with a clear message", async () => {
    expect(algoConfigProblems({ ...config, lots: 1.5 })).toContain("Quantity must be 1 to 50 lots.");
    const fractional = await placeOptionReplay(student, { symbol: "NIFTY", expiry: "2026-10-20", strike: 23_150, right: "PE", action: "BUY", lots: 1.5, session: SESSION, cursor: m(31), idempotencyKey: "frac" }, NOW, "ALGO").catch((error: unknown) => error as { code?: string; field?: string });
    expect(fractional).toMatchObject({ code: "INVALID_QUANTITY", field: "lots" });
    feed.premiums = premiums(() => ({ low: 100.05, high: 100.95, close: 100.35 }));
    await placeOptionReplay(student, { symbol: "NIFTY", expiry: "2026-10-20", strike: 23_150, right: "PE", action: "BUY", lots: 1, session: SESSION, cursor: m(31), idempotencyKey: "dec", fillPremium: 100.45 }, NOW, "ALGO");
    expect(db.state.executions[0].pricePaise).toBe(10_045n);
  });

  it("every enabled line is compared on each candle, and a quiet candle says so", async () => {
    const two: AlgoLine[] = [...lines, { id: `${DATE}:second`, type: "prev-high", label: "Prev high", price: 23_500, activeFrom: OPEN, source: "strategy" }];
    const result = await stepChartRun({
      user: student, wallet: "ALGO", runId: "lines", session: SESSION, date: DATE, config, lines: two, candles: underlying("DOWN"), chain: await loadOptionChain("NIFTY", null),
      sessionOpen: OPEN, sessionClose: CLOSE, now: NOW, state: { ...initialState(DATE), running: true, entries: true }, processedThrough: OPEN, cursor: m(10),
    });
    const quiet = result.events.filter((event) => event.key.startsWith("eval:")).at(-1)!;
    expect(quiet.evaluation?.evaluated).toBe(2);
    expect(quiet.message).toBe("No qualifying line crossing (2 lines checked).");
    const off = await stepChartRun({
      user: student, wallet: "ALGO", runId: "lines2", session: SESSION, date: DATE, config: { ...config, disabledLines: ["prev-high"] }, lines: two, candles: underlying("DOWN"), chain: await loadOptionChain("NIFTY", null),
      sessionOpen: OPEN, sessionClose: CLOSE, now: NOW, state: { ...initialState(DATE), running: true, entries: true }, processedThrough: OPEN, cursor: m(10),
    });
    expect(off.events.filter((event) => event.key.startsWith("eval:")).at(-1)?.evaluation?.evaluated).toBe(1);
  });

  it("diagnostics count candles, crossings, signals, accepted and rejected orders and the last rejection", async () => {
    feed.premiums = premiums((index) => (index === 36 ? { low: 100, high: 150, close: 145 } : null));
    // A long cooldown rejects the second signal (29 minutes after the first entry).
    const result = await run(twoCrossings(30, 60), { cursor: m(70), config: { ...config, cooldownMinutes: 60 } });
    const diagnostics = runDiagnostics(result.events, 1);
    expect(diagnostics).toMatchObject({ enabledLines: 1, crossings: 2, signals: 2, accepted: 1, rejected: 1 });
    expect(diagnostics.candlesEvaluated).toBeGreaterThan(60);
    expect(diagnostics.lastRejection?.reason).toMatch(/Cooling down \(60 min between entries\)/);
  });

  it("the entry limit is enforced: once its trades are all closed the session completes and nothing more is processed", async () => {
    feed.premiums = premiums((index) => (index === 36 ? { low: 100, high: 150, close: 145 } : null));
    const result = await run(twoCrossings(30, 60), { cursor: m(70), config: { ...config, maxTrades: 1 } });
    expect(buys()).toHaveLength(1);
    expect(algoTrades(result.events, null)).toHaveLength(1);
    expect(result.completed).toBe(true);
    // Stopped at the minute the trade closed: the later crossing is never evaluated, so no further entry.
    expect(result.processedThrough).toBe(m(37));
    expect(result.events.some((event) => event.key === `eval:${m(60)}`)).toBe(false);
  });

  it("each accepted entry becomes a numbered trade with its line, premiums, exit and realized P&L, and gets markers", async () => {
    feed.premiums = premiums((index) => (index === 36 ? { low: 100, high: 150, close: 145 } : null));
    const result = await run(twoCrossings(30, 60), { cursor: m(70) });
    const trades = algoTrades(result.events, result.state.position ? { entryKey: result.state.position.entryKey, exitPending: false } : null);
    expect(trades.map((trade) => [trade.number, trade.side, trade.status])).toEqual([[1, "PUT", "COMPLETED"], [2, "CALL", "OPEN"]]);
    expect(trades[0]).toMatchObject({ lines: ["Test line"], signalTime: m(30), entryTime: m(31), quantity: 75, exitReason: "Target", exitTime: m(37), durationMinutes: 6 });
    expect(trades[0].realized).toBeGreaterThan(0);
    expect(trades[0].returnPercent).toBeGreaterThan(0);
    const markers = tradeMarkers(result.events, m(70), { max: 3, open: { entryKey: trades[1].entryKey, exitPending: false, unrealized: 12.5 } });
    expect(markers.map((marker) => [marker.kind, marker.time, marker.text.slice(0, 13)])).toEqual([["entry", m(31), "T1/3 PUT BUY "], ["exit", m(37), "T1/3 EXIT Tar"], ["entry", m(61), "T2/3 CALL BUY"]]);
    expect(markers[2].detail.join(" ")).toMatch(/Open · running P&L \+₹12\.50/);
    expect(markers[0].detail.join(" ")).toMatch(/Test line/);
    // The same events twice (a reprocessed candle) never duplicate trades or markers.
    expect(tradeMarkers([...result.events, ...result.events], m(70))).toHaveLength(3);
    expect(algoTrades([...result.events, ...result.events], null)).toHaveLength(2);
  });

  it("the ledger stays consistent across two trades: cash = start − costs + exit proceeds", async () => {
    feed.premiums = premiums((index) => (index === 36 ? { low: 100, high: 150, close: 145 } : null));
    await run(twoCrossings(30, 60), { cursor: m(70) });
    const [buy1, sell1, buy2] = db.state.executions as Array<Row & { pricePaise: bigint; chargesPaise: bigint; quantity: number }>;
    const expected = START - (buy1.pricePaise * 75n + buy1.chargesPaise) + (sell1.pricePaise * 75n - sell1.chargesPaise) - (buy2.pricePaise * 75n + buy2.chargesPaise);
    expect(cash()).toBe(expected);
  });

  it("the panel shows trade slots, the active trade, completed trades and rejected/skipped signals from the run", () => {
    const panel = readFileSync("src/components/algo/algo-replay-panel.tsx", "utf8");
    expect(panel).toMatch(/aria-label="Trade slots"/);
    expect(panel).toMatch(/aria-label="Completed trades"/);
    expect(panel).toMatch(/aria-label="Rejected and skipped signals"/);
    expect(panel).toMatch(/aria-label="Algo processing"/);
    expect(panel).toMatch(/runDiagnostics\(run\.events, run\.enabledLines\)/);
    expect(panel).toMatch(/onOpenTrade\(trade\.entryKey\)/);
  });
});

describe("CALL and PUT profit and loss on the dashboards", () => {
  it("splits closed trades and open positions by CALL and PUT from the ledger", () => {
    const sides = callPutBreakdown(
      [
        { symbol: "NIFTY|2026-10-20|23150|PE|R:2026-10-16.a", netPaise: 25_000n },
        { symbol: "NIFTY|2026-10-20|23150|PE|R:2026-10-16.a", netPaise: -4_000n },
        { symbol: "NIFTY|2026-10-20|23150|CE|R:2026-10-16.a", netPaise: 10_000n },
      ],
      [{ symbol: "NIFTY|2026-10-20|23200|CE|R:2026-10-16.a", unrealizedPaise: -1_550n, valuePaise: 900_000n }],
    );
    expect(sides.put).toMatchObject({ trades: 2, wins: 1, losses: 1, realizedPaise: 21_000n, open: 0 });
    expect(sides.call).toMatchObject({ trades: 1, wins: 1, losses: 0, realizedPaise: 10_000n, open: 1, unrealizedPaise: -1_550n, openValuePaise: 900_000n });
  });

  it("a completed replay PUT trade and an open CALL appear on the right side with the ledger's figures", async () => {
    feed.premiums = premiums((index) => (index === 36 ? { low: 100, high: 150, close: 145 } : null));
    const down = underlying("DOWN");
    const both: Candle[] = down.map((candle, index) => (index < 60 ? candle : { ...candle, open: index === 60 ? LINE - 8 : LINE + 10, close: LINE + 10, high: LINE + 11, low: index === 60 ? LINE - 9 : LINE + 9 }));
    await run(both, { cursor: m(70) });
    const closed = db.state.closed.map((row) => ({ symbol: String(row.symbol), netPaise: row.netPaise as bigint }));
    const open = db.state.positions.filter((row) => (row.quantity as number) > 0).map((row) => ({ symbol: String(db.state.instruments.find((item) => item.id === row.instrumentId)?.symbol), unrealizedPaise: null, valuePaise: null }));
    const sides = callPutBreakdown(closed, open);
    expect(sides.put.trades).toBe(1);
    expect(sides.put.realizedPaise).toBe(db.state.closed[0].netPaise);
    expect(sides.put.realizedPaise > 0n).toBe(true);
    expect(sides.call).toMatchObject({ trades: 0, open: 1 });
  });

  it("Home, Portfolio and the Algo panel all show the same CALL/PUT figures", () => {
    expect(readFileSync("src/app/api/portfolio/route.ts", "utf8")).toMatch(/sides: await algoSides\(user\.id, bundle\.positions\)/);
    expect(readFileSync("src/server/algo.ts", "utf8")).toMatch(/sides: await algoSides\(userId, bundle\.positions\)/);
    expect(readFileSync("src/components/algo/algo-account.tsx", "utf8")).toMatch(/<SideTable sides=\{account\.sides\} \/>/);
  });
});

describe("trade dashboard and trade detail view", () => {
  /** Flat, a down crossing at `down`, then an up crossing at `up`. */
  function twoCrossings(down: number, up: number): Candle[] {
    const candles: Candle[] = [];
    for (let index = 0; index < 375; index += 1) {
      const close = index < down ? LINE + 10 : index < up ? LINE - 10 : LINE + 10;
      const open = index === down ? LINE + 8 : index === up ? LINE - 8 : close;
      candles.push({ time: m(index), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 });
    }
    return candles;
  }
  async function session() {
    feed.premiums = premiums((index) => (index === 36 ? { low: 100, high: 150, close: 145 } : null));
    const result = await run(twoCrossings(30, 60), { cursor: m(70) });
    const open = result.state.position ? { entryKey: result.state.position.entryKey, exitPending: false } : null;
    return { result, trades: algoTrades(result.events, open) };
  }

  it("every trade has its own id, timeline and figures; a completed trade keeps its final result", async () => {
    const { result, trades } = await session();
    expect(new Set(trades.map((trade) => trade.entryKey)).size).toBe(2);
    const first = tradeTimeline(result.events, trades[0].entryKey);
    const second = tradeTimeline(result.events, trades[1].entryKey);
    // The order / fill events in order; the trade's intratrade confirmation changes are listed with them.
    expect(first.filter((event) => event.kind !== "info").map((event) => event.kind)).toEqual(["signal", "order", "opened", "exit", "closed"]);
    expect(second.filter((event) => event.kind !== "info").map((event) => event.kind)).toEqual(["signal", "order", "opened"]);
    expect(first.some((event) => event.kind === "info" && /^(Price action|Breakout level|Candle|Volume|Momentum|Risk \/ exit):/.test(event.text))).toBe(true);
    expect(first.every((event, index) => index === 0 || event.time >= first[index - 1].time)).toBe(true);
    expect(first.at(-1)?.text).toMatch(/Realized \+₹/);
    // Later replay minutes never change the completed trade.
    const later = await run(twoCrossings(30, 60), { state: result.state, processedThrough: m(70), cursor: m(90) });
    const again = algoTrades([...result.events, ...later.events], null)[0];
    expect(again.realized).toBe(trades[0].realized);
    expect(again.exitPremium).toBe(trades[0].exitPremium);
    expect(trades[0].entryCharges).toBeGreaterThan(0);
    expect(trades[0].exitCharges).toBeGreaterThan(0);
    expect(trades[0].linePrices).toEqual([LINE]);
    expect(trades[0].direction).toBe("DOWN");
  });

  it("the three slots show Open / Completed / Waiting, a pending order, or the latest rejection with its reason", async () => {
    const { result, trades } = await session();
    const skipped = skippedSignals(result.events);
    expect(tradeSlots(trades, skipped, false, 3).map((slot) => slot.state)).toEqual(["Completed", "Open", "Waiting"]);
    expect(tradeSlots(trades.slice(0, 1), skipped, true, 3).map((slot) => slot.state)).toEqual(["Completed", "Order pending", "Waiting"]);
    const rejected = tradeSlots([], [{ id: "x", time: m(5), side: "CALL", reason: "Stale option quote", lines: [] }], false, 3);
    expect(rejected[0]).toMatchObject({ state: "Rejected", reason: "Stale option quote", trade: null });
    expect(tradeSlots([], [], false, 3).every((slot) => slot.state === "Waiting" && slot.trade == null)).toBe(true);
  });

  it("the activity feed lists actual events newest first, tagged with trade numbers, sides and P&L", async () => {
    const { result } = await session();
    const feedItems = activityFeed(result.events);
    // Newest first: the open trade's confirmations, then its entry.
    expect(feedItems.find((item) => item.kind !== "confirm")).toMatchObject({ kind: "opened", trade: 2, side: "CALL" });
    expect(feedItems.filter((item) => item.kind === "confirm").every((item) => item.trade != null)).toBe(true);
    const closed = feedItems.find((item) => item.kind === "closed");
    expect(closed).toMatchObject({ trade: 1, side: "PUT" });
    expect(closed?.pnl).toBeGreaterThan(0);
    expect(feedItems.filter((item) => item.kind === "signal").map((item) => item.side).sort()).toEqual(["CALL", "PUT"]);
    expect(feedItems.every((item, index) => index === 0 || item.time <= feedItems[index - 1].time)).toBe(true);
  });

  it("copied trade details are the trade's own figures", async () => {
    const { trades } = await session();
    const text = tradeSummary(trades[0], 3, null);
    expect(text).toMatch(/^Trade 1\/3 · BUY PUT · NIFTY 23150 PE/);
    expect(text).toMatch(/Exit \d\d:\d\d IST · ₹[\d,.]+ \(Target\) · realized \+₹/);
    expect(text).toMatch(/simulated replay trade/);
    const open = tradeSummary(trades[1], 3, null);
    expect(open).toMatch(/Open · premium — · unrealized —/);
  });

  it("money parsing and formatting are exact and never invent a value", () => {
    expect(rupeesOf("+₹1,250.40")).toBe(1250.4);
    expect(rupeesOf("−₹12.05")).toBe(-12.05);
    expect(rupeesOf("-₹3.00")).toBe(-3);
    expect(rupeesOf("₹1,00,000.00")).toBe(100000);
    expect(rupeesOf(null)).toBeNull();
    expect(rupeesOf("—")).toBeNull();
    expect(money(1250.4, true)).toBe("+₹1,250.40");
    expect(money(-12.05, true)).toBe("−₹12.05");
    const live = readFileSync("src/components/algo/live-value.tsx", "utf8");
    expect(live).toMatch(/if \(value == null \|\| !Number\.isFinite\(value\)\) return <span className=\{cx\("text-muted", className\)\}>\{missing\}<\/span>;/);
    expect(live).not.toMatch(/Math\.random/);
  });

  it("opening, closing and using the trade view never touches the replay clock, and it reads the live run", () => {
    const desk = readFileSync("src/components/chart-desk.tsx", "utf8");
    const show = desk.slice(desk.indexOf("const showTrade = useCallback"), desk.indexOf("}, [algoTrades]);", desk.indexOf("const showTrade = useCallback")));
    expect(show).not.toMatch(/setReplay/);
    expect(desk).toMatch(/const closeTrade = useCallback\(\(\) => \{ setOpenTrade\(null\); setLineFocus\(null\); \}, \[\]\);/);
    expect(desk).toMatch(/onClose=\{closeTrade\}/);
    const drawer = readFileSync("src/components/algo/algo-trade-drawer.tsx", "utf8");
    expect(drawer).toMatch(/const run = algo\.run;/);
    expect(drawer).not.toMatch(/useState<.*(premium|pnl|unrealized)/i);
    expect(drawer).toMatch(/<ExitConfirm algo=\{algo\}/);
    expect(drawer).toMatch(/navigator\.clipboard\.writeText\(tradeSummary\(/);
  });

  it("cards, slots, activity rows and chart markers all open the same trade; Focus moves the chart", () => {
    const desk = readFileSync("src/components/chart-desk.tsx", "utf8");
    const panel = readFileSync("src/components/algo/algo-replay-panel.tsx", "utf8");
    expect(desk).toMatch(/onMarkerClick=\{\(ids\) => \{[\s\S]{0,200}selectTrade\(entryKey\)/);
    expect(panel.match(/onOpenTrade\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(readFileSync("src/components/chart-panel.tsx", "utf8")).toMatch(/focus: \(from, to\) => \{[\s\S]{0,900}setVisibleLogicalRange/);
  });
});

describe("replay session lifecycle: archive on exit, fresh session on the next replay", () => {
  const algoAccount = () => db.state.accounts.find((row) => row.mode === "ALGO")!;
  function threeTrades(): Candle[] {
    // Down at 30, up at 60, down at 90: three crossings → three entries (each closes at its target).
    const candles: Candle[] = [];
    for (let index = 0; index < 375; index += 1) {
      const close = index < 30 ? LINE + 10 : index < 60 ? LINE - 10 : index < 90 ? LINE + 10 : LINE - 10;
      const open = index === 30 || index === 90 ? LINE + 8 : index === 60 ? LINE - 8 : close;
      candles.push({ time: m(index), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 });
    }
    return candles;
  }
  const targets = (index: number) => (index === 36 || index === 66 || index === 96 ? { low: 100, high: 150, close: 145 } : null);

  it("three trades, then a fresh period: ₹1,00,000, nothing reserved, the old period ended with its trades kept", async () => {
    feed.premiums = premiums(targets);
    const session = await run(threeTrades(), { cursor: m(110) });
    expect(algoTrades(session.events, null)).toHaveLength(3);
    expect(db.state.closed).toHaveLength(3);
    expect(cash()).not.toBe(START);
    const fresh = await startAlgoPeriod("u1", "Algo replay session ended (EXIT_REPLAY).");
    expect(fresh.reused).toBe(false);
    expect(cash()).toBe(START);
    expect(algoAccount().cashReserved).toBe(0n);
    expect(algoAccount().currentPeriodId).toBe(fresh.periodId);
    expect(db.state.periods.find((row) => row.id === "p1")?.endedAt).toBeInstanceOf(Date);
    // The archived session's records are untouched and still belong to the old period.
    expect(db.state.closed.every((row) => row.practicePeriodId === "p1")).toBe(true);
    expect(db.state.ledger.at(-1)).toMatchObject({ type: "RESET_OPENING", cashDelta: START, practicePeriodId: fresh.periodId });
  });

  it("starting twice opens only one fresh period (an unused period is reused)", async () => {
    feed.premiums = premiums(targets);
    await run(threeTrades(), { cursor: m(40) });
    const first = await startAlgoPeriod("u1", "end");
    const second = await startAlgoPeriod("u1", "end again");
    expect(second).toMatchObject({ reused: true, periodId: first.periodId });
    expect(db.state.periods.filter((row) => String(row.label ?? "").startsWith("Algo session"))).toHaveLength(1);
  });

  it("the next session starts at zero: new id, 0 entries, no trades or markers, and orders on the new period", async () => {
    feed.premiums = premiums(targets);
    const old = await run(threeTrades(), { cursor: m(110) });
    const period = await startAlgoPeriod("u1", "end");
    const next = await stepChartRun({
      user: student, wallet: "ALGO", runId: "run-new", session: "2026-10-16.fresh001", date: DATE, config, lines, candles: threeTrades(), chain: await loadOptionChain("NIFTY", null),
      sessionOpen: OPEN, sessionClose: CLOSE, now: NOW, state: { ...initialState(DATE), running: true, entries: true }, processedThrough: OPEN, cursor: m(20),
    });
    expect(next.state.tradesToday).toBe(0);
    expect(algoTrades(next.events, null)).toEqual([]);
    expect(tradeMarkers(next.events, m(20))).toEqual([]);
    expect(cash()).toBe(START);
    // Its first trade is a new order on the new period, with a key of the new run (never the old one's).
    const later = await stepChartRun({
      user: student, wallet: "ALGO", runId: "run-new", session: "2026-10-16.fresh001", date: DATE, config, lines, candles: threeTrades(), chain: await loadOptionChain("NIFTY", null),
      sessionOpen: OPEN, sessionClose: CLOSE, now: NOW, state: next.state, processedThrough: next.processedThrough, cursor: m(34),
    });
    expect(later.state.position?.entryKey).toMatch(/^algo:run-new:/);
    expect(db.state.orders.at(-1)?.practicePeriodId).toBe(period.periodId);
    expect(algoTrades(old.events, null)).toHaveLength(3);
  });

  it("an open position is closed at the last processed premium with the reason 'Replay session closed'", async () => {
    feed.premiums = premiums((index) => (index >= 33 ? { low: 109.5, high: 110.5, close: 110 } : null));
    const opened = await run(threeTrades(), { cursor: m(34) });
    const base = { user: student, wallet: "ALGO" as const, runId: "run1", session: SESSION, date: DATE, config, lines, candles: threeTrades(), chain: await loadOptionChain("NIFTY", null), sessionOpen: OPEN, sessionClose: CLOSE, now: NOW };
    const closed = await exitChartRun({ ...base, state: opened.state, at: opened.processedThrough, reason: "SESSION_CLOSED" });
    expect(closed.state.position).toBeNull();
    const exit = closed.events.find((event) => event.kind === "EXIT")!;
    expect(exit.message).toMatch(/^Exit \(SESSION_CLOSED\)/);
    expect(algoTrades([...opened.events, ...closed.events], null)[0].exitReason).toBe("Replay session closed");
    expect(db.state.positions[0].quantity).toBe(0);
  });

  it("without a premium the position is not filled: it stays open (archived as unresolved)", async () => {
    const opened = await run(threeTrades(), { cursor: m(34) });
    feed.missing = true;
    clearReplayTapes();
    const base = { user: student, wallet: "ALGO" as const, runId: "run1", session: SESSION, date: DATE, config, lines, candles: threeTrades(), chain: await loadOptionChain("NIFTY", null), sessionOpen: OPEN, sessionClose: CLOSE, now: NOW };
    await expect(exitChartRun({ ...base, state: opened.state, at: opened.processedThrough, reason: "SESSION_CLOSED" })).rejects.toThrow(/premium/i);
    expect(sells()).toHaveLength(0);
    expect(db.state.positions[0].quantity).toBe(75);
  });

  it("the server archives once (repeated Exit Replay is a no-op) and the archive is written before anything is cleared", () => {
    const server = readFileSync("src/server/algo.ts", "utf8");
    expect(server).toMatch(/if \(existing\.status === "ENDED" && existing\.summary\) return;/);
    const archive = server.slice(server.indexOf("async function archiveRun"), server.indexOf("export async function algoHistory"));
    expect(archive.indexOf("await saveChartRun(run")).toBeGreaterThan(-1);
    expect(archive.indexOf("await saveChartRun(run")).toBeLessThan(archive.indexOf("await startAlgoPeriod("));
    expect(archive).toMatch(/summary: summary as unknown as Prisma\.InputJsonValue/);
    // Strategy settings are never touched by ending a session.
    expect(archive).not.toMatch(/algoSession\.update/);
    // A new run always opens (or reuses an unused) fresh period.
    expect(server).toMatch(/const period = await startAlgoPeriod\(user\.id, `Algo replay session \$\{command\.session\}`\);/);
  });

  it("the chart clears its session only after the archive succeeded, and ignores late responses from an old session", () => {
    const hook = readFileSync("src/components/algo/use-chart-algo.ts", "utf8");
    const end = hook.slice(hook.indexOf("const endSession = useCallback"), hook.indexOf("const gate: PlayGate"));
    expect(end.indexOf("if (!ok) return false;")).toBeGreaterThan(-1);
    expect(end.indexOf("if (!ok) return false;")).toBeLessThan(end.indexOf("forgetSession();"));
    expect(hook).toMatch(/if \(sessionRef\.current !== asked\) return;/);
    expect(hook).toMatch(/next\.chart && next\.chart\.replaySession !== sessionRef\.current \? \{ \.\.\.next, chart: null \}/);
    expect(hook).toMatch(/id = newReplaySession\(date\);/);
    const desk = readFileSync("src/components/chart-desk.tsx", "utf8");
    const exit = desk.slice(desk.indexOf("async function endAlgoSession"), desk.indexOf("async function endAlgoSession") + 600);
    expect(exit.indexOf("if (!(await algo.finalize())) return;")).toBeLessThan(exit.indexOf("continueExitReplay()"));
    expect(exit).toMatch(/setOpenTrade\(null\);/);
    expect(desk).toMatch(/function requestExitReplay\(\) \{\s*if \(algoAllowed && algo\.hasSession\)/);
  });

  it("Home shows Algo History read-only", () => {
    expect(readFileSync("src/components/home.tsx", "utf8")).toMatch(/<AlgoSessionsCard \/>/);
    const server = readFileSync("src/server/algo.ts", "utf8");
    const history = server.slice(server.indexOf("export async function algoHistory"));
    expect(history).not.toMatch(/\.(update|create|upsert|delete)\w*\(/);
    expect(readFileSync("src/app/api/algo/route.ts", "utf8")).toMatch(/params\.get\("history"\) === "1"/);
  });
});

describe("minimal chart markers, completion after the last trade, Algo on by default", () => {
  function threeTrades(): Candle[] {
    const candles: Candle[] = [];
    for (let index = 0; index < 375; index += 1) {
      const close = index < 30 ? LINE + 10 : index < 60 ? LINE - 10 : index < 90 ? LINE + 10 : index < 120 ? LINE - 10 : LINE + 10;
      const open = index === 30 || index === 90 ? LINE + 8 : index === 60 || index === 120 ? LINE - 8 : close;
      candles.push({ time: m(index), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 });
    }
    return candles;
  }
  // Trade 1 wins (target at 36), trade 2 loses (stop at 66), trade 3 wins (target at 96).
  const outcomes = (index: number) => (index === 36 || index === 96 ? { low: 100, high: 150, close: 145 } : index === 66 ? { low: 60, high: 100, close: 70 } : null);
  const tokens = { profit: "#0f0", loss: "#f00", muted: "#888" };

  it("entries are small triangles and exits small outcome-coloured dots, with no text and no duplicates", async () => {
    feed.premiums = premiums(outcomes);
    const result = await run(threeTrades(), { cursor: m(110) });
    const trades = tradeMarkers(result.events, m(110));
    const markers = algoChartMarkers([...trades, ...trades], tokens, null);
    expect(markers).toHaveLength(6);
    expect(markers.every((marker) => marker.text === "" && marker.size === MARKER_SIZE)).toBe(true);
    const entries = markers.filter((marker) => marker.shape !== "circle");
    expect(entries.map((marker) => [marker.shape, marker.color])).toEqual([["arrowDown", "#f00"], ["arrowUp", "#0f0"], ["arrowDown", "#f00"]]);
    const exits = markers.filter((marker) => marker.shape === "circle");
    expect(exits.map((marker) => marker.color)).toEqual(["#0f0", "#f00", "#0f0"]);
    // Break-even exits are grey; the selected trade's markers are a little larger.
    const even = algoChartMarkers([{ ...trades[1], pnl: 0 }], tokens, null);
    expect(even[0].color).toBe("#888");
    expect(algoChartMarkers(trades, tokens, trades[0].entryKey).filter((marker) => marker.size === SELECTED_MARKER_SIZE)).toHaveLength(2);
    expect(trades[0].tip).toMatch(/^PUT entry · \d\d:\d\d · ₹/);
    expect(trades[1].tip).toMatch(/^PUT exit \(Target\) · \d\d:\d\d · \+₹/);
  });

  it("trades 1 and 2 completing do not stop the replay; trade 3 open does not either", async () => {
    feed.premiums = premiums(outcomes);
    const two = await run(threeTrades(), { cursor: m(80) });
    expect(algoTrades(two.events, null).filter((trade) => trade.status === "COMPLETED")).toHaveLength(2);
    expect(two.completed).toBe(false);
    const third = await run(threeTrades(), { state: two.state, processedThrough: two.processedThrough, cursor: m(93) });
    expect(third.state.position).not.toBeNull();
    expect(third.completed).toBe(false);
    expect(sessionComplete(third.state, 3)).toBe(false);
  });

  it("when the third trade exits, processing stops at that minute and no fourth entry can happen", async () => {
    feed.premiums = premiums(outcomes);
    const result = await run(threeTrades(), { cursor: m(200) });
    expect(result.completed).toBe(true);
    expect(result.state.position).toBeNull();
    expect(result.processedThrough).toBe(m(97));
    expect(buys()).toHaveLength(3);
    expect(sells()).toHaveLength(3);
    // The crossing at minute 120 is never evaluated; another step later does nothing at all.
    expect(result.events.some((event) => event.key === `eval:${m(120)}`)).toBe(false);
    const again = await run(threeTrades(), { state: result.state, processedThrough: result.processedThrough, cursor: m(250) });
    expect(again).toMatchObject({ completed: true, processedThrough: m(97), events: [] });
    expect(buys()).toHaveLength(3);
  });

  it("the server archives the completed session once (COMPLETED) and keeps its figures for the summary", () => {
    const server = readFileSync("src/server/algo.ts", "utf8");
    expect(server).toMatch(/if \(ran\.completed\) await completeRun\(user, existing\.id, wallet\);/);
    expect(server).toMatch(/async function completeRun[\s\S]{0,300}if \(run\.status === "ENDED" && run\.summary\) return;[\s\S]{0,200}"COMPLETED"/);
    expect(server).toMatch(/if \(wallet === "ALGO" && reason !== "COMPLETED"\) await startAlgoPeriod/);
    expect(server).toMatch(/!command\.emergency && sessionComplete\(current, runConfig\.maxTrades\)/);
    expect(readFileSync("src/server/algo-replay.ts", "utf8")).toMatch(/if \(sessionComplete\(state, input\.config\.maxTrades\)\) \{\s*completed = true;\s*break;/);
  });

  it("the chart pauses on completion, shows the summary once, and Close keeps the replay paused", () => {
    const hook = readFileSync("src/components/algo/use-chart-algo.ts", "utf8");
    expect(hook).toMatch(/run\.status === "ENDED" && run\.endReason === "COMPLETED"/);
    expect(hook).toMatch(/if \(!shown\.includes\(run\.id\)\)/);
    const desk = readFileSync("src/components/chart-desk.tsx", "utf8");
    expect(desk).toMatch(/onComplete: \(run\) => \{\s*setReplay\(\(current\) => \(\{ \.\.\.current, status: current\.status === "completed" \? "completed" : "paused"/);
    expect(desk).toMatch(/onClose=\{\(\) => setAlgoDone\(null\)\}/);
    expect(desk).toMatch(/algo\.run\?\.status === "ENDED" && algo\.run\.endReason === "COMPLETED"\) \{\s*setAlgoDone\(algo\.run\);\s*return;/);
    const dialog = readFileSync("src/components/algo/algo-replay-panel.tsx", "utf8");
    expect(dialog).toMatch(/title="Algo Session Completed"/);
    expect(dialog).toMatch(/All \{max\} trades are completed\. Replay has been paused\./);
    expect(dialog).toMatch(/View Trade History/);
    expect(dialog).toMatch(/Start New Replay/);
  });

  it("Algo starts enabled; an explicit switch-off is kept for the session and a new session turns it on again", () => {
    const hook = readFileSync("src/components/algo/use-chart-algo.ts", "utf8");
    expect(hook).toMatch(/return localStorage\.getItem\(enabledKey\(user\)\) !== "0";/);
    expect(hook).toMatch(/const forgetSession = useCallback\(\(\) => \{[\s\S]{0,300}remember\(true\);/);
    expect(hook).toMatch(/queueMicrotask\(\(\) => void command\("mode", \{ action: "chartMode" \}\)\)/);
    // Never switched to chart replay while a live-price session or position is active.
    expect(hook).toMatch(/if \(data\.state\.running \|\| data\.state\.position \|\| data\.state\.pending\) return;/);
  });
});

describe("price-action strategies through the shared coordinator and the real ledger", () => {
  const W = [100, 102, 104, 108, 104, 101, 100, 102, 104, 106, 103, 101, 100, 101, 102, 103, 110];
  /** Flat until `start`, then the W fixture (scaled ×10 around 23,000), then flat above the neckline. */
  function wDay(start: number): Candle[] {
    const closes: number[] = [];
    for (let index = 0; index < 375; index += 1) {
      const step = index - start;
      closes.push(step < 0 ? 23_000 : step < W.length ? 23_000 + (W[step] - 100) * 10 : 23_100 + (W.length - step) * 0);
    }
    return closes.map((close, index) => {
      const open = index === 0 ? close : closes[index - 1];
      return { time: m(index), open, high: Math.max(open, close) + 5, low: Math.min(open, close) - 5, close, volume: 0 };
    });
  }
  const wOnly: AlgoConfig = { ...config, strategies: { line: false, trendline: false, w: true, m: false, orb: false, bounce: false, rejection: false } };

  it("a W neckline breakout after 09:30 places one ATM CALL, recording its strategy and setup", async () => {
    // Pattern from 09:45; the breakout candle is index 46 (10:01), closing at 10:02.
    const result = await run(wDay(30), { cursor: m(50), config: wOnly });
    expect(buys()).toHaveLength(1);
    expect(String(db.state.instruments[0].symbol)).toContain("|CE|");
    expect(result.state.position?.setup).toMatchObject({ strategy: "w", direction: "CALL", level: 23_065, invalidation: 22_995 });
    const entry = result.events.find((event) => event.kind === "ENTRY");
    expect(entry?.time).toBe(m(46));
    expect(entry?.setup?.strategy).toBe("w");
    const evaluation = result.events.find((event) => event.key === `eval:${m(46)}`)?.evaluation;
    expect(evaluation?.strategies?.map((item) => item.strategy)).toEqual(["w"]);
    expect(algoTrades(result.events, null)[0]).toMatchObject({ strategy: "w", strategies: ["w"] });
    // The market analysis is stored for the dashboard and the chart.
    expect(result.state.analysis?.w?.neckline).toBe(23_065);
    expect(result.state.analysis?.strategies.w.lastSignal).toEqual({ time: m(46), direction: "CALL" });
  });

  it("intratrade confirmations are logged when their status changes, never repeated for the same state", async () => {
    const result = await run(wDay(30), { cursor: m(60), config: wOnly });
    const confirmations = result.events.filter((event) => event.key.startsWith("confirm:"));
    expect(confirmations.length).toBeGreaterThan(0);
    expect(result.state.confirmations?.map((item) => item.category)).toEqual(["price", "level", "candle", "volume", "momentum", "risk"]);
    expect(result.state.confirmations?.find((item) => item.category === "volume")?.status).toBe("UNAVAILABLE");
    const keys = confirmations.map((event) => event.key.split(":").slice(-3, -1).join(":"));
    for (let index = 1; index < keys.length; index += 1) {
      const category = keys[index].split(":")[0];
      const previous = keys.slice(0, index).reverse().find((key) => key.startsWith(`${category}:`));
      expect(previous).not.toBe(keys[index]);
    }
    expect(buys()).toHaveLength(1);
  });

  it("no entry inside the observation window, and the opening breakout is not traded when it ends", async () => {
    // The breakout candle (index 16) closes at 09:32, inside a 30-minute observation.
    const result = await run(wDay(0), { cursor: m(80), config: { ...wOnly, observationMinutes: 30 } });
    expect(db.state.orders).toHaveLength(0);
    expect(result.state.analysis?.observationComplete).toBe(true);
    expect(result.state.analysis?.w?.status).toBe("BROKEN");
  });

  it("the line break can be switched off; it alone still trades as before when the others are off", async () => {
    await run(underlying("DOWN"), { cursor: m(40), config: { ...config, strategies: { line: false, trendline: false, w: false, m: false, orb: false, bounce: false, rejection: false } } });
    expect(db.state.orders).toHaveLength(0);
    const lineOnly = await run(underlying("DOWN"), { cursor: m(40), config: { ...config, strategies: { line: true, trendline: false, w: false, m: false, orb: false, bounce: false, rejection: false } } });
    expect(lineOnly.state.position?.setup).toMatchObject({ strategy: "line", level: LINE });
  });
});

describe("trade report download and retrade", () => {
  function threeDone(): Candle[] {
    const candles: Candle[] = [];
    for (let index = 0; index < 375; index += 1) {
      const close = index < 30 ? LINE + 10 : index < 60 ? LINE - 10 : index < 90 ? LINE + 10 : index < 120 ? LINE - 10 : LINE + 10;
      const open = index === 30 || index === 90 ? LINE + 8 : index === 60 || index === 120 ? LINE - 8 : close;
      candles.push({ time: m(index), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 0 });
    }
    return candles;
  }
  const outcomes = (index: number) => (index === 36 || index === 96 ? { low: 100, high: 150, close: 145 } : index === 66 ? { low: 60, high: 100, close: 70 } : null);

  it("the CSV has the summary, every trade and the complete flow of the session, with quoted cells", async () => {
    feed.premiums = premiums(outcomes);
    const result = await run(threeDone(), { cursor: m(200) });
    expect(result.completed).toBe(true);
    const csv = algoReportCsv({
      sessionId: SESSION, underlying: "NIFTY", date: DATE, status: "ENDED", endReason: "COMPLETED", startedAt: NOW.toISOString(), endedAt: NOW.toISOString(),
      startCapital: 100_000, endCash: 101_000, summary: { account: { equity: "₹1,01,000.00" } }, settings: config, stats: runStats(result.events), events: result.events,
    });
    expect(csv.startsWith("﻿TradeD Algo trade report,")).toBe(true);
    const lines = csv.trim().split("\r\n");
    const tradesAt = lines.indexOf("TRADES");
    const flowAt = lines.indexOf("FULL FLOW");
    expect(tradesAt).toBeGreaterThan(0);
    expect(flowAt).toBeGreaterThan(tradesAt);
    // Three trades, numbered, with their exit reasons and P&L.
    const tradeRows = lines.slice(tradesAt + 2, flowAt - 1);
    expect(tradeRows).toHaveLength(3);
    expect(tradeRows.map((line) => line.split(",")[0])).toEqual(["1", "2", "3"]);
    expect(tradeRows.map((line) => line.split(",")[1])).toEqual(["BUY PUT", "BUY CALL", "BUY PUT"]);
    expect(tradeRows[0]).toMatch(/,Target,/);
    expect(tradeRows[1]).toMatch(/,Stop-loss,/);
    // Every logged event is one flow row (candles checked, signals, orders, confirmations, exits).
    expect(lines.length - (flowAt + 2)).toBe(result.events.length);
    const flow = lines.slice(flowAt + 2).join("\n");
    for (const kind of ["Candle checked", "PUT signal", "Entry (BUY)", "Exit (SELL)", "Confirmation"]) expect(flow).toContain(kind);
    expect(lines.find((line) => line.startsWith("Trades,"))).toBe("Trades,3/3");
    expect(csvCell('a, "b"\nc')).toBe('"a, ""b""\nc"');
    expect(algoReportName({ underlying: "NIFTY", date: DATE, sessionId: SESSION })).toBe("TradeD-Algo-NIFTY-2026-10-16-algo1234.csv");
  });

  it("only the signed-in user's own session can be downloaded; the report reads the stored record", () => {
    const server = readFileSync("src/server/algo.ts", "utf8");
    const report = server.slice(server.indexOf("export async function algoReport"));
    expect(report).toMatch(/prisma\.algoRun\.findFirst\(\{ where: \{ id: runId, sessionId: session\.id \} \}\)/);
    expect(report).toMatch(/throw new AppError\("This Algo session was not found\.", 404/);
    expect(report).not.toMatch(/\.(update|create|upsert|delete)\w*\(/);
    expect(readFileSync("src/app/api/algo/route.ts", "utf8")).toMatch(/if \(!\/\^\[a-z0-9\]\{8,40\}\$\/\.test\(report\)\)/);
  });

  it("finished sessions offer the download and a retrade in the panel, the popup and Home", () => {
    const panel = readFileSync("src/components/algo/algo-replay-panel.tsx", "utf8");
    expect(panel).toMatch(/\{run && run\.status === "ENDED" \? <SessionFinished runId=\{run\.id\}/);
    expect(panel).toMatch(/Download trade report/);
    expect(panel).toMatch(/Retrade this day/);
    expect(panel).toMatch(/const report = useReportDownload\(run\.id\);/);
    const desk = readFileSync("src/components/chart-desk.tsx", "utf8");
    expect(desk).toMatch(/onRetrade=\{retrade\}/);
    expect(desk).toMatch(/onNewReplay=\{retrade\}/);
    expect(desk).toMatch(/function retrade\(\) \{[\s\S]{0,300}algo\.startNew\(\);\s*returnToStart\(\);\s*setAlgoDialog\(true\);/);
    expect(readFileSync("src/components/algo/algo-sessions.tsx", "utf8")).toMatch(/downloadAlgoReport\(session\.id\)/);
  });
});

describe("the first 30 minutes are for reading the market", () => {
  it("the early session has no waiting period: settings from before version 4 move to 0 once, later choices are kept", () => {
    expect(ALGO_DEFAULTS.observationMinutes).toBe(0);
    expect(readAlgoConfig({ observationMinutes: 30, settingsVersion: 3 }).observationMinutes).toBe(0);
    expect(readAlgoConfig({}).observationMinutes).toBe(0);
    // Saved under the current version (4): a 15-minute choice stays 15, and the same for a 10% stop / 25% target.
    const saved = readAlgoConfig({ observationMinutes: 15, settingsVersion: 4, stop: { mode: "percent", value: 10 }, target: { mode: "percent", value: 25 } });
    expect([saved.observationMinutes, saved.stop.value, saved.target.value]).toEqual([15, 10, 25]);
    expect(readAlgoConfig(saved)).toEqual(saved);
  });

  it("a crossing at 09:40 is not traded (analysis only); the same crossing at 09:46 is", async () => {
    const early = await run(underlying("DOWN", 25), { cursor: m(40), config: { ...config, observationMinutes: 30 } });
    expect(db.state.orders).toHaveLength(0);
    const rejected = early.events.find((event) => event.key === `eval:${m(25)}`);
    expect(rejected?.reasons?.join(" ")).toMatch(/Observation period: the first 30 minutes \(to 09:45 IST\) are analysis only/);
    const later = await run(underlying("DOWN", 30), { cursor: m(40), config: { ...config, observationMinutes: 30 } });
    expect(later.state.position).not.toBeNull();
  });
});

describe("trade filters and the structure stop (against false breaks and whipsaws)", () => {
  /** Candles from closes (open = previous close; a one-point wick each side). Index 0 opens at its close. */
  function fromCloses(closes: number[]): Candle[] {
    return closes.map((close, index) => {
      const open = index === 0 ? close : closes[index - 1];
      return { time: m(index), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 0 };
    });
  }
  /** 375 closes: `base` everywhere except the given minute → close overrides. */
  function day(base: number, overrides: Record<number, number>): Candle[] {
    let last = base;
    return fromCloses(Array.from({ length: 375 }, (_, index) => {
      if (index in overrides) last = overrides[index];
      return last;
    }));
  }
  const only = (patch: Partial<AlgoConfig["filters"]> = {}, structureStop = false): AlgoConfig => ({ ...config, filters: { levelBlockMinutes: 0, breakoutBufferPercent: 0, secondCandle: false, momentum: false, ...patch }, structureStop });

  it("breakout buffer: a close 2 points past the line is not a break; 10 points past it is", async () => {
    await run(day(LINE + 10, { 30: LINE - 2 }), { cursor: m(40), config: only({ breakoutBufferPercent: 0.03 }) });
    expect(db.state.orders).toHaveLength(0);
    const clear = await run(day(LINE + 10, { 30: LINE - 10 }), { cursor: m(40), config: only({ breakoutBufferPercent: 0.03 }) });
    expect(clear.state.position?.side).toBe("PUT");
  });

  it("second candle: enters on the next candle only when its whole body stays beyond the line", async () => {
    const confirmed = await run(day(LINE + 10, { 30: LINE - 10, 31: LINE - 15 }), { cursor: m(40), config: only({ secondCandle: true }) });
    const entry = confirmed.events.find((event) => event.kind === "ENTRY");
    expect(entry?.time).toBe(m(31));
    expect(confirmed.events.find((event) => event.key === `eval:${m(31)}`)?.message).toMatch(/^Second candle confirmed/);
  });

  it("second candle: a signal whose next candle comes back is dropped (no trade)", async () => {
    // The next candle closes back on the line (not beyond it, and not a new crossing either).
    const failed = await run(day(LINE + 10, { 30: LINE - 10, 31: LINE }), { cursor: m(40), config: only({ secondCandle: true }) });
    expect(db.state.orders).toHaveLength(0);
    expect(failed.events.find((event) => event.key === `eval:${m(31)}`)?.message).toMatch(/signal was not confirmed/);
  });

  it("momentum: a PUT against a rising 9 / 21 EMA is rejected with the reason", async () => {
    // A steady rise for 30 minutes, then one candle closing just below the line.
    const rising: Record<number, number> = {};
    for (let index = 0; index < 30; index += 1) rising[index] = LINE - 60 + index * 3;
    rising[29] = LINE + 5;
    rising[30] = LINE - 5;
    const result = await run(day(LINE, rising), { cursor: m(40), config: only({ momentum: true }) });
    expect(db.state.orders).toHaveLength(0);
    expect(result.events.find((event) => event.key === `eval:${m(30)}`)?.reasons?.join(" ")).toMatch(/Momentum against the signal/);
  });

  it("level block: after a stop on a line, the same line is not traded again for 15 minutes", async () => {
    // PUT at 30 is stopped at 33; the line is crossed up at 40 (blocked) and down again at 60 (allowed).
    feed.premiums = premiums((index) => (index === 33 ? { low: 60, high: 100, close: 70 } : null));
    const result = await run(day(LINE + 10, { 30: LINE - 10, 40: LINE + 10, 60: LINE - 10 }), { cursor: m(70), config: only({ levelBlockMinutes: 15 }) });
    expect(result.events.find((event) => event.key === `eval:${m(40)}`)?.reasons?.join(" ")).toMatch(/was stopped out recently: not traded again until 10:04 IST/);
    expect(buys()).toHaveLength(2);
    expect(algoTrades(result.events, null).map((trade) => trade.side)).toEqual(["PUT", "PUT"]);
  });

  it("structure stop: exits when the index closes back through the broken line, at the option's price", async () => {
    const result = await run(day(LINE + 10, { 30: LINE - 10, 35: LINE + 10 }), { cursor: m(40), config: only({}, true) });
    const exit = result.events.find((event) => event.kind === "EXIT");
    expect(exit?.message).toMatch(/^Exit \(STRUCTURE\).*Index closed at 23160\.00, back above the broken level 23150\.00/);
    expect(exit?.time).toBe(m(36));
    expect(algoTrades(result.events, null)[0].exitReason).toBe("Setup invalidated");
  });

  it("your losing day: a line crossed up, down and up within minutes gives at most one trade with the defaults", async () => {
    // Like 22 Oct: up at 31, down at 32, up at 34, down at 35 around one line, each by ~12 points.
    const chop = day(LINE - 12, { 31: LINE + 12, 32: LINE - 12, 34: LINE + 12, 35: LINE - 12, 37: LINE + 12, 38: LINE - 12 });
    // Each trade's option premium dips through its stop the minute after entry (as on your day).
    feed.premiums = premiums((index) => ([32, 33, 35, 36, 38, 39].includes(index) ? { low: 60, high: 100, close: 100 } : null));
    await run(chop, { cursor: m(60), config: { ...config, filters: ALGO_DEFAULTS.filters, structureStop: true } });
    expect(buys().length).toBeLessThanOrEqual(1);
    // Without the filters the same minutes trade three times (the losses you saw).
    Object.assign(db.state, { accounts: [{ id: "acc1", userId: "u1", mode: "ALGO", currentPeriodId: "p1", cashAvailable: START, cashReserved: 0n }], orders: [], instruments: [], positions: [], executions: [], ledger: [], quotes: [], closed: [], periods: [], seq: 0 });
    await run(chop, { cursor: m(60), config: { ...only(), maxTrades: 3 } });
    expect(buys().length).toBeGreaterThanOrEqual(3);
  });

  it("old saved settings: a 5% / 10% stop and target become 20% / 40% once; later choices are kept", () => {
    const old = readAlgoConfig({ stop: { mode: "percent", value: 5 }, target: { mode: "percent", value: 10 }, settingsVersion: 2 });
    expect([old.stop.value, old.target.value, old.structureStop]).toEqual([20, 40, true]);
    expect(old.filters).toEqual(ALGO_DEFAULTS.filters);
    const chosen = readAlgoConfig({ stop: { mode: "percent", value: 5 }, target: { mode: "percent", value: 10 }, settingsVersion: 3 });
    expect([chosen.stop.value, chosen.target.value]).toEqual([5, 10]);
  });
});

describe("session strategy: 09:15–12:00, risk-based sizing", () => {
  // Line break only (the other setups have their own tests), no filters, any score: the window and sizing alone.
  const early: AlgoConfig = { ...ALGO_DEFAULTS, mode: "REPLAY", strategies: { line: true, trendline: false, w: false, m: false, orb: false, bounce: false, rejection: false }, minScore: 0, cooldownMinutes: 0, filters: { levelBlockMinutes: 0, breakoutBufferPercent: 0, secondCandle: false, momentum: false }, structureStop: false };
  /** Flat 10 above the line, a body crossing down to `by` below it at `at`, then flat there; `after` overrides closes. */
  function crossing(at: number, by: number, after: Record<number, number> = {}): Candle[] {
    const candles: Candle[] = [];
    for (let index = 0; index < 375; index += 1) {
      const close = after[index] ?? (index < at ? LINE + 10 : LINE - by);
      const open = index === at ? LINE + 8 : index > 0 ? candles[index - 1].close : close;
      candles.push({ time: m(index), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 });
    }
    return candles;
  }

  it("acts on the 09:16 candle at 09:17 (no waiting period), sized so the stop risks at most ₹500", async () => {
    const result = await run(crossing(1, 3), { cursor: m(4), config: early });
    expect(buys()).toHaveLength(1);
    const entry = result.events.find((event) => event.kind === "ENTRY")!;
    expect(entry.time).toBe(m(1));
    expect(entry.message).toMatch(/Index stop 23156\.\d+, index target 23\d+\.\d+ \(reward : risk 2\); \d+ lots? risking ₹\d+\.\d+ of ₹500\.00/);
    const risk = Number(/risking ₹(\d+\.\d+)/.exec(entry.message)![1]);
    expect(risk).toBeLessThanOrEqual(500);
    expect(entry.setup).toMatchObject({ stopIndex: expect.any(Number), targetIndex: expect.any(Number) });
  });

  it("no trade when even one lot would risk more than ₹500; the engine says why", async () => {
    const result = await run(crossing(1, 10), { cursor: m(2), config: early });
    expect(buys()).toHaveLength(0);
    const rejected = result.events.find((event) => event.kind === "REJECTED")!;
    expect(rejected.message).toContain("above the ₹500.00 risk per trade: no trade");
    expect(result.state.engine).toMatchObject({ status: "NO_TRADE" });
  });

  it("no new entries after 12:00: the trading window is closed", async () => {
    const result = await run(crossing(170, 3), { cursor: m(172), config: early });
    expect(buys()).toHaveLength(0);
    expect(result.events.some((event) => event.kind === "REJECTED" && event.message.includes("Trading window closed at 12:00 IST"))).toBe(true);
    expect(result.state.engine).toMatchObject({ status: "TRADING_WINDOW_CLOSED" });
  });

  it("the index stop closes the trade when the index closes back through it", async () => {
    // From minute 5 the index stays back above the line (no new crossing after the stop).
    const back = Object.fromEntries(Array.from({ length: 370 }, (_, index) => [index + 5, LINE + 8]));
    const result = await run(crossing(1, 3, back), { cursor: m(8), config: early });
    expect(buys()).toHaveLength(1);
    expect(sells()).toHaveLength(1);
    expect(result.events.find((event) => event.kind === "EXIT")?.message).toMatch(/Exit \(STOP\).*through the stop 23156/);
  });

  it("no new entries once the daily target is reached, or after the daily loss limit", async () => {
    const target = await run(crossing(1, 3), { cursor: m(3), config: early, state: { ...initialState(DATE), running: true, entries: true, realizedToday: 5_000 } });
    expect(buys()).toHaveLength(0);
    expect(target.events.some((event) => event.message.includes("Daily target ₹5000 reached"))).toBe(true);
    const lost = await run(crossing(1, 3), { cursor: m(3), config: early, state: { ...initialState(DATE), running: true, entries: true, realizedToday: -1_500 } });
    expect(buys()).toHaveLength(0);
    expect(lost.state.engine).toMatchObject({ status: "DAILY_RISK_LIMIT_REACHED" });
  });
});

describe("trailing stop", () => {
  it("moves the index stop to each swing high confirmed after a PUT entry, never back", async () => {
    const early: AlgoConfig = { ...ALGO_DEFAULTS, mode: "REPLAY", risk: { ...ALGO_DEFAULTS.risk, targetMode: "trail" }, strategies: { line: true, trendline: false, w: false, m: false, orb: false, bounce: false, rejection: false }, minScore: 0, cooldownMinutes: 0, filters: { levelBlockMinutes: 0, breakoutBufferPercent: 0, secondCandle: false, momentum: false }, structureStop: false };
    // Cross down at 1 (to LINE − 3), fall, bounce to a swing high at 6 (high LINE − 11), then fall further.
    const path: Record<number, number> = { 0: LINE + 10, 1: LINE - 3, 2: LINE - 10, 3: LINE - 14, 4: LINE - 18, 5: LINE - 22, 6: LINE - 12, 7: LINE - 24, 8: LINE - 28 };
    const candles: Candle[] = [];
    for (let index = 0; index < 375; index += 1) {
      const close = path[index] ?? LINE - 30;
      const open = index === 1 ? LINE + 8 : index > 0 ? candles[index - 1].close : close;
      candles.push({ time: m(index), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 1000 });
    }
    const result = await run(candles, { cursor: m(12), config: early });
    expect(buys()).toHaveLength(1);
    expect(sells()).toHaveLength(0);
    const moved = result.events.find((event) => event.message.startsWith("Trailing stop moved"));
    expect(moved?.message).toMatch(/from 23156\.94 to 23145\.94 \(beyond the swing high 23139\.00/);
    expect(result.state.position?.setup?.stopIndex).toBeLessThan(23_150);
  });
});
