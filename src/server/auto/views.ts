import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { kolkataParts } from "@/lib/market/clock";
import { AUTO_KEYS, AUTO_STRATEGIES, autoStrategy, DAY_CAPITAL_PAISE, MONWED_EVENTS_DEFAULT, MONWED_EVENTS_KEY } from "@/lib/auto/strategies";
import { buildReport, engineRow, ensureStrategies, ENGINE_ID } from "./engine";

/**
 * Read models and controls for the Automated Trading dashboard. Live paper results only come from the Auto* tables;
 * backtest figures come from the strategy catalogue and are always labelled as backtest.
 */

const today = () => kolkataParts(new Date()).dateKey;
const rupees = (paise: number | null | undefined) => (paise == null ? null : paise / 100);

function tradeView(t: Awaited<ReturnType<typeof prisma.autoTrade.findMany>>[number]) {
  const entry = t.entryPaise / 100;
  const exit = rupees(t.exitPaise);
  return {
    id: t.id, strategyKey: t.strategyKey, date: t.date, tradeNo: t.tradeNo, status: t.status, side: t.side, right: t.right, strike: t.strike, expiry: t.expiry, symbol: t.symbol,
    lots: t.lots, quantity: t.quantity, lotSize: t.lotSize, signalAt: t.signalAt, entryAt: t.entryAt, entry, entryBid: rupees(t.entryBidPaise), entryAsk: rupees(t.entryAskPaise),
    invested: t.investedPaise / 100, entryCharges: t.entryChargesPaise / 100, latencyMs: t.latencyMs, target: rupees(t.targetPaise), stop: rupees(t.stopPaise),
    last: rupees(t.lastPaise), lastAt: t.lastAt, unrealized: rupees(t.unrealizedPaise), exitAt: t.exitAt, exit, exitBid: rupees(t.exitBidPaise), exitCharges: rupees(t.exitChargesPaise),
    exitReason: t.exitReason, exitModel: t.exitModel, exitValue: exit != null ? exit * t.quantity : null, points: exit != null ? Math.round((exit - entry) * 100) / 100 : null,
    percent: exit != null ? Math.round(((exit - entry) / entry) * 10_000) / 100 : null, gross: rupees(t.grossPaise), net: rupees(t.netPaise),
    result: t.status === "CLOSED" ? ((t.netPaise ?? 0) > 0 ? "PROFIT" : "LOSS") : null, notes: t.notes,
  };
}
export type AutoTradeView = ReturnType<typeof tradeView>;

function dayView(d: Awaited<ReturnType<typeof prisma.autoDay.findMany>>[number] | undefined, unrealizedPaise: number) {
  if (!d) return null;
  return {
    date: d.date, status: d.status, note: d.note, opening: d.openingPaise / 100, available: d.availablePaise / 100, invested: d.investedPaise / 100,
    realized: d.realizedPaise / 100, charges: d.chargesPaise / 100, unrealized: unrealizedPaise / 100, total: (d.realizedPaise + unrealizedPaise) / 100,
    balance: (d.openingPaise + d.realizedPaise + unrealizedPaise) / 100, trades: d.trades, wins: d.wins, losses: d.losses, skipped: d.skipped,
  };
}

export async function autoOverview() {
  const date = today();
  const [engine, strategies, days, trades, signals, history] = await Promise.all([
    engineRow(), ensureStrategies(),
    prisma.autoDay.findMany({ where: { date } }),
    prisma.autoTrade.findMany({ where: { date }, orderBy: { tradeNo: "asc" } }),
    prisma.autoSignal.findMany({ where: { date }, orderBy: { createdAt: "desc" } }),
    prisma.autoDay.groupBy({ by: ["date"], _sum: { realizedPaise: true, trades: true, wins: true, losses: true }, orderBy: { date: "desc" }, take: 60 }),
  ]);
  const cards = AUTO_STRATEGIES.map((def) => {
    const row = strategies.find((s) => s.key === def.key)!;
    const own = trades.filter((t) => t.strategyKey === def.key);
    const open = own.find((t) => t.status !== "CLOSED") ?? null;
    const unreal = open?.unrealizedPaise ?? 0;
    const day = dayView(days.find((d) => d.strategyKey === def.key), unreal);
    const lastEntry = own.at(-1)?.entryAt ?? null;
    const lastExit = own.filter((t) => t.exitAt).at(-1)?.exitAt ?? null;
    const weekday = kolkataParts(new Date()).weekday.slice(0, 3);
    return {
      key: def.key, name: def.name, enabled: row.enabled, paused: row.paused, lastRunAt: row.lastRunAt, lastError: row.lastError,
      eligibleToday: def.days.includes(weekday as never), days: def.days, window: def.window, exit: def.exit, maxTrades: def.maxTrades, backtest: def.backtest,
      day, open: open ? tradeView(open) : null, lastEntry, lastExit,
      lastSignal: signals.find((s) => s.strategyKey === def.key) ?? row.lastSignal ?? null,
    };
  });
  const totals = cards.reduce((acc, card) => ({
    trades: acc.trades + (card.day?.trades ?? 0), realized: acc.realized + (card.day?.realized ?? 0), unrealized: acc.unrealized + (card.day?.unrealized ?? 0),
    capital: acc.capital + (card.day?.opening ?? DAY_CAPITAL_PAISE / 100), active: acc.active + (card.enabled && !card.paused ? 1 : 0),
    latency: card.open ? [...acc.latency, card.open.latencyMs] : acc.latency,
  }), { trades: 0, realized: 0, unrealized: 0, capital: 0, active: 0, latency: [] as number[] });
  const latencies = trades.map((t) => t.latencyMs);
  return {
    date, engine: { enabled: engine.enabled, mode: engine.mode, heartbeatAt: engine.heartbeatAt, lastTick: engine.lastTick, config: engine.config },
    cards, totals: { ...totals, latency: undefined, avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null },
    history: history.map((h) => ({ date: h.date, net: (h._sum.realizedPaise ?? 0) / 100, trades: h._sum.trades ?? 0, wins: h._sum.wins ?? 0, losses: h._sum.losses ?? 0 })).reverse(),
  };
}

