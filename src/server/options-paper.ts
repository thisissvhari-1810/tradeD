import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { formatInr } from "@/lib/money";
import { vwap } from "@/lib/market/indicators";
import {
  LIVE_BROKER_ORDER_URL,
  backtestOptions,
  contractKey,
  decideOptionOrder,
  evaluateRisk,
  evaluateSignal,
  istDayKey,
  istMinutes,
  optionCharges,
  sessionBars,
  type OptionContract,
  type Signal,
} from "@/lib/options/engine";
import type { SessionUser } from "@/server/auth";
import { loadOptionsSnapshot } from "@/server/options-market";

export function paperCapitalPaise() {
  const raw = process.env.OPTIONS_PAPER_CAPITAL_RUPEES?.trim() ?? "";
  if (/^\d+$/.test(raw) && raw !== "0") return BigInt(raw) * 100n;
  return 5_000_000n * 100n;
}

export async function optionsDesk(user: SessionUser) {
  assertSimulated();
  if (user.role !== "STUDENT" || user.status !== "ACTIVE" || !user.tradingEnabled) throw new AppError("Options practice is available on active student accounts.", 403);
  const snapshot = await loadOptionsSnapshot();
  const account = await freshAccount(user.id);
  const open = account.positions.find((position) => position.status === "OPEN") ?? null;
  const openContract = open ? snapshot.chain.find((contract) => contractKey(contract) === open.contractKey) ?? null : null;
  const signal = buildSignal(snapshot);
  const marked = markPaise(open, openContract);
  const equity = account.cashPaise + marked;
  const entryContract = signal.contract;
  const premiumPaise = entryContract?.ask != null ? rupeePaise(entryContract.ask) : 0n;
  const quantity = entryContract?.lotSize || 1;
  const chargesPaise = entryContract?.ask != null ? optionCharges("BUY", premiumPaise, quantity).total : 0n;
  const risk = evaluateRisk({
    equityPaise: equity,
    dayEntries: account.dayEntries,
    openPositions: open ? 1 : 0,
    dayRealizedPaise: account.dayRealizedPaise,
    stale: snapshot.stale,
    minutesIst: istMinutes(new Date()),
    premiumPaise,
    quantity,
    chargesPaise,
    sameContractOpen: open != null && signal.contractKey === open.contractKey,
  });
  const study = backtestOptions({
    candles5: snapshot.candles5.slice(-1_200),
    candles15: snapshot.candles15,
    lotSize: snapshot.lotSize,
    equityRupees: Number(paperCapitalPaise() / 100n),
  });
  await rememberSignal(account.id, snapshot.candles5.at(-1)?.time ?? 0, signal);
  const session = sessionBars(snapshot.candles5);
  const vwapLine = vwap(session);
  return {
    simulated: true,
    brokerOrderUrl: LIVE_BROKER_ORDER_URL,
    message: snapshot.message,
    indexSource: snapshot.indexSource,
    premiumSource: snapshot.premiumSource,
    asOf: snapshot.asOf,
    stale: snapshot.stale,
    spot: snapshot.spot,
    lotSize: snapshot.lotSize,
    lotSizeNote: snapshot.lotSizeNote,
    model: { name: "rule-baseline", status: "The rule baseline is active. No machine-learning model is trained, so none is used.", updatedAt: snapshot.asOf },
    chart: session.slice(-80).map((bar, index, rows) => {
      const sourceIndex = session.length - rows.length + index;
      return { time: bar.time, close: bar.close, vwap: vwapLine[sourceIndex] };
    }),
    chain: snapshot.chain
      .filter((contract) => Math.abs(contract.strike - snapshot.spot) <= 400)
      .map(presentContract),
    signal: presentSignal(signal),
    risk: {
      ok: risk.ok,
      reasons: risk.reasons,
      budget: formatInr(risk.budgetPaise),
      dailyLossLimit: formatInr(risk.dailyLossLimitPaise),
      remainingLoss: formatInr(risk.remainingLossPaise),
      entriesUsed: account.dayEntries,
      entryLimit: 3,
    },
    cash: formatInr(account.cashPaise),
    equity: formatInr(equity),
    unrealized: formatInr(unrealized(open, marked)),
    dayRealized: formatInr(account.dayRealizedPaise),
    position: open ? presentPosition(open, openContract) : null,
    orders: account.orders.slice(0, 12).map((order) => ({
      id: order.id,
      action: order.action,
      contractKey: order.contractKey,
      status: order.status,
      reason: order.reason,
      fill: order.fillPremiumPaise == null ? null : formatInr(order.fillPremiumPaise),
      charges: formatInr(order.chargesPaise),
      simulated: order.simulated,
      createdAt: order.createdAt.toISOString(),
    })),
    backtest: study,
  };
}

