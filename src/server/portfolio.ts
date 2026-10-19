import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { formatInr, formatSignedInr, formatSignedPercent, paiseToRupees } from "@/lib/money";
import { holdingsValue, maxDrawdownBps, performancePnl, portfolioEquity, tradeStats, unrealizedPnl } from "@/lib/trading/accounting";
import { kolkataParts } from "@/lib/market/clock";
import { realizedInScope } from "@/lib/trading/replay-summary";
import { getQuote } from "@/server/market";
import { loadOptionChain } from "@/server/option-chain";
import { parseOptionLedgerSymbol } from "@/lib/options/contract";
import { replaySessionOf } from "@/lib/options/replay-premium";
import { rupeesToPaise } from "@/lib/money";
import { evaluateOpenOrders } from "@/server/trading";
import type { DataMode } from "@prisma/client";

export async function getStudentBundle(userId: string) {
  const account = await prisma.virtualAccount.findUnique({
    where: { userId },
    include: { currentPeriod: true },
  });
  if (!account?.currentPeriodId || !account.currentPeriod) throw new AppError("Practice account not found.", 404);
  await evaluateOpenOrders(account.id).catch(() => undefined);
  const refreshed = await prisma.virtualAccount.findUniqueOrThrow({ where: { id: account.id }, include: { currentPeriod: true } });
  const periodId = refreshed.currentPeriodId as string;
  const positions = await prisma.position.findMany({
    where: { accountId: refreshed.id, practicePeriodId: periodId, quantity: { gt: 0 } },
    include: { instrument: true },
  });
  const quotes = new Map<string, Awaited<ReturnType<typeof getQuote>> | null>();
  for (const position of positions) {
    if (position.instrument.sector === "Option") continue;
    try {
      quotes.set(position.instrument.symbol, await getQuote(position.instrument.symbol));
    } catch {
      quotes.set(position.instrument.symbol, null);
    }
  }
  const optionMarks = await markOptionPositions(positions);
  const openedAt = await optionEntryTimes(refreshed.id, periodId, positions.map((position) => position.instrumentId));
  let holdings = 0n;
  let unrealized = 0n;
  let stale = false;
  let mode: DataMode = "DEMO";
  const rows = positions.map((position) => {
    const quote = quotes.get(position.instrument.symbol) ?? optionMarks.get(position.instrument.symbol) ?? null;
    const mark = quote?.lastPaise ?? null;
    if (!quote || quote.mode === "UNAVAILABLE") stale = true;
    if (quote) mode = quote.mode;
    const market = mark == null ? null : holdingsValue(position.quantity, mark);
    if (market != null) holdings += market;
    const pnl = mark == null ? null : unrealizedPnl(position.quantity, position.avgCostPaise, mark);
    if (pnl != null) unrealized += pnl;
    const contract = position.instrument.sector === "Option" ? parseOptionLedgerSymbol(position.instrument.symbol) : null;
    const lotSize = position.instrument.lotSize;
    const lots = contract && lotSize > 1 && position.quantity % lotSize === 0 ? position.quantity / lotSize : null;
    return {
      symbol: position.instrument.symbol,
      name: position.instrument.name,
      quantity: position.quantity,
      lotSize: contract ? lotSize : null,
      lots,
      contract,
      replaySession: replaySessionOf(position.instrument.symbol),
      averageCost: paiseToRupees(position.avgCostPaise),
      mark: mark == null ? null : paiseToRupees(mark),
      marketValue: market == null ? null : paiseToRupees(market),
      unrealized: pnl == null ? null : paiseToRupees(pnl),
      realized: paiseToRupees(position.realizedPaise),
      mode: quote?.mode ?? "UNAVAILABLE",
      asOf: quote?.asOf.toISOString() ?? null,
      status: "OPEN",
      openedAt: openedAt.get(position.instrumentId)?.toISOString() ?? null,
      updatedAt: position.updatedAt.toISOString(),
    };
  });
  const realizedAgg = await prisma.position.aggregate({
    where: { accountId: refreshed.id, practicePeriodId: periodId },
    _sum: { realizedPaise: true },
  });
  const realized = realizedAgg._sum.realizedPaise ?? 0n;
  const todayKey = kolkataParts(new Date()).dateKey;
  const realizedFills = await prisma.execution.findMany({
    where: { order: { accountId: refreshed.id, practicePeriodId: periodId }, realizedPaise: { not: 0 } },
    select: { realizedPaise: true, executedAt: true },
  });
  // Real calendar day in IST. Replay fills carry their simulated time, so replay P&L is reported per session instead.
  const realizedToday = realizedInScope(realizedFills, { kind: "day", dateKey: todayKey, dayOf: (at) => kolkataParts(at).dateKey });
  const equity = portfolioEquity(refreshed.cashAvailable, refreshed.cashReserved, holdings);
  const fees = await prisma.ledgerEntry.aggregate({
    where: { accountId: refreshed.id, practicePeriodId: periodId, type: "FEE" },
    _sum: { cashDelta: true },
  });
  const adjustments = await prisma.ledgerEntry.aggregate({
    where: { accountId: refreshed.id, practicePeriodId: periodId, type: "ADMIN_ADJUSTMENT" },
    _sum: { cashDelta: true },
  });
  const adminNet = adjustments._sum.cashDelta ?? 0n;
  const starting = refreshed.currentPeriod?.startingCapital ?? 0n;
  const perf = performancePnl(equity, starting, adminNet);
  const invested = starting + adminNet;
  const closedRows = await prisma.closedTrade.findMany({
    where: { accountId: refreshed.id, practicePeriodId: periodId },
    select: { netPaise: true, exitAt: true },
    orderBy: { exitAt: "asc" },
  });
  const stats = tradeStats(closedRows.map((row) => ({ realizedPaise: row.netPaise })));
  const snaps = await prisma.portfolioSnapshot.findMany({
    where: { accountId: refreshed.id, practicePeriodId: periodId },
    orderBy: { capturedAt: "asc" },
    take: 80,
    select: { capturedAt: true, equity: true, realizedPaise: true, unrealizedPaise: true },
  });
  const largestWin = closedRows.reduce((best, row) => row.netPaise > best ? row.netPaise : best, 0n);
  const largestLoss = closedRows.reduce((worst, row) => row.netPaise < worst ? row.netPaise : worst, 0n);
  await captureSnapshot(refreshed.id, periodId, {
    cashAvailable: refreshed.cashAvailable,
    cashReserved: refreshed.cashReserved,
    holdings,
    equity,
    realized,
    unrealized,
    invested,
    stale: stale || rows.some((row) => row.mark == null),
    mode,
  });
  const returns = await periodReturns(refreshed.id, equity, starting);
  const allocation = rows
    .filter((row) => row.marketValue)
    .map((row) => ({ symbol: row.symbol, valuePaise: BigInt(Math.round(Number(row.marketValue) * 100)) }));
  const allocationTotal = allocation.reduce((sum, item) => sum + item.valuePaise, 0n) + refreshed.cashAvailable + refreshed.cashReserved;
  return {
    currency: "INR",
    periodLabel: refreshed.currentPeriod?.label ?? "",
    startingCapital: formatInr(starting),
    allocatedCapital: formatInr(invested),
    netPnl: formatSignedInr(perf),
    completedTrades: closedRows.length,
    winningTrades: stats.wins,
    losingTrades: stats.losses,
    winRate: stats.wins + stats.losses === 0 ? "—" : `${(stats.winRateBps / 100).toFixed(1)}%`,
    averageWin: formatSignedInr(stats.averageWin),
    averageLoss: formatSignedInr(-stats.averageLoss),
    largestWin: formatSignedInr(largestWin),
    largestLoss: formatSignedInr(largestLoss),
    maxDrawdown: snaps.length < 2 ? "—" : `${(maxDrawdownBps(snaps.map((row) => ({ equity: row.equity }))) / 100).toFixed(2)}%`,
    equityCurve: snaps.map((row) => ({ at: row.capturedAt.toISOString(), equity: formatInr(row.equity), realized: formatSignedInr(row.realizedPaise), unrealized: formatSignedInr(row.unrealizedPaise) })),
    cashAvailable: formatInr(refreshed.cashAvailable),
    cashReserved: formatInr(refreshed.cashReserved),
    holdingsValue: formatInr(holdings),
    equity: formatInr(equity),
    realized: formatSignedInr(realized),
    realizedToday: formatSignedInr(realizedToday),
    unrealized: formatSignedInr(unrealized),
    charges: formatInr(-(fees._sum.cashDelta ?? 0n)),
    dailyReturn: returns.daily,
    monthlyReturn: returns.monthly,
    allTimeReturn: formatSignedPercent(equity - starting, starting),
    performanceReturn: formatSignedPercent(perf, invested <= 0n ? 1n : invested),
    stale: stale || rows.some((row) => row.mark == null),
    valuationMessage: stale ? "One or more marks are missing or the provider failed. Equity excludes unknown marks." : "Marks use the current data mode shown on each holding.",
    positions: rows,
    allocation: [
      { label: "Cash", percent: allocationTotal === 0n ? "0.00%" : formatSignedPercent(refreshed.cashAvailable + refreshed.cashReserved, allocationTotal).replace("+", "") },
      ...rows.map((row) => ({
        label: row.symbol,
        percent: row.marketValue && allocationTotal > 0n ? formatSignedPercent(BigInt(Math.round(Number(row.marketValue) * 100)), allocationTotal).replace("+", "") : "0.00%",
      })),
    ],
  };
}

