import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { mayPractice } from "@/lib/auth/permissions";
import { kolkataParts } from "@/lib/market/clock";
import { optionCharges } from "@/lib/options/engine";
import { algoConfigProblems, readAlgoConfig, switchToChartReplay } from "@/lib/algo/config";
import { strategyLines, type AlgoLine, type Candle } from "@/lib/algo/lines";
import { createReplayAdapter, simulateSession } from "@/lib/algo/replay-adapter";
import { expiredChain, expiredTape, weeklyExpiries } from "@/lib/algo/expired-options";
import { backtestTotals, backtestTrades, missedSignals, type BacktestDay } from "@/lib/algo/backtest";
import type { AlgoRequest } from "@/lib/algo/request";
import { dhanExpiredOptions, dhanOptionSession } from "@/server/dhan-market";
import type { ChainInput, Right } from "@/lib/algo/options";
export { liveAdapter } from "@/lib/algo/live";
import { acquireLock, isAlgoStrategy, lockOwnerOf, releaseLock, STRATEGY_NAME, type AlgoStrategy, type LockStore, type OwnerActivity } from "@/lib/algo/exclusive";
import { advance, initialState, regimeStatus, startExit, ALGO_DEFAULTS, MATHI5_DEFAULTS, PRIMARY_DEFAULTS, type AlgoConfig, type AlgoEvent, type AlgoState, type ContractRef, type ExecutionAdapter, type Fill, type Mark } from "@/lib/algo/runner";
import type { SessionUser } from "@/server/auth";
import { gateFor } from "@/server/live-gate";
import { getCandles, getS1Data, sessionMinuteTape } from "@/server/market";
import { buildPlan } from "@/lib/algo/plan";
import { loadOptionChain } from "@/server/option-chain";
import { checkReplayClock, sessionTape } from "@/server/option-replay";
import { ensurePracticeAccount } from "@/server/practice-account";
import { replaySessionDate, sessionBounds } from "@/lib/options/replay-premium";
import { findIndex } from "@/lib/market/indices";
import { runScheduledChecks, type ScheduledCheck } from "@/lib/algo/monitor";
import { activationSummary, activationTrades, afterLiveTick, beforeLiveTick, endActivation, feedIsStale, liveStatus, startActivation } from "@/lib/algo/live-session";
import { randomBytes } from "node:crypto";
import { algoTrades, EXIT_LABEL, panelEvents, positionValuation, runDiagnostics, runStats, sessionComplete, skippedSignals } from "@/lib/algo/chart-replay";
import { exitChartRun, stepChartRun, walletPaperAdapter, type ChartRunInput } from "@/server/algo-replay";
import { walletKey } from "@/server/practice-account";
import { startAlgoPeriod } from "@/server/trading";
import { ALGO_STARTING_CAPITAL_PAISE } from "@/lib/algo/capital";
import { featuresOf } from "@/lib/auth/features";
import { premiumFrom } from "@/lib/premium/entitlements";
import { algoSides, getStudentBundle } from "@/server/portfolio";

/**
 * The Strategy Algo on the server: settings, the runner state, the signal / order log and the execution
 * adapters. Every algo order (paper at live prices, and chart replay) goes to the Algo wallet: its own
 * practice account on the shared ledger, opened once with ₹1,00,000 (ALGO_STARTING_CAPITAL_PAISE). The
 * options desk's paper account and the demo / live wallets never fund it. Positions opened before the Algo
 * wallet existed are closed on the account they were opened on. The quick backtest uses a virtual account
 * with the same starting capital; live execution stays unavailable (see liveAvailability).
 */

const paise = (rupees: number) => BigInt(Math.round(rupees * 100));
const rupees = (value: bigint) => Number(value) / 100;
const contractKeyOf = (contract: Pick<ContractRef, "underlying" | "expiry" | "strike" | "right">) => `${contract.underlying}|${contract.expiry}|${contract.strike}|${contract.right}`;
const todayIst = () => kolkataParts(new Date()).dateKey;
/** A readable activation session id: MS-<date>-<IST time>-<random>. */
const activationId = (now: number, prefix = "MS") => `${prefix}-${new Date((now + 19_800) * 1000).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}-${randomBytes(2).toString("hex").toUpperCase()}`;
const LEASE_MS = 45_000;

function assertAllowed(user: SessionUser) {
  if (!mayPractice(user) || user.status !== "ACTIVE" || !user.tradingEnabled) throw new AppError("Algo trading practice is available on active accounts with trading enabled.", 403);
}

/* ---------------- live: honest availability ---------------- */

/**
 * Live algo orders need the live gate (static IP, own account, broker token, live switch), a separate
 * server switch for automatic orders, and broker-side protective exits with order-status reconciliation.
 * The last is not validated yet, so live algo execution stays unavailable and says why.
 */
export async function liveAvailability(user: SessionUser, env: NodeJS.ProcessEnv = process.env) {
  const reasons: string[] = [];
  if (env.ALGO_LIVE_ENABLED !== "1") reasons.push("Automatic live orders are switched off on the server (ALGO_LIVE_ENABLED is not set).");
  const gate = await gateFor(user, env).catch(() => null);
  if (!gate) reasons.push("The live trading gate could not be checked.");
  else for (const item of gate.requirements) if (!item.met) reasons.push(`${item.label}: not met.`);
  reasons.push("Broker-side protective stop / target orders and order-status reconciliation for automatic trading are not validated yet, so live algo orders stay off.");
  return { available: false as const, reasons };
}

/* ---------------- session store ---------------- */

async function loadSession(userId: string) {
  return prisma.algoSession.upsert({
    where: { userId },
    update: {},
    create: { userId, config: ALGO_DEFAULTS as unknown as Prisma.InputJsonValue, state: initialState(todayIst()) as unknown as Prisma.InputJsonValue },
  });
}

/** Runs `task` while holding the session's short lease (two ticks never run one session at once). */
async function withLease<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const now = new Date();
  const taken = await prisma.algoSession.updateMany({ where: { id: sessionId, lockedUntil: { lt: now } }, data: { lockedUntil: new Date(now.getTime() + LEASE_MS) } });
  if (taken.count === 0) throw new AppError("The algo is busy with another update. Try again in a moment.", 409, "ALGO_BUSY");
  try {
    return await task();
  } finally {
    await prisma.algoSession.update({ where: { id: sessionId }, data: { lockedUntil: new Date() } }).catch(() => undefined);
  }
}

/* ---------------- the exclusive execution lock (Algo Trade vs Algo - Primary Strategy) ---------------- */

/** The lock's atomic store: a conditional update on the user's algo session row. */
function lockStore(sessionId: string): LockStore {
  return {
    compareAndSet: async (expected, next) => (await prisma.algoSession.updateMany({ where: { id: sessionId, activeStrategy: { in: expected } }, data: { activeStrategy: next } })).count === 1,
    read: async () => lockOwnerOf((await prisma.algoSession.findUnique({ where: { id: sessionId }, select: { activeStrategy: true } }))?.activeStrategy),
  };
}

/** What a feature still has to manage: armed replay runs, open positions, pending orders (and the paper session for Algo Trade). */
async function ownerActivity(sessionId: string, owner: AlgoStrategy): Promise<OwnerActivity> {
  const activity: OwnerActivity = { running: false, position: false, pending: false };
  for (const run of await prisma.algoRun.findMany({ where: { sessionId, strategy: owner, status: "ACTIVE" } })) {
    const state = runStateOf(run);
    activity.running ||= run.armed;
    activity.position ||= Boolean(state.position);
    activity.pending ||= Boolean(state.pending);
  }
  if (owner === "EXISTING_ALGO" || owner === "MATHI_5") {
    const session = await prisma.algoSession.findUnique({ where: { id: sessionId } });
    if (session) {
      const state = owner === "MATHI_5" ? mathi5StateOf(session) : stateOf(session);
      activity.running ||= state.running;
      activity.position ||= Boolean(state.position);
      activity.pending ||= Boolean(state.pending);
    }
  }
  return activity;
}

/**
 * Stops a feature so the other can be started (the switch dialog's "Stop" / "Exit and stop"): its replay
 * runs stop taking entries and its paper session stops. An open position is never closed silently: without
 * `exit` the stop is refused while one is open; with `exit` it is closed first at the current price (the
 * replay premium at the run's processed minute, or the live paper quote). A pending order is never touched —
 * it must be reconciled first. The lock is released only when nothing is left open.
 */
async function stopStrategy(user: SessionUser, sessionId: string, strategy: AlgoStrategy, exit: boolean) {
  const now = Math.floor(Date.now() / 1000);
  const runs = await prisma.algoRun.findMany({ where: { sessionId, strategy, status: "ACTIVE" } });
  const session = await prisma.algoSession.findUniqueOrThrow({ where: { id: sessionId } });
  const m5 = strategy === "MATHI_5";
  const paper = strategy === "EXISTING_ALGO" ? stateOf(session) : m5 ? mathi5StateOf(session) : null;
  const pending = runs.some((run) => runStateOf(run).pending) || Boolean(paper?.pending);
  if (pending) throw new AppError(`${STRATEGY_NAME[strategy]} has a pending order that is still being reconciled. Wait for it to settle, then stop it.`, 409, "ORDER_PENDING");
  const open = runs.some((run) => runStateOf(run).position) || Boolean(paper?.position);
  if (open && !exit) throw new AppError(`${STRATEGY_NAME[strategy]} has an open position. Exit it (or let it reach its stop-loss / target) before switching.`, 409, "POSITION_OPEN");
  for (const run of runs) {
    let state = runStateOf(run);
    const events: AlgoEvent[] = [];
    if (state.position && !state.position.exit) {
      const config = readAlgoConfig(run.config);
      const { date, open: sessionOpen, close } = chartBounds(run.replaySession, null);
      const exited = await exitChartRun({
        user, wallet: run.wallet === "ALGO" ? "ALGO" : "DEMO", runId: run.id, session: run.replaySession, date, config, lines: (run.lines as unknown as AlgoLine[]) ?? [],
        candles: await dayTape(run.underlying, date), chain: await runChain(config, date), sessionOpen, sessionClose: close,
        state, at: Math.min(run.processedThrough, close), reason: "MANUAL",
      });
      state = exited.state;
      events.push(...exited.events);
    }
    Object.assign(state, { running: false, entries: false });
    state.status = state.recovery ? "RECOVERY_REQUIRED" : state.position?.exit ? "EXIT_PENDING" : state.position ? "POSITION_OPEN" : "DISABLED";
    events.push({ key: `switch-stop:${now}`, time: run.processedThrough, kind: "INFO", message: `${STRATEGY_NAME[strategy]} stopped to switch strategies${state.position ? " (its exit is not confirmed yet: the position stays protected)" : ""}.` });
    await saveChartRun(run, { armed: false, state: state as unknown as Prisma.InputJsonValue }, events);
  }
  if (paper && (paper.running || paper.position)) {
    const config = m5 ? mathi5ConfigOf(session) : readAlgoConfig(session.config);
    const events: AlgoEvent[] = [];
    if (paper.position && !paper.position.exit) await startExit(paper, { sessionId: m5 ? mathi5Key(sessionId) : sessionId, sessionDate: paper.sessionDate, config, candles: [], lines: [], now, adapter: adapterFor(user, config, paper) }, "MANUAL", null, (event) => events.push({ time: now, ...event }));
    events.push(...endActivation(paper, now, "STOPPED", m5 ? STRATEGY_NAME.MATHI_5 : undefined));
    paper.status = paper.recovery ? "RECOVERY_REQUIRED" : paper.position ? "POSITION_OPEN" : "DISABLED";
    events.push({ key: `switch-stop:${now}`, time: now, kind: "INFO", message: "Session stopped to switch strategies." });
    if (m5) {
      await tagClosedTrades(user.id, paper, events, config, STRATEGY_NAME.MATHI_5);
      await saveMathi5(sessionId, paper, events);
    } else await saveRun(sessionId, paper, events, "PAPER");
  }
  const released = await freeLock(sessionId, strategy);
  if (!released && lockOwnerOf((await prisma.algoSession.findUnique({ where: { id: sessionId }, select: { activeStrategy: true } }))?.activeStrategy) === strategy) {
    throw new AppError(`${STRATEGY_NAME[strategy]} is stopped, but its exit has not been confirmed yet, so it still holds the lock. Try again once the exit has filled.`, 409, "EXIT_PENDING");
  }
}

