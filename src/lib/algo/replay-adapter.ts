import { optionCharges } from "@/lib/options/engine";
import { FILL_STALE_SECONDS } from "@/lib/options/replay-premium";
import type { AlgoLine, Candle } from "./lines";
import { atmStrike, type ChainInput, type Right } from "./options";
import { advance, initialState, startExit, type AlgoConfig, type AlgoEvent, type AlgoState, type ContractRef, type ExecutionAdapter, type Fill } from "./runner";
import { sessionComplete } from "./chart-replay";

const paise = (rupees: number) => BigInt(Math.round(rupees * 100));
const rupees = (value: bigint) => Number(value) / 100;

/** The contract list a replay picks its ATM strike from (strikes, identifiers and lot size; never prices). */
export type ReplayChain = {
  symbol: string;
  expiry: string | null;
  kind: "index" | "equity";
  lotSize: number | null;
  strikes: Array<{ strike: number; ce?: { securityId?: string | null } | null; pe?: { securityId?: string | null } | null }>;
};

/** A contract's 1-minute premium candles for the replayed session. */
export type TapeLoader = (contract: Pick<ContractRef, "underlying" | "expiry" | "strike" | "right" | "securityId" | "lotSize">) => Promise<Candle[]>;

/**
 * Simulated execution for a replayed or backtested session on a virtual account: the ATM contract is
 * chosen from the underlying's close at the signal minute, and every fill uses that contract's real
 * 1-minute premium at the replay clock (never a later candle), with the ledger's option charges.
 * Where the premiums come from is the caller's: listed contracts' history, or expired weekly contracts.
 */
export function createReplayAdapter(input: { candles: Candle[]; chain: ReplayChain; config: AlgoConfig; capital: number; tapeOf: TapeLoader }): ExecutionAdapter & { setClock: (now: number) => void } {
  const orders = new Map<string, Fill>();
  let cash = input.capital;
  // The simulated clock: the close of the candle being replayed.
  let clock = 0;
  const tapes = new Map<string, Promise<Candle[]>>();
  const tapeOf: TapeLoader = (contract) => {
    const key = contract.securityId;
    if (!tapes.has(key)) tapes.set(key, input.tapeOf(contract).catch(() => []));
    return tapes.get(key)!;
  };
  const candleAt = (tape: Candle[], time: number) => tape.find((candle) => candle.time === time) ?? null;
  // The latest premium candle at or before `time` that is still fresh enough to trade on (an ATM option
  // that did not trade in one minute keeps its last price, but never one older than the fill limit).
  const lastAt = (tape: Candle[], time: number) => {
    const found = [...tape].reverse().find((candle) => candle.time <= time) ?? null;
    return found && time - found.time <= FILL_STALE_SECONDS ? found : null;
  };
  return {
    kind: "replay",
    setClock: (now) => { clock = now; },
    health: async () => ({ ok: true }),
    cash: async () => cash,
    charges: (side, premium, quantity) => rupees(optionCharges(side, paise(premium), quantity).total),
    async chain(right: Right) {
      // The underlying's close at the signal minute is the spot; only the ATM contract's premium is loaded.
      const view = input.chain;
      const now = clock;
      const spotCandle = [...input.candles].filter((candle) => candle.time + 60 <= now).at(-1);
      let quoteAsOf = now;
      const spot = spotCandle?.close ?? null;
      const strikes = view.strikes.map((row) => ({ strike: row.strike, ce: null as ChainInput["strikes"][number]["ce"], pe: null as ChainInput["strikes"][number]["pe"] }));
      const strike = spot != null ? atmStrike(view.strikes.map((row) => row.strike), spot, input.config.rounding) : null;
      const row = view.strikes.find((item) => item.strike === strike);
      const side = right === "CE" ? row?.ce : row?.pe;
      if (row && side?.securityId && view.lotSize && spotCandle) {
        const tape = await tapeOf({ underlying: view.symbol, expiry: view.expiry!, strike: row.strike, right, securityId: side.securityId, lotSize: view.lotSize });
        const premium = lastAt(tape, spotCandle.time);
        const quote = premium ? { ltp: premium.close, bid: premium.close, ask: premium.close, securityId: side.securityId } : { ltp: null, bid: null, ask: null, securityId: side.securityId };
        const target = strikes.find((item) => item.strike === row.strike)!;
        if (right === "CE") target.ce = quote; else target.pe = quote;
        // The quote is as old as its candle: a premium from an earlier minute is checked against the age limit.
        if (premium) quoteAsOf = premium.time + 60;
      }
      return { underlying: view.symbol, spot, expiry: view.expiry, asOf: new Date(quoteAsOf * 1000).toISOString(), lotSize: view.lotSize, strikes };
    },
    async mark(contract, now) {
      const tape = await tapeOf(contract);
      const candle = candleAt(tape, now - 60);
      if (candle) return { bid: candle.close, ask: candle.close, candle: { open: candle.open, high: candle.high, low: candle.low, close: candle.close }, asOf: now };
      // No trade in this minute: the last traded premium stands (its own range was checked in its minute).
      const last = lastAt(tape, now - 60);
      return last ? { bid: last.close, ask: last.close, candle: null, asOf: last.time + 60 } : null;
    },
    async enter(order) {
      if (orders.has(order.key)) return orders.get(order.key)!;
      const charges = rupees(optionCharges("BUY", paise(order.price), order.quantity).total);
      const cost = order.price * order.quantity + charges;
      const fill: Fill = cost > cash ? { status: "REJECTED", reason: "Insufficient virtual buying power." } : { status: "FILLED", quantity: order.quantity, price: order.price, charges };
      if (fill.status === "FILLED") cash -= cost;
      orders.set(order.key, fill);
      return fill;
    },
    async exit(order) {
      if (orders.has(order.key)) return orders.get(order.key)!;
      const charges = rupees(optionCharges("SELL", paise(order.price), order.quantity).total);
      const fill: Fill = { status: "FILLED", quantity: order.quantity, price: order.price, charges };
      cash += order.price * order.quantity - charges;
      orders.set(order.key, fill);
      return fill;
    },
    lookup: async (key) => orders.get(key) ?? null,
  };
}

