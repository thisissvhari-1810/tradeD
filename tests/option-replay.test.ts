import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../src/lib/market/demo";
import type { OptionChainView } from "../src/server/option-chain";
import type { AppError } from "../src/lib/http";
import {
  FILL_STALE_SECONDS,
  newReplaySession,
  replayLedgerSymbol,
  replayPremiumAt,
  replaySessionDate,
  replaySessionOf,
  sessionBounds,
  sessionCoverage,
  sessionMinutes,
} from "../src/lib/options/replay-premium";
import { parseOptionLedgerSymbol } from "../src/lib/options/contract";
import { exitEstimate, ticketMath } from "../src/components/option-order-ticket";

type Row = Record<string, unknown> & { id: string };

const OPEN = Date.UTC(2026, 9, 16, 3, 45) / 1000;
const at = (hour: number, minute: number, second = 0) => Date.UTC(2026, 9, 16, hour - 5, minute - 30, second) / 1000;
/** Test fixture: one candle per minute; close rises 0.5 a minute from 100. */
function fixtureTape(minutes = 375, skip: (index: number) => boolean = () => false): Candle[] {
  const tape: Candle[] = [];
  for (let index = 0; index < minutes; index += 1) {
    if (skip(index)) continue;
    const close = 100 + index * 0.5;
    tape.push({ time: OPEN + index * 60, open: close - 0.25, high: close + 0.5, low: close - 0.5, close, volume: 1000 });
  }
  return tape;
}

describe("replay execution policy", () => {
  const tape = fixtureTape();

  it("uses the close of the last completed one-minute candle and never the forming one", () => {
    // 10:15:30 — the 10:14 candle closed at 10:15:00; the 10:15 candle is still forming.
    const picked = replayPremiumAt(tape, at(10, 15, 30));
    expect(picked.status).toBe("ok");
    if (picked.status !== "ok") return;
    expect(picked.candleTime).toBe(at(10, 14));
    expect(picked.price).toBe(100 + 59 * 0.5);
    expect(picked.candleEnd).toBeLessThanOrEqual(at(10, 15, 30));
  });

  it("never reads a candle that ends after the replay time", () => {
    for (let cursor = OPEN; cursor <= OPEN + 375 * 60; cursor += 37) {
      const picked = replayPremiumAt(tape, cursor);
      if (picked.status === "none") continue;
      expect(picked.candleTime + 60).toBeLessThanOrEqual(cursor);
    }
  });

  it("includes a candle exactly when it completes", () => {
    const picked = replayPremiumAt(tape, at(9, 16));
    expect(picked.status === "ok" && picked.candleTime).toBe(at(9, 15));
    expect(replayPremiumAt(tape, at(9, 15, 59)).status).toBe("none");
  });

  it("refuses fills when the contract has not traded recently and flags marks as stale", () => {
    const sparse = fixtureTape(375, (index) => index > 30);
    const later = at(9, 46) + FILL_STALE_SECONDS + 60;
    expect(replayPremiumAt(sparse, later).status).toBe("too-stale");
    const recent = replayPremiumAt(sparse, at(9, 46) + 6 * 60);
    expect(recent.status).toBe("ok");
    expect(recent.status === "ok" && recent.stale).toBe(true);
  });

  it("reports complete, partial and unavailable coverage", () => {
    expect(sessionCoverage(tape, "2026-10-16").status).toBe("complete");
    expect(sessionCoverage(fixtureTape(200), "2026-10-16")).toMatchObject({ status: "partial", minutes: 200 });
    expect(sessionCoverage([], "2026-10-16").status).toBe("unavailable");
    expect(sessionCoverage(tape, "2026-10-15").status).toBe("unavailable");
  });

  it("keeps only the selected session and normalises minute stamps", () => {
    const noisy = [...tape, { ...tape[0], time: OPEN - 60 }, { ...tape[0], time: OPEN + 375 * 60 }];
    expect(sessionMinutes(noisy, "2026-10-16")).toHaveLength(375);
    expect(sessionBounds("2026-10-16")).toEqual({ open: OPEN, close: OPEN + 375 * 60 });
  });

  it("scopes replay positions to a session without breaking contract parsing", () => {
    const session = newReplaySession("2026-10-16", () => 0.42);
    expect(replaySessionDate(session)).toBe("2026-10-16");
    const symbol = replayLedgerSymbol("NIFTY|2026-10-20|23150|CE", session);
    expect(replaySessionOf(symbol)).toBe(session);
    expect(replaySessionOf("NIFTY|2026-10-20|23150|CE")).toBeNull();
    expect(parseOptionLedgerSymbol(symbol)).toEqual({ underlying: "NIFTY", expiry: "2026-10-20", strike: 23150, right: "CE" });
  });

  it("estimates exit value and realized P&L on the ticket from the replay premium", () => {
    const math = ticketMath({ action: "SELL", lots: "2", lotSize: 65, heldLots: 3, premium: 129.5, buyingPower: 100_000 });
    expect(math.quantity).toBe(130);
    expect(math.total).toBe(16_835);
    expect(exitEstimate(129.5, 120, math.quantity)).toBe(1_235);
    expect(exitEstimate(null, 120, 130)).toBeNull();
  });
});

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
      findUnique: async ({ where }: { where: { id?: string; userId?: string } }) => state.accounts.find((row) => (where.id ? row.id === where.id : row.userId === where.userId)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(state.accounts.find((row) => row.id === where.id)!, data),
    },
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

