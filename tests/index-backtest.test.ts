import { describe, expect, it } from "vitest";
import { readAlgoConfig } from "../src/lib/algo/config";
import { expiredChain, expiredTape, type ExpiredTapes } from "../src/lib/algo/expired-options";
import {
  auditCsv, auditSession, INDEX_SPECS, indexSessions, monthWindow, resolveExpiries, sessionQuality, statutoryCharges, summarize, verifyTrade, weekdays, type AuditTrade,
} from "../src/lib/algo/index-backtest";
import { strategyLines, type Candle } from "../src/lib/algo/lines";
import { createReplayAdapter, simulateSession } from "../src/lib/algo/replay-adapter";
import { ALGO_DEFAULTS, type AlgoConfig } from "../src/lib/algo/runner";
import { findIndex } from "../src/lib/market/indices";
import { optionCharges } from "../src/lib/options/engine";
import type { S1Data } from "../src/lib/trading/s1";

/* Mathi Strategy (+3%) on other indices: the engine's trades, audited against their own option candles. */

const DATE = "2026-10-20";
const OPEN = Date.UTC(2026, 9, 20, 3, 45) / 1000; // 09:15 IST
const at = (minute: number) => OPEN + minute * 60;
const LOT = INDEX_SPECS.FINNIFTY.lotSize;
const config: AlgoConfig = readAlgoConfig({ ...ALGO_DEFAULTS, underlying: "FINNIFTY", mode: "REPLAY" });

const candle = (minute: number, open: number, high: number, low: number, close: number, volume = 0): Candle => ({ time: at(minute), open, high, low, close, volume });

/**
 * A session on a 24,000 previous-day high: flat below it, a 09:30 candle with 80% of its body past it, a 09:31 retest
 * that holds, and a 09:32 bullish candle above the retest high (SETUP CONFIRMED → entry at 09:33 on the ATM CE 24050).
 */
function indexSession(after: (minute: number) => number = () => 24_030): Candle[] {
  const list: Candle[] = [candle(0, 23_950, 23_985, 23_945, 23_980)];
  for (let minute = 1; minute < 15; minute += 1) list.push(candle(minute, 23_990, 23_991, 23_989, 23_990));
  list.push(candle(15, 23_995, 24_022, 23_994, 24_020), candle(16, 24_018, 24_019, 24_003, 24_010), candle(17, 24_010, 24_031, 24_009, 24_030));
  let previous = 24_030;
  for (let minute = 18; minute < 375; minute += 1) {
    const value = after(minute);
    list.push(candle(minute, previous, Math.max(previous, value) + 0.5, Math.min(previous, value) - 0.5, value));
    previous = value;
  }
  return list;
}

const s1: S1Data = {
  symbol: "FINNIFTY", date: DATE, sessionOpen: OPEN, sessionClose: OPEN + 22_500, status: "ready", message: "",
  previous: { date: "2026-10-19", open: 23_700, high: 24_000, low: 23_600, close: 23_900 } as S1Data["previous"],
  open: 23_950, firstMinute: { time: OPEN, open: 23_950, high: 23_985, low: 23_945 },
};

/** Flat ₹100 tapes on every strike; the traded CE 24050 follows `ce` after the signal minute. */
function optionTapes(ce: (minute: number) => [number, number, number, number] | null, options: { signalClose?: number | null; volume?: number } = {}): Map<string, Candle[]> {
  const tapes = new Map<string, Candle[]>();
  for (let strike = 23_900; strike <= 24_200; strike += 50) {
    for (const right of ["CE", "PE"]) {
      const list: Candle[] = [];
      for (let minute = 0; minute < 375; minute += 1) {
        if (right === "CE" && strike === 24_050) {
          if (minute === 17) { if (options.signalClose !== null) list.push(candle(17, 99, 100.5, 98.5, options.signalClose ?? 100, options.volume ?? 5_000)); continue; }
          const row = minute > 17 ? ce(minute) : [99, 99.5, 98.5, 99] as [number, number, number, number];
          if (row) list.push(candle(minute, ...row, 1_000));
        } else list.push(candle(minute, 100, 100, 100, 100, 1_000));
      }
      tapes.set(`${right}:${strike}`, list);
    }
  }
  return tapes;
}

async function simulate(candles: Candle[], tapes: Map<string, Candle[]>, settings: AlgoConfig = config) {
  const lines = strategyLines(s1, settings.custom);
  const chain = expiredChain({ symbol: "FINNIFTY", date: DATE, expiry: "2026-10-27", lotSize: LOT, tapes });
  const adapter = createReplayAdapter({ candles, chain, config: settings, capital: 100_000, tapeOf: async (contract) => expiredTape(tapes, contract.securityId) });
  const { events } = await simulateSession({ sessionId: "t", date: DATE, config: settings, candles, lines, adapter, startNote: "test" });
  const expiry = { expiry: "2026-10-27", source: "data" as const, calendar: "2026-10-27", mismatch: false };
  return { events, trades: auditSession({ symbol: "FINNIFTY", date: DATE, events, tapes, expiry, slippageTicks: settings.slippageTicks }) };
}