export async function placeOptionPaper(user: SessionUser, input: { action: "BUY" | "CLOSE"; idempotencyKey: string }) {
  assertSimulated();
  if (user.role !== "STUDENT" || user.status !== "ACTIVE" || !user.tradingEnabled) throw new AppError("Options practice is available on active student accounts.", 403);
  if (!/^[A-Za-z0-9:_-]{8,80}$/.test(input.idempotencyKey)) throw new AppError("Enter an idempotency key of 8 to 80 letters or numbers.");
  const snapshot = await loadOptionsSnapshot();
  const account = await freshAccount(user.id);
  const replay = account.orders.find((order) => order.idempotencyKey === input.idempotencyKey);
  if (replay) return { replayed: true, order: presentOrder(replay) };
  const signal = buildSignal(snapshot);
  const open = account.positions.find((position) => position.status === "OPEN") ?? null;
  const contract = input.action === "CLOSE"
    ? snapshot.chain.find((item) => open != null && contractKey(item) === open.contractKey) ?? null
    : signal.contract;
  const marked = markPaise(open, contract);
  const equity = account.cashPaise + marked;
  const premiumPaise = contract?.ask != null ? rupeePaise(contract.ask) : 0n;
  const quantity = contract?.lotSize || snapshot.lotSize;
  const chargesPaise = contract?.ask != null ? optionCharges("BUY", premiumPaise, quantity).total : 0n;
  const risk = evaluateRisk({
    equityPaise: equity,
    dayEntries: account.dayEntries,
    openPositions: open ? 1 : 0,
    dayRealizedPaise: account.dayRealizedPaise,
    stale: snapshot.stale,
    minutesIst: istMinutes(new Date()),
    premiumPaise,
    quantity,
    chargesPaise,
    sameContractOpen: false,
  });
  const decision = decideOptionOrder({
    action: input.action,
    signal,
    risk,
    contract,
    cashPaise: account.cashPaise,
    openContractKey: open?.contractKey ?? null,
    lots: 1,
    slippageBps: 10,
  });
  const saved = await prisma.$transaction(async (tx) => {
    const again = await tx.optionPaperOrder.findUnique({ where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: input.idempotencyKey } } });
    if (again) return again;
    const current = await tx.optionPaperAccount.findUnique({ where: { id: account.id } });
    const live = await tx.optionPaperPosition.findFirst({ where: { accountId: account.id, status: "OPEN" } });
    if (!current) throw new AppError("Simulated options account is missing.", 409);
    if (!decision.ok) {
      return tx.optionPaperOrder.create({
        data: {
          accountId: account.id,
          idempotencyKey: input.idempotencyKey,
          action: input.action,
          contractKey: contract ? contractKey(contract) : "NONE",
          lots: 1,
          quantity: contract?.lotSize ?? 0,
          status: "REJECTED",
          reason: decision.reason,
          simulated: true,
        },
      });
    }
    if (input.action === "BUY") {
      if (live) throw new AppError("Only one simulated options position can be open.", 409);
      if (!signal.contract) throw new AppError("The rule engine did not accept a trade.", 409);
      const debit = decision.fillPaise * BigInt(decision.quantity) + decision.chargesPaise;
      await tx.optionPaperAccount.update({
        where: { id: account.id },
        data: { cashPaise: current.cashPaise - debit, dayEntries: current.dayEntries + 1 },
      });
      await tx.optionPaperPosition.create({
        data: {
          accountId: account.id,
          contractKey: contractKey(signal.contract),
          side: "LONG",
          strike: signal.contract.strike,
          expiry: signal.contract.expiry,
          right: signal.contract.side,
          lots: 1,
          lotSize: signal.contract.lotSize,
          quantity: decision.quantity,
          avgPremiumPaise: decision.fillPaise,
          stopPremiumPaise: rupeePaise(signal.stop ?? 0),
          targetPremiumPaise: rupeePaise(signal.target ?? 0),
          chargesPaise: decision.chargesPaise,
          status: "OPEN",
        },
      });
      return tx.optionPaperOrder.create({
        data: {
          accountId: account.id,
          idempotencyKey: input.idempotencyKey,
          action: "BUY",
          contractKey: contractKey(signal.contract),
          lots: 1,
          quantity: decision.quantity,
          status: "FILLED",
          reason: "Simulated buy filled at the ask plus slippage. No broker received this order.",
          fillPremiumPaise: decision.fillPaise,
          chargesPaise: decision.chargesPaise,
          simulated: true,
        },
      });
    }
    if (!live || !contract) throw new AppError("There is no open simulated option to close.", 409);
    const credit = decision.fillPaise * BigInt(live.quantity) - decision.chargesPaise;
    const realized = (decision.fillPaise - live.avgPremiumPaise) * BigInt(live.quantity) - live.chargesPaise - decision.chargesPaise;
    await tx.optionPaperAccount.update({
      where: { id: account.id },
      data: { cashPaise: current.cashPaise + credit, dayRealizedPaise: current.dayRealizedPaise + realized },
    });
    await tx.optionPaperPosition.update({
      where: { id: live.id },
      data: { status: "CLOSED", exitPremiumPaise: decision.fillPaise, realizedPaise: realized, chargesPaise: live.chargesPaise + decision.chargesPaise, closedAt: new Date() },
    });
    return tx.optionPaperOrder.create({
      data: {
        accountId: account.id,
        idempotencyKey: input.idempotencyKey,
        action: "CLOSE",
        contractKey: live.contractKey,
        lots: live.lots,
        quantity: live.quantity,
        status: "FILLED",
        reason: "Simulated close filled at the bid minus slippage. No broker received this order.",
        fillPremiumPaise: decision.fillPaise,
        chargesPaise: decision.chargesPaise,
        simulated: true,
      },
    });
  });
  return { replayed: false, order: presentOrder(saved) };
}

