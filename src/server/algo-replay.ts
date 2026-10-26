import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { walletKey } from "@/server/practice-account";
import { minuteEnds, sessionComplete } from "@/lib/algo/chart-replay";
import type { AlgoLine, Candle } from "@/lib/algo/lines";
import { advance, startExit, type AlgoConfig, type AlgoEvent, type AlgoState, type ExecutionAdapter, type Fill } from "@/lib/algo/runner";
import type { SessionUser } from "@/server/auth";
import type { loadOptionChain } from "@/server/option-chain";
import { replayAdapter } from "@/server/algo";
import { placeOptionDemo, placeOptionReplay } from "@/server/trading";

/**
 * The Algo driven by the chart's replay clock. Signals come from the underlying's real 1-minute candles,
 * the ATM contract is priced from its own real 1-minute premium history, and every entry and exit is an
 * order on the Algo wallet's ledger (its own ₹1,00,000 practice capital, positions, closed trades and
 * history, which Portfolio and Home show as the Algo account) through the historical replay order path.
 * Runs started before the Algo wallet existed finish on the demo wallet they began on. Nothing is sent to
 * a broker. Orders carry the run's idempotency keys, so a repeated step never fills twice.
 */

const rupees = (paise: bigint) => Number(paise) / 100;
const KNOWN_REJECTIONS = new Set(["INSUFFICIENT_FUNDS", "NO_HISTORICAL_PREMIUM", "NO_LOT_SIZE", "QTY_ABOVE_POSITION", "SHORT_NOT_ALLOWED", "EXPIRY_NOT_LISTED", "NO_CONTRACT_ID", "NO_DEMO_ACCOUNT", "TRADING_DISABLED", "ROLE_NOT_ALLOWED", "REPLAY_TIME_BEHIND", "INVALID_QUANTITY", "INVALID_EXPIRY"]);

type ChainView = Awaited<ReturnType<typeof loadOptionChain>>;

export type ChartRunInput = {
  user: SessionUser;
  /** The run id: part of every order key, so separate runs never collide. */
  runId: string;
  /** The chart's option replay session (ledger positions are scoped to it). */
  session: string;
  date: string;
  config: AlgoConfig;
  lines: AlgoLine[];
  candles: Candle[];
  chain: ChainView;
  sessionOpen: number;
  sessionClose: number;
  /** The practice wallet holding this run's orders. */
  wallet: "ALGO" | "DEMO";
  /** The real clock (orders are refused for replay times in the real future). */
  now?: Date;
};

/** Ledger fill of an order key in this replay session, or null if it was never placed. */
async function ledgerFill(userId: string, wallet: "ALGO" | "DEMO", session: string, key: string): Promise<Fill | null> {
  const account = await prisma.virtualAccount.findUnique({ where: walletKey(userId, wallet) });
  if (!account) return null;
  const order = await prisma.order.findUnique({ where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: `optreplay:${session}:${key}` } }, include: { instrument: true, executions: true } });
  return order ? fillOfOrder(order) : null;
}

function fillOfOrder(order: { status: string; rejectionReason: string | null; quantity: number; executions?: Array<{ quantity: number; pricePaise: bigint; chargesPaise: bigint }> }): Fill {
  if (order.status === "REJECTED" || order.status === "CANCELLED") return { status: "REJECTED", reason: order.rejectionReason || "Rejected." };
  const fills = order.executions ?? [];
  if (!fills.length) return { status: "PENDING" };
  const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  const notional = fills.reduce((sum, fill) => sum + fill.pricePaise * BigInt(fill.quantity), 0n);
  const charges = fills.reduce((sum, fill) => sum + fill.chargesPaise, 0n);
  return { status: quantity < order.quantity ? "PARTIAL" : "FILLED", quantity, price: Math.round(Number(notional) / quantity) / 100, charges: rupees(charges) };
}

/**
 * Chain, marks and the signal-minute premium come from the historical replay adapter (real 1-minute
 * premiums only, at the replay clock); cash, entries, exits and lookups go to the demo wallet's ledger.
 */
