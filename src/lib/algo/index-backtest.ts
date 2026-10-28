import { algoTrades, EXIT_LABEL, tradeTimeline, type AlgoTrade } from "./chart-replay";
import { monthlyExpiry, weeklyExpiries, type ExpiredTapes, type ExpiryCycle } from "./expired-options";
import { csvCell } from "./report";
import { TICK, type AlgoEvent } from "./runner";
import type { Candle } from "./lines";

/**
 * Mathi Strategy (+3%) backtests on other NSE indices: the index metadata, the data-quality checks, the per-trade
 * audit and the report figures. The trades themselves come from the app's own engine (simulateSession on the
 * expired contracts' real 1-minute premiums); nothing here changes a rule, it only measures and labels.
 */

export type IndexSpec = {
  symbol: string;
  name: string;
  /** Dhan IDX_I security id of the index (also the underlying id for its expired-options history). */
  dhanIndexId: number;
  cycle: ExpiryCycle;
  /** Strike interval around the money. */
  strikeStep: number;
  /** Contract lot size, and where it comes from. */
  lotSize: number;
  lotSizeSource: string;
};

const MASTER = "Dhan instrument master (api-scrip-master-detailed.csv) read 2026-10-28; same for every listed expiry";

/** The three indices of this comparison (all monthly-expiry only on NSE since 20 Nov 2024). */
export const INDEX_SPECS: Record<"FINNIFTY" | "MIDCPNIFTY" | "NIFTYNXT50", IndexSpec> = {
  FINNIFTY: { symbol: "FINNIFTY", name: "NIFTY Financial Services", dhanIndexId: 27, cycle: "MONTH", strikeStep: 50, lotSize: 60, lotSizeSource: MASTER },
  MIDCPNIFTY: { symbol: "MIDCPNIFTY", name: "NIFTY Midcap Select", dhanIndexId: 442, cycle: "MONTH", strikeStep: 25, lotSize: 120, lotSizeSource: MASTER },
  NIFTYNXT50: { symbol: "NIFTYNXT50", name: "NIFTY Next 50", dhanIndexId: 38, cycle: "MONTH", strikeStep: 100, lotSize: 25, lotSizeSource: MASTER },
};
export type IndexSymbol = keyof typeof INDEX_SPECS;
export const INDEX_SYMBOLS = Object.keys(INDEX_SPECS) as IndexSymbol[];

const DAY = 86_400_000;
const round = (value: number) => Math.round(value * 100) / 100;
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
export const istDay = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(0, 10);
export const istClock = (seconds: number | null) => (seconds == null ? "" : new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16));
const istMinute = (seconds: number) => {
  const date = new Date((seconds + 19_800) * 1000);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
};

/** One calendar month ending on `last` (inclusive): 2026-10-27 → 2026-09-28 … 2026-10-27. */
export function monthWindow(last: string): { from: string; to: string } {
  const [year, month, day] = last.split("-").map(Number);
  const back = new Date(Date.UTC(year, month - 2, day));
  // 31 March → 28/29 February rather than rolling into March.
  if (back.getUTCMonth() !== (month + 10) % 12) back.setUTCDate(0);
  return { from: addDays(back.toISOString().slice(0, 10), 1), to: last };
}

