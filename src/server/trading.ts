import type { Prisma, VirtualAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { applyAdverseSlippage, rupeesToPaise } from "@/lib/money";
import { applyBuy, applySell } from "@/lib/trading/accounting";
import { calculateCharges } from "@/lib/trading/fees";
import { decideOrder, quoteIsStale, referencePrice, shouldTriggerResting, type QuoteView } from "@/lib/trading/decide";
import { getQuote } from "@/server/market";
import { getTradingSettings } from "@/server/settings";
import { recordClosedPosition } from "@/server/closed-trades";
import type { SessionUser } from "@/server/auth";

type Tx = Prisma.TransactionClient;

async function lockAccount(tx: Tx, accountId: string): Promise<VirtualAccount> {
  await tx.$queryRaw`SELECT id FROM "VirtualAccount" WHERE id = ${accountId} FOR UPDATE`;
  const account = await tx.virtualAccount.findUnique({ where: { id: accountId } });
  if (!account || !account.currentPeriodId) throw new AppError("Virtual account is not ready.", 409);
  return account;
}

async function postLedger(
  tx: Tx,
  account: VirtualAccount,
  input: {
    type: "OPENING_BALANCE" | "BUY" | "SELL" | "FEE" | "REFUND" | "RESERVE" | "RELEASE" | "ADMIN_ADJUSTMENT" | "RESET_OPENING";
    cashDelta: bigint;
    reservedDelta: bigint;
    practicePeriodId: string;
    referenceType?: string;
    referenceId?: string;
    idempotencyKey?: string;
    reason?: string;
    actorId?: string;
  },
) {
  const cashAvailable = account.cashAvailable + input.cashDelta;
  const cashReserved = account.cashReserved + input.reservedDelta;
  if (cashAvailable < 0n || cashReserved < 0n) throw new AppError("The ledger rejected this entry because a balance would turn negative.");
  await tx.ledgerEntry.create({
    data: {
      accountId: account.id,
      practicePeriodId: input.practicePeriodId,
      type: input.type,
      cashDelta: input.cashDelta,
      reservedDelta: input.reservedDelta,
      cashAvailableAfter: cashAvailable,
      cashReservedAfter: cashReserved,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason ?? "",
      actorId: input.actorId,
    },
  });
  const updated = await tx.virtualAccount.update({
    where: { id: account.id },
    data: { cashAvailable, cashReserved },
  });
  account.cashAvailable = updated.cashAvailable;
  account.cashReserved = updated.cashReserved;
}

async function writeAudit(
  tx: Tx,
  input: { actorId?: string; action: string; targetType: string; targetId: string; reason?: string; before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue; ipAddress?: string },
) {
  await tx.auditLog.create({ data: { ...input, reason: input.reason ?? "" } });
}

function quoteViewFrom(quote: Awaited<ReturnType<typeof getQuote>>): QuoteView {
  return {
    mode: quote.mode,
    lastPaise: quote.lastPaise,
    bidPaise: quote.bidPaise,
    askPaise: quote.askPaise,
    asOf: quote.asOf,
    marketOpen: quote.marketOpen,
  };
}

export async function placeOrder(
  user: SessionUser,
  input: { symbol: string; side: "BUY" | "SELL"; type: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "TARGET"; quantity: number; limitRupees?: string; stopRupees?: string; idempotencyKey: string },
) {
  if (user.role !== "STUDENT") throw new AppError("Only student practice accounts can place simulated orders.", 403);
  if (user.status !== "ACTIVE" || !user.tradingEnabled) throw new AppError("Trading is disabled for this account.", 403);
  const account = await prisma.virtualAccount.findUnique({ where: { userId: user.id } });
  if (!account?.currentPeriodId) throw new AppError("No active practice period.", 409);
  const existing = await prisma.order.findUnique({
    where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: input.idempotencyKey } },
    include: { instrument: true, executions: true },
  });
  if (existing) return { order: existing, replayed: true };

  const instrument = await prisma.instrument.findUnique({ where: { symbol: input.symbol.toUpperCase() } });
  if (!instrument?.isActive) throw new AppError("Instrument is not available.", 404);
  const settings = await getTradingSettings();
  let quote: Awaited<ReturnType<typeof getQuote>> | null = null;
  let quoteError = "";
  try {
    quote = await getQuote(instrument.symbol);
  } catch (error) {
    quoteError = error instanceof Error ? error.message : "Market data unavailable.";
  }

  const limitPaise = input.limitRupees ? rupeesToPaise(input.limitRupees) : null;
  const stopPaise = input.stopRupees ? rupeesToPaise(input.stopRupees) : null;

  return prisma.$transaction(async (tx) => {
    const locked = await lockAccount(tx, account.id);
    const replay = await tx.order.findUnique({
      where: { accountId_idempotencyKey: { accountId: locked.id, idempotencyKey: input.idempotencyKey } },
      include: { instrument: true, executions: true },
    });
    if (replay) return { order: replay, replayed: true };
    const periodId = locked.currentPeriodId as string;
    const position = await tx.position.findUnique({
      where: { accountId_practicePeriodId_instrumentId: { accountId: locked.id, practicePeriodId: periodId, instrumentId: instrument.id } },
    });
    const openSells = await tx.order.findMany({
      where: { accountId: locked.id, practicePeriodId: periodId, instrumentId: instrument.id, side: "SELL", status: "OPEN" },
    });
    const openSellQuantity = openSells.reduce((sum, order) => sum + (order.quantity - order.filledQuantity), 0);
    const positions = await tx.position.findMany({ where: { accountId: locked.id, practicePeriodId: periodId, quantity: { gt: 0 } }, include: { instrument: { include: { quote: true } } } });
    let holdings = 0n;
    for (const item of positions) {
      const mark = item.instrumentId === instrument.id && quote ? quote.lastPaise : item.instrument.quote?.lastPaise ?? item.avgCostPaise;
      holdings += mark * BigInt(item.quantity);
    }
    const view: QuoteView = quote
      ? quoteViewFrom(quote)
      : { mode: "UNAVAILABLE", lastPaise: null, bidPaise: null, askPaise: null, asOf: null, marketOpen: false };
    const decision = quoteError
      ? { ok: false as const, reason: quoteError }
      : decideOrder(
          {
            side: input.side,
            type: input.type,
            quantity: input.quantity,
            limitPaise,
            stopPaise,
            lotSize: instrument.lotSize,
            tickPaise: instrument.tickPaise,
            positionQuantity: position?.quantity ?? 0,
            openSellQuantity,
            positionMarkPaise: quote?.lastPaise ?? position?.avgCostPaise ?? 0n,
            equityPaise: locked.cashAvailable + locked.cashReserved + holdings,
          },
          view,
          locked.cashAvailable,
          new Date(),
          settings.charges,
          settings.risk,
          user.tradingEnabled && user.status === "ACTIVE",
        );

    if (!decision.ok) {
      const rejected = await tx.order.create({
        data: {
          accountId: locked.id,
          practicePeriodId: periodId,
          instrumentId: instrument.id,
          side: input.side,
          type: input.type,
          quantity: input.quantity,
          limitPaise,
          stopPaise,
          status: "REJECTED",
          rejectionReason: decision.reason,
          idempotencyKey: input.idempotencyKey,
        },
        include: { instrument: true, executions: true },
      });
      return { order: rejected, replayed: false };
    }

    const order = await tx.order.create({
      data: {
        accountId: locked.id,
        practicePeriodId: periodId,
        instrumentId: instrument.id,
        side: input.side,
        type: input.type,
        quantity: input.quantity,
        limitPaise,
        stopPaise,
        status: "OPEN",
        idempotencyKey: input.idempotencyKey,
        reservedPaise: decision.reserve,
      },
    });

    if (decision.reserve > 0n) {
      await postLedger(tx, locked, {
        type: "RESERVE",
        cashDelta: -decision.reserve,
        reservedDelta: decision.reserve,
        practicePeriodId: periodId,
        referenceType: "ORDER",
        referenceId: order.id,
        idempotencyKey: `${order.id}:reserve`,
        reason: "Cash reserved for a resting buy order.",
        actorId: user.id,
      });
    }

    if (decision.action === "FILL" && quote) {
      await fillLocked(tx, locked, order.id, decision.fillPrice, decision.charges, quote);
    } else if (decision.action === "REST" && decision.reference.includes("triggered")) {
      await tx.order.update({ where: { id: order.id }, data: { triggeredAt: new Date() } });
    }

    const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { instrument: true, executions: true } });
    return { order: fresh, replayed: false };
  });
}

