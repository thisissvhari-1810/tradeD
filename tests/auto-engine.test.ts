import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── In-memory database (only what the engine uses) ──
type Row = Record<string, unknown> & { id?: string };
const db: Record<string, Row[]> = {};
let seq = 0;
const table = (name: string) => (db[name] ??= []);
const unique: Record<string, string[][]> = {
  autoDay: [["strategyKey", "date"]], autoSignal: [["strategyKey", "date", "tradeNo"]], autoTrade: [["strategyKey", "date", "tradeNo"]], autoOrder: [["idempotencyKey"]],
  autoEngine: [["id"]], autoStrategy: [["key"]], autoReport: [["date"]], appSetting: [["key"]],
};
function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Record<string, unknown>[]).some((c) => matches(row, c));
    if (key === "NOT") return !matches(row, cond as Record<string, unknown>);
    if (key.includes("_") && cond && typeof cond === "object" && !("in" in (cond as object))) return matches(row, cond as Record<string, unknown>); // compound unique
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("not" in c) return value !== c.not && !(c.not && typeof c.not === "object" && "in" in (c.not as object) && ((c.not as { in: unknown[] }).in).includes(value));
      if ("lt" in c) return value != null && (value as Date) < (c.lt as Date);
      return false;
    }
    return value === cond;
  });
}
function apply(row: Row, data: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !(v instanceof Date) && ("increment" in v || "decrement" in v)) row[k] = (row[k] as number) + ((v as { increment?: number }).increment ?? 0) - ((v as { decrement?: number }).decrement ?? 0);
    else row[k] = v;
  }
  row.updatedAt = new Date();
}
function conflict(name: string, data: Row) {
  return (unique[name] ?? []).some((keys) => table(name).some((r) => keys.every((k) => r[k] === data[k])));
}
const p2002 = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
const DEFAULTS: Record<string, Row> = {
  autoEngine: { enabled: true, mode: "PAPER", leaseId: null, leaseUntil: null }, autoStrategy: { enabled: true, paused: false, lastError: null },
  autoDay: { investedPaise: 0, realizedPaise: 0, chargesPaise: 0, trades: 0, wins: 0, losses: 0, skipped: 0, status: "WAITING", note: "" },
};
function model(name: string) {
  const create = ({ data }: { data: Row }) => {
    if (conflict(name, data)) throw p2002();
    const row = { id: `${name}-${(seq += 1)}`, createdAt: new Date(), updatedAt: new Date(), ...(DEFAULTS[name] ?? {}), ...data };
    table(name).push(row);
    return { ...row };
  };
  const findFirst = ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown } = {}) => { void orderBy; const r = table(name).find((row) => matches(row, where)); return r ? { ...r } : null; };
  return {
    create: async (a: { data: Row }) => create(a),
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => { let count = 0; for (const d of data) { if (conflict(name, d)) { if (!skipDuplicates) throw p2002(); continue; } create({ data: d }); count += 1; } return { count }; },
    findFirst: async (a?: { where?: Record<string, unknown> }) => findFirst(a),
    count: async ({ where }: { where?: Record<string, unknown> } = {}) => table(name).filter((row) => matches(row, where)).length,
    findUnique: async ({ where }: { where: Record<string, unknown> }) => findFirst({ where }),
    findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => { const r = findFirst({ where }); if (!r) throw new Error("not found"); return r; },
    findMany: async ({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Record<string, string> | Record<string, string>[]; take?: number } = {}) => {
      let rows = table(name).filter((row) => matches(row, where)).map((r) => ({ ...r }));
      const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) => Object.entries(o));
      if (keys.length) rows.sort((a, b) => { for (const [k, dir] of keys) { if (a[k] === b[k]) continue; return ((a[k] as number) < (b[k] as number) ? -1 : 1) * (dir === "desc" ? -1 : 1); } return 0; });
      if (take) rows = rows.slice(0, take);
      return rows;
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => { const r = table(name).find((row) => matches(row, where)); if (!r) throw new Error(`${name} not found`); apply(r, data); return { ...r }; },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => { const hit = table(name).filter((row) => matches(row, where)); hit.forEach((r) => apply(r, data)); return { count: hit.length }; },
    upsert: async ({ where, update, create: c }: { where: Record<string, unknown>; update: Row; create: Row }) => { const r = table(name).find((row) => matches(row, where)); if (r) { apply(r, update); return { ...r }; } return create({ data: c }); },
  };
}
const prismaMock: Record<string, unknown> = {};
for (const name of ["autoEngine", "autoStrategy", "autoDay", "autoSignal", "autoTrade", "autoOrder", "autoSnapshot", "autoEvent", "autoReport", "appSetting"]) prismaMock[name] = model(name);
prismaMock.$transaction = async (arg: unknown) => {
  const snapshot = JSON.stringify(db);
  try {
    return typeof arg === "function" ? await (arg as (tx: unknown) => Promise<unknown>)(prismaMock) : await Promise.all(arg as Promise<unknown>[]);
  } catch (error) {
    const back = JSON.parse(snapshot, (k, v) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && ["createdAt", "updatedAt", "leaseUntil", "heartbeatAt", "entryAt", "exitAt", "signalAt", "lastAt", "requestedAt", "filledAt", "quoteAt", "at"].includes(k) ? new Date(v) : v));
    for (const key of Object.keys(db)) delete db[key];
    Object.assign(db, back);
    throw error;
  }
};
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// ── Market data: real NIFTY candles (Dhan, 19 Nov 2026) and a synthetic option book derived from them ──
const FIX = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/nifty-1min-2026-11.json"), "utf8")) as Record<string, Array<[string, number, number, number, number]>>;
const IST = 19_800;
const unixOf = (date: string, clock: string) => { const [y, m, d] = date.split("-").map(Number); return Date.UTC(y, m - 1, d) / 1000 - IST + (+clock.slice(0, 2) * 60 + +clock.slice(3, 5)) * 60; };
const tapeOf = (date: string) => (FIX[date] ?? []).map(([t, o, h, l, c]) => ({ time: unixOf(date, t), open: o, high: h, low: l, close: c, volume: 0 }));
let clockNow = new Date();
const optionPrice = (spot: number, strike: number, right: "CE" | "PE") => Math.max(5, Math.round((80 + (right === "CE" ? spot - strike : strike - spot) * 0.5) * 20) / 20);
const optionTape = (date: string, strike: number, right: "CE" | "PE") => tapeOf(date).map((b) => ({ time: b.time, open: optionPrice(b.open, strike, right), high: optionPrice(right === "CE" ? b.high : b.low, strike, right), low: optionPrice(right === "CE" ? b.low : b.high, strike, right), close: optionPrice(b.close, strike, right), volume: 100 }));
const ids = new Map<string, { strike: number; right: "CE" | "PE"; date: string }>();
let chainOk = true;
vi.mock("@/server/market", () => ({
  sessionMinuteTape: async (symbol: string, date: string) => (symbol === "NIFTY" ? tapeOf(date) : tapeOf(date).map((b) => ({ ...b, open: 14, high: 14, low: 14, close: 14 }))),
  getS1Data: async (_s: string, date: string) => {
    const dates = Object.keys(FIX).sort();
    const prev = dates[dates.indexOf(date) - 1];
    return { previous: prev ? { close: FIX[prev].at(-1)![4] } : null };
  },
}));
vi.mock("@/server/option-chain", () => ({
  loadOptionChain: async () => {
    if (!chainOk) throw new Error("chain down");
    const date = new Date(clockNow.getTime() + IST * 1000).toISOString().slice(0, 10);
    const nowSec = Math.floor(clockNow.getTime() / 1000);
    const last = tapeOf(date).filter((b) => b.time + 60 <= nowSec).at(-1);
    const spot = last?.close ?? 25_000;
    const strikes = [];
    for (let k = Math.round(spot / 50) * 50 - 500; k <= Math.round(spot / 50) * 50 + 500; k += 50) {
      const side = (right: "CE" | "PE") => { const id = `${date}-${k}-${right}`.replace(/-/g, ""); ids.set(id, { strike: k, right, date }); const px = optionPrice(spot, k, right); return { ltp: px, bid: px - 0.05, ask: px + 0.05, securityId: id }; };
      strikes.push({ strike: k, ce: side("CE"), pe: side("PE") });
    }
    return { symbol: "NIFTY", available: true, asOf: clockNow.toISOString(), expiry: "2026-11-24", lotSize: 65, strikes, spot };
  },
}));
vi.mock("@/server/dhan-market", () => ({ dhanOptionSession: async (id: string) => { const c = ids.get(id)!; return optionTape(c.date, c.strike, c.right); } }));
let holidays: string[] = [];
vi.mock("@/server/settings", () => ({ getHolidays: async () => holidays }));

