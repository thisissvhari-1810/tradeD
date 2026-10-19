import type { Candle } from "@/lib/market/demo";

/**
 * Historical option execution policy for replay practice.
 *
 * A one-minute candle stamped `t` covers [t, t + 60). It is usable at replay time `cursor`
 * only once it has completed, i.e. `t + 60 <= cursor`. The fill and mark price is the close
 * of the latest completed candle. Nothing at or after the cursor is read, so no future
 * premium can leak into a fill, a mark, or the ticket.
 *
 * A fill is refused when the latest completed candle ended more than FILL_STALE_SECONDS
 * before the cursor (the contract did not trade recently enough to price an order).
 * Marks use the same candle and are flagged stale past MARK_STALE_SECONDS instead of refused.
 */
export const REPLAY_POLICY = "last-completed-1m-close";
export const REPLAY_POLICY_LABEL = "Close of the last completed 1-minute candle at or before the replay time";
export const FILL_STALE_SECONDS = 10 * 60;
export const MARK_STALE_SECONDS = 5 * 60;
export const SESSION_MINUTES = 375;

export type ReplayPremium =
  | { status: "ok"; price: number; candleTime: number; candleEnd: number; ageSeconds: number; stale: boolean }
  | { status: "too-stale"; price: number; candleTime: number; candleEnd: number; ageSeconds: number; stale: true }
  | { status: "none" };

export function replayPremiumAt(tape: Candle[], cursor: number, fillStaleSeconds = FILL_STALE_SECONDS): ReplayPremium {
  let latest: Candle | null = null;
  for (const candle of tape) {
    if (candle.time + 60 > cursor) break;
    if (Number.isFinite(candle.close) && candle.close > 0) latest = candle;
  }
  if (!latest) return { status: "none" };
  const candleEnd = latest.time + 60;
  const ageSeconds = cursor - candleEnd;
  if (ageSeconds > fillStaleSeconds) return { status: "too-stale", price: latest.close, candleTime: latest.time, candleEnd, ageSeconds, stale: true };
  return { status: "ok", price: latest.close, candleTime: latest.time, candleEnd, ageSeconds, stale: ageSeconds > MARK_STALE_SECONDS };
}

/** Session bounds in epoch seconds for an NSE cash/F&O day: 09:15 to 15:30 IST. */
export function sessionBounds(date: string): { open: number; close: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const open = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 3, 45) / 1000;
  if (!Number.isFinite(open)) return null;
  return { open, close: open + SESSION_MINUTES * 60 };
}

export type Coverage = { status: "complete" | "partial" | "unavailable"; minutes: number; expected: number; first: number | null; last: number | null };

/** How much of the session the provider returned for a contract. Full sessions miss a few illiquid minutes, so 95% counts as complete. */
export function sessionCoverage(tape: Candle[], date: string): Coverage {
  const bounds = sessionBounds(date);
  const inSession = bounds ? tape.filter((candle) => candle.time >= bounds.open && candle.time < bounds.close) : [];
  if (!inSession.length) return { status: "unavailable", minutes: 0, expected: SESSION_MINUTES, first: null, last: null };
  const minutes = new Set(inSession.map((candle) => Math.floor(candle.time / 60))).size;
  return {
    status: minutes >= SESSION_MINUTES * 0.95 ? "complete" : "partial",
    minutes,
    expected: SESSION_MINUTES,
    first: inSession[0].time,
    last: inSession[inSession.length - 1].time,
  };
}

/** Keeps only one-minute candles inside the selected session, sorted and de-duplicated. */
export function sessionMinutes(tape: Candle[], date: string): Candle[] {
  const bounds = sessionBounds(date);
  if (!bounds) return [];
  const byMinute = new Map<number, Candle>();
  for (const candle of tape) {
    if (candle.time < bounds.open || candle.time >= bounds.close) continue;
    byMinute.set(Math.floor(candle.time / 60) * 60, { ...candle, time: Math.floor(candle.time / 60) * 60 });
  }
  return [...byMinute.values()].sort((a, b) => a.time - b.time);
}

/** Session ids look like `2026-10-16.k3x9q2`. The date is the replay day; the suffix separates restarts. */
export const REPLAY_SESSION_PATTERN = /^(\d{4}-\d{2}-\d{2})\.([a-z0-9]{6,16})$/;

export function replaySessionDate(session: string): string | null {
  return REPLAY_SESSION_PATTERN.exec(session)?.[1] ?? null;
}

export function newReplaySession(date: string, random: () => number = Math.random): string {
  let suffix = "";
  while (suffix.length < 8) suffix += Math.floor(random() * 36).toString(36);
  return `${date}.${suffix}`;
}

/** Ledger symbol for a replay position. Kept apart from the live contract so live snapshots never mark it. */
export function replayLedgerSymbol(contractSymbol: string, session: string) {
  return `${contractSymbol}|R:${session}`;
}

export function replaySessionOf(symbol: string): string | null {
  const tag = symbol.split("|")[4];
  if (!tag?.startsWith("R:")) return null;
  const session = tag.slice(2);
  return REPLAY_SESSION_PATTERN.test(session) ? session : null;
}
