import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../src/server/auth";
import type { LiveOrderIntent } from "../src/lib/dhan/orders";

/** In-memory broker tables with the same unique constraints as Postgres. */
const db = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
  const state = { accounts: [] as Row[], orders: [] as Row[], audit: [] as Array<Record<string, unknown>>, seq: 0 };
  const unique = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  const id = () => `c${String((state.seq += 1)).padStart(24, "0")}`;
  const match = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && "in" in (value as object)) return ((value as { in: unknown[] }).in).includes(row[key]);
      return row[key] === value;
    });
  const orders = {
    findUnique: async ({ where, include }: { where: Record<string, unknown>; include?: unknown }) => {
      const composite = where.accountId_idempotencyKey as { accountId: string; idempotencyKey: string } | undefined;
      const row = composite ? state.orders.find((item) => item.accountId === composite.accountId && item.idempotencyKey === composite.idempotencyKey) : state.orders.find((item) => item.id === where.id);
      if (!row) return null;
      return include ? { ...row, account: { ...state.accounts.find((item) => item.id === row.accountId) } } : { ...row };
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) => state.orders.filter((row) => match(row, where)).map((row) => ({ ...row })).reverse(),
    count: async ({ where }: { where: Record<string, unknown> }) => state.orders.filter((row) => match(row, where)).length,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (state.orders.some((item) => item.accountId === data.accountId && item.idempotencyKey === data.idempotencyKey)) throw unique();
      const row: Row = { id: id(), brokerOrderId: null, brokerStatus: "", avgPricePaise: null, filledQuantity: 0, rejectReason: "", submittedAt: null, triggerPricePaise: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      state.orders.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = state.orders.find((item) => item.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
  };
  const client = {
    brokerAccount: {
      findUnique: async ({ where }: { where: { clientFingerprint?: string; id?: string } }) => state.accounts.find((item) => (where.id ? item.id === where.id : item.clientFingerprint === where.clientFingerprint)) ?? null,
      findMany: async ({ where }: { where: { ownerId: string } }) => state.accounts.filter((item) => item.ownerId === where.ownerId),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.accounts.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (state.accounts.some((item) => item.clientFingerprint === data.clientFingerprint)) throw unique();
        const row: Row = { id: id(), enabled: true, ...data };
        state.accounts.push(row);
        return { ...row };
      },
    },
    brokerOrder: orders,
    tradingAuditEvent: { create: async ({ data }: { data: Record<string, unknown> }) => void state.audit.push(data) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ brokerOrder: orders, $executeRaw: async () => 0 }),
  };
  return { state, client };
});

const broker = vi.hoisted(() => ({ token: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.c2ln", clientId: "1114171746", expired: false }));

vi.mock("@/lib/prisma", () => ({ prisma: db.client }));
vi.mock("@/server/settings", () => ({
  getDhanClientId: async () => broker.clientId,
  getDhanAccessToken: async () => broker.token,
  dhanTokenStatus: async () => ({ source: "saved", expiresAt: null, expired: broker.expired, updatedAt: null }),
}));

const service = await import("../src/server/live-orders");

const SECRET = "w".repeat(40);
const env = {
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  LIVE_ORDERS_ENABLED: "true",
  EXECUTION_SERVICE_URL: "https://exec.test",
  EXECUTION_SERVICE_SECRET: SECRET,
  DHAN_STATIC_IP: "13.49.97.101",
  DHAN_ACCOUNT_OWNER_EMAIL: "owner@x.test",
} as unknown as NodeJS.ProcessEnv;

const user = (email: string, id = email): SessionUser => ({ id, email, name: id, role: "STUDENT", status: "ACTIVE", tradingEnabled: true, mfaEnabled: false });
const owner = user("owner@x.test", "u-owner");
const stranger = user("someone@x.test", "u-other");
const ctx = { ip: "127.0.0.1" };

const intent: LiveOrderIntent = { exchangeSegment: "NSE_FNO", securityId: "49081", symbol: "NIFTY 23150 CE", side: "BUY", productType: "INTRADAY", orderType: "MARKET", quantity: 75, lotSize: 75, pricePaise: null, referencePaise: 100_00 };

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function router(routes: { worker?: Handler; funds?: unknown; lookup?: Handler }) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("https://exec.test")) return routes.worker ? routes.worker(url, init) : reply(500, {});
    if (url.endsWith("/fundlimit")) return reply(200, routes.funds ?? { availabelBalance: 1_00_000 });
    if (routes.lookup) return routes.lookup(url, init);
    return reply(404, { errorCode: "DH-907" });
  });
}
const workerCalls = (fetch: ReturnType<typeof router>) => fetch.mock.calls.filter(([url]) => String(url).startsWith("https://exec.test"));

beforeEach(() => {
  db.state.accounts = [];
  db.state.orders = [];
  db.state.audit = [];
  broker.expired = false;
});

