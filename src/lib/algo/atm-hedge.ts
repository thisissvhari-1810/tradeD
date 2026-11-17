/**
 * NIFTY 50 — First 1-Minute ATM CE + PE Premium-Based Hedge (user spec, 17 Nov 2026). An independent strategy: it shares
 * no settings, state or code path with the Mathi strategies, and it never places a broker order. Backtest and paper only;
 * live trading stays off until the backtest has been reviewed and approved.
 *
 * 1. Wait for the first completed NIFTY 1-minute candle (09:15, complete at 09:16). ATM = its close rounded to the strike
 *    step; the SAME strike and expiry for CE and PE (expiry series configurable: nearest weekly or nearest monthly).
 * 2. BUY both legs at once. Capital is split 50/50; each leg's lots are sized independently from its own premium and lot
 *    size so that premium × quantity + the leg's round-trip charges stay within the leg's allocation.
 * 3. Combined entry = CE fill + PE fill (actual average fills, captured only after BOTH legs are filled).
 * 4. Target on the COMBINED PREMIUM only (never on NIFTY's index move, never per leg):
 *      POINTS  : target premium = combined entry + points
 *      PERCENT : target premium = combined entry × (1 + pct / 100)
 *    When CE now + PE now ≥ target premium, sell BOTH legs completely. Otherwise square off both at 15:29.
 * 5. No stop-loss, no trailing, no per-leg targets in this version (hooks are kept, OFF by default).
 *
 * Backtest model (only 1-minute OHLC history exists):
 *  - Entry: market buys at the 09:16 candle's OPEN + slippage (first minute ≥ 09:16 where both legs trade, by 09:20).
 *  - Monitoring: the combined premium is read at two near-simultaneous snapshots per minute, the candle OPEN and the
 *    candle CLOSE of both legs. Highs/lows are never added together (CE high and PE high do not happen at the same moment
 *    for a straddle), so a target touched only inside a minute is missed — the model is conservative, never optimistic.
 *  - Exit: market sells at the triggering snapshot − slippage on each leg (so the realised combined points are a little
 *    below the target, as live). Square-off: the 15:29 candle's open − slippage.
 *  - A snapshot counts only when both legs have a candle in that minute (no stale leg can trigger a target).
 *
 * All times are minutes after midnight IST. A bar stamped `t` covers [t, t+1): its open is known at t, its close at t+1.
 */
import { tradeCharges, type ChargeSettings, type MinuteBar, type Right } from "@/lib/algo/fib-breakout";

export type { MinuteBar, Right };
export type HedgeTargetMode = "POINTS" | "PERCENT";
export type ExpirySeries = "WEEK" | "MONTH";

export type HedgeSettings = {
  underlying: "NIFTY";
  strikeStep: number;
  /** Strategy capital in ₹, split CE / PE by `ceShare` (0.5 = 50/50). */
  capital: number;
  ceShare: number;
  /** "CAPITAL_SPLIT" (the spec): each leg sized on its own half of the capital, so quantities usually differ.
   * "EQUAL_QTY" (research diagnostic, off): the same lots on both legs, sized on CE + PE together — combined points then
   * map exactly to rupees. */
  sizing: "CAPITAL_SPLIT" | "EQUAL_QTY";
  expirySeries: ExpirySeries;
  targetMode: HedgeTargetMode;
  /** Points (POINTS) or percent (PERCENT) of the combined entry premium. */
  targetValue: number;
  /** Signal minute: the first 1-minute candle (09:15) is complete at 09:16. */
  signalTime: number;
  /** No entry if both legs cannot be bought by this minute (inclusive). */
  entryDeadline: number;
  /** Square-off minute: an open position is sold at this candle's open. */
  squareOffTime: number;
  tick: number;
  /** Slippage per unit, in ticks, on every market order (both buys, both sells). */
  slippageTicks: number;
  /** Sizing headroom over the signal-time LTP so a slightly worse fill still fits the allocation. */
  sizingBuffer: number;
  /** Future experiments — OFF (0) in this version: combined stop in points below entry; time exit after N minutes. */
  stopLossPoints: number;
  maxHoldMinutes: number;
  charges: ChargeSettings;
};