async function fillLocked(
  tx: Tx,
  account: VirtualAccount,
  orderId: string,
  fillPrice: bigint,
  charges: bigint,
  quote: { mode: QuoteView["mode"]; source: string; asOf: Date; message: string },
) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== "OPEN" && order.status !== "NEW") return;
  const remaining = order.quantity - order.filledQuantity;
  if (remaining <= 0 || fillPrice <= 0n) throw new AppError("Invalid fill.");
  const notional = fillPrice * BigInt(remaining);
  const periodId = order.practicePeriodId;
  if (order.reservedPaise > 0n) {
    await postLedger(tx, account, {
      type: "RELEASE",
      cashDelta: order.reservedPaise,
      reservedDelta: -order.reservedPaise,
      practicePeriodId: periodId,
      referenceType: "ORDER",
      referenceId: order.id,
      idempotencyKey: `${order.id}:release`,
      reason: "Released cash reserved for an order that is filling.",
      actorId: account.userId,
    });
  }
  if (order.side === "BUY") {
    await postLedger(tx, account, {
      type: "BUY",
      cashDelta: -notional,
      reservedDelta: 0n,
      practicePeriodId: periodId,
      referenceType: "ORDER",
      referenceId: order.id,
      idempotencyKey: `${order.id}:buy`,
      reason: "Simulated purchase.",
      actorId: account.userId,
    });
  } else {
    await postLedger(tx, account, {
      type: "SELL",
      cashDelta: notional,
      reservedDelta: 0n,
      practicePeriodId: periodId,
      referenceType: "ORDER",
      referenceId: order.id,
      idempotencyKey: `${order.id}:sell`,
      reason: "Simulated sale.",
      actorId: account.userId,
    });
  }
  if (charges > 0n) {
    await postLedger(tx, account, {
      type: "FEE",
      cashDelta: -charges,
      reservedDelta: 0n,
      practicePeriodId: periodId,
      referenceType: "ORDER",
      referenceId: order.id,
      idempotencyKey: `${order.id}:fee`,
      reason: "Simulated transaction charges.",
      actorId: account.userId,
    });
  }

  const current = await tx.position.findUnique({
    where: { accountId_practicePeriodId_instrumentId: { accountId: account.id, practicePeriodId: periodId, instrumentId: order.instrumentId } },
  });
  const state = { quantity: current?.quantity ?? 0, avgCostPaise: current?.avgCostPaise ?? 0n, realizedPaise: current?.realizedPaise ?? 0n };
  let realized = 0n;
  const next = order.side === "BUY"
    ? applyBuy(state, remaining, fillPrice, charges)
    : (() => {
        const sold = applySell(state, remaining, fillPrice, charges);
        realized = sold.realizedOnTrade;
        return sold;
      })();
  await tx.position.upsert({
    where: { accountId_practicePeriodId_instrumentId: { accountId: account.id, practicePeriodId: periodId, instrumentId: order.instrumentId } },
    create: { accountId: account.id, practicePeriodId: periodId, instrumentId: order.instrumentId, quantity: next.quantity, avgCostPaise: next.avgCostPaise, realizedPaise: next.realizedPaise },
    update: { quantity: next.quantity, avgCostPaise: next.avgCostPaise, realizedPaise: next.realizedPaise },
  });
  await tx.execution.create({
    data: {
      orderId: order.id,
      quantity: remaining,
      pricePaise: fillPrice,
      chargesPaise: charges,
      notionalPaise: notional,
      realizedPaise: realized,
      priceSource: quote.source,
      priceAsOf: quote.asOf,
      dataMode: quote.mode,
    },
  });
  await tx.order.update({
    where: { id: order.id },
    data: {
      status: "FILLED",
      filledQuantity: order.quantity,
      avgFillPaise: fillPrice,
      chargesPaise: charges,
      reservedPaise: 0n,
      filledAt: new Date(),
    },
  });
  if (order.side === "SELL" && state.quantity > 0 && next.quantity === 0) {
    await recordClosedPosition(tx, account, order.instrumentId, periodId);
  }
  if (order.side === "BUY") {
    await awardBadge(tx, account.userId, "first-trade");
  }
}