export async function autoStrategyDetail(key: string) {
  const def = autoStrategy(key);
  if (!def) throw new AppError("Unknown strategy.", 404);
  const [row, days, trades, signals, events] = await Promise.all([
    prisma.autoStrategy.findUnique({ where: { key } }),
    prisma.autoDay.findMany({ where: { strategyKey: key }, orderBy: { date: "desc" }, take: 120 }),
    prisma.autoTrade.findMany({ where: { strategyKey: key }, orderBy: [{ date: "desc" }, { tradeNo: "desc" }], take: 500 }),
    prisma.autoSignal.findMany({ where: { strategyKey: key }, orderBy: [{ date: "desc" }, { tradeNo: "desc" }], take: 200 }),
    prisma.autoEvent.findMany({ where: { strategyKey: key }, orderBy: { at: "desc" }, take: 150 }),
  ]);
  const closed = trades.filter((t) => t.status === "CLOSED");
  const nets = closed.map((t) => (t.netPaise ?? 0) / 100);
  const wins = nets.filter((v) => v > 0).length;
  const date = today();
  const open = trades.find((t) => t.status !== "CLOSED") ?? null;
  return {
    key, name: def.name, def: { days: def.days, window: def.window, exit: def.exit, maxTrades: def.maxTrades, backtest: def.backtest },
    enabled: row?.enabled ?? true, paused: row?.paused ?? false, lastRunAt: row?.lastRunAt ?? null, lastError: row?.lastError ?? null,
    today: dayView(days.find((d) => d.date === date), open?.unrealizedPaise ?? 0),
    open: open ? tradeView(open) : null,
    stats: {
      trades: closed.length, wins, losses: closed.length - wins, winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : null,
      net: Math.round(nets.reduce((a, b) => a + b, 0) * 100) / 100, average: nets.length ? Math.round((nets.reduce((a, b) => a + b, 0) / nets.length) * 100) / 100 : null,
      best: nets.length ? Math.max(...nets) : null, worst: nets.length ? Math.min(...nets) : null,
    },
    days: days.map((d) => dayView(d, 0)),
    trades: trades.map(tradeView),
    signals: signals.map((s) => ({ ...s, breakout: s.breakoutMinute, confirm: s.confirmMinute })),
    events,
  };
}

export async function autoTradeDetail(id: string) {
  const trade = await prisma.autoTrade.findUnique({ where: { id } });
  if (!trade) throw new AppError("Trade not found.", 404);
  const [signal, orders, snapshots] = await Promise.all([
    prisma.autoSignal.findUnique({ where: { strategyKey_date_tradeNo: { strategyKey: trade.strategyKey, date: trade.date, tradeNo: trade.tradeNo } } }),
    prisma.autoOrder.findMany({ where: { tradeId: id }, orderBy: { requestedAt: "asc" } }),
    prisma.autoSnapshot.findMany({ where: { tradeId: id }, orderBy: { at: "asc" }, take: 2000 }),
  ]);
  return {
    trade: tradeView(trade), strategy: autoStrategy(trade.strategyKey)?.name ?? trade.strategyKey, signal,
    orders: orders.map((o) => ({ ...o, price: rupees(o.pricePaise), bid: rupees(o.bidPaise), ask: rupees(o.askPaise), charges: rupees(o.chargesPaise) })),
    snapshots: snapshots.map((s) => ({ at: s.at, bid: rupees(s.bidPaise), ask: rupees(s.askPaise), last: rupees(s.lastPaise), unrealized: rupees(s.unrealizedPaise), stop: rupees(s.stopPaise) })),
  };
}