describe("live order gate", () => {
  it("stays locked when the operator switch is off, and sends nothing", async () => {
    const fetch = router({ worker: () => reply(200, { outcome: "ACCEPTED", orderId: "1", orderStatus: "PENDING" }) });
    await expect(service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch, env: { ...env, LIVE_ORDERS_ENABLED: "false" } })).rejects.toMatchObject({ code: "LIVE_LOCKED" });
    expect(workerCalls(fetch)).toHaveLength(0);
    expect(db.state.orders).toHaveLength(0);
  });

  it("refuses any user other than the named account holder", async () => {
    const fetch = router({});
    await expect(service.placeLiveOrder(stranger, { key: randomUUID(), intent }, ctx, { fetch, env })).rejects.toMatchObject({ code: "LIVE_LOCKED" });
    expect(workerCalls(fetch)).toHaveLength(0);
  });

  it("refuses when the token has expired", async () => {
    broker.expired = true;
    await expect(service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch: router({}), env })).rejects.toMatchObject({ code: "LIVE_LOCKED" });
  });
});

describe("placing live orders", () => {
  it("places a valid order once, signed, and records the broker order id", async () => {
    const fetch = router({ worker: () => reply(200, { outcome: "ACCEPTED", orderId: "112111182198", orderStatus: "TRANSIT" }) });
    const result = await service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch, env });
    expect(result.duplicate).toBe(false);
    expect(result.order).toMatchObject({ status: "PENDING", brokerOrderId: "112111182198", quantity: 75 });
    const [url, init] = workerCalls(fetch)[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://exec.test/v1/orders/place");
    expect((init.headers as Record<string, string>)["x-traded-signature"]).toMatch(/^[a-f0-9]{64}$/);
    const sent = JSON.parse(String(init.body));
    expect(sent.order).toMatchObject({ transactionType: "BUY", exchangeSegment: "NSE_FNO", productType: "INTRADAY", orderType: "MARKET", securityId: "49081", quantity: 75, price: 0 });
    expect(sent.order.correlationId).toMatch(/^td[a-f0-9]{24}$/);
    expect(db.state.audit.map((row) => row.action)).toEqual(["live.order.submit", "live.order.result"]);
    expect(JSON.stringify(db.state.audit)).not.toMatch(/eyJ|1114171746/);
  });

  it("returns the existing order for a repeated request key instead of sending again", async () => {
    const fetch = router({ worker: () => reply(200, { outcome: "ACCEPTED", orderId: "9", orderStatus: "PENDING" }) });
    const key = randomUUID();
    await service.placeLiveOrder(owner, { key, intent }, ctx, { fetch, env });
    const again = await service.placeLiveOrder(owner, { key, intent }, ctx, { fetch, env });
    expect(again.duplicate).toBe(true);
    expect(workerCalls(fetch)).toHaveLength(1);
    expect(db.state.orders).toHaveLength(1);
  });

  it("marks a timed-out send UNKNOWN and blocks further orders until it is reconciled", async () => {
    const fetch = router({ worker: () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); } });
    const first = await service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch, env });
    expect(first.order.status).toBe("UNKNOWN");
    await expect(service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch, env })).rejects.toMatchObject({ code: "ORDER_UNRESOLVED" });
    expect(workerCalls(fetch)).toHaveLength(1);

    const lookup = router({ lookup: (url) => (url.includes("/orders/external/") ? reply(200, [{ orderId: "777", orderStatus: "TRADED", filledQty: 75, remainingQuantity: 0, averageTradedPrice: 101.5 }]) : reply(404, {})) });
    const reconciled = await service.reconcileLiveOrder(owner, first.order.id, ctx, { fetch: lookup, env });
    expect(reconciled.order).toMatchObject({ status: "FILLED", brokerOrderId: "777", filledQuantity: 75, avgPricePaise: 10150 });
    const fetch2 = router({ worker: () => reply(200, { outcome: "ACCEPTED", orderId: "778", orderStatus: "PENDING" }) });
    await expect(service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch: fetch2, env })).resolves.toMatchObject({ order: { status: "PENDING" } });
  });

  it("treats an order Dhan never recorded as not placed only after a grace period", async () => {
    const fetch = router({ worker: () => reply(200, { outcome: "UNKNOWN", message: "Dhan did not confirm." }) });
    const placed = await service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch, env });
    const early = await service.reconcileLiveOrder(owner, placed.order.id, ctx, { fetch: router({}), env });
    expect(early.order.status).toBe("UNKNOWN");
    const later = await service.reconcileLiveOrder(owner, placed.order.id, ctx, { fetch: router({}), env, now: new Date(Date.now() + 5 * 60_000) });
    expect(later.order.status).toBe("REJECTED");
    expect(later.order.reason).toMatch(/not placed/);
  });

  it("records a worker refusal as not sent", async () => {
    const fetch = router({ worker: () => reply(400, { error: "Quantity must be 1 to 1800." }) });
    const result = await service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch, env });
    expect(result.order).toMatchObject({ status: "REJECTED" });
    expect(result.order.reason).toMatch(/^Not sent/);
  });

  it("records a broker rejection with Dhan's reason", async () => {
    const fetch = router({ worker: () => reply(200, { outcome: "REJECTED", message: "Insufficient margin" }) });
    const result = await service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch, env });
    expect(result.order).toMatchObject({ status: "REJECTED", reason: "Insufficient margin" });
  });

  it("blocks a buy above available funds and invalid contracts before sending", async () => {
    const fetch = router({ funds: { availabelBalance: 50 }, worker: () => reply(200, { outcome: "ACCEPTED", orderId: "1", orderStatus: "PENDING" }) });
    await expect(service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch, env })).rejects.toMatchObject({ code: "INVALID_ORDER" });
    await expect(service.placeLiveOrder(owner, { key: randomUUID(), intent: { ...intent, quantity: 80 } }, ctx, { fetch: router({}), env })).rejects.toThrow(/multiple of the lot size/);
    await expect(service.placeLiveOrder(owner, { key: randomUUID(), intent: { ...intent, orderType: "LIMIT", pricePaise: null } }, ctx, { fetch: router({}), env })).rejects.toThrow(/limit price/);
    expect(workerCalls(fetch)).toHaveLength(0);
  });
});