async function awardBadge(tx: Tx, userId: string, slug: string) {
  const badge = await tx.badge.findUnique({ where: { slug } });
  if (!badge) return;
  await tx.userBadge.upsert({
    where: { userId_badgeId: { userId, badgeId: badge.id } },
    create: { userId, badgeId: badge.id },
    update: {},
  });
}

export async function cancelOrder(user: SessionUser, orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { account: true } });
  if (!order) throw new AppError("Order not found.", 404);
  if (user.role === "STUDENT" && order.account.userId !== user.id) throw new AppError("You cannot change another student's order.", 403);
  if (user.role === "INSTRUCTOR") throw new AppError("Instructors cannot cancel student orders.", 403);
  if (order.status !== "OPEN") throw new AppError("Only open orders can be cancelled.");

  return prisma.$transaction(async (tx) => {
    const account = await lockAccount(tx, order.accountId);
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (fresh.status !== "OPEN") throw new AppError("Only open orders can be cancelled.");
    if (fresh.reservedPaise > 0n) {
      await postLedger(tx, account, {
        type: "RELEASE",
        cashDelta: fresh.reservedPaise,
        reservedDelta: -fresh.reservedPaise,
        practicePeriodId: fresh.practicePeriodId,
        referenceType: "ORDER",
        referenceId: fresh.id,
        idempotencyKey: `${fresh.id}:cancel`,
        reason: "Cash released because the order was cancelled.",
        actorId: user.id,
      });
    }
    const updated = await tx.order.update({
      where: { id: fresh.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), reservedPaise: 0n, rejectionReason: user.role === "STUDENT" ? "Cancelled by student." : "Cancelled by administrator." },
      include: { instrument: true, executions: true },
    });
    if (user.role !== "STUDENT") {
      await writeAudit(tx, { actorId: user.id, action: "order.cancel", targetType: "Order", targetId: fresh.id, reason: "Administrator cancelled an open simulated order." });
    }
    return updated;
  });
}