async function optionEntryTimes(accountId: string, practicePeriodId: string, instrumentIds: string[]) {
  const opened = new Map<string, Date>();
  if (!instrumentIds.length) return opened;
  const fills = await prisma.execution.findMany({
    where: { order: { accountId, practicePeriodId, side: "BUY", instrumentId: { in: instrumentIds } } },
    orderBy: { executedAt: "asc" },
    select: { executedAt: true, order: { select: { instrumentId: true } } },
  });
  for (const fill of fills) {
    if (!opened.has(fill.order.instrumentId)) opened.set(fill.order.instrumentId, fill.executedAt);
  }
  return opened;
}

async function markOptionPositions(positions: Array<{ instrumentId: string; instrument: { symbol: string; sector: string } }>) {
  const marks = new Map<string, { lastPaise: bigint; mode: DataMode; asOf: Date }>();
  const groups = new Map<string, { underlying: string; expiry: string }>();
  const replayed = positions.filter((position) => position.instrument.sector === "Option" && replaySessionOf(position.instrument.symbol));
  if (replayed.length) {
    // Replay positions are valued only by the last mark taken at the replay clock, never by the live chain.
    const cached = await prisma.quoteCache.findMany({ where: { instrumentId: { in: replayed.map((position) => position.instrumentId) }, mode: "HISTORICAL" } });
    const byId = new Map(cached.map((row) => [row.instrumentId, row]));
    for (const position of replayed) {
      const row = byId.get(position.instrumentId);
      if (row) marks.set(position.instrument.symbol, { lastPaise: row.lastPaise, mode: "HISTORICAL", asOf: row.asOf });
    }
  }
  for (const position of positions) {
    if (replaySessionOf(position.instrument.symbol)) continue;
    const parsed = position.instrument.sector === "Option" ? parseOptionLedgerSymbol(position.instrument.symbol) : null;
    if (parsed) groups.set(`${parsed.underlying}|${parsed.expiry}`, parsed);
  }
  for (const group of groups.values()) {
    try {
      const chain = await loadOptionChain(group.underlying, group.expiry);
      for (const position of positions) {
        const parsed = replaySessionOf(position.instrument.symbol) ? null : parseOptionLedgerSymbol(position.instrument.symbol);
        if (!parsed || parsed.underlying !== group.underlying || parsed.expiry !== group.expiry) continue;
        const row = chain.strikes.find((item) => item.strike === parsed.strike);
        const premium = parsed.right === "CE" ? row?.ce?.ltp : row?.pe?.ltp;
        if (premium == null || premium <= 0) continue;
        marks.set(position.instrument.symbol, { lastPaise: rupeesToPaise(premium.toFixed(2)), mode: "DELAYED", asOf: new Date(chain.asOf) });
      }
    } catch {
      continue;
    }
  }
  return marks;
}

