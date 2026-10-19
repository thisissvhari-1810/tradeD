import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  combineLive,
  liveTotals,
  parseFunds,
  parseHoldings,
  parseOrders,
  parsePositions,
  type LiveAccount,
} from "../src/lib/multi-account/live";

function slot(partial: Partial<LiveAccount> & Pick<LiveAccount, "id" | "connection">): LiveAccount {
  return {
    slot: 1,
    nickname: partial.id,
    maskedId: null,
    authorized: false,
    tokenExpiresAt: null,
    lastSyncAt: null,
    tradingReady: false,
    tradingReason: "locked",
    message: "",
    funds: null,
    positions: null,
    positionsError: null,
    holdings: null,
    holdingsError: null,
    orders: null,
    ordersError: null,
    totals: { realizedPaise: null, unrealizedPaise: null, openPositions: null, pendingOrders: null, rejectedOrders: null, holdingsCostPaise: null, holdingsCount: null },
    ...partial,
  };
}

describe("broker payload parsing", () => {
  it("reads funds including the documented misspelt available-balance field", () => {
    const funds = parseFunds({ availabelBalance: 12_345.67, utilizedAmount: 100, withdrawableBalance: 50, sodLimit: 200 });
    expect(funds?.error).toBeNull();
    expect(funds?.availablePaise).toBe(1_234_567);
    expect(funds?.usedMarginPaise).toBe(10_000);
  });

  it("does not treat a failed funds request as a zero balance", () => {
    expect(parseFunds({ error: "Token expired." })).toEqual({
      availablePaise: null,
      usedMarginPaise: null,
      withdrawablePaise: null,
      openingLimitPaise: null,
      error: "Token expired.",
    });
    expect(parseFunds(null)).toBeNull();
  });

  it("parses positions and leaves missing P&L as null", () => {
    const { positions, error } = parsePositions([
      { tradingSymbol: "NIFTY 20 OCT 23150 CE", netQty: 65, positionType: "LONG", buyAvg: 120.5, realizedProfit: 10, unrealizedProfit: -4.25, drvStrikePrice: 23150, drvOptionType: "CALL", drvExpiryDate: "2026-10-20", productType: "INTRADAY", securityId: "49081" },
      { tradingSymbol: "BANKNIFTY 20 OCT 56000 PE", netQty: 0, positionType: "CLOSED", realizedProfit: "not-a-number" },
    ]);
    expect(error).toBeNull();
    expect(positions).toHaveLength(2);
    expect(positions?.[0]).toMatchObject({ netQty: 65, side: "LONG", right: "CE", strike: 23150, avgPaise: 12_050, realizedPaise: 1_000, unrealizedPaise: -425 });
    expect(positions?.[1]?.realizedPaise).toBeNull();
  });

  it("does not invent orders when the broker request failed", () => {
    expect(parseOrders({ error: "Account request failed." })).toEqual({ orders: null, error: "Account request failed." });
  });

  it("maps broker order statuses and skips rows without a reference", () => {
    const { orders, error } = parseOrders([
      { orderId: "111", tradingSymbol: "NIFTY", transactionType: "BUY", orderStatus: "PART_TRADED", quantity: 75, filledQty: 25, price: 100, averageTradedPrice: 99.5, createTime: "2026-10-16 10:01:00" },
      { tradingSymbol: "IGNORED", orderStatus: "TRADED" },
      { exchangeOrderId: "222", tradingSymbol: "BANKNIFTY", transactionType: "SELL", orderStatus: "REJECTED", omsErrorDescription: "Insufficient funds", quantity: 30, filledQty: 0 },
    ]);
    expect(error).toBeNull();
    expect(orders?.map((order) => [order.ref, order.status, order.reason])).toEqual([
      ["111", "PARTIAL", ""],
      ["222", "REJECTED", "Insufficient funds"],
    ]);
    expect(orders?.[0]?.avgPaise).toBe(9_950);
  });

  it("parses holdings and refuses to total cost when any average is missing", () => {
    const { holdings, error } = parseHoldings([
      { tradingSymbol: "RELIANCE", totalQty: 10, availableQty: 8, avgCostPrice: 2_450.5, isin: "INE002A01018" },
      { tradingSymbol: "INFY", totalQty: 5, avgCostPrice: null },
    ]);
    expect(error).toBeNull();
    expect(holdings?.[0]?.costPaise).toBe(2_450_50 * 10);
    expect(holdings?.[1]?.costPaise).toBeNull();
    expect(liveTotals(null, null, holdings).holdingsCostPaise).toBeNull();
  });
});

