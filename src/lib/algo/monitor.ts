import type { AlgoState } from "./runner";

/**
 * Server-side monitoring of paper sessions: one scheduled pass checks every active strategy of every session, whether or
 * not anyone has the page open. Each check runs under the session's lease and on the session read again under that
 * lease, so a check that ran in between (another scheduler call, or the browser) is never overwritten and the same
 * exit is never decided twice; a session whose lease is held is reported busy and checked on the next pass.
 */

export type MonitoredStrategy = "MATHI" | "MATHI_5" | "MATHI_BANK";
export type ScheduledCheck = { session: string; strategy: MonitoredStrategy; ok: boolean; open: boolean; problem: string | null };

/** A strategy needs checking while it runs, holds a position or waits on an order to reconcile. */
export const needsCheck = (state: AlgoState) => state.running || Boolean(state.position) || Boolean(state.pending);

export async function runScheduledChecks<S>(sessions: S[], deps: {
  id: (session: S) => string;
  strategies: readonly MonitoredStrategy[];
  stateOf: (session: S, strategy: MonitoredStrategy) => AlgoState;
  withLease: <T>(id: string, task: () => Promise<T>) => Promise<T>;
  reload: (id: string) => Promise<S>;
  check: (session: S, strategy: MonitoredStrategy, state: AlgoState) => Promise<AlgoState>;
}): Promise<{ ran: number; checks: ScheduledCheck[] }> {
  const checks: ScheduledCheck[] = [];
  for (const listed of sessions) {
    const id = deps.id(listed);
    for (const strategy of deps.strategies) {
      const before = deps.stateOf(listed, strategy);
      if (!needsCheck(before)) continue;
      try {
        const after = await deps.withLease(id, async () => {
          const current = await deps.reload(id);
          const state = deps.stateOf(current, strategy);
          return needsCheck(state) ? deps.check(current, strategy, state) : state;
        });
        checks.push({ session: id, strategy, ok: true, open: Boolean(after.position), problem: after.monitor?.problem ?? null });
      } catch (error) {
        checks.push({ session: id, strategy, ok: false, open: Boolean(before.position), problem: error instanceof Error ? error.message : "Check failed." });
      }
    }
  }
  return { ran: checks.filter((check) => check.ok).length, checks };
}
