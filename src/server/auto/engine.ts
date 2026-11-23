/**
 * Automated multi-strategy PAPER trading engine. Nothing here talks to a broker's order API: every fill is simulated
 * on the live option quote and stored in the Auto* tables.
 *
 * A scheduler calls autoTick() every 30 s (GET /api/auto/cron); each call is one stateless pass:
 *  1. Session check (weekend / exchange holiday / hours) and a database lease, so two passes never overlap.
 *  2. Daily wallets: every strategy starts each trading day with a fresh ₹20,000 (AutoDay, unique per strategy + date).
 *  3. Shared market data, read once for all strategies: NIFTY's completed 1-minute candles, India VIX when a rule needs
 *     it, the NIFTY option chain (bid / ask, nearest weekly expiry) and the open contracts' own 1-minute candles.
 *  4. The 8 strategies run independently (Promise.allSettled): one failing never blocks another. Each one manages its
 *     open position first (exit rules on completed option candles, sold at the live bid), then looks for an entry with
 *     its own ported rules (src/lib/auto/rules.ts), sized from its own wallet, bought at the live ask.
 *  5. Every order and position change is one database transaction keyed by strategy + date + trade number, so a
 *     repeated or overlapping pass can never fill twice; an open position is recovered from the database on every pass.
 *  6. After 15:35 each day is closed and the daily report written.
 */
import { prisma } from "@/lib/prisma";
import { kolkataParts } from "@/lib/market/clock";
import { describeSession } from "@/lib/trading/replay-engine";
import { optionCharges } from "@/lib/options/engine";
import { getHolidays } from "@/server/settings";
import { getS1Data, sessionMinuteTape } from "@/server/market";
import { loadOptionChain, type OptionChainView } from "@/server/option-chain";
import { dhanOptionSession } from "@/server/dhan-market";
import {
  clock, eventOn, m1315Decision, monwedDecision, MONWED_BUY, MONWED_TARGET, r2, secondHourDecision, sensexExpiry, SQ, TICK,
  type Bar, type Decision, type Minutes, type Right,
} from "@/lib/auto/rules";
import { lotsFor, newTarget, newTrail, targetStep, trailStep, trailStopLevel, type ExitHit, type TargetState, type TrailState } from "@/lib/auto/exits";
import { AUTO_STRATEGIES, DAY_CAPITAL_PAISE, MONWED_EVENTS_DEFAULT, MONWED_EVENTS_KEY, type AutoStrategyDef, type MonWedEvents } from "@/lib/auto/strategies";

export const ENGINE_ID = "main";
export const ENGINE_DEFAULTS = { slippage: 0.05, quoteMaxAgeSec: 30, signalMaxAgeSec: 180, dataStaleSec: 150, exitQuoteWaitSec: 120 };
const IST = 19_800;
const PREP_MINUTE = 9 * 60;
const CLOSE_MINUTE = 15 * 60 + 35;
const LAST_MINUTE = 15 * 60 + 50;

const paise = (rupees: number) => Math.round(rupees * 100);
const rupees = (value: number) => value / 100;
const chargesPaise = (side: "BUY" | "SELL", premium: number, qty: number) => Number(optionCharges(side, BigInt(paise(premium)), qty).total);
export const istMinuteOf = (unix: number) => Math.floor((((unix + IST) % 86_400) + 86_400) % 86_400 / 60);
export const unixOf = (date: string, minute: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 1000 - IST + minute * 60;
};

type TradeState = { kind: "trail"; trail: TrailState; fromMinute: number; exitSince?: number } | { kind: "target"; target: TargetState; fromMinute: number; exitSince?: number };
type DayState = { lastExitMinute?: number; lastNote?: string };
type EventInput = { strategyKey?: string; level: "INFO" | "WARN" | "ERROR"; kind: "SIGNAL" | "ORDER" | "EXIT" | "SKIP" | "DATA" | "SYSTEM"; message: string; data?: unknown };

type Ctx = {
  date: string;
  now: Date;
  nowSec: number;
  minute: number;
  open: number;
  close: number;
  n: Minutes;
  lastBarAge: number | null;
  stale: boolean;
  prevClose: number | null;
  holidays: string[];
  config: typeof ENGINE_DEFAULTS;
  entriesOn: boolean;
  mode: string;
  vix: () => Promise<Map<number, number>>;
  chain: () => Promise<OptionChainView | null>;
  optionBars: (securityId: string) => Promise<Map<number, Bar>>;
  events: EventInput[];
};

function memo<T>(load: () => Promise<T>) {
  let value: Promise<T> | null = null;
  return () => (value ??= load());
}

function minutesOf(tape: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>, nowSec: number): Minutes {
  const out: Minutes = new Map();
  for (const bar of tape) if (bar.time + 60 <= nowSec) out.set(istMinuteOf(bar.time), { o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume ?? 0 });
  return out;
}

