import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OptionChainView } from "../src/server/option-chain";

type Row = Record<string, unknown> & { id: string };

const db = vi.hoisted(() => {
  const state = {
    accounts: [] as Row[],
    orders: [] as Row[],
    instruments: [] as Row[],
    positions: [] as Row[],
    executions: [] as Row[],
    ledger: [] as Row[],
    txOptions: [] as unknown[],
    seq: 0,
  };
  const id = (prefix: string) => `${prefix}${++state.seq}`;
  const positionKey = (where: { accountId_practicePeriodId_instrumentId: { accountId: string; practicePeriodId: string; instrumentId: string } }) => where.accountId_practicePeriodId_instrumentId;
  const findPosition = (where: Parameters<typeof positionKey>[0]) => {
    const key = positionKey(where);
    return state.positions.find((row) => row.accountId === key.accountId && row.practicePeriodId === key.practicePeriodId && row.instrumentId === key.instrumentId) ?? null;
  };
  const withIncludes = (order: Row | undefined) => order && { ...order, instrument: state.instruments.find((row) => row.id === order.instrumentId), executions: state.executions.filter((row) => row.orderId === order.id) };
  const findOrder = (where: { id?: string; accountId_idempotencyKey?: { accountId: string; idempotencyKey: string } }) => where.id
    ? state.orders.find((row) => row.id === where.id)
    : state.orders.find((row) => row.accountId === where.accountId_idempotencyKey?.accountId && row.idempotencyKey === where.accountId_idempotencyKey?.idempotencyKey);
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
      create: async ({ data }: { data: Omit<Row, "id"> }) => { const row: Row = { filledQuantity: 0, reservedPaise: 0n, chargesPaise: 0n, avgFillPaise: null, filledAt: null, ...data, id: id("ord") }; state.orders.push(row); return row; },
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
      findUnique: async ({ where }: { where: { id: string } }) => state.instruments.find((row) => row.id === where.id) ?? null,
    },
    position: {
      findUnique: async ({ where }: { where: Parameters<typeof positionKey>[0] }) => findPosition(where),
      upsert: async ({ where, create, update }: { where: Parameters<typeof positionKey>[0]; create: Row; update: Row }) => {
        const found = findPosition(where);
        if (found) return Object.assign(found, update, { updatedAt: new Date() });
        const row = { ...create, id: id("pos"), updatedAt: new Date() };
        state.positions.push(row as Row);
        return row;
      },
    },
    execution: { create: async ({ data }: { data: Row }) => { const row = { ...data, id: id("exe") }; state.executions.push(row as Row); return row; } },
    ledgerEntry: { create: async ({ data }: { data: Row }) => { const row = { ...data, id: id("led") }; state.ledger.push(row as Row); return row; } },
    badge: { findUnique: async () => null },
    userBadge: { upsert: async () => null },
    closedTrade: { create: async ({ data }: { data: Row }) => ({ ...data, id: id("ct") }) },
    $transaction: async (work: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      state.txOptions.push(options);
      return work(client);
    },
  };
  return { state, client };
});

const chain = vi.hoisted(() => ({ ltp: 62.8 as number | null, fail: null as Error | null }));

vi.mock("@/lib/prisma", () => ({ prisma: db.client }));
vi.mock("@/server/option-chain", () => ({
  loadOptionChain: async (): Promise<OptionChainView> => {
    if (chain.fail) throw chain.fail;
    return {
      symbol: "NIFTY", name: "Nifty 50", kind: "index", available: true, message: "Option chain snapshot.",
      asOf: "2026-10-16T16:11:00.000Z", spot: 23_142.6, expiry: "2026-10-20", expiries: ["2026-10-20"], lotSize: 65,
      daysToExpiry: 4, pcr: 0.94, atmStrike: 23_150, atmIv: 11.8,
      strikes: [{ strike: 23_150, ce: { ltp: chain.ltp, previousClose: 58.4, oi: 4_812_300, previousOi: 4_390_050, oiChangePct: 9.6, volume: 18_402_500, iv: 11.8, bid: 62.75, ask: 62.85, securityId: "49081" }, pe: null }],
    };
  },
}));

const { placeOptionDemo, premiumMoved } = await import("../src/server/trading");
const { AppError } = await import("../src/lib/http");

