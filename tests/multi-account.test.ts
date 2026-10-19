import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OptionChainView } from "../src/server/option-chain";
import type { AppError } from "../src/lib/http";
import {
  defaultDoc,
  marketablePrice,
  overallStatus,
  planLegs,
  riskCheck,
  summarize,
  type DemoDoc,
  type OrderIntent,
  type PriceQuote,
} from "../src/lib/multi-account/engine";
import { executeLegs } from "../src/lib/multi-account/executor";
import { liveGate } from "../src/lib/multi-account/compliance";
import { DEFAULT_CHARGES } from "../src/lib/trading/settings";

const TODAY = "2026-10-16";
const QUOTE: PriceQuote = { premiumPaise: 100_00, lotSize: 75, asOf: "2026-10-16T05:00:00.000Z", source: "chain", label: "test", securityId: "49081" };
const CONTRACT = { underlying: "NIFTY", expiry: "2026-10-20", strike: 23_150, right: "CE" as const };
const BUY: OrderIntent = { contract: CONTRACT, side: "BUY", orderType: "MARKET", limitPaise: null };
const codeOf = (error: unknown) => (error as AppError).code;

function docWith(change: (doc: DemoDoc) => void = () => undefined) {
  const doc = defaultDoc();
  change(doc);
  return doc;
}

describe("overall request status", () => {
  it("maps leg outcomes to Completed, Partially Completed, Failed and Pending", () => {
    expect(overallStatus([{ status: "FILLED" }, { status: "FILLED" }])).toBe("Completed");
    expect(overallStatus([{ status: "FILLED" }, { status: "REJECTED" }])).toBe("Partially Completed");
    expect(overallStatus([{ status: "PARTIAL" }])).toBe("Partially Completed");
    expect(overallStatus([{ status: "REJECTED" }, { status: "CANCELLED" }])).toBe("Failed");
    expect(overallStatus([{ status: "FILLED" }, { status: "PENDING" }])).toBe("Pending");
    expect(overallStatus([{ status: "FILLED" }, { status: "UNKNOWN" }])).toBe("Pending");
    expect(overallStatus([])).toBe("Failed");
  });
});

