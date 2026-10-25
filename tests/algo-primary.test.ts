import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Candle } from "../src/lib/algo/lines";
import { acquireLock, blockedMessage, mayEnter, releaseLock, type AlgoStrategy, type LockOwner, type LockStore, type OwnerActivity } from "../src/lib/algo/exclusive";
import { PRIMARY_SETTINGS_DEFAULTS, primarySignal, sessionVwap, type PrimarySettings } from "../src/lib/algo/primary";
import { allocateLots, ALLOCATION_DEFAULTS } from "../src/lib/algo/sizing";
import { algoConfigProblems, readAlgoConfig } from "../src/lib/algo/config";
import { ALGO_DEFAULTS, PRIMARY_DEFAULTS } from "../src/lib/algo/runner";
import { algoRequest } from "../src/lib/algo/request";

/** An in-memory lock store whose compare-and-set is atomic but yields first, so concurrent calls interleave. */
function memoryStore(initial: LockOwner = "NONE") {
  let owner: LockOwner = initial;
  const store: LockStore = {
    compareAndSet: async (expected, next) => {
      await Promise.resolve();
      if (!expected.includes(owner)) return false;
      owner = next;
      return true;
    },
    read: async () => owner,
  };
  return { store, owner: () => owner };
}
const idle: OwnerActivity = { running: false, position: false, pending: false };
const running: OwnerActivity = { running: true, position: false, pending: false };

describe("the exclusive execution lock", () => {
  it("a free lock is taken; the same feature may take it again (a resume)", async () => {
    const { store, owner } = memoryStore();
    expect(await acquireLock(store, "PRIMARY_STRATEGY", async () => idle)).toEqual({ ok: true });
    expect(await acquireLock(store, "PRIMARY_STRATEGY", async () => running)).toEqual({ ok: true });
    expect(owner()).toBe("PRIMARY_STRATEGY");
  });

  it("each feature is refused while the other one runs, with the reason", async () => {
    const existing = memoryStore("EXISTING_ALGO");
    const refused = await acquireLock(existing.store, "PRIMARY_STRATEGY", async () => running);
    expect(refused).toEqual({ ok: false, owner: "EXISTING_ALGO", reason: "Algo Trade is running. Stop it before starting Algo - Primary Strategy." });
    const primary = memoryStore("PRIMARY_STRATEGY");
    const other = await acquireLock(primary.store, "EXISTING_ALGO", async () => ({ running: false, position: true, pending: false }));
    expect(other.ok).toBe(false);
    expect(!other.ok && other.reason).toContain("Algo - Primary Strategy is running with an open position. Stop it before starting Algo Trade. Its open position must be closed");
    expect(primary.owner()).toBe("PRIMARY_STRATEGY");
  });

  it("simultaneous start requests: exactly one feature gets the lock", async () => {
    for (let round = 0; round < 20; round += 1) {
      const { store, owner } = memoryStore();
      const requests: AlgoStrategy[] = Array.from({ length: 12 }, (_, index) => ((index + round) % 2 ? "EXISTING_ALGO" : "PRIMARY_STRATEGY"));
      // The winner is active as soon as it holds the lock.
      const results = await Promise.all(requests.map((strategy) => acquireLock(store, strategy, async (holder) => (holder === owner() ? running : idle))));
      const winners = new Set(requests.filter((_, index) => results[index].ok));
      expect(winners.size).toBe(1);
      expect(owner()).toBe([...winners][0]);
    }
  });

  it("a lock left by a feature with nothing running is taken over; one with a position is not", async () => {
    const stale = memoryStore("EXISTING_ALGO");
    expect(await acquireLock(stale.store, "PRIMARY_STRATEGY", async () => idle)).toEqual({ ok: true });
    expect(stale.owner()).toBe("PRIMARY_STRATEGY");
    const held = memoryStore("EXISTING_ALGO");
    expect((await acquireLock(held.store, "PRIMARY_STRATEGY", async () => ({ running: false, position: true, pending: false }))).ok).toBe(false);
  });

  it("released only when its owner has no session, position or pending order — and only by its owner", async () => {
    const { store, owner } = memoryStore("PRIMARY_STRATEGY");
    expect(await releaseLock(store, "PRIMARY_STRATEGY", { running: false, position: true, pending: false })).toBe(false);
    expect(await releaseLock(store, "PRIMARY_STRATEGY", { running: false, position: false, pending: true })).toBe(false);
    expect(await releaseLock(store, "EXISTING_ALGO", idle)).toBe(false);
    expect(owner()).toBe("PRIMARY_STRATEGY");
    expect(await releaseLock(store, "PRIMARY_STRATEGY", idle)).toBe(true);
    expect(owner()).toBe("NONE");
    expect([mayEnter("NONE", "EXISTING_ALGO"), mayEnter("EXISTING_ALGO", "EXISTING_ALGO"), mayEnter("EXISTING_ALGO", "PRIMARY_STRATEGY")]).toEqual([false, true, false]);
    expect(blockedMessage("EXISTING_ALGO", "PRIMARY_STRATEGY", { running: false, position: false, pending: true })).toContain("with a pending order");
  });
});