const student = { id: "u1", email: "student.demo@tradelab.local", name: "Student", role: "STUDENT" as const, status: "ACTIVE" as const, tradingEnabled: true, mfaEnabled: false };
const order = { symbol: "NIFTY", expiry: "2026-10-20", strike: 23_150, right: "CE" as const, action: "BUY" as const, lots: 10, idempotencyKey: "test-key-0001", referencePremium: 62.8 };
const START = 20_000_000n;

beforeEach(() => {
  Object.assign(db.state, { accounts: [], orders: [], instruments: [], positions: [], executions: [], ledger: [], txOptions: [], seq: 0 });
  db.state.accounts.push({ id: "acc1", userId: "u1", currentPeriodId: "p1", cashAvailable: START, cashReserved: 0n });
  chain.ltp = 62.8;
  chain.fail = null;
});

describe("demo option buy", () => {
  it("creates the position and reduces buying power for NIFTY 23150 CE × 10 lots", async () => {
    const result = await placeOptionDemo(student, order);
    expect(result.replayed).toBe(false);
    expect(result.order.status).toBe("FILLED");
    expect(result.order.quantity).toBe(650);

    const position = db.state.positions[0];
    expect(position.quantity).toBe(650);
    expect(db.state.instruments[0].symbol).toBe("NIFTY|2026-10-20|23150|CE");

    const notional = 4_082_000n;
    const buy = db.state.ledger.find((row) => row.type === "BUY");
    expect(buy?.cashDelta).toBe(-notional);
    const fees = db.state.ledger.filter((row) => row.type === "FEE").reduce((sum, row) => sum + (row.cashDelta as bigint), 0n);
    expect(db.state.accounts[0].cashAvailable).toBe(START - notional + fees);
    expect(db.state.accounts[0].cashAvailable as bigint).toBeLessThan(START - notional + 1n);
    expect(db.state.executions[0].pricePaise).toBe(6_280n);
  });

  it("runs the fill inside a transaction long enough for a remote database", async () => {
    await placeOptionDemo(student, order);
    expect(db.state.txOptions[0]).toMatchObject({ timeout: 25_000 });
  });

  it("does not fill twice for the same idempotency key", async () => {
    await placeOptionDemo(student, order);
    chain.fail = new Error("chain should not be needed for a replay");
    const again = await placeOptionDemo(student, order);
    expect(again.replayed).toBe(true);
    expect(db.state.orders).toHaveLength(1);
    expect(db.state.positions[0].quantity).toBe(650);
  });

  it("rejects insufficient buying power with a structured code", async () => {
    db.state.accounts[0].cashAvailable = 3_000_000n;
    const error = await placeOptionDemo(student, order).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as InstanceType<typeof AppError>).code).toBe("INSUFFICIENT_FUNDS");
    expect(db.state.orders).toHaveLength(0);
    expect(db.state.accounts[0].cashAvailable).toBe(3_000_000n);
  });

  it("asks for a fresh review when the premium moved", async () => {
    chain.ltp = 68.5;
    const error = await placeOptionDemo(student, order).catch((reason: unknown) => reason);
    expect((error as InstanceType<typeof AppError>).code).toBe("PRICE_MOVED");
    expect((error as InstanceType<typeof AppError>).details?.latestPremium).toBe(68.5);
    expect(db.state.orders).toHaveLength(0);
    expect(premiumMoved(62.8, 63.1)).toBe(false);
  });

  it("turns an expired ledger transaction into a retryable structured error", async () => {
    const { jsonError } = await import("../src/lib/http");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = jsonError(Object.assign(new Error("Transaction already closed"), { code: "P2028" }));
    spy.mockRestore();
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toMatchObject({ code: "LEDGER_BUSY" });
    expect(payload.message).not.toMatch(/Unexpected server error/);
  });

  it("closes part of the position with sell to close", async () => {
    await placeOptionDemo(student, order);
    await placeOptionDemo(student, { ...order, action: "SELL", lots: 4, idempotencyKey: "test-key-0002" });
    expect(db.state.positions[0].quantity).toBe(390);
    const short = await placeOptionDemo(student, { ...order, action: "SELL", lots: 7, idempotencyKey: "test-key-0003" }).catch((reason: unknown) => reason);
    expect((short as InstanceType<typeof AppError>).code).toBe("QTY_ABOVE_POSITION");
  });
});
