import { walletKey } from "@/server/practice-account";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { paiseToRupees, rupeesToPaise } from "@/lib/money";
import type { Candle } from "@/lib/market/demo";
import { findIndex } from "@/lib/market/indices";
import { kolkataParts } from "@/lib/market/clock";
import { parseOptionLedgerSymbol } from "@/lib/options/contract";
import {
  REPLAY_POLICY,
  REPLAY_POLICY_LABEL,
  replayPremiumAt,
  replaySessionDate,
  replaySessionOf,
  sessionBounds,
  sessionCoverage,
  sessionMinutes,
  type Coverage,
} from "@/lib/options/replay-premium";
import { summarizeReplaySession, toSummaryWire, type ReplaySummaryWire, type SessionFill, type SessionOpenPosition, type SessionTrade } from "@/lib/trading/replay-summary";
import { dhanOptionSession } from "@/server/dhan-market";
import { loadOptionChain } from "@/server/option-chain";
import { configuredProvider } from "@/server/settings";
import type { SessionUser } from "@/server/auth";

export const HISTORICAL_UNAVAILABLE = "Historical premium data is unavailable for this contract and time. Choose another contract or replay session.";

export type ReplayContract = { underlying: string; name: string; expiry: string; strike: number; right: "CE" | "PE"; securityId: string; kind: "index" | "equity"; lotSize: number | null };

export type ReplayQuote = {
  available: boolean;
  message: string;
  reason: string;
  session: string;
  date: string;
  cursor: number;
  premium: number | null;
  candleTime: number | null;
  candleEnd: number | null;
  ageSeconds: number | null;
  stale: boolean;
  sessionOpenPremium: number | null;
  coverage: Pick<Coverage, "status" | "minutes" | "expected">;
  lotSize: number | null;
  policy: typeof REPLAY_POLICY;
  policyLabel: string;
  source: string;
};

const tapes = new Map<string, { candles: Candle[]; at: number; ttl: number }>();

export function clearReplayTapes() {
  tapes.clear();
}

/** Validates the session and replay time. The replay time must sit inside that day's session and never past the real clock. */
export function checkReplayClock(session: string, cursor: number, now = new Date()) {
  const date = replaySessionDate(session);
  if (!date) throw new AppError("This replay session is not recognised. Restart the replay.", 400, "INVALID_SESSION");
  const bounds = sessionBounds(date);
  if (!bounds) throw new AppError("This replay date is not valid.", 400, "INVALID_SESSION");
  if (!Number.isInteger(cursor) || cursor < bounds.open || cursor > bounds.close) {
    throw new AppError("The replay time is outside this session. Move the replay between 09:15 and 15:30 IST.", 400, "CURSOR_OUT_OF_SESSION");
  }
  if (cursor * 1000 > now.getTime()) throw new AppError("The replay time is in the future.", 400, "FUTURE_CURSOR");
  return { date, bounds };
}

export async function resolveReplayContract(input: { underlying: string; expiry: string; strike: number; right: "CE" | "PE" }, stored?: { securityId: string; lotSize: number }): Promise<ReplayContract> {
  const underlying = input.underlying.trim().toUpperCase();
  if (stored?.securityId && /^\d{1,12}$/.test(stored.securityId)) {
    return { underlying, name: underlying, expiry: input.expiry, strike: input.strike, right: input.right, securityId: stored.securityId, kind: findIndex(underlying) ? "index" : "equity", lotSize: stored.lotSize > 1 ? stored.lotSize : null };
  }
  const chain = await loadOptionChain(underlying, input.expiry);
  if (!chain.available || chain.expiry !== input.expiry) {
    throw new AppError("This expiry is not on the current contract list, so its history cannot be looked up. Expired contracts cannot be replayed with this data connection.", 409, "EXPIRY_NOT_LISTED", { field: "expiry" });
  }
  const row = chain.strikes.find((item) => item.strike === input.strike);
  const side = input.right === "CE" ? row?.ce : row?.pe;
  if (!row || !side?.securityId || !/^\d{1,12}$/.test(side.securityId)) {
    throw new AppError("This strike has no market identifier, so its history cannot be looked up.", 409, "NO_CONTRACT_ID");
  }
  return { underlying: chain.symbol, name: chain.name || chain.symbol, expiry: input.expiry, strike: row.strike, right: input.right, securityId: side.securityId, kind: chain.kind, lotSize: chain.lotSize };
}

