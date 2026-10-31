import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acquireLock, blockedMessage, mayEnter, releaseLock, type AlgoStrategy, type LockOwner, type LockStore, type OwnerActivity } from "../src/lib/algo/exclusive";
import { allocateLots, ALLOCATION_DEFAULTS } from "../src/lib/algo/sizing";
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
    expect(await acquireLock(store, "MATHI_HOURLY", async () => idle)).toEqual({ ok: true });
    expect(await acquireLock(store, "MATHI_HOURLY", async () => running)).toEqual({ ok: true });
    expect(owner()).toBe("MATHI_HOURLY");
  });

  it("each feature is refused while the other one runs, with the reason", async () => {
    const existing = memoryStore("EXISTING_ALGO");
    const refused = await acquireLock(existing.store, "MATHI_HOURLY", async () => running);
    expect(refused).toEqual({ ok: false, owner: "EXISTING_ALGO", reason: "Mathi Strategy is running. Stop it before starting Mathi Hourly Zone Strategy — 5%." });
    const hourly = memoryStore("MATHI_HOURLY");
    const other = await acquireLock(hourly.store, "EXISTING_ALGO", async () => ({ running: false, position: true, pending: false }));
    expect(other.ok).toBe(false);
    expect(!other.ok && other.reason).toContain("Mathi Hourly Zone Strategy — 5% is running with an open position. Stop it before starting Mathi Strategy. Its open position must be closed");
    expect(hourly.owner()).toBe("MATHI_HOURLY");
  });

  it("simultaneous start requests: exactly one feature gets the lock", async () => {
    for (let round = 0; round < 20; round += 1) {
      const { store, owner } = memoryStore();
      const requests: AlgoStrategy[] = Array.from({ length: 12 }, (_, index) => ((index + round) % 2 ? "EXISTING_ALGO" : "MATHI_HOURLY"));
      // The winner is active as soon as it holds the lock.
      const results = await Promise.all(requests.map((strategy) => acquireLock(store, strategy, async (holder) => (holder === owner() ? running : idle))));
      const winners = new Set(requests.filter((_, index) => results[index].ok));
      expect(winners.size).toBe(1);
      expect(owner()).toBe([...winners][0]);
    }
  });

  it("a lock left by a feature with nothing running is taken over; one with a position is not", async () => {
    const stale = memoryStore("EXISTING_ALGO");
    expect(await acquireLock(stale.store, "MATHI_HOURLY", async () => idle)).toEqual({ ok: true });
    expect(stale.owner()).toBe("MATHI_HOURLY");
    const held = memoryStore("EXISTING_ALGO");
    expect((await acquireLock(held.store, "MATHI_HOURLY", async () => ({ running: false, position: true, pending: false }))).ok).toBe(false);
  });

  it("released only when its owner has no session, position or pending order — and only by its owner", async () => {
    const { store, owner } = memoryStore("MATHI_HOURLY");
    expect(await releaseLock(store, "MATHI_HOURLY", { running: false, position: true, pending: false })).toBe(false);
    expect(await releaseLock(store, "MATHI_HOURLY", { running: false, position: false, pending: true })).toBe(false);
    expect(await releaseLock(store, "EXISTING_ALGO", idle)).toBe(false);
    expect(owner()).toBe("MATHI_HOURLY");
    expect(await releaseLock(store, "MATHI_HOURLY", idle)).toBe(true);
    expect(owner()).toBe("NONE");
    expect([mayEnter("NONE", "EXISTING_ALGO"), mayEnter("EXISTING_ALGO", "EXISTING_ALGO"), mayEnter("EXISTING_ALGO", "MATHI_HOURLY")]).toEqual([false, true, false]);
    expect(blockedMessage("EXISTING_ALGO", "MATHI_HOURLY", { running: false, position: false, pending: true })).toContain("with a pending order");
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
  it("requests name the feature: settings, starting a replay run and the backtest", () => {
    expect(algoRequest.parse({ action: "save", config: {}, strategy: "MATHI_HOURLY" })).toMatchObject({ strategy: "MATHI_HOURLY" });
    expect(algoRequest.parse({ action: "chartArm", session: "2026-10-16.abcd1234", cursor: 1, strategy: "MATHI_HOURLY" })).toMatchObject({ strategy: "MATHI_HOURLY" });
    expect(() => algoRequest.parse({ action: "chartArm", session: "2026-10-16.abcd1234", cursor: 1, strategy: "BOTH" })).toThrow();
    // The removed strategies (Algo - Primary Strategy, Mathi 5%, Mathi Bank Strategy) are refused.
    for (const removed of ["PRIMARY_STRATEGY", "MATHI_5", "MATHI_BANK"]) expect(algoRequest.safeParse({ action: "save", config: {}, strategy: removed }).success).toBe(false);
    expect(algoRequest.safeParse({ action: "mathi5", op: "tick" }).success).toBe(false);
  });

  it("switching: stop (or exit and stop) the running feature first — refused with an open position unless exiting, never touching a pending order", () => {
    expect(algoRequest.parse({ action: "stopStrategy", strategy: "EXISTING_ALGO", exit: true })).toMatchObject({ exit: true });
    expect(() => algoRequest.parse({ action: "stopStrategy", strategy: "EXISTING_ALGO" })).toThrow();
    const server = readFileSync("src/server/algo.ts", "utf8");
    const stop = server.slice(server.indexOf("async function stopStrategy("), server.indexOf("/** Takes the lock for"));
    // Pending orders first (refused), then an open position (refused without exit), then exit at the replay minute.
    expect(stop.indexOf("ORDER_PENDING")).toBeLessThan(stop.indexOf("POSITION_OPEN"));
    expect(stop).toMatch(/if \(open && !exit\) throw new AppError/);
    expect(stop).toMatch(/exitChartRun\(\{[\s\S]*at: Math\.min\(run\.processedThrough, close\), reason: "MANUAL"/);
    expect(stop).toMatch(/await saveChartRun\(run, \{ armed: false, state:/);
    // The lock is released only when nothing is left open; an unconfirmed exit keeps it (and says so).
    expect(stop).toMatch(/const released = await freeLock\(sessionId, strategy\);/);
    expect(stop).toContain("EXIT_PENDING");
    const ui = readFileSync("src/components/algo/algo-primary.tsx", "utf8");
    expect(ui).toMatch(/action: "stopStrategy", strategy: owner, exit/);
    expect(ui).toContain("Exit position, stop and switch");
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
    expect(server).toMatch(/strategy, config: config as unknown as Prisma\.InputJsonValue/);
    // Released after every chart command once the run has nothing to manage.
    expect(server).toMatch(/finally \{\s*await freeLock\(session\.id, strategy\)/);
    const migration = readFileSync("prisma/migrations/20261027090000_algo_primary_strategy/migration.sql", "utf8");
    expect(migration).toContain(`ADD COLUMN "activeStrategy" TEXT NOT NULL DEFAULT 'NONE'`);
    expect(migration).toContain(`ADD COLUMN "strategy" TEXT NOT NULL DEFAULT 'EXISTING_ALGO'`);
  });
});