const isTradingDay = (day: string, holidays: string[]) => {
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.includes(day);
};
const nextSession = (day: string, holidays: string[]) => {
  const d = new Date(`${day}T00:00:00Z`);
  for (let i = 0; i < 10; i += 1) {
    d.setUTCDate(d.getUTCDate() + 1);
    const key = d.toISOString().slice(0, 10);
    if (isTradingDay(key, holidays)) return key;
  }
  return null;
};

export async function engineRow() {
  return prisma.autoEngine.upsert({ where: { id: ENGINE_ID }, update: {}, create: { id: ENGINE_ID, enabled: true, mode: "PAPER", config: ENGINE_DEFAULTS } });
}

export async function ensureStrategies() {
  const rows = await prisma.autoStrategy.findMany();
  const have = new Set(rows.map((row) => row.key));
  const missing = AUTO_STRATEGIES.filter((def) => !have.has(def.key));
  if (missing.length) await prisma.autoStrategy.createMany({ data: missing.map((def) => ({ key: def.key, name: def.name, position: AUTO_STRATEGIES.indexOf(def) })), skipDuplicates: true });
  return prisma.autoStrategy.findMany({ orderBy: { position: "asc" } });
}

async function ensureDays(date: string) {
  await prisma.autoDay.createMany({
    data: AUTO_STRATEGIES.map((def) => ({ strategyKey: def.key, date, openingPaise: DAY_CAPITAL_PAISE, availablePaise: DAY_CAPITAL_PAISE, state: {} })),
    skipDuplicates: true,
  });
}

