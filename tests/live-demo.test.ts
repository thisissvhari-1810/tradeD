// Mathi Strategy live demo mode: activation sessions and their 3-entry allowance, on the same engine and
// in-memory order adapter as tests/algo.test.ts (its fixtures, copied).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strategyLines, type AlgoLine, type Candle } from "@/lib/algo/lines";
import type { ChainInput } from "@/lib/algo/options";
import { advance, ALGO_DEFAULTS, initialState, type AlgoConfig, type AlgoState, type ExecutionAdapter, type Fill, type Mark } from "@/lib/algo/runner";
import { algoTrades } from "@/lib/algo/chart-replay";
import { activationSummary, activationTrades, afterLiveTick, beforeLiveTick, endActivation, feedIsStale, LIMIT_NOTICE, liveStatus, startActivation } from "@/lib/algo/live-session";
import type { S1Data } from "@/lib/trading/s1";

/* ---------------- fixtures ---------------- */

const DATE = "2026-10-26";
const OPEN = Date.UTC(2026, 9, 26, 3, 45) / 1000; // 09:15 IST
const at = (minute: number) => OPEN + minute * 60;
const bar = (minute: number, open: number, high: number, low: number, close: number): Candle => ({ time: at(minute), open, high, low, close });

const s1: S1Data = {
  symbol: "NIFTY",
  date: DATE,
  sessionOpen: OPEN,
  sessionClose: OPEN + 375 * 60,
  status: "ready",
  message: "",
  previous: { date: "2026-10-23", high: 24_000, low: 23_800, close: 23_950 } as S1Data["previous"],
  open: 23_990,
  firstMinute: { time: OPEN, open: 23_990, high: 24_020, low: 23_970 },
};
const lines = strategyLines(s1, [{ id: "extra", label: "My level", price: 23_700 }]);
const lineOf = (type: AlgoLine["type"]) => lines.find((line) => line.type === type)!;
const NOW = at(400);

/** A candle pair crossing `price` down (bearish) or up (bullish), from minute 30. */
function crossing(price: number, direction: "DOWN" | "UP", minute = 30): [Candle, Candle] {
  return direction === "DOWN"
    ? [bar(minute, price + 8, price + 10, price + 4, price + 6), bar(minute + 1, price + 5, price + 7, price - 9, price - 6)]
    : [bar(minute, price - 8, price - 4, price - 10, price - 6), bar(minute + 1, price - 5, price + 9, price - 7, price + 6)];
}


/** A chain around 23,987 with 50-point strikes, lot size 75, fresh quotes. */
function chain(now: number, overrides: Partial<ChainInput> = {}): ChainInput {
  const strikes = Array.from({ length: 9 }, (_, index) => 23_800 + index * 50).map((strike) => ({
    strike,
    ce: { ltp: 100, bid: 100, ask: 101, securityId: `${strike}CE` },
    pe: { ltp: 100, bid: 100, ask: 101, securityId: `${strike}PE` },
  }));
  return { underlying: "NIFTY", spot: 23_987, expiry: "2026-10-28", asOf: new Date(now * 1000).toISOString(), lotSize: 75, strikes, ...overrides };
}