export function chartReplayAdapter(input: ChartRunInput): ExecutionAdapter & { setClock: (now: number) => void } {
  const base = replayAdapter({ underlying: input.config.underlying, date: input.date, candles: input.candles, chain: input.chain, config: input.config, capital: 0 });
  let clock = 0;
  const place = async (side: "BUY" | "SELL", order: { key: string; contract: { underlying: string; expiry: string; strike: number; right: "CE" | "PE"; lotSize: number }; quantity: number; price: number }): Promise<Fill> => {
    const lots = Math.round(order.quantity / Math.max(1, order.contract.lotSize));
    try {
      await placeOptionReplay(input.user, {
        symbol: order.contract.underlying, expiry: order.contract.expiry, strike: order.contract.strike, right: order.contract.right, action: side, lots,
        session: input.session, cursor: clock, idempotencyKey: order.key, fillPremium: order.price,
      }, input.now ?? new Date(), input.wallet);
    } catch (error) {
      // A refusal the ledger explains is a rejection; anything else (a timeout, a lost connection) is unknown
      // and is reconciled by key before anything is sent again.
      if (error instanceof AppError && (KNOWN_REJECTIONS.has(error.code ?? "") || error.status < 500)) return { status: "REJECTED", reason: error.message };
      return { status: "UNKNOWN", reason: error instanceof Error ? error.message : "The order outcome is unknown." };
    }
    return (await ledgerFill(input.user.id, input.wallet, input.session, order.key)) ?? { status: "UNKNOWN", reason: "The order was not found after placing it." };
  };
  return {
    kind: "replay",
    setClock: (now) => { clock = now; base.setClock(now); },
    health: async () => ({ ok: true }),
    async cash() {
      const account = await prisma.virtualAccount.findUnique({ where: walletKey(input.user.id, input.wallet) });
      return account ? rupees(account.cashAvailable) : 0;
    },
    charges: base.charges,
    chain: base.chain,
    mark: base.mark,
    enter: (order) => place("BUY", order),
    exit: (order) => place("SELL", order),
    lookup: (key) => ledgerFill(input.user.id, input.wallet, input.session, key),
  };
}

/**
 * Processes every minute that completed after `processedThrough`, up to the replay cursor, in order:
 * reconcile, protect the open position on that minute's premium candle, then evaluate the new underlying
 * candle (entries only while the algo is on). At the session close an open position is squared off at
 * the last completed premium. Never reads a candle that completes after the minute being processed.
 */
export async function stepChartRun(input: ChartRunInput & { state: AlgoState; processedThrough: number; cursor: number }) {
  const adapter = chartReplayAdapter(input);
  let state = input.state;
  const events: AlgoEvent[] = [];
  let processedThrough = input.processedThrough;
  // Once the session's trades are all done nothing more is processed: the replay stops at that minute.
  const limit = input.config.stopAtLimit === false ? Infinity : input.config.maxTrades;
  let completed = sessionComplete(state, limit);
  for (const end of completed ? [] : minuteEnds(processedThrough, input.cursor, input.sessionOpen, input.sessionClose)) {
    adapter.setClock(end);
    const result = await advance(state, { sessionId: input.runId, sessionDate: input.date, config: input.config, candles: input.candles, lines: input.lines, now: end, adapter });
    state = result.state;
    events.push(...result.events);
    processedThrough = end;
    if (sessionComplete(state, limit)) {
      completed = true;
      break;
    }
  }
  let ended = false;
  if (!completed && processedThrough >= input.sessionClose) {
    ended = true;
    if (state.position && !state.position.exit) {
      const mark = await adapter.mark(state.position.contract, input.sessionClose).catch(() => null);
      adapter.setClock(input.sessionClose);
      await startExit(state, runInput(input, adapter, input.sessionClose), "SESSION_END", mark?.bid != null ? { price: mark.bid, note: "Squared off at the session close (last completed premium)." } : null, (event) => events.push({ time: input.sessionClose, ...event }));
    }
    state.running = false;
    state.entries = false;
  }
  return { state, events, processedThrough, ended, completed };
}