// 2026-10-16 09:15 IST.
const OPEN = Date.UTC(2026, 9, 16, 3, 45) / 1000;
const T = (index: number) => OPEN + index * 60;
/** Candles from closes: opens at the previous close, 1-point wicks, volume `volume`. */
function series(closes: number[], volume = 1000): Candle[] {
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1];
    return { time: T(index), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume };
  });
}
// Opening range 09:15–09:30 between 97 and 105 (closes 98 / 104), a slow rise inside it, then a break above at 25.
const range = Array.from({ length: 15 }, (_, index) => (index % 2 ? 104 : 98));
const rise = Array.from({ length: 10 }, (_, index) => 100 + index * 0.4);
const settings: PrimarySettings = { ...PRIMARY_SETTINGS_DEFAULTS, breakBufferPercent: 0 };

describe("Algo - Primary Strategy: NIFTY ORB + VWAP + trend", () => {
  it("the opening range is analysis only: nothing during it, and nothing carried out of it", () => {
    const inside = series([...range.slice(0, 10), 110]);
    expect(primarySignal(inside, OPEN, settings)).toMatchObject({ signal: null, state: { status: "OBSERVING OPENING RANGE (to 09:30)" } });
    // A break inside the window (candle 12) is not traded when the window ends: no new crossing after it.
    const early = series([...range.slice(0, 12), 110, 111, 112, 112, 112]);
    expect(primarySignal(early, OPEN, settings).signal).toBeNull();
  });

  it("CALL on a completed close above the range high, above VWAP, with the 9 / 21 EMA bullish; stop beyond the candle", () => {
    const candles = series([...range, ...rise, 110]);
    const result = primarySignal(candles, OPEN, settings);
    expect(result.state.range).toMatchObject({ high: 105, low: 97 });
    expect(result.signal).toMatchObject({ strategy: "primary", direction: "CALL", level: 105, invalidation: candles.at(-1)!.low });
    expect(result.state.vwap?.source).toBe("VWAP");
    expect(result.signal!.reason).toContain("close is above it");
  });

  it("no trade below VWAP, or against the trend; each check says why", () => {
    // A heavy-volume spike to 130 after the range pulls VWAP above 110; price falls back inside, then breaks out again.
    const spiked = series([...range, 130, 130, 130, 100, 100, 100, 100, 100, 100, 100, 110]).map((candle, index) => (index >= 15 && index <= 17 ? { ...candle, volume: 100_000 } : candle));
    expect(primarySignal(spiked, OPEN, settings)).toMatchObject({ signal: null, state: { status: "BREAKOUT BELOW VWAP: NO TRADE" } });
    const falling = series([...range, ...Array.from({ length: 10 }, (_, index) => 103 - index * 0.5), 110]);
    expect(primarySignal(falling, OPEN, settings).state.status).toMatch(/TREND|BREAKOUT CONFIRMED/);
    // A long decline, then a close just above the range high: the 9 EMA stays below the 21 EMA.
    const bearish = series([...range, ...Array.from({ length: 20 }, (_, index) => 103 - index * 0.3), 105.5]);
    expect(primarySignal(bearish, OPEN, settings)).toMatchObject({ signal: null, state: { status: "TREND AGAINST: NO TRADE" } });
  });

  it("without index volume: a labelled TWAP, or no trade when set to refuse", () => {
    const candles = series([...range, ...rise, 110], 0);
    expect(sessionVwap(candles, "twap")?.source).toBe("TWAP");
    expect(sessionVwap(candles, "reject")).toBeNull();
    expect(primarySignal(candles, OPEN, settings).signal?.reason).toContain("TWAP (no index volume, so not a true VWAP)");
    expect(primarySignal(candles, OPEN, { ...settings, vwapFallback: "reject" }).state.status).toBe("VWAP UNAVAILABLE");
  });

  it("PUT is the mirror image; the stop can be the range midpoint or the opposite edge", () => {
    const down = series([...range, ...Array.from({ length: 10 }, (_, index) => 102 - index * 0.4), 90]);
    expect(primarySignal(down, OPEN, settings).signal).toMatchObject({ direction: "PUT", level: 97 });
    expect(primarySignal(down, OPEN, { ...settings, stopBasis: "mid" }).signal?.invalidation).toBe(101);
    expect(primarySignal(down, OPEN, { ...settings, stopBasis: "range" }).signal?.invalidation).toBe(105);
  });

  it("retest mode: the break, then a touch of the range high and a close back above it", () => {
    const base = [...range, ...rise, 110, 108];
    const candles = series(base);
    const retest: Candle = { time: T(base.length), open: 106, high: 108, low: 104.8, close: 107.5, volume: 1000 };
    expect(primarySignal([...candles, retest], OPEN, { ...settings, retest: true }).signal?.reason).toContain("retest of the range high 105.00 held");
    expect(primarySignal(series([...range, ...rise, 110]), OPEN, { ...settings, retest: true }).signal).toBeNull();
  });
});