const feed = vi.hoisted(() => ({ tape: [] as Candle[], calls: [] as Array<{ id: string; open: number; close: number }>, fail: null as Error | null }));

vi.mock("@/lib/prisma", () => ({ prisma: db.client }));
vi.mock("@/server/settings", async (original) => ({ ...(await original<typeof import("../src/server/settings")>()), configuredProvider: () => "dhan" }));
vi.mock("@/server/dhan-market", async (original) => ({
  ...(await original<typeof import("../src/server/dhan-market")>()),
  dhanOptionSession: async (id: string, _kind: string, open: number, close: number) => {
    feed.calls.push({ id, open, close });
    if (feed.fail) throw feed.fail;
    return feed.tape;
  },
}));
vi.mock("@/server/option-chain", () => ({
  loadOptionChain: async (): Promise<OptionChainView> => ({
    symbol: "NIFTY", name: "Nifty 50", kind: "index", available: true, message: "Option chain snapshot.",
    asOf: "2026-10-16T16:11:00.000Z", spot: 23_142.6, expiry: "2026-10-20", expiries: ["2026-10-20"], lotSize: 65,
    daysToExpiry: 4, pcr: 0.94, atmStrike: 23_150, atmIv: 11.8,
    // The live snapshot premium (999) must never appear in a replay fill or mark.
    strikes: [{ strike: 23_150, ce: { ltp: 999, previousClose: 58.4, oi: 1, previousOi: 1, oiChangePct: 0, volume: 1, iv: 11.8, bid: 998, ask: 1000, securityId: "49081" }, pe: null }],
  }),
}));

const { placeOptionReplay } = await import("../src/server/trading");
const { replayMarks, replayQuote, clearReplayTapes, HISTORICAL_UNAVAILABLE } = await import("../src/server/option-replay");
const student = { id: "u1", email: "student.demo@tradelab.local", name: "Student", role: "STUDENT" as const, status: "ACTIVE" as const, tradingEnabled: true, mfaEnabled: false };
const SESSION = "2026-10-16.abcd1234";
const NOW = new Date("2026-10-16T12:00:00.000Z");
const START = 20_000_000n;
const buy = { symbol: "NIFTY", expiry: "2026-10-20", strike: 23_150, right: "CE" as const, action: "BUY" as const, lots: 2, session: SESSION, cursor: at(10, 15, 30), idempotencyKey: "replay-key-0001" };
const codeOf = (error: unknown) => (error as AppError).code;