/** Takes the lock for `strategy` or refuses with the reason (another feature is running). */
async function takeLock(sessionId: string, strategy: AlgoStrategy) {
  const result = await acquireLock(lockStore(sessionId), strategy, (owner) => ownerActivity(sessionId, owner));
  if (!result.ok) throw new AppError(result.reason, 409, "ALGO_LOCKED");
}

/** Releases `strategy`'s lock once it has nothing left to manage (a no-op otherwise). */
async function freeLock(sessionId: string, strategy: AlgoStrategy) {
  return releaseLock(lockStore(sessionId), strategy, await ownerActivity(sessionId, strategy));
}

/** Algo - Primary Strategy's own saved settings (or its defaults): always its engine, always chart replay. */
function primaryConfigOf(session: { primaryConfig: Prisma.JsonValue | null }): AlgoConfig {
  const saved = session.primaryConfig && typeof session.primaryConfig === "object" ? session.primaryConfig : PRIMARY_DEFAULTS;
  return { ...readAlgoConfig(saved), engine: "primary", mode: "REPLAY" };
}

/** Mathi 5%'s own saved settings (or its defaults: Mathi Strategy v18 with a +5% target); live paper trading. */
function mathi5ConfigOf(session: { mathi5Config: Prisma.JsonValue | null }): AlgoConfig {
  const saved = session.mathi5Config && typeof session.mathi5Config === "object" ? session.mathi5Config : MATHI5_DEFAULTS;
  return { ...readAlgoConfig(saved), engine: "existing", mode: "PAPER" };
}

/** Mathi 5%'s live paper-trading state (its own, never Mathi Strategy's). */
function mathi5StateOf(row: { mathi5State: Prisma.JsonValue }): AlgoState {
  const raw = (row.mathi5State && typeof row.mathi5State === "object" ? row.mathi5State : {}) as Partial<AlgoState>;
  return { ...initialState(todayIst()), ...raw };
}

/** Mathi 5%'s order keys, stored events and run id: its own, so they never meet Mathi Strategy's. */
const mathi5Key = (sessionId: string) => `${sessionId}:M5`;
const MATHI5_MODE = "MATHI_5";
const MATHI5_RUN = "M5";

async function saveMathi5(sessionId: string, state: AlgoState, events: AlgoEvent[]) {
  await prisma.$transaction([
    prisma.algoSession.update({ where: { id: sessionId }, data: { mathi5State: state as unknown as Prisma.InputJsonValue } }),
    ...(events.length ? [prisma.algoEvent.createMany({ data: events.map((event) => ({ sessionId, mode: MATHI5_MODE, runId: MATHI5_RUN, key: event.key, time: Math.floor(event.time), kind: event.kind, payload: event as unknown as Prisma.InputJsonValue })), skipDuplicates: true })] : []),
  ]);
}

function configFor(session: { config: Prisma.JsonValue; primaryConfig: Prisma.JsonValue | null; mathi5Config: Prisma.JsonValue | null }, strategy: AlgoStrategy): AlgoConfig {
  // The chart replay (Demo) runs Mathi 5% with its own settings on the replay clock.
  if (strategy === "MATHI_5") return { ...mathi5ConfigOf(session), mode: "REPLAY" };
  return strategy === "PRIMARY_STRATEGY" ? primaryConfigOf(session) : { ...readAlgoConfig(session.config), engine: "existing" };
}

const strategyOf = (value: unknown): AlgoStrategy => (isAlgoStrategy(value) ? value : "EXISTING_ALGO");

async function saveRun(sessionId: string, state: AlgoState, events: AlgoEvent[], mode: string, runId = "") {
  await prisma.$transaction([
    prisma.algoSession.update({ where: { id: sessionId }, data: { state: state as unknown as Prisma.InputJsonValue } }),
    ...(events.length ? [prisma.algoEvent.createMany({ data: events.map((event) => ({ sessionId, mode, runId, key: event.key, time: Math.floor(event.time), kind: event.kind, payload: event as unknown as Prisma.InputJsonValue })), skipDuplicates: true })] : []),
  ]);
}

/* ---------------- paper adapter (the options paper ledger) ---------------- */

async function paperAccountId(userId: string) {
  // Legacy positions only: the options desk's account already exists for them; it is never opened for the algo.
  const account = await prisma.optionPaperAccount.findUnique({ where: { userId } });
  if (!account) throw new AppError("The options paper account for this earlier algo position was not found.", 409, "NO_LEGACY_ACCOUNT");
  return account.id;
}

function fillOf(order: { status: string; reason: string; quantity: number; fillPremiumPaise: bigint | null; chargesPaise: bigint }): Fill {
  if (order.status === "FILLED" && order.fillPremiumPaise != null) return { status: "FILLED", quantity: order.quantity, price: rupees(order.fillPremiumPaise), charges: rupees(order.chargesPaise) };
  if (order.status === "REJECTED") return { status: "REJECTED", reason: order.reason || "Rejected." };
  return { status: "PENDING" };
}

function chainInput(view: Awaited<ReturnType<typeof loadOptionChain>>): ChainInput {
  return { underlying: view.symbol, spot: view.spot, expiry: view.expiry, asOf: view.asOf, lotSize: view.lotSize, strikes: view.strikes.map((row) => ({ strike: row.strike, ce: row.ce, pe: row.pe })) };
}

/**
 * Legacy: simulated execution on the options desk's paper ledger, used only to protect and close a position
 * the algo opened there before it had its own wallet (see adapterFor). Fills use the real option-chain quote: a buy pays the
 * ask plus the configured slippage, a sell gets the bid less it (the runner sets the price), with the
 * educational charges model. Cash, the order and the position change in one transaction, keyed by the
 * order's idempotency key, so a repeated request returns the first result.
 */
const OPTION_MINUTES_TTL_MS = 15_000;
const optionMinuteCache = new Map<string, { at: number; candles: Candle[] }>();

/** Today's 1-minute candles of one listed option contract (cached briefly; one provider request per contract and 15 s). */
async function optionMinutes(contract: ContractRef, now: number): Promise<Candle[]> {
  const cached = optionMinuteCache.get(contract.securityId);
  if (cached && Date.now() - cached.at < OPTION_MINUTES_TTL_MS) return cached.candles;
  const bounds = sessionBounds(todayIst());
  if (!bounds) return [];
  const { open, close } = bounds;
  const candles =(await dhanOptionSession(contract.securityId, findIndex(contract.underlying) ? "index" : "equity", open, close)).filter((candle) => candle.time >= open && candle.time < close && candle.time <= now);
  optionMinuteCache.set(contract.securityId, { at: Date.now(), candles });
  return candles;
}

export function paperAdapter(userId: string, config: AlgoConfig): ExecutionAdapter {
  let accountId: string | null = null;
  const account = async () => (accountId ??= await paperAccountId(userId));
  return {
    kind: "paper",
    async health() {
      return { ok: true };
    },
    async cash() {
      const row = await prisma.optionPaperAccount.findUnique({ where: { id: await account() } });
      return row ? rupees(row.cashPaise) : 0;
    },
    charges(side, premium, quantity) {
      return rupees(optionCharges(side, paise(premium), quantity).total);
    },
    async chain(_right: Right, expiry: string) {
      return chainInput(await loadOptionChain(config.underlying, expiry === "nearest" ? null : expiry));
    },
    async mark(contract, now) {
      // The live quote (option chain snapshot) and the option's own completed 1-minute candles: the candles let the
      // monitor see a target or stop reached between two checks; either one alone is still used.
      const [view, candles] = await Promise.all([loadOptionChain(contract.underlying, contract.expiry).catch(() => null), optionMinutes(contract, now).catch(() => null)]);
      const row = view?.strikes.find((item) => item.strike === contract.strike);
      const side = contract.right === "CE" ? row?.ce : row?.pe;
      const age = view ? (Date.now() - new Date(view.asOf).getTime()) / 1000 : Infinity;
      const quote = side && side.bid != null && age <= config.maxQuoteAgeSeconds ? side : null;
      if (!quote && !candles?.length) return null;
      return { bid: quote?.bid ?? null, ask: quote?.ask ?? null, candle: null, asOf: view && quote ? Math.floor(new Date(view.asOf).getTime() / 1000) : now, ...(candles ? { candles } : {}) } satisfies Mark;
    },
    async enter(order) {
      const id = await account();
      const chargesPaise = optionCharges("BUY", paise(order.price), order.quantity).total;
      const costPaise = paise(order.price) * BigInt(order.quantity) + chargesPaise;
      try {
        return await prisma.$transaction(async (tx) => {
          const again = await tx.optionPaperOrder.findUnique({ where: { accountId_idempotencyKey: { accountId: id, idempotencyKey: order.key } } });
          if (again) return fillOf(again);
          const current = await tx.optionPaperAccount.findUnique({ where: { id } });
          const base = { accountId: id, idempotencyKey: order.key, source: "algo", action: "BUY", contractKey: contractKeyOf(order.contract), lots: Math.round(order.quantity / order.contract.lotSize), quantity: order.quantity, simulated: true };
          if (!current || current.cashPaise < costPaise) {
            await tx.optionPaperOrder.create({ data: { ...base, status: "REJECTED", reason: "Insufficient simulated buying power." } });
            return { status: "REJECTED", reason: "Insufficient simulated buying power." } satisfies Fill;
          }
          await tx.optionPaperOrder.create({ data: { ...base, status: "FILLED", reason: "Algo entry (simulated)", fillPremiumPaise: paise(order.price), chargesPaise } });
          await tx.optionPaperPosition.create({
            data: {
              accountId: id, source: "algo", contractKey: contractKeyOf(order.contract), side: "LONG", strike: Math.round(order.contract.strike), expiry: order.contract.expiry, right: order.contract.right,
              lots: base.lots, lotSize: order.contract.lotSize, quantity: order.quantity, avgPremiumPaise: paise(order.price), stopPremiumPaise: 0n, targetPremiumPaise: 0n, chargesPaise, status: "OPEN",
            },
          });
          await tx.optionPaperAccount.update({ where: { id }, data: { cashPaise: { decrement: costPaise } } });
          return { status: "FILLED", quantity: order.quantity, price: order.price, charges: rupees(chargesPaise) } satisfies Fill;
        });
      } catch (error) {
        // A concurrent request with the same key already wrote the order: report that one.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return (await this.lookup(order.key)) ?? { status: "UNKNOWN", reason: "Duplicate request." };
        throw error;
      }
    },
    async exit(order) {
      const id = await account();
      return prisma.$transaction(async (tx) => {
        const again = await tx.optionPaperOrder.findUnique({ where: { accountId_idempotencyKey: { accountId: id, idempotencyKey: order.key } } });
        if (again) return fillOf(again);
        const position = await tx.optionPaperPosition.findFirst({ where: { accountId: id, source: "algo", status: "OPEN", contractKey: contractKeyOf(order.contract) }, orderBy: { openedAt: "desc" } });
        const base = { accountId: id, idempotencyKey: order.key, source: "algo", action: "SELL", contractKey: contractKeyOf(order.contract), lots: Math.max(1, Math.round(order.quantity / order.contract.lotSize)), quantity: order.quantity, simulated: true };
        if (!position) {
          await tx.optionPaperOrder.create({ data: { ...base, status: "REJECTED", reason: "No open algo position for this contract." } });
          return { status: "REJECTED", reason: "No open algo position for this contract." } satisfies Fill;
        }
        const quantity = Math.min(order.quantity, position.quantity);
        const chargesPaise = optionCharges("SELL", paise(order.price), quantity).total;
        const share = (position.chargesPaise * BigInt(quantity)) / BigInt(Math.max(1, position.quantity));
        const realized = (paise(order.price) - position.avgPremiumPaise) * BigInt(quantity) - share - chargesPaise;
        await tx.optionPaperOrder.create({ data: { ...base, quantity, status: "FILLED", reason: `Algo exit: ${order.reason} (simulated)`, fillPremiumPaise: paise(order.price), chargesPaise } });
        const left = position.quantity - quantity;
        await tx.optionPaperPosition.update({
          where: { id: position.id },
          data: { quantity: left, chargesPaise: position.chargesPaise - share, realizedPaise: { increment: realized }, ...(left === 0 ? { status: "CLOSED", exitPremiumPaise: paise(order.price), closedAt: new Date() } : {}) },
        });
        await tx.optionPaperAccount.update({ where: { id }, data: { cashPaise: { increment: paise(order.price) * BigInt(quantity) - chargesPaise } } });
        return { status: "FILLED", quantity, price: order.price, charges: rupees(chargesPaise) } satisfies Fill;
      });
    },
    async lookup(key) {
      const order = await prisma.optionPaperOrder.findUnique({ where: { accountId_idempotencyKey: { accountId: await account(), idempotencyKey: key } } });
      return order ? fillOf(order) : null;
    },
  };
}