describe("order ownership and cancellation", () => {
  it("hides one user's orders from another", async () => {
    const fetch = router({ worker: () => reply(200, { outcome: "ACCEPTED", orderId: "42", orderStatus: "PENDING" }) });
    const placed = await service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch, env });
    await expect(service.reconcileLiveOrder(stranger, placed.order.id, ctx, { fetch, env })).rejects.toMatchObject({ status: 404 });
    await expect(service.cancelLiveOrder(stranger, placed.order.id, ctx, { fetch, env })).rejects.toMatchObject({ status: 404 });
    expect(await service.listLiveOrders(stranger)).toEqual([]);
    expect(await service.listLiveOrders(owner)).toHaveLength(1);
  });

  it("cancels an open order through the worker and confirms with Dhan", async () => {
    const place = router({ worker: () => reply(200, { outcome: "ACCEPTED", orderId: "42", orderStatus: "PENDING" }) });
    const placed = await service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch: place, env });
    const cancel = router({
      worker: (url) => (url.endsWith("/v1/orders/cancel") ? reply(200, { outcome: "ACCEPTED", orderId: "42", orderStatus: "CANCELLED" }) : reply(404, {})),
      lookup: (url) => (url.endsWith("/orders/42") ? reply(200, { orderId: "42", orderStatus: "CANCELLED", filledQty: 0, remainingQuantity: 75 }) : reply(404, {})),
    });
    const result = await service.cancelLiveOrder(owner, placed.order.id, ctx, { fetch: cancel, env });
    expect(result.order.status).toBe("CANCELLED");
    await expect(service.cancelLiveOrder(owner, placed.order.id, ctx, { fetch: cancel, env })).rejects.toMatchObject({ code: "ORDER_NOT_OPEN" });
  });

  it("tracks partial fills from Dhan", async () => {
    const place = router({ worker: () => reply(200, { outcome: "ACCEPTED", orderId: "43", orderStatus: "PENDING" }) });
    const placed = await service.placeLiveOrder(owner, { key: randomUUID(), intent: { ...intent, quantity: 150 } }, ctx, { fetch: place, env });
    const partial = router({ lookup: () => reply(200, { orderId: "43", orderStatus: "PART_TRADED", filledQty: 75, remainingQuantity: 75, averageTradedPrice: 99 }) });
    const result = await service.reconcileLiveOrder(owner, placed.order.id, ctx, { fetch: partial, env });
    expect(result.order).toMatchObject({ status: "PARTIAL", filledQuantity: 75, remainingQuantity: 75, final: false });
  });
});

describe("account switch", () => {
  it("refuses a switched-off account before anything is sent, and allows it again when switched on", async () => {
    const fetch = router({ worker: () => reply(200, { outcome: "ACCEPTED", orderId: "77", orderStatus: "PENDING" }) });
    await service.setAccountEnabled(owner, "server", false, ctx, env);
    await expect(service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch, env })).rejects.toMatchObject({ code: "LIVE_LOCKED", details: { unmet: ["Account switched on for trading in TradeD"] } });
    expect(workerCalls(fetch)).toHaveLength(0);
    expect(db.state.audit.some((row) => row.action === "broker.account.disable")).toBe(true);
    await service.setAccountEnabled(owner, "server", true, ctx, env);
    await expect(service.placeLiveOrder(owner, { key: randomUUID(), intent }, ctx, { fetch, env })).resolves.toMatchObject({ order: { status: "PENDING" } });
  });

  it("does not let another user switch an account", async () => {
    await service.setAccountEnabled(owner, "server", true, ctx, env);
    const id = String(db.state.accounts[0]!.id);
    await expect(service.setAccountEnabled(stranger, id, false, ctx, env)).rejects.toMatchObject({ status: 404 });
    await expect(service.setAccountEnabled(stranger, "server", false, ctx, env)).rejects.toMatchObject({ status: 404 });
  });
});