function runInput(input: ChartRunInput, adapter: ExecutionAdapter, now: number) {
  return { sessionId: input.runId, sessionDate: input.date, config: input.config, candles: input.candles, lines: input.lines, now, adapter };
}

/**
 * Simulated execution at live prices on the Algo wallet's ledger (paper mode): the same order path as the
 * demo option ticket (fills at the option chain's traded premium with the ledger's charges), keyed by the
 * algo's idempotency keys. The options desk's own paper account is never used.
 */
export function walletPaperAdapter(user: SessionUser, base: Pick<ExecutionAdapter, "charges" | "chain" | "mark">): ExecutionAdapter {
  const place = async (side: "BUY" | "SELL", order: { key: string; contract: { underlying: string; expiry: string; strike: number; right: "CE" | "PE"; lotSize: number }; quantity: number }): Promise<Fill> => {
    try {
      await placeOptionDemo(user, {
        symbol: order.contract.underlying, expiry: order.contract.expiry, strike: order.contract.strike, right: order.contract.right, action: side,
        lots: Math.round(order.quantity / Math.max(1, order.contract.lotSize)), idempotencyKey: order.key,
      }, "ALGO");
    } catch (error) {
      if (error instanceof AppError && (KNOWN_REJECTIONS.has(error.code ?? "") || error.status < 500)) return { status: "REJECTED", reason: error.message };
      return { status: "UNKNOWN", reason: error instanceof Error ? error.message : "The order outcome is unknown." };
    }
    return (await walletFill(user.id, `option:${order.key}`)) ?? { status: "UNKNOWN", reason: "The order was not found after placing it." };
  };
  return {
    kind: "paper",
    health: async () => ({ ok: true }),
    async cash() {
      const account = await prisma.virtualAccount.findUnique({ where: walletKey(user.id, "ALGO") });
      return account ? rupees(account.cashAvailable) : 0;
    },
    charges: base.charges,
    chain: base.chain,
    mark: base.mark,
    enter: (order) => place("BUY", order),
    exit: (order) => place("SELL", order),
    lookup: (key) => walletFill(user.id, `option:${key}`),
  };
}

async function walletFill(userId: string, idempotencyKey: string): Promise<Fill | null> {
  const account = await prisma.virtualAccount.findUnique({ where: walletKey(userId, "ALGO") });
  if (!account) return null;
  const order = await prisma.order.findUnique({ where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey } }, include: { instrument: true, executions: true } });
  return order ? fillOfOrder(order) : null;
}

/** A manual (or emergency) exit at the replay time: the last completed premium, as any replay order. */
export async function exitChartRun(input: ChartRunInput & { state: AlgoState; at: number; reason: "MANUAL" | "EMERGENCY" | "SESSION_CLOSED" }) {
  const adapter = chartReplayAdapter(input);
  const state: AlgoState = JSON.parse(JSON.stringify(input.state)) as AlgoState;
  const events: AlgoEvent[] = [];
  if (!state.position) throw new AppError("There is no open algo position.", 409);
  if (state.position.exit) throw new AppError("An exit for this position is already being processed.", 409, "EXIT_PENDING");
  adapter.setClock(input.at);
  const mark = await adapter.mark(state.position.contract, input.at).catch(() => null);
  if (!mark?.bid) throw new AppError("No completed premium for this contract at the replay time, so it cannot be exited here. Move the replay forward a minute and try again.", 409, "NO_HISTORICAL_PREMIUM");
  await startExit(state, runInput(input, adapter, input.at), input.reason, { price: mark.bid, note: input.reason === "MANUAL" ? "Manual exit at the last completed premium." : input.reason === "SESSION_CLOSED" ? "Replay session closed: exited at the last completed premium." : "Emergency stop at the last completed premium." }, (event) => events.push({ time: input.at, ...event }));
  if (input.reason === "EMERGENCY") state.entries = false;
  return { state, events };
}