/** Positions and pending orders opened on the Algo wallet carry wallet "ALGO"; anything else is legacy. */
function onLegacyAccount(state: AlgoState) {
  return Boolean((state.position && state.position.wallet !== "ALGO") || (state.pending && state.pending.wallet !== "ALGO"));
}

/** Live-price paper execution for this state: the Algo wallet, or the legacy account until its position is closed. */
function adapterFor(user: SessionUser, config: AlgoConfig, state: AlgoState): ExecutionAdapter {
  const legacy = paperAdapter(user.id, config);
  return onLegacyAccount(state) ? legacy : walletPaperAdapter(user, legacy);
}

/** Tags what the Algo wallet adapter opened, so later ticks keep using the Algo wallet for it. */
function tagWallet(state: AlgoState, legacy: boolean) {
  if (legacy) return;
  if (state.position && !state.position.wallet) state.position.wallet = "ALGO";
  if (state.pending && !state.pending.wallet) state.pending.wallet = "ALGO";
}

/** The Algo wallet's balances, from the same ledger summary Portfolio and Home use. */
async function algoWallet(userId: string) {
  const bundle = await getStudentBundle(userId, "ALGO");
  return {
    startingCapital: bundle.startingCapital,
    cashAvailable: bundle.cashAvailable,
    cashReserved: bundle.cashReserved,
    holdingsValue: bundle.holdingsValue,
    unrealized: bundle.unrealized,
    realized: bundle.realized,
    realizedToday: bundle.realizedToday,
    charges: bundle.charges,
    equity: bundle.equity,
    /** Total P&L = equity − starting capital (realized + unrealized, after charges; never counted twice). */
    netPnl: bundle.netPnl,
    completedTrades: bundle.completedTrades,
    sides: await algoSides(userId, bundle.positions),
  };
}

/* ---------------- historical replay adapter ---------------- */

/**
 * Replays a past session with real data only: the underlying's 1-minute candles drive the signals and
 * each option's own 1-minute premium candles price it. Fill model: the signal is known when its candle
 * closes, so the entry uses that minute's option close (plus slippage); exits use each later option
 * candle (gaps fill at the open; a candle reaching both stop and target takes the stop). Historical bid /
 * ask are not available, so the candle close stands for both and the spread check cannot apply. A virtual
 * account is used: nothing is written to the paper ledger, and no order goes anywhere.
 */
export function replayAdapter(input: { underlying: string; date: string; candles: Candle[]; chain: Awaited<ReturnType<typeof loadOptionChain>>; config: AlgoConfig; capital: number }): ExecutionAdapter & { setClock: (now: number) => void } {
  // Premiums from the listed contracts' own 1-minute history.
  return createReplayAdapter({
    candles: input.candles, chain: input.chain, config: input.config, capital: input.capital,
    tapeOf: (contract) => sessionTape({ underlying: contract.underlying, name: contract.underlying, expiry: contract.expiry, strike: contract.strike, right: contract.right, securityId: contract.securityId, kind: input.chain.kind, lotSize: contract.lotSize }, input.date, new Date()),
  });
}

/* ---------------- view ---------------- */

function stateOf(row: { state: Prisma.JsonValue }): AlgoState {
  const raw = (row.state && typeof row.state === "object" ? row.state : {}) as Partial<AlgoState>;
  return { ...initialState(todayIst()), ...raw };
}

/** Everything the Algo panel shows, for the signed-in user. */
export async function algoView(user: SessionUser, chartSession: string | null = null) {
  assertAllowed(user);
  const session = await loadSession(user.id);
  const config = readAlgoConfig(session.config);
  const state = stateOf(session);
  const live = await liveAvailability(user);
  let lines: ReturnType<typeof strategyLines> = [];
  let levelsMessage = "";
  try {
    const data = await getS1Data(config.underlying);
    lines = strategyLines(data, config.custom);
    levelsMessage = data.message;
  } catch (error) {
    levelsMessage = error instanceof Error ? error.message : "The strategy levels could not be loaded.";
  }
  let mark: Mark | null = null;
  if (state.position) mark = await paperAdapter(user.id, config).mark(state.position.contract, Math.floor(Date.now() / 1000)).catch(() => null);
  // Opening the Algo panel opens the Algo wallet (once, with its starting capital) so every figure is the ledger's.
  const wallet = await algoWallet(user.id);
  const unrealized = state.position && mark?.bid != null ? Math.round(((mark.bid - state.position.avg) * state.position.quantity - state.position.entryCharges) * 100) / 100 : null;
  const [events, replays] = await Promise.all([
    prisma.algoEvent.findMany({ where: { sessionId: session.id, mode: "PAPER" }, orderBy: [{ time: "desc" }, { createdAt: "desc" }], take: 150 }),
    prisma.algoEvent.findMany({ where: { sessionId: session.id, mode: "REPLAY" }, orderBy: [{ createdAt: "desc" }], take: 400 }),
  ]);
  const latestRun = replays[0]?.runId ?? null;
  const primaryConfig = primaryConfigOf(session);
  const liveSession = await liveSessionView(session.id, config, state, unrealized);
  const mathi5 = await mathi5View(user, session);
  const owner = lockOwnerOf(session.activeStrategy);
  return {
    config,
    problems: algoConfigProblems(config),
    /** Algo - Primary Strategy's own settings and their problems. */
    primaryConfig,
    primaryProblems: algoConfigProblems(primaryConfig),
    /** The exclusive execution lock: its owner and what that owner still has open. */
    lock: { owner, activity: owner === "NONE" ? null : await ownerActivity(session.id, owner) },
    state,
    live,
    lines: lines.map((line) => ({ ...line, enabled: !config.disabledLines.includes(line.type) })),
    levelsMessage,
    position: state.position ? { ...state.position, bid: mark?.bid ?? null, ask: mark?.ask ?? null, unrealized, markedAt: mark?.asOf ?? null } : null,
    events: events.map((event) => event.payload as unknown as AlgoEvent),
    replay: latestRun ? { runId: latestRun, events: replays.filter((event) => event.runId === latestRun).map((event) => event.payload as unknown as AlgoEvent).sort((a, b) => a.time - b.time) } : null,
    /** Live demo: the Mathi Strategy activation session, its trades and status, and the earlier sessions. */
    liveSession,
    /** Mathi 5%: its settings, live paper session, open trade and recent events (its own, apart from Mathi Strategy's). */
    mathi5,
    /** The Algo wallet (paper and chart replay). A position from before the wallet existed is flagged. */
    account: { ...wallet, legacyPosition: onLegacyAccount(state) },
    ...(await chartView(user, session.id, chartSession)),
    monitoring: "The algo checks completed candles and its open position each time TradeD runs a check: while this page is open (every 15 seconds), or from the server scheduler when one is configured. Stop-loss and target are watched by TradeD, not held at a broker, so they are not guaranteed protection; exits fill at the quote available when checked.",
  };
}

/**
 * The live demo monitor: the current (or latest) activation session with its status, entries used, the trades
 * entered in it (from the stored order events — the source of truth) and its P&L, plus the earlier sessions.
 */
async function liveSessionView(sessionId: string, config: AlgoConfig, state: AlgoState, unrealized: number | null, source: { mode: string; runId: string } = { mode: "PAPER", runId: "" }) {
  const now = Math.floor(Date.now() / 1000);
  const current = state.activation ?? null;
  const earlier = (state.activations ?? []).filter((item) => item.id !== current?.id).slice(0, 5);
  const shown = [...(current ? [current] : []), ...earlier];
  const since = shown.length ? Math.min(...shown.map((item) => item.startedAt)) : null;
  const rows = since == null ? [] : await prisma.algoEvent.findMany({ where: { sessionId, mode: source.mode, runId: source.runId, time: { gte: since - 300 } }, orderBy: [{ time: "asc" }, { createdAt: "asc" }], take: 5_000 });
  const events = rows.map((event) => event.payload as unknown as AlgoEvent);
  // When each entry was recorded (stored), which places it in the activation that made it.
  const recordedAt = new Map(rows.flatMap((row, index) => (events[index].kind === "ENTRY" && events[index].order ? [[events[index].order!.key, Math.floor(row.createdAt.getTime() / 1000)] as const] : [])));
  const open = state.position ? { entryKey: state.position.entryKey, exitPending: Boolean(state.position.exit) } : null;
  const all = algoTrades(events, open);
  const running = Boolean(current && current.endedAt == null && state.running);
  const feedStale = running && feedIsStale(state.lastCandle, current?.startedAt ?? null, now);
  const tradesOf = (item: NonNullable<typeof current>) => activationTrades(all, item, recordedAt);
  const currentTrades = current ? tradesOf(current) : [];
  const openHere = currentTrades.some((trade) => trade.status !== "COMPLETED");
  return {
    status: liveStatus(state, config, feedStale),
    /** Regime switch: real entries (on) or shadow trades only (off), with the reason. */
    regime: regimeStatus(state, config),
    feedStale,
    lastCandle: state.lastCandle,
    lastSignal: state.lastSignal ? { time: state.lastSignal.time, decision: state.lastSignal.decision } : null,
    activation: current,
    trades: currentTrades,
    summary: activationSummary(currentTrades, config.maxTrades, openHere ? unrealized : null),
    /** An open position entered before the current activation (it is still managed; it blocks new entries). */
    carriedPosition: Boolean(state.position && !openHere),
    previous: earlier.map((item) => ({ activation: item, summary: activationSummary(tradesOf(item), config.maxTrades, null) })),
  };
}

/** The Mathi 5% panel: settings, the live paper session (status, regime, trades, P&L) and the open trade's premium. */
async function mathi5View(user: SessionUser, session: Prisma.AlgoSessionGetPayload<object>) {
  const config = mathi5ConfigOf(session);
  const state = mathi5StateOf(session);
  let mark: Mark | null = null;
  if (state.position) mark = await paperAdapter(user.id, config).mark(state.position.contract, Math.floor(Date.now() / 1000)).catch(() => null);
  const unrealized = state.position && mark?.bid != null ? Math.round(((mark.bid - state.position.avg) * state.position.quantity - state.position.entryCharges) * 100) / 100 : null;
  const events = await prisma.algoEvent.findMany({ where: { sessionId: session.id, mode: MATHI5_MODE, runId: MATHI5_RUN }, orderBy: [{ time: "desc" }, { createdAt: "desc" }], take: 150 });
  return {
    config,
    problems: algoConfigProblems(config),
    state,
    position: state.position ? { ...state.position, bid: mark?.bid ?? null, ask: mark?.ask ?? null, unrealized, markedAt: mark?.asOf ?? null } : null,
    liveSession: await liveSessionView(session.id, config, state, unrealized, { mode: MATHI5_MODE, runId: MATHI5_RUN }),
    events: events.map((event) => event.payload as unknown as AlgoEvent),
  };
}