async function monwedEvents(): Promise<MonWedEvents> {
  const row = await prisma.appSetting.findUnique({ where: { key: MONWED_EVENTS_KEY } });
  const value = row?.value as Partial<MonWedEvents> | undefined;
  const list = (name: keyof MonWedEvents) => (Array.isArray(value?.[name]) ? (value![name] as string[]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : MONWED_EVENTS_DEFAULT[name]);
  return { rbi: list("rbi"), fomc: list("fomc"), election: list("election"), budget: list("budget"), tariff: list("tariff") };
}

/** One engine pass. Safe to call any time: outside the session it only records the heartbeat. */
export async function autoTick(now = new Date()) {
  const started = Date.now();
  const ist = kolkataParts(now);
  const date = ist.dateKey;
  const minute = ist.hour * 60 + ist.minute;
  const engine = await engineRow();
  const holidays = await getHolidays();
  const session = describeSession(date, holidays, date);
  const beat = async (lastTick: Record<string, unknown>) => {
    await prisma.autoEngine.update({ where: { id: ENGINE_ID }, data: { heartbeatAt: now, lastTick: { ...lastTick, at: now.toISOString(), ms: Date.now() - started } as object } });
  };
  if (!session.ok) {
    await beat({ status: "CLOSED", message: session.message });
    return { status: "CLOSED", message: session.message };
  }
  if (minute < PREP_MINUTE || minute > LAST_MINUTE) {
    await beat({ status: "OUTSIDE_HOURS", message: `Market session ${date}: the engine works 09:00–15:50 IST.` });
    return { status: "OUTSIDE_HOURS" };
  }

  // Lease: one pass at a time (a pass that dies releases it after 55 s).
  const leaseId = `${process.pid}-${started}`;
  const got = await prisma.autoEngine.updateMany({ where: { id: ENGINE_ID, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseId, leaseUntil: new Date(now.getTime() + 55_000) } });
  if (!got.count) return { status: "BUSY" };
  const events: EventInput[] = [];
  const results: Record<string, unknown> = {};
  let dataAge: number | null = null;
  let stale = false;
  try {
    const strategies = await ensureStrategies();
    await ensureDays(date);
    const config = { ...ENGINE_DEFAULTS, ...((engine.config as object | null) ?? {}) };
    if (minute < 555) {
      await beat({ status: "PREPARING", message: "Wallets ready; monitoring starts at 09:15." });
      return { status: "PREPARING" };
    }
    // A day already closed for lack of market data (holiday or feed outage) needs nothing more.
    const openDays = await prisma.autoDay.count({ where: { date, status: { not: "CLOSED" } } });
    const openTrades = await prisma.autoTrade.count({ where: { date, status: { in: ["OPEN", "EXITING"] } } });
    if (!openDays && !openTrades) {
      await beat({ status: "DAY_CLOSED", message: `Session ${date} is closed.` });
      return { status: "DAY_CLOSED" };
    }
    const nowSec = Math.floor(now.getTime() / 1000);
    const tape = await sessionMinuteTape("NIFTY", date).catch((error: unknown) => {
      events.push({ level: "ERROR", kind: "DATA", message: `NIFTY candles could not be loaded: ${error instanceof Error ? error.message : "unknown"}` });
      return [];
    });
    const n = minutesOf(tape, nowSec);
    const last = tape.filter((bar) => bar.time + 60 <= nowSec).at(-1);
    dataAge = last ? nowSec - (last.time + 60) : null;
    stale = minute < SQ && (dataAge == null || dataAge > config.dataStaleSec);
    // No NIFTY candle at all by 09:30: an exchange holiday missing from the holiday list, or a feed outage. Close the
    // day once (nothing can have traded) instead of checking every 30 s.
    if (!n.size && minute >= 570 && !openTrades) {
      await prisma.autoDay.updateMany({ where: { date, status: { not: "CLOSED" } }, data: { status: "CLOSED", note: "No market data today (exchange holiday or feed outage): nothing traded.", closedAt: now } });
      events.push({ level: "WARN", kind: "DATA", message: `No NIFTY candles for ${date} by 09:30: the day was closed without trading (holiday or feed outage).` });
      if (!(await prisma.autoReport.findUnique({ where: { date } }))) await prisma.autoReport.create({ data: { date, report: (await buildReport(date)) as object } });
      return { status: "NO_SESSION", date };
    }
    if (stale && minute % 5 === 0) events.push({ level: "WARN", kind: "DATA", message: `NIFTY data is stale (${dataAge == null ? "no candles" : `last candle closed ${dataAge} s ago`}): new entries are suspended; open positions are still managed.` });
    const prevClose = await getS1Data("NIFTY", date).then((data) => data.previous?.close ?? null).catch(() => null);
    const ctx: Ctx = {
      date, now, nowSec, minute, open: session.open, close: session.close, n, lastBarAge: dataAge, stale, prevClose, holidays, config,
      entriesOn: engine.enabled, mode: engine.mode,
      vix: memo(async () => minutesToVix(minutesOf(await sessionMinuteTape("INDIAVIX", date).catch(() => []), nowSec))),
      chain: memo(async () => loadOptionChain("NIFTY", null).catch((error: unknown) => {
        events.push({ level: "ERROR", kind: "DATA", message: `Option chain unavailable: ${error instanceof Error ? error.message : "unknown"}` });
        return null;
      })),
      optionBars: (() => {
        const cache = new Map<string, Promise<Map<number, Bar>>>();
        return (id: string) => {
          if (!cache.has(id)) cache.set(id, dhanOptionSession(id, "index", session.open, session.close).then((bars) => minutesOf(bars, nowSec)).catch(() => new Map()));
          return cache.get(id)!;
        };
      })(),
      events,
    };
    const settled = await Promise.allSettled(AUTO_STRATEGIES.map((def) => runStrategy(ctx, def, strategies.find((row) => row.key === def.key)!)));
    settled.forEach((result, index) => {
      const key = AUTO_STRATEGIES[index].key;
      if (result.status === "fulfilled") results[key] = result.value;
      else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        results[key] = { error: message };
        events.push({ strategyKey: key, level: "ERROR", kind: "SYSTEM", message: `Worker error: ${message}` });
      }
    });
    await Promise.all(AUTO_STRATEGIES.map((def, index) => prisma.autoStrategy.update({
      where: { key: def.key },
      data: { lastRunAt: now, lastError: settled[index].status === "rejected" ? String((settled[index] as PromiseRejectedResult).reason).slice(0, 500) : null },
    })));
    if (minute >= CLOSE_MINUTE) await closeDay(date, events);
    return { status: "OK", date, minute: clock(minute), dataAgeSec: dataAge, stale, strategies: results };
  } finally {
    if (events.length) await prisma.autoEvent.createMany({ data: events.map((event) => ({ date, strategyKey: event.strategyKey ?? null, level: event.level, kind: event.kind, message: event.message.slice(0, 1000), data: (event.data ?? undefined) as object | undefined })) }).catch(() => undefined);
    await beat({ status: "RUNNING", dataAgeSec: dataAge, stale, strategies: results, errors: events.filter((e) => e.level === "ERROR").map((e) => e.message).slice(0, 10) }).catch(() => undefined);
    await prisma.autoEngine.updateMany({ where: { id: ENGINE_ID, leaseId }, data: { leaseId: null, leaseUntil: null } });
  }
}

function minutesToVix(bars: Minutes) {
  const out = new Map<number, number>();
  for (const [m, bar] of bars) out.set(m, bar.c);
  return out;
}

// ─────────────────────────────── one strategy ───────────────────────────────