const winning = (minute: number): [number, number, number, number] => (minute === 18 ? [100, 102, 99.5, 101.5] : minute === 19 ? [101.5, 103.3, 101, 103] : [103, 103.5, 102.5, 103]);

describe("index specs: the three indices as the app and Dhan know them", () => {
  it("uses the app's own index ids and Dhan's current lot sizes, monthly expiries only", () => {
    expect(Object.keys(INDEX_SPECS)).toEqual(["FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"]);
    for (const spec of Object.values(INDEX_SPECS)) {
      expect(findIndex(spec.symbol)?.id).toBe(String(spec.dhanIndexId));
      expect(spec.cycle).toBe("MONTH");
    }
    expect([INDEX_SPECS.FINNIFTY.lotSize, INDEX_SPECS.MIDCPNIFTY.lotSize, INDEX_SPECS.NIFTYNXT50.lotSize]).toEqual([60, 120, 25]);
    expect([INDEX_SPECS.FINNIFTY.strikeStep, INDEX_SPECS.MIDCPNIFTY.strikeStep, INDEX_SPECS.NIFTYNXT50.strikeStep]).toEqual([50, 25, 100]);
  });

  it("runs Mathi Strategy unchanged: only the underlying and the replay mode differ from the defaults", () => {
    // The same settings the app runs when Mathi Strategy's saved settings are the defaults (readAlgoConfig spells out the
    // optional research toggles, all off).
    expect({ ...config, underlying: ALGO_DEFAULTS.underlying, mode: ALGO_DEFAULTS.mode }).toEqual(readAlgoConfig(ALGO_DEFAULTS));
    expect({ ...config.filters, ...ALGO_DEFAULTS.filters }).toEqual(config.filters);
    expect(Object.entries(config.filters).filter(([key]) => !(key in ALGO_DEFAULTS.filters)).every(([, value]) => value === 0 || value === false)).toBe(true);
    expect([config.indexStopPoints, config.itmSteps, config.structureStop]).toEqual([0, 0, false]);
    expect(config).toMatchObject({ underlying: "FINNIFTY", target: { mode: "percent", value: 3 }, stopLoss: false, crossPercent: 50, maxTrades: 3, slippageTicks: 1 });
    expect(config.confirmation.mode).toBe("retest");
  });
});

