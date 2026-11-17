/**
 * The exclusive execution lock between the algo features. All can be configured, but only the lock's
 * owner may place new orders. The lock lives with the user's algo session on the server and changes only
 * by compare-and-set (an atomic conditional update), so two start requests — rapid clicks, two tabs, a
 * remount — can never both acquire it. It is released only when its owner has nothing left to manage (no
 * running session, no open position, no pending order); an open position keeps it held while it stays
 * protected. A lock whose owner is no longer active at all (a crash, an archived run) can be taken over.
 */

export type AlgoStrategy = "EXISTING_ALGO" | "MATHI_HOURLY" | "MATHI_CHANNEL";
export type LockOwner = "NONE" | AlgoStrategy;
export const ALGO_STRATEGIES: AlgoStrategy[] = ["EXISTING_ALGO", "MATHI_HOURLY", "MATHI_CHANNEL"];

/** Strategies with their own settings, live paper session, state and trade history: Mathi Hourly Zone Strategy and
 * Mathi Trend Channel, each on its own engine with the same execution as Mathi Strategy. */
export type VariantStrategy = "MATHI_HOURLY" | "MATHI_CHANNEL";
export const VARIANT_STRATEGIES: VariantStrategy[] = ["MATHI_HOURLY", "MATHI_CHANNEL"];
export const isVariantStrategy = (value: unknown): value is VariantStrategy => value === "MATHI_HOURLY" || value === "MATHI_CHANNEL";

export const STRATEGY_NAME: Record<AlgoStrategy, string> = {
  EXISTING_ALGO: "Mathi Strategy",
  MATHI_HOURLY: "Mathi Hourly Zone Strategy — 5%",
  MATHI_CHANNEL: "Mathi Trend Channel",
};
/** The short line after the name in the strategy selector. */
export const STRATEGY_TAGLINE: Record<AlgoStrategy, string> = {
  EXISTING_ALGO: "Existing Strategy",
  MATHI_HOURLY: "First two 1-hour candles, +5%",
  MATHI_CHANNEL: "3-minute parallel channel breakout",
};
export const STRATEGY_DESCRIPTION: Record<AlgoStrategy, string> = {
  EXISTING_ALGO: "Strategy-line breakouts: ATM CE / PE once 50% of a candle's body crosses an enabled line and the break holds on the next candle; +3% premium target, no stop-loss, 3 trades a session.",
  MATHI_HOURLY: "NIFTY 50 ATM options from the first two 1-hour candles: a red 09:15 candle sets a LONG reference (ATM CALL), a green one a SHORT reference (ATM PUT) at its close; the 10:15 candle must close in the zone. Entry from 11:15, +5% premium target, no stop-loss order, exit when a completed hour closes on the wrong side of its midpoint.",
  MATHI_CHANNEL: "NIFTY 50 ATM options on 3-minute candles: the first deep-swing combination after the 09:15 candle (2 highs + 1 low, or 2 lows + 1 high) sets a primary trendline and its exact parallel clone. A close beyond the channel and the horizontal swing level, then a next candle beyond the breakout candle's high / low, buys the ATM CALL / PUT; +5% premium target, no stop-loss, 1 trade a session.",
};

export function isAlgoStrategy(value: unknown): value is AlgoStrategy {
  return value === "EXISTING_ALGO" || value === "MATHI_HOURLY" || value === "MATHI_CHANNEL";
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
    if (now === "NONE" || now === strategy) return { ok: false, owner: ALGO_STRATEGIES.find((item) => item !== strategy)!, reason: "The algo lock changed while starting. Try again." };
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