/**
 * One session simulated candle by candle with the strategy engine (the same `advance` as replay and paper):
 * each completed minute in order, never a later candle; it stops once the session's trades are done or the
 * entry window has closed with nothing open, and an open position is closed at the session's last premium.
 */
export async function simulateSession(input: { sessionId: string; date: string; config: AlgoConfig; candles: Candle[]; lines: AlgoLine[]; adapter: ExecutionAdapter & { setClock: (now: number) => void }; startNote: string }) {
  const { sessionId, date, config, candles, lines, adapter } = input;
  let state: AlgoState = { ...initialState(date), running: true, entries: true };
  const events: AlgoEvent[] = [{ key: "start", time: candles[0].time, kind: "INFO", message: input.startNote }];
  for (const candle of candles) {
    const clock = candle.time + 60;
    adapter.setClock(clock);
    const result = await advance(state, { sessionId, sessionDate: date, config, candles, lines, now: clock, adapter });
    state = result.state;
    events.push(...result.events);
    // Like chart replay: the session stops once its trades are all done, or once the entry window has
    // closed with nothing open (no later candle can enter).
    if (sessionComplete(state, config.stopAtLimit === false ? Infinity : config.maxTrades)) break;
    if (!state.position && !state.pending && new Date((clock + 19_800) * 1000).toISOString().slice(11, 16) > config.entryCutoff) break;
  }
  if (state.position) {
    const last = candles.at(-1)!.time + 60;
    const mark = await adapter.mark(state.position.contract, last);
    await startExit(state, { sessionId, sessionDate: date, config, candles, lines, now: last, adapter }, "SESSION_END", mark ? { price: mark.bid ?? state.position.avg, note: "Closed at the end of the replayed session." } : null, (event) => events.push({ time: last, ...event }));
  }
  return { events, state };
}
