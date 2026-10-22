import { ensurePracticeAccount, walletKey, type PracticeMode } from "@/server/practice-account";
import { mayPractice } from "@/lib/auth/permissions";
import type { Prisma, VirtualAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { applyAdverseSlippage, formatInr, rupeesToPaise } from "@/lib/money";
import { applyBuy, applySell } from "@/lib/trading/accounting";
import { calculateCharges } from "@/lib/trading/fees";
import { decideOrder, quoteIsStale, referencePrice, shouldTriggerResting, type QuoteView } from "@/lib/trading/decide";
import { getQuote, getReplay } from "@/server/market";
import { replayFillPrice } from "@/lib/trading/replay-engine";
import { findIndex } from "@/lib/market/indices";
import { optionLedgerSymbol, premiumValuePaise } from "@/lib/options/contract";
import { loadOptionChain } from "@/server/option-chain";
import { REPLAY_POLICY, replayLedgerSymbol } from "@/lib/options/replay-premium";
import { checkReplayClock, HISTORICAL_UNAVAILABLE, replayQuote } from "@/server/option-replay";
import { getTradingSettings } from "@/server/settings";
import { recordClosedPosition } from "@/server/closed-trades";
import type { SessionUser } from "@/server/auth";

type Tx = Prisma.TransactionClient;

// A fill makes ~15 sequential round trips; Prisma's 5 s default expired in production (P2028).
const LEDGER_TX = { maxWait: 10_000, timeout: 25_000 } as const;

function ledgerTx<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(work, LEDGER_TX);
}

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
  mode: PracticeMode = "DEMO",
) {
  if (!mayPractice(user)) throw new AppError("This account cannot place practice orders.", 403);
  if (user.status !== "ACTIVE" || !user.tradingEnabled) throw new AppError("Trading is disabled for this account.", 403);
  const account = await ensurePracticeAccount(user.id, mode);
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

  return ledgerTx(async (tx) => {
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
  quote: { mode: QuoteView["mode"]; source: string; asOf: Date; message: string; executedAt?: Date },
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
      executedAt: quote.executedAt ?? new Date(),
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

  return ledgerTx(async (tx) => {
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
    if (order.idempotencyKey.startsWith("replay:")) continue;
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
      await ledgerTx(async (tx) => {
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

export async function placeReplayOrder(
  user: SessionUser,
  input: {
    symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
    quantity: number;
    limitRupees?: string;
    stopRupees?: string;
    date: string;
    cursor: number;
    timeframe: string;
    idempotencyKey: string;
  },
) {
  if (!mayPractice(user)) throw new AppError("This account cannot place practice orders.", 403);
  if (user.status !== "ACTIVE" || !user.tradingEnabled) throw new AppError("Trading is disabled for this account.", 403);
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new AppError("Enter a whole number of shares.");
  if (!Number.isFinite(input.cursor)) throw new AppError("The replay clock is not ready.", 409);
  const symbol = input.symbol.trim().toUpperCase();
  const session = await getReplay(symbol, input.date);
  if (session.unavailable || !session.tape.length || session.sessionOpen == null || session.sessionClose == null) {
    throw new AppError(session.message || "This session has no candles.", 409);
  }
  if (input.cursor < session.sessionOpen || input.cursor > session.sessionClose) throw new AppError("The replay clock is outside this session.", 409);
  const revealed = replayFillPrice(session.tape, input.cursor);
  if (revealed == null) throw new AppError("Demo mode has no candle at the replay time.", 409);
  const instrument = await practiceInstrument(symbol, revealed);
  if (!instrument?.isActive) throw new AppError("Instrument is not available.", 404);
  const account = await prisma.virtualAccount.findUnique({ where: walletKey(user.id, "DEMO") });
  if (!account?.currentPeriodId) throw new AppError("No demo capital has been assigned to this account.", 409);
  const key = input.idempotencyKey.startsWith("replay:") ? input.idempotencyKey : `replay:${input.date}:${input.idempotencyKey}`;
  const existing = await prisma.order.findUnique({
    where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: key } },
    include: { instrument: true, executions: true },
  });
  if (existing) return { order: existing, replayed: true };
  const minute = session.tape.find((item) => input.cursor >= item.time && input.cursor < item.time + 60);
  const limitPaise = input.limitRupees ? rupeesToPaise(input.limitRupees) : null;
  const stopPaise = input.stopRupees ? rupeesToPaise(input.stopRupees) : null;
  const fillRupees = replayTouched(input.type, input.side, revealed, minute, input.cursor, limitPaise, stopPaise);
  const settings = await getTradingSettings();
  return ledgerTx(async (tx) => {
    const locked = await lockAccount(tx, account.id);
    const again = await tx.order.findUnique({
      where: { accountId_idempotencyKey: { accountId: locked.id, idempotencyKey: key } },
      include: { instrument: true, executions: true },
    });
    if (again) return { order: again, replayed: true };
    const periodId = locked.currentPeriodId as string;
    const position = await tx.position.findUnique({
      where: { accountId_practicePeriodId_instrumentId: { accountId: locked.id, practicePeriodId: periodId, instrumentId: instrument.id } },
    });
    if (input.side === "SELL" && input.quantity > (position?.quantity ?? 0)) {
      throw new AppError("Sell quantity is above the shares this demo account holds. Short selling is off.", 409);
    }
    const settingsNow = settings;
    const previewPrice = fillRupees == null ? null : rupeesToPaise(fillRupees.toFixed(2));
    if (input.side === "BUY" && previewPrice != null) {
      const chargesPreview = calculateCharges("BUY", previewPrice * BigInt(input.quantity), settingsNow.charges).total;
      const required = previewPrice * BigInt(input.quantity) + chargesPreview;
      if (locked.cashAvailable < required) {
        throw new AppError(`Demo buying power cannot cover this order. Available buying power ${formatInr(locked.cashAvailable)}. Required funds ${formatInr(required)}. Shortfall ${formatInr(required - locked.cashAvailable)}.`, 409);
      }
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
        idempotencyKey: key,
      },
    });
    if (fillRupees == null) {
      const waiting = await tx.order.update({
        where: { id: order.id },
        data: { rejectionReason: `Waiting for the revealed ${input.date} replay range.` },
        include: { instrument: true, executions: true },
      });
      return { order: waiting, replayed: false };
    }
    const fillPrice = rupeesToPaise(fillRupees.toFixed(2));
    const charges = calculateCharges(input.side, fillPrice * BigInt(input.quantity), settings.charges).total;
    await fillLocked(tx, locked, order.id, fillPrice, charges, {
      mode: "HISTORICAL",
      source: `replay ${input.date} ${input.timeframe}`,
      asOf: new Date(input.cursor * 1000),
      message: "Filled from the revealed replay candle.",
      executedAt: new Date(input.cursor * 1000),
    });
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { instrument: true, executions: true } });
    return { order: fresh, replayed: false };
  });
}

async function practiceInstrument(symbol: string, referenceRupees: number) {
  const existing = await prisma.instrument.findUnique({ where: { symbol } });
  if (existing?.isActive) return existing;
  const index = findIndex(symbol);
  if (!index) return existing;
  const base = Number(rupeesToPaise(referenceRupees.toFixed(2)));
  if (!Number.isSafeInteger(base) || base <= 0 || base > 2_000_000_000) {
    throw new AppError("The revealed index price cannot be stored on the practice ledger.", 409);
  }
  return prisma.instrument.upsert({
    where: { symbol },
    update: { isActive: true, name: index.name, exchange: "NSE", sector: "Index", lotSize: 1, dhanSecurityId: index.id },
    create: {
      symbol,
      name: index.name,
      exchange: "NSE",
      sector: "Index",
      lotSize: 1,
      tickPaise: 5,
      isActive: true,
      dhanSecurityId: index.id,
      basePaise: base,
    },
  });
}

function replayTouched(
  type: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT",
  side: "BUY" | "SELL",
  revealed: number,
  minute: { time: number; open: number; high: number; low: number; close: number } | undefined,
  cursor: number,
  limitPaise: bigint | null,
  stopPaise: bigint | null,
): number | null {
  if (!minute || cursor < minute.time) return null;
  const forming = cursor < minute.time + 60;
  const high = forming ? revealed : minute.high;
  const low = forming ? revealed : minute.low;
  const open = forming ? revealed : minute.open;
  if (type === "MARKET") return revealed;
  const limit = limitPaise == null ? null : Number(limitPaise) / 100;
  const trigger = stopPaise == null ? null : Number(stopPaise) / 100;
  if (type === "LIMIT") return limit != null && (side === "BUY" ? low <= limit : high >= limit) ? limit : null;
  if (trigger == null) return null;
  const crossed = side === "BUY" ? high >= trigger : low <= trigger;
  if (!crossed) return null;
  const gap = side === "BUY" ? open >= trigger : open <= trigger;
  if (type === "STOP") return gap ? open : trigger;
  if (limit == null) return null;
  const openBeyond = side === "BUY" ? open > limit : open < limit;
  if (openBeyond) return null;
  return side === "BUY" ? (low <= limit ? limit : null) : high >= limit ? limit : null;
}

export async function settleReplayOrders(user: SessionUser, input: { symbol: string; date: string; cursor: number; timeframe: string }) {
  if (!mayPractice(user)) throw new AppError("This account cannot settle practice orders.", 403);
  if (!Number.isFinite(input.cursor)) return { filled: 0 };
  const symbol = input.symbol.trim().toUpperCase();
  const session = await getReplay(symbol, input.date);
  if (session.unavailable || !session.tape.length) return { filled: 0 };
  const revealed = replayFillPrice(session.tape, input.cursor);
  const minute = session.tape.find((item) => input.cursor >= item.time && input.cursor < item.time + 60);
  if (revealed == null || !minute) return { filled: 0 };
  const account = await prisma.virtualAccount.findUnique({ where: walletKey(user.id, "DEMO") });
  if (!account) return { filled: 0 };
  const orders = await prisma.order.findMany({
    where: { accountId: account.id, status: "OPEN", idempotencyKey: { startsWith: `replay:${input.date}:` }, instrument: { symbol } },
    include: { instrument: true },
  });
  const settings = await getTradingSettings();
  let filled = 0;
  for (const order of orders) {
    if (order.type === "TARGET") continue;
    const price = replayTouched(order.type, order.side, revealed, minute, input.cursor, order.limitPaise, order.stopPaise);
    if (price == null) continue;
    const did = await ledgerTx(async (tx) => {
      const locked = await lockAccount(tx, account.id);
      const fresh = await tx.order.findUnique({ where: { id: order.id } });
      if (!fresh || fresh.status !== "OPEN") return false;
      const fillPrice = rupeesToPaise(price.toFixed(2));
      const charges = calculateCharges(fresh.side, fillPrice * BigInt(fresh.quantity), settings.charges).total;
      if (fresh.side === "BUY" && locked.cashAvailable < fillPrice * BigInt(fresh.quantity) + charges) {
        await tx.order.update({ where: { id: fresh.id }, data: { status: "REJECTED", rejectionReason: "Demo buying power cannot cover this order." } });
        return false;
      }
      if (fresh.side === "SELL") {
        const position = await tx.position.findUnique({
          where: { accountId_practicePeriodId_instrumentId: { accountId: locked.id, practicePeriodId: locked.currentPeriodId as string, instrumentId: fresh.instrumentId } },
        });
        if (fresh.quantity > (position?.quantity ?? 0)) {
          await tx.order.update({ where: { id: fresh.id }, data: { status: "REJECTED", rejectionReason: "Sell quantity is above the open long." } });
          return false;
        }
      }
      await fillLocked(tx, locked, fresh.id, fillPrice, charges, {
        mode: "HISTORICAL",
        source: `replay ${input.date} ${input.timeframe}`,
        asOf: new Date(input.cursor * 1000),
        message: "Filled from the revealed replay candle.",
        executedAt: new Date(input.cursor * 1000),
      });
      return true;
    });
    if (did) filled += 1;
  }
  return { filled };
}

export async function placeOptionDemo(
  user: SessionUser,
  input: { symbol: string; expiry: string; strike: number; right: "CE" | "PE"; action: "BUY" | "SELL"; lots: number; idempotencyKey: string; referencePremium?: number },
  mode: PracticeMode = "DEMO",
) {
  if (!mayPractice(user)) throw new AppError("This account cannot buy or sell practice options.", 403, "ROLE_NOT_ALLOWED");
  if (user.status !== "ACTIVE" || !user.tradingEnabled) throw new AppError("Trading is disabled for this account. Ask your instructor to enable it.", 403, "TRADING_DISABLED");
  if (!Number.isInteger(input.lots) || input.lots <= 0 || input.lots > 50) throw new AppError("Enter between 1 and 50 lots.", 400, "INVALID_QUANTITY", { field: "lots" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiry)) throw new AppError("Choose an expiry from the option chain.", 400, "INVALID_EXPIRY", { field: "expiry" });
  const account = await ensurePracticeAccount(user.id, mode);
  if (!account?.currentPeriodId) throw new AppError("No demo capital has been assigned to this account yet. Ask your instructor to assign capital.", 409, "NO_DEMO_ACCOUNT");
  const key = input.idempotencyKey.startsWith("option:") ? input.idempotencyKey : `option:${input.idempotencyKey}`;
  const existing = await prisma.order.findUnique({
    where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: key } },
    include: { instrument: true, executions: true },
  });
  if (existing) return { order: existing, replayed: true };

  const chain = await loadOptionChain(input.symbol, input.expiry);
  if (!chain.available || chain.expiry !== input.expiry) throw new AppError(chain.message || "This expiry is no longer on the option chain. Pick a listed expiry.", 409, "EXPIRY_NOT_LISTED", { field: "expiry" });
  if (!chain.lotSize) throw new AppError("The lot size for this contract is unavailable, so the order cannot be sized.", 409, "NO_LOT_SIZE");
  const row = chain.strikes.find((item) => item.strike === input.strike);
  const side = input.right === "CE" ? row?.ce : row?.pe;
  if (!row || side?.ltp == null || side.ltp <= 0) throw new AppError("This contract has no traded premium right now, so it cannot be filled.", 409, "NO_PREMIUM");
  if (input.referencePremium != null && input.referencePremium > 0 && premiumMoved(input.referencePremium, side.ltp)) {
    throw new AppError(`Price moved from ₹${input.referencePremium.toFixed(2)} to ₹${side.ltp.toFixed(2)}. Review the new price and confirm again.`, 409, "PRICE_MOVED", { details: { latestPremium: side.ltp, asOf: chain.asOf } });
  }
  const premium = rupeesToPaise(side.ltp.toFixed(2));
  const notional = premiumValuePaise(premium, input.lots, chain.lotSize);
  if (notional == null) throw new AppError("The lot size for this contract is not usable.", 409, "NO_LOT_SIZE");
  const quantity = input.lots * chain.lotSize;
  const symbol = optionLedgerSymbol(chain.symbol, chain.expiry, row.strike, input.right);
  const base = Number(premium);
  if (!Number.isSafeInteger(base) || base <= 0 || base > 2_000_000_000) throw new AppError("This premium cannot be stored on the practice ledger.", 409, "NO_PREMIUM");
  const instrument = await prisma.instrument.upsert({
    where: { symbol },
    update: { isActive: true, lotSize: chain.lotSize, name: `${chain.name} ${row.strike} ${input.right}`, ...(side.securityId ? { dhanSecurityId: side.securityId } : {}) },
    create: {
      symbol,
      name: `${chain.name} ${row.strike} ${input.right} · ${chain.expiry}`,
      exchange: "NSE",
      sector: "Option",
      lotSize: chain.lotSize,
      tickPaise: 5,
      isActive: true,
      ...(side.securityId ? { dhanSecurityId: side.securityId } : {}),
      basePaise: base,
    },
  });
  const settings = await getTradingSettings();
  return ledgerTx(async (tx) => {
    const locked = await lockAccount(tx, account.id);
    const again = await tx.order.findUnique({
      where: { accountId_idempotencyKey: { accountId: locked.id, idempotencyKey: key } },
      include: { instrument: true, executions: true },
    });
    if (again) return { order: again, replayed: true };
    const periodId = locked.currentPeriodId as string;
    const charges = calculateCharges(input.action, notional, settings.charges).total;
    if (input.action === "SELL") {
      const position = await tx.position.findUnique({
        where: { accountId_practicePeriodId_instrumentId: { accountId: locked.id, practicePeriodId: periodId, instrumentId: instrument.id } },
      });
      if ((position?.quantity ?? 0) <= 0) throw new AppError("You don’t hold this contract. Short options are not available; Sell only closes a long position.", 409, "SHORT_NOT_ALLOWED");
      if (quantity > (position?.quantity ?? 0)) throw new AppError(`You hold ${position?.quantity ?? 0} units. Reduce the lots to close at most that.`, 409, "QTY_ABOVE_POSITION", { field: "lots" });
    } else if (locked.cashAvailable < notional + charges) {
      throw new AppError(`Insufficient buying power. Available ${formatInr(locked.cashAvailable)}, required ${formatInr(notional + charges)} (short by ${formatInr(notional + charges - locked.cashAvailable)}).`, 409, "INSUFFICIENT_FUNDS", { field: "lots", details: { availablePaise: locked.cashAvailable.toString(), requiredPaise: (notional + charges).toString() } });
    }
    const order = await tx.order.create({
      data: {
        accountId: locked.id,
        practicePeriodId: periodId,
        instrumentId: instrument.id,
        side: input.action,
        type: "MARKET",
        quantity,
        status: "OPEN",
        idempotencyKey: key,
      },
    });
    await fillLocked(tx, locked, order.id, premium, charges, {
      mode: "DELAYED",
      source: "option chain snapshot",
      asOf: new Date(chain.asOf),
      message: "Filled from the option-chain snapshot. No order was sent to a broker.",
    });
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { instrument: true, executions: true } });
    return { order: fresh, replayed: false };
  });
}