async function captureSnapshot(
  accountId: string,
  practicePeriodId: string,
  input: { cashAvailable: bigint; cashReserved: bigint; holdings: bigint; equity: bigint; realized: bigint; unrealized: bigint; invested: bigint; stale: boolean; mode: DataMode },
) {
  const latest = await prisma.portfolioSnapshot.findFirst({ where: { accountId }, orderBy: { capturedAt: "desc" } });
  if (latest && Date.now() - latest.capturedAt.getTime() < 15 * 60 * 1000) return;
  await prisma.portfolioSnapshot.create({
    data: {
      accountId,
      practicePeriodId,
      cashAvailable: input.cashAvailable,
      cashReserved: input.cashReserved,
      holdingsValue: input.holdings,
      equity: input.equity,
      realizedPaise: input.realized,
      unrealizedPaise: input.unrealized,
      investedCapital: input.invested,
      stale: input.stale,
      valuationMode: input.mode,
    },
  });
}

async function periodReturns(accountId: string, equity: bigint, starting: bigint) {
  const snaps = await prisma.portfolioSnapshot.findMany({ where: { accountId }, orderBy: { capturedAt: "asc" }, take: 400 });
  const today = kolkataParts(new Date()).dateKey;
  const month = today.slice(0, 7);
  const beforeToday = [...snaps].reverse().find((snap) => kolkataParts(snap.capturedAt).dateKey < today);
  const beforeMonth = [...snaps].reverse().find((snap) => kolkataParts(snap.capturedAt).dateKey.slice(0, 7) < month);
  return {
    daily: beforeToday ? formatSignedPercent(equity - beforeToday.equity, beforeToday.equity) : null,
    monthly: beforeMonth ? formatSignedPercent(equity - beforeMonth.equity, beforeMonth.equity) : null,
    points: snaps.map((snap) => ({ time: snap.capturedAt.toISOString(), equity: paiseToRupees(snap.equity), stale: snap.stale })),
    drawdown: `${(maxDrawdownBps(snaps.map((snap) => ({ equity: snap.equity }))) / 100).toFixed(2)}%`,
    allTimeFromStart: formatSignedPercent(equity - starting, starting),
  };
}