async function sessionTape(contract: ReplayContract, date: string, now: Date) {
  const bounds = sessionBounds(date);
  if (!bounds) return [];
  const key = `${contract.securityId}|${date}`;
  const hit = tapes.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.candles;
  const raw = await dhanOptionSession(contract.securityId, contract.kind, bounds.open, bounds.close);
  const candles = sessionMinutes(raw, date);
  const today = kolkataParts(now).dateKey;
  const ttl = date < today ? 6 * 60 * 60 * 1000 : 30 * 1000;
  if (tapes.size > 400) tapes.delete(tapes.keys().next().value as string);
  tapes.set(key, { candles, at: Date.now(), ttl });
  return candles;
}

/** Premium for one contract at the replay time. Only candles completed by the cursor are read. */
export async function replayQuote(input: { underlying: string; expiry: string; strike: number; right: "CE" | "PE"; session: string; cursor: number }, stored?: { securityId: string; lotSize: number }, now = new Date()): Promise<{ quote: ReplayQuote; contract: ReplayContract | null }> {
  const { date } = checkReplayClock(input.session, input.cursor, now);
  const base: Omit<ReplayQuote, "available" | "message" | "reason"> = {
    session: input.session,
    date,
    cursor: input.cursor,
    premium: null,
    candleTime: null,
    candleEnd: null,
    ageSeconds: null,
    stale: false,
    sessionOpenPremium: null,
    coverage: { status: "unavailable", minutes: 0, expected: 375 },
    lotSize: null,
    policy: REPLAY_POLICY,
    policyLabel: REPLAY_POLICY_LABEL,
    source: "Provider 1-minute option history",
  };
  const unavailable = (reason: string, contract: ReplayContract | null = null, coverage: ReplayQuote["coverage"] = base.coverage): { quote: ReplayQuote; contract: ReplayContract | null } => ({
    quote: { ...base, coverage, lotSize: contract?.lotSize ?? null, available: false, message: HISTORICAL_UNAVAILABLE, reason },
    contract,
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiry)) return unavailable("Choose an expiry from the option chain.");
  if (input.expiry < date) return unavailable(`This contract expired on ${input.expiry}, before the replay date ${date}.`);
  if (configuredProvider() !== "dhan") return unavailable("The current market-data connection does not provide historical option premiums.");
  let contract: ReplayContract;
  try {
    contract = await resolveReplayContract(input, stored);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "The contract could not be resolved.");
  }
  let tape: Candle[];
  try {
    tape = await sessionTape(contract, date, now);
  } catch (error) {
    return unavailable(error instanceof Error ? `The history request failed: ${error.message}` : "The history request failed.", contract);
  }
  const full = sessionCoverage(tape, date);
  const coverage = { status: full.status, minutes: full.minutes, expected: full.expected };
  if (full.status === "unavailable") return unavailable(`No 1-minute candles were returned for this contract on ${date}. It may not have been listed yet or did not trade.`, contract, coverage);
  const picked = replayPremiumAt(tape, input.cursor);
  if (picked.status === "none") return unavailable("No 1-minute candle for this contract has completed by this replay time.", contract, coverage);
  const first = tape[0];
  const sessionOpenPremium = first && first.time + 60 <= input.cursor ? first.open : null;
  const shared = { ...base, coverage, lotSize: contract.lotSize, premium: picked.price, candleTime: picked.candleTime, candleEnd: picked.candleEnd, ageSeconds: picked.ageSeconds, stale: picked.stale, sessionOpenPremium };
  if (picked.status === "too-stale") {
    return { quote: { ...shared, available: false, message: HISTORICAL_UNAVAILABLE, reason: `The last trade in this contract was ${Math.round(picked.ageSeconds / 60)} minutes before the replay time, which is too old to fill an order.` }, contract };
  }
  return { quote: { ...shared, available: true, message: "", reason: "" }, contract };
}

export type ReplayMark = {
  symbol: string;
  session: string;
  cursor: number;
  mark: string | null;
  marketValue: string | null;
  unrealized: string | null;
  asOf: string | null;
  stale: boolean;
  beforeEntry: boolean;
  openedAt: string | null;
  message: string;
};

/**
 * Marks every open position from one replay session at the replay time.
 * The latest mark is also cached on the replay instrument so Portfolio and Home value it the same way.
 */