describe("per-account risk checks", () => {
  const check = (doc: DemoDoc, intent: OrderIntent = BUY, lots = 1, id = "demo-1") => riskCheck(doc, doc.accounts.find((account) => account.id === id)!, intent, lots, QUOTE, DEFAULT_CHARGES, TODAY);

  it("accepts a normal buy", () => {
    expect(check(docWith())).toBeNull();
  });

  it("blocks disabled accounts, oversized lots, disallowed sides and underlyings", () => {
    expect(check(docWith((doc) => { doc.accounts[0]!.tradingEnabled = false; }))).toMatch(/turned off/);
    expect(check(docWith(), BUY, 11)).toMatch(/above this account's limit/);
    expect(check(docWith((doc) => { doc.accounts[0]!.risk.sides = ["SELL"]; }))).toMatch(/BUY orders are not allowed/);
    expect(check(docWith((doc) => { doc.accounts[0]!.risk.underlyings = ["BANKNIFTY"]; }))).toMatch(/not on this account's allowed list/);
  });

  it("checks this account's own cash and capital limit, never a pooled balance", () => {
    const doc = docWith((draft) => { draft.accounts[0]!.cashPaise = 1_000_00; });
    expect(check(doc)).toMatch(/Not enough demo cash/);
    expect(check(doc, BUY, 1, "demo-2")).toBeNull();
    expect(check(docWith((draft) => { draft.accounts[0]!.risk.maxCapitalPaise = 5_000_00; }))).toMatch(/capital limit/);
  });

  it("blocks new buys after the daily loss limit and at the open-position limit", () => {
    expect(check(docWith((doc) => Object.assign(doc.accounts[0]!, { dayKey: TODAY, dayRealizedPaise: -25_000_00 })))).toMatch(/daily loss limit/);
    expect(check(docWith((doc) => Object.assign(doc.accounts[0]!, { dayKey: "2026-10-15", dayRealizedPaise: -25_000_00 })))).toBeNull();
    const full = docWith((doc) => {
      doc.accounts[0]!.risk.maxOpenPositions = 1;
      doc.positions.push({ accountId: "demo-1", symbol: "NIFTY|2026-10-20|23200|CE", contract: { ...CONTRACT, strike: 23_200 }, lotSize: 75, securityId: null, quantity: 75, avgCostPaise: 90_00, openedAt: "", source: "chain" });
    });
    expect(check(full)).toMatch(/open positions, its limit/);
  });

  it("refuses short sells and lets the close workflow run during an emergency stop", () => {
    const sell: OrderIntent = { ...BUY, side: "SELL" };
    expect(check(docWith(), sell)).toMatch(/Short options are not available/);
    const halted = docWith((doc) => {
      doc.halted = true;
      doc.positions.push({ accountId: "demo-1", symbol: "NIFTY|2026-10-20|23150|CE", contract: CONTRACT, lotSize: 75, securityId: null, quantity: 75, avgCostPaise: 90_00, openedAt: "", source: "chain" });
    });
    expect(check(halted)).toMatch(/Emergency stop/);
    expect(check(halted, sell)).toMatch(/Emergency stop/);
    expect(check(halted, { ...sell, closing: true })).toBeNull();
  });

  it("dedupes repeated account IDs and ignores unknown ones", () => {
    const plans = planLegs(docWith(), ["demo-1", "demo-1", "demo-9"], BUY, QUOTE, DEFAULT_CHARGES, TODAY);
    expect(plans.map((plan) => plan.account.id)).toEqual(["demo-1"]);
  });
});

describe("limit orders", () => {
  it("fills only when marketable and at the quoted premium", () => {
    expect(marketablePrice({ side: "BUY", orderType: "LIMIT", limitPaise: 99_00 }, QUOTE)).toBeNull();
    expect(marketablePrice({ side: "BUY", orderType: "LIMIT", limitPaise: 101_00 }, QUOTE)).toBe(100_00);
    expect(marketablePrice({ side: "SELL", orderType: "LIMIT", limitPaise: 101_00 }, QUOTE)).toBeNull();
    expect(marketablePrice({ side: "SELL", orderType: "LIMIT", limitPaise: 99_00 }, QUOTE)).toBe(100_00);
  });
});

describe("summary", () => {
  it("reports combined unrealised P&L as unavailable when any position has no price", () => {
    const doc = docWith((draft) => {
      draft.positions.push({ accountId: "demo-1", symbol: "A", contract: CONTRACT, lotSize: 75, securityId: null, quantity: 75, avgCostPaise: 90_00, openedAt: "", source: "chain" });
      draft.positions.push({ accountId: "demo-2", symbol: "B", contract: CONTRACT, lotSize: 75, securityId: null, quantity: 75, avgCostPaise: 90_00, openedAt: "", source: "chain" });
    });
    const priced = summarize(doc, new Map([["A", 100_00], ["B", 80_00]]), TODAY);
    expect(priced.accounts[0]!.unrealizedPaise).toBe(75 * 10_00);
    expect(priced.combined.unrealizedPaise).toBe(0);
    const missing = summarize(doc, new Map([["A", 100_00], ["B", null]]), TODAY);
    expect(missing.accounts[0]!.unrealizedPaise).toBe(75 * 10_00);
    expect(missing.accounts[1]!.unrealizedPaise).toBeNull();
    expect(missing.combined.unrealizedPaise).toBeNull();
    expect(missing.combined.marksMissing).toBe(1);
  });
});

describe("leg executor", () => {
  it("runs legs concurrently within the cap and isolates failures", async () => {
    let running = 0;
    let peak = 0;
    const sleeps: number[] = [];
    const results = await executeLegs([1, 2, 3, 4, 5, 6], async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;
      if (item === 3) throw new Error("broker timeout");
      return item * 10;
    }, { concurrency: 2, perSecond: 5, sleep: async (ms) => { sleeps.push(ms); } });
    expect(peak).toBeLessThanOrEqual(2);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
    expect(sleeps).toHaveLength(5);
    expect(sleeps.every((ms) => ms === 200)).toBe(true);
  });
});

const db = vi.hoisted(() => {
  const settings = new Map<string, { value: unknown }>();
  const audits: Array<Record<string, unknown>> = [];
  const client = {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const row = settings.get(where.key);
        return row ? { key: where.key, value: JSON.parse(JSON.stringify(row.value)) } : null;
      },
      create: async ({ data }: { data: { key: string; value: unknown } }) => {
        if (settings.has(data.key)) throw Object.assign(new Error("Unique"), { code: "P2002" });
        settings.set(data.key, { value: data.value });
        return data;
      },
      updateMany: async ({ where, data }: { where: { key: string; value: { path: string[]; equals: number } }; data: { value: unknown } }) => {
        const row = settings.get(where.key) as { value: { rev: number } } | undefined;
        if (!row || row.value.rev !== where.value.equals) return { count: 0 };
        settings.set(where.key, { value: data.value });
        return { count: 1 };
      },
    },
    auditLog: { createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => { audits.push(...data); return { count: data.length }; } },
  };
  return { settings, audits, client };
});