/** An in-memory execution adapter that records every order (and can be told to misbehave). */
function fakeAdapter(options: { cash?: number; bid?: number | null; candle?: Mark["candle"]; enter?: (key: string) => Fill; exit?: (key: string, quantity: number) => Fill; kind?: ExecutionAdapter["kind"]; orders?: Map<string, Fill>; chain?: (now: number) => ChainInput } = {}) {
  const orders = options.orders ?? new Map<string, Fill>();
  const calls = { enter: 0, exit: 0 };
  let cash = options.cash ?? 1_000_000;
  let clock = NOW;
  const adapter: ExecutionAdapter & { calls: typeof calls; orders: Map<string, Fill>; set: (patch: { bid?: number | null; candle?: Mark["candle"] }) => void; cashNow: () => number; tick: (now: number) => void } = {
    kind: options.kind ?? "paper",
    calls,
    orders,
    set(patch) { Object.assign(options, patch); },
    cashNow: () => cash,
    tick(now) { clock = now; },
    health: async () => ({ ok: true }),
    cash: async () => cash,
    charges: () => 20,
    chain: async () => (options.chain ?? ((now: number) => chain(now)))(clock),
    mark: async () => (options.bid === undefined && !options.candle ? { bid: 100, ask: 101, candle: null, asOf: clock } : options.bid === null ? null : { bid: options.bid ?? null, ask: options.bid ?? null, candle: options.candle ?? null, asOf: clock }),
    async enter(order) {
      calls.enter += 1;
      if (orders.has(order.key)) return orders.get(order.key)!;
      const fill = options.enter ? options.enter(order.key) : ({ status: "FILLED", quantity: order.quantity, price: order.price, charges: 20 } as Fill);
      if (fill.status !== "UNKNOWN") orders.set(order.key, fill);
      if (fill.status === "FILLED" || fill.status === "PARTIAL") cash -= fill.price * fill.quantity + fill.charges;
      return fill;
    },
    async exit(order) {
      calls.exit += 1;
      if (orders.has(order.key)) return orders.get(order.key)!;
      const fill = options.exit ? options.exit(order.key, order.quantity) : ({ status: "FILLED", quantity: order.quantity, price: order.price, charges: 20 } as Fill);
      if (fill.status !== "UNKNOWN") orders.set(order.key, fill);
      if (fill.status === "FILLED" || fill.status === "PARTIAL") cash += fill.price * fill.quantity - fill.charges;
      return fill;
    },
    lookup: async (key) => orders.get(key) ?? null,
  };
  return adapter;
}

// The core engine's tests run with the entry filters and the structure stop off (they have their own tests).
const config = (patch: Partial<AlgoConfig> = {}): AlgoConfig => ({ ...ALGO_DEFAULTS, stopLoss: true, crossRule: "classic", crossPercent: 0, confirmation: { ...ALGO_DEFAULTS.confirmation, mode: "single" }, stopAtLimit: true, intrabar: false, risk: { ...ALGO_DEFAULTS.risk, stopAtTarget: false }, stop: { mode: "percent", value: 20 }, target: { mode: "percent", value: 40 }, lots: 1, sizing: "fixed", entryCutoff: "15:00", maxDailyLoss: 5_000, strategies: { line: true, trendline: true, w: true, m: true, orb: false, bounce: false, rejection: false }, cooldownMinutes: 0, filters: { levelBlockMinutes: 0, breakoutBufferPercent: 0, secondCandle: false, momentum: false }, structureStop: false, ...patch });

async function step(state: AlgoState, candles: Candle[], adapter: ReturnType<typeof fakeAdapter>, now = candles.at(-1)!.time + 60, cfg = config(), useLines = lines) {
  adapter.tick(now);
  return advance(state, { sessionId: "s1", sessionDate: DATE, config: cfg, candles, lines: useLines, now, adapter });
}

/* ---------------- live demo: Mathi Strategy activation sessions ---------------- */

const LOW = lineOf("or-low").price;
const cfg = config({ maxTrades: 3 });
const off = (): AlgoState => ({ ...initialState(DATE) });

/** One live tick exactly as the server runs it: the day check, the engine, then the activation's limit. */
async function tick(state: AlgoState, candles: Candle[], adapter: ReturnType<typeof fakeAdapter>, now: number) {
  const before = beforeLiveTick(state, DATE, now);
  if (!state.running && !state.position && !state.pending) return { state, events: before };
  const result = await step(state, candles, adapter, now, cfg);
  return { state: result.state, events: [...before, ...result.events, ...afterLiveTick(result.state, cfg, now)] };
}

/** Switched ON at `minute`. */
function switchedOn(minute: number, state = off(), id = "MS-A") {
  const events = startActivation(state, at(minute), id, DATE, cfg.maxTrades);
  return { state, events };
}