/** Weekdays from `from` to `to` inclusive. */
export function weekdays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += DAY) {
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

const SESSION_FIRST = 9 * 60 + 15;
const SESSION_LAST = 15 * 60 + 29;
export const SESSION_MINUTES = SESSION_LAST - SESSION_FIRST + 1;

export type SessionQuality = { date: string; candles: number; missing: string[]; complete: boolean };

/**
 * Index 1-minute candles split into sessions (IST 09:15–15:29), with what was dropped: rows outside the session,
 * duplicated minutes (the later row is dropped, never merged), and rows that are not valid candles.
 */
export function indexSessions(raw: Candle[]) {
  const seen = new Map<number, Candle>();
  let duplicates = 0;
  let outside = 0;
  let invalid = 0;
  for (const candle of raw) {
    if (![candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0) || candle.high < candle.low || candle.time % 60 !== 0) { invalid += 1; continue; }
    const minute = istMinute(candle.time);
    if (minute < SESSION_FIRST || minute > SESSION_LAST) { outside += 1; continue; }
    if (seen.has(candle.time)) { duplicates += 1; continue; }
    seen.set(candle.time, candle);
  }
  const byDay = new Map<string, Candle[]>();
  for (const candle of [...seen.values()].sort((a, b) => a.time - b.time)) {
    const day = istDay(candle.time);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(candle);
  }
  return { byDay, duplicates, outside, invalid };
}

/** Which session minutes have no index candle (a complete session has all 375). */
export function sessionQuality(date: string, candles: Candle[]): SessionQuality {
  const have = new Set(candles.map((candle) => istMinute(candle.time)));
  const missing: string[] = [];
  for (let minute = SESSION_FIRST; minute <= SESSION_LAST; minute += 1) {
    if (!have.has(minute)) missing.push(`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);
  }
  return { date, candles: candles.length, missing, complete: missing.length === 0 };
}

export type ExpiryInfo = { expiry: string | null; source: "data" | "calendar" | "none"; calendar: string | null; mismatch: boolean };

/**
 * Each session's expiry, from the premiums themselves where possible: the expiry day is the day the at-the-money
 * options end with (almost) no time value (`tolerance` points, scaled to the index level by the caller). Monthly
 * contracts are cross-checked against the calendar rule (last Tuesday), which ignores holiday shifts; a session after
 * the last expiry seen in the data falls back to the calendar rule and says so.
 */
export function resolveExpiries(tapes: ExpiredTapes, cycle: ExpiryCycle, tolerance: number): Map<string, ExpiryInfo> {
  const fromData = weeklyExpiries(tapes, tolerance);
  const out = new Map<string, ExpiryInfo>();
  for (const [day, expiry] of fromData) {
    const calendar = cycle === "MONTH" ? monthlyExpiry(day) : null;
    if (expiry) out.set(day, { expiry, source: "data", calendar, mismatch: calendar != null && calendar !== expiry });
    else out.set(day, { expiry: calendar, source: calendar ? "calendar" : "none", calendar, mismatch: false });
  }
  return out;
}

/* ---------------- per-trade audit ---------------- */

export type TradeFlag =
  | "STALE_ENTRY_PREMIUM" | "STALE_EXIT_PREMIUM" | "TARGET_TOUCH_ONLY" | "GAP_FILL_ABOVE_TARGET"
  | "QTY_ABOVE_ENTRY_MINUTE_VOLUME" | "MISSING_OPTION_MINUTES" | "OPEN_AT_END" | "EXPIRY_FROM_CALENDAR" | "EXPIRY_CALENDAR_MISMATCH";

export const FLAG_TEXT: Record<TradeFlag, string> = {
  STALE_ENTRY_PREMIUM: "No option trade in the signal minute: the entry used the last earlier premium (within the engine's 10-minute fill limit).",
  STALE_EXIT_PREMIUM: "No option trade in the exit minute: the exit used the last earlier premium.",
  TARGET_TOUCH_ONLY: "The option only touched the target (high < target + 1 tick): a resting sell at the target might not have filled.",
  GAP_FILL_ABOVE_TARGET: "The target minute opened above the target: filled at that open (better than the target).",
  QTY_ABOVE_ENTRY_MINUTE_VOLUME: "Order quantity is larger than the contracts traded in the entry minute: the fill size is optimistic.",
  MISSING_OPTION_MINUTES: "Some minutes while the trade was open have no option candle (no trades): MFE/MAE and exits use the last premium.",
  OPEN_AT_END: "No exit fill recorded: excluded from P&L.",
  EXPIRY_FROM_CALENDAR: "The expiry date comes from the calendar rule (last Tuesday), not from the data.",
  EXPIRY_CALENDAR_MISMATCH: "The expiry seen in the data differs from the calendar rule (an exchange-holiday shift).",
};

export type AuditTrade = {
  id: string;
  date: string;
  index: string;
  optionSymbol: string;
  right: "CE" | "PE";
  side: "CALL" | "PUT";
  expiry: string | null;
  strike: number | null;
  lotSize: number | null;
  lots: number | null;
  quantity: number;
  lines: string[];
  shadow: boolean;
  signalTime: number;
  entryTime: number;
  entryPremium: number;
  targetPremium: number | null;
  exitTime: number | null;
  exitPremium: number | null;
  exitReason: string | null;
  targetHit: boolean;
  gross: number | null;
  charges: number;
  net: number | null;
  /** Premium paid plus entry charges, ₹. */
  deployed: number;
  /** Net P&L / premium paid, %. */
  returnPercent: number | null;
  /** Best rise / worst fall of the option's own 1-minute high / low after the entry minute, per unit, ₹ and %. */
  mfe: number | null;
  mae: number | null;
  mfePercent: number | null;
  maePercent: number | null;
  holdingMinutes: number | null;
  flags: TradeFlag[];
  /** Slippage included in the fill prices (entry + exit ticks × quantity), ₹. */
  slippage: number;
  evidence: { signalCandle: Candle | null; targetCandle: Candle | null; heldMinutes: number; missingMinutes: number; entryVolume: number | null };
  timeline: Array<{ time: number; text: string }>;
};

/**
 * Every trade of one simulated session, with its contract, fills, P&L, excursions and data-quality flags, all
 * measured on the traded strike's own 1-minute premium tape (only candles that finished after the entry).
 */
export function auditSession(input: { symbol: string; date: string; events: AlgoEvent[]; tapes: Map<string, Candle[]>; expiry: ExpiryInfo | null; slippageTicks: number }): AuditTrade[] {
  return algoTrades(input.events, null).map((trade) => auditTrade(trade, input));
}

function auditTrade(trade: AlgoTrade, input: { symbol: string; date: string; events: AlgoEvent[]; tapes: Map<string, Candle[]>; expiry: ExpiryInfo | null; slippageTicks: number }): AuditTrade {
  const right = trade.right === "PE" ? "PE" : "CE";
  const tape = input.tapes.get(`${right}:${trade.strike}`) ?? [];
  const at = (time: number) => tape.find((candle) => candle.time === time) ?? null;
  // The premium the entry used is the signal minute's close (the minute that ends at the entry time).
  const signalCandle = at(trade.entryTime - 60);
  const end = trade.exitTime ?? Infinity;
  const held = tape.filter((candle) => candle.time >= trade.entryTime && candle.time + 60 <= end);
  const heldMinutes = trade.exitTime != null ? Math.max(0, Math.round((trade.exitTime - trade.entryTime) / 60)) : 0;
  // The exit's own reason code: a shadow exit's message starts "SHADOW Exit (…)", which algoTrades labels only "Exit".
  const exitEvent = input.events.filter((event) => event.kind === "EXIT" && event.order?.key.startsWith(`${trade.entryKey}:exit`)).at(-1);
  const code = exitEvent ? /Exit \(([A-Z_]+)\)/.exec(exitEvent.message)?.[1] ?? null : null;
  const exitReason = trade.exitReason === "Exit" && code ? EXIT_LABEL[code] ?? trade.exitReason : trade.exitReason;
  const targetHit = exitReason === "Target";
  const targetCandle = targetHit && trade.exitTime != null ? at(trade.exitTime - 60) : null;
  const flags: TradeFlag[] = [];
  if (!signalCandle) flags.push("STALE_ENTRY_PREMIUM");
  if (trade.exitTime != null && !targetHit && !at(trade.exitTime - 60)) flags.push("STALE_EXIT_PREMIUM");
  if (targetCandle && trade.target != null) {
    if (targetCandle.open >= trade.target) flags.push("GAP_FILL_ABOVE_TARGET");
    else if (targetCandle.high < trade.target + TICK) flags.push("TARGET_TOUCH_ONLY");
  }
  if (signalCandle && signalCandle.volume != null && signalCandle.volume > 0 && trade.quantity > signalCandle.volume) flags.push("QTY_ABOVE_ENTRY_MINUTE_VOLUME");
  if (held.length < heldMinutes) flags.push("MISSING_OPTION_MINUTES");
  if (trade.exitTime == null || trade.realized == null) flags.push("OPEN_AT_END");
  if (input.expiry?.source === "calendar") flags.push("EXPIRY_FROM_CALENDAR");
  if (input.expiry?.mismatch) flags.push("EXPIRY_CALENDAR_MISMATCH");
  const high = held.length ? Math.max(...held.map((candle) => candle.high)) : null;
  const low = held.length ? Math.min(...held.map((candle) => candle.low)) : null;
  const mfe = high == null ? null : round(Math.max(0, high - trade.entryPremium));
  const mae = low == null ? null : round(Math.max(0, trade.entryPremium - low));
  const charges = round(trade.entryCharges + trade.exitCharges);
  const paid = trade.entryPremium * trade.quantity;
  const expiry = input.expiry?.expiry ?? (trade.expiry || null);
  return {
    id: `${input.symbol}:${input.date}:${trade.number}`,
    date: input.date,
    index: input.symbol,
    optionSymbol: `${input.symbol} ${expiry ?? "?"} ${trade.strike ?? "?"} ${right}`,
    right,
    side: trade.side,
    expiry,
    strike: trade.strike,
    lotSize: trade.lotSize,
    lots: trade.lotSize ? trade.quantity / trade.lotSize : null,
    quantity: trade.quantity,
    lines: trade.lines,
    shadow: trade.shadow,
    signalTime: trade.signalTime,
    entryTime: trade.entryTime,
    entryPremium: trade.entryPremium,
    targetPremium: trade.target,
    exitTime: trade.exitTime,
    exitPremium: trade.exitPremium,
    exitReason,
    targetHit,
    gross: trade.gross,
    charges,
    net: trade.realized,
    deployed: round(paid + trade.entryCharges),
    returnPercent: trade.realized != null && paid ? round((trade.realized / paid) * 100) : null,
    mfe,
    mae,
    mfePercent: mfe == null ? null : round((mfe / trade.entryPremium) * 100),
    maePercent: mae == null ? null : round((mae / trade.entryPremium) * 100),
    holdingMinutes: trade.durationMinutes,
    flags,
    slippage: round(input.slippageTicks * TICK * trade.quantity * (trade.exitTime != null ? 2 : 1)),
    evidence: { signalCandle, targetCandle, heldMinutes, missingMinutes: Math.max(0, heldMinutes - held.length), entryVolume: signalCandle?.volume ?? null },
    timeline: tradeTimeline(input.events, trade.entryKey).map((event) => ({ time: event.time, text: event.text })),
  };
}

/**
 * Re-derives a trade's prices from its own option candles, independently of the engine: the entry is the signal
 * minute's close plus the slippage, the target is entry × 1.03 (2 decimals), and a target exit needs that minute's
 * high at or above the target and fills at the target (or the open, if it opened above) less the slippage.
 * Returns the differences found (empty when the trade agrees with its candles).
 */
export function verifyTrade(trade: AuditTrade, tape: Candle[], slippageTicks: number, targetPercent = 3): string[] {
  const problems: string[] = [];
  const at = (time: number) => tape.find((candle) => candle.time === time) ?? null;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  const signal = at(trade.entryTime - 60) ?? [...tape].reverse().find((candle) => candle.time < trade.entryTime - 60) ?? null;
  if (!signal) problems.push("no option candle at or before the signal minute");
  else if (!near(trade.entryPremium, round(signal.close + slippageTicks * TICK))) problems.push(`entry ${trade.entryPremium} ≠ signal-minute close ${signal.close} + ${slippageTicks} tick(s)`);
  const target = round(trade.entryPremium * (1 + targetPercent / 100));
  if (trade.targetPremium == null || !near(trade.targetPremium, target)) problems.push(`target ${trade.targetPremium} ≠ entry × ${1 + targetPercent / 100} = ${target}`);
  if (trade.targetHit && trade.exitTime != null) {
    const candle = at(trade.exitTime - 60);
    if (!candle) problems.push("target exit without an option candle in that minute");
    else {
      if (candle.high < target) problems.push(`target exit but the minute's high ${candle.high} < target ${target}`);
      const fill = round(Math.max(TICK, (candle.open >= target ? candle.open : target) - slippageTicks * TICK));
      if (trade.exitPremium != null && !near(trade.exitPremium, fill)) problems.push(`exit ${trade.exitPremium} ≠ expected fill ${fill}`);
    }
  }
  if (!trade.targetHit && trade.exitTime != null) {
    // Every option minute before a non-target exit must have stayed below the target (else the target came first).
    const before = tape.filter((candle) => candle.time >= trade.entryTime && candle.time + 60 <= trade.exitTime!);
    const crossed = before.find((candle) => candle.high >= target);
    if (crossed) problems.push(`the ${istClock(crossed.time)} minute reached the target (high ${crossed.high}) before the ${trade.exitReason} exit`);
  }
  if (trade.entryTime <= trade.signalTime) problems.push("entry is not after the signal candle");
  if (trade.exitTime != null && trade.exitTime <= trade.entryTime) problems.push("exit is not after the entry");
  if (trade.gross != null && trade.exitPremium != null && !near(trade.gross, round((trade.exitPremium - trade.entryPremium) * trade.quantity))) problems.push("gross P&L ≠ (exit − entry) × quantity");
  if (trade.net != null && trade.gross != null && !near(trade.net, round(trade.gross - trade.charges))) problems.push("net P&L ≠ gross − charges");
  if (trade.lotSize && trade.quantity % trade.lotSize !== 0) problems.push("quantity is not a whole number of lots");
  return problems;
}

/* ---------------- charges sensitivity ---------------- */

/** Statutory option charges per order (NSE, long premium). Rates as fractions of premium turnover. */
export type ChargeRates = { brokeragePerOrder: number; exchange: number; sebi: number; stampBuy: number; sttSell: number; gst: number };
/** Exchange 0.03503% (NSE options, from Oct 2024), SEBI ₹10 / crore, stamp 0.003% on buys, STT 0.1% on sells, GST 18% on brokerage + exchange + SEBI. */
export const STATUTORY_RATES: ChargeRates = { brokeragePerOrder: 20, exchange: 0.0003503, sebi: 0.000001, stampBuy: 0.00003, sttSell: 0.001, gst: 0.18 };

export function statutoryCharges(side: "BUY" | "SELL", premium: number, quantity: number, rates: ChargeRates = STATUTORY_RATES) {
  const turnover = premium * quantity;
  const exchange = turnover * rates.exchange;
  const sebi = turnover * rates.sebi;
  const tax = side === "BUY" ? turnover * rates.stampBuy : turnover * rates.sttSell;
  return round(rates.brokeragePerOrder + exchange + sebi + tax + (rates.brokeragePerOrder + exchange + sebi) * rates.gst);
}

/* ---------------- report figures ---------------- */

export type DayRow = { date: string; trades: number; ce: number; pe: number; targetHits: number; gross: number; charges: number; net: number; cumulative: number };

export type IndexSummary = {
  sessions: number;
  trades: number;
  ce: number;
  pe: number;
  wins: number;
  losses: number;
  breakeven: number;
  targetHits: number;
  otherExits: number;
  open: number;
  /** Wins / closed trades × 100 (a win is net P&L after charges > 0). */
  winRate: number | null;
  /** Average net return on the premium paid, %, of winning and of losing trades. */
  avgWinReturn: number | null;
  avgLossReturn: number | null;
  /** Sum of the before-charges P&L of trades that made / lost money before charges, ₹. */
  grossProfit: number;
  grossLoss: number;
  gross: number;
  charges: number;
  slippage: number;
  net: number;
  /** Net / premium deployed across all trades, %. */
  returnOnDeployed: number | null;
  /** Net / the ₹ account capital (same capital every session, not compounded), %. */
  returnOnCapital: number | null;
  deployed: number;
  /** Largest peak-to-trough fall of the cumulative net P&L, trade by trade in time order, from 0, ₹ and % of capital. */
  maxDrawdown: number;
  maxDrawdownPercent: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  avgHoldingMinutes: number | null;
  maxConsecutiveLosses: number;
  tradesPerDay: number | null;
  worstMaePercent: number | null;
  avgMaePercent: number | null;
  flagged: number;
  exits: Record<string, number>;
  daily: DayRow[];
};

/** The figures for a set of trades over the given sessions (each session listed, with or without trades). */
export function summarize(trades: AuditTrade[], sessions: string[], capital: number): IndexSummary {
  const ordered = [...trades].filter((trade) => !trade.shadow).sort((a, b) => a.entryTime - b.entryTime);
  const closed = ordered.filter((trade) => trade.net != null);
  const wins = closed.filter((trade) => trade.net! > 0);
  const losses = closed.filter((trade) => trade.net! < 0);
  const sum = (list: AuditTrade[], pick: (trade: AuditTrade) => number) => round(list.reduce((total, trade) => total + pick(trade), 0));
  const average = (values: number[]) => (values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null);
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let streak = 0;
  let maxConsecutiveLosses = 0;
  for (const trade of closed) {
    running += trade.net!;
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, peak - running);
    streak = trade.net! < 0 ? streak + 1 : 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
  }
  const net = sum(closed, (trade) => trade.net!);
  const deployed = sum(ordered, (trade) => trade.deployed);
  const paid = sum(closed, (trade) => trade.entryPremium * trade.quantity);
  const exits: Record<string, number> = {};
  for (const trade of ordered) exits[trade.exitReason ?? "Open"] = (exits[trade.exitReason ?? "Open"] ?? 0) + 1;
  let cumulative = 0;
  const daily = [...sessions].sort().map((date): DayRow => {
    const list = closed.filter((trade) => trade.date === date);
    const dayNet = sum(list, (trade) => trade.net!);
    cumulative = round(cumulative + dayNet);
    return { date, trades: ordered.filter((trade) => trade.date === date).length, ce: list.filter((trade) => trade.right === "CE").length, pe: list.filter((trade) => trade.right === "PE").length, targetHits: list.filter((trade) => trade.targetHit).length, gross: sum(list, (trade) => trade.gross ?? 0), charges: sum(list, (trade) => trade.charges), net: dayNet, cumulative };
  });
  const mae = closed.map((trade) => trade.maePercent).filter((value): value is number => value != null);
  return {
    sessions: sessions.length,
    trades: ordered.length,
    ce: ordered.filter((trade) => trade.right === "CE").length,
    pe: ordered.filter((trade) => trade.right === "PE").length,
    wins: wins.length,
    losses: losses.length,
    breakeven: closed.length - wins.length - losses.length,
    targetHits: closed.filter((trade) => trade.targetHit).length,
    otherExits: closed.filter((trade) => !trade.targetHit).length,
    open: ordered.length - closed.length,
    winRate: closed.length ? round((wins.length / closed.length) * 100) : null,
    avgWinReturn: average(wins.map((trade) => trade.returnPercent!).filter((value) => value != null)),
    avgLossReturn: average(losses.map((trade) => trade.returnPercent!).filter((value) => value != null)),
    grossProfit: sum(closed.filter((trade) => (trade.gross ?? 0) > 0), (trade) => trade.gross!),
    grossLoss: sum(closed.filter((trade) => (trade.gross ?? 0) < 0), (trade) => trade.gross!),
    gross: sum(closed, (trade) => trade.gross ?? 0),
    charges: sum(ordered, (trade) => trade.charges),
    slippage: sum(ordered, (trade) => trade.slippage),
    net,
    returnOnDeployed: paid ? round((net / paid) * 100) : null,
    returnOnCapital: capital ? round((net / capital) * 100) : null,
    deployed,
    maxDrawdown: round(maxDrawdown),
    maxDrawdownPercent: capital ? round((maxDrawdown / capital) * 100) : null,
    largestWin: wins.length ? Math.max(...wins.map((trade) => trade.net!)) : null,
    largestLoss: losses.length ? Math.min(...losses.map((trade) => trade.net!)) : null,
    avgHoldingMinutes: average(closed.map((trade) => trade.holdingMinutes ?? 0)),
    maxConsecutiveLosses,
    tradesPerDay: sessions.length ? round(ordered.length / sessions.length) : null,
    worstMaePercent: mae.length ? Math.max(...mae) : null,
    avgMaePercent: average(mae),
    flagged: ordered.filter((trade) => trade.flags.length).length,
    exits,
    daily,
  };
}

