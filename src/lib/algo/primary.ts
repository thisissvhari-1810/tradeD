import type { Candle } from "./lines";
import type { Direction, StrategySignal } from "./patterns";

/**
 * "Algo - Primary Strategy": NIFTY 50 options on an opening-range breakout confirmed by session VWAP and
 * the trend. Decided only on completed 1-minute index candles, by walking the session in order (so the
 * decision on any candle depends only on candles up to it, and replaying the same candles always gives
 * the same decisions):
 * - the opening range is the high / low of the first `orMinutes` (default 09:15–09:30); nothing is traded
 *   inside it, and nothing seen inside it is carried out of it;
 * - BREAKOUT / BREAKDOWN: a completed close beyond the range edge (crossing it on that candle) arms that
 *   direction. The entry is the first candle, within `confirmBars`, on which VWAP and the trend agree while
 *   price is still beyond the edge. A close back inside disarms it. Each armed setup enters at most once;
 * - RETEST (optional): after a break, a candle touches the edge and closes back beyond it;
 * - CONTINUATION (optional): after a breakout, the 9 EMA crosses back over the 21 EMA in the breakout's
 *   direction while price is beyond the range edge and on the right side of VWAP (once per cross, so a
 *   trend that simply continues is never bought again on every candle);
 * - SUPPORT BREAKDOWN (optional, off by default): a close below a support that is still above the range low —
 *   the range high once price has been above it, or the latest confirmed swing low. It is labelled as such,
 *   never as an opening-range breakdown, and needs the same VWAP and trend confirmation.
 * VWAP needs volume. Index candles often have none; then the strategy either uses a clearly labelled TWAP
 * (time-weighted average of the typical price) or refuses the setup — never an invented VWAP.
 */

export type PrimarySettings = {
  /** Opening-range length from 09:15 (15 = 09:15–09:30). */
  orMinutes: number;
  /** Require price above (CALL) / below (PUT) session VWAP. */
  vwap: boolean;
  /** Without volume on the index candles: use a time-weighted average instead, or refuse the setup. */
  vwapFallback: "twap" | "reject";
  /** Trend confirmation: 9 / 21 EMA of the session's closes, or none. */
  trend: "ema" | "none";
  trendFast: number;
  trendSlow: number;
  /** Also enter on a retest of the broken range edge. */
  retest: boolean;
  /** A break not retested within this many candles expires. */
  retestBars: number;
  /** A close must clear the range edge by this % (0 = any close beyond it). */
  breakBufferPercent: number;
  /** The stop on the index: beyond the signal candle's extreme, the range midpoint, or the opposite range edge. */
  stopBasis: "candle" | "mid" | "range";
  /** A break waits this many candles for VWAP and trend confirmation (0 = only on the breaking candle). */
  confirmBars: number;
  /** Also enter on a 9 / 21 EMA re-cross in the breakout's direction (a pullback continuation). */
  continuation: boolean;
  /** Also take a PUT on a support breakdown above the range low (labelled separately from the ORB). */
  supportBreak: boolean;
};

export const PRIMARY_SETTINGS_DEFAULTS: PrimarySettings = { orMinutes: 15, vwap: true, vwapFallback: "twap", trend: "ema", trendFast: 9, trendSlow: 21, retest: false, retestBars: 10, breakBufferPercent: 0.02, stopBasis: "candle", confirmBars: 10, continuation: true, supportBreak: false };

export type PrimarySetup = "BREAKOUT" | "BREAKDOWN" | "RETEST" | "CONTINUATION" | "SUPPORT BREAKDOWN";

/** Everything the strategy saw on one candle, for the signal audit (no value is estimated or invented). */
export type PrimaryAudit = {
  time: number;
  candle: { open: number; high: number; low: number; close: number };
  range: { high: number; low: number } | null;
  vwap: { value: number; source: "VWAP" | "TWAP" } | null;
  ema: { fast: number; slow: number } | null;
  trend: "BULLISH" | "BEARISH" | "FLAT" | null;
  /** A fresh close beyond a level on this candle. */
  crossing: string | null;
  /** The setup armed or triggered (with its direction), if any. */
  setup: { type: PrimarySetup; direction: Direction; level: number; since: number } | null;
  passed: string[];
  failed: string[];
  /** The strategy's verdict; the runner then reports the order result (entered, or rejected and why). */
  decision: "ENTER" | "WAIT" | "REJECT";
  reason: string;
};