describe("combined live totals", () => {
  it("never mixes unsynced accounts into a complete portfolio figure", () => {
    const connected = slot({
      id: "live-1",
      connection: "CONNECTED",
      authorized: true,
      funds: { availablePaise: 1_000_00, usedMarginPaise: 200_00, withdrawablePaise: 800_00, openingLimitPaise: 1_000_00, error: null },
      totals: { realizedPaise: 50_00, unrealizedPaise: -10_00, openPositions: 1, pendingOrders: 0, rejectedOrders: 0, holdingsCostPaise: 200_00, holdingsCount: 1 },
    });
    const broken = slot({
      id: "live-2",
      connection: "DATA_UNAVAILABLE",
      authorized: true,
      positionsError: "Positions timed out.",
      totals: { realizedPaise: 9_999_00, unrealizedPaise: 9_999_00, openPositions: 9, pendingOrders: 0, rejectedOrders: 0, holdingsCostPaise: 9_999_00, holdingsCount: 1 },
    });
    const empty = slot({ id: "live-3", connection: "NOT_CONNECTED" });
    const combined = combineLive([connected, broken, empty]);
    expect(combined.connected).toBe(2);
    expect(combined.synced).toBe(1);
    expect(combined.incomplete).toBe(true);
    expect(combined.totalPaise).toBe(40_00);
    expect(combined.realizedPaise).toBe(50_00);
    expect(combined.availablePaise).toBe(1_000_00);
    expect(combined.eligible).toBe(0);
  });

  it("reports combined P&L as unavailable when any synced mark is missing", () => {
    const a = slot({
      id: "live-1",
      connection: "CONNECTED",
      totals: { realizedPaise: 10_00, unrealizedPaise: null, openPositions: 1, pendingOrders: 0, rejectedOrders: 0, holdingsCostPaise: null, holdingsCount: 0 },
    });
    const combined = combineLive([a]);
    expect(combined.unrealizedPaise).toBeNull();
    expect(combined.totalPaise).toBeNull();
  });
});

const broker = vi.hoisted(() => ({
  view: {
    liveTrading: false,
    liveOrders: "unavailable" as const,
    reason: "Read-only connected account.",
    token: { source: "saved" as const, expiresAt: "2026-10-16T18:00:00.000Z", expired: false, updatedAt: "2026-10-16T05:00:00.000Z" },
    clientConfigured: true,
    funds: { availabelBalance: 50_000, utilizedAmount: 1_000, withdrawableBalance: 40_000, sodLimit: 50_000 },
    positions: [{ tradingSymbol: "NIFTY 20 OCT 23150 CE", netQty: 65, positionType: "LONG", buyAvg: 100, realizedProfit: 12, unrealizedProfit: 8, securityId: "1" }],
    holdings: [{ tradingSymbol: "RELIANCE", totalQty: 2, avgCostPrice: 100, isin: "INE002A01018" }],
    orders: [{ orderId: "ORD-1", tradingSymbol: "NIFTY", transactionType: "BUY", orderStatus: "TRADED", quantity: 65, filledQty: 65, price: 100 }],
  } as Record<string, unknown>,
}));

vi.mock("@/server/dhan-account", () => ({ brokerAccountView: async () => broker.view }));
vi.mock("@/server/settings", () => ({ getDhanClientId: async () => "1234567890" }));

const live = await import("../src/server/multi-account-live");
const admin = { id: "a1", email: "a@example.test", name: "A", role: "SUPER_ADMIN" as const, status: "ACTIVE" as const, tradingEnabled: true, mfaEnabled: false };
const student = { ...admin, id: "s1", role: "STUDENT" as const };