export const hhmm = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
export const clockOf = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export const r2 = (value: number) => Math.round(value * 100) / 100;
const EPS = 1e-9;
const tickDown = (price: number, tick: number) => r2(Math.floor(price / tick + EPS) * tick);
const tickUp = (price: number, tick: number) => r2(Math.ceil(price / tick - EPS) * tick);

/**
 * Statutory NSE option charges with their history, so a 2021–2026 backtest charges each date at its own rates.
 * STT on the sell premium: 0.05% → 0.0625% (1 Apr 2023) → 0.1% (1 Oct 2024) → 0.15% (1 Apr 2026).
 * NSE transaction charge: 0.053% → 0.03503% (1 Oct 2024). Stamp 0.003% on buys; SEBI ₹10/crore; GST 18%; ₹20/order.
 */
export const HEDGE_CHARGES: ChargeSettings = {
  brokeragePerOrder: 20,
  sttSell: [{ from: "2000-01-01", rate: 0.0005 }, { from: "2023-04-01", rate: 0.000625 }, { from: "2024-10-01", rate: 0.001 }, { from: "2026-04-01", rate: 0.0015 }],
  exchangeRate: 0.00053,
  exchangeRates: [{ from: "2000-01-01", rate: 0.00053 }, { from: "2024-10-01", rate: 0.0003503 }],
  sebiPerCrore: 10,
  stampBuyRate: 0.00003,
  gstRate: 0.18,
};

export const HEDGE_DEFAULTS: HedgeSettings = {
  underlying: "NIFTY",
  strikeStep: 50,
  capital: 100_000,
  ceShare: 0.5,
  sizing: "CAPITAL_SPLIT",
  expirySeries: "WEEK",
  targetMode: "POINTS",
  targetValue: 4,
  signalTime: hhmm("09:16"),
  entryDeadline: hhmm("09:20"),
  squareOffTime: hhmm("15:29"),
  tick: 0.05,
  slippageTicks: 2,
  sizingBuffer: 0.02,
  stopLossPoints: 0,
  maxHoldMinutes: 0,
  charges: HEDGE_CHARGES,
};

/** NIFTY lot size by contract expiry. 50 → 25 after the 25-Apr-2024 expiry → 75 after 24-Dec-2024 → 65 after 30-Dec-2025.
 * The 26-Dec-2024 and 30-Jan-2025 monthlies were listed before the 75 revision and stayed at 25. */
export const hedgeLotSize = (expiry: string) =>
  expiry === "2024-12-26" || expiry === "2025-01-30" ? 25 : expiry <= "2024-04-25" ? 50 : expiry <= "2024-12-24" ? 25 : expiry <= "2025-12-30" ? 75 : 65;

export const atmStrike = (spot: number, step: number) => Math.round(spot / step) * step;

export function targetPremium(combinedEntry: number, settings: Pick<HedgeSettings, "targetMode" | "targetValue">) {
  return settings.targetMode === "POINTS" ? combinedEntry + settings.targetValue : combinedEntry * (1 + settings.targetValue / 100);
}

/** Lots one leg can buy: premium × qty + that leg's round-trip charges (at the same price) ≤ allocation. */
export function legLots(allocation: number, premium: number, lotSize: number, date: string, charges: ChargeSettings) {
  if (!(premium > 0) || lotSize <= 0) return 0;
  let lots = Math.floor(allocation / (premium * lotSize));
  while (lots > 0 && premium * lots * lotSize + tradeCharges(premium, premium, lots * lotSize, date, charges).total > allocation) lots -= 1;
  return lots;
}