beforeEach(() => {
  Object.assign(db.state, { accounts: [], orders: [], instruments: [], positions: [], executions: [], ledger: [], quotes: [], closed: [], seq: 0 });
  db.state.accounts.push({ id: "acc1", userId: "u1", currentPeriodId: "p1", cashAvailable: START, cashReserved: 0n });
  feed.tape = fixtureTape();
  feed.calls = [];
  feed.fail = null;
  clearReplayTapes();
});

describe("historical option replay orders", () => {
  it("buys from the chain at the replay-time premium, not the live snapshot", async () => {
    const result = await placeOptionReplay(student, buy, NOW);
    expect(result.order.status).toBe("FILLED");
    expect(result.order.quantity).toBe(130);
    const fill = db.state.executions[0];
    expect(fill.pricePaise).toBe(12_950n);
    expect(fill.dataMode).toBe("HISTORICAL");
    expect((fill.executedAt as Date).getTime()).toBe(at(10, 15, 30) * 1000);
    expect((fill.priceAsOf as Date).getTime()).toBe(at(10, 15) * 1000);
    expect(String(fill.priceSource)).toContain("last-completed-1m-close");
    expect(String(fill.priceSource)).toContain(SESSION);
    expect(db.state.instruments[0]).toMatchObject({ symbol: `NIFTY|2026-10-20|23150|CE|R:${SESSION}`, isActive: false, dhanSecurityId: "49081", lotSize: 65 });
    expect(feed.calls[0]).toMatchObject({ id: "49081", open: OPEN, close: OPEN + 375 * 60 });
    const notional = 12_950n * 130n;
    expect(db.state.ledger.find((row) => row.type === "BUY")?.cashDelta).toBe(-notional);
    expect(db.state.accounts[0].cashAvailable as bigint).toBeLessThan(START - notional + 1n);
  });

  it("does not reveal or use a later candle when the replay sits inside a forming minute", async () => {
    feed.tape = fixtureTape().map((candle) => candle.time >= at(10, 15) ? { ...candle, close: 5_000 } : candle);
    await placeOptionReplay(student, { ...buy, cursor: at(10, 15, 59) }, NOW);
    expect(db.state.executions[0].pricePaise).toBe(12_950n);
    const { quote } = await replayQuote({ underlying: "NIFTY", expiry: "2026-10-20", strike: 23_150, right: "CE", session: SESSION, cursor: at(10, 15, 59) }, undefined, NOW);
    expect(quote.premium).toBe(129.5);
    expect(JSON.stringify(quote)).not.toContain("5000");
  });

  it("blocks the order with the unavailable message when the provider has no history", async () => {
    feed.tape = [];
    const error = await placeOptionReplay(student, buy, NOW).catch((reason: unknown) => reason);
    expect(codeOf(error)).toBe("NO_HISTORICAL_PREMIUM");
    expect((error as Error).message).toBe(HISTORICAL_UNAVAILABLE);
    expect(db.state.orders).toHaveLength(0);
    expect(db.state.accounts[0].cashAvailable).toBe(START);
  });

  it("blocks the order when the history request fails, without falling back to live", async () => {
    feed.fail = new Error("Market data returned 502.");
    const error = await placeOptionReplay(student, buy, NOW).catch((reason: unknown) => reason);
    expect(codeOf(error)).toBe("NO_HISTORICAL_PREMIUM");
    expect(db.state.executions).toHaveLength(0);
  });

  it("refuses a contract that expired before the replay date", async () => {
    const error = await placeOptionReplay(student, { ...buy, expiry: "2026-10-13" }, NOW).catch((reason: unknown) => reason);
    expect(codeOf(error)).toBe("NO_HISTORICAL_PREMIUM");
    expect(feed.calls).toHaveLength(0);
  });

  it("refuses a replay time in the real future or outside the session", async () => {
    const future = await placeOptionReplay(student, buy, new Date(at(10, 0) * 1000)).catch((reason: unknown) => reason);
    expect(codeOf(future)).toBe("FUTURE_CURSOR");
    const early = await placeOptionReplay(student, { ...buy, cursor: OPEN - 60 }, NOW).catch((reason: unknown) => reason);
    expect(codeOf(early)).toBe("CURSOR_OUT_OF_SESSION");
  });

  it("refuses to fill when the contract has not traded within the staleness window", async () => {
    feed.tape = fixtureTape(375, (index) => index > 30);
    const error = await placeOptionReplay(student, { ...buy, cursor: at(11, 0) }, NOW).catch((reason: unknown) => reason);
    expect(codeOf(error)).toBe("NO_HISTORICAL_PREMIUM");
  });

  it("does not execute twice for the same idempotency key", async () => {
    await placeOptionReplay(student, buy, NOW);
    const again = await placeOptionReplay(student, buy, NOW);
    expect(again.replayed).toBe(true);
    expect(db.state.orders).toHaveLength(1);
    expect(db.state.executions).toHaveLength(1);
  });

  it("sells to close partly, then fully, at replay premiums and records realized P&L and history", async () => {
    await placeOptionReplay(student, { ...buy, lots: 3 }, NOW);
    const entry = db.state.executions[0];
    await placeOptionReplay(student, { ...buy, action: "SELL", lots: 1, cursor: at(11, 0, 10), idempotencyKey: "replay-key-0002" }, NOW);
    const partial = db.state.executions[1];
    expect(partial.pricePaise).toBe(rupees(100 + 104 * 0.5));
    expect(db.state.positions[0].quantity).toBe(130);
    const gross = ((partial.pricePaise as bigint) - (entry.pricePaise as bigint)) * 65n;
    expect(partial.realizedPaise as bigint).toBeLessThan(gross);
    expect(partial.realizedPaise as bigint).toBeGreaterThan(gross - (entry.chargesPaise as bigint) - (partial.chargesPaise as bigint) - 1n);

    const tooMany = await placeOptionReplay(student, { ...buy, action: "SELL", lots: 3, cursor: at(11, 5), idempotencyKey: "replay-key-0003" }, NOW).catch((reason: unknown) => reason);
    expect(codeOf(tooMany)).toBe("QTY_ABOVE_POSITION");

    await placeOptionReplay(student, { ...buy, action: "SELL", lots: 2, cursor: at(11, 30), idempotencyKey: "replay-key-0004" }, NOW);
    expect(db.state.positions[0].quantity).toBe(0);
    expect(db.state.closed).toHaveLength(1);
    expect((db.state.closed[0].entryAt as Date).getTime()).toBe(at(10, 15, 30) * 1000);
    expect((db.state.closed[0].exitAt as Date).getTime()).toBe(at(11, 30) * 1000);
  });

  it("refuses a sell with nothing held in this replay session", async () => {
    const error = await placeOptionReplay(student, { ...buy, action: "SELL" }, NOW).catch((reason: unknown) => reason);
    expect(codeOf(error)).toBe("SHORT_NOT_ALLOWED");
  });

  it("keeps recorded fills in time order after seeking backward", async () => {
    await placeOptionReplay(student, { ...buy, cursor: at(10, 30) }, NOW);
    const error = await placeOptionReplay(student, { ...buy, cursor: at(10, 20), idempotencyKey: "replay-key-0005" }, NOW).catch((reason: unknown) => reason);
    expect(codeOf(error)).toBe("REPLAY_TIME_BEHIND");
    expect(db.state.executions).toHaveLength(1);
    const other = await placeOptionReplay(student, { ...buy, session: "2026-10-16.zzzz9999", cursor: at(10, 20), idempotencyKey: "replay-key-0006" }, NOW);
    expect(other.order.status).toBe("FILLED");
  });
});