/* ---------------- the stored report ---------------- */

export type IndexStatus = "BACKTESTED" | "INCOMPLETE" | "NOT_BACKTESTED";

export type SessionRecord = {
  date: string;
  status: "SIMULATED" | "SKIPPED";
  reason?: string;
  indexCandles: number;
  missingMinutes: string[];
  optionStrikes: number;
  expiry: ExpiryInfo | null;
  /** Spot in the option rows vs the index close of the same minute. */
  spotChecked: number;
  spotMismatched: number;
  signals: { detected: number; confirmed: number; falseBreakouts: number; expired: number; rejected: number; entered: number; shadow: number };
  rejections: string[];
};

export type IndexResult = {
  symbol: string;
  name: string;
  status: IndexStatus;
  reason: string | null;
  premiumSource: string;
  spec: IndexSpec;
  sessions: SessionRecord[];
  trades: AuditTrade[];
  shadowTrades: AuditTrade[];
  summary: IndexSummary | null;
  sensitivity: { statutoryCharges: number | null; netAtStatutoryCharges: number | null; stressSlippageTicks: number; netAtStressSlippage: number | null } | null;
  dataQuality: { duplicates: number; outsideSession: number; invalid: number; incompleteSessions: string[]; offsetsWithData: string[]; requestFailures: string[]; verification: { checked: number; problems: Array<{ id: string; problems: string[] }> } };
};

