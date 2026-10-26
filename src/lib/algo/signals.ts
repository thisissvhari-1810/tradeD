import type { AlgoLine, Candle, LineType } from "./lines";
import type { StrategySignal } from "./patterns";

/**
 * Candle-body crossings on completed 1-minute candles, and one decision per candle.
 *
 * For a line at price L, comparing the previous completed candle (p) with the current one (c):
 *   DOWN (bearish → ATM PUT):  p.close > L, c.open > L, c.close < L
 *   UP   (bullish → ATM CALL): p.close < L, c.open < L, c.close > L
 *
 * Deterministic boundary rule: if p.close, c.open or c.close equals L (to the paisa) the result is
 * BOUNDARY — touching a line is not a confirmed body crossing. A gap across L between p.close and
 * c.open is GAP (the body did not cross L). A wick through L with the body on one side is WICK. None of
 * these signal. Staying above or below a line never signals: a crossing needs the change itself.
 */

export type Direction = "UP" | "DOWN";
export type CrossKind = "CROSS" | "BOUNDARY" | "GAP" | "WICK" | "NONE";
export type CrossResult = { kind: CrossKind; direction: Direction | null; detail: string };

const PAISA = 0.005;
const same = (a: number, b: number) => Math.abs(a - b) < PAISA;

export function bodyCross(previous: Pick<Candle, "close">, current: Pick<Candle, "open" | "high" | "low" | "close">, level: number): CrossResult {
  const { close: before } = previous;
  const { open, close, high, low } = current;
  const touched = [before, open, close].some((value) => same(value, level));
  const spans = Math.min(before, open, close, low) <= level + PAISA && Math.max(before, open, close, high) >= level - PAISA;
  if (touched && spans) return { kind: "BOUNDARY", direction: null, detail: "Opened or closed exactly on the line: not a confirmed body crossing." };
  if (before > level && open > level && close < level) return { kind: "CROSS", direction: "DOWN", detail: "Previous close and this open above the line, this close below it." };
  if (before < level && open < level && close > level) return { kind: "CROSS", direction: "UP", detail: "Previous close and this open below the line, this close above it." };
  if ((before > level && open < level) || (before < level && open > level)) return { kind: "GAP", direction: null, detail: "Gapped across the line between candles: the body did not cross it." };
  if (high > level && low < level) return { kind: "WICK", direction: null, detail: "Only a wick crossed the line; the body stayed on one side." };
  return { kind: "NONE", direction: null, detail: "No crossing." };
}

/**
 * The body rule (Mathi Strategy): a bullish candle that opens at or below the line crosses it UP once its
 * close is above the line — by any amount when `fraction` is 0, or with at least `fraction` of its body
 * (close − open) above it; a bearish candle that opens at or
 * above it crosses DOWN once that share of its body (open − close) is below. Exactly on the line is not
 * beyond it, and a wick never counts. With the candle still forming, its current price is the close.
 */
export function bodyShareCross(current: Pick<Candle, "open" | "high" | "low" | "close">, level: number, fraction: number): CrossResult {
  const { open, close, high, low } = current;
  const body = Math.abs(close - open);
  if (close > open && open <= level + PAISA && close > level + PAISA) {
    const share = (close - level) / body;
    return share + 1e-9 >= fraction
      ? { kind: "CROSS", direction: "UP", detail: fraction > 0 ? `${Math.round(share * 100)}% of the bullish body is above the line (needs ${Math.round(fraction * 100)}%).` : `The bullish body crossed the line by ${(close - level).toFixed(2)} points.` }
      : { kind: "WICK", direction: null, detail: `Only ${Math.round(share * 100)}% of the bullish body is above the line (needs ${Math.round(fraction * 100)}%).` };
  }
  if (close < open && open >= level - PAISA && close < level - PAISA) {
    const share = (level - close) / body;
    return share + 1e-9 >= fraction
      ? { kind: "CROSS", direction: "DOWN", detail: fraction > 0 ? `${Math.round(share * 100)}% of the bearish body is below the line (needs ${Math.round(fraction * 100)}%).` : `The bearish body crossed the line by ${(level - close).toFixed(2)} points.` }
      : { kind: "WICK", direction: null, detail: `Only ${Math.round(share * 100)}% of the bearish body is below the line (needs ${Math.round(fraction * 100)}%).` };
  }
  if (high > level && low < level) return { kind: "WICK", direction: null, detail: "The body did not cross the line in the candle's direction (wick or the wrong colour)." };
  return { kind: "NONE", direction: null, detail: "No crossing." };
}

export type CrossEvent = { lineId: string; lineType: LineType; label: string; price: number; direction: Direction };
export type LineNote = { lineId: string; label: string; price: number; kind: Exclude<CrossKind, "CROSS" | "NONE">; detail: string };

export type Decision = "CALL" | "PUT" | "CONFLICTING_SIGNAL" | "NO_SIGNAL" | "FORMING" | "NO_PREVIOUS";