async function runStrategy(ctx: Ctx, def: AutoStrategyDef, row: { enabled: boolean; paused: boolean }) {
  const day = await prisma.autoDay.findUniqueOrThrow({ where: { strategyKey_date: { strategyKey: def.key, date: ctx.date } } });
  const open = await prisma.autoTrade.findFirst({ where: { strategyKey: def.key, date: ctx.date, status: { in: ["OPEN", "EXITING"] } } });
  if (open) return manage(ctx, def, open);
  if (["NO_TRADE", "DONE", "CLOSED"].includes(day.status)) return { status: day.status, note: day.note };
  if (ctx.minute >= SQ) return setDay(def.key, ctx.date, "DONE", "Session over: no new entries after 15:20.");
  const closed = await prisma.autoTrade.findMany({ where: { strategyKey: def.key, date: ctx.date }, orderBy: { tradeNo: "asc" } });
  const signals = await prisma.autoSignal.findMany({ where: { strategyKey: def.key, date: ctx.date } });
  const tradeNo = Math.max(closed.length, signals.length) + 1;
  if (tradeNo > def.maxTrades) return setDay(def.key, ctx.date, "DONE", `Done for the day (${def.maxTrades} trade${def.maxTrades > 1 ? "s" : ""} max).`);
  // A skipped (not traded) signal ends the day: the next trade in the backtest only follows a trade that was taken.
  if (signals.some((s) => s.status !== "TRADED")) return setDay(def.key, ctx.date, "DONE", signals.find((s) => s.status !== "TRADED")!.reason || "Signal not traded.");
  if (!row.enabled) return setDay(def.key, ctx.date, day.status === "IN_TRADE" ? "WATCHING" : day.status, "Strategy disabled: no new entries.");
  if (row.paused) return setDay(def.key, ctx.date, day.status === "IN_TRADE" ? "WATCHING" : day.status, "Paused: no new entries.");
  if (!ctx.entriesOn) return setDay(def.key, ctx.date, day.status, "Master engine OFF: no new entries.");
  if (ctx.stale) return { status: day.status, note: "Market data stale: entries suspended." };
  const afterExit = tradeNo > 1 ? ((closed.at(-1)?.exitModel as { minute?: number } | null)?.minute ?? null) : null;
  if (tradeNo > 1 && afterExit == null) return { status: day.status, note: "Waiting for trade 1 to close." };

  const decision = await decideFor(ctx, def, afterExit);
  if (decision.kind === "WAIT") return setDay(def.key, ctx.date, "WATCHING", decision.note);
  if (decision.kind === "SKIP") return setDay(def.key, ctx.date, tradeNo === 1 ? "NO_TRADE" : "DONE", tradeNo === 1 ? `No trade today: ${decision.reason}.` : `No trade 2: ${decision.reason}.`);
  return enter(ctx, def, tradeNo, decision, day.availablePaise);
}

type Entry = Extract<Decision, { kind: "SIGNAL" }> & { weak?: boolean; buyMinute: number };

async function decideFor(ctx: Ctx, def: AutoStrategyDef, afterExit: number | null): Promise<{ kind: "WAIT"; note: string } | { kind: "SKIP"; reason: string } | Entry> {
  const now = ctx.minute;
  if (def.family === "second_hour") {
    // Day-to-expiry only matters for trade 2 (no trade 2 on expiry day); the chain says which expiry is nearest.
    const dte = afterExit != null ? await ctx.chain().then((chain) => (chain?.expiry ? (chain.expiry === ctx.date ? 0 : 1) : null)) : null;
    const d = secondHourDecision(ctx.n, { date: ctx.date, prevClose: ctx.prevClose, daysToExpiry: dte }, def.secondHour!, now, afterExit);
    return d.kind === "SIGNAL" ? { ...d, buyMinute: d.sig.conf + 1 } : d;
  }
  if (def.family === "m1315") {
    if (now < 796) return { kind: "WAIT", note: "Waiting for the 13:15 candle." };
    const d = m1315Decision(ctx.n, await ctx.vix(), { date: ctx.date, prevClose: ctx.prevClose, daysToExpiry: null }, def.m1315!, now, afterExit);
    return d.kind === "SIGNAL" ? { ...d, buyMinute: d.sig.conf + 1 } : d;
  }
  if (now < MONWED_BUY) return { kind: "WAIT", note: "Waiting for 10:15." };
  const chain = await ctx.chain();
  if (!chain?.expiry) return { kind: "WAIT", note: "Waiting for the option chain (expiry check)." };
  const events = await monwedEvents();
  const cal = {
    niftyExpiry: chain.expiry === ctx.date,
    sensexExpiry: sensexExpiry(ctx.date, (day) => isTradingDay(day, ctx.holidays)),
    event: eventOn(ctx.date, events, (day) => nextSession(day, ctx.holidays)),
  };
  const d = monwedDecision(ctx.n, await ctx.vix(), { date: ctx.date, prevClose: ctx.prevClose, daysToExpiry: null }, cal, now);
  if (d.kind !== "PLAN") return d;
  const p = d.plan;
  const sig = { side: p.right === "CE" ? "CALL" : "PUT", level: p.close, brk: MONWED_BUY - 1, conf: MONWED_BUY - 1, firstClose: p.close, confClose: p.close } as const;
  return { kind: "SIGNAL", sig: { ...sig }, right: p.right, flip: false, strike: p.strike, vix: p.vix, note: `gap ${p.gap.toFixed(2)}%${p.weak ? ", weak entry: 1 lot" : ""}`, weak: p.weak, buyMinute: MONWED_BUY };
}

