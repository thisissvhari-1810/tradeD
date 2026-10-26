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
    expect(refused).toEqual({ ok: false, owner: "EXISTING_ALGO", reason: "Mathi Strategy is running. Stop it before starting Algo - Primary Strategy." });
    const primary = memoryStore("PRIMARY_STRATEGY");
    const other = await acquireLock(primary.store, "EXISTING_ALGO", async () => ({ running: false, position: true, pending: false }));
    expect(other.ok).toBe(false);
    expect(!other.ok && other.reason).toContain("Algo - Primary Strategy is running with an open position. Stop it before starting Mathi Strategy. Its open position must be closed");
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
  /** Every candle's decision in time order, as a replay would make them (each from its own prefix only). */
  const walk = (candles: Candle[], extra: Partial<PrimarySettings> = {}) => candles.map((_, index) => primarySignal(candles.slice(0, index + 1), OPEN, { ...settings, ...extra }));
  const fired = (candles: Candle[], extra: Partial<PrimarySettings> = {}) => walk(candles, extra).flatMap((result, index) => (result.signal ? [{ index, direction: result.signal.direction, type: result.signal.reason.split(":")[0] }] : []));

  it("the opening range is analysis only: nothing during it, and nothing carried out of it", () => {
    const inside = series([...range.slice(0, 10), 110]);
    expect(primarySignal(inside, OPEN, settings)).toMatchObject({ signal: null, state: { status: "WAITING — Observing the opening range (to 09:30)" } });
    // A break inside the window (candle 12) is not traded when the window ends: no new crossing after it.
    const early = series([...range.slice(0, 12), 110, 111, 112, 112, 112]);
    expect(fired(early)).toEqual([]);
  });

  it("1. initial breakout: a completed close above the range high, above VWAP, with the 9 / 21 EMA bullish; stop beyond the candle", () => {
    const candles = series([...range, ...rise, 110]);
    const result = primarySignal(candles, OPEN, settings);
    expect(result.state.range).toMatchObject({ high: 105, low: 97 });
    expect(result.signal).toMatchObject({ strategy: "primary", direction: "CALL", level: 105, invalidation: candles.at(-1)!.low });
    expect(result.signal!.reason).toMatch(/^Primary BREAKOUT CALL: /);
    expect(result.state.audit).toMatchObject({ decision: "ENTER", setup: { type: "BREAKOUT", direction: "CALL" }, failed: [] });
    expect(result.state.status).toBe("SIGNAL CONFIRMED — BREAKOUT CALL: checking the option contract");
  });

  it("6. a break without VWAP or trend confirmation waits (with the missing condition), and enters if confirmed in the window", () => {
    // A long decline, then a close just above the range high: the 9 EMA is still below the 21 EMA.
    const bearish = [...range, ...Array.from({ length: 20 }, (_, index) => 103 - index * 0.3), 105.5];
    const waiting = primarySignal(series(bearish), OPEN, settings);
    expect(waiting.signal).toBeNull();
    expect(waiting.state.status).toMatch(/^WAITING — EMA trend confirmation missing \(BREAKOUT CALL armed at /);
    expect(waiting.state.audit?.failed[0]).toMatch(/9 EMA .* 21 EMA .*trend bearish/);
    // Price holds above the range high and the trend turns: the armed breakout enters once, on that candle.
    const confirmed = series([...bearish, 107, 109, 111, 113, 115, 117]);
    const hits = fired(confirmed);
    expect(hits).toHaveLength(1);
    expect(hits[0].direction).toBe("CALL");
    expect(primarySignal(confirmed.slice(0, hits[0].index + 1), OPEN, settings).signal!.reason).toMatch(/confirmed \d+ candles? later/);
    // A heavy-volume spike pulls VWAP above the breakout: VWAP confirmation missing.
    const spiked = series([...range, 130, 130, 130, 100, 100, 100, 100, 100, 100, 100, 110]).map((candle, index) => (index >= 15 && index <= 17 ? { ...candle, volume: 100_000 } : candle));
    expect(primarySignal(spiked, OPEN, settings).state.status).toMatch(/^WAITING — VWAP confirmation missing/);
  });

  it("without index volume: a labelled TWAP, or no trade when set to refuse", () => {
    const candles = series([...range, ...rise, 110], 0);
    expect(sessionVwap(candles, "twap")?.source).toBe("TWAP");
    expect(sessionVwap(candles, "reject")).toBeNull();
    expect(primarySignal(candles, OPEN, settings).signal?.reason).toContain("TWAP");
    expect(primarySignal(candles, OPEN, { ...settings, vwapFallback: "reject" }).state.audit?.failed).toContain("VWAP unavailable (no index volume; the fallback is set to refuse)");
  });

  it("4. a confirmed close below the range low is a PUT breakdown; the stop can be the candle, the midpoint or the opposite edge", () => {
    const down = series([...range, ...Array.from({ length: 10 }, (_, index) => 102 - index * 0.4), 90]);
    expect(primarySignal(down, OPEN, settings).signal).toMatchObject({ direction: "PUT", level: 97 });
    expect(primarySignal(down, OPEN, settings).signal!.reason).toMatch(/^Primary BREAKDOWN PUT/);
    expect(primarySignal(down, OPEN, { ...settings, stopBasis: "mid" }).signal?.invalidation).toBe(101);
    expect(primarySignal(down, OPEN, { ...settings, stopBasis: "range" }).signal?.invalidation).toBe(105);
  });

  // The 22 Oct shape: breakout, a pullback that turns the EMAs down, then back up (a continuation), then a fall below the range high.
  const breakout = [...range, ...rise, 110, 112, 114, 116, 118, 120];
  const pullback = [118, 116, 114, 112, 110, 108, 107, 106.5, 106.2, 106];
  const resume = [108, 111, 114, 117, 120, 122];

  it("2 / 3. a second CALL needs a fresh setup: the EMA re-cross after a pullback (continuation), once — never every candle above the range", () => {
    const candles = series([...breakout, ...pullback, ...resume, 123, 124, 125, 126]);
    const hits = fired(candles);
    expect(hits.map((hit) => [hit.direction, hit.type])).toEqual([["CALL", "Primary BREAKOUT CALL"], ["CALL", "Primary CONTINUATION CALL"]]);
    // Without continuation entries only the breakout is taken.
    expect(fired(candles, { continuation: false })).toHaveLength(1);
    // Retest entries are an extra, once per break.
    const retest = series([...range, ...rise, 110, 108, 106]).concat([{ time: T(29), open: 106, high: 108, low: 104.8, close: 107.5, volume: 1000 }]);
    expect(fired(retest, { retest: true }).map((hit) => hit.type)).toEqual(["Primary BREAKOUT CALL", "Primary RETEST CALL"]);
  });

  it("5. a break of support that stays above the range low is a SUPPORT BREAKDOWN (only when enabled), never an ORB breakdown", () => {
    const fall = [...breakout, 112, 108, 104, 101, 100, 99.5, 99];
    const candles = series(fall);
    expect(fired(candles).filter((hit) => hit.direction === "PUT")).toEqual([]);
    const statuses = walk(candles).map((result) => result.state.status);
    expect(statuses.every((status) => !status.includes("BREAKDOWN PUT"))).toBe(true);
    const hits = fired(candles, { supportBreak: true }).filter((hit) => hit.direction === "PUT");
    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe("Primary SUPPORT BREAKDOWN PUT");
    // It is above the range low the whole time.
    expect(Math.min(...candles.slice(15).map((candle) => candle.close))).toBeGreaterThan(97);
  });

  it("8 / 9. decisions use only completed candles (appending later candles never changes an earlier one) and are reproducible", () => {
    const candles = series([...breakout, ...pullback, ...resume, 112, 104, 100, 99]);
    const once = walk(candles, { supportBreak: true, retest: true }).map((result) => ({ signal: result.signal, status: result.state.status }));
    const twice = walk(candles, { supportBreak: true, retest: true }).map((result) => ({ signal: result.signal, status: result.state.status }));
    expect(twice).toEqual(once);
    // Each decision equals the one made when only that much of the session existed (no look-ahead).
    const longer = series([...breakout, ...pullback, ...resume, 112, 104, 100, 99, 95, 90, 120]);
    walk(longer, { supportBreak: true, retest: true }).slice(0, candles.length).forEach((result, index) => expect({ signal: result.signal, status: result.state.status }).toEqual(once[index]));
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
    expect(ALGO_DEFAULTS).toMatchObject({ engine: "existing", sizing: "capital", stopLoss: false, crossRule: "body", crossPercent: 50 });
    expect(PRIMARY_DEFAULTS).toMatchObject({ stopLoss: true, stopAtLimit: true, crossPercent: 0 });
    expect(algoConfigProblems(readAlgoConfig(PRIMARY_DEFAULTS))).toEqual([]);
    // The Primary Strategy is chart replay only.
    expect(algoConfigProblems({ ...PRIMARY_DEFAULTS, mode: "PAPER" })).toContain("Algo - Primary Strategy runs in chart replay (demo trading) only.");
    expect(algoConfigProblems({ ...PRIMARY_DEFAULTS, allocation: { ...PRIMARY_DEFAULTS.allocation, percent: 120 } })).toContain("Capital allocation must be above 0% and at most 100%.");
  });

  it("requests name the feature: settings, starting a replay run and the backtest", () => {
    expect(algoRequest.parse({ action: "save", config: {}, strategy: "PRIMARY_STRATEGY" })).toMatchObject({ strategy: "PRIMARY_STRATEGY" });
    expect(algoRequest.parse({ action: "chartArm", session: "2026-10-16.abcd1234", cursor: 1, strategy: "PRIMARY_STRATEGY" })).toMatchObject({ strategy: "PRIMARY_STRATEGY" });
    expect(() => algoRequest.parse({ action: "chartArm", session: "2026-10-16.abcd1234", cursor: 1, strategy: "BOTH" })).toThrow();
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
    expect(server).toMatch(/data: \{ primaryConfig: primary as unknown as Prisma\.InputJsonValue \}/);
    expect(server).toMatch(/strategy, config: config as unknown as Prisma\.InputJsonValue/);
    // Released after every chart command once the run has nothing to manage.
    expect(server).toMatch(/finally \{\s*await freeLock\(session\.id, strategy\)/);
    const migration = readFileSync("prisma/migrations/20261027090000_algo_primary_strategy/migration.sql", "utf8");
    expect(migration).toContain(`ADD COLUMN "activeStrategy" TEXT NOT NULL DEFAULT 'NONE'`);
    expect(migration).toContain(`ADD COLUMN "strategy" TEXT NOT NULL DEFAULT 'EXISTING_ALGO'`);
  });
});