/* ---------------- commands ---------------- */

export type AlgoCommand =
  | { action: "save"; config: unknown; strategy?: AlgoStrategy }
  | { action: "start" }
  | { action: "stop" }
  | { action: "entries"; enabled: boolean }
  | { action: "exit" }
  | { action: "emergency" }
  | { action: "acknowledge" }
  | { action: "tick" }
  | { action: "chartMode" }
  | { action: "stopStrategy"; strategy: AlgoStrategy; exit: boolean }
  | { action: "replay"; date: string }
  | { action: "mathi5"; op: "start" | "stop" | "tick" | "exit" }
  | ChartCommand;

/** The Algo inside the chart's replay (see chartCommand). */
export type ChartCommand =
  | { action: "chartArm"; session: string; cursor: number; strategy?: AlgoStrategy }
  | { action: "chartStep"; session: string; cursor: number }
  | { action: "chartExit"; session: string; cursor: number; emergency?: boolean }
  | { action: "chartDisarm"; session: string }
  | { action: "chartReset"; session: string }
  | { action: "chartFinalize"; session: string };

export async function algoCommand(user: SessionUser, command: AlgoCommand) {
  assertAllowed(user);
  const session = await loadSession(user.id);
  if (command.action === "replay") return withLease(session.id, () => runReplay(user, session.id, command.date)).then(() => algoView(user));
  if (command.action === "stopStrategy") {
    await withLease(session.id, () => stopStrategy(user, session.id, command.strategy, command.exit));
    return algoView(user);
  }
  if ("session" in command) {
    await withLease(session.id, () => chartCommandLocked(user, session, command));
    return algoView(user, command.session);
  }
  if (command.action === "mathi5") {
    await withLease(session.id, () => mathi5Command(user, session.id, command.op));
    return algoView(user);
  }
  await withLease(session.id, async () => {
    // Read again under the lease: a scheduler check may have changed the session since it was loaded above.
    const current = await prisma.algoSession.findUniqueOrThrow({ where: { id: session.id } });
    const config = readAlgoConfig(current.config);
    const state = stateOf(current);
    const events: AlgoEvent[] = [];
    const now = Math.floor(Date.now() / 1000);
    const note = (key: string, message: string, kind: AlgoEvent["kind"] = "INFO") => events.push({ key: `${key}:${now}`, time: now, kind, message });
    switch (command.action) {
      case "save": {
        if (command.strategy === "MATHI_5") {
          const next: AlgoConfig = { ...readAlgoConfig(command.config), engine: "existing", mode: "PAPER" };
          const problems = algoConfigProblems(next);
          if (problems.length) throw new AppError(problems.join(" "), 400, "INVALID_ALGO_SETTINGS");
          if (mathi5StateOf(current).position && next.underlying !== mathi5ConfigOf(current).underlying) throw new AppError("Exit the open Mathi 5% position before changing the underlying.", 409);
          await prisma.algoSession.update({ where: { id: session.id }, data: { mathi5Config: next as unknown as Prisma.InputJsonValue } });
          note("settings-m5", "Mathi 5% settings saved.");
          break;
        }
        if (command.strategy === "PRIMARY_STRATEGY") {
          const primary: AlgoConfig = { ...readAlgoConfig(command.config), engine: "primary", mode: "REPLAY" };
          const problems = algoConfigProblems(primary);
          if (problems.length) throw new AppError(problems.join(" "), 400, "INVALID_ALGO_SETTINGS");
          await prisma.algoSession.update({ where: { id: session.id }, data: { primaryConfig: primary as unknown as Prisma.InputJsonValue } });
          note("settings-primary", "Algo - Primary Strategy settings saved.");
          break;
        }
        const next: AlgoConfig = { ...readAlgoConfig(command.config), engine: "existing" };
        const problems = algoConfigProblems(next);
        if (problems.length) throw new AppError(problems.join(" "), 400, "INVALID_ALGO_SETTINGS");
        if (next.mode === "LIVE") throw new AppError(`Live algo trading is unavailable: ${(await liveAvailability(user)).reasons.join(" ")}`, 409, "LIVE_UNAVAILABLE");
        if (state.position && next.underlying !== config.underlying) throw new AppError("Exit the open position before changing the underlying.", 409);
        await prisma.algoSession.update({ where: { id: session.id }, data: { config: next as unknown as Prisma.InputJsonValue } });
        note("settings", "Settings saved.");
        break;
      }
      case "start": {
        const problems = algoConfigProblems(config);
        if (problems.length) throw new AppError(problems.join(" "), 400, "INVALID_ALGO_SETTINGS");
        if (config.mode !== "PAPER") throw new AppError(config.mode === "LIVE" ? "Live algo trading is unavailable." : "Historical replay runs from the Replay button, not as a session.", 409);
        // Switching ON again while it runs (a double click, a retried request) never starts a second activation.
        if (state.running && state.activation && state.activation.endedAt == null) break;
        // Only one algo feature may place orders: the lock is taken before any candle is evaluated.
        await takeLock(session.id, "EXISTING_ALGO");
        // Each session has its own ₹1,00,000 ledger: a trade still open from the previous session must close first
        // (it belongs to that session's ledger), so a new session never starts beside it.
        if (state.position || state.pending) throw new AppError("A trade from the previous session is still open. Let it reach its exit (or use Exit position) before starting a new session with fresh capital.", 409, "POSITION_OPEN");
        // A fresh ₹1,00,000 virtual ledger for this session (a new Algo-wallet period; earlier periods and their trades
        // are kept). An unused period is reused, so a retried start never allocates twice.
        const period = await startAlgoPeriod(user.id, "Live demo algo session started");
        // A new activation session with a fresh entry allowance. Starting mid-session never trades history:
        // evaluation begins from the latest completed candle.
        const id = activationId(now);
        events.push(...startActivation(state, now, id, todayIst(), config.maxTrades));
        state.activation = { ...state.activation!, periodId: period.periodId, capital: Number(period.cashPaise) / 100 };
        break;
      }
      case "stop":
        // Stop Strategy: no new entries from now. An open position is not closed: it stays managed by its exit
        // rules (target, time limit, session end) and visible until it closes, or until it is exited by hand.
        events.push(...endActivation(state, now, "STOPPED"));
        note("stop", state.position ? "Mathi Strategy stopped — POSITION OPEN: no new entries; the open position stays managed until it exits." : state.pending ? "Mathi Strategy stopped: no new entries. An order sent before the stop is still being reconciled." : "Mathi Strategy stopped: no new entries.");
        break;
      case "entries":
        state.entries = command.enabled && state.running;
        note("entries", command.enabled ? "New entries enabled." : "New entries disabled. An open position stays protected by its stop-loss and target.");
        break;
      case "exit":
      case "emergency": {
        if (command.action === "emergency") { state.entries = false; note("emergency", "Emergency stop: new entries blocked; exiting any open position.", "ERROR"); }
        if (state.position) {
          await startExit(state, { sessionId: session.id, sessionDate: state.sessionDate, config, candles: [], lines: [], now, adapter: adapterFor(user, config, state) }, command.action === "emergency" ? "EMERGENCY" : "MANUAL", null, (event) => events.push({ time: now, ...event }));
        } else if (command.action === "exit") throw new AppError("There is no open algo position.", 409);
        break;
      }
      case "chartMode": {
        const switched = switchToChartReplay(config, state);
        if (!switched.ok) throw new AppError(switched.reason, 409, "POSITION_OPEN");
        if (switched.config !== config) await prisma.algoSession.update({ where: { id: session.id }, data: { config: switched.config as unknown as Prisma.InputJsonValue } });
        if (switched.stopped) {
          Object.assign(state, { running: false, entries: false });
          note("mode-stop", "Live-price paper session stopped: the Algo now follows the chart replay.");
        }
        note("mode", "Execution mode: Chart replay (historical paper trading on the Algo account, on the replay clock).");
        break;
      }
      case "acknowledge":
        if (state.pending || state.position?.exit) throw new AppError("An order is still being reconciled; it cannot be acknowledged yet.", 409);
        state.recovery = null;
        note("ack", "Recovery acknowledged.");
        break;
      case "tick":
        break;
    }
    if (command.action === "tick" || command.action === "start") {
      const ran = await runTick(user, session.id, config, state);
      await saveRun(session.id, ran.state, [...events, ...ran.events], "PAPER");
      await syncPaperLevels(user.id, ran.state);
      await freeLock(session.id, "EXISTING_ALGO");
      return;
    }
    state.status = state.recovery ? "RECOVERY_REQUIRED" : state.position ? "POSITION_OPEN" : state.running ? (state.entries ? "MONITORING" : "READY") : "DISABLED";
    await saveRun(session.id, state, events, "PAPER");
    await syncPaperLevels(user.id, state);
    // A stopped session with nothing open releases the execution lock.
    await freeLock(session.id, "EXISTING_ALGO");
  });
  return algoView(user);
}

/** One paper tick: today's strategy levels and 1-minute candles through the runner. */
async function runTick(user: SessionUser, sessionId: string, config: AlgoConfig, state: AlgoState, source: CheckSource = "browser") {
  if (!state.running && !state.position && !state.pending) return { state, events: [] as AlgoEvent[] };
  const today = todayIst();
  const now = Math.floor(Date.now() / 1000);
  // An activation from an earlier day ends before anything is evaluated (its allowance was for that session).
  const before = beforeLiveTick(state, today, now);
  if (!state.running && !state.position && !state.pending) return { state, events: before };
  const data = await getS1Data(config.underlying);
  // Before today's session (or on a closed day) the levels belong to an earlier day: nothing is evaluated.
  const candles = data.date === today ? await sessionMinuteTape(config.underlying, today) : [];
  const lines = data.date === today ? strategyLines(data, config.custom) : [];
  const legacy = onLegacyAccount(state);
  const adapter = adapterFor(user, config, state);
  // New entries only while Algo Trade owns the execution lock; otherwise the open position is only protected.
  const lockEvents: AlgoEvent[] = [];
  if (state.running && state.entries) {
    const got = await acquireLock(lockStore(sessionId), "EXISTING_ALGO", (owner) => ownerActivity(sessionId, owner));
    if (!got.ok) {
      state.entries = false;
      const now = Math.floor(Date.now() / 1000);
      lockEvents.push({ key: `lock-lost:${now}`, time: now, kind: "REJECTED", message: `New entries stopped: ${got.reason}` });
    }
  }
  // A legacy position is only protected and closed on its old account: no new entry is ever made there,
  // so candles are evaluated (and entries made on the Algo wallet) from the tick after it is flat.
  const input = legacy ? { ...state, running: false } : state;
  const result = await advance(input, { sessionId, sessionDate: today, config, candles, lines, now, adapter });
  if (legacy) result.state.running = state.running;
  tagWallet(result.state, legacy);
  // The activation's entry count and its limit (entries stop at the limit; it ends once nothing is open).
  const after = afterLiveTick(result.state, config, now);
  await tagClosedTrades(user.id, result.state, result.events, config);
  stampCheck(result.state, now, source);
  return { state: result.state, events: [...before, ...lockEvents, ...result.events, ...after] };
}

/**
 * Trade History: the Algo wallet records each completed live-demo trade (its exit fill closes the position, once per
 * exit fill). The record is tagged with the algo session, the strategy and version, the exit reason and the paper
 * mode. Shadow trades (regime switch off) place no order, so they never reach Trade History.
 */