/**
 * Replay option order. The fill comes from the provider's 1-minute history for this exact contract at the
 * replay time (see REPLAY_POLICY). The current chain snapshot is never used. Orders in a session cannot be
 * placed earlier than that session's latest fill, so seeking back cannot rewrite recorded executions.
 */
export async function placeOptionReplay(
  user: SessionUser,
  input: { symbol: string; expiry: string; strike: number; right: "CE" | "PE"; action: "BUY" | "SELL"; lots: number; session: string; cursor: number; idempotencyKey: string; referencePremium?: number },
  now = new Date(),
) {
  if (!mayPractice(user)) throw new AppError("This account cannot buy or sell practice options.", 403, "ROLE_NOT_ALLOWED");
  if (user.status !== "ACTIVE" || !user.tradingEnabled) throw new AppError("Trading is disabled for this account. Ask your instructor to enable it.", 403, "TRADING_DISABLED");
  if (!Number.isInteger(input.lots) || input.lots <= 0 || input.lots > 50) throw new AppError("Enter between 1 and 50 lots.", 400, "INVALID_QUANTITY", { field: "lots" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiry)) throw new AppError("Choose an expiry from the option chain.", 400, "INVALID_EXPIRY", { field: "expiry" });
  const { date } = checkReplayClock(input.session, input.cursor, now);
  const account = await prisma.virtualAccount.findUnique({ where: walletKey(user.id, "DEMO") });
  if (!account?.currentPeriodId) throw new AppError("No demo capital has been assigned to this account yet. Ask your instructor to assign capital.", 409, "NO_DEMO_ACCOUNT");
  const prefix = `optreplay:${input.session}:`;
  const key = `${prefix}${input.idempotencyKey.replace(/^optreplay:[^:]*:/, "")}`;
  const existing = await prisma.order.findUnique({
    where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: key } },
    include: { instrument: true, executions: true },
  });
  if (existing) return { order: existing, replayed: true, quote: null };

  const contractSymbol = optionLedgerSymbol(input.symbol, input.expiry, input.strike, input.right);
  const symbol = replayLedgerSymbol(contractSymbol, input.session);
  const known = await prisma.instrument.findUnique({ where: { symbol } });
  const { quote, contract } = await replayQuote(
    { underlying: input.symbol, expiry: input.expiry, strike: input.strike, right: input.right, session: input.session, cursor: input.cursor },
    known ? { securityId: known.dhanSecurityId, lotSize: known.lotSize } : undefined,
    now,
  );
  if (!quote.available || quote.premium == null || quote.candleEnd == null || !contract) {
    throw new AppError(HISTORICAL_UNAVAILABLE, 409, "NO_HISTORICAL_PREMIUM", { details: { reason: quote.reason, coverage: quote.coverage.status } });
  }
  const lotSize = contract.lotSize ?? (known && known.lotSize > 1 ? known.lotSize : null);
  if (!lotSize) throw new AppError("The lot size for this contract is unavailable, so the order cannot be sized.", 409, "NO_LOT_SIZE");
  if (input.referencePremium != null && input.referencePremium > 0 && premiumMoved(input.referencePremium, quote.premium)) {
    throw new AppError(`The replay premium is now ₹${quote.premium.toFixed(2)}, not ₹${input.referencePremium.toFixed(2)}. Review the new price and confirm again.`, 409, "PRICE_MOVED", { details: { latestPremium: quote.premium, candleTime: quote.candleTime } });
  }
  const premium = rupeesToPaise(quote.premium.toFixed(2));
  const notional = premiumValuePaise(premium, input.lots, lotSize);
  if (notional == null) throw new AppError("The lot size for this contract is not usable.", 409, "NO_LOT_SIZE");
  const quantity = input.lots * lotSize;
  const base = Number(premium);
  if (!Number.isSafeInteger(base) || base <= 0 || base > 2_000_000_000) throw new AppError("This premium cannot be stored on the practice ledger.", 409, "NO_HISTORICAL_PREMIUM");
  const instrument = known
    ? await prisma.instrument.update({ where: { id: known.id }, data: { lotSize, dhanSecurityId: contract.securityId } })
    : await prisma.instrument.upsert({
        where: { symbol },
        update: { lotSize, dhanSecurityId: contract.securityId },
        create: {
          symbol,
          name: `${contract.name} ${contract.strike} ${input.right} · ${input.expiry} · replay ${date}`,
          exchange: "NSE",
          sector: "Option",
          lotSize,
          tickPaise: 5,
          // Session-scoped ledger rows stay out of instrument search.
          isActive: false,
          dhanSecurityId: contract.securityId,
          basePaise: base,
        },
      });
  const candleClock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date((quote.candleTime ?? 0) * 1000));
  const settings = await getTradingSettings();
  return ledgerTx(async (tx) => {
    const locked = await lockAccount(tx, account.id);
    const again = await tx.order.findUnique({
      where: { accountId_idempotencyKey: { accountId: locked.id, idempotencyKey: key } },
      include: { instrument: true, executions: true },
    });
    if (again) return { order: again, replayed: true, quote };
    const periodId = locked.currentPeriodId as string;
    const latest = await tx.execution.findFirst({
      where: { order: { accountId: locked.id, idempotencyKey: { startsWith: prefix } } },
      orderBy: { executedAt: "desc" },
      select: { executedAt: true },
    });
    if (latest && input.cursor * 1000 < latest.executedAt.getTime()) {
      throw new AppError(`Your last fill in this replay session was at ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(latest.executedAt)} IST. Move the replay to that time or later to trade, so recorded fills stay in order.`, 409, "REPLAY_TIME_BEHIND", { details: { latestFill: latest.executedAt.toISOString() } });
    }
    const charges = calculateCharges(input.action, notional, settings.charges).total;
    if (input.action === "SELL") {
      const position = await tx.position.findUnique({
        where: { accountId_practicePeriodId_instrumentId: { accountId: locked.id, practicePeriodId: periodId, instrumentId: instrument.id } },
      });
      if ((position?.quantity ?? 0) <= 0) throw new AppError("You don’t hold this contract in this replay session. Short options are not available; Sell only closes a long position.", 409, "SHORT_NOT_ALLOWED");
      if (quantity > (position?.quantity ?? 0)) throw new AppError(`You hold ${position?.quantity ?? 0} units. Reduce the lots to close at most that.`, 409, "QTY_ABOVE_POSITION", { field: "lots" });
    } else if (locked.cashAvailable < notional + charges) {
      throw new AppError(`Insufficient buying power. Available ${formatInr(locked.cashAvailable)}, required ${formatInr(notional + charges)} (short by ${formatInr(notional + charges - locked.cashAvailable)}).`, 409, "INSUFFICIENT_FUNDS", { field: "lots", details: { availablePaise: locked.cashAvailable.toString(), requiredPaise: (notional + charges).toString() } });
    }
    const order = await tx.order.create({
      data: {
        accountId: locked.id,
        practicePeriodId: periodId,
        instrumentId: instrument.id,
        side: input.action,
        type: "MARKET",
        quantity,
        status: "OPEN",
        idempotencyKey: key,
      },
    });
    await fillLocked(tx, locked, order.id, premium, charges, {
      mode: "HISTORICAL",
      source: `${REPLAY_POLICY} · ${candleClock} IST candle · ${date} · session ${input.session}`,
      asOf: new Date(quote.candleEnd! * 1000),
      message: "Filled from historical 1-minute option data at the replay time. No order was sent to a broker.",
      executedAt: new Date(input.cursor * 1000),
    });
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { instrument: true, executions: true } });
    return { order: fresh, replayed: false, quote };
  });
}