export async function replayMarks(user: SessionUser, session: string, cursor: number, now = new Date()): Promise<{ marks: ReplayMark[]; summary: ReplaySummaryWire | null }> {
  checkReplayClock(session, cursor, now);
  const account = await prisma.virtualAccount.findUnique({ where: walletKey(user.id, "DEMO") });
  if (!account?.currentPeriodId) return { marks: [], summary: null };
  const positions = await prisma.position.findMany({
    where: { accountId: account.id, practicePeriodId: account.currentPeriodId, quantity: { gt: 0 }, instrument: { symbol: { endsWith: `|R:${session}` } } },
    include: { instrument: true },
  });
  const marks: ReplayMark[] = [];
  for (const position of positions) {
    const contract = parseOptionLedgerSymbol(position.instrument.symbol);
    if (!contract || replaySessionOf(position.instrument.symbol) !== session) continue;
    const firstFill = await prisma.execution.findFirst({
      where: { order: { accountId: account.id, practicePeriodId: account.currentPeriodId, instrumentId: position.instrumentId, side: "BUY" } },
      orderBy: { executedAt: "asc" },
      select: { executedAt: true },
    });
    const openedAt = firstFill?.executedAt ?? null;
    const row: ReplayMark = { symbol: position.instrument.symbol, session, cursor, mark: null, marketValue: null, unrealized: null, asOf: null, stale: false, beforeEntry: false, openedAt: openedAt?.toISOString() ?? null, message: "" };
    if (openedAt && cursor * 1000 < openedAt.getTime()) {
      marks.push({ ...row, beforeEntry: true, message: "This position was opened later in the session than the replay time." });
      continue;
    }
    const { quote } = await replayQuote({ ...contract, session, cursor }, { securityId: position.instrument.dhanSecurityId, lotSize: position.instrument.lotSize }, now);
    if (quote.premium == null || quote.candleEnd == null) {
      marks.push({ ...row, message: quote.reason || quote.message });
      continue;
    }
    const markPaise = rupeesToPaise(quote.premium.toFixed(2));
    const value = markPaise * BigInt(position.quantity);
    const pnl = (markPaise - position.avgCostPaise) * BigInt(position.quantity);
    const asOf = new Date(quote.candleEnd * 1000);
    marks.push({ ...row, mark: paiseToRupees(markPaise), marketValue: paiseToRupees(value), unrealized: paiseToRupees(pnl), asOf: asOf.toISOString(), stale: quote.stale || !quote.available, message: quote.available ? "" : quote.reason });
    const cache = {
      lastPaise: markPaise,
      bidPaise: markPaise,
      askPaise: markPaise,
      openPaise: markPaise,
      highPaise: markPaise,
      lowPaise: markPaise,
      previousClosePaise: markPaise,
      volume: 0n,
      asOf,
      mode: "HISTORICAL" as const,
      source: `${REPLAY_POLICY} at replay ${new Date(cursor * 1000).toISOString()}`,
      marketOpen: false,
      message: "Replay mark. Not a live price.",
    };
    await prisma.quoteCache.upsert({ where: { instrumentId: position.instrumentId }, create: { instrumentId: position.instrumentId, ...cache }, update: cache });
  }
  const open: SessionOpenPosition[] = positions.map((position) => {
    const mark = marks.find((row) => row.symbol === position.instrument.symbol);
    const unrealized = mark?.unrealized == null ? null : rupeesToPaise(mark.unrealized);
    return { symbol: position.instrument.symbol, quantity: position.quantity, avgCostPaise: position.avgCostPaise, unrealizedPaise: unrealized, waiting: mark?.beforeEntry ?? false };
  });
  const summary = await replaySessionSummary(account.id, account.currentPeriodId, session, open);
  return { marks, summary: toSummaryWire(summary) };
}

/** Session P&L from the session's own fills and closed trades, never from the real calendar day. */
async function replaySessionSummary(accountId: string, practicePeriodId: string, session: string, open: SessionOpenPosition[]) {
  const sessionSymbol = { endsWith: `|R:${session}` };
  const executions = await prisma.execution.findMany({
    where: { order: { accountId, practicePeriodId, instrument: { symbol: sessionSymbol } } },
    select: { quantity: true, chargesPaise: true, realizedPaise: true, executedAt: true, order: { select: { side: true, instrument: { select: { symbol: true } } } } },
  });
  const closed = await prisma.closedTrade.findMany({
    where: { accountId, practicePeriodId, symbol: sessionSymbol },
    include: { instrument: { select: { lotSize: true } } },
  });
  const fills: SessionFill[] = executions.map((fill) => ({ symbol: fill.order.instrument.symbol, side: fill.order.side, quantity: fill.quantity, chargesPaise: fill.chargesPaise, realizedPaise: fill.realizedPaise, executedAt: fill.executedAt }));
  const trades: SessionTrade[] = closed.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    quantity: row.quantity,
    lotSize: row.instrument.lotSize > 1 ? row.instrument.lotSize : null,
    entryAt: row.entryAt,
    exitAt: row.exitAt,
    avgEntryPaise: row.avgEntryPaise,
    avgExitPaise: row.avgExitPaise,
    grossPaise: row.grossPaise,
    chargesPaise: row.chargesPaise,
    netPaise: row.netPaise,
    returnBps: row.returnBps,
    holdingSeconds: row.holdingSeconds,
  }));
  return summarizeReplaySession({ session, fills, trades, open });
}