export type HedgeLeg = {
  right: Right;
  lots: number;
  quantity: number;
  /** LTP at the signal (the 09:15 candle close) used for sizing. */
  signalPrice: number;
  entryPrice: number;
  invested: number;
  exitPrice: number | null;
  gross: number | null;
  charges: number | null;
};

export type HedgeExitReason = "TARGET" | "SQUARE_OFF" | "STOP_LOSS" | "TIME_EXIT";
export type HedgeStatus = "NO_DATA" | "NOT_EXECUTED" | "WAITING" | "OPEN" | "CLOSED";

export type HedgeDayInput = {
  date: string;
  expiry: string;
  /** Close of the first 1-minute NIFTY candle (09:15). */
  firstClose: number;
  strike: number;
  lotSize: number;
  ce: MinuteBar[];
  pe: MinuteBar[];
};

export type HedgeDayResult = {
  status: HedgeStatus;
  note: string;
  date: string;
  expiry: string;
  strike: number;
  firstClose: number;
  entryTime: number | null;
  ce: HedgeLeg | null;
  pe: HedgeLeg | null;
  combinedEntry: number | null;
  targetPremium: number | null;
  /** Combined premium at the moment of the latest snapshot (paper) or at the exit (closed). */
  combinedNow: number | null;
  exitTime: number | null;
  exitReason: HedgeExitReason | null;
  /** Combined snapshot price that triggered the exit (before slippage), and the realised combined sell price. */
  combinedTrigger: number | null;
  combinedExit: number | null;
  /** Realised combined points = combined exit − combined entry (per unit of a 1:1 straddle). */
  points: number | null;
  /** Best / worst combined snapshot points while open (before slippage). */
  maxPoints: number | null;
  minPoints: number | null;
  holdMinutes: number | null;
  gross: number | null;
  charges: number | null;
  net: number | null;
  invested: number | null;
  staleSquareOff: boolean;
};

const emptyResult = (input: HedgeDayInput, status: HedgeStatus, note: string): HedgeDayResult => ({
  status, note, date: input.date, expiry: input.expiry, strike: input.strike, firstClose: input.firstClose, entryTime: null, ce: null, pe: null,
  combinedEntry: null, targetPremium: null, combinedNow: null, exitTime: null, exitReason: null, combinedTrigger: null, combinedExit: null,
  points: null, maxPoints: null, minPoints: null, holdMinutes: null, gross: null, charges: null, net: null, invested: null, staleSquareOff: false,
});

/**
 * Evaluate one session. `now` (minutes, IST) is for paper mode: only candles complete by `now` are used (a bar's open is
 * usable from t, its close from t+1). Backtest: leave `now` at the default (end of day).
 */