export type IndexBacktestReport = {
  generatedAt: string;
  window: { from: string; to: string; weekdays: number; holidays: string[] };
  provider: string;
  capital: number;
  strategy: { name: string; version: number; rules: string[]; config: Record<string, unknown> };
  definitions: Record<string, string>;
  limitations: string[];
  indices: IndexResult[];
};

export const DEFINITIONS: Record<string, string> = {
  "Win rate": "Winning trades ÷ closed trades × 100. A win is a trade whose net P&L (after charges and slippage) is above ₹0; ₹0 is break-even, below ₹0 a loss.",
  "Gross P&L": "(Exit premium − entry premium) × quantity, before charges. Slippage is already inside both prices (1 tick = ₹0.05 against the trade at entry and at exit).",
  "Gross profit / loss": "Sum of the gross P&L of the trades that made money / lost money before charges.",
  Charges: "The app's own option charge model on every order (₹20 brokerage, exchange 0.05%, SEBI 0.01%, stamp 0.03% on buys, STT 0.06% on sells, GST 18%): an estimate, not a contract note. A statutory-rate check is shown alongside.",
  "Net P&L": "Gross P&L − charges, summed over closed real trades. Shadow trades (regime switch off) are never included.",
  "Return on deployed capital": "Net P&L ÷ premium paid on all closed trades × 100.",
  "Return on account capital": "Net P&L ÷ ₹1,00,000 × 100. Every session starts from the same ₹1,00,000 virtual account (not compounded).",
  "Maximum drawdown": "Largest fall from a peak of the cumulative net P&L, trade by trade in time order, starting at ₹0; also shown as % of ₹1,00,000.",
  "Open positions": "The strategy squares off at 15:20 IST and closes anything left at the session's last premium, so no position is carried; a trade without an exit fill would be listed as OPEN and left out of P&L.",
  "MFE / MAE": "Highest high / lowest low of the traded option's own 1-minute candles after the entry minute up to the exit, against the entry premium (per unit and %).",
  Signals: "Detected = line crossings (50% of the body past a line); confirmed = retests that passed; entered = filled real entries; shadow = signals followed without money because the regime switch was off; rejected = confirmed signals the engine did not enter (with its reason).",
};

