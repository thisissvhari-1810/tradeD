import type { AlgoEvent } from "./runner";

/**
 * The Algo inside the chart's replay: pure rules shared by the server (which executes) and the chart
 * (which asks for confirmation). The replay clock is the only clock: a minute is processed once its
 * candle has completed at the replay time, minutes are processed in order and never twice, and a replay
 * moved back before the last processed minute cannot reprocess (it needs a new, isolated session).
 */

export const MINUTE = 60;

/** Minute ends after `processedThrough` up to the replay cursor (and the session close), oldest first. */
export function minuteEnds(processedThrough: number, cursor: number, sessionOpen: number, sessionClose: number): number[] {
  const last = Math.min(Math.floor(cursor / MINUTE) * MINUTE, sessionClose);
  const first = Math.max(Math.floor(processedThrough / MINUTE) * MINUTE + MINUTE, sessionOpen + MINUTE);
  const ends: number[] = [];
  for (let end = first; end <= last; end += MINUTE) ends.push(end);
  return ends;
}

/**
 * A simulated fill must be a price the contract actually traded at in that minute: the requested price
 * (a stop or target level, or the close plus slippage) is kept inside the candle's low–high range and
 * rounded to the 0.05 tick.
 */
export function clampFill(price: number, candle: { low: number; high: number }) {
  const inside = Math.min(candle.high, Math.max(candle.low, price));
  return Math.round(Math.round(inside / 0.05) * 0.05 * 100) / 100;
}

export type PlayGate =
  /** The algo is off: ordinary chart replay, no confirmation. */
  | { kind: "free" }
  /** The algo is on: playback waits for an explicit "Start Algo & Replay". */
  | { kind: "confirm"; skippedMinutes: number }
  /** The replay sits before minutes the algo already processed: resume from there, reset, or cancel. */
  | { kind: "behind"; processedThrough: number };

/** What pressing Play needs, given the algo switch and the run's progress in this replay session. */
export function playGate(input: { algoEnabled: boolean; cursor: number; processedThrough: number | null }): PlayGate {
  if (!input.algoEnabled) return { kind: "free" };
  if (input.processedThrough != null && Math.floor(input.cursor / MINUTE) * MINUTE < input.processedThrough) return { kind: "behind", processedThrough: input.processedThrough };
  const skipped = input.processedThrough == null ? 0 : Math.max(0, Math.floor(input.cursor / MINUTE) - Math.floor(input.processedThrough / MINUTE) - 1);
  return { kind: "confirm", skippedMinutes: skipped };
}

export type RunStats = {
  signals: number;
  accepted: number;
  rejected: number;
  trades: number;
  wins: number;
  losses: number;
  realized: number;
  maxDrawdown: number;
  exits: Record<string, number>;
};

const EXIT_REASON = /^Exit \(([A-Z_]+)\)/;

/** Session figures from the run's own log (closed trades are counted once, by their exit events). */
export function runStats(events: AlgoEvent[]): RunStats {
  const stats: RunStats = { signals: 0, accepted: 0, rejected: 0, trades: 0, wins: 0, losses: 0, realized: 0, maxDrawdown: 0, exits: {} };
  let peak = 0;
  const byEntry = new Map<string, number>();
  const ordered = [...events].sort((a, b) => a.time - b.time);
  for (const event of ordered) {
    const decision = event.evaluation?.decision;
    if (decision === "CALL" || decision === "PUT") stats.signals += 1;
    if (event.kind === "ENTRY") stats.accepted += 1;
    if (event.kind === "REJECTED") stats.rejected += 1;
    if (event.kind === "EXIT" && event.pnl != null) {
      stats.realized = Math.round((stats.realized + event.pnl) * 100) / 100;
      peak = Math.max(peak, stats.realized);
      stats.maxDrawdown = Math.max(stats.maxDrawdown, Math.round((peak - stats.realized) * 100) / 100);
      const entry = event.order?.key.replace(/:exit:\d+$/, "") ?? event.key;
      byEntry.set(entry, (byEntry.get(entry) ?? 0) + event.pnl);
      const reason = EXIT_REASON.exec(event.message)?.[1] ?? "OTHER";
      stats.exits[reason] = (stats.exits[reason] ?? 0) + 1;
    }
  }
  for (const pnl of byEntry.values()) {
    stats.trades += 1;
    if (pnl > 0) stats.wins += 1;
    else if (pnl < 0) stats.losses += 1;
  }
  return stats;
}

/** Plain-language exit reasons. */
export const EXIT_LABEL: Record<string, string> = {
  STOP: "Stop-loss",
  TARGET: "Target",
  MANUAL: "Manual exit",
  EMERGENCY: "Emergency stop",
  SESSION_END: "Session end",
  OPPOSITE_SIGNAL: "Opposite signal",
  RISK: "Risk limit",
};