async function setDay(key: string, date: string, status: string, note: string) {
  await prisma.autoDay.updateMany({ where: { strategyKey: key, date, OR: [{ status: { not: status } }, { note: { not: note } }] }, data: { status, note } });
  return { status, note };
}

/** Records a signal that will not be traded (and why), once. */
async function skipSignal(ctx: Ctx, def: AutoStrategyDef, tradeNo: number, d: Entry, reason: string, detail: Record<string, unknown> = {}) {
  try {
    await prisma.$transaction([
      prisma.autoSignal.create({ data: signalRow(ctx, def, tradeNo, d, "SKIPPED", reason, detail) }),
      prisma.autoDay.update({ where: { strategyKey_date: { strategyKey: def.key, date: ctx.date } }, data: { skipped: { increment: 1 }, status: "DONE", note: `Signal skipped: ${reason}` } }),
    ]);
    ctx.events.push({ strategyKey: def.key, level: "WARN", kind: "SKIP", message: `Trade ${tradeNo} ${d.right} ${d.strike} skipped: ${reason}`, data: detail });
  } catch {
    /* already recorded by an earlier pass */
  }
  return { status: "DONE", note: `Signal skipped: ${reason}` };
}

function signalRow(ctx: Ctx, def: AutoStrategyDef, tradeNo: number, d: Entry, status: string, reason: string, detail: Record<string, unknown>) {
  const candles = [d.sig.brk - 2, d.sig.brk - 1, d.sig.brk, d.sig.conf].filter((m, i, all) => all.indexOf(m) === i).map((m) => ({ minute: clock(m), ...(ctx.n.get(m) ?? {}) }));
  return {
    strategyKey: def.key, date: ctx.date, tradeNo, status, side: d.sig.side, right: d.right, strike: d.strike,
    breakoutMinute: d.sig.brk, confirmMinute: d.sig.conf, level: d.sig.level, nifty: d.sig.confClose, vix: d.vix ?? null, reason,
    detail: { note: d.note, flip: d.flip, candles, ...detail } as object, signalAt: new Date(unixOf(ctx.date, d.buyMinute) * 1000),
  };
}