const AUDIT_HEADER = [
  "Date", "Timestamp (IST)", "Index", "Option symbol", "CE/PE", "Expiry", "Strike", "Lot size", "Lots", "Entry signal time", "Entry time", "Entry premium", "Target premium",
  "Exit time", "Exit premium", "Exit reason", "Quantity", "Gross P&L", "Charges (est.)", "Net P&L", "Return %", "MFE / unit", "MFE %", "MAE / unit", "MAE %", "Holding minutes",
  "Lines", "Shadow (regime off)", "Data-quality flags",
];

/** Trade-by-trade audit CSV (Excel-friendly: BOM, CRLF). Times are IST; flags are separated by "; " ("OK" when none). */
export function auditCsv(trades: AuditTrade[]): string {
  const row = (cells: unknown[]) => cells.map(csvCell).join(",");
  const lines = [row(AUDIT_HEADER)];
  for (const trade of [...trades].sort((a, b) => a.index.localeCompare(b.index) || a.entryTime - b.entryTime)) {
    lines.push(row([
      trade.date, `${trade.date} ${istClock(trade.entryTime)}`, trade.index, trade.optionSymbol, trade.right, trade.expiry ?? "", trade.strike ?? "", trade.lotSize ?? "", trade.lots ?? "",
      istClock(trade.signalTime), istClock(trade.entryTime), trade.entryPremium.toFixed(2), trade.targetPremium?.toFixed(2) ?? "", istClock(trade.exitTime), trade.exitPremium?.toFixed(2) ?? "",
      trade.exitReason ?? "OPEN", trade.quantity, trade.gross?.toFixed(2) ?? "", trade.charges.toFixed(2), trade.net?.toFixed(2) ?? "", trade.returnPercent?.toFixed(2) ?? "",
      trade.mfe ?? "", trade.mfePercent ?? "", trade.mae ?? "", trade.maePercent ?? "", trade.holdingMinutes ?? "", trade.lines.join("; "), trade.shadow ? "yes" : "no",
      trade.flags.length ? trade.flags.join("; ") : "OK",
    ]));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Daily P&L CSV for each index (every session, including days without trades). */
export function dailyCsv(results: Array<{ symbol: string; daily: DayRow[] }>): string {
  const row = (cells: unknown[]) => cells.map(csvCell).join(",");
  const lines = [row(["Index", "Date", "Trades", "CE", "PE", "Target hits", "Gross P&L", "Charges (est.)", "Net P&L", "Cumulative net P&L"])];
  for (const result of results) for (const day of result.daily) lines.push(row([result.symbol, day.date, day.trades, day.ce, day.pe, day.targetHits, day.gross.toFixed(2), day.charges.toFixed(2), day.net.toFixed(2), day.cumulative.toFixed(2)]));
  return `﻿${lines.join("\r\n")}\r\n`;
}