export type CandleEvaluation = {
  time: number;
  previousClose: number | null;
  candle: Candle;
  events: CrossEvent[];
  notes: LineNote[];
  /** Lines compared on this candle (enabled, and known when the previous candle formed). */
  evaluated?: number;
  /** Every strategy's signal on this candle (line break and the price-action add-ons), from the coordinator. */
  strategies?: StrategySignal[];
  decision: Decision;
  /** Plain-language reason for the decision. */
  explanation: string;
  /** Algo - Primary Strategy: every value and condition checked on this candle, and the order result. */
  audit?: import("./primary").PrimaryAudit | null;
  /**
   * Breakout confirmation (hold / retest modes): SIGNAL_DETECTED — the body crossed a line, not yet tradable;
   * WAITING — still waiting for its hold or retest; SETUP_CONFIRMED — passed, goes to the entry checks;
   * FALSE_BREAKOUT — price came back across the line, cancelled; EXPIRED — not confirmed in time, cancelled.
   */
  stage?: "SIGNAL_DETECTED" | "WAITING" | "SETUP_CONFIRMED" | "FALSE_BREAKOUT" | "EXPIRED";
  /** The side of the setup a stage refers to (the decision itself is NO_SIGNAL until it is confirmed). */
  setupSide?: "CALL" | "PUT";
  /** Why a pending setup was cancelled (FALSE_BREAKOUT / EXPIRED): no order is sent. */
  cancelled?: string;
  /** SETUP_CONFIRMED: the crossing that started the setup (its candle and lines); this candle only confirmed it. */
  breakout?: { time: number; candle: Candle; events: CrossEvent[] };
};

/** Same IST trading day (a session's first candle is never paired with the previous day's last). */
export function sameSession(a: number, b: number) {
  const day = (seconds: number) => new Date((seconds + 19_800) * 1000).toISOString().slice(0, 10);
  return day(a) === day(b);
}

/**
 * Evaluates one candle against every enabled line and consolidates the crossings into one decision.
 * A candle still forming (its minute not finished at `now`) is never a confirmed signal.
 */
export function evaluateCandle(input: { previous: Candle | null; candle: Candle; lines: AlgoLine[]; enabled: (line: AlgoLine) => boolean; now: number; fraction?: number; forming?: boolean }): CandleEvaluation {
  const { previous, candle, lines, enabled, now } = input;
  const base = { time: candle.time, previousClose: previous?.close ?? null, candle, events: [] as CrossEvent[], notes: [] as LineNote[] };
  if (candle.time + 60 > now && !input.forming) return { ...base, decision: "FORMING", explanation: "This candle is still forming; signals use completed candles only." };
  if (!previous || !sameSession(previous.time, candle.time) || previous.time >= candle.time) {
    return { ...base, decision: "NO_PREVIOUS", explanation: "No earlier completed candle in this session to compare with." };
  }
  let evaluated = 0;
  for (const line of lines) {
    // Disabled lines, and lines not yet known when the previous candle formed, are not compared.
    if (!enabled(line) || previous.time < line.activeFrom) continue;
    evaluated += 1;
    const result = input.fraction != null ? bodyShareCross(candle, line.price, input.fraction) : bodyCross(previous, candle, line.price);
    if (result.kind === "CROSS" && result.direction) base.events.push({ lineId: line.id, lineType: line.type, label: line.label, price: line.price, direction: result.direction });
    else if (result.kind !== "NONE" && result.kind !== "CROSS") base.notes.push({ lineId: line.id, label: line.label, price: line.price, kind: result.kind, detail: result.detail });
  }
  const result = consolidate(base.events, base.notes);
  return { ...base, evaluated, ...result, explanation: result.decision === "NO_SIGNAL" && !base.notes.length ? `No qualifying line crossing (${evaluated} line${evaluated === 1 ? "" : "s"} checked).` : result.explanation };
}

/**
 * One decision from all of a candle's crossings: every crossing is kept, but a candle makes at most one
 * entry decision. Several lines crossed the same way are one signal. Crossings both ways are
 * CONFLICTING_SIGNAL and the policy is no entry (there is no ranking of line types). With the fixed
 * levels of one session a single candle body cannot cross one line down and another up, so a conflict can
 * only come from levels that change; the rule is still applied whenever it happens.
 */
export function consolidate(events: CrossEvent[], notes: LineNote[] = []): { decision: Decision; explanation: string } {
  const down = events.filter((event) => event.direction === "DOWN");
  const up = events.filter((event) => event.direction === "UP");
  const names = (items: CrossEvent[]) => items.map((event) => event.label).join(", ");
  if (down.length && up.length) {
    return { decision: "CONFLICTING_SIGNAL", explanation: `Conflicting signals: crossed down through ${names(down)} and up through ${names(up)} on the same candle. Conflict policy: no entry.` };
  }
  if (down.length) return { decision: "PUT", explanation: `Bearish body crossing confirmed below ${names(down)}. ATM PUT.` };
  if (up.length) return { decision: "CALL", explanation: `Bullish body crossing confirmed above ${names(up)}. ATM CALL.` };
  return { decision: "NO_SIGNAL", explanation: notes.length ? `No new crossing (${notes.map((note) => `${note.label}: ${note.kind.toLowerCase()}`).join("; ")}).` : "No new crossing." };
}