export async function evaluateOpenOrders(accountId?: string) {
  const settings = await getTradingSettings();
  const orders = await prisma.order.findMany({
    where: { status: "OPEN", ...(accountId ? { accountId } : {}) },
    include: { instrument: true, account: { include: { user: true } } },
    take: accountId ? 100 : 200,
    orderBy: { submittedAt: "asc" },
  });
  const symbols = [...new Set(orders.map((order) => order.instrument.symbol))];
  const quotes = new Map<string, Awaited<ReturnType<typeof getQuote>>>();
  for (const symbol of symbols) {
    try {
      quotes.set(symbol, await getQuote(symbol));
    } catch {
      quotes.set(symbol, null as never);
    }
  }
  let filled = 0;
  for (const order of orders) {
    const quote = quotes.get(order.instrument.symbol);
    if (!quote?.lastPaise) continue;
    if (!order.account.user.tradingEnabled || order.account.user.status !== "ACTIVE") continue;
    const view = quoteViewFrom(quote);
    if (quoteIsStale(view, new Date(), settings.risk)) continue;
    const tradable = quote.marketOpen || (quote.mode === "DEMO" && settings.risk.demoFillWhenClosed);
    if (!tradable) continue;
    const signal = shouldTriggerResting({
      side: order.side,
      type: order.type,
      limitPaise: order.limitPaise,
      stopPaise: order.stopPaise,
      triggered: Boolean(order.triggeredAt),
      lastPaise: quote.lastPaise,
    });
    if (signal === "WAIT") continue;
    try {
      await prisma.$transaction(async (tx) => {
        const account = await lockAccount(tx, order.accountId);
        const fresh = await tx.order.findUnique({ where: { id: order.id } });
        if (!fresh || fresh.status !== "OPEN") return;
        if (signal === "ARM") {
          await tx.order.update({ where: { id: fresh.id }, data: { triggeredAt: new Date() } });
          return;
        }
        const price = restingFillPrice(fresh, quote, settings.charges.slippageBps, order.instrument.tickPaise);
        if (price == null) return;
        const notional = price * BigInt(fresh.quantity - fresh.filledQuantity);
        const charges = calculateCharges(fresh.side, notional, settings.charges).total;
        if (fresh.side === "BUY" && account.cashAvailable + fresh.reservedPaise < notional + charges) {
          await tx.order.update({ where: { id: fresh.id }, data: { status: "REJECTED", rejectionReason: "Insufficient cash when the limit triggered.", reservedPaise: 0n } });
          if (fresh.reservedPaise > 0n) {
            await postLedger(tx, account, {
              type: "RELEASE",
              cashDelta: fresh.reservedPaise,
              reservedDelta: -fresh.reservedPaise,
              practicePeriodId: fresh.practicePeriodId,
              referenceType: "ORDER",
              referenceId: fresh.id,
              idempotencyKey: `${fresh.id}:reject-release`,
              reason: "Released reserve after a triggered order was rejected.",
            });
          }
          return;
        }
        await fillLocked(tx, account, fresh.id, price, charges, quote);
        filled += 1;
      });
    } catch (error) {
      console.error("Order evaluation failed", order.id, error);
    }
  }
  await evaluateAlerts();
  return { checked: orders.length, filled };
}