async function tagClosedTrades(userId: string, state: AlgoState, events: AlgoEvent[], config: AlgoConfig, name = "Mathi Strategy") {
  const exits = events.filter((event) => event.kind === "EXIT" && !event.shadow && event.order?.key);
  if (!exits.length) return;
  const account = await prisma.virtualAccount.findUnique({ where: walletKey(userId, "ALGO") });
  if (!account) return;
  for (const exit of exits) {
    const order = await prisma.order.findUnique({ where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: `option:${exit.order!.key}` } }, include: { executions: true } });
    const execution = order?.executions.at(-1);
    if (!execution) continue;
    const code = exit.message.match(/Exit \((\w+)\)/)?.[1] ?? "";
    const reason = EXIT_LABEL[code] ?? code;
    const session = state.activation?.id ?? "—";
    await prisma.closedTrade.updateMany({ where: { exitExecutionId: execution.id }, data: { note: `${name} v${config.settingsVersion}${name === "Mathi Strategy" ? "" : ` (+${config.target.value}% target)`} · algo session ${session} · exit: ${reason} · paper trading (live demo)` } });
  }
}

/**
 * Mathi 5% in live paper trading: Start opens a new session (a fresh ₹1,00,000 Algo-wallet period, 0 / 3 trades)
 * evaluated from the latest completed candle; Stop ends new entries (an open trade stays managed to its exit);
 * each check runs the same engine as Mathi Strategy on today's live candles, with Mathi 5%'s own settings and state.
 */
async function mathi5Command(user: SessionUser, sessionId: string, op: "start" | "stop" | "tick" | "exit") {
  const session = await prisma.algoSession.findUniqueOrThrow({ where: { id: sessionId } });
  const config = mathi5ConfigOf(session);
  const state = mathi5StateOf(session);
  const events: AlgoEvent[] = [];
  const now = Math.floor(Date.now() / 1000);
  const note = (key: string, message: string, kind: AlgoEvent["kind"] = "INFO") => events.push({ key: `${key}:${now}`, time: now, kind, message });
  const name = STRATEGY_NAME.MATHI_5;
  switch (op) {
    case "start": {
      const problems = algoConfigProblems(config);
      if (problems.length) throw new AppError(problems.join(" "), 400, "INVALID_ALGO_SETTINGS");
      // A double click or a retried request never starts a second session.
      if (state.running && state.activation && state.activation.endedAt == null) break;
      await takeLock(sessionId, "MATHI_5");
      if (state.position || state.pending) throw new AppError(`A ${name} trade from the previous session is still open. Let it reach its exit (or exit it) before starting a new session.`, 409, "POSITION_OPEN");
      const period = await startAlgoPeriod(user.id, `${name} live paper session started`);
      events.push(...startActivation(state, now, activationId(now, "M5"), todayIst(), config.maxTrades, name));
      state.activation = { ...state.activation!, periodId: period.periodId, capital: Number(period.cashPaise) / 100 };
      break;
    }
    case "stop":
      events.push(...endActivation(state, now, "STOPPED", name));
      note("m5-stop", state.position ? `${name} stopped — POSITION OPEN: no new entries; the open position stays managed until it exits.` : `${name} stopped: no new entries.`);
      break;
    case "exit":
      if (!state.position) throw new AppError(`There is no open ${name} position.`, 409);
      await startExit(state, { sessionId: mathi5Key(sessionId), sessionDate: state.sessionDate, config, candles: [], lines: [], now, adapter: adapterFor(user, config, state) }, "MANUAL", null, (event) => events.push({ time: now, ...event }));
      await tagClosedTrades(user.id, state, events, config, name);
      break;
    case "tick":
      break;
  }
  if (op === "tick" || op === "start") {
    const ran = await runMathi5Tick(user, sessionId, config, state);
    await saveMathi5(sessionId, ran.state, [...events, ...ran.events]);
  } else {
    state.status = state.recovery ? "RECOVERY_REQUIRED" : state.position ? "POSITION_OPEN" : state.running ? (state.entries ? "MONITORING" : "READY") : "DISABLED";
    await saveMathi5(sessionId, state, events);
  }
  // A stopped session with nothing open releases the execution lock.
  await freeLock(sessionId, "MATHI_5");
}

/** One Mathi 5% live paper check: Mathi Strategy's engine on today's levels and completed 1-minute candles. */
async function runMathi5Tick(user: SessionUser, sessionId: string, config: AlgoConfig, state: AlgoState, source: CheckSource = "browser") {
  if (!state.running && !state.position && !state.pending) return { state, events: [] as AlgoEvent[] };
  const name = STRATEGY_NAME.MATHI_5;
  const today = todayIst();
  const now = Math.floor(Date.now() / 1000);
  const before = beforeLiveTick(state, today, now, name);
  if (!state.running && !state.position && !state.pending) return { state, events: before };
  const data = await getS1Data(config.underlying);
  // Before today's session (or on a closed day) the levels belong to an earlier day: nothing is evaluated.
  const candles = data.date === today ? await sessionMinuteTape(config.underlying, today) : [];
  const lines = data.date === today ? strategyLines(data, config.custom) : [];
  const lockEvents: AlgoEvent[] = [];
  if (state.running && state.entries) {
    const got = await acquireLock(lockStore(sessionId), "MATHI_5", (owner) => ownerActivity(sessionId, owner));
    if (!got.ok) {
      state.entries = false;
      lockEvents.push({ key: `lock-lost:${now}`, time: now, kind: "REJECTED", message: `New entries stopped: ${got.reason}` });
    }
  }
  const result = await advance(state, { sessionId: mathi5Key(sessionId), sessionDate: today, config, candles, lines, now, adapter: adapterFor(user, config, state) });
  tagWallet(result.state, false);
  const after = afterLiveTick(result.state, config, now, undefined, name);
  await tagClosedTrades(user.id, result.state, result.events, config, name);
  stampCheck(result.state, now, source);
  return { state: result.state, events: [...before, ...lockEvents, ...result.events, ...after] };
}

/** Keeps a legacy paper position's stored stop and target equal to the runner's. */
async function syncPaperLevels(userId: string, state: AlgoState) {
  const position = state.position;
  if (!position || position.wallet === "ALGO") return;
  const account = await prisma.optionPaperAccount.findUnique({ where: { userId } });
  if (!account) return;
  await prisma.optionPaperPosition.updateMany({ where: { accountId: account.id, source: "algo", status: "OPEN", contractKey: contractKeyOf(position.contract) }, data: { stopPremiumPaise: paise(position.stop), targetPremiumPaise: paise(position.target) } });
}

export type CheckSource = "scheduler" | "browser";

/** Records when the session was last checked and by what (the open position's details are set by the runner). */
function stampCheck(state: AlgoState, now: number, source: CheckSource) {
  state.monitor = { quoteAt: null, bid: null, candlesThrough: null, target: null, problem: null, failures: 0, ...(state.monitor ?? {}), checkedAt: now, source };
  if (!state.position) Object.assign(state.monitor, { quoteAt: null, bid: null, candlesThrough: null, target: null, problem: null, failures: 0 });
}

/**
 * Checks every active paper session from the server, whether or not anyone has the page open (called by a scheduler; see
 * /api/algo/cron and docs/paper-monitoring.md). The pass itself is in runScheduledChecks: lease, read again, check.
 */
export async function tickAllSessions(): Promise<{ ran: number; checks: ScheduledCheck[] }> {
  const include = { user: { include: { subscriptions: { where: { status: "ACTIVE" as const }, orderBy: { endsAt: "desc" as const }, take: 5 } } } };
  const sessions = await prisma.algoSession.findMany({ include });
  type Row = (typeof sessions)[number];
  const userOf = (row: Row["user"]): SessionUser => ({ id: row.id, email: row.email, name: row.name, role: row.role, status: row.status, tradingEnabled: row.tradingEnabled, mfaEnabled: row.mfaEnabled, features: featuresOf(row), premium: premiumFrom(row.role, row.subscriptions ?? []), createdAt: row.createdAt });
  return runScheduledChecks<Row>(sessions, {
    id: (session) => session.id,
    strategies: ["MATHI_5", "MATHI"],
    stateOf: (session, strategy) => (strategy === "MATHI_5" ? mathi5StateOf(session) : stateOf(session)),
    withLease,
    reload: (id) => prisma.algoSession.findUniqueOrThrow({ where: { id }, include }),
    check: async (session, strategy, state) => {
      if (strategy === "MATHI_5") {
        const result = await runMathi5Tick(userOf(session.user), session.id, mathi5ConfigOf(session), state, "scheduler");
        await saveMathi5(session.id, result.state, result.events);
        return result.state;
      }
      const result = await runTick(userOf(session.user), session.id, readAlgoConfig(session.config), state, "scheduler");
      await saveRun(session.id, result.state, result.events, "PAPER");
      await syncPaperLevels(session.userId, result.state);
      return result.state;
    },
  });
}

/* ---------------- historical replay ---------------- */

/**
 * Simulates one past session with the given settings: the underlying's real 1-minute candles, each option's
 * real 1-minute premiums and a virtual account. Nothing is stored and no order goes anywhere. Used by the
 * quick backtest (stored for its log) and the multi-day backtest (returned only).
 */
/**
 * One past session simulated with the strategy engine on a virtual account. With `historical`, an index's
 * options are priced from the expired weekly contracts' own history (the contract that was really the
 * nearest that day); without it, or when that history is not published yet (the latest sessions), from the
 * nearest still-listed contract, which is said in the result.
 */
async function simulateDay(sessionId: string, date: string, config: AlgoConfig, options: { capital?: number; historical?: boolean } = {}) {
  const data = await getS1Data(config.underlying, date);
  if (!data.previous) throw new AppError(data.message || "No strategy levels for that date.", 409, "NO_LEVELS");
  const candles = await dayTape(config.underlying, date);
  if (!candles.length) throw new AppError(`No 1-minute candles for ${config.underlying} on ${date} (a holiday or no data).`, 409, "NO_CANDLES");
  const listed = await runChain(config, date);
  const capital = options.capital ?? rupees(ALGO_STARTING_CAPITAL_PAISE);
  const lines = strategyLines(data, config.custom);
  const expired = options.historical ? await expiredSession(config.underlying, date) : null;
  if (expired && listed.lotSize) {
    const chain = expiredChain({ symbol: listed.symbol, date, expiry: expired.expiry, lotSize: listed.lotSize, tapes: expired.tapes });
    const adapter = createReplayAdapter({ candles, chain, config, capital, tapeOf: async (contract) => expiredTape(expired.tapes, contract.securityId) });
    const { events, state } = await simulateSession({ sessionId, date, config, candles, lines, adapter, startNote: `Backtest of ${date}: the nearest weekly expiry that day (${expired.expiry ?? "after the tested range"}), real 1-minute premiums from the expired contracts' history; lot size ${listed.lotSize} (today's). Virtual account; no orders are sent anywhere.` });
    return { events, state, expiry: expired.expiry, source: "expired" as const, candles, lines };
  }
  const adapter = replayAdapter({ underlying: config.underlying, date, candles, chain: listed, config, capital });
  if (adapter.kind !== "replay") throw new AppError("Replay must use the replay adapter.", 500);
  const { events, state } = await simulateSession({ sessionId, date, config, candles, lines, adapter, startNote: `Replay of ${date} with expiry ${listed.expiry} (the nearest still-listed expiry; expired contracts cannot be replayed). Premiums: real 1-minute option candles. Virtual account; no orders are sent anywhere.` });
  return { events, state, expiry: listed.expiry, source: "listed" as const, candles, lines };
}

const expiredSessions = new Map<string, Promise<{ tapes: Map<string, Candle[]>; expiry: string | null } | null>>();

/**
 * A past day's expired weekly option tapes for an index (null for a stock, or when Dhan has no history for
 * that day yet), and that day's expiry, found from the following days' at-the-money premiums.
 */