const market = vi.hoisted(() => ({ ltp: 100 as number | null, available: true, calls: 0 }));

vi.mock("@/lib/prisma", () => ({ prisma: db.client }));
vi.mock("@/server/settings", () => ({ configuredProvider: () => "dhan", getTradingSettings: async () => ({ charges: DEFAULT_CHARGES }) }));
vi.mock("@/server/option-replay", () => ({ replayQuote: async () => { throw new Error("replay not used in this test"); } }));
vi.mock("@/server/option-chain", () => ({
  loadOptionChain: async (): Promise<OptionChainView> => {
    market.calls += 1;
    return {
      symbol: "NIFTY", name: "Nifty 50", kind: "index", available: market.available, message: market.available ? "" : "Option chain unavailable.",
      asOf: "2026-10-16T05:00:00.000Z", spot: 23_142, expiry: "2026-10-20", expiries: ["2026-10-20"], lotSize: 75,
      daysToExpiry: 4, pcr: null, atmStrike: 23_150, atmIv: null,
      strikes: [{ strike: 23_150, ce: { ltp: market.ltp, previousClose: null, oi: null, previousOi: null, oiChangePct: null, volume: null, iv: null, bid: null, ask: null, securityId: "49081" }, pe: null }],
    };
  },
}));

const service = await import("../src/server/multi-account");
const user = { id: "u1", email: "u@example.test", name: "U", role: "STUDENT" as const, status: "ACTIVE" as const, tradingEnabled: true, mfaEnabled: false };
const NOW = new Date("2026-10-16T05:30:00.000Z");
const submit = (key: string, extra: Partial<Parameters<typeof service.submitDemoOrder>[1]> = {}, options: Parameters<typeof service.submitDemoOrder>[2] = {}) =>
  service.submitDemoOrder(user, { key, contract: CONTRACT, side: "BUY", orderType: "MARKET", limitPaise: null, product: "INTRADAY", stopLossPaise: null, targetPaise: null, accountIds: ["demo-1", "demo-2", "demo-3"], source: { kind: "chain" }, ...extra }, { now: NOW, ...options });
const stored = async () => service.parseStored((await db.client.appSetting.findUnique({ where: { key: service.demoKey("u1") } }))!.value).doc;

beforeEach(() => {
  db.settings.clear();
  db.audits.length = 0;
  Object.assign(market, { ltp: 100, available: true, calls: 0 });
});