function restingFillPrice(
  order: { side: "BUY" | "SELL"; type: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "TARGET"; limitPaise: bigint | null; triggeredAt: Date | null },
  quote: { lastPaise: bigint; bidPaise: bigint; askPaise: bigint },
  slippageBps: number,
  tickPaise: number,
): bigint | null {
  if (order.type === "LIMIT") return order.limitPaise;
  if (order.type === "STOP_LIMIT") return order.triggeredAt ? order.limitPaise : null;
  if (order.type === "STOP" || order.type === "TARGET") {
    const raw = referencePrice({ mode: "DEMO", lastPaise: quote.lastPaise, bidPaise: quote.bidPaise, askPaise: quote.askPaise, asOf: new Date(), marketOpen: true }, order.side);
    if (raw == null) return null;
    return applyAdverseSlippage(raw, order.side, slippageBps, BigInt(tickPaise));
  }
  return null;
}

async function evaluateAlerts() {
  const alerts = await prisma.priceAlert.findMany({ where: { status: "ACTIVE" }, include: { instrument: { include: { quote: true } } }, take: 200 });
  for (const alert of alerts) {
    const last = alert.instrument.quote?.lastPaise;
    if (last == null) continue;
    const hit = alert.condition === "PRICE_ABOVE" ? last >= alert.targetPaise : last <= alert.targetPaise;
    if (!hit) continue;
    await prisma.priceAlert.update({ where: { id: alert.id }, data: { status: "TRIGGERED", triggeredAt: new Date() } });
    await prisma.notification.create({
      data: {
        userId: alert.userId,
        title: `${alert.instrument.symbol} alert`,
        body: alert.condition === "PRICE_ABOVE" ? "The demo or provider reference price moved above your alert." : "The demo or provider reference price moved below your alert.",
        href: `/terminal?symbol=${alert.instrument.symbol}`,
      },
    });
  }
}