describe("entries, target hits and losing exits on the engine's own trades", () => {
  it("enters after the retest at the signal minute's premium + 1 tick and exits at the +3% target", async () => {
    const tapes = optionTapes(winning);
    const { trades } = await simulate(indexSession(), tapes);
    expect(trades).toHaveLength(1);
    const trade = trades[0];
    expect([trade.right, trade.strike, trade.side, trade.expiry, trade.optionSymbol]).toEqual(["CE", 24_050, "CALL", "2026-10-27", "FINNIFTY 2026-10-27 24050 CE"]);
    expect(trade.signalTime).toBe(at(15));
    expect(trade.entryTime).toBe(at(18));
    // Known example: 100 + 0.05 = 100.05; × 1.03 = 103.0515 → 103.05; filled less 1 tick = 103.00.
    expect(trade.entryPremium).toBe(100.05);
    expect(trade.targetPremium).toBe(103.05);
    expect(trade.exitPremium).toBe(103);
    expect(trade.exitReason).toBe("Target");
    expect(trade.exitTime).toBe(at(20));
    expect(trade.targetHit).toBe(true);
    // Whole lots of 60 that ₹1,00,000 pays for, charges included.
    expect(trade.quantity % LOT).toBe(0);
    expect(trade.lots).toBe(Math.floor(100_000 / (100.05 * LOT + 25)));
    expect(trade.gross).toBeCloseTo((103 - 100.05) * trade.quantity, 2);
    expect(trade.net).toBeCloseTo(trade.gross! - trade.charges, 2);
    expect(trade.mfe).toBeCloseTo(103.3 - 100.05, 2);
    expect(trade.mae).toBeCloseTo(100.05 - 99.5, 2);
    expect(trade.flags).toEqual([]);
    expect(verifyTrade(trade, tapes.get("CE:24050")!, 1)).toEqual([]);
  });

  it("charges are the app's option charge model on both orders", async () => {
    const { trades } = await simulate(indexSession(), optionTapes(winning));
    const trade = trades[0];
    const paise = (rupees: number) => BigInt(Math.round(rupees * 100));
    const expected = Number(optionCharges("BUY", paise(100.05), trade.quantity).total + optionCharges("SELL", paise(103), trade.quantity).total) / 100;
    expect(trade.charges).toBeCloseTo(expected, 2);
    expect(trade.slippage).toBeCloseTo(2 * 0.05 * trade.quantity, 2);
  });

  it("a trade that never reaches +3% exits at the 45-minute checkpoint when the trend no longer agrees: a loss, all costs in", async () => {
    // The index drifts down after the entry; the option bleeds to ₹95.
    const tapes = optionTapes((minute) => [96, 97, 94.5, 95]);
    const { trades } = await simulate(indexSession((minute) => Math.max(24_004, 24_030 - (minute - 17) * 0.5)), tapes);
    expect(trades).toHaveLength(1);
    const trade = trades[0];
    expect(trade.targetHit).toBe(false);
    expect(trade.exitReason).not.toBe("Target");
    expect(trade.holdingMinutes).toBeGreaterThanOrEqual(45);
    expect(trade.exitPremium).toBe(94.95);
    expect(trade.net).toBeLessThan(0);
    expect(trade.mae).toBeCloseTo(100.05 - 94.5, 2);
    expect(verifyTrade(trade, tapes.get("CE:24050")!, 1)).toEqual([]);
    const summary = summarize(trades, [DATE], 100_000);
    expect([summary.wins, summary.losses, summary.winRate, summary.targetHits, summary.otherExits, summary.maxConsecutiveLosses]).toEqual([0, 1, 0, 0, 1, 1]);
    expect(summary.net).toBeCloseTo(trade.net!, 2);
    expect(summary.maxDrawdown).toBeCloseTo(-trade.net!, 2);
  });

  it("never lets a later candle change an earlier decision (no look-ahead)", async () => {
    const base = (await simulate(indexSession(), optionTapes(winning))).trades[0];
    // A wild index move and option spike from 10:30 on: the 09:33 entry is the same.
    const later = await simulate(indexSession((minute) => (minute >= 75 ? 25_000 : 24_030)), optionTapes((minute) => (minute >= 75 ? [500, 600, 400, 550] : winning(minute))));
    expect(later.trades[0]).toMatchObject({ signalTime: base.signalTime, entryTime: base.entryTime, entryPremium: base.entryPremium, exitTime: base.exitTime, exitPremium: base.exitPremium });
  });
});

describe("missing and thin data", () => {
  it("no premiums for the ATM contract: no trade, the reason is recorded", async () => {
    const tapes = optionTapes(winning);
    tapes.delete("CE:24050");
    const { trades, events } = await simulate(indexSession(), tapes);
    expect(trades).toEqual([]);
    expect(events.some((event) => event.kind === "REJECTED" && /not listed|bid and ask|Stale/i.test(event.message))).toBe(true);
  });

  it("no option trade in the signal minute: the earlier premium is used and the trade is flagged", async () => {
    const tapes = optionTapes(winning, { signalClose: null });
    const { trades } = await simulate(indexSession(), tapes);
    expect(trades[0].entryPremium).toBe(99.05);
    expect(trades[0].flags).toContain("STALE_ENTRY_PREMIUM");
    expect(verifyTrade(trades[0], tapes.get("CE:24050")!, 1)).toEqual([]);
  });

  it("a target that was only touched, an order larger than the minute's volume, and minutes without trades are flagged", async () => {
    // 100.05 × 1.03 = 103.05: the 09:34 high is exactly the target.
    const tapes = optionTapes((minute) => (minute === 18 ? [100, 101, 99.5, 100.5] : minute === 19 ? null : minute === 20 ? [100.5, 103.05, 100.5, 102] : [102, 102.5, 101.5, 102]), { volume: 60 });
    const { trades } = await simulate(indexSession(), tapes);
    expect(trades[0].exitReason).toBe("Target");
    expect(trades[0].flags).toEqual(expect.arrayContaining(["TARGET_TOUCH_ONLY", "QTY_ABOVE_ENTRY_MINUTE_VOLUME", "MISSING_OPTION_MINUTES"]));
  });

  it("verification catches a trade that does not match its candles", async () => {
    const tapes = optionTapes(winning);
    const trade = (await simulate(indexSession(), tapes)).trades[0];
    expect(verifyTrade({ ...trade, entryPremium: 98 }, tapes.get("CE:24050")!, 1).join(" ")).toMatch(/entry 98/);
    expect(verifyTrade({ ...trade, targetHit: false, exitReason: "Time limit", exitTime: at(40) }, tapes.get("CE:24050")!, 1).join(" ")).toMatch(/reached the target/);
  });

  it("splits index candles into sessions, dropping duplicates, out-of-session and invalid rows, and lists missing minutes", () => {
    const raw = indexSession().slice(0, 10);
    const split = indexSessions([...raw, raw[3], { ...raw[0], time: OPEN - 600 }, { ...raw[1], time: at(500) }, { ...raw[2], time: at(2) + 7, high: 1, low: 2 }]);
    expect([split.duplicates, split.outside, split.invalid]).toEqual([1, 2, 1]);
    const quality = sessionQuality(DATE, split.byDay.get(DATE)!);
    expect(quality.candles).toBe(10);
    expect(quality.missing[0]).toBe("09:25");
    expect(quality.complete).toBe(false);
  });
});