export function evaluateHedgeDay(input: HedgeDayInput, settings: HedgeSettings = HEDGE_DEFAULTS, now = 24 * 60): HedgeDayResult {
  const s = settings;
  const ceAt = new Map(input.ce.map((bar) => [bar.t, bar]));
  const peAt = new Map(input.pe.map((bar) => [bar.t, bar]));
  if (now < s.signalTime) return emptyResult(input, "WAITING", "Waiting for the first 1-minute candle to complete (09:16).");

  // --- entry: first minute ≥ 09:16 (and ≤ the deadline) where both legs trade; its open is the fill.
  let entryTime: number | null = null;
  for (let t = s.signalTime; t <= s.entryDeadline && t <= now; t += 1) {
    if (ceAt.has(t) && peAt.has(t)) { entryTime = t; break; }
  }
  if (entryTime === null) {
    if (now <= s.entryDeadline) return emptyResult(input, "WAITING", "Waiting for both legs to trade.");
    return emptyResult(input, "NOT_EXECUTED", `No candle for both CE and PE between ${clockOf(s.signalTime)} and ${clockOf(s.entryDeadline)}; nothing bought.`);
  }
  const slip = s.slippageTicks * s.tick;
  const lastBefore = (bars: MinuteBar[], t: number) => [...bars].reverse().find((bar) => bar.t < t);
  const legAllocation = { CE: s.capital * s.ceShare, PE: s.capital * (1 - s.ceShare) };
  const legs: Partial<Record<Right, HedgeLeg>> = {};
  for (const right of ["CE", "PE"] as Right[]) {
    const bars = right === "CE" ? input.ce : input.pe;
    const bar = (right === "CE" ? ceAt : peAt).get(entryTime)!;
    const signalPrice = lastBefore(bars, s.signalTime)?.close ?? bar.open;
    const entryPrice = tickUp(bar.open + slip, s.tick);
    // size on the signal LTP with headroom, then confirm the actual fill still fits (else drop lots)
    let lots = legLots(legAllocation[right], Math.max(signalPrice * (1 + s.sizingBuffer), entryPrice), input.lotSize, input.date, s.charges);
    while (lots > 0 && entryPrice * lots * input.lotSize + tradeCharges(entryPrice, entryPrice, lots * input.lotSize, input.date, s.charges).total > legAllocation[right]) lots -= 1;
    const quantity = lots * input.lotSize;
    legs[right] = { right, lots, quantity, signalPrice, entryPrice, invested: r2(entryPrice * quantity), exitPrice: null, gross: null, charges: null };
  }
  if (s.sizing === "EQUAL_QTY") {
    const c = legs.CE!, p = legs.PE!;
    let lots = legLots(s.capital, Math.max(c.signalPrice + p.signalPrice, (c.entryPrice + p.entryPrice) / (1 + s.sizingBuffer)) * (1 + s.sizingBuffer), input.lotSize, input.date, s.charges);
    while (lots > 0 && (c.entryPrice + p.entryPrice) * lots * input.lotSize + 2 * tradeCharges(c.entryPrice + p.entryPrice, c.entryPrice + p.entryPrice, lots * input.lotSize, input.date, s.charges).total > s.capital) lots -= 1;
    for (const leg of [c, p]) Object.assign(leg, { lots, quantity: lots * input.lotSize, invested: r2(leg.entryPrice * lots * input.lotSize) });
  }
  const ce = legs.CE!, pe = legs.PE!;
  if (ce.lots === 0 || pe.lots === 0) {
    return { ...emptyResult(input, "NOT_EXECUTED", `Capital too small: ${ce.lots === 0 ? "CE" : "PE"} allocation buys 0 lots.`), ce, pe };
  }
  const combinedEntry = r2(ce.entryPrice + pe.entryPrice);
  const target = targetPremium(combinedEntry, s);
  const base: HedgeDayResult = {
    ...emptyResult(input, "OPEN", "Position open."), entryTime, ce, pe, combinedEntry, targetPremium: r2(target), invested: r2(ce.invested + pe.invested),
  };

  // --- monitoring: snapshots (open of t if t > entry minute, then close of t), until the square-off minute.
  let maxPoints = -Infinity, minPoints = Infinity, combinedNow = combinedEntry;
  const finish = (time: number, reason: HedgeExitReason, cePx: number, pePx: number, trigger: number, stale = false): HedgeDayResult => {
    const ceExit = Math.max(tickDown(cePx - slip, s.tick), 0);
    const peExit = Math.max(tickDown(pePx - slip, s.tick), 0);
    const ceCh = tradeCharges(ce.entryPrice, ceExit, ce.quantity, input.date, s.charges).total;
    const peCh = tradeCharges(pe.entryPrice, peExit, pe.quantity, input.date, s.charges).total;
    const ceGross = r2((ceExit - ce.entryPrice) * ce.quantity);
    const peGross = r2((peExit - pe.entryPrice) * pe.quantity);
    const gross = r2(ceGross + peGross);
    const charges = r2(ceCh + peCh);
    return {
      ...base, status: "CLOSED", note: reason === "TARGET" ? "Combined premium reached the target; both legs sold." : reason === "SQUARE_OFF" ? "Target not reached; both legs squared off." : `Exit: ${reason}.`,
      ce: { ...ce, exitPrice: ceExit, gross: ceGross, charges: ceCh }, pe: { ...pe, exitPrice: peExit, gross: peGross, charges: peCh },
      combinedNow: r2(cePx + pePx), exitTime: time, exitReason: reason, combinedTrigger: r2(trigger), combinedExit: r2(ceExit + peExit),
      points: r2(ceExit + peExit - combinedEntry), maxPoints: Number.isFinite(maxPoints) ? r2(maxPoints) : null, minPoints: Number.isFinite(minPoints) ? r2(minPoints) : null,
      holdMinutes: time - entryTime, gross, charges, net: r2(gross - charges), staleSquareOff: stale,
    };
  };
  for (let t = entryTime; t < s.squareOffTime; t += 1) {
    const c = ceAt.get(t), p = peAt.get(t);
    if (!c || !p) continue;
    const snaps: [number, number, number][] = []; // [time the price is known, ce, pe]
    if (t > entryTime) snaps.push([t, c.open, p.open]);
    snaps.push([t + 1, c.close, p.close]);
    for (const [known, cePx, pePx] of snaps) {
      if (known > now) return { ...base, combinedNow: r2(combinedNow), maxPoints: Number.isFinite(maxPoints) ? r2(maxPoints) : null, minPoints: Number.isFinite(minPoints) ? r2(minPoints) : null };
      const combined = cePx + pePx;
      combinedNow = combined;
      const pts = combined - combinedEntry;
      maxPoints = Math.max(maxPoints, pts);
      minPoints = Math.min(minPoints, pts);
      if (combined >= target - EPS) return finish(known, "TARGET", cePx, pePx, combined);
      if (s.stopLossPoints > 0 && pts <= -s.stopLossPoints) return finish(known, "STOP_LOSS", cePx, pePx, combined);
      if (s.maxHoldMinutes > 0 && known - entryTime >= s.maxHoldMinutes) return finish(known, "TIME_EXIT", cePx, pePx, combined);
    }
  }
  if (now < s.squareOffTime) return { ...base, combinedNow: r2(combinedNow) };
  // --- square-off: the square-off candle's open; a leg without one uses its last close before it (stale, flagged).
  const exitPx = (at: Map<number, MinuteBar>, bars: MinuteBar[]) => at.get(s.squareOffTime)?.open ?? lastBefore(bars, s.squareOffTime)?.close ?? 0;
  const stale = !ceAt.has(s.squareOffTime) || !peAt.has(s.squareOffTime);
  const cePx = exitPx(ceAt, input.ce), pePx = exitPx(peAt, input.pe);
  return finish(s.squareOffTime, "SQUARE_OFF", cePx, pePx, cePx + pePx, stale);
}