describe("whole-lot capital allocation", () => {
  const charges = (side: "BUY" | "SELL", premium: number, quantity: number) => 20 + premium * quantity * 0.001;
  const base = { price: 100, lotSize: 75, cash: 100_000, settings: ALLOCATION_DEFAULTS, maxLots: 50, charges };
  it("buys the most whole lots whose premium and charges fit; never a part lot", () => {
    const result = allocateLots(base);
    expect(result.ok).toBe(true);
    const plan = result.plan;
    expect(plan.quantity % 75).toBe(0);
    expect(plan.committed).toBeLessThanOrEqual(100_000);
    // One more lot would not fit.
    expect(100 * 75 * (plan.lots + 1) + charges("BUY", 100, 75 * (plan.lots + 1))).toBeGreaterThan(100_000);
    expect(plan.lots).toBe(13);
    expect(plan.committed).toBeCloseTo(97_500 + 20 + 97.5, 2);
  });
  it("50% allocation, the max-lots cap, and the maximum capital", () => {
    expect(allocateLots({ ...base, settings: { ...ALLOCATION_DEFAULTS, percent: 50 } }).plan.lots).toBe(6);
    expect(allocateLots({ ...base, maxLots: 4 }).plan).toMatchObject({ lots: 4, note: "Capped at the maximum of 4 lots." });
    expect(allocateLots({ ...base, settings: { ...ALLOCATION_DEFAULTS, maxCapital: 20_000 } }).plan.lots).toBe(2);
  });
  it("less cash than the allocation: reduce to the affordable lots, or skip — with the reason", () => {
    const reduced = allocateLots({ ...base, cash: 40_000 });
    expect(reduced).toMatchObject({ ok: true, plan: { lots: 5, wantedLots: 13 } });
    expect(reduced.plan.note).toContain("reduced to 5 lots");
    const rejected = allocateLots({ ...base, cash: 40_000, settings: { ...ALLOCATION_DEFAULTS, policy: "reject" } });
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.reason).toContain("the policy is to skip such an order: no trade");
    const broke = allocateLots({ ...base, cash: 5_000 });
    expect(!broke.ok && broke.reason).toContain("Insufficient buying power: one lot needs ₹7527.50 including charges, ₹5000.00 is available");
    const tiny = allocateLots({ ...base, settings: { ...ALLOCATION_DEFAULTS, maxCapital: 5_000 } });
    expect(!tiny.ok && tiny.reason).toContain("more than the ₹5000.00 allocation");
  });
});