describe("multi-account demo order service", () => {
  it("places one confirmed request for every selected account with its own lots", async () => {
    await service.updateDemoAccounts(user, [{ id: "demo-2", lots: 3 }]);
    const { request, duplicate } = await submit("11111111-1111-4111-8111-111111111111");
    expect(duplicate).toBe(false);
    expect(request.status).toBe("Completed");
    expect(request.legs.map((leg) => [leg.accountId, leg.quantity, leg.status])).toEqual([["demo-1", 75, "FILLED"], ["demo-2", 225, "FILLED"], ["demo-3", 75, "FILLED"]]);
    expect(new Set(request.legs.map((leg) => leg.id)).size).toBe(3);
    const doc = await stored();
    expect(doc.positions.map((position) => [position.accountId, position.quantity])).toEqual([["demo-1", 75], ["demo-2", 225], ["demo-3", 75]]);
    expect(doc.accounts[3]!.cashPaise).toBe(doc.accounts[3]!.startingPaise);
    expect(db.audits.filter((row) => String(row.action).startsWith("multi.leg.filled"))).toHaveLength(3);
  });

  it("returns the original result for a duplicate submit and never fills twice", async () => {
    const key = "22222222-2222-4222-8222-222222222222";
    const first = await submit(key);
    const again = await submit(key);
    expect(again.duplicate).toBe(true);
    expect(again.request.id).toBe(first.request.id);
    const [left, right] = await Promise.all([submit("33333333-3333-4333-8333-333333333333"), submit("33333333-3333-4333-8333-333333333333")]);
    expect(left.request.id).toBe(right.request.id);
    expect([left.duplicate, right.duplicate].sort()).toEqual([false, true]);
    const doc = await stored();
    expect(doc.requests).toHaveLength(2);
    expect(doc.positions.find((position) => position.accountId === "demo-1")?.quantity).toBe(150);
  });

  it("reports partial results accurately when some accounts are rejected", async () => {
    await service.updateDemoAccounts(user, [{ id: "demo-2", tradingEnabled: false }, { id: "demo-3", risk: { maxLots: 1 } }, { id: "demo-3", lots: 1 }]);
    const { request } = await submit("44444444-4444-4444-8444-444444444444", { lots: { "demo-3": 2 } });
    expect(request.status).toBe("Partially Completed");
    expect(request.legs.map((leg) => leg.status)).toEqual(["FILLED", "REJECTED", "REJECTED"]);
    expect(request.legs[1]!.reason).toMatch(/turned off/);
    expect(request.legs[2]!.reason).toMatch(/above this account's limit/);
    const doc = await stored();
    expect(doc.accounts[1]!.cashPaise).toBe(doc.accounts[1]!.startingPaise);
    expect(doc.positions).toHaveLength(1);
  });

  it("marks an unconfirmed leg as unknown, never resubmits it, and reconciles it from the ledger", async () => {
    const real = service.demoRunner({ charges: DEFAULT_CHARGES } as Awaited<ReturnType<typeof import("../src/server/settings").getTradingSettings>>);
    const runner: typeof real = async (doc, accountId, ...rest) => {
      if (accountId === "demo-2") throw new Error("timeout");
      return real(doc, accountId, ...rest);
    };
    const { request } = await submit("55555555-5555-4555-8555-555555555555", {}, { runner });
    expect(request.status).toBe("Pending");
    expect(request.legs.map((leg) => leg.status)).toEqual(["FILLED", "UNKNOWN", "FILLED"]);
    const result = await service.reconcileDemoRequest(user, request.id, { kind: "chain" }, { now: NOW });
    expect(result.request.legs.map((leg) => leg.status)).toEqual(["FILLED", "REJECTED", "FILLED"]);
    expect(result.request.status).toBe("Partially Completed");
    expect((await stored()).positions.filter((position) => position.accountId === "demo-2")).toHaveLength(0);
  });

  it("keeps unmarketable limit orders pending and fills them on reconcile once the price allows", async () => {
    const { request } = await submit("66666666-6666-4666-8666-666666666666", { orderType: "LIMIT", limitPaise: 90_00, accountIds: ["demo-1"] });
    expect(request.legs[0]!.status).toBe("PENDING");
    expect(request.status).toBe("Pending");
    market.ltp = 89;
    const result = await service.reconcileDemoRequest(user, request.id, { kind: "chain" }, { now: NOW });
    expect(result.request.legs[0]!.status).toBe("FILLED");
    expect(result.request.legs[0]!.avgPaise).toBe(89_00);
    const again = await service.reconcileDemoRequest(user, request.id, { kind: "chain" }, { now: NOW });
    expect(again.changed).toBe(0);
    expect((await stored()).positions[0]!.quantity).toBe(75);
  });

  it("refuses to fill without a real price and writes nothing", async () => {
    market.available = false;
    await expect(submit("77777777-7777-4777-8777-777777777777")).rejects.toSatisfy((error) => codeOf(error) === "PRICE_UNAVAILABLE");
    market.available = true;
    market.ltp = null;
    await expect(submit("77777777-7777-4777-8777-777777777778")).rejects.toSatisfy((error) => codeOf(error) === "PRICE_UNAVAILABLE");
    expect(db.settings.size).toBe(0);
  });

  it("blocks new orders during an emergency stop but still closes positions", async () => {
    await submit("88888888-8888-4888-8888-888888888888", { accountIds: ["demo-1"] });
    await service.setDemoHalt(user, true);
    await expect(submit("88888888-8888-4888-8888-888888888889")).rejects.toSatisfy((error) => codeOf(error) === "HALTED");
    const results = await service.closeDemoPositions(user, { key: "99999999-9999-4999-8999-999999999999", positions: [{ accountId: "demo-1", symbol: "NIFTY|2026-10-20|23150|CE" }], source: { kind: "chain" } });
    expect(results[0]!.error).toBeNull();
    expect(results[0]!.request?.legs[0]!.status).toBe("FILLED");
    const doc = await stored();
    expect(doc.positions).toHaveLength(0);
    expect(doc.accounts[0]!.realizedPaise).toBeLessThan(0);
  });

  it("refuses live mode with the compliance reasons", () => {
    expect(() => service.assertLiveAllowed()).toThrow();
    try {
      service.assertLiveAllowed();
    } catch (error) {
      expect(codeOf(error)).toBe("LIVE_LOCKED");
      expect((error as AppError).status).toBe(403);
    }
    expect(liveGate().enabled).toBe(false);
    expect(liveGate().requirements.every((item) => !item.met)).toBe(true);
  });
});

describe("demo and live separation", () => {
  const files = ["src/server/multi-account.ts", "src/lib/multi-account/engine.ts", "src/lib/multi-account/executor.ts", "src/lib/multi-account/compliance.ts", "src/app/api/multi-account/route.ts"];

  it("has no broker order endpoint, network call or credential access in the demo engine", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/fetch\(|api\.dhan\.co|\/v2\/orders|placeOrder|getDhanAccessToken|access-token/i);
    }
  });

  it("does not put demo cash on the live-account console", () => {
    const source = readFileSync("src/components/multi-account/live-desk.tsx", "utf8");
    expect(source).not.toMatch(/demo cash|Demo cash|startingPaise|DEFAULT_DEMO_CAPITAL|simulated capital/i);
  });

  it("routes every LIVE request through the gate before any demo code runs", () => {
    const route = readFileSync("src/app/api/multi-account/route.ts", "utf8");
    expect(route.match(/if \(input\.mode === "LIVE"\) assertLiveAllowed\(\);/g)).toHaveLength(2);
  });

  it("stores demo data under its own key and never touches the practice ledger", () => {
    expect(service.demoKey("u1")).toBe("multi.demo.v1:u1");
    const source = readFileSync("src/server/multi-account.ts", "utf8");
    expect(source).not.toMatch(/prisma\.(virtualAccount|order|execution|position|ledgerEntry|closedTrade)\b/);
  });
});
