/**
 * The exclusive execution lock between the two algo features. Both can be configured, but only the lock's
 * owner may place new orders. The lock lives with the user's algo session on the server and changes only
 * by compare-and-set (an atomic conditional update), so two start requests — rapid clicks, two tabs, a
 * remount — can never both acquire it. It is released only when its owner has nothing left to manage (no
 * running session, no open position, no pending order); an open position keeps it held while it stays
 * protected. A lock whose owner is no longer active at all (a crash, an archived run) can be taken over.
 */

export type AlgoStrategy = "EXISTING_ALGO" | "PRIMARY_STRATEGY";
export type LockOwner = "NONE" | AlgoStrategy;
export const ALGO_STRATEGIES: AlgoStrategy[] = ["EXISTING_ALGO", "PRIMARY_STRATEGY"];

export const STRATEGY_NAME: Record<AlgoStrategy, string> = {
  EXISTING_ALGO: "Mathi Strategy",
  PRIMARY_STRATEGY: "Algo - Primary Strategy",
};
export const STRATEGY_DESCRIPTION: Record<AlgoStrategy, string> = {
  EXISTING_ALGO: "Strategy-line breakouts: ATM CE / PE once 50% of a candle's body crosses an enabled line and the break holds on the next candle; +3% premium target, no stop-loss, 3 trades a session.",
  PRIMARY_STRATEGY: "NIFTY 50 options: opening-range breakout confirmed by session VWAP and the trend (9 / 21 EMA).",
};

export function isAlgoStrategy(value: unknown): value is AlgoStrategy {
  return value === "EXISTING_ALGO" || value === "PRIMARY_STRATEGY";
}

export function lockOwnerOf(value: unknown): LockOwner {
  return isAlgoStrategy(value) ? value : "NONE";
}

/** The atomic primitive: set the owner to `next` only if it is currently one of `expected`. */
export interface LockStore {
  compareAndSet(expected: LockOwner[], next: LockOwner): Promise<boolean>;
  read(): Promise<LockOwner>;
}

/** What the owner still has to manage (it keeps the lock while any of it is true). */
export type OwnerActivity = { running: boolean; position: boolean; pending: boolean };
export const isActive = (activity: OwnerActivity) => activity.running || activity.position || activity.pending;

function describe(activity: OwnerActivity) {
  if (activity.pending) return " with a pending order";
  if (activity.position) return " with an open position";
  return "";
}

/** The message shown when `strategy` cannot start because `owner` holds the lock. */
export function blockedMessage(owner: AlgoStrategy, strategy: AlgoStrategy, activity: OwnerActivity) {
  const what = activity.position || activity.pending ? ` Its ${activity.pending ? "pending order" : "open position"} must be closed (or reach its stop-loss / target) before the lock is released.` : "";
  return `${STRATEGY_NAME[owner]} is running${describe(activity)}. Stop it before starting ${STRATEGY_NAME[strategy]}.${what}`;
}

/**
 * Acquires the lock for `strategy`. Already held by it: fine (a resume). Held by the other feature: refused
 * while that feature is active; taken over when it is not (its session ended without releasing the lock).
 */
export async function acquireLock(store: LockStore, strategy: AlgoStrategy, activityOf: (owner: AlgoStrategy) => Promise<OwnerActivity>): Promise<{ ok: true } | { ok: false; owner: AlgoStrategy; reason: string }> {
  if (await store.compareAndSet(["NONE", strategy], strategy)) return { ok: true };
  const owner = await store.read();
  if (owner === "NONE" || owner === strategy) {
    // Released (or taken by this strategy) between the two reads: try once more.
    if (await store.compareAndSet(["NONE", strategy], strategy)) return { ok: true };
    const now = await store.read();
    if (now === "NONE" || now === strategy) return { ok: false, owner: strategy === "EXISTING_ALGO" ? "PRIMARY_STRATEGY" : "EXISTING_ALGO", reason: "The algo lock changed while starting. Try again." };
    return blocked(store, now, strategy, activityOf);
  }
  return blocked(store, owner, strategy, activityOf);
}

async function blocked(store: LockStore, owner: AlgoStrategy, strategy: AlgoStrategy, activityOf: (owner: AlgoStrategy) => Promise<OwnerActivity>): Promise<{ ok: true } | { ok: false; owner: AlgoStrategy; reason: string }> {
  const activity = await activityOf(owner);
  if (!isActive(activity) && (await store.compareAndSet([owner], strategy))) return { ok: true };
  return { ok: false, owner, reason: blockedMessage(owner, strategy, activity) };
}

/** Releases the lock held by `strategy` once it has nothing left to manage. Returns whether it was released. */
export async function releaseLock(store: LockStore, strategy: AlgoStrategy, activity: OwnerActivity): Promise<boolean> {
  if (isActive(activity)) return false;
  return store.compareAndSet([strategy], "NONE");
}

/** Only the lock's owner may enter; anyone may still protect (stop-loss, target, exit) its own open position. */
export const mayEnter = (owner: LockOwner, strategy: AlgoStrategy) => owner === strategy;
