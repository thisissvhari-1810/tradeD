import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { mayPractice } from "@/lib/auth/permissions";
import { kolkataParts } from "@/lib/market/clock";
import { findIndex } from "@/lib/market/indices";
import { sessionBounds } from "@/lib/options/replay-premium";
import { ROLLING_OFFSETS } from "@/lib/algo/expired-options";
import type { Candle } from "@/lib/algo/lines";
import {
  advanceH0H4, contractSymbol, createH0H4Session, fiveMinuteCandles, h0h4Report, H0H4_DEFAULTS, H0H4_KEY, H0H4_NAME, istMinute, isTerminal, niftyLotSize, progress,
  selectContract, sessionRow, tradeResult, unrealized, weeklyExpiryByRule, type Bar, type H0H4Contract, type H0H4Row, type H0H4State,
} from "@/lib/algo/fib-h0h4";
import type { SessionUser } from "@/server/auth";
import { sessionMinuteTape } from "@/server/market";
import { loadOptionChain } from "@/server/option-chain";
import { dhanExpiredOptions, dhanOptionSession } from "@/server/dhan-market";
import { configuredProvider, getHolidays } from "@/server/settings";

/**
 * H0–H4 Fibonacci Breakout (default 1-minute candles, high breaks, buy on the H4 touch) on the server: its own paper session (one per user per IST date), its own history and
 * its own saved backtests, all in AppSetting rows under "fibH0H4:" keys — no shared table, no Mathi state, no order ledger.
 * Paper only: a BUY / SELL is a record in this strategy's state; nothing is ever sent to a broker.
 *
 * Every tick: NIFTY spot 1-minute tape (Dhan) → engine; once ATM is known, the CE of the nearest listed weekly expiry from
 * the option chain → its 1-minute tape (Dhan) + a fresh bid/ask → engine. The engine only acts on completed
 * candles and keeps the last candle it processed, so repeated ticks, reconnects and restarts never repeat a signal.
 */

const KEY = (userId: string) => `fibH0H4:paper:${userId}`;
const BACKTESTS = (userId: string) => `fibH0H4:backtests:${userId}`;
const HISTORY_LIMIT = 260;
const QUOTE_MAX_AGE_SECONDS = 30;
/** Give up looking for the ATM contract after this (the levels need the contract's own candles from 09:15). */
const CONTRACT_DEADLINE = 10 * 60 + 15;

type PaperRecord = { enabled: boolean; startedAt: string | null; state: H0H4State | null; history: H0H4Row[]; days: Record<string, H0H4State>; problems: string[] };
const emptyRecord = (): PaperRecord => ({ enabled: false, startedAt: null, state: null, history: [], days: {}, problems: [] });

function assertAllowed(user: SessionUser) {
  if (!mayPractice(user) || user.status !== "ACTIVE") throw new AppError("Strategy paper trading is available on active practice accounts.", 403);
}

async function readRecord(userId: string) {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY(userId) } });
  const value = (row?.value ?? null) as Partial<PaperRecord> | null;
  return { record: { ...emptyRecord(), ...(value ?? {}) } as PaperRecord, updatedAt: row?.updatedAt ?? null };
}

/** Optimistic write: only if nobody else wrote since `updatedAt` (two ticks at once never both act). */
async function writeRecord(userId: string, record: PaperRecord, updatedAt: Date | null) {
  const value = JSON.parse(JSON.stringify(record));
  if (!updatedAt) {
    try {
      await prisma.appSetting.create({ data: { key: KEY(userId), value, updatedById: userId } });
      return true;
    } catch {
      return false;
    }
  }
  const result = await prisma.appSetting.updateMany({ where: { key: KEY(userId), updatedAt }, data: { value, updatedById: userId } });
  return result.count === 1;
}