const { autoTick } = await import("../src/server/auto/engine");

async function runDay(date: string, from = "09:00", to = "15:40", step = 30) {
  for (let t = unixOf(date, from); t <= unixOf(date, to); t += step) {
    clockNow = new Date(t * 1000);
    await autoTick(clockNow);
  }
}
const rows = (name: string) => table(name);

describe("automated paper engine — real NIFTY sessions", () => {
  beforeEach(() => { for (const k of Object.keys(db)) delete db[k]; holidays = []; chainOk = true; seq = 0; });

  it("takes no trade on a day its rules skip (19 Nov 2026: first hour 199 pts >= 108.8), and still closes the day", async () => {
    await runDay("2026-11-19", "09:00", "15:40", 60);
    expect(rows("autoTrade")).toHaveLength(0);
    const days = rows("autoDay");
    expect(days).toHaveLength(8);
    expect(days.every((d) => d.status === "CLOSED" && d.availablePaise === 20_000_00)).toBe(true);
    expect(days.filter((d) => String(d.note).includes("first-hour range")).length).toBeGreaterThanOrEqual(6);
    expect(rows("autoReport")).toHaveLength(1);
  }, 120_000);

  it("trades a real Second Hour day (6 Aug 2026): trade 1 = the backtest's 11:19 24650 CE, wallets and P&L reconcile", async () => {
    await runDay("2026-08-06", "09:00", "15:40", 30);
    const trades = rows("autoTrade");
    for (const key of ["SH_TUE_THU", "SH_THU", "SH_ALL", "MHB_FINAL"]) {
      const t1 = trades.find((t) => t.strategyKey === key && t.tradeNo === 1);
      expect(t1, key).toBeTruthy();
      expect([t1!.strike, t1!.right]).toEqual([24650, "CE"]);
      expect((t1!.entryAt as Date).getTime() / 1000).toBeGreaterThanOrEqual(unixOf("2026-08-06", "11:20")); // after the 11:19 confirmation candle closed
      expect((t1!.entryAt as Date).getTime() / 1000).toBeLessThanOrEqual(unixOf("2026-08-06", "11:20") + 60);
    }
    expect(trades.some((t) => t.strategyKey === "SH_TUE" || t.strategyKey === "MONWED")).toBe(false); // Tuesday-only / Mon-Wed
    expect(trades.filter((t) => t.strategyKey === "MHB_FINAL")).toHaveLength(1); // one trade a day
    for (const t of trades.filter((x) => x.tradeNo === 2)) {
      const first = trades.find((x) => x.strategyKey === t.strategyKey && x.tradeNo === 1)!;
      expect((t.entryAt as Date) > (first.exitAt as Date)).toBe(true);
      expect((t.entryAt as Date).getTime() / 1000).toBeLessThanOrEqual(unixOf("2026-08-06", "13:12"));
    }
    for (const t of trades) {
      expect(t.status).toBe("CLOSED");
      expect(t.netPaise).toBe((t.grossPaise as number) - (t.entryChargesPaise as number) - (t.exitChargesPaise as number));
      expect((t.investedPaise as number) + (t.entryChargesPaise as number)).toBeLessThanOrEqual(20_000_00);
      expect(t.quantity as number % 65).toBe(0);
    }
    for (const d of rows("autoDay")) {
      const own = trades.filter((t) => t.strategyKey === d.strategyKey);
      expect(d.realizedPaise).toBe(own.reduce((sum, t) => sum + (t.netPaise as number), 0));
      expect(d.availablePaise).toBe(20_000_00 + (d.realizedPaise as number));
      expect(d.trades).toBe(own.length);
    }
    expect(rows("autoOrder")).toHaveLength(trades.length * 2);
  }, 120_000);

  it("trades MonWed on a real Monday (2 Nov 2026): 23300 CE at 10:15, +1.48% limit or 15:20", async () => {
    await runDay("2026-11-02", "09:00", "15:40", 30);
    const mw = rows("autoTrade").filter((t) => t.strategyKey === "MONWED");
    expect(mw).toHaveLength(1);
    expect([mw[0].strike, mw[0].right]).toEqual([23300, "CE"]);
    expect((mw[0].entryAt as Date).getTime() / 1000).toBeLessThan(unixOf("2026-11-02", "10:16"));
    expect(["TARGET", "TIME_EXIT"]).toContain(mw[0].exitReason);
  }, 120_000);

  it("never fills twice when passes overlap or repeat, and resets wallets the next day", async () => {
    await runDay("2026-08-06", "09:00", "11:21");
    const before = rows("autoTrade").length;
    expect(before).toBeGreaterThan(0);
    clockNow = new Date(unixOf("2026-08-06", "11:21") * 1000 + 10_000);
    const [a, b] = await Promise.all([autoTick(clockNow), autoTick(clockNow)]);
    expect([a.status, b.status]).toContain("BUSY");
    await autoTick(clockNow);
    expect(rows("autoTrade").length).toBe(before);
    expect(new Set(rows("autoOrder").map((o) => o.idempotencyKey)).size).toBe(rows("autoOrder").length);
    await runDay("2026-08-06", "11:22", "15:40", 60);
    expect(rows("autoDay").some((d) => d.realizedPaise !== 0)).toBe(true);
    await runDay("2026-11-19", "09:00", "09:05", 60);
    const next = rows("autoDay").filter((d) => d.date === "2026-11-19");
    expect(next).toHaveLength(8);
    expect(next.every((d) => d.availablePaise === 20_000_00 && d.realizedPaise === 0)).toBe(true);
  }, 120_000);

  it("pausing keeps managing an open position to its exit", async () => {
    await runDay("2026-08-06", "09:00", "11:20", 30);
    const open = rows("autoTrade").find((t) => t.strategyKey === "SH_ALL");
    expect(open?.status).toBe("OPEN");
    await (prismaMock.autoStrategy as ReturnType<typeof model>).updateMany({ where: { key: "SH_ALL" }, data: { paused: true } });
    await runDay("2026-08-06", "11:21", "15:40", 60);
    const own = rows("autoTrade").filter((t) => t.strategyKey === "SH_ALL");
    expect(own).toHaveLength(1); // no trade 2 while paused
    expect(own[0].status).toBe("CLOSED");
  }, 120_000);

  it("master OFF stops new entries for every strategy", async () => {
    await runDay("2026-08-06", "09:00", "11:15", 60);
    await (prismaMock.autoEngine as ReturnType<typeof model>).updateMany({ where: { id: "main" }, data: { enabled: false } });
    await runDay("2026-08-06", "11:16", "15:40", 60);
    expect(rows("autoTrade")).toHaveLength(0);
    expect(rows("autoDay").filter((d) => String(d.note).includes("Master")).length + rows("autoDay").filter((d) => d.status === "CLOSED").length).toBeGreaterThan(0);
    expect(rows("autoDay").every((d) => d.status === "CLOSED")).toBe(true);
  }, 120_000);

  it("does nothing on an exchange holiday or a weekend", async () => {
    holidays = ["2026-11-19"];
    await runDay("2026-11-19", "11:00", "11:05", 60);
    expect(rows("autoDay")).toHaveLength(0);
    clockNow = new Date(unixOf("2026-11-21", "11:00") * 1000);
    expect((await autoTick(clockNow)).status).toBe("CLOSED");
  });

  it("suspends entries while the option chain is down and skips a signal that is too old", async () => {
    chainOk = false;
    await runDay("2026-08-06", "09:00", "11:30", 60);
    expect(rows("autoTrade")).toHaveLength(0);
    chainOk = true;
    await runDay("2026-08-06", "11:31", "11:35", 60);
    // The 11:19 signal is now 11+ minutes old: recorded as SKIPPED with the reason, never bought late.
    expect(rows("autoTrade").filter((t) => t.tradeNo === 1)).toHaveLength(0);
    const skipped = rows("autoSignal").filter((s) => s.status === "SKIPPED");
    expect(skipped.length).toBeGreaterThan(0);
    expect(String(skipped[0].reason)).toMatch(/after its candle closed/);
  }, 120_000);
});

describe("automated paper engine — a day without market data", () => {
  beforeEach(() => { for (const k of Object.keys(db)) delete db[k]; holidays = []; chainOk = true; seq = 0; });
  it("closes the day once at 09:30 when no NIFTY candle exists (holiday missing from the list) and then stays quiet", async () => {
    await runDay("2026-11-24", "09:00", "10:00", 30);
    const days = rows("autoDay");
    expect(days).toHaveLength(8);
    expect(days.every((d) => d.status === "CLOSED" && String(d.note).startsWith("No market data"))).toBe(true);
    expect(rows("autoTrade")).toHaveLength(0);
    expect(rows("autoReport")).toHaveLength(1);
    expect(rows("autoEvent").filter((e) => String(e.message).startsWith("No NIFTY candles"))).toHaveLength(1);
  }, 60_000);
});
