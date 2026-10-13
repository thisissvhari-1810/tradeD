import type { Prisma, VirtualAccount } from "@prisma/client";
import { formatInr, formatSignedInr, formatSignedPercent, paiseToRupees } from "@/lib/money";
import { summarizeRoundTrip, type FillLeg } from "@/lib/trading/closed-trade";
import { tradeReceiptSvg } from "@/lib/trading/receipt";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import type { SessionUser } from "@/server/auth";

type Tx = Prisma.TransactionClient;

const stamp = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Kolkata" });

export async function recordClosedPosition(tx: Tx, account: VirtualAccount, instrumentId: string, practicePeriodId: string) {
  const existingOpen = await tx.position.findUnique({
    where: { accountId_practicePeriodId_instrumentId: { accountId: account.id, practicePeriodId, instrumentId } },
  });
  if ((existingOpen?.quantity ?? 0) !== 0) return;
  const instrument = await tx.instrument.findUnique({ where: { id: instrumentId } });
  if (!instrument) return;
  const fills = await tx.execution.findMany({
    where: { order: { accountId: account.id, practicePeriodId, instrumentId } },
    include: { order: { select: { id: true, side: true } } },
    orderBy: [{ executedAt: "asc" }, { id: "asc" }],
  });
  const legs: FillLeg[] = fills.map((fill) => ({
    id: fill.id,
    side: fill.order.side,
    quantity: fill.quantity,
    pricePaise: fill.pricePaise,
    chargesPaise: fill.chargesPaise,
    notionalPaise: fill.notionalPaise,
    realizedPaise: fill.realizedPaise,
    executedAt: fill.executedAt,
    orderId: fill.order.id,
  }));
  const summary = summarizeRoundTrip(legs);
  if (!summary) return;
  const prior = await tx.closedTrade.findUnique({ where: { exitExecutionId: summary.exitExecutionId } });
  if (prior) return;
  const receipt = safeReceipt(instrument.symbol, instrument.name, instrument.exchange, summary);
  const created = await tx.closedTrade.create({
    data: {
      accountId: account.id,
      userId: account.userId,
      practicePeriodId,
      instrumentId,
      symbol: instrument.symbol,
      name: instrument.name,
      exchange: instrument.exchange,
      quantity: summary.quantity,
      entryAt: summary.entryAt,
      avgEntryPaise: summary.avgEntryPaise,
      exitAt: summary.exitAt,
      avgExitPaise: summary.avgExitPaise,
      grossPaise: summary.grossPaise,
      chargesPaise: summary.chargesPaise,
      netPaise: summary.netPaise,
      returnBps: summary.returnBps,
      holdingSeconds: summary.holdingSeconds,
      orderIds: summary.orderIds,
      exitExecutionId: summary.exitExecutionId,
      receiptSvg: receipt.svg,
      capturedAt: receipt.capturedAt,
    },
  });
  await tx.notification.create({
    data: {
      userId: account.userId,
      title: `${instrument.symbol} position closed`,
      body: `Net ${formatSignedInr(summary.netPaise)} on a virtual long. The receipt is stored with the trade.`,
      href: `/history/${created.id}`,
    },
  });
}

function safeReceipt(symbol: string, name: string, exchange: string, summary: NonNullable<ReturnType<typeof summarizeRoundTrip>>) {
  try {
    const svg = tradeReceiptSvg({
      symbol,
      name,
      exchange,
      quantity: summary.quantity,
      entry: `₹${paiseToRupees(summary.avgEntryPaise)}`,
      exit: `₹${paiseToRupees(summary.avgExitPaise)}`,
      entryAt: `${stamp.format(summary.entryAt)} IST`,
      exitAt: `${stamp.format(summary.exitAt)} IST`,
      gross: formatSignedInr(summary.grossPaise),
      charges: formatInr(summary.chargesPaise),
      net: formatSignedInr(summary.netPaise),
      ret: formatSignedPercent(BigInt(summary.returnBps), 10_000n),
      profit: summary.netPaise > 0n,
    });
    return { svg, capturedAt: new Date() };
  } catch {
    return { svg: "", capturedAt: null };
  }
}

