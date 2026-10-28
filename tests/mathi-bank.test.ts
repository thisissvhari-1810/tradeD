import { describe, expect, it } from "vitest";
import { acquireLock, ALGO_STRATEGIES, isAlgoStrategy, isVariantStrategy, STRATEGY_NAME, type LockOwner, type LockStore } from "../src/lib/algo/exclusive";
import { algoConfigProblems, readAlgoConfig } from "../src/lib/algo/config";
import { expiryCycleOf, monthlyExpiry, rollingRequest } from "../src/lib/algo/expired-options";
import { strategyLines, type Candle } from "../src/lib/algo/lines";
import { resolveAtm, tradeStrike, type ChainInput } from "../src/lib/algo/options";
import { advance, ALGO_DEFAULTS, initialState, MATHI_BANK_DEFAULTS, type AlgoConfig, type ExecutionAdapter, type Fill } from "../src/lib/algo/runner";
import { allocateLots, ALLOCATION_DEFAULTS } from "../src/lib/algo/sizing";
import { algoRequest } from "../src/lib/algo/request";
import type { S1Data } from "../src/lib/trading/s1";

/* Mathi Bank Strategy: Mathi Strategy (+3%) on BANKNIFTY monthly options, with its own settings. */

const DATE = "2026-10-26";
const OPEN = Date.UTC(2026, 9, 26, 3, 45) / 1000; // 09:15 IST
const at = (minute: number) => OPEN + minute * 60;
const LOT = 30; // BANKNIFTY options (Dhan instrument list, October 2026)

function bankChain(now: number, ask = 800): ChainInput {
  const strikes = Array.from({ length: 7 }, (_, index) => 53_700 + index * 100).map((strike) => ({
    strike,
    ce: { ltp: ask, bid: ask - 0.5, ask, securityId: `BN${strike}CE` },
    pe: { ltp: ask, bid: ask - 0.5, ask, securityId: `BN${strike}PE` },
  }));
  return { underlying: "BANKNIFTY", spot: 54_020, expiry: "2026-10-27", asOf: new Date(now * 1000).toISOString(), lotSize: LOT, strikes };
}

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

describe("Mathi Bank Strategy: its own strategy, Mathi Strategy unchanged", () => {
  it("leaves Mathi Strategy (+3%, NIFTY) exactly as it was", () => {
    expect(ALGO_DEFAULTS.underlying).toBe("NIFTY");
    expect(ALGO_DEFAULTS.target).toEqual({ mode: "percent", value: 3 });
    expect(STRATEGY_NAME.EXISTING_ALGO).toBe("Mathi Strategy");
  });

  it("is Mathi Strategy's +3% engine on BANKNIFTY, valid, and keeps BANKNIFTY when saved settings are read back", () => {
    expect(MATHI_BANK_DEFAULTS).toMatchObject({ underlying: "BANKNIFTY", engine: "existing", crossRule: "body", stopLoss: false, settingsVersion: ALGO_DEFAULTS.settingsVersion });
    const saved = readAlgoConfig(JSON.parse(JSON.stringify(MATHI_BANK_DEFAULTS)));
    expect(saved.underlying).toBe("BANKNIFTY");
    expect(saved.target).toEqual(MATHI_BANK_DEFAULTS.target);
    expect(algoConfigProblems(saved)).toEqual([]);
  });

  it("is a separate strategy under the exclusive lock: never trades while another one runs", async () => {
    expect(ALGO_STRATEGIES).toContain("MATHI_BANK");
    expect(isAlgoStrategy("MATHI_BANK")).toBe(true);
    expect(isVariantStrategy("MATHI_BANK")).toBe(true);
    expect(isVariantStrategy("EXISTING_ALGO")).toBe(false);
    expect(STRATEGY_NAME.MATHI_BANK).toBe("Mathi Bank Strategy");
    const busy = memoryStore("EXISTING_ALGO");
    expect((await acquireLock(busy.store, "MATHI_BANK", async () => ({ running: true, position: false, pending: false }))).ok).toBe(false);
    const free = memoryStore();
    expect(await acquireLock(free.store, "MATHI_BANK", async () => ({ running: false, position: false, pending: false }))).toEqual({ ok: true });
    expect(free.owner()).toBe("MATHI_BANK");
  });

  it("accepts its live paper commands, its settings save and the chart replay; Mathi 5%'s old command still works", () => {
    for (const op of ["start", "stop", "tick", "exit"]) expect(algoRequest.safeParse({ action: "variant", strategy: "MATHI_BANK", op }).success).toBe(true);
    expect(algoRequest.safeParse({ action: "variant", strategy: "EXISTING_ALGO", op: "start" }).success).toBe(false);
    expect(algoRequest.safeParse({ action: "mathi5", op: "tick" }).success).toBe(true);
    expect(algoRequest.safeParse({ action: "save", strategy: "MATHI_BANK", config: {} }).success).toBe(true);
    expect(algoRequest.safeParse({ action: "chartArm", session: "2026-10-26.abcd", cursor: 1, strategy: "MATHI_BANK" }).success).toBe(true);
    expect(algoRequest.safeParse({ action: "backtestDay", date: DATE, variant: "saved", strategy: "MATHI_BANK" }).success).toBe(true);
  });
});