/* ------------------------------------------------------------------------------------------------------------------
 * Paper / live order safety (pure; the caller reports broker order status, these decide what to do next).
 * ------------------------------------------------------------------------------------------------------------------ */

export type LegOrderStatus = "PENDING" | "FILLED" | "PARTIAL" | "REJECTED" | "CANCELLED";
export type LegOrder = { right: Right; requestedQty: number; filledQty: number; avgPrice: number; status: LegOrderStatus };

/**
 * After the two entry buys, decide the position. While any leg is still working → WAIT. Both complete → ACTIVE with the
 * filled quantities and weighted average prices. A leg that ends with nothing filled → UNWIND whatever the other leg
 * bought (never hold one leg alone). Partial fills that ended (`PARTIAL` reported final, or `CANCELLED` with a fill) keep
 * the filled quantity; `timedOut` turns a still-working order into its final filled state.
 */
export function reconcileEntry(ce: LegOrder, pe: LegOrder, timedOut = false) {
  const working = (o: LegOrder) => o.status === "PENDING" || (o.status === "PARTIAL" && o.filledQty < o.requestedQty && !timedOut);
  if (!timedOut && (working(ce) || working(pe))) return { action: "WAIT" as const, unwind: [] as { right: Right; qty: number }[], cancel: [] as Right[], combinedEntry: null, note: "Waiting for both legs to fill." };
  const cancel = [ce, pe].filter((o) => o.filledQty < o.requestedQty && (o.status === "PENDING" || o.status === "PARTIAL")).map((o) => o.right);
  if (ce.filledQty > 0 && pe.filledQty > 0) {
    return { action: "ACTIVE" as const, unwind: [], cancel, combinedEntry: r2(ce.avgPrice + pe.avgPrice), note: ce.filledQty === ce.requestedQty && pe.filledQty === pe.requestedQty ? "Both legs filled." : "Partial fill kept: P&L uses the filled quantities." };
  }
  const unwind = [ce, pe].filter((o) => o.filledQty > 0).map((o) => ({ right: o.right, qty: o.filledQty }));
  return { action: "UNWIND" as const, unwind, cancel, combinedEntry: null, note: unwind.length ? `${unwind[0].right === "CE" ? "PE" : "CE"} leg not filled: selling the ${unwind[0].right} leg; no position.` : "Neither leg filled: no position." };
}