function expiredSession(underlying: string, date: string) {
  const key = `${underlying}|${date}`;
  if (!expiredSessions.has(key)) {
    if (expiredSessions.size > 60) expiredSessions.delete(expiredSessions.keys().next().value as string);
    expiredSessions.set(key, (async () => {
      const index = findIndex(underlying);
      if (!index) return null;
      const next = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
      const tapes = (await dhanExpiredOptions(Number(index.id), date, next(date, 1))).get(date);
      if (!tapes?.size) return null;
      // The expiry: the first day from this one whose at-the-money options end with no time value.
      const window = await dhanExpiredOptions(Number(index.id), date, next(date, 10), ["ATM"]).catch(() => null);
      return { tapes, expiry: window ? weeklyExpiries(window).get(date) ?? null : null };
    })().catch((error) => {
      expiredSessions.delete(key);
      throw error;
    }));
  }
  return expiredSessions.get(key)!;
}

async function runReplay(user: SessionUser, sessionId: string, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= todayIst()) throw new AppError("Choose a past trading date for the replay.", 400);
  const session = await prisma.algoSession.findUniqueOrThrow({ where: { id: sessionId } });
  const config = { ...readAlgoConfig(session.config), mode: "REPLAY" as const };
  const problems = algoConfigProblems(config);
  if (problems.length) throw new AppError(problems.join(" "), 400, "INVALID_ALGO_SETTINGS");
  const { events } = await simulateDay(sessionId, date, config);
  const runId = `replay:${date}:${Date.now()}`;
  await prisma.algoEvent.deleteMany({ where: { sessionId, mode: "REPLAY", NOT: { runId: { in: (await prisma.algoEvent.findMany({ where: { sessionId, mode: "REPLAY" }, distinct: ["runId"], orderBy: { createdAt: "desc" }, take: 2, select: { runId: true } })).map((row) => row.runId) } } } });
  await prisma.algoEvent.createMany({ data: events.map((event) => ({ sessionId, mode: "REPLAY", runId, key: event.key, time: Math.floor(event.time), kind: event.kind, payload: event as unknown as Prisma.InputJsonValue })), skipDuplicates: true });
}

/**
 * Multi-day backtest, one day per request (the browser walks the dates): the saved settings, or the same
 * settings with every entry filter and the structure stop off ("baseline") to compare. Read-only: nothing
 * is written and no order is placed anywhere.
 */
export async function backtestDay(user: SessionUser, date: string, variant: string, strategy: AlgoStrategy = "EXISTING_ALGO", capital = rupees(ALGO_STARTING_CAPITAL_PAISE), slippageTicks?: number) {
  assertAllowed(user);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= todayIst()) throw new AppError("Choose a past trading date.", 400);
  const session = await loadSession(user.id);
  const saved = { ...configFor(session, strategy), mode: "REPLAY" as const };
  // "baseline": the entry filters and the structure stop off; "score:NN": the saved settings with another minimum score.
  const score = /^score:(\d{1,3})$/.exec(variant);
  // "confirm:single|hold|retest": the saved settings with another breakout confirmation mode (Mathi Strategy).
  const confirm = /^confirm:(single|hold|retest)$/.exec(variant);
  const config: AlgoConfig = variant === "baseline" ? { ...saved, filters: { levelBlockMinutes: 0, breakoutBufferPercent: 0, secondCandle: false, momentum: false }, structureStop: false }
    : score ? { ...saved, minScore: Math.min(100, Number(score[1])) }
    : confirm ? { ...saved, filters: { ...saved.filters, secondCandle: false }, confirmation: { ...saved.confirmation, mode: confirm[1] as "single" | "hold" | "retest" } }
    : { ...saved };
  if (slippageTicks != null) config.slippageTicks = slippageTicks;
  const problems = algoConfigProblems(config);
  if (problems.length) throw new AppError(problems.join(" "), 400, "INVALID_ALGO_SETTINGS");
  try {
    const { events, expiry, source, candles, lines } = await simulateDay(session.id, date, config, { capital, historical: true });
    const notes = source === "listed" ? [`No expired-option history for ${date} yet: priced on the nearest still-listed contract (${expiry}).`] : [];
    return {
      date, variant, ok: true as const, expiry, stats: runStats(events), trades: backtestTrades(events, expiry), rejected: skippedSignals(events).length, dailyTarget: config.risk.dailyTarget,
      capital, source, notes, missed: missedSignals(events, candles),
      session: { candles: candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })), lines: lines.map((line) => ({ label: line.label, price: line.price })) },
    };
  } catch (error) {
    // A day without data (a holiday, missing history) is reported, not fatal.
    return { date, variant, ok: false as const, reason: error instanceof Error ? error.message : "This day could not be simulated." };
  }
}

/**
 * The provisional pre-market plan for a session (today before or after 09:15, or a past date): the
 * previous day's levels, recent daily volatility, gaps and swing levels, and the scenarios with their
 * triggers and invalidations. Read-only.
 */
export async function marketPlan(user: SessionUser, date: string) {
  assertAllowed(user);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayIst()) throw new AppError("Choose today or a past date.", 400);
  const session = await loadSession(user.id);
  const config = readAlgoConfig(session.config);
  const data = await getS1Data(config.underlying, date);
  if (!data.previous) return { ok: false as const, reason: data.message || `No previous-day data for ${config.underlying} before ${date}.` };
  const start = Math.floor(Date.parse(`${date}T03:45:00Z`) / 1000);
  const daily = (await getCandles(config.underlying, "1d").catch(() => ({ candles: [] as Candle[] }))).candles.filter((bar) => bar.time < start - 3_600);
  const lotSize = await runChain(config, date).then((chain) => chain.lotSize ?? null).catch(() => null);
  const open = start <= Math.floor(Date.now() / 1000) ? data.open : null;
  return { ok: true as const, plan: buildPlan({ date, underlying: config.underlying, previous: data.previous, daily, open, risk: config.risk, maxDailyLoss: config.maxDailyLoss, lotSize, orbMinutes: config.patterns.orbMinutes }) };
}

/* ---------------- the algo inside the chart's replay ---------------- */

const dayTapes = new Map<string, { at: number; candles: Candle[] }>();
const runChains = new Map<string, { at: number; chain: Awaited<ReturnType<typeof loadOptionChain>> }>();

/** The underlying's 1-minute session (a past day never changes, so it is kept for a while). */
async function dayTape(underlying: string, date: string) {
  const key = `${underlying}|${date}`;
  const hit = dayTapes.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.candles;
  const candles = await sessionMinuteTape(underlying, date);
  if (dayTapes.size > 50) dayTapes.delete(dayTapes.keys().next().value as string);
  dayTapes.set(key, { at: Date.now(), candles });
  return candles;
}

/** The contract list used to find the ATM strike (strikes, identifiers and lot size only; never its prices). */
async function runChain(config: AlgoConfig, date: string) {
  const key = `${config.underlying}|${config.expiry}`;
  const hit = runChains.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.chain;
  const chain = await loadOptionChain(config.underlying, config.expiry === "nearest" ? null : config.expiry);
  if (!chain.available || !chain.expiry) throw new AppError(`No option contract list for ${config.underlying}: ${chain.message}`, 409, "NO_OPTION_CHAIN");
  if (chain.expiry < date) throw new AppError(`The expiry ${chain.expiry} is before ${date}; expired contracts cannot be replayed with this data connection.`, 409, "EXPIRY_BEFORE_REPLAY");
  runChains.set(key, { at: Date.now(), chain });
  return chain;
}

function chartBounds(session: string, cursor: number | null) {
  const date = replaySessionDate(session);
  const bounds = date ? sessionBounds(date) : null;
  if (!date || !bounds) throw new AppError("This replay session is not recognised. Restart the replay.", 400, "INVALID_SESSION");
  if (cursor != null) checkReplayClock(session, cursor);
  return { date, ...bounds };
}

async function walletCash(userId: string, wallet: "ALGO" | "DEMO") {
  const account = await ensurePracticeAccount(userId, wallet);
  return account.cashAvailable;
}

async function saveChartRun(run: { id: string; sessionId: string }, data: Prisma.AlgoRunUpdateInput, events: AlgoEvent[]) {
  await prisma.$transaction([
    prisma.algoRun.update({ where: { id: run.id }, data }),
    ...(events.length ? [prisma.algoEvent.createMany({ data: events.map((event) => ({ sessionId: run.sessionId, mode: "CHART", runId: run.id, key: event.key, time: Math.floor(event.time), kind: event.kind, payload: event as unknown as Prisma.InputJsonValue })), skipDuplicates: true })] : []),
  ]);
}

function runStateOf(run: { state: Prisma.JsonValue; date: string }): AlgoState {
  return { ...initialState(run.date), ...((run.state && typeof run.state === "object" ? run.state : {}) as Partial<AlgoState>) };
}

const istTime = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16);

/**
 * Chart replay commands. Arm needs the user's explicit confirmation in the chart ("Start Algo & Replay");
 * each step processes the minutes the replay has completed since the last step; exits fill at the last
 * completed premium. A run never moves backwards: a replay moved before its processed minute must start a
 * new replay session (the chart's reset), which starts a new run.
 */
/**
 * Chart replay commands under the execution lock: a run's feature (Algo Trade or Algo - Primary Strategy)
 * takes the lock when it is confirmed, keeps it while it is armed or has a position or order open, and
 * releases it after any command leaves it with nothing to manage (disabled and flat, exited, archived).
 */
async function chartCommandLocked(user: SessionUser, session: Prisma.AlgoSessionGetPayload<object>, command: ChartCommand) {
  const run = await prisma.algoRun.findUnique({ where: { sessionId_replaySession: { sessionId: session.id, replaySession: command.session } } });
  const strategy: AlgoStrategy = run ? strategyOf(run.strategy) : command.action === "chartArm" ? strategyOf(command.strategy) : "EXISTING_ALGO";
  try {
    await chartCommand(user, session.id, configFor(session, strategy), strategy, command);
  } finally {
    await freeLock(session.id, strategy).catch(() => false);
  }
}