const toBars = (candles: Candle[], date: string): Bar[] =>
  candles.filter((c) => new Date((c.time + 19_800) * 1000).toISOString().slice(0, 10) === date).map((c) => ({ t: Math.floor(istMinute(c.time) + 1e-9), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
const nowMinute = (date = new Date()) => { const p = kolkataParts(date); return p.hour * 60 + p.minute + date.getUTCSeconds() / 60; };
const isTradingDay = (date: string, holidays: string[]) => { const d = new Date(`${date}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6 && !holidays.includes(date); };

/** The ATM CE on the nearest listed weekly expiry, from the live option chain (null + why when unavailable). */
async function liveContract(strike: number): Promise<{ contract: H0H4Contract | null; why: string }> {
  const chain = await loadOptionChain("NIFTY", null);
  if (!chain.available || !chain.expiry) return { contract: null, why: chain.message || "option chain unavailable" };
  const row = chain.strikes.find((item) => item.strike === strike);
  const securityId = row?.ce?.securityId;
  if (!securityId) return { contract: null, why: `${strike} CE not in the ${chain.expiry} chain` };
  const lotSize = chain.lotSize ?? niftyLotSize(chain.expiry);
  return { contract: { underlying: "NIFTY", expiry: chain.expiry, strike, right: "CE", symbol: contractSymbol("NIFTY", chain.expiry, strike, "CE"), lotSize, securityId }, why: "" };
}

async function liveQuote(contract: H0H4Contract) {
  const chain = await loadOptionChain("NIFTY", contract.expiry).catch(() => null);
  const side = chain?.strikes.find((item) => item.strike === contract.strike)?.ce;
  if (!chain || !side) return null;
  const asOf = new Date(chain.asOf);
  if ((Date.now() - asOf.getTime()) / 1000 > QUOTE_MAX_AGE_SECONDS) return null;
  return { bid: side.bid ?? null, ask: side.ask ?? null, ltp: side.ltp ?? null, at: nowMinute(asOf) };
}

async function contractTape(contract: H0H4Contract, date: string) {
  const bounds = sessionBounds(date);
  if (!bounds || !contract.securityId) return [];
  return toBars(await dhanOptionSession(contract.securityId, "index", bounds.open, bounds.close), date);
}

/** Advances today's paper session as far as the market data allows and saves it (no-op when stopped). */
async function tick(userId: string, problems: string[] = []) {
  const { record, updatedAt } = await readRecord(userId);
  if (!record.enabled) return { record, ce: [] as Bar[], spot: [] as Bar[], quote: null as Awaited<ReturnType<typeof liveQuote>> };
  const today = kolkataParts(new Date()).dateKey;
  const holidays = await getHolidays();
  let changed = false;
  // A new date: archive the previous session (whatever state it reached), start a fresh one — nothing carries over.
  if (record.state && record.state.date !== today) {
    record.history = [sessionRow(record.state), ...record.history.filter((row) => row.date !== record.state!.date)].slice(0, HISTORY_LIMIT);
    record.days = Object.fromEntries([[record.state.date, record.state], ...Object.entries(record.days)].slice(0, 30));
    record.state = null;
    changed = true;
  }
  if (!record.state && isTradingDay(today, holidays)) { record.state = createH0H4Session(today); changed = true; }
  let ce: Bar[] = [];
  let spot: Bar[] = [];
  let quote: Awaited<ReturnType<typeof liveQuote>> = null;
  const state0 = record.state;
  if (state0 && !isTerminal(state0.phase)) {
    const now = nowMinute();
    if (configuredProvider() !== "dhan") problems.push("Market data provider is not Dhan: the strategy cannot read live 1-minute candles.");
    else if (now >= H0H4_DEFAULTS.sessionOpen + H0H4_DEFAULTS.candleMinutes) {
      try {
        spot = toBars(await sessionMinuteTape("NIFTY", today), today);
        let state = advanceH0H4(state0, { now, spot });
        if (state.phase === "SELECTING_ATM") {
          const found = await liveContract(state.strike!).catch((error: unknown) => ({ contract: null, why: error instanceof Error ? error.message : "option chain failed" }));
          if (found.contract || now >= CONTRACT_DEADLINE) state = selectContract(state, found.contract, now, found.why);
          else problems.push(`ATM CE not available yet (${found.why}); retrying.`);
        }
        if (state.contract && !isTerminal(state.phase)) {
          ce = await contractTape(state.contract, today);
          const needQuote = ["WAITING_FOR_H4_BREAK", "ENTRY_PENDING", "POSITION_OPEN"].includes(state.phase);
          quote = needQuote ? await liveQuote(state.contract) : null;
          state = advanceH0H4(state, { now, spot, ce, quote }, H0H4_DEFAULTS);
        }
        if (state !== state0) { record.state = state; changed = true; }
      } catch (error) {
        problems.push(`Market data unavailable: ${error instanceof Error ? error.message : "request failed"}. The session state is unchanged.`);
      }
    }
  } else if (state0?.contract && isTerminal(state0.phase)) {
    ce = await contractTape(state0.contract, state0.date).catch(() => []);
  }
  record.problems = problems;
  if (changed) {
    const ok = await writeRecord(userId, record, updatedAt);
    if (!ok) return { ...(await readBack(userId)), ce, spot, quote };
  }
  return { record, ce, spot, quote };
}
const readBack = async (userId: string) => ({ record: (await readRecord(userId)).record });

function view(record: PaperRecord, extra: { ce: Bar[]; spot: Bar[]; quote: Awaited<ReturnType<typeof liveQuote>> }) {
  const state = record.state;
  const ce5 = fiveMinuteCandles(extra.ce, 24 * 60).candles;
  const lastCe = extra.ce.at(-1)?.close ?? null;
  const ltp = extra.quote?.ltp ?? lastCe;
  return {
    name: H0H4_NAME, key: H0H4_KEY, mode: "PAPER" as const, liveOrders: false as const, settings: H0H4_DEFAULTS,
    enabled: record.enabled, startedAt: record.startedAt, problems: record.problems,
    state, progress: state ? progress(state) : [], row: state ? sessionRow(state) : null, trade: state ? tradeResult(state) : null,
    ltp, unrealized: state && !state.exit ? unrealized(state, extra.quote?.bid ?? ltp) : null,
    spotLast: extra.spot.at(-1)?.close ?? null, candleTime: ce5.at(-1)?.t ?? null,
    candles: ce5, history: record.history.slice(0, 120),
  };
}
export type H0H4View = ReturnType<typeof view>;

export async function h0h4View(user: SessionUser) {
  assertAllowed(user);
  const result = await tick(user.id);
  return view(result.record, result);
}

/** Server scheduler (cron): ticks every user whose paper session is switched on, independently of open pages. */
export async function tickAllH0H4() {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: "fibH0H4:paper:" } }, select: { key: true, value: true } });
  const checks: { user: string; phase: string | null; problems: string[] }[] = [];
  for (const row of rows) {
    if (!(row.value as Partial<PaperRecord> | null)?.enabled) continue;
    const userId = row.key.slice("fibH0H4:paper:".length);
    const result = await tick(userId).catch((error: unknown) => ({ record: { ...emptyRecord(), problems: [error instanceof Error ? error.message : "tick failed"] } as PaperRecord }));
    checks.push({ user: userId, phase: result.record.state?.phase ?? null, problems: result.record.problems });
  }
  return { ran: checks.length, checks };
}

export async function h0h4Command(user: SessionUser, op: "start" | "stop" | "tick") {
  assertAllowed(user);
  if (op === "tick") return h0h4View(user);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { record, updatedAt } = await readRecord(user.id);
    record.enabled = op === "start";
    record.startedAt = op === "start" ? new Date().toISOString() : record.startedAt;
    if (await writeRecord(user.id, record, updatedAt)) return h0h4View(user);
  }
  throw new AppError("The strategy state changed at the same time. Retry.", 409);
}

/** A saved session (from this strategy's own paper history) with its CE candles for the chart. */
export async function h0h4Day(user: SessionUser, date: string) {
  assertAllowed(user);
  const { record } = await readRecord(user.id);
  const state = record.state?.date === date ? record.state : record.days[date] ?? null;
  if (!state) throw new AppError("No paper session saved for that date.", 404);
  const ce = state.contract ? await contractTape(state.contract, date).catch(() => []) : [];
  return { state, row: sessionRow(state), progress: progress(state), trade: tradeResult(state), candles: fiveMinuteCandles(ce, 24 * 60).candles };
}

/* ---------------- historical backtest (Dhan expired weekly options) ---------------- */

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Backtests a past date range (≤ 31 days) on real premiums: NIFTY 1-minute candles per day, and the expired weekly options
 * (Dhan rolling ATM ± 10, regrouped per strike) for the ATM CE that day. The expiry is the NSE weekly rule. A day whose
 * strike or premiums are missing is recorded as skipped with the reason — never filled in. Saved under this strategy only.
 */
export async function h0h4Backtest(user: SessionUser, from: string, to: string) {
  assertAllowed(user);
  const today = kolkataParts(new Date()).dateKey;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new AppError("Choose a valid date range.", 400);
  if (to >= today) throw new AppError("Backtests run on past sessions only (today is paper trading).", 400);
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 31) throw new AppError("Up to 31 days per run (the data API's range limit). The 5-year result is in scripts/backtest-fib-h0h4.ts.", 400);
  if (configuredProvider() !== "dhan") throw new AppError("Historical premiums need the Dhan data connection.", 400);
  const holidays = await getHolidays();
  const dates: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) if (isTradingDay(day, holidays)) dates.push(day);
  const index = findIndex("NIFTY");
  if (!index) throw new AppError("NIFTY is not configured.", 500);
  const tapes = await dhanExpiredOptions(Number(index.id), from, addDays(to, 1), ROLLING_OFFSETS, "WEEK");
  const states: H0H4State[] = [];
  const notes: string[] = [];
  for (const date of dates) {
    const spot = toBars(await sessionMinuteTape("NIFTY", date).catch(() => []), date);
    let state = advanceH0H4(createH0H4Session(date), { now: 24 * 60, spot });
    if (state.phase === "SELECTING_ATM") {
      const strike = state.strike!;
      const expiry = weeklyExpiryByRule(date, holidays);
      const tape = tapes.get(date)?.get(`CE:${strike}`) ?? [];
      const at = H0H4_DEFAULTS.sessionOpen + H0H4_DEFAULTS.candleMinutes;
      if (!tape.length) {
        state = selectContract(state, null, at, `no expired-option history for ${strike} CE on ${date}`);
        notes.push(`${date}: no premium history for ${strike} CE.`);
      } else {
        state = selectContract(state, { underlying: "NIFTY", expiry, strike, right: "CE", symbol: contractSymbol("NIFTY", expiry, strike, "CE"), lotSize: niftyLotSize(expiry) }, at);
        state = advanceH0H4(state, { now: 24 * 60, spot, ce: toBars(tape, date) });
      }
    }
    states.push(state);
  }
  const report = h0h4Report(states);
  const run = { id: `${from}_${to}_${Date.now().toString(36)}`, from, to, createdAt: new Date().toISOString(), report, sessions: states.map((state) => sessionRow(state)), notes, assumptions: BACKTEST_ASSUMPTIONS };
  const row = await prisma.appSetting.findUnique({ where: { key: BACKTESTS(user.id) } });
  const saved = Array.isArray(row?.value) ? (row!.value as unknown[]) : [];
  await prisma.appSetting.upsert({ where: { key: BACKTESTS(user.id) }, create: { key: BACKTESTS(user.id), value: JSON.parse(JSON.stringify([run])), updatedById: user.id }, update: { value: JSON.parse(JSON.stringify([run, ...saved].slice(0, 10))), updatedById: user.id } });
  return run;
}

export async function h0h4Backtests(user: SessionUser) {
  assertAllowed(user);
  const row = await prisma.appSetting.findUnique({ where: { key: BACKTESTS(user.id) } });
  return Array.isArray(row?.value) ? row!.value : [];
}

export const BACKTEST_ASSUMPTIONS = [
  `${H0H4_DEFAULTS.candleMinutes}-minute candles from the exchange 1-minute candles; only completed candles set levels. A level is broken when a later candle's HIGH goes above it.`,
  "ATM = NIFTY first-candle close rounded to 50 (half up); nearest weekly expiry by the NSE rule; 1 lot (dated lot size).",
  "BUY: stop order one tick above H4, filled when a later 1-minute bar trades through it (+2 ticks; at the open when a bar opens above it); not executed if at/above Fib 0.618.",
  "SELL: resting order at Fib 0.618 rounded up to the tick, filled only when a traded bar goes one tick through it; else square-off 15:29 (open − 2 ticks).",
  "Charges: ₹20 per order + dated STT, NSE, SEBI, stamp duty and GST.",
];

/** The 5-year baseline written by scripts/backtest-fib-h0h4.ts (read-only; FIB_H0H4_RESULTS overrides the path). */
export async function h0h4Baseline() {
  const file = process.env.FIB_H0H4_RESULTS || path.join(process.cwd(), ".backtests", "fib-h0h4", "latest.json");
  try {
    return { report: JSON.parse(await readFile(file, "utf8")), reason: null };
  } catch {
    return { report: null, reason: "No 5-year baseline on this server yet: run `npx tsx scripts/backtest-fib-h0h4.ts --data <export folder>`." };
  }
}