export function presentTrade(row: {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  direction: string;
  quantity: number;
  entryAt: Date;
  avgEntryPaise: bigint;
  exitAt: Date;
  avgExitPaise: bigint;
  grossPaise: bigint;
  chargesPaise: bigint;
  netPaise: bigint;
  returnBps: number;
  holdingSeconds: number;
  orderIds: unknown;
  note: string;
  receiptSvg: string;
  capturedAt: Date | null;
  createdAt: Date;
  user?: { name: string; email: string };
}) {
  return {
    id: row.id,
    student: row.user ? `${row.user.name} · ${row.user.email}` : undefined,
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    direction: row.direction,
    quantity: row.quantity,
    entryAt: row.entryAt.toISOString(),
    exitAt: row.exitAt.toISOString(),
    averageEntry: paiseToRupees(row.avgEntryPaise),
    averageExit: paiseToRupees(row.avgExitPaise),
    gross: formatSignedInr(row.grossPaise),
    charges: formatInr(row.chargesPaise),
    net: formatSignedInr(row.netPaise),
    ret: formatSignedPercent(BigInt(row.returnBps), 10_000n),
    profitable: row.netPaise > 0n,
    loss: row.netPaise < 0n,
    holdingSeconds: row.holdingSeconds,
    orderIds: Array.isArray(row.orderIds) ? row.orderIds.filter((item): item is string => typeof item === "string") : [],
    note: row.note,
    hasReceipt: row.receiptSvg.length > 0,
    capturedAt: row.capturedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listClosedTrades(user: SessionUser, scope: string | null) {
  if (scope === "all") {
    if (user.role !== "SUPER_ADMIN") throw new AppError("You do not have access to other students' trades.", 403);
    const rows = await prisma.closedTrade.findMany({ orderBy: { exitAt: "desc" }, take: 100, include: { user: { select: { name: true, email: true } } } });
    return rows.map(presentTrade);
  }
  if (user.role !== "STUDENT") throw new AppError("Trade history is available on student accounts.", 403);
  const rows = await prisma.closedTrade.findMany({ where: { userId: user.id }, orderBy: { exitAt: "desc" }, take: 100 });
  return rows.map(presentTrade);
}

export async function getClosedTrade(user: SessionUser, id: string) {
  const row = await prisma.closedTrade.findUnique({ where: { id }, include: { user: { select: { name: true, email: true } } } });
  if (!row) throw new AppError("Trade not found.", 404);
  if (user.role === "STUDENT" && row.userId !== user.id) throw new AppError("You cannot open another student's trade.", 403);
  if (user.role === "INSTRUCTOR") throw new AppError("You do not have access to this trade.", 403);
  return presentTrade(row);
}

export async function receiptFor(user: SessionUser, id: string) {
  const row = await prisma.closedTrade.findUnique({ where: { id } });
  if (!row) throw new AppError("Trade not found.", 404);
  if (user.role === "STUDENT" && row.userId !== user.id) throw new AppError("You cannot open another student's receipt.", 403);
  if (user.role === "INSTRUCTOR") throw new AppError("You do not have access to this receipt.", 403);
  if (!row.receiptSvg) {
    const svg = tradeReceiptSvg({
      symbol: row.symbol,
      name: row.name,
      exchange: row.exchange,
      quantity: row.quantity,
      entry: `₹${paiseToRupees(row.avgEntryPaise)}`,
      exit: `₹${paiseToRupees(row.avgExitPaise)}`,
      entryAt: `${stamp.format(row.entryAt)} IST`,
      exitAt: `${stamp.format(row.exitAt)} IST`,
      gross: formatSignedInr(row.grossPaise),
      charges: formatInr(row.chargesPaise),
      net: formatSignedInr(row.netPaise),
      ret: formatSignedPercent(BigInt(row.returnBps), 10_000n),
      profit: row.netPaise > 0n,
    });
    await prisma.closedTrade.update({ where: { id: row.id }, data: { receiptSvg: svg, capturedAt: new Date() } });
    return svg;
  }
  return row.receiptSvg;
}