/**
 * Exit orders still needed: a SELL for each leg with open quantity and no working exit order. Calling it again while the
 * sells are working returns nothing (no duplicate exits); a leg is closed only once the broker reports its sell filled.
 */
export function pendingExitOrders(openQty: Record<Right, number>, workingExitQty: Record<Right, number>) {
  return (["CE", "PE"] as Right[]).filter((right) => openQty[right] > 0 && workingExitQty[right] === 0).map((right) => ({ right, side: "SELL" as const, qty: openQty[right] }));
}

/* ------------------------------------------------------------------------------------------------------------------
 * Live dashboard view model.
 * ------------------------------------------------------------------------------------------------------------------ */

export function hedgeMonitor(args: {
  ceEntry: number; peEntry: number; ceNow: number; peNow: number; ceQty: number; peQty: number;
  targetMode: HedgeTargetMode; targetValue: number; date: string; charges?: ChargeSettings; closed?: boolean;
}) {
  const combinedEntry = r2(args.ceEntry + args.peEntry);
  const combinedNow = r2(args.ceNow + args.peNow);
  const target = r2(targetPremium(combinedEntry, args));
  const profitPoints = r2(combinedNow - combinedEntry);
  const targetPoints = target - combinedEntry;
  const ceGross = r2((args.ceNow - args.ceEntry) * args.ceQty);
  const peGross = r2((args.peNow - args.peEntry) * args.peQty);
  const charges = args.charges
    ? r2(tradeCharges(args.ceEntry, args.ceNow, args.ceQty, args.date, args.charges).total + tradeCharges(args.peEntry, args.peNow, args.peQty, args.date, args.charges).total)
    : 0;
  const invested = r2(args.ceEntry * args.ceQty + args.peEntry * args.peQty);
  const reached = combinedNow >= target - EPS;
  return {
    combinedEntry, combinedNow, profitPoints, targetPremium: target, remainingPoints: r2(Math.max(target - combinedNow, 0)),
    progressPct: targetPoints > 0 ? r2((profitPoints / targetPoints) * 100) : 0,
    ce: { invested: r2(args.ceEntry * args.ceQty), pnl: ceGross }, pe: { invested: r2(args.peEntry * args.peQty), pnl: peGross },
    invested, gross: r2(ceGross + peGross), charges, net: r2(ceGross + peGross - charges), returnPct: invested > 0 ? r2(((ceGross + peGross - charges) / invested) * 100) : 0,
    status: args.closed ? "CLOSED" : reached ? "TARGET REACHED – EXIT BOTH LEGS" : "MONITORING",
  };
}