beforeEach(() => {
  broker.view = {
    liveTrading: false,
    liveOrders: "unavailable",
    reason: "Read-only connected account.",
    token: { source: "saved", expiresAt: "2026-10-16T18:00:00.000Z", expired: false, updatedAt: "2026-10-16T05:00:00.000Z" },
    clientConfigured: true,
    funds: { availabelBalance: 50_000, utilizedAmount: 1_000, withdrawableBalance: 40_000, sodLimit: 50_000 },
    positions: [{ tradingSymbol: "NIFTY 20 OCT 23150 CE", netQty: 65, positionType: "LONG", buyAvg: 100, realizedProfit: 12, unrealizedProfit: 8, securityId: "1" }],
    holdings: [{ tradingSymbol: "RELIANCE", totalQty: 2, avgCostPrice: 100, isin: "INE002A01018" }],
    orders: [{ orderId: "ORD-1", tradingSymbol: "NIFTY", transactionType: "BUY", orderStatus: "TRADED", quantity: 65, filledQty: 65, price: 100 }],
  };
});

describe("live accounts view", () => {
  it("shows the server connection only to the administrator who configured it", async () => {
    const owner = await live.liveAccountsView(admin, new Date("2026-10-16T06:00:00.000Z"));
    expect(owner.viewerOwnsConnection).toBe(true);
    expect(owner.accounts[0]?.connection).toBe("CONNECTED");
    expect(owner.accounts[0]?.maskedId).toBe("••••••7890");
    expect(owner.accounts[0]?.tradingReady).toBe(false);
    expect(owner.accounts[0]?.funds?.availablePaise).toBe(50_00_000);
    expect(owner.accounts[0]?.holdings?.[0]?.symbol).toBe("RELIANCE");
    expect(owner.capabilities.placeOrders).toBe(false);
    expect(owner.capabilities.connectAccounts).toBe(false);
    expect(JSON.stringify(owner)).not.toMatch(/1234567890|access-token|accessToken/);

    const other = await live.liveAccountsView(student);
    expect(other.viewerOwnsConnection).toBe(false);
    expect(other.accounts.every((account) => account.connection === "NOT_CONNECTED")).toBe(true);
    expect(other.accounts[0]?.funds).toBeNull();
  });

  it("marks an expired token as expired and does not invent balances", async () => {
    broker.view.token = { source: "saved", expiresAt: "2026-10-15T18:00:00.000Z", expired: true, updatedAt: null };
    broker.view.clientConfigured = true;
    const view = await live.liveAccountsView(admin);
    expect(view.accounts[0]?.connection).toBe("EXPIRED");
    expect(view.accounts[0]?.funds).toBeNull();
    expect(view.accounts[0]?.positions).toBeNull();
  });

  it("keeps remaining slots empty instead of filling them with sample accounts", async () => {
    const view = await live.liveAccountsView(admin);
    expect(view.accounts).toHaveLength(8);
    expect(view.accounts.slice(1).every((account) => account.connection === "NOT_CONNECTED" && account.funds == null)).toBe(true);
  });
});

describe("live integration boundaries", () => {
  it("has no order placement or cancellation in the live adapter", () => {
    const source = readFileSync("src/server/multi-account-live.ts", "utf8");
    expect(source).not.toMatch(/method:\s*["']POST["']/);
    expect(source).not.toMatch(/\/v2\/orders/);
    expect(source).not.toMatch(/\bplaceOrder\b|\bcancelOrder\b/);
    expect(source).toMatch(/brokerAccountView/);
  });

  it("exposes a GET-only live route", () => {
    const route = readFileSync("src/app/api/multi-account/live/route.ts", "utf8");
    expect(route).toMatch(/export const GET/);
    expect(route).not.toMatch(/export const POST/);
  });

  it("does not mix the demo ledger into live reads", () => {
    const source = readFileSync("src/server/multi-account-live.ts", "utf8");
    expect(source).not.toMatch(/multi\.demo|virtualAccount|submitDemoOrder|defaultDoc/);
  });
});