async function chartCommand(user: SessionUser, sessionId: string, config: AlgoConfig, strategy: AlgoStrategy, command: ChartCommand) {
  const existing = await prisma.algoRun.findUnique({ where: { sessionId_replaySession: { sessionId, replaySession: command.session } } });
  const now = Math.floor(Date.now() / 1000);
  const note = (key: string, time: number, message: string, kind: AlgoEvent["kind"] = "INFO"): AlgoEvent => ({ key: `${key}:${now}`, time, kind, message });

  if (command.action === "chartArm") {
    const { date, open, close } = chartBounds(command.session, command.cursor);
    if (config.mode !== "REPLAY") throw new AppError("Switch the Algo's execution mode to Chart replay first.", 409, "WRONG_MODE");
    const problems = algoConfigProblems(config);
    if (problems.length) throw new AppError(problems.join(" "), 400, "INVALID_ALGO_SETTINGS");
    if (existing?.status === "ENDED") throw new AppError(existing.endReason === "SESSION_END" ? "This replay session has finished. Reset the replay to start a new algo session." : "This algo session has ended. Reset the replay to start a new one.", 409, "RUN_ENDED");
    // A replay session belongs to one feature: switching starts a new session (never this run's orders).
    if (existing && strategyOf(existing.strategy) !== strategy) throw new AppError(`This replay session's algo run belongs to ${STRATEGY_NAME[strategyOf(existing.strategy)]}. Exit or reset the replay (after its position is closed) to start ${STRATEGY_NAME[strategy]} in a new session.`, 409, "OTHER_STRATEGY");
    const minute = Math.floor(command.cursor / 60) * 60;
    if (existing && minute < existing.processedThrough) throw new AppError(`The replay is before ${istTime(existing.processedThrough)}, the last minute the algo processed. Move it forward to resume, or reset the replay to start a new isolated session.`, 409, "REPLAY_BEHIND");
    if (minute >= close) throw new AppError("The replay is at the session close. Choose an earlier time or another date.", 409, "SESSION_CLOSED");
    // The exclusive lock before any signal is processed: refused while the other feature is active.
    await takeLock(sessionId, strategy);
    if (existing) {
      const state = runStateOf(existing);
      Object.assign(state, { running: true, entries: true });
      state.status = state.recovery ? "RECOVERY_REQUIRED" : state.position ? "POSITION_OPEN" : "MONITORING";
      await saveChartRun(existing, { armed: true, state: state as unknown as Prisma.InputJsonValue }, [note("resume", Math.max(minute, existing.processedThrough), `Algo confirmed: resuming with the replay at ${istTime(Math.max(minute, existing.processedThrough))} IST.`)]);
      return;
    }
    const data = await getS1Data(config.underlying, date);
    if (!data.previous) throw new AppError(data.message || `No strategy levels for ${config.underlying} on ${date}.`, 409, "NO_LEVELS");
    const candles = await dayTape(config.underlying, date);
    if (!candles.length) throw new AppError(`No 1-minute candles for ${config.underlying} on ${date}.`, 409, "NO_CANDLES");
    const chain = await runChain(config, date);
    // Every replay session trades its own fresh practice period: ₹1,00,000, nothing open, no P&L.
    const period = await startAlgoPeriod(user.id, `Algo replay session ${command.session}`);
    const cash = period.cashPaise;
    const lines = strategyLines(data, config.custom);
    // Starting mid-session never trades history: evaluation starts with the first minute after the cursor.
    const processedThrough = Math.max(open, minute);
    const state: AlgoState = { ...initialState(date), running: true, entries: true, lastCandle: processedThrough > open ? processedThrough - 60 : null, status: "MONITORING" };
    const run = await prisma.algoRun.create({
      data: {
        sessionId, replaySession: command.session, date, underlying: config.underlying, strategy, config: config as unknown as Prisma.InputJsonValue, lines: lines as unknown as Prisma.InputJsonValue,
        state: state as unknown as Prisma.InputJsonValue, armed: true, processedThrough, wallet: "ALGO", startCashPaise: cash, periodId: period.periodId,
      },
    });
    await saveChartRun(run, {}, [{ key: "start", time: processedThrough, kind: "INFO", message: `${STRATEGY_NAME[strategy]}: replay started on ${date} at ${istTime(processedThrough)} IST: ${config.underlying}, completed 1-minute candles, expiry ${chain.expiry} (nearest listed; premiums from its real 1-minute history). Algo wallet (₹1,00,000 practice capital); no broker orders.` }]);
    return;
  }

  if (!existing) {
    if (command.action === "chartStep" || command.action === "chartDisarm" || command.action === "chartReset") return;
    throw new AppError("There is no algo session for this replay.", 409, "NO_RUN");
  }
  const runConfig = readAlgoConfig(existing.config);
  const { date, open, close } = chartBounds(command.session, "cursor" in command ? command.cursor : null);
  const state = runStateOf(existing);
  const wallet = existing.wallet === "ALGO" ? "ALGO" as const : "DEMO" as const;
  const context = async () => ({
    user, wallet, runId: existing.id, session: command.session, date, config: runConfig, lines: (existing.lines as unknown as AlgoLine[]) ?? [],
    candles: await dayTape(existing.underlying, date), chain: await runChain(runConfig, date), sessionOpen: open, sessionClose: close,
  });

  if (command.action === "chartDisarm") {
    if (!existing.armed) return;
    Object.assign(state, { running: false, entries: false });
    state.status = state.recovery ? "RECOVERY_REQUIRED" : state.position ? "POSITION_OPEN" : "DISABLED";
    await saveChartRun(existing, { armed: false, state: state as unknown as Prisma.InputJsonValue }, [note("disarm", existing.processedThrough, state.position ? "Algo disabled: no new entries. The open position stays on the demo ledger; its stop-loss and target are still checked while the replay runs." : "Algo disabled: no new entries.")]);
    return;
  }

  if (command.action === "chartReset" || command.action === "chartFinalize") {
    if (command.action === "chartReset" && (state.position || state.pending)) throw new AppError("Exit the open algo position before resetting the replay session.", 409, "POSITION_OPEN");
    // Archived once: a repeated Exit Replay (a double click, a retry) changes nothing.
    if (existing.status === "ENDED" && existing.summary) return;
    await archiveRun(user, existing, state, wallet, command.action === "chartReset" ? "RESET" : "EXIT_REPLAY", existing.status === "ENDED" ? null : await context());
    return;
  }

  const minute = Math.floor(command.cursor / 60) * 60;
  if (command.action === "chartStep") {
    if (existing.status === "ENDED") return;
    // Protection continues while entries are off; a run that is off with nothing open does nothing.
    if (!existing.armed && !state.position && !state.pending) return;
    if (minute <= existing.processedThrough) return;
    // Entries only while this run's feature owns the execution lock; otherwise it only protects its position.
    const lockNotes: AlgoEvent[] = [];
    let armed = existing.armed;
    if (armed) {
      const got = await acquireLock(lockStore(sessionId), strategy, (owner) => ownerActivity(sessionId, owner));
      if (!got.ok) {
        armed = false;
        Object.assign(state, { running: false, entries: false });
        lockNotes.push(note("lock-lost", existing.processedThrough, `New entries stopped: ${got.reason}`, "REJECTED"));
      }
    }
    const ran = await stepChartRun({ ...(await context()), state, processedThrough: existing.processedThrough, cursor: command.cursor, liveSteps: true });
    ran.events.unshift(...lockNotes);
    if (!armed && existing.armed) await prisma.algoRun.update({ where: { id: existing.id }, data: { armed: false } });
    if (ran.ended) ran.state.status = ran.state.recovery ? "RECOVERY_REQUIRED" : ran.state.position ? "EXIT_PENDING" : "COMPLETED";
    await saveChartRun(existing, {
      state: ran.state as unknown as Prisma.InputJsonValue, processedThrough: ran.processedThrough,
      ...(ran.ended ? { status: ran.state.position ? "ACTIVE" : "ENDED", armed: false, endedAt: ran.state.position ? null : new Date(), endReason: "SESSION_END", endCashPaise: await walletCash(user.id, wallet) } : {}),
    }, [...ran.events, ...(ran.ended ? [{ key: "session-end", time: close, kind: "INFO" as const, message: ran.state.position ? "Replay reached the session close but the square-off is not confirmed: the position is still open on the demo ledger." : "Replay reached the session close: the algo session ended." }] : [])]);
    if (ran.completed) await completeRun(user, existing.id, wallet);
    return;
  }

  // chartExit: first process the minutes up to the replay time (a stop already reached is honoured).
  if (minute < existing.processedThrough) throw new AppError(`The replay is before ${istTime(existing.processedThrough)}, the last minute the algo processed. Move it forward to exit at a current price.`, 409, "REPLAY_BEHIND");
  let current = state;
  let through = existing.processedThrough;
  const events: AlgoEvent[] = [];
  const ctx = await context();
  if (minute > through) {
    const ran = await stepChartRun({ ...ctx, state: current, processedThrough: through, cursor: command.cursor });
    current = ran.state;
    through = ran.processedThrough;
    events.push(...ran.events);
  }
  if (current.position && !current.position.exit) {
    const exited = await exitChartRun({ ...ctx, state: current, at: Math.min(through, close), reason: command.emergency ? "EMERGENCY" : "MANUAL" });
    current = exited.state;
    events.push(...exited.events);
  } else if (!command.emergency) {
    events.push(note("exit-none", through, "No open position to exit (it may have just closed at its stop-loss or target)."));
  }
  if (command.emergency) {
    Object.assign(current, { running: false, entries: false });
    events.push(note("emergency", through, "Emergency stop: new entries blocked and the open position exited.", "ERROR"));
  }
  current.status = current.recovery ? "RECOVERY_REQUIRED" : current.position?.exit ? "EXIT_PENDING" : current.position ? "POSITION_OPEN" : current.running ? (current.entries ? "MONITORING" : "READY") : "DISABLED";
  await saveChartRun(existing, { state: current as unknown as Prisma.InputJsonValue, processedThrough: through, ...(command.emergency ? { armed: false } : {}) }, events);
  // A manual exit of the last trade completes the session just as a stop-loss or target would.
  if (!command.emergency && sessionComplete(current, runConfig.stopAtLimit === false ? Infinity : runConfig.maxTrades)) await completeRun(user, existing.id, wallet);
}

/** The run for the chart's replay session, the run history, and the demo wallet. */
async function chartView(user: SessionUser, sessionId: string, chartSession: string | null) {
  const runs = await prisma.algoRun.findMany({ where: { sessionId }, orderBy: { startedAt: "desc" }, take: 20 });
  const current = chartSession ? runs.find((run) => run.replaySession === chartSession) ?? await prisma.algoRun.findUnique({ where: { sessionId_replaySession: { sessionId, replaySession: chartSession } } }) : null;
  const ids = runs.map((run) => run.id).filter((id) => id !== current?.id);
  const rows = ids.length ? await prisma.algoEvent.findMany({ where: { sessionId, mode: "CHART", runId: { in: ids } }, orderBy: [{ time: "asc" }, { createdAt: "asc" }], take: 4000 }) : [];
  // The current run's whole log (never cut by the history's row cap): its trades and entry count come from it.
  const currentRows = current ? await prisma.algoEvent.findMany({ where: { sessionId, mode: "CHART", runId: current.id }, orderBy: [{ time: "asc" }, { createdAt: "asc" }] }) : [];
  const eventsOf = (runId: string) => (runId === current?.id ? currentRows : rows.filter((row) => row.runId === runId)).map((row) => row.payload as unknown as AlgoEvent);
  let run = null;
  if (current) {
    const state = runStateOf(current);
    let position = null;
    if (state.position) {
      const contract = state.position.contract;
      const at = current.processedThrough;
      const tape = await sessionTape({ underlying: contract.underlying, name: contract.underlying, expiry: contract.expiry, strike: contract.strike, right: contract.right, securityId: contract.securityId, kind: findIndex(contract.underlying) ? "index" : "equity", lotSize: contract.lotSize }, current.date, new Date()).catch(() => []);
      const candle = tape.filter((item) => item.time + 60 <= at).at(-1) ?? null;
      const premium = candle?.close ?? null;
      if (candle) await cacheReplayMark(current.replaySession, contract, candle.close, candle.time + 60, at);
      position = { ...state.position, premium, premiumAt: candle ? candle.time + 60 : null, ...positionValuation(state.position, premium) };
    }
    const events = eventsOf(current.id);
    const runLines = Array.isArray(current.lines) ? (current.lines as unknown as AlgoLine[]) : [];
    const enabledLines = runLines.filter((line) => !readAlgoConfig(current.config).disabledLines.includes(line.type)).length;
    run = {
      id: current.id, replaySession: current.replaySession, date: current.date, underlying: current.underlying, strategy: strategyOf(current.strategy), armed: current.armed, status: current.status, endReason: current.endReason,
      processedThrough: current.processedThrough, startedAt: current.startedAt.toISOString(), state, position, events: panelEvents(events), stats: runStats(events), config: readAlgoConfig(current.config),
      summary: (current.summary ?? null) as { account?: Awaited<ReturnType<typeof algoWallet>> | null; stats?: ReturnType<typeof runStats>; completed?: number; maxTrades?: number; startCapital?: number; status?: string; finalizedAt?: string } | null,
      // The strategy lines this run compares (fixed for its date) and how many of them are switched on.
      lineCount: runLines.length,
      enabledLines,
      // From the whole log (the panel's events are the recent ones plus every trade's).
      diagnostics: runDiagnostics(events, enabledLines),
    };
  }
  return {
    chart: run,
    runs: runs.map((item) => {
      const events = eventsOf(item.id);
      return {
        id: item.id, replaySession: item.replaySession, date: item.date, underlying: item.underlying, strategy: strategyOf(item.strategy), status: item.status, endReason: item.endReason, startedAt: item.startedAt.toISOString(), endedAt: item.endedAt?.toISOString() ?? null,
        startCash: rupees(item.startCashPaise), endCash: item.endCashPaise == null ? null : rupees(item.endCashPaise), config: readAlgoConfig(item.config), stats: runStats(events),
        trades: events.filter((event) => event.kind === "ENTRY" || event.kind === "EXIT"),
      };
    }),
    /** A run started before the Algo wallet existed finishes on the demo wallet. */
    runWallet: current ? current.wallet : "ALGO",
  };
}