/** A completed crossing of the 9:15 low at `minute` (down = PUT, up = CALL). */
const cross = (minute: number, direction: "DOWN" | "UP") => crossing(LOW, direction, minute);

/** Enters on a crossing at `minute`, then reaches the target the next minute. */
async function trade(state: AlgoState, candles: Candle[], adapter: ReturnType<typeof fakeAdapter>, minute: number, direction: "DOWN" | "UP") {
  candles.push(...cross(minute, direction));
  adapter.set({ bid: 100 });
  const entered = await tick(state, candles, adapter, at(minute + 2));
  adapter.set({ bid: 150 });
  const exited = await tick(entered.state, candles, adapter, at(minute + 3));
  adapter.set({ bid: 100 });
  return { entered, exited };
}

describe("live demo: Mathi Strategy activation sessions (3 entries each)", () => {
  it("1 · 10 · three trades: no fourth entry, then LIMIT REACHED with its notice once", async () => {
    const adapter = fakeAdapter();
    const candles: Candle[] = [];
    let { state } = switchedOn(25);
    for (const [minute, direction] of [[30, "DOWN"], [40, "UP"], [50, "DOWN"]] as const) {
      const { entered, exited } = await trade(state, candles, adapter, minute, direction);
      expect(entered.events.some((event) => event.kind === "ENTRY")).toBe(true);
      expect(exited.events.some((event) => event.kind === "EXIT" && /TARGET/.test(event.message))).toBe(true);
      state = exited.state;
    }
    expect(adapter.calls.enter).toBe(3);
    expect(state.activation).toMatchObject({ id: "MS-A", entries: 3, end: "LIMIT", limitNotified: true });
    expect(state.activations?.[0]).toMatchObject({ id: "MS-A", entries: 3, end: "LIMIT" });
    expect(liveStatus(state, cfg, false)).toBe("LIMIT_REACHED");
    // A fourth valid crossing: no order, and the notice is not repeated.
    candles.push(...cross(60, "UP"));
    const later = await tick(state, candles, adapter, at(62));
    expect(adapter.calls.enter).toBe(3);
    expect(later.events.filter((event) => event.message === LIMIT_NOTICE(3))).toHaveLength(0);
  });

  it("9 · while the third trade is open no fourth entry is made; entries stop at once and it is still managed", async () => {
    const adapter = fakeAdapter();
    const candles: Candle[] = [];
    let { state } = switchedOn(25);
    for (const [minute, direction] of [[30, "DOWN"], [40, "UP"]] as const) state = (await trade(state, candles, adapter, minute, direction)).exited.state;
    candles.push(...cross(50, "DOWN"));
    state = (await tick(state, candles, adapter, at(52))).state;
    expect(state.position).not.toBeNull();
    expect(state.entries).toBe(false);
    expect(liveStatus(state, cfg, false)).toBe("POSITION_OPEN");
    candles.push(...cross(60, "UP"));
    const next = await tick(state, candles, adapter, at(62));
    expect(adapter.calls.enter).toBe(3);
    expect(next.events.some((event) => event.message === LIMIT_NOTICE(3))).toBe(false);
    adapter.set({ bid: 150 });
    const closed = await tick(next.state, candles, adapter, at(63));
    expect(closed.events.some((event) => event.message === LIMIT_NOTICE(3))).toBe(true);
    expect(liveStatus(closed.state, cfg, false)).toBe("LIMIT_REACHED");
  });

  it("2 · stopped after one trade: later valid signals make no entry", async () => {
    const adapter = fakeAdapter();
    const candles: Candle[] = [];
    let { state } = switchedOn(25);
    state = (await trade(state, candles, adapter, 30, "DOWN")).exited.state;
    endActivation(state, at(35), "STOPPED");
    expect(liveStatus(state, cfg, false)).toBe("STOPPED");
    candles.push(...cross(40, "UP"));
    const after = await tick(state, candles, adapter, at(42));
    expect(adapter.calls.enter).toBe(1);
    expect(after.events.some((event) => event.kind === "EVALUATION" || event.kind === "ENTRY")).toBe(false);
    expect(state.activations?.[0]).toMatchObject({ entries: 1, end: "STOPPED" });
  });

  it("3 · restarted after one trade: a new session at 0/3 with its own id, the earlier one kept", async () => {
    const adapter = fakeAdapter();
    const candles: Candle[] = [];
    let { state } = switchedOn(25);
    const first = await trade(state, candles, adapter, 30, "DOWN");
    state = first.exited.state;
    endActivation(state, at(35), "STOPPED");
    switchedOn(36, state, "MS-B");
    expect(state.activation).toMatchObject({ id: "MS-B", entries: 0, startedAt: at(36), endedAt: null });
    expect(state.tradesToday).toBe(0);
    expect(state.activations?.map((item) => item.id)).toEqual(["MS-A"]);
    const second = await trade(state, candles, adapter, 40, "UP");
    expect(second.entered.state.activation?.entries).toBe(1);
    // Each session's trades come from the order events, by when each entry was recorded.
    const events = [...first.entered.events, ...first.exited.events, ...second.entered.events, ...second.exited.events];
    const all = algoTrades(events, null);
    const recorded = new Map(all.map((item) => [item.entryKey, item.entryTime]));
    expect(activationTrades(all, state.activations![0], recorded).map((item) => item.side)).toEqual(["PUT"]);
    expect(activationTrades(all, second.exited.state.activation!, recorded).map((item) => [item.number, item.side])).toEqual([[1, "CALL"]]);
    // The daily loss lock is not reset by a restart.
    const locked = { ...off(), realizedToday: -6_000, riskLocked: true };
    startActivation(locked, at(70), "MS-C", DATE, 3);
    expect(locked).toMatchObject({ riskLocked: true, realizedToday: -6_000 });
  });

  it("4 · 11 · the same signal seen again (repeated ticks, a refresh racing a scheduler) makes one entry", async () => {
    const adapter = fakeAdapter();
    const { state } = switchedOn(25);
    const candles = [...cross(30, "DOWN")];
    const first = await tick(state, candles, adapter, at(32));
    const again = await tick(first.state, candles, adapter, at(32));
    const later = await tick(again.state, candles, adapter, at(32) + 40);
    expect([again, later].some((result) => result.events.some((event) => event.kind === "ENTRY"))).toBe(false);
    // A second tick from the same stored state (a refresh racing a scheduler) sends the same order key: it is
    // refused as already processed, so no second position exists.
    const raced = await tick(JSON.parse(JSON.stringify(state)) as AlgoState, candles, adapter, at(32));
    expect(raced.events.some((event) => event.kind === "ENTRY")).toBe(false);
    expect(raced.events.some((event) => /Order already processed/.test(event.message))).toBe(true);
    expect(adapter.orders.size).toBe(1);
  });

  it("5 · a forming candle that keeps changing never makes an order; the completed one makes one", async () => {
    const adapter = fakeAdapter();
    const { state } = switchedOn(25);
    const [previous, crossingBar] = cross(30, "DOWN");
    let current = state;
    for (const close of [LOW - 3, LOW - 8, LOW + 2, LOW - 6]) {
      current = (await tick(current, [previous, { ...crossingBar, close, low: Math.min(crossingBar.low, close) }], adapter, crossingBar.time + 30)).state;
    }
    expect(adapter.calls.enter).toBe(0);
    current = (await tick(current, [previous, crossingBar], adapter, crossingBar.time + 60)).state;
    current = (await tick(current, [previous, crossingBar], adapter, crossingBar.time + 75)).state;
    expect(adapter.calls.enter).toBe(1);
  });

  it("6 · stale data: a signal candle that closed minutes ago is not traded, and the feed reads as stale", async () => {
    const adapter = fakeAdapter();
    const { state } = switchedOn(25);
    const candles = [...cross(30, "DOWN")];
    const late = await tick({ ...state, lastCandle: at(29) }, candles, adapter, at(36));
    expect(adapter.calls.enter).toBe(0);
    expect(late.events.some((event) => /evaluated late/.test(event.message))).toBe(true);
    expect(late.events.some((event) => event.kind === "ENTRY")).toBe(false);
    expect(feedIsStale(at(30), at(25), at(36))).toBe(true);
    expect(feedIsStale(at(34), at(25), at(36))).toBe(false);
    expect(liveStatus(state, cfg, true)).toBe("WAITING_FOR_DATA");
    // No data at all: nothing is evaluated.
    expect((await tick(state, [], adapter, at(36))).events.some((event) => event.kind === "ENTRY")).toBe(false);
  });

  it("7 · a rejected entry order uses no slot", async () => {
    const adapter = fakeAdapter({ enter: () => ({ status: "REJECTED", reason: "Insufficient funds" }) });
    const { state } = switchedOn(25);
    const result = await tick(state, [...cross(30, "DOWN")], adapter, at(32));
    expect(adapter.calls.enter).toBe(1);
    expect(result.state.position).toBeNull();
    expect([result.state.tradesToday, result.state.activation?.entries]).toEqual([0, 0]);
    expect(activationSummary([], 3, null)).toMatchObject({ entriesUsed: 0, completed: 0, open: 0 });
  });

  it("8 · stopped with a position open: it stays visible and managed to its exit; no new entry is made", async () => {
    const adapter = fakeAdapter();
    const candles = [...cross(30, "DOWN")];
    let { state } = switchedOn(25);
    state = (await tick(state, candles, adapter, at(32))).state;
    expect(state.position).not.toBeNull();
    const ended = endActivation(state, at(33), "STOPPED");
    expect(ended[0].message).toMatch(/open position stays managed/);
    expect(state.position).not.toBeNull();
    expect(liveStatus(state, cfg, false)).toBe("POSITION_OPEN_STOPPED");
    candles.push(...cross(40, "UP"));
    adapter.set({ bid: 150 });
    const after = await tick(state, candles, adapter, at(42));
    expect(after.events.find((event) => event.kind === "EXIT")?.message).toMatch(/TARGET/);
    expect(adapter.calls.enter).toBe(1);
    expect(liveStatus(after.state, cfg, false)).toBe("STOPPED");
  });

  it("restart while an earlier session's position is open: it stays managed and blocks a new entry until flat", async () => {
    const adapter = fakeAdapter();
    const carried = (await tick(switchedOn(25, off(), "MS-X").state, [...cross(30, "DOWN")], adapter, at(32))).state;
    endActivation(carried, at(33), "STOPPED");
    switchedOn(34, carried, "MS-Y");
    const blocked = await tick(carried, [...cross(30, "DOWN"), ...cross(40, "UP")], adapter, at(42));
    expect(blocked.events.some((event) => event.kind === "ENTRY")).toBe(false);
    expect(blocked.state.position?.entryKey).toBe(carried.position?.entryKey);
    expect(adapter.calls.enter).toBe(1);
    expect(blocked.state.activation?.entries).toBe(0);
  });

  it("a switch-on carried into the next market day ends before anything is evaluated", () => {
    const { state } = switchedOn(25);
    const events = beforeLiveTick(state, "2026-10-27", at(25) + 86_400);
    expect(events[0].message).toMatch(/market day ended/);
    expect(state).toMatchObject({ running: false, entries: false, activation: { end: "DAY_END" } });
  });

  it("11 · 12 · 13 · the server: one activation per switch-on, the limit after every tick, paper orders only, the chart stream untouched", () => {
    const server = readFileSync(join(process.cwd(), "src/server/algo.ts"), "utf8");
    // Switching ON while running (a double click, a retried request, a refresh) never starts a second activation.
    expect(server).toMatch(/if \(state\.running && state\.activation && state\.activation\.endedAt == null\) break;/);
    // The order of a live tick: the day check, the engine, the activation's limit.
    expect(server).toMatch(/const before = beforeLiveTick\(state, today, now\);[\s\S]*await advance\(input,[\s\S]*const after = afterLiveTick\(result\.state, config, now\);/);
    // Only paper (simulated) sessions start; live broker trading is refused.
    expect(server).toMatch(/if \(config\.mode !== "PAPER"\) throw new AppError/);
    expect(server).toMatch(/if \(next\.mode === "LIVE"\) throw new AppError/);
    // Every command and tick runs under the session's lease (no two process the same candle at once).
    expect(server).toMatch(/await withLease\(session\.id, async \(\) => \{\s*const config = readAlgoConfig\(session\.config\);/);
    // The chart's market data stream does not depend on the algo.
    expect(readFileSync(join(process.cwd(), "src/app/api/market/stream/route.ts"), "utf8")).not.toMatch(/algo/i);
    // The panel only shows the server's figures and sends ON / OFF through the Algo panel.
    const panel = readFileSync(join(process.cwd(), "src/components/algo/algo-live-session.tsx"), "utf8");
    expect(panel).not.toMatch(/api\(|fetch\(/);
  });

  it("the auto-stop notice reads as the spec asks", () => {
    expect(LIMIT_NOTICE(3)).toBe("3 trades completed. Algo stopped automatically.");
  });

  it("every Start Algo gets its own ₹1,00,000 ledger; completed trades are tagged in Trade History", () => {
    const server = readFileSync(join(process.cwd(), "src/server/algo.ts"), "utf8");
    const start = server.slice(server.indexOf('case "start": {'), server.indexOf('case "stop":'));
    // The double-click guard comes before anything is allocated, so a retried start never opens a second ledger.
    expect(start.indexOf("endedAt == null) break;")).toBeLessThan(start.indexOf("startAlgoPeriod("));
    // A trade still open from the previous session must close first: it belongs to that session's ledger.
    expect(start).toMatch(/if \(state\.position \|\| state\.pending\) throw new AppError\(.*, 409, "POSITION_OPEN"\);/);
    expect(start.indexOf('"POSITION_OPEN"')).toBeLessThan(start.indexOf("startAlgoPeriod("));
    expect(start).toMatch(/const period = await startAlgoPeriod\(user\.id,/);
    expect(start).toMatch(/periodId: period\.periodId, capital: Number\(period\.cashPaise\) \/ 100/);
    // Every tick tags the closed trades of its non-shadow exits (once per exit fill: updateMany by exitExecutionId).
    expect(server).toMatch(/const after = afterLiveTick\(result\.state, config, now\);\s*await tagClosedTrades\(/);
    expect(server).toMatch(/event\.kind === "EXIT" && !event\.shadow/);
    expect(server).toMatch(/closedTrade\.updateMany\(\{ where: \{ exitExecutionId: execution\.id \}/);
    expect(server).toMatch(/paper trading \(live demo\)/);
  });

  it("the chart's Start / Stop Algo button only sends start / stop (paper mode) and shares the panel's view", () => {
    const button = readFileSync(join(process.cwd(), "src/components/algo/algo-start-button.tsx"), "utf8");
    expect(button).toMatch(/action: running \? "stop" : "start"/);
    expect(button).toMatch(/if \(data && data\.config\.mode !== "PAPER"\) return null;/);
    expect(button).not.toMatch(/dhan|placeOrder|"LIVE"/i);
    const panel = readFileSync(join(process.cwd(), "src/components/algo/algo-panel.tsx"), "utf8");
    expect(panel).toMatch(/broadcastAlgoView\(next\)/);
    expect(panel).toMatch(/algoPanelTicker\.mounted \+= 1/);
    expect(readFileSync(join(process.cwd(), "src/components/chart-desk.tsx"), "utf8")).toMatch(/live \|\| replay\.active \? null : <AlgoStartButton/);
  });
});