/** True when the server premium differs from what the user reviewed by more than 5% and more than ₹0.50. */
export function premiumMoved(reviewed: number, latest: number) {
  const gap = Math.abs(latest - reviewed);
  return gap > 0.5 && gap / reviewed > 0.05;
}

export async function adjustFunds(actor: SessionUser, userId: string, amountPaise: bigint, reason: string, ip?: string, idempotencyKey?: string) {
  if (!reason.trim()) throw new AppError("A reason is required for a balance adjustment.");
  const account = await prisma.virtualAccount.findUnique({ where: walletKey(userId, "DEMO") });
  if (!account?.currentPeriodId) throw new AppError("Student account not found.", 404);
  if (idempotencyKey) {
    const prior = await prisma.ledgerEntry.findUnique({ where: { idempotencyKey } });
    if (prior) return account;
  }
  return ledgerTx(async (tx) => {
    const locked = await lockAccount(tx, account.id);
    if (amountPaise < 0n && locked.cashAvailable + amountPaise < 0n) {
      throw new AppError(`Available cash ${formatInr(locked.cashAvailable)} cannot cover a reduction of ${formatInr(-amountPaise)}. Open positions and reserved orders are left unchanged.`);
    }
    const before = locked.cashAvailable.toString();
    await postLedger(tx, locked, {
      type: "ADMIN_ADJUSTMENT",
      cashDelta: amountPaise,
      reservedDelta: 0n,
      practicePeriodId: locked.currentPeriodId as string,
      reason,
      actorId: actor.id,
      idempotencyKey: idempotencyKey ?? `adjust:${actor.id}:${account.id}:${Date.now()}:${amountPaise}`,
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
  const account = await prisma.virtualAccount.findUnique({ where: walletKey(userId, "DEMO"), include: { currentPeriod: true } });
  if (!account?.currentPeriodId || !account.currentPeriod) throw new AppError("Student account not found.", 404);
  return ledgerTx(async (tx) => {
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