/**
 * Stores the replay mark of an algo replay position on its session instrument, as the chart's own replay
 * marks do, so Portfolio and Home value the Algo wallet's replay position at the same replay price.
 */
async function cacheReplayMark(session: string, contract: ContractRef, premium: number, candleEnd: number, cursor: number) {
  const symbol = `${contract.underlying}|${contract.expiry}|${contract.strike}|${contract.right}|R:${session}`;
  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) return;
  const markPaise = paise(premium);
  const cache = {
    lastPaise: markPaise, bidPaise: markPaise, askPaise: markPaise, openPaise: markPaise, highPaise: markPaise, lowPaise: markPaise, previousClosePaise: markPaise,
    volume: 0n, asOf: new Date(candleEnd * 1000), mode: "HISTORICAL" as const, source: `last-completed-1m-close at replay ${new Date(cursor * 1000).toISOString()}`, marketOpen: false, message: "Replay mark. Not a live price.",
  };
  await prisma.quoteCache.upsert({ where: { instrumentId: instrument.id }, create: { instrumentId: instrument.id, ...cache }, update: cache }).catch(() => undefined);
}

/**
 * Finalizes a replay session (Exit Replay, or the chart's reset): stops it, closes an open position at the
 * last processed replay premium ("Replay session closed"), or, when no premium exists, leaves it open and
 * records it as unresolved (never a made-up fill). Then writes the archive (account figures, trades,
 * counts and settings) and the run's end in one transaction, and only after that opens a fresh period on
 * the Algo wallet for the next session. The archived period, its orders and closed trades stay as they are.
 */
/**
 * All of the session's trades are done (the entry limit used, every trade closed): the session is archived
 * as COMPLETED at the minute it finished. The next replay opens its own fresh period, so the finished
 * session's account figures stay on screen in its completion summary.
 */
async function completeRun(user: SessionUser, runId: string, wallet: "ALGO" | "DEMO") {
  const run = await prisma.algoRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.status === "ENDED" && run.summary) return;
  await archiveRun(user, run, runStateOf(run), wallet, "COMPLETED", null);
}

async function archiveRun(user: SessionUser, run: Prisma.AlgoRunGetPayload<object>, state: AlgoState, wallet: "ALGO" | "DEMO", reason: "EXIT_REPLAY" | "RESET" | "COMPLETED", ctx: ChartRunInput | null) {
  const now = Math.floor(Date.now() / 1000);
  let current: AlgoState = { ...state, running: false, entries: false };
  const events: AlgoEvent[] = [];
  if (ctx && current.position && !current.position.exit) {
    try {
      const exited = await exitChartRun({ ...ctx, state: current, at: Math.min(run.processedThrough, ctx.sessionClose), reason: "SESSION_CLOSED" });
      current = { ...exited.state, running: false, entries: false };
      events.push(...exited.events);
    } catch (error) {
      events.push({ key: `close-failed:${now}`, time: run.processedThrough, kind: "ERROR", message: `The open position could not be closed (${error instanceof Error ? error.message : "no premium"}). It is archived as unresolved and stays on the Algo ledger.` });
    }
  }
  const allEvents = [...(await prisma.algoEvent.findMany({ where: { sessionId: run.sessionId, mode: "CHART", runId: run.id }, orderBy: [{ time: "asc" }, { createdAt: "asc" }] })).map((row) => row.payload as unknown as AlgoEvent), ...events];
  const unresolved = Boolean(current.position || current.pending);
  const account = wallet === "ALGO" ? await algoWallet(user.id).catch(() => null) : null;
  const trades = algoTrades(allEvents, current.position ? { entryKey: current.position.entryKey, exitPending: Boolean(current.position.exit) } : null);
  const summary = {
    sessionId: run.replaySession,
    runId: run.id,
    strategy: strategyOf(run.strategy),
    strategyName: STRATEGY_NAME[strategyOf(run.strategy)],
    underlying: run.underlying,
    date: run.date,
    timeframe: "1m",
    startedAt: run.startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    startCapital: rupees(run.startCashPaise),
    account,
    entries: trades.length,
    maxTrades: readAlgoConfig(run.config).maxTrades,
    stats: runStats(allEvents),
    completed: trades.filter((trade) => trade.status === "COMPLETED").length,
    rejected: skippedSignals(allEvents).length,
    unresolved: unresolved ? 1 : 0,
    trades,
    settings: readAlgoConfig(run.config),
    status: unresolved ? "ARCHIVED_UNRESOLVED" : "ARCHIVED",
    reason,
    finalizedAt: new Date().toISOString(),
  };
  const message = reason === "COMPLETED"
    ? `All ${summary.maxTrades} trades are completed. The session is saved to Algo History; the replay stops here.`
    : reason === "RESET"
    ? "Replay session reset and saved to Algo History. The next session starts fresh."
    : `Replay session ended and saved to Algo History${unresolved ? " (an open position could not be closed and is kept as unresolved)" : ""}.`;
  await saveChartRun(run, {
    status: "ENDED", armed: false, endedAt: new Date(), endReason: reason, endCashPaise: await walletCash(user.id, wallet),
    state: { ...current, status: unresolved ? "RECOVERY_REQUIRED" : "COMPLETED" } as unknown as Prisma.InputJsonValue,
    summary: summary as unknown as Prisma.InputJsonValue,
  }, [...events, { key: `archived:${now}`, time: run.processedThrough, kind: "INFO", message }]);
  // The next session starts on a fresh ₹1,00,000 period (an unresolved position stays with this one).
  if (wallet === "ALGO" && reason !== "COMPLETED") await startAlgoPeriod(user.id, `Algo replay session ${run.replaySession} ended (${reason}).`).catch(() => undefined);
}

/**
 * Saved backtests (the user's own only): save one run's days (every total is recomputed here from them, with
 * the saved strategy settings and the data coverage), list them, open one, delete one. Separate from replay
 * runs and from every ledger: nothing here places or records an order.
 */
export async function backtestRecords(user: SessionUser, command: Extract<AlgoRequest, { action: "backtestSave" | "backtestList" | "backtestGet" | "backtestDelete" }>) {
  assertAllowed(user);
  const session = await loadSession(user.id);
  if (command.action === "backtestList") {
    const rows = await prisma.algoBacktest.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, strategy: true, strategyVersion: true, fromDate: true, toDate: true, underlying: true, capital: true, mode: true, status: true, summary: true, warnings: true, createdAt: true } });
    return { backtests: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
  }
  if (command.action === "backtestGet") {
    const row = await prisma.algoBacktest.findFirst({ where: { id: command.id, sessionId: session.id } });
    if (!row) throw new AppError("That backtest was not found.", 404);
    return { backtest: { ...row, createdAt: row.createdAt.toISOString() } };
  }
  if (command.action === "backtestDelete") {
    await prisma.algoBacktest.deleteMany({ where: { id: command.id, sessionId: session.id } });
    return { ok: true };
  }
  const strategy = command.strategy ?? "EXISTING_ALGO";
  const settings = configFor(session, strategy);
  const runs = command.runs as Partial<Record<"daily" | "continuous", BacktestDay[]>>;
  const days = runs.daily ?? runs.continuous ?? [];
  const priced = days.filter((day) => day.ok);
  const coverage = {
    sessions: days.length, simulated: priced.length, skipped: days.filter((day) => !day.ok).map((day) => ({ date: day.date, reason: day.ok ? "" : day.reason })),
    expiredHistory: priced.filter((day) => day.ok && day.source === "expired").length, listedFallback: priced.filter((day) => day.ok && day.source === "listed").map((day) => day.date),
  };
  const warnings = [
    ...coverage.skipped.map((item) => `${item.date}: not simulated — ${item.reason}`),
    ...coverage.listedFallback.map((date) => `${date}: no expired-option history yet; priced on the nearest still-listed contract.`),
  ];
  const summary = Object.fromEntries(Object.entries(runs).map(([mode, list]) => [mode, backtestTotals(list ?? [])]));
  const row = await prisma.algoBacktest.create({
    data: {
      sessionId: session.id, strategy, strategyVersion: settings.settingsVersion, fromDate: command.from, toDate: command.to, underlying: settings.underlying, interval: "1m",
      capital: command.capital, mode: command.mode, settings: settings as unknown as Prisma.InputJsonValue, costs: { slippageTicks: command.slippageTicks, charges: "Option charges as on the ledger (brokerage, STT, exchange, SEBI, stamp duty, GST)" },
      coverage: coverage as unknown as Prisma.InputJsonValue, warnings, status: command.status, summary: summary as unknown as Prisma.InputJsonValue, days: runs as unknown as Prisma.InputJsonValue,
    },
  });
  return { id: row.id };
}

/** Home → Algo History: every archived (and the running) replay session, newest first. Read-only. */
export async function algoHistory(user: SessionUser) {
  assertAllowed(user);
  const session = await prisma.algoSession.findUnique({ where: { userId: user.id } });
  if (!session) return { sessions: [] };
  const runs = await prisma.algoRun.findMany({ where: { sessionId: session.id }, orderBy: { startedAt: "desc" }, take: 50 });
  const rows = runs.length ? await prisma.algoEvent.findMany({ where: { sessionId: session.id, mode: "CHART", runId: { in: runs.map((run) => run.id) } }, orderBy: [{ time: "asc" }, { createdAt: "asc" }] }) : [];
  return {
    sessions: runs.map((run) => {
      const events = rows.filter((row) => row.runId === run.id).map((row) => row.payload as unknown as AlgoEvent);
      const summary = (run.summary ?? null) as Record<string, unknown> | null;
      const trades = (summary?.trades as ReturnType<typeof algoTrades> | undefined) ?? algoTrades(events, null);
      const stats = runStats(events);
      return {
        id: run.id, sessionId: run.replaySession, underlying: run.underlying, date: run.date, status: run.status === "ENDED" ? (summary?.status as string | undefined) ?? "ARCHIVED" : "RUNNING",
        endReason: run.endReason, startedAt: run.startedAt.toISOString(), endedAt: run.endedAt?.toISOString() ?? null, startCapital: rupees(run.startCashPaise), endCash: run.endCashPaise == null ? null : rupees(run.endCashPaise),
        account: (summary?.account ?? null) as Awaited<ReturnType<typeof algoWallet>> | null, stats, trades, rejected: skippedSignals(events), settings: readAlgoConfig(run.config),
      };
    }),
  };
}

/**
 * One replay session's complete record for its report download: the run, its archived summary and every
 * logged event (signals, every candle evaluation, orders, confirmations, exits), oldest first. Only the
 * signed-in user's own sessions are readable. Read-only.
 */
export async function algoReport(user: SessionUser, runId: string) {
  assertAllowed(user);
  const session = await prisma.algoSession.findUnique({ where: { userId: user.id } });
  const run = session ? await prisma.algoRun.findFirst({ where: { id: runId, sessionId: session.id } }) : null;
  if (!session || !run) throw new AppError("This Algo session was not found.", 404, "NOT_FOUND");
  const rows = await prisma.algoEvent.findMany({ where: { sessionId: session.id, mode: "CHART", runId: run.id }, orderBy: [{ time: "asc" }, { createdAt: "asc" }] });
  const events = rows.map((row) => row.payload as unknown as AlgoEvent);
  return {
    id: run.id, sessionId: run.replaySession, underlying: run.underlying, date: run.date, status: run.status, endReason: run.endReason,
    startedAt: run.startedAt.toISOString(), endedAt: run.endedAt?.toISOString() ?? null, processedThrough: run.processedThrough,
    startCapital: rupees(run.startCashPaise), endCash: run.endCashPaise == null ? null : rupees(run.endCashPaise),
    summary: (run.summary ?? null) as { account?: Awaited<ReturnType<typeof algoWallet>> | null } | null,
    settings: readAlgoConfig(run.config), stats: runStats(events), events,
  };
}