describe("replay position marks", () => {
  it("marks at the replay time, freezes for the same time, and hides marks before entry", async () => {
    await placeOptionReplay(student, buy, NOW);
    const first = await replayMarks(student, SESSION, at(11, 0, 20), NOW);
    expect(first.marks).toHaveLength(1);
    const mark = first.marks[0];
    // 11:00:20 → the 10:59 candle (index 104) is the latest completed one.
    expect(Number(mark.mark)).toBe(152);
    // The ledger average includes buy charges, so unrealized is measured from that stored average.
    const avg = Number(db.state.positions[0].avgCostPaise) / 100;
    expect(Number(mark.unrealized)).toBeCloseTo((152 - avg) * 130, 1);
    expect(Number(mark.unrealized)).toBeLessThan((152 - 129.5) * 130);
    expect(mark.asOf).toBe(new Date(at(11, 0) * 1000).toISOString());
    expect(db.state.quotes[0]).toMatchObject({ mode: "HISTORICAL", lastPaise: 15_200n });

    const paused = await replayMarks(student, SESSION, at(11, 0, 20), NOW);
    expect(paused.marks[0].mark).toBe(mark.mark);

    const back = await replayMarks(student, SESSION, at(10, 0), NOW);
    expect(back.marks[0]).toMatchObject({ beforeEntry: true, mark: null, unrealized: null });

    const other = await replayMarks(student, "2026-10-16.other123", at(11, 0), NOW);
    expect(other.marks).toHaveLength(0);
  });

  it("reports one session realized figure that matches the fills and the closed trade", async () => {
    await placeOptionReplay(student, { ...buy, lots: 3 }, NOW);
    await placeOptionReplay(student, { ...buy, action: "SELL", lots: 1, cursor: at(11, 0, 10), idempotencyKey: "replay-key-0002" }, NOW);
    const midway = await replayMarks(student, SESSION, at(11, 10), NOW);
    const partialRealized = db.state.executions.reduce((sum, fill) => sum + (fill.realizedPaise as bigint), 0n);
    expect(midway.summary?.realizedPaise).toBe(partialRealized.toString());
    expect(midway.summary?.partialRealizedPaise).toBe(partialRealized.toString());
    expect(midway.summary?.trades).toHaveLength(0);
    expect(midway.summary?.openCount).toBe(1);

    await placeOptionReplay(student, { ...buy, action: "SELL", lots: 2, cursor: at(11, 30), idempotencyKey: "replay-key-0004" }, NOW);
    const done = await replayMarks(student, SESSION, at(11, 31), NOW);
    const summary = done.summary;
    const fillRealized = db.state.executions.reduce((sum, fill) => sum + (fill.realizedPaise as bigint), 0n);
    const closedNet = db.state.closed.reduce((sum, row) => sum + (row.netPaise as bigint), 0n);
    expect(summary?.trades).toHaveLength(1);
    expect(summary?.realizedPaise).toBe(fillRealized.toString());
    expect(summary?.completedNetPaise).toBe(closedNet.toString());
    expect(closedNet).toBe(fillRealized);
    expect(summary?.netPaise).toBe(fillRealized.toString());
    expect(summary?.trades[0].lotSize).toBe(65);

    const elsewhere = await replayMarks(student, "2026-10-16.other123", at(11, 31), NOW);
    expect(elsewhere.summary?.realizedPaise).toBe("0");
  });
});