function assertSimulated() {
  if (LIVE_BROKER_ORDER_URL !== null) throw new AppError("Live broker routing is disabled.", 500);
}

async function freshAccount(userId: string) {
  const capital = paperCapitalPaise();
  const day = istDayKey(new Date());
  let account;
  try {
    account = await prisma.optionPaperAccount.upsert({
    where: { userId },
    update: {},
    create: { userId, cashPaise: capital, dayKey: day },
    include: { positions: { orderBy: { openedAt: "desc" }, take: 20 }, orders: { orderBy: { createdAt: "desc" }, take: 20 } },
  });
  } catch (error) {
    throw missingOptionsTable(error);
  }
  if (account.dayKey === day) return account;
  return prisma.optionPaperAccount.update({
    where: { id: account.id },
    data: { dayKey: day, dayEntries: 0, dayRealizedPaise: 0n },
    include: { positions: { orderBy: { openedAt: "desc" }, take: 20 }, orders: { orderBy: { createdAt: "desc" }, take: 20 } },
  });
}

function buildSignal(snapshot: Awaited<ReturnType<typeof loadOptionsSnapshot>>) {
  return evaluateSignal({
    candles5: sessionBars(snapshot.candles5),
    candles15: snapshot.candles15,
    chain: snapshot.chain,
    spot: snapshot.spot,
    timestamp: new Date().toISOString(),
    dataTimestamp: snapshot.asOf,
    quality: snapshot.premiumSource === "dhan" ? "exchange" : "modelled",
    nowDay: istDayKey(new Date()),
  });
}

async function rememberSignal(accountId: string, barTime: number, signal: Signal) {
  const dedupeKey = `${barTime}:${signal.direction}:${signal.contractKey ?? "none"}`;
  try {
    await prisma.optionSignalLog.upsert({
    where: { accountId_dedupeKey: { accountId, dedupeKey } },
    update: {},
    create: { accountId, dedupeKey, payload: signal as unknown as Prisma.InputJsonValue },
  });
  } catch (error) {
    throw missingOptionsTable(error);
  }
}

function missingOptionsTable(error: unknown): Error {
  if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2021" || error.code === "P2022")) {
    return new AppError("The options tables are not in the database yet. Run npm run db:deploy, then reload this page.", 503);
  }
  return error instanceof Error ? error : new Error("Options desk failed.");
}

function markPaise(position: { quantity: number; avgPremiumPaise: bigint } | null, contract: OptionContract | null) {
  if (!position) return 0n;
  const price = contract?.bid ?? contract?.ltp;
  if (price == null) return position.avgPremiumPaise * BigInt(position.quantity);
  return rupeePaise(price) * BigInt(position.quantity);
}

function unrealized(position: { quantity: number; avgPremiumPaise: bigint; chargesPaise: bigint } | null, marked: bigint) {
  if (!position) return 0n;
  return marked - position.avgPremiumPaise * BigInt(position.quantity) - position.chargesPaise;
}

function presentContract(contract: OptionContract) {
  return { ...contract, key: contractKey(contract) };
}

function presentSignal(signal: Signal) {
  return {
    ...signal,
    contract: signal.contract ? presentContract(signal.contract) : null,
  };
}

function presentPosition(position: { contractKey: string; right: string; strike: number; expiry: string; quantity: number; lotSize: number; avgPremiumPaise: bigint; stopPremiumPaise: bigint; targetPremiumPaise: bigint; status: string }, contract: OptionContract | null) {
  return {
    contractKey: position.contractKey,
    right: position.right,
    strike: position.strike,
    expiry: position.expiry,
    quantity: position.quantity,
    lotSize: position.lotSize,
    average: formatInr(position.avgPremiumPaise),
    stop: formatInr(position.stopPremiumPaise),
    target: formatInr(position.targetPremiumPaise),
    mark: contract?.bid != null ? formatInr(rupeePaise(contract.bid)) : "No bid",
    status: position.status,
    simulated: true,
  };
}

function presentOrder(order: { id: string; action: string; contractKey: string; status: string; reason: string; fillPremiumPaise: bigint | null; chargesPaise: bigint; simulated: boolean }) {
  return {
    id: order.id,
    action: order.action,
    contractKey: order.contractKey,
    status: order.status,
    reason: order.reason,
    fill: order.fillPremiumPaise == null ? null : formatInr(order.fillPremiumPaise),
    charges: formatInr(order.chargesPaise),
    simulated: order.simulated,
  };
}

function rupeePaise(rupees: number) {
  return BigInt(Math.round(rupees * 100));
}