export async function adjustFunds(actor: SessionUser, userId: string, amountPaise: bigint, reason: string, ip?: string) {
  if (!reason.trim()) throw new AppError("A reason is required for a balance adjustment.");
  const account = await prisma.virtualAccount.findUnique({ where: { userId } });
  if (!account?.currentPeriodId) throw new AppError("Student account not found.", 404);
  return prisma.$transaction(async (tx) => {
    const locked = await lockAccount(tx, account.id);
    const before = locked.cashAvailable.toString();
    await postLedger(tx, locked, {
      type: "ADMIN_ADJUSTMENT",
      cashDelta: amountPaise,
      reservedDelta: 0n,
      practicePeriodId: locked.currentPeriodId as string,
      reason,
      actorId: actor.id,
      idempotencyKey: `adjust:${actor.id}:${account.id}:${Date.now()}:${amountPaise}`,
    });
    await writeAudit(tx, {
      actorId: actor.id,
      action: amountPaise >= 0n ? "funds.credit" : "funds.debit",
      targetType: "VirtualAccount",
      targetId: locked.id,
      reason,
      before: { cashAvailablePaise: before },
      after: { cashAvailablePaise: locked.cashAvailable.toString() },
      ipAddress: ip,
    });
    return locked;
  });
}

export async function resetPracticePeriod(actor: SessionUser, userId: string, reason: string, ip?: string) {
  if (!reason.trim()) throw new AppError("A reason is required to reset a practice period.");
  const settings = await getTradingSettings();
  const account = await prisma.virtualAccount.findUnique({ where: { userId }, include: { currentPeriod: true } });
  if (!account?.currentPeriodId || !account.currentPeriod) throw new AppError("Student account not found.", 404);
  return prisma.$transaction(async (tx) => {
    const locked = await lockAccount(tx, account.id);
    const periodId = locked.currentPeriodId as string;
    const open = await tx.order.findMany({ where: { accountId: locked.id, status: "OPEN" } });
    for (const order of open) {
      if (order.reservedPaise > 0n) {
        await postLedger(tx, locked, {
          type: "RELEASE",
          cashDelta: order.reservedPaise,
          reservedDelta: -order.reservedPaise,
          practicePeriodId: periodId,
          referenceType: "ORDER",
          referenceId: order.id,
          idempotencyKey: `${order.id}:reset-release`,
          reason: "Reserve released because the practice period was reset.",
          actorId: actor.id,
        });
      }
      await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED", cancelledAt: new Date(), reservedPaise: 0n, rejectionReason: "Cancelled because the practice period was reset." } });
    }
    await tx.competitionParticipant.updateMany({
      where: { practicePeriodId: periodId, status: "ACTIVE" },
      data: { status: "COMPLETED", finalizedAt: new Date() },
    });
    await tx.practicePeriod.update({ where: { id: periodId }, data: { endedAt: new Date(), endReason: reason } });
    const currentPeriod = await tx.practicePeriod.findUniqueOrThrow({ where: { id: periodId } });
    const sequence = currentPeriod.sequence + 1;
    const next = await tx.practicePeriod.create({
      data: {
        accountId: locked.id,
        sequence,
        label: `Practice period ${sequence}`,
        startingCapital: settings.startingCapitalPaise,
        createdById: actor.id,
      },
    });
    await tx.virtualAccount.update({
      where: { id: locked.id },
      data: { currentPeriodId: next.id, cashAvailable: settings.startingCapitalPaise, cashReserved: 0n },
    });
    await tx.ledgerEntry.create({
      data: {
        accountId: locked.id,
        practicePeriodId: next.id,
        type: "RESET_OPENING",
        cashDelta: settings.startingCapitalPaise,
        reservedDelta: 0n,
        cashAvailableAfter: settings.startingCapitalPaise,
        cashReservedAfter: 0n,
        reason,
        actorId: actor.id,
      },
    });
    await writeAudit(tx, {
      actorId: actor.id,
      action: "account.reset",
      targetType: "VirtualAccount",
      targetId: locked.id,
      reason,
      before: { practicePeriodId: periodId },
      after: { practicePeriodId: next.id, startingCapitalPaise: settings.startingCapitalPaise.toString() },
      ipAddress: ip,
    });
    return next;
  });
}

export { awardBadge };