export type PrimaryState = {
  status: string;
  range: { high: number; low: number; end: number; complete: boolean } | null;
  vwap: { value: number; source: "VWAP" | "TWAP" } | null;
  trend: "BULLISH" | "BEARISH" | "FLAT" | null;
  /** Every condition checked on the last candle, in plain words. */
  checks: string[];
  audit?: PrimaryAudit | null;
};

const clock = (time: number) => new Date((time + 19_800) * 1000).toISOString().slice(11, 16);
const round = (value: number) => Math.round(value * 100) / 100;
const fmt = (value: number) => value.toFixed(2);

/** Session VWAP from volume, or the labelled TWAP fallback when the candles carry no volume. */
export function sessionVwap(candles: Candle[], fallback: PrimarySettings["vwapFallback"]): PrimaryState["vwap"] {
  if (!candles.length) return null;
  const typical = (candle: Candle) => (candle.high + candle.low + candle.close) / 3;
  const volume = candles.reduce((sum, candle) => sum + (candle.volume ?? 0), 0);
  if (volume > 0) return { value: round(candles.reduce((sum, candle) => sum + typical(candle) * (candle.volume ?? 0), 0) / volume), source: "VWAP" };
  if (fallback === "reject") return null;
  return { value: round(candles.reduce((sum, candle) => sum + typical(candle), 0) / candles.length), source: "TWAP" };
}

type Armed = { type: PrimarySetup; direction: Direction; level: number; since: number; label: string };

/**
 * The Primary Strategy on the session's completed candles (the last one is the candle being evaluated).
 * Returns at most one signal for that candle, with its level and invalidation (where the stop goes), and
 * an audit of every condition.
 */
