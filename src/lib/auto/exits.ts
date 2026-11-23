/**
 * Automated paper trading: exits and sizing, ported from the research engine (opt_engine.exit_sim "real" model,
 * inv_engine.charge / lots_for, monwed.py fixed exit). Pure: it reads the option's completed 1-minute candles in time
 * order and keeps a small state, so the engine can feed new candles on every check without re-reading old ones.
 *
 * Trailing exit (Second Hour family, Hourly Breakout FINAL, 13:15 Minute):
 *   start level A = buy × (1 + a%), a = min(2%, ₹2 as a % of the buy price)  → the lower of +2% and +₹2;
 *   the trail starts when the option trades at A + 1 tick in a minute with volume; then
 *   stop = max(highest − 1% of the buy price, A), never down; sold 1 tick below the stop.
 *   Trade-2 lock (dyn): once the option has traded at +L%, a stop sits at +L% until the trail starts (Second Hour 0.5%,
 *   13:15 Minute 0.7%). Otherwise the 15:20 square-off at the last close before 15:20 − 1 tick.
 *   Within a minute the price path is the candle-colour path (green O-L-H-C, red O-H-L-C), as in the backtest.
 * Fixed target (MonWed): +1.48% resting limit from 10:15, else the 15:20 close.
 */
import { r2, SQ, TICK, type Bar } from "./rules";

export type TrailState = {
  entry: number;
  start: number; // trail start level A (= the floor)
  trail: number; // 1% of the buy price, in rupees
  lock: number | null; // trade-2 lock level, once armed
  lockAt: number | null; // the lock's arming level (+L%)
  active: boolean;
  peak: number | null;
  hiSeen: number;
  last: number | null; // last close seen
  lastMinute: number | null;
};

export type ExitHit = { minute: number; price: number; reason: "TRAIL_STOP" | "LOCK_STOP" | "TARGET" | "TIME_EXIT" };

export function trailStart(entry: number) {
  const a = Math.min(2.0, (2.0 / entry) * 100);
  return { pct: a, level: r2(entry * (1 + a / 100)) };
}

export function newTrail(entry: number, lockPct: number | null): TrailState {
  const { level } = trailStart(entry);
  return { entry, start: level, trail: 0.01 * entry, lock: null, lockAt: lockPct != null ? lockPct : null, active: false, peak: null, hiSeen: entry, last: null, lastMinute: null };
}

/** One completed option candle at `minute` (must be after the entry minute and in time order). */
export function trailStep(s: TrailState, minute: number, bar: Bar): ExitHit | null {
  if (minute >= SQ) return null;
  if (s.lastMinute != null && minute <= s.lastMinute) return null; // already read
  s.lastMinute = minute;
  const { o: op, h: hi, l: lo, c: cl } = bar;
  const vol = bar.v ?? 1;
  s.last = cl;
  const A = s.start;
  const lvl = (pk: number) => Math.max(pk - s.trail, A);
  const preStop = () => {
    if (s.lockAt == null) return null;
    if (s.hiSeen >= s.entry * (1 + s.lockAt / 100) - 1e-9) s.lock = r2(s.entry * (1 + s.lockAt / 100));
    return s.lock;
  };
  if (s.active && op <= lvl(s.peak!)) return { minute, price: r2(Math.max(TICK, op - TICK)), reason: "TRAIL_STOP" };
  let ps = s.active ? null : preStop();
  if (ps != null && op <= ps) return { minute, price: r2(Math.max(TICK, op - TICK)), reason: "LOCK_STOP" };
  const path = cl >= op ? [op, lo, hi, cl] : [op, hi, lo, cl];
  for (let k = 1; k < path.length; k += 1) {
    const x = path[k - 1];
    const y = path[k];
    if (y >= x) {
      s.hiSeen = Math.max(s.hiSeen, y);
      if (!s.active && vol > 0 && y >= A + TICK - 1e-9) {
        s.active = true;
        s.peak = y;
      } else if (s.active) s.peak = Math.max(s.peak!, y);
    } else {
      if (s.active && y <= lvl(s.peak!)) return { minute, price: r2(Math.max(TICK, lvl(s.peak!) - TICK)), reason: "TRAIL_STOP" };
      ps = s.active ? null : preStop();
      if (ps != null && y <= ps) return { minute, price: r2(Math.max(TICK, ps - TICK)), reason: "LOCK_STOP" };
    }
  }
  return null;
}

/** The stop the trail would sell at now (for the screen), or null before it starts. */
export function trailStopLevel(s: TrailState) {
  if (s.active && s.peak != null) return r2(Math.max(s.peak - s.trail, s.start));
  return s.lock;
}

export type TargetState = { entry: number; target: number; last: number | null; lastMinute: number | null };
export const newTarget = (entry: number, pct: number): TargetState => ({ entry, target: entry * (1 + pct), last: null, lastMinute: null });

/** MonWed: the +1.48% limit fills in the first minute whose high reaches it (monwed.py: high >= target). */
export function targetStep(s: TargetState, minute: number, bar: Bar): ExitHit | null {
  if (s.lastMinute != null && minute <= s.lastMinute) return null;
  s.lastMinute = minute;
  s.last = bar.c;
  if (minute > SQ) return null;
  if (bar.h >= s.target - 1e-9) return { minute, price: r2(s.target), reason: "TARGET" };
  return null;
}

// ─────────────────────────────── charges and sizing ───────────────────────────────

/** inv_engine.charge = TradeD's optionCharges (paise maths), in rupees. */
export function chargeRupees(side: "BUY" | "SELL", premium: number, qty: number) {
  const turnover = Math.round(premium * 100) * qty;
  const bps = (value: number, b: number) => Math.floor((value * b + 5_000) / 10_000); // TradeD bps(): rounded
  const brokerage = 2000;
  const exchange = bps(turnover, 5);
  const sebi = bps(turnover, 1);
  const stamp = side === "BUY" ? bps(turnover, 3) : 0;
  const stt = side === "SELL" ? bps(turnover, 6) : 0;
  const gst = Math.floor(((brokerage + exchange) * 18) / 100);
  return (brokerage + exchange + sebi + stamp + stt + gst) / 100;
}

/** lots_for: whole lots (max 50) whose cost plus buy charges fits the capital. */
export function lotsFor(price: number, lot: number, capital: number, chargesOf: (premium: number, qty: number) => number = (p, q) => chargeRupees("BUY", p, q)) {
  let k = Math.min(50, Math.floor(capital / (price * lot)));
  while (k > 0 && price * k * lot + chargesOf(price, k * lot) > capital) k -= 1;
  return Math.max(0, k);
}