describe("BANKNIFTY contracts", () => {
  it("asks for monthly option history for BANKNIFTY (no weekly options) and weekly for NIFTY", () => {
    expect(expiryCycleOf("BANKNIFTY")).toBe("MONTH");
    expect(expiryCycleOf("nifty")).toBe("WEEK");
    expect(rollingRequest({ underlyingSecurityId: 25, offset: "ATM", side: "CALL", from: DATE, to: "2026-10-27", cycle: "MONTH" })).toMatchObject({ securityId: 25, expiryFlag: "MONTH", expiryCode: 1, instrument: "OPTIDX" });
    expect(rollingRequest({ underlyingSecurityId: 13, offset: "ATM", side: "PUT", from: DATE, to: "2026-10-27" }).expiryFlag).toBe("WEEK");
  });

  it("dates the monthly expiry: the month's last Tuesday from September 2025, the last Thursday before", () => {
    expect(monthlyExpiry("2026-10-26")).toBe("2026-10-27");
    expect(monthlyExpiry("2026-10-27")).toBe("2026-10-27");
    expect(monthlyExpiry("2026-10-28")).toBe("2026-11-24"); // the exchange moved it to 23 Nov (a holiday): holidays are not known here
    expect(monthlyExpiry("2026-12-30")).toBe("2027-01-26");
    expect(monthlyExpiry("2025-08-12")).toBe("2025-08-28");
  });

  it("picks the ATM strike on BANKNIFTY's 100-point strikes, with the contract's own lot size", () => {
    const strikes = [53_800, 53_900, 54_000, 54_100, 54_200];
    expect(tradeStrike(strikes, 54_020, "nearest", "CE")).toBe(54_000);
    expect(tradeStrike(strikes, 54_060, "nearest", "PE")).toBe(54_100);
    const call = resolveAtm(bankChain(at(30)), "CE", { rounding: "nearest", maxQuoteAgeSeconds: 90, maxSpreadPercent: 5 }, new Date(at(30) * 1000));
    expect(call.ok && [call.contract.underlying, call.contract.strike, call.contract.right, call.contract.lotSize, call.contract.securityId]).toEqual(["BANKNIFTY", 54_000, "CE", LOT, "BN54000CE"]);
  });

  it("sizes whole BANKNIFTY lots from ₹1,00,000: four lots of 30 at ₹800 (₹96,000 plus charges)", () => {
    const plan = allocateLots({ price: 800, lotSize: LOT, cash: 100_000, settings: ALLOCATION_DEFAULTS, maxLots: 50, charges: () => 60 });
    expect(plan.ok && [plan.plan.lots, plan.plan.quantity]).toEqual([4, 120]);
    const dear = allocateLots({ price: 3_400, lotSize: LOT, cash: 100_000, settings: ALLOCATION_DEFAULTS, maxLots: 50, charges: () => 60 });
    expect(dear.ok).toBe(false); // one lot (₹1,02,000) is more than the capital: no trade, never a partial lot
  });
});

describe("in the engine: a BANKNIFTY signal buys a BANKNIFTY contract", () => {
  it("enters the ATM PUT of BANKNIFTY in whole lots of 30 when the 09:15 low breaks", async () => {
    const s1: S1Data = {
      symbol: "BANKNIFTY", date: DATE, sessionOpen: OPEN, sessionClose: OPEN + 375 * 60, status: "ready", message: "",
      previous: { date: "2026-10-23", open: 54_000, high: 54_400, low: 53_700, close: 54_100 } as S1Data["previous"],
      open: 54_150, firstMinute: { time: OPEN, open: 54_150, high: 54_200, low: 54_120 },
    };
    const lines = strategyLines(s1, []);
    const low = lines.find((line) => line.type === "or-low")!.price;
    const candles: Candle[] = [{ time: at(30), open: low + 30, high: low + 40, low: low + 20, close: low + 25 }, { time: at(31), open: low + 20, high: low + 25, low: low - 60, close: low - 40 }];
    const orders: Array<{ quantity: number; contract: string; price: number }> = [];
    const adapter: ExecutionAdapter = {
      kind: "paper",
      health: async () => ({ ok: true }),
      cash: async () => 100_000,
      charges: () => 40,
      chain: async () => ({ ...bankChain(at(32)), spot: candles[1].close }),
      mark: async () => ({ bid: 800, ask: 800, candle: null, asOf: at(32) }),
      async enter(order) {
        orders.push({ quantity: order.quantity, contract: `${order.contract.underlying} ${order.contract.strike} ${order.contract.right}`, price: order.price });
        return { status: "FILLED", quantity: order.quantity, price: order.price, charges: 40 } satisfies Fill;
      },
      exit: async (order) => ({ status: "FILLED", quantity: order.quantity, price: order.price, charges: 40 }),
      lookup: async () => null,
    };
    // Single-candle confirmation only to keep the fixture short (the defaults confirm by retest).
    const config: AlgoConfig = { ...MATHI_BANK_DEFAULTS, mode: "PAPER", confirmation: { ...MATHI_BANK_DEFAULTS.confirmation, mode: "single" }, regime: { enabled: false, lookback: 30 }, filters: { ...MATHI_BANK_DEFAULTS.filters } };
    const result = await advance({ ...initialState(DATE), running: true, entries: true, lastCandle: at(29) }, { sessionId: "bank", sessionDate: DATE, config, candles, lines, now: at(32), adapter });
    expect(orders).toHaveLength(1);
    expect(orders[0].contract).toMatch(/^BANKNIFTY \d+ PE$/);
    expect(orders[0].quantity % LOT).toBe(0);
    expect(orders[0].quantity).toBe(Math.floor(100_000 / (orders[0].price * LOT + 40)) * LOT);
    expect(result.state.position?.contract.underlying).toBe("BANKNIFTY");
    expect(result.state.position?.target).toBeCloseTo(orders[0].price * (1 + MATHI_BANK_DEFAULTS.target.value / 100), 1);
  });
});