export async function getAnalytics(userId: string) {
  const bundle = await getStudentBundle(userId);
  const account = await prisma.virtualAccount.findUniqueOrThrow({ where: { userId } });
  const periodId = account.currentPeriodId as string;
  const executions = await prisma.execution.findMany({
    where: { order: { accountId: account.id, practicePeriodId: periodId }, realizedPaise: { not: 0 } },
  });
  const stats = tradeStats(executions.map((item) => ({ realizedPaise: item.realizedPaise })));
  const journals = await prisma.journalEntry.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 });
  const sells = await prisma.execution.count({ where: { order: { accountId: account.id, practicePeriodId: periodId, side: "SELL" } } });
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const tradesThisWeek = await prisma.order.count({ where: { accountId: account.id, practicePeriodId: periodId, submittedAt: { gte: weekAgo } } });
  const mistakeCounts = new Map<string, number>();
  for (const journal of journals) {
    if (!journal.mistakeTag) continue;
    mistakeCounts.set(journal.mistakeTag, (mistakeCounts.get(journal.mistakeTag) ?? 0) + 1);
  }
  const repeated = [...mistakeCounts.entries()].filter(([, count]) => count >= 2).map(([tag, count]) => ({ tag, count }));
  const poorRr = journals.filter((journal) => {
    const value = Number(journal.riskReward);
    return Number.isFinite(value) && value > 0 && value < 1;
  }).length;
  const snaps = await prisma.portfolioSnapshot.findMany({ where: { accountId: account.id }, orderBy: { capturedAt: "asc" } });
  return {
    summary: bundle,
    winRate: `${(stats.winRateBps / 100).toFixed(2)}%`,
    averageWin: formatInr(stats.averageWin),
    averageLoss: formatInr(stats.averageLoss),
    profitFactor: stats.profitFactor,
    wins: stats.wins,
    losses: stats.losses,
    maxDrawdown: `${(maxDrawdownBps(snaps.map((snap) => ({ equity: snap.equity }))) / 100).toFixed(2)}%`,
    equityCurve: snaps.map((snap) => ({ time: Math.floor(snap.capturedAt.getTime() / 1000), value: Number(snap.equity) / 100 })),
    insights: [
      tradesThisWeek > 20 ? "Order count this week is high. Review whether each trade had a written plan." : null,
      poorRr > 0 ? `${poorRr} journal entries record a risk/reward ratio below 1.` : null,
      repeated.length ? `Repeated journal tags: ${repeated.map((item) => `${item.tag} (${item.count})`).join(", ")}.` : null,
      sells === 0 ? "No closed trades yet. Win rate stays empty until a sale realizes profit or loss." : null,
    ].filter((item): item is string => Boolean(item)),
    disclaimer: "These figures describe simulated performance. They are not a forecast and do not imply that a method will make money.",
  };
}