describe("window, expiries, charges and report figures", () => {
  it("takes one calendar month ending on the last session", () => {
    expect(monthWindow("2026-10-27")).toEqual({ from: "2026-09-28", to: "2026-10-27" });
    expect(monthWindow("2026-03-31")).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(weekdays("2026-09-28", "2026-10-27")).toHaveLength(22);
  });

  it("dates expiries from the data (holiday shifts included) and says when the calendar rule differs", () => {
    // ATM call and put at the last minute: ₹0.5 of time value on Mon 23 Nov 2026 (expiry), ₹40 the days before.
    const day = (date: string, value: number) => {
      const last = Date.parse(`${date}T09:59:00Z`) / 1000; // 15:29 IST
      return new Map([["CE:15000", [{ time: last, open: value, high: value, low: value, close: value }]], ["PE:15000", [{ time: last, open: value, high: value, low: value, close: value }]]]);
    };
    const tapes: ExpiredTapes = new Map([["2026-11-19", day("2026-11-19", 40)], ["2026-11-20", day("2026-11-20", 40)], ["2026-11-23", day("2026-11-23", 0.25)]]);
    const expiries = resolveExpiries(tapes, "MONTH", 5);
    expect(expiries.get("2026-11-19")).toEqual({ expiry: "2026-11-23", source: "data", calendar: "2026-11-24", mismatch: true });
    const unknown = resolveExpiries(new Map([["2026-11-19", day("2026-11-19", 40)]]), "MONTH", 5).get("2026-11-19");
    expect(unknown).toEqual({ expiry: "2026-11-24", source: "calendar", calendar: "2026-11-24", mismatch: false });
  });

  it("statutory charge check: a known example", () => {
    // ₹1,00,000 premium turnover: buy = 20 + 35.03 + 0.10 + 3.00 + 18% × 55.13 = 68.05; sell = 20 + 35.03 + 0.10 + 100 + 9.92 = 165.05.
    expect(statutoryCharges("BUY", 100, 1_000)).toBeCloseTo(68.05, 2);
    expect(statutoryCharges("SELL", 100, 1_000)).toBeCloseTo(165.05, 2);
  });

  it("report figures: shadow trades excluded, drawdown and losing streak in time order, every session listed", () => {
    const make = (id: number, net: number, extra: Partial<AuditTrade> = {}): AuditTrade => ({
      id: `X:${id}`, date: id < 3 ? "2026-10-01" : "2026-10-02", index: "X", optionSymbol: "X", right: id % 2 ? "CE" : "PE", side: id % 2 ? "CALL" : "PUT", expiry: null, strike: 1, lotSize: 1, lots: 1, quantity: 100, lines: [], shadow: false,
      signalTime: id * 100, entryTime: id * 100 + 60, entryPremium: 100, targetPremium: 103, exitTime: id * 100 + 120, exitPremium: 100 + net / 100, exitReason: net > 0 ? "Target" : "Time limit", targetHit: net > 0,
      gross: net + 10, charges: 10, net, deployed: 10_000, returnPercent: net / 100, mfe: null, mae: null, mfePercent: null, maePercent: null, holdingMinutes: 10, flags: [], slippage: 10,
      evidence: { signalCandle: null, targetCandle: null, heldMinutes: 1, missingMinutes: 0, entryVolume: null }, timeline: [], ...extra,
    });
    const trades = [make(1, 300), make(2, -500), make(3, -200), make(4, 100), make(5, 999, { shadow: true })];
    const summary = summarize(trades, ["2026-10-01", "2026-10-02", "2026-10-05"], 100_000);
    expect([summary.trades, summary.wins, summary.losses, summary.net, summary.maxDrawdown, summary.maxConsecutiveLosses, summary.targetHits]).toEqual([4, 2, 2, -300, 700, 2, 2]);
    expect(summary.winRate).toBe(50);
    expect(summary.returnOnCapital).toBe(-0.3);
    expect(summary.returnOnDeployed).toBe(-0.75);
    expect(summary.daily.map((day) => [day.date, day.net, day.cumulative])).toEqual([["2026-10-01", -200, -200], ["2026-10-02", -100, -300], ["2026-10-05", 0, -300]]);
    const csv = auditCsv(trades.filter((trade) => !trade.shadow));
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(5);
    expect(csv).toContain("Data-quality flags");
    expect(csv.split("\r\n")[1].endsWith(",OK")).toBe(true);
  });
});