export async function autoReport(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError("Choose a valid date.", 400);
  const saved = await prisma.autoReport.findUnique({ where: { date } });
  const dates = await prisma.autoDay.findMany({ distinct: ["date"], select: { date: true }, orderBy: { date: "desc" }, take: 250 });
  return { report: saved ? saved.report : await buildReport(date), final: Boolean(saved), dates: dates.map((d) => d.date) };
}

export function reportCsv(report: Awaited<ReturnType<typeof buildReport>>) {
  const cell = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [["Date", "Strategy", "Status", "Initial capital", "Trades", "Wins", "Losses", "Skipped", "Gross P&L", "Charges", "Net P&L", "Final balance", "Note"].join(",")];
  for (const s of report.strategies) lines.push([report.date, s.name, s.status, s.openingPaise / 100, s.trades, s.wins, s.losses, s.skipped, s.grossPaise / 100, s.chargesPaise / 100, s.netPaise / 100, s.finalPaise / 100, s.note].map(cell).join(","));
  lines.push("", ["Strategy", "Trade", "Option", "Qty", "Entry time", "Entry", "Exit time", "Exit", "Exit reason", "Net P&L"].join(","));
  for (const t of report.trades) lines.push([t.strategy, t.tradeNo, t.symbol, t.quantity, t.entryAt, t.entry, t.exitAt ?? "", t.exit ?? "", t.reason ?? "", t.net ?? ""].map(cell).join(","));
  if (report.skipped.length) {
    lines.push("", ["Strategy", "Trade", "Option", "Skipped because"].join(","));
    for (const s of report.skipped) lines.push([s.strategy, s.tradeNo, s.option, s.reason].map(cell).join(","));
  }
  if (report.problems.length) {
    lines.push("", ["Time", "Strategy", "Level", "Kind", "Message"].join(","));
    for (const p of report.problems) lines.push([p.at, p.strategy ?? "", p.level, p.kind, p.message].map(cell).join(","));
  }
  return lines.join("\n");
}

export type AutoAction =
  | { action: "master"; enabled: boolean }
  | { action: "mode"; mode: "PAPER" | "SHADOW" }
  | { action: "strategy"; key: string; op: "enable" | "disable" | "pause" | "resume" }
  | { action: "events"; events: unknown };

export async function autoControl(body: AutoAction, userId: string) {
  await engineRow();
  await ensureStrategies();
  switch (body.action) {
    case "master":
      await prisma.autoEngine.update({ where: { id: ENGINE_ID }, data: { enabled: Boolean(body.enabled) } });
      break;
    case "mode":
      if (body.mode !== "PAPER" && body.mode !== "SHADOW") throw new AppError("Choose PAPER or SHADOW.", 400);
      await prisma.autoEngine.update({ where: { id: ENGINE_ID }, data: { mode: body.mode } });
      break;
    case "strategy": {
      if (!AUTO_KEYS.includes(body.key as never)) throw new AppError("Unknown strategy.", 400);
      const data = body.op === "enable" ? { enabled: true } : body.op === "disable" ? { enabled: false } : body.op === "pause" ? { paused: true } : body.op === "resume" ? { paused: false } : null;
      if (!data) throw new AppError("Unknown control.", 400);
      await prisma.autoStrategy.update({ where: { key: body.key }, data });
      break;
    }
    case "events": {
      const value = body.events as Record<string, unknown>;
      const clean = Object.fromEntries(Object.keys(MONWED_EVENTS_DEFAULT).map((k) => [k, Array.isArray(value?.[k]) ? (value[k] as unknown[]).filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : MONWED_EVENTS_DEFAULT[k as keyof typeof MONWED_EVENTS_DEFAULT]]));
      await prisma.appSetting.upsert({ where: { key: MONWED_EVENTS_KEY }, update: { value: clean, updatedById: userId }, create: { key: MONWED_EVENTS_KEY, value: clean, updatedById: userId } });
      break;
    }
    default:
      throw new AppError("Unknown action.", 400);
  }
  await prisma.autoEvent.create({ data: { date: today(), strategyKey: body.action === "strategy" ? body.key : null, level: "INFO", kind: "SYSTEM", message: `Control: ${JSON.stringify(body).slice(0, 300)}` } });
  return autoOverview();
}

export async function monwedEventList() {
  const row = await prisma.appSetting.findUnique({ where: { key: MONWED_EVENTS_KEY } });
  return { events: (row?.value as typeof MONWED_EVENTS_DEFAULT | undefined) ?? MONWED_EVENTS_DEFAULT, saved: Boolean(row) };
}