export async function recentActivity(userId: string) {
  const account = await prisma.virtualAccount.findUnique({ where: { userId } });
  if (!account?.currentPeriodId) return { orders: [], ledger: [], executions: [] };
  const [orders, ledger, executions] = await Promise.all([
    prisma.order.findMany({
      where: { accountId: account.id, practicePeriodId: account.currentPeriodId },
      include: { instrument: true, executions: { orderBy: { executedAt: "asc" }, take: 1, select: { executedAt: true, priceAsOf: true, priceSource: true, dataMode: true } } },
      orderBy: { submittedAt: "desc" },
      take: 50,
    }),
    prisma.ledgerEntry.findMany({
      where: { accountId: account.id, practicePeriodId: account.currentPeriodId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.execution.findMany({
      where: { order: { accountId: account.id, practicePeriodId: account.currentPeriodId } },
      include: { order: { include: { instrument: true } } },
      orderBy: { executedAt: "desc" },
      take: 50,
    }),
  ]);
  return {
    orders: orders.map((order) => ({
      id: order.id,
      symbol: order.instrument.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      filledQuantity: order.filledQuantity,
      status: order.status,
      limit: order.limitPaise == null ? null : paiseToRupees(order.limitPaise),
      stop: order.stopPaise == null ? null : paiseToRupees(order.stopPaise),
      avgFill: order.avgFillPaise == null ? null : paiseToRupees(order.avgFillPaise),
      charges: paiseToRupees(order.chargesPaise),
      reason: order.rejectionReason,
      submittedAt: order.submittedAt.toISOString(),
      filledAt: order.filledAt?.toISOString() ?? null,
      executedAt: order.executions[0]?.executedAt.toISOString() ?? null,
      priceAsOf: order.executions[0]?.priceAsOf.toISOString() ?? null,
      priceSource: order.executions[0]?.priceSource ?? null,
      dataMode: order.executions[0]?.dataMode ?? null,
    })),
    ledger: ledger.map((entry) => ({
      id: entry.id,
      type: entry.type,
      cashDelta: paiseToRupees(entry.cashDelta),
      reservedDelta: paiseToRupees(entry.reservedDelta),
      cashAvailableAfter: paiseToRupees(entry.cashAvailableAfter),
      reason: entry.reason,
      createdAt: entry.createdAt.toISOString(),
    })),
    executions: executions.map((fill) => ({
      id: fill.id,
      symbol: fill.order.instrument.symbol,
      side: fill.order.side,
      quantity: fill.quantity,
      price: paiseToRupees(fill.pricePaise),
      charges: paiseToRupees(fill.chargesPaise),
      realized: paiseToRupees(fill.realizedPaise),
      mode: fill.dataMode,
      source: fill.priceSource,
      executedAt: fill.executedAt.toISOString(),
    })),
  };
}
