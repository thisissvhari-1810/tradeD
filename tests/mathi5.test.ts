import { describe, expect, it } from "vitest";
import { acquireLock, ALGO_STRATEGIES, isAlgoStrategy, STRATEGY_NAME, type LockOwner, type LockStore } from "../src/lib/algo/exclusive";
import { algoConfigProblems, readAlgoConfig } from "../src/lib/algo/config";
import { ALGO_DEFAULTS, MATHI5_DEFAULTS } from "../src/lib/algo/runner";
import { algoRequest } from "../src/lib/algo/request";

function memoryStore(initial: LockOwner = "NONE") {
  let owner: LockOwner = initial;
  const store: LockStore = {
    compareAndSet: async (expected, next) => {
      if (!expected.includes(owner)) return false;
      owner = next;
      return true;
    },
    read: async () => owner,
  };
  return { store, owner: () => owner };
}

describe("Mathi 5%: a separate copy of Mathi Strategy v18", () => {
  it("is Mathi Strategy's settings with only the target changed to +5% of the premium", () => {
    const { target, ...rest } = MATHI5_DEFAULTS;
    const { target: mathiTarget, ...mathi } = ALGO_DEFAULTS;
    expect(target).toEqual({ mode: "percent", value: 5 });
    expect(mathiTarget).toEqual({ mode: "percent", value: 3 });
    expect(rest).toEqual(mathi);
    expect(MATHI5_DEFAULTS).toMatchObject({ engine: "existing", maxTrades: 3, stopLoss: false, settingsVersion: 18, confirmation: { mode: "retest" }, regime: { enabled: true } });
  });

  it("keeps its +5% target when its saved settings are read back, and is valid", () => {
    const saved = readAlgoConfig(JSON.parse(JSON.stringify(MATHI5_DEFAULTS)));
    expect(saved.target).toEqual({ mode: "percent", value: 5 });
    expect({ ...saved, target: ALGO_DEFAULTS.target }).toEqual(readAlgoConfig(JSON.parse(JSON.stringify(ALGO_DEFAULTS))));
    expect(algoConfigProblems(saved)).toEqual([]);
  });

  it("does not change Mathi Strategy itself", () => {
    expect(ALGO_DEFAULTS.target).toEqual({ mode: "percent", value: 3 });
    expect(STRATEGY_NAME.EXISTING_ALGO).toBe("Mathi Strategy");
  });

  it("is its own strategy under the exclusive lock: never trades while Mathi Strategy runs", async () => {
    expect(ALGO_STRATEGIES).toEqual(["EXISTING_ALGO", "MATHI_5", "PRIMARY_STRATEGY"]);
    expect(isAlgoStrategy("MATHI_5")).toBe(true);
    expect(STRATEGY_NAME.MATHI_5).toBe("Mathi 5%");
    const mathi = memoryStore("EXISTING_ALGO");
    const refused = await acquireLock(mathi.store, "MATHI_5", async () => ({ running: true, position: false, pending: false }));
    expect(refused.ok).toBe(false);
    expect(mathi.owner()).toBe("EXISTING_ALGO");
    const free = memoryStore();
    expect(await acquireLock(free.store, "MATHI_5", async () => ({ running: false, position: false, pending: false }))).toEqual({ ok: true });
    expect(free.owner()).toBe("MATHI_5");
  });

  it("accepts its live paper commands and its settings save, nothing else", () => {
    for (const op of ["start", "stop", "tick", "exit"]) expect(algoRequest.safeParse({ action: "mathi5", op }).success).toBe(true);
    expect(algoRequest.safeParse({ action: "mathi5", op: "live" }).success).toBe(false);
    expect(algoRequest.safeParse({ action: "save", strategy: "MATHI_5", config: {} }).success).toBe(true);
    expect(algoRequest.safeParse({ action: "chartArm", session: "2026-10-26.abcd", cursor: 1, strategy: "MATHI_5" }).success).toBe(true);
  });
});