export function primarySignal(candles: Candle[], sessionOpen: number, input: PrimarySettings): { signal: StrategySignal | null; state: PrimaryState } {
  const settings = { ...PRIMARY_SETTINGS_DEFAULTS, ...input };
  const end = sessionOpen + settings.orMinutes * 60;
  const inside = candles.filter((candle) => candle.time >= sessionOpen && candle.time < end);
  const last = candles.at(-1);
  if (!last || !inside.length) return { signal: null, state: { status: "WAITING — Waiting for the open", range: null, vwap: null, trend: null, checks: [], audit: null } };
  const range = { high: Math.max(...inside.map((candle) => candle.high)), low: Math.min(...inside.map((candle) => candle.low)), end, complete: last.time + 60 >= end };
  const up = range.high * (1 + settings.breakBufferPercent / 100);
  const down = range.low * (1 - settings.breakBufferPercent / 100);
  const lastIndex = candles.length - 1;

  // Indicators candle by candle (each uses only the candles up to it).
  const fastK = 2 / (settings.trendFast + 1);
  const slowK = 2 / (settings.trendSlow + 1);
  let fast = 0;
  let slow = 0;
  let pv = 0;
  let vol = 0;
  let tp = 0;
  const vwapAt: Array<PrimaryState["vwap"]> = [];
  const emaAt: Array<{ fast: number; slow: number } | null> = [];
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const typical = (candle.high + candle.low + candle.close) / 3;
    pv += typical * (candle.volume ?? 0);
    vol += candle.volume ?? 0;
    tp += typical;
    vwapAt.push(vol > 0 ? { value: round(pv / vol), source: "VWAP" } : settings.vwapFallback === "reject" ? null : { value: round(tp / (index + 1)), source: "TWAP" });
    fast = index === 0 ? candle.close : candle.close * fastK + fast * (1 - fastK);
    slow = index === 0 ? candle.close : candle.close * slowK + slow * (1 - slowK);
    emaAt.push(index + 1 >= settings.trendSlow ? { fast, slow } : null);
  }
  const trendAt = (index: number): PrimaryState["trend"] => {
    const value = emaAt[index];
    return value ? (value.fast > value.slow ? "BULLISH" : value.fast < value.slow ? "BEARISH" : "FLAT") : null;
  };
  const vwap = vwapAt[lastIndex];
  const trend = trendAt(lastIndex);
  const base: PrimaryState = { status: "", range: { ...range, high: round(range.high), low: round(range.low) }, vwap, trend, checks: [] };
  const auditOf = (crossing: string | null, setup: PrimaryAudit["setup"], passed: string[], failed: string[], decision: PrimaryAudit["decision"], reason: string): PrimaryAudit => ({
    time: last.time, candle: { open: last.open, high: last.high, low: last.low, close: last.close }, range: { high: round(range.high), low: round(range.low) },
    vwap, ema: emaAt[lastIndex] ? { fast: round(emaAt[lastIndex]!.fast), slow: round(emaAt[lastIndex]!.slow) } : null, trend, crossing, setup, passed, failed, decision, reason,
  });
  // Inside the observation window: analysis only, and nothing is carried forward.
  if (last.time < end) {
    const status = `WAITING — Observing the opening range (to ${clock(end)})`;
    return { signal: null, state: { ...base, status, audit: auditOf(null, null, [], [], "WAIT", status) } };
  }

  // The confirmations a direction needs on candle `index`: VWAP side and trend (each reported).
  const confirm = (index: number, direction: Direction) => {
    const bull = direction === "CALL";
    const close = candles[index].close;
    const passed: string[] = [];
    const failed: string[] = [];
    if (settings.vwap) {
      const value = vwapAt[index];
      if (!value) failed.push("VWAP unavailable (no index volume; the fallback is set to refuse)");
      else if (bull ? close > value.value : close < value.value) passed.push(`close ${bull ? "above" : "below"} ${value.source} ${fmt(value.value)}${value.source === "TWAP" ? " (no index volume, so not a true VWAP)" : ""}`);
      else failed.push(`close ${fmt(close)} is ${close > value.value ? "above" : "below"} ${value.source} ${fmt(value.value)}`);
    }
    if (settings.trend === "ema") {
      const value = emaAt[index];
      const state = trendAt(index);
      if (!value) failed.push(`fewer than ${settings.trendSlow} candles for the ${settings.trendSlow} EMA`);
      else if (state === (bull ? "BULLISH" : "BEARISH")) passed.push(`${settings.trendFast} EMA ${fmt(value.fast)} ${bull ? ">" : "<"} ${settings.trendSlow} EMA ${fmt(value.slow)}`);
      else failed.push(`${settings.trendFast} EMA ${fmt(value.fast)} ${value.fast > value.slow ? ">" : "≤"} ${settings.trendSlow} EMA ${fmt(value.slow)} (trend ${state?.toLowerCase()})`);
    }
    return { passed, failed };
  };

  // Walk the session from the end of the range: arm, confirm, consume. Only the last candle's outcome is returned.
  const first = candles.findIndex((candle) => candle.time >= end);
  const armed: Record<Direction, Armed | null> = { CALL: null, PUT: null };
  const lastBreak: Record<Direction, { index: number; retested: boolean } | null> = { CALL: null, PUT: null };
  let brokeUp = false;
  let brokeDown = false;
  let outcome: { signal: StrategySignal | null; status: string; audit: PrimaryAudit } | null = null;
  // Confirmed swing lows (2 candles each side), for the support breakdown.
  const swingLowBefore = (index: number) => {
    for (let at = index - 3; at >= Math.max(2, first); at -= 1) {
      const low = candles[at].low;
      if (low < candles[at - 1].low && low < candles[at - 2].low && low <= candles[at + 1].low && low <= candles[at + 2].low) return { price: low, time: candles[at].time };
    }
    return null;
  };
  for (let index = Math.max(1, first); index <= lastIndex; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const isLast = index === lastIndex;
    const crossings: string[] = [];
    const fired: Array<{ direction: Direction; type: PrimarySetup; level: number; note: string; passed: string[] }> = [];
    const waiting: Array<{ armed: Armed; failed: string[]; passed: string[] }> = [];

    // Fresh crossings of the range edges arm a breakout / breakdown (a later re-break re-arms it).
    if (candle.close > up && previous.close <= up) {
      crossings.push(`close ${fmt(candle.close)} crossed above the range high ${fmt(range.high)}`);
      armed.CALL = { type: "BREAKOUT", direction: "CALL", level: range.high, since: index, label: "opening-range breakout" };
      lastBreak.CALL = { index, retested: false };
      brokeUp = true;
    }
    if (candle.close < down && previous.close >= down) {
      crossings.push(`close ${fmt(candle.close)} crossed below the range low ${fmt(range.low)}`);
      armed.PUT = { type: "BREAKDOWN", direction: "PUT", level: range.low, since: index, label: "opening-range breakdown" };
      lastBreak.PUT = { index, retested: false };
      brokeDown = true;
    }
    // Support breakdown (optional): a close below support that stays above the range low.
    if (settings.supportBreak && candle.close >= down) {
      const supports: Array<{ price: number; label: string }> = [];
      if (brokeUp) supports.push({ price: range.high, label: `the range high ${fmt(range.high)} (support after the breakout)` });
      const swing = swingLowBefore(index);
      if (swing && swing.price > range.low) supports.push({ price: swing.price, label: `the swing low ${fmt(swing.price)} at ${clock(swing.time)}` });
      const broken = supports.find((support) => candle.close < support.price && previous.close >= support.price);
      if (broken) {
        crossings.push(`close ${fmt(candle.close)} broke below ${broken.label}, above the range low ${fmt(range.low)}`);
        armed.PUT = { type: "SUPPORT BREAKDOWN", direction: "PUT", level: broken.price, since: index, label: `support breakdown below ${broken.label}` };
      }
    }

    for (const direction of ["CALL", "PUT"] as const) {
      const bull = direction === "CALL";
      const setup = armed[direction];
      if (setup) {
        // Back through the level: the break failed. Out of time: it expired.
        const back = bull ? candle.close <= setup.level * (1 + settings.breakBufferPercent / 100) : candle.close >= setup.level * (1 - settings.breakBufferPercent / 100);
        if (back && index !== setup.since) armed[direction] = null;
        else if (index - setup.since > settings.confirmBars) armed[direction] = null;
        else {
          const check = confirm(index, direction);
          if (!check.failed.length) {
            fired.push({ direction, type: setup.type, level: setup.level, note: index === setup.since ? `${setup.label}: ${crossings.join("; ")}` : `${setup.label} at ${clock(candles[setup.since].time + 60)}, confirmed ${index - setup.since} candle${index - setup.since === 1 ? "" : "s"} later (close ${fmt(candle.close)} still ${bull ? "above" : "below"} ${fmt(setup.level)})`, passed: check.passed });
            armed[direction] = null;
          } else waiting.push({ armed: setup, failed: check.failed, passed: check.passed });
        }
      }
      // Retest of the broken edge, once per break.
      const broke = lastBreak[direction];
      if (settings.retest && broke && !broke.retested && index > broke.index && index - broke.index <= settings.retestBars && !fired.some((item) => item.direction === direction)) {
        const edge = bull ? range.high : range.low;
        const touched = bull ? candle.low <= edge * 1.0003 : candle.high >= edge * 0.9997;
        const reclaimed = bull ? candle.close > up && candle.close > candle.open : candle.close < down && candle.close < candle.open;
        if (touched && reclaimed) {
          broke.retested = true;
          const check = confirm(index, direction);
          if (!check.failed.length) fired.push({ direction, type: "RETEST", level: edge, note: `retest of the range ${bull ? "high" : "low"} ${fmt(edge)} held (${bull ? "low" : "high"} ${fmt(bull ? candle.low : candle.high)}, close ${fmt(candle.close)})`, passed: check.passed });
          else if (isLast) waiting.push({ armed: { type: "RETEST", direction, level: edge, since: index, label: "retest" }, failed: check.failed, passed: check.passed });
        }
      }
      // Continuation: a fresh EMA re-cross in the breakout's direction, beyond the range and on the VWAP side.
      if (settings.continuation && settings.trend === "ema" && (bull ? brokeUp : brokeDown) && !fired.some((item) => item.direction === direction) && emaAt[index] && emaAt[index - 1]) {
        const now = emaAt[index]!;
        const before = emaAt[index - 1]!;
        const crossed = bull ? now.fast > now.slow && before.fast <= before.slow : now.fast < now.slow && before.fast >= before.slow;
        const beyond = bull ? candle.close > up : candle.close < down;
        if (crossed && beyond && !armed[direction]) {
          crossings.push(`${settings.trendFast} EMA crossed ${bull ? "above" : "below"} the ${settings.trendSlow} EMA`);
          const check = confirm(index, direction);
          if (!check.failed.length) fired.push({ direction, type: "CONTINUATION", level: bull ? range.high : range.low, note: `pullback continuation: the ${settings.trendFast} EMA crossed back ${bull ? "above" : "below"} the ${settings.trendSlow} EMA with the close ${fmt(candle.close)} ${bull ? "above the range high" : "below the range low"}`, passed: check.passed });
          else if (isLast) waiting.push({ armed: { type: "CONTINUATION", direction, level: bull ? range.high : range.low, since: index, label: "continuation" }, failed: check.failed, passed: check.passed });
        }
      }
    }
    if (!isLast) continue;

    const crossing = crossings.length ? crossings.join("; ") : null;
    if (fired.length > 1 && new Set(fired.map((item) => item.direction)).size > 1) {
      const reason = `REJECTED — Conflicting setups on one candle (${fired.map((item) => `${item.type} ${item.direction}`).join(", ")}): no entry.`;
      outcome = { signal: null, status: reason, audit: auditOf(crossing, null, [], ["conflicting setups"], "REJECT", reason) };
      break;
    }
    if (fired.length) {
      const hit = fired[0];
      const bull = hit.direction === "CALL";
      const invalidation = settings.stopBasis === "range" ? (bull ? range.low : hit.type === "SUPPORT BREAKDOWN" ? hit.level : range.high) : settings.stopBasis === "mid" ? (range.high + range.low) / 2 : bull ? candle.low : candle.high;
      const stopText = settings.stopBasis === "range" ? `${bull ? "the range low" : hit.type === "SUPPORT BREAKDOWN" ? "the broken support" : "the range high"}` : settings.stopBasis === "mid" ? "the range midpoint" : `the signal candle's ${bull ? "low" : "high"}`;
      const checks = [`${hit.type}: ${hit.note}`, ...hit.passed.map((item) => `✓ ${item}`), `Stop beyond ${stopText} ${fmt(invalidation)}.`];
      const signal: StrategySignal = { id: `primary:${hit.direction}:${candle.time}`, strategy: "primary", direction: hit.direction, time: candle.time, trigger: candle.close, level: round(hit.level), invalidation: round(invalidation), reason: `Primary ${hit.type} ${hit.direction}: ${checks.join(" ")}`, volume: "NOT_REQUIRED" };
      const status = `SIGNAL CONFIRMED — ${hit.type} ${hit.direction}: checking the option contract`;
      outcome = { signal, status, audit: auditOf(crossing, { type: hit.type, direction: hit.direction, level: round(hit.level), since: candle.time }, hit.passed, [], "ENTER", status) };
      break;
    }
    if (waiting.length) {
      const item = waiting[0];
      const missing = item.failed.some((text) => text.startsWith("VWAP") || text.includes("VWAP") || text.includes("TWAP")) ? "VWAP confirmation missing" : "EMA trend confirmation missing";
      const left = Math.max(0, settings.confirmBars - (index - item.armed.since));
      const status = `WAITING — ${missing} (${item.armed.type} ${item.armed.direction} armed at ${clock(candles[item.armed.since].time + 60)}; ${left} candle${left === 1 ? "" : "s"} left)`;
      outcome = { signal: null, status, audit: auditOf(crossing, { type: item.armed.type, direction: item.armed.direction, level: round(item.armed.level), since: candles[item.armed.since].time }, item.passed, item.failed, "WAIT", status) };
      break;
    }
    const where = candle.close > range.high ? "above" : candle.close < range.low ? "below" : "inside";
    const status = where === "inside"
      ? "WAITING — Price remains inside the opening range"
      : `WAITING — Price is ${where} the opening range with no fresh setup${settings.continuation ? ` (a continuation needs a new ${settings.trendFast} / ${settings.trendSlow} EMA cross)` : ""}`;
    outcome = { signal: null, status, audit: auditOf(crossing, null, [], [], "WAIT", status) };
  }

  const result = outcome ?? { signal: null, status: "WAITING — Price remains inside the opening range", audit: auditOf(null, null, [], [], "WAIT", "WAITING — Price remains inside the opening range") };
  const audit = result.audit;
  const checks = [
    `Range ${fmt(range.low)}–${fmt(range.high)}; close ${fmt(last.close)}.`,
    ...(audit.crossing ? [`Crossing: ${audit.crossing}.`] : []),
    ...audit.passed.map((item) => `✓ ${item}.`),
    ...audit.failed.map((item) => `✗ ${item}.`),
  ];
  return { signal: result.signal, state: { ...base, status: result.status, checks, audit } };
}