describe("separate settings for each feature", () => {
  it("the Primary Strategy's defaults are its own: capital sizing, 3% premium target and stop, chart replay", () => {
    expect(PRIMARY_DEFAULTS).toMatchObject({ engine: "primary", mode: "REPLAY", sizing: "capital", allocation: { percent: 100, maxCapital: 100_000, policy: "reduce" }, target: { mode: "percent", value: 3 }, stop: { mode: "percent", value: 3 }, maxDailyLoss: 3_000 });
    expect(ALGO_DEFAULTS).toMatchObject({ engine: "existing", sizing: "risk" });
    expect(algoConfigProblems(readAlgoConfig(PRIMARY_DEFAULTS))).toEqual([]);
    // Capital sizing is not offered to Algo Trade; the Primary Strategy is chart replay only.
    expect(algoConfigProblems(readAlgoConfig({ ...ALGO_DEFAULTS, sizing: "capital" }))).toContain("Capital-allocation sizing is part of Algo - Primary Strategy; Algo Trade uses risk-based or fixed sizing.");
    expect(algoConfigProblems({ ...PRIMARY_DEFAULTS, mode: "PAPER" })).toContain("Algo - Primary Strategy runs in chart replay (demo trading) only.");
    expect(algoConfigProblems({ ...PRIMARY_DEFAULTS, allocation: { ...PRIMARY_DEFAULTS.allocation, percent: 120 } })).toContain("Capital allocation must be above 0% and at most 100%.");
  });

  it("requests name the feature: settings, starting a replay run and the backtest", () => {
    expect(algoRequest.parse({ action: "save", config: {}, strategy: "PRIMARY_STRATEGY" })).toMatchObject({ strategy: "PRIMARY_STRATEGY" });
    expect(algoRequest.parse({ action: "chartArm", session: "2026-10-16.abcd1234", cursor: 1, strategy: "PRIMARY_STRATEGY" })).toMatchObject({ strategy: "PRIMARY_STRATEGY" });
    expect(() => algoRequest.parse({ action: "chartArm", session: "2026-10-16.abcd1234", cursor: 1, strategy: "BOTH" })).toThrow();
  });

  it("the server takes the lock before a run processes a signal, checks it on every step and stores settings and runs separately", () => {
    const server = readFileSync("src/server/algo.ts", "utf8");
    const arm = server.slice(server.indexOf('if (command.action === "chartArm") {'));
    // Taken before resuming or creating the run (before any candle is processed).
    expect(arm.indexOf("await takeLock(sessionId, strategy);")).toBeGreaterThan(0);
    expect(arm.indexOf("await takeLock(sessionId, strategy);")).toBeLessThan(arm.indexOf("prisma.algoRun.create"));
    expect(server).toMatch(/This replay session's algo run belongs to \$\{STRATEGY_NAME/);
    // Every replay step re-checks the lock; without it the run only protects its position.
    expect(server).toMatch(/const got = await acquireLock\(lockStore\(sessionId\), strategy, \(owner\) => ownerActivity\(sessionId, owner\)\);\s*if \(!got\.ok\) \{\s*armed = false;/);
    expect(server).toMatch(/await takeLock\(session\.id, "EXISTING_ALGO"\);/);
    expect(server).toMatch(/activeStrategy: \{ in: expected \}/);
    expect(server).toMatch(/data: \{ primaryConfig: primary as unknown as Prisma\.InputJsonValue \}/);
    expect(server).toMatch(/strategy, config: config as unknown as Prisma\.InputJsonValue/);
    // Released after every chart command once the run has nothing to manage.
    expect(server).toMatch(/finally \{\s*await freeLock\(session\.id, strategy\)/);
    const migration = readFileSync("prisma/migrations/20261027090000_algo_primary_strategy/migration.sql", "utf8");
    expect(migration).toContain(`ADD COLUMN "activeStrategy" TEXT NOT NULL DEFAULT 'NONE'`);
    expect(migration).toContain(`ADD COLUMN "strategy" TEXT NOT NULL DEFAULT 'EXISTING_ALGO'`);
  });
});