describe("no broker orders and no live fallback", () => {
  const files = ["src/server/option-replay.ts", "src/app/api/demo/option-replay/route.ts", "src/lib/options/replay-premium.ts"];
  it("never calls a broker order endpoint", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/\/orders|super\/orders|placeOrder|api\.dhan\.co/i);
    }
  });

  it("does not value replay positions from the live chain", () => {
    const portfolio = readFileSync("src/server/portfolio.ts", "utf8");
    expect(portfolio).toMatch(/if \(replaySessionOf\(position\.instrument\.symbol\)\) continue;/);
    const replay = readFileSync("src/server/option-replay.ts", "utf8");
    expect(replay).not.toMatch(/\.ltp\b/);
  });

  it("hides live chain premiums during replay and shows the replay clock on the ticket", () => {
    const panel = readFileSync("src/components/option-chain-panel.tsx", "utf8");
    expect(panel).toContain("Live premiums, OI and volume are hidden");
    const ticket = readFileSync("src/components/option-order-ticket.tsx", "utf8");
    expect(ticket).toContain("Replay clock");
    expect(ticket).toContain("/api/demo/option-replay");
    expect(ticket).not.toContain("not the replay clock");
  });
});

function rupees(value: number) {
  return BigInt(Math.round(value * 100));
}