async function enter(ctx: Ctx, def: AutoStrategyDef, tradeNo: number, d: Entry, availablePaise: number) {
  const readyAt = unixOf(ctx.date, d.buyMinute);
  const age = ctx.nowSec - readyAt;
  if (age > ctx.config.signalMaxAgeSec) return skipSignal(ctx, def, tradeNo, d, `signal seen ${age} s after its candle closed (data or scheduler delay; limit ${ctx.config.signalMaxAgeSec} s)`);
  const chain = await ctx.chain();
  if (!chain?.available || !chain.expiry || !chain.lotSize) return { status: "WATCHING", note: "Signal: waiting for the option chain." };
  const row = chain.strikes.find((item) => item.strike === d.strike);
  const side = d.right === "CE" ? row?.ce : row?.pe;
  const quoteAge = (ctx.now.getTime() - new Date(chain.asOf).getTime()) / 1000;
  if (!side?.securityId) return skipSignal(ctx, def, tradeNo, d, `${d.strike} ${d.right} is not on the option chain`);
  if (!(side.ask && side.ask > 0) || quoteAge > ctx.config.quoteMaxAgeSec) {
    return age > ctx.config.signalMaxAgeSec - 30 ? skipSignal(ctx, def, tradeNo, d, "no fresh ask quote for the contract") : { status: "WATCHING", note: "Signal: waiting for a fresh quote." };
  }
  const price = r2(side.ask + ctx.config.slippage);
  if (d.maxBuy != null && price >= d.maxBuy) return skipSignal(ctx, def, tradeNo, d, `trade-2 option costs ₹${price} (rule: below ₹${d.maxBuy})`);
  if (ctx.mode === "SHADOW") {
    await prisma.autoSignal.create({ data: signalRow(ctx, def, tradeNo, d, "SHADOW", `shadow mode: would buy at ₹${price}`, { ask: side.ask, bid: side.bid }) }).catch(() => undefined);
    return setDay(def.key, ctx.date, "DONE", `Shadow signal: ${d.right} ${d.strike} at ₹${price} (not traded).`);
  }
  const lot = chain.lotSize;
  const capital = Math.min(DAY_CAPITAL_PAISE, availablePaise);
  let lots = lotsFor(price, lot, rupees(capital), (p, q) => rupees(chargesPaise("BUY", p, q)));
  if (d.weak) lots = Math.min(1, lots);
  if (lots < 1) return skipSignal(ctx, def, tradeNo, d, `1 lot costs ₹${Math.round(price * lot).toLocaleString("en-IN")} + charges, more than the ₹${Math.round(rupees(capital)).toLocaleString("en-IN")} available`);
  const qty = lots * lot;
  const entryCh = chargesPaise("BUY", price, qty);
  const invested = paise(price) * qty;
  const state: TradeState = def.family === "monwed"
    ? { kind: "target", target: newTarget(price, MONWED_TARGET), fromMinute: MONWED_BUY }
    : { kind: "trail", trail: newTrail(price, tradeNo === 2 ? def.lockPct : null), fromMinute: d.buyMinute };
  const target = state.kind === "target" ? state.target.target : state.trail.start;
  const symbol = `NIFTY ${chain.expiry} ${d.strike} ${d.right}`;
  try {
    await prisma.$transaction(async (tx) => {
      const sigRow = await tx.autoSignal.create({ data: signalRow(ctx, def, tradeNo, d, "TRADED", d.note, { ask: side.ask, bid: side.bid, quoteAsOf: chain.asOf, expiry: chain.expiry }) });
      const trade = await tx.autoTrade.create({
        data: {
          strategyKey: def.key, date: ctx.date, tradeNo, status: "OPEN", side: d.sig.side, right: d.right, strike: d.strike, expiry: chain.expiry!, securityId: side.securityId!, symbol,
          lotSize: lot, lots, quantity: qty, signalAt: sigRow.signalAt, entryAt: ctx.now, entryPaise: paise(price), entryBidPaise: side.bid != null ? paise(side.bid) : null, entryAskPaise: paise(side.ask!),
          entryChargesPaise: entryCh, investedPaise: invested, latencyMs: Math.max(0, ctx.now.getTime() - readyAt * 1000), state: state as object, targetPaise: paise(target), lastPaise: paise(side.ltp ?? price), lastAt: ctx.now,
          notes: d.note,
        },
      });
      await tx.autoOrder.create({ data: { idempotencyKey: `${def.key}:${ctx.date}:T${tradeNo}:BUY`, strategyKey: def.key, date: ctx.date, tradeId: trade.id, side: "BUY", status: "FILLED", quantity: qty, pricePaise: paise(price), bidPaise: side.bid != null ? paise(side.bid) : null, askPaise: paise(side.ask!), quoteAt: new Date(chain.asOf), chargesPaise: entryCh, requestedAt: ctx.now, filledAt: ctx.now } });
      const day = await tx.autoDay.update({
        where: { strategyKey_date: { strategyKey: def.key, date: ctx.date } },
        data: { availablePaise: { decrement: invested + entryCh }, investedPaise: { increment: invested }, chargesPaise: { increment: entryCh }, trades: { increment: 1 }, status: "IN_TRADE", note: `Trade ${tradeNo}: bought ${lots} lot${lots > 1 ? "s" : ""} of ${symbol} at ₹${price}.` },
      });
      if (day.availablePaise < 0) throw new Error("Capital check failed: the wallet would go negative.");
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { status: "IN_TRADE", note: "Already entered by another pass." };
    throw error;
  }
  ctx.events.push({ strategyKey: def.key, level: "INFO", kind: "ORDER", message: `Trade ${tradeNo}: BUY ${qty} ${symbol} at ₹${price} (ask ${side.ask}, signal ${clock(d.sig.conf)} close, ${Math.round(age)} s after the candle).`, data: { tradeNo, price, qty, lots } });
  await prisma.autoStrategy.update({ where: { key: def.key }, data: { lastSignal: { at: ctx.now.toISOString(), tradeNo, right: d.right, strike: d.strike, minute: clock(d.sig.conf) } } });
  return { status: "IN_TRADE", note: `Bought ${symbol} at ₹${price}` };
}

// ─────────────────────────────── open position ───────────────────────────────

type OpenTrade = NonNullable<Awaited<ReturnType<typeof prisma.autoTrade.findFirst>>>;

async function manage(ctx: Ctx, def: AutoStrategyDef, trade: OpenTrade) {
  const state = trade.state as TradeState;
  const bars = await ctx.optionBars(trade.securityId);
  let hit: ExitHit | null = (trade.exitModel as ExitHit | null) ?? null;
  if (!hit) {
    for (const m of [...bars.keys()].filter((k) => k >= state.fromMinute).sort((a, b) => a - b)) {
      const bar = bars.get(m)!;
      hit = state.kind === "trail" ? trailStep(state.trail, m, bar) : targetStep(state.target, m, bar);
      if (hit) break;
    }
  }
  if (!hit && ctx.minute >= SQ) {
    const last = [...bars.entries()].filter(([m]) => m < SQ).sort((a, b) => a[0] - b[0]).at(-1);
    hit = { minute: SQ, price: r2(Math.max(TICK, (last?.[1].c ?? rupees(trade.lastPaise ?? trade.entryPaise)) - (state.kind === "trail" ? TICK : 0))), reason: "TIME_EXIT" };
  }
  const chain = await ctx.chain();
  const row = chain?.strikes.find((item) => item.strike === trade.strike);
  const side = trade.right === "CE" ? row?.ce : row?.pe;
  const quoteAge = chain ? (ctx.now.getTime() - new Date(chain.asOf).getTime()) / 1000 : Infinity;
  const fresh = side && chain?.expiry === trade.expiry && quoteAge <= ctx.config.quoteMaxAgeSec ? side : null;
  const lastClose = [...bars.values()].at(-1)?.c ?? null;
  const mark = fresh?.bid ?? fresh?.ltp ?? lastClose;
  const stop = state.kind === "trail" ? trailStopLevel(state.trail) : null;
  const unrealized = mark != null ? paise(mark) * trade.quantity - trade.investedPaise - trade.entryChargesPaise : null;
  await prisma.autoSnapshot.create({ data: { tradeId: trade.id, at: ctx.now, bidPaise: fresh?.bid != null ? paise(fresh.bid) : null, askPaise: fresh?.ask != null ? paise(fresh.ask) : null, lastPaise: mark != null ? paise(mark) : null, unrealizedPaise: unrealized, stopPaise: stop != null ? paise(stop) : null } });

  if (!hit) {
    await prisma.autoTrade.update({ where: { id: trade.id }, data: { state: state as object, stopPaise: stop != null ? paise(stop) : null, lastPaise: mark != null ? paise(mark) : trade.lastPaise, lastAt: ctx.now, unrealizedPaise: unrealized } });
    return { status: "IN_TRADE", note: `Holding ${trade.symbol}${stop != null ? `, stop ₹${stop}` : ""}` };
  }
  // Exit decided: sell at the live bid less slippage; without a fresh bid, wait up to exitQuoteWaitSec, then use the
  // option's last traded price (marked in the trade notes).
  const since = state.exitSince ?? ctx.nowSec;
  let price: number | null = fresh?.bid && fresh.bid > 0 ? r2(Math.max(TICK, fresh.bid - ctx.config.slippage)) : null;
  let note = "";
  if (price == null) {
    if (ctx.nowSec - since < ctx.config.exitQuoteWaitSec && ctx.minute < 15 * 60 + 28) {
      await prisma.autoTrade.update({ where: { id: trade.id }, data: { status: "EXITING", exitModel: hit as object, state: { ...state, exitSince: since } as object, lastAt: ctx.now } });
      ctx.events.push({ strategyKey: def.key, level: "WARN", kind: "DATA", message: `Trade ${trade.tradeNo}: exit (${hit.reason}) waiting for a fresh bid.` });
      return { status: "IN_TRADE", note: "Exit pending: waiting for a fresh bid." };
    }
    price = r2(Math.max(TICK, (lastClose ?? hit.price) - ctx.config.slippage));
    note = " No fresh bid within the wait: sold at the option's last traded price less slippage.";
  }
  return closeTrade(ctx, def, trade, state, hit, price, fresh?.bid ?? null, note);
}

async function closeTrade(ctx: Ctx, def: AutoStrategyDef, trade: OpenTrade, state: TradeState, hit: ExitHit, price: number, bid: number | null, note: string) {
  const exitCh = chargesPaise("SELL", price, trade.quantity);
  const proceeds = paise(price) * trade.quantity;
  const gross = proceeds - trade.investedPaise;
  const net = gross - trade.entryChargesPaise - exitCh;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.autoOrder.create({ data: { idempotencyKey: `${def.key}:${ctx.date}:T${trade.tradeNo}:SELL`, strategyKey: def.key, date: ctx.date, tradeId: trade.id, side: "SELL", status: "FILLED", quantity: trade.quantity, pricePaise: paise(price), bidPaise: bid != null ? paise(bid) : null, quoteAt: ctx.now, chargesPaise: exitCh, reason: hit.reason, requestedAt: ctx.now, filledAt: ctx.now } });
      await tx.autoTrade.update({
        where: { id: trade.id },
        data: { status: "CLOSED", exitAt: ctx.now, exitPaise: paise(price), exitBidPaise: bid != null ? paise(bid) : null, exitChargesPaise: exitCh, exitReason: hit.reason, exitModel: hit as object, grossPaise: gross, netPaise: net, unrealizedPaise: null, state: state as object, notes: `${trade.notes}${note}`.trim() },
      });
      const more = trade.tradeNo < def.maxTrades && ctx.minute < SQ;
      await tx.autoDay.update({
        where: { strategyKey_date: { strategyKey: def.key, date: ctx.date } },
        data: {
          availablePaise: { increment: proceeds - exitCh }, realizedPaise: { increment: net }, chargesPaise: { increment: exitCh },
          wins: net > 0 ? { increment: 1 } : undefined, losses: net > 0 ? undefined : { increment: 1 },
          status: more ? "WATCHING" : "DONE", note: `Trade ${trade.tradeNo} closed (${hit.reason.replace("_", " ").toLowerCase()}) at ₹${price}: net ₹${rupees(net).toFixed(2)}.`,
          state: { lastExitMinute: hit.minute } as DayState as object,
        },
      });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return { status: "DONE", note: "Already closed by another pass." };
    throw error;
  }
  ctx.events.push({ strategyKey: def.key, level: "INFO", kind: "EXIT", message: `Trade ${trade.tradeNo}: SELL ${trade.quantity} ${trade.symbol} at ₹${price} (${hit.reason}, model ${clock(hit.minute)} ₹${hit.price}); net ₹${rupees(net).toFixed(2)}.${note}`, data: { hit, price, net } });
  return { status: "CLOSED", note: `Sold at ₹${price}` };
}

// ─────────────────────────────── end of day ───────────────────────────────

async function closeDay(date: string, events: EventInput[]) {
  const stuck = await prisma.autoTrade.findMany({ where: { date, status: { in: ["OPEN", "EXITING"] } } });
  for (const trade of stuck) events.push({ strategyKey: trade.strategyKey, level: "ERROR", kind: "SYSTEM", message: `Trade ${trade.tradeNo} ${trade.symbol} is still open after 15:35 (no exit price could be obtained); it needs review.` });
  await prisma.autoDay.updateMany({ where: { date, status: { not: "CLOSED" }, NOT: { strategyKey: { in: stuck.map((t) => t.strategyKey) } } }, data: { status: "CLOSED", closedAt: new Date() } });
  const exists = await prisma.autoReport.findUnique({ where: { date } });
  if (!exists && !stuck.length) await prisma.autoReport.create({ data: { date, report: (await buildReport(date)) as object } });
}

export async function buildReport(date: string) {
  const [days, trades, signals, evts] = await Promise.all([
    prisma.autoDay.findMany({ where: { date } }),
    prisma.autoTrade.findMany({ where: { date }, orderBy: [{ strategyKey: "asc" }, { tradeNo: "asc" }] }),
    prisma.autoSignal.findMany({ where: { date } }),
    prisma.autoEvent.findMany({ where: { date, level: { in: ["WARN", "ERROR"] } }, orderBy: { at: "asc" }, take: 500 }),
  ]);
  const strategies = AUTO_STRATEGIES.map((def) => {
    const day = days.find((d) => d.strategyKey === def.key);
    const own = trades.filter((t) => t.strategyKey === def.key);
    const gross = own.reduce((s, t) => s + (t.grossPaise ?? 0), 0);
    const charges = own.reduce((s, t) => s + t.entryChargesPaise + (t.exitChargesPaise ?? 0), 0);
    return {
      key: def.key, name: def.name, status: day?.status ?? "—", note: day?.note ?? "", openingPaise: day?.openingPaise ?? DAY_CAPITAL_PAISE,
      trades: own.length, wins: own.filter((t) => (t.netPaise ?? 0) > 0).length, losses: own.filter((t) => t.status === "CLOSED" && (t.netPaise ?? 0) <= 0).length,
      skipped: signals.filter((s) => s.strategyKey === def.key && s.status === "SKIPPED").length,
      grossPaise: gross, chargesPaise: charges, netPaise: day?.realizedPaise ?? 0, finalPaise: (day?.openingPaise ?? DAY_CAPITAL_PAISE) + (day?.realizedPaise ?? 0),
    };
  });
  return {
    date, generatedAt: new Date().toISOString(), strategies,
    trades: trades.map((t) => ({ strategy: t.strategyKey, tradeNo: t.tradeNo, symbol: t.symbol, right: t.right, quantity: t.quantity, entryAt: t.entryAt, entry: rupees(t.entryPaise), exitAt: t.exitAt, exit: t.exitPaise != null ? rupees(t.exitPaise) : null, reason: t.exitReason, net: t.netPaise != null ? rupees(t.netPaise) : null })),
    skipped: signals.filter((s) => s.status !== "TRADED").map((s) => ({ strategy: s.strategyKey, tradeNo: s.tradeNo, option: `${s.strike} ${s.right}`, reason: s.reason })),
    problems: evts.map((e) => ({ at: e.at, strategy: e.strategyKey, level: e.level, kind: e.kind, message: e.message })),
  };
}

export type { Right };
