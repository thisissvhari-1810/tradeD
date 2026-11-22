/**
 * Automatic renewal of the market-data (charts) Dhan access token: WHEN to renew and HOW to read Dhan's answer.
 * Pure functions, unit-tested (tests/dhan-token-renewal.test.ts). Same schedule as Neural Core's copy engine
 * (neural-core/backend/neural_backend/tokens.py).
 *
 * Dhan tokens last 24 hours and can be renewed (GET /v2/RenewToken, another 24 hours) only while still active;
 * the renewal expires the old token at once. So renewals happen after the market closes and never touch a token
 * the charts are using during the session.
 *
 * A token renewed at 15:40 would expire at 15:40 the next day, exactly when the next renewal is due, and any safety
 * margin would then pull each day's renewal a little earlier until it lands in market hours. So the target is a
 * token that lasts until 16:00 the next day: renewed at 15:40, then once more at about 16:00 (20 minutes later).
 * The next day's 15:40 renewal then has 20 minutes to spare and the cycle repeats at the same clock times.
 *
 * - Evening (15:40-24:00 IST): renew if the token would expire before 16:00 after the next close.
 * - Morning (07:30-09:00 IST): second chance if the evening renewal did not happen (scheduler was off).
 * - Last resort, less than 15 minutes left: always outside market hours; inside them only if the token would
 *   otherwise expire before the close.
 * - Never twice within 20 minutes of the token being made.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const IST_OFFSET = 330 * MINUTE;
const CLOSE = 15 * 60 + 30; // minutes after midnight, IST
const MARKET_START = 9 * 60; // no routine renewals from 09:00 ...
const MARKET_END = 15 * 60 + 35; // ... to 15:35
const EVENING = 15 * 60 + 40;
const PRE_START = 7 * 60 + 30;
const PRE_END = 9 * 60;
const COVER = 30 * MINUTE; // the token must last until the next close + 30 min (16:00)
const LAST_RESORT = 15 * MINUTE;
export const TOKEN_LIFETIME = 24 * HOUR; // Dhan tokens (fresh or renewed) last 24 hours
const MIN_AGE = 20 * MINUTE;

function ist(ms: number) {
  const d = new Date(ms + IST_OFFSET);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_OFFSET;
  return { dayStart, minutes: (ms - dayStart) / MINUTE };
}

/** The next 15:30 IST at or after `nowMs` (weekends included: the token is renewed every day). */
export function nextClose(nowMs: number) {
  const { dayStart } = ist(nowMs);
  const close = dayStart + CLOSE * MINUTE;
  return nowMs < close ? close : close + 24 * HOUR;
}

/** Why the token should be renewed now, or null. Unknown or expired tokens cannot be renewed. */
export function renewDue(expiresAtMs: number | null, nowMs: number): string | null {
  if (expiresAtMs == null || expiresAtMs <= nowMs) return null;
  if (nowMs - (expiresAtMs - TOKEN_LIFETIME) < MIN_AGE) return null; // renewed (or generated) a moment ago
  const { dayStart, minutes } = ist(nowMs);
  const inMarket = minutes >= MARKET_START && minutes < MARKET_END;
  if (expiresAtMs - nowMs < LAST_RESORT) {
    const marketEnd = dayStart + MARKET_END * MINUTE;
    if (!inMarket || expiresAtMs < marketEnd) return "expires in less than 15 minutes";
  }
  const coversNextSession = expiresAtMs >= nextClose(nowMs) + COVER;
  if (minutes >= EVENING && !coversNextSession) return "after-market renewal for the next session";
  if (minutes >= PRE_START && minutes < PRE_END && !coversNextSession) return "pre-market renewal (evening renewal did not happen)";
  return null;
}

/**
 * The new access token in Dhan's renewal answer (the field name is not documented): a JWT under a key containing
 * "token", else the only JWT-looking string.
 */
export function renewedToken(payload: unknown): string | null {
  const found: Array<[string, string]> = [];
  const walk = (value: unknown, key: string) => {
    if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === "object") Object.entries(value as Record<string, unknown>).forEach(([k, v]) => walk(v, k));
    else if (typeof value === "string" && value.split(".").length === 3 && value.length > 40 && !value.includes(" ")) found.push([key.toLowerCase(), value.trim()]);
  };
  walk(payload, "");
  const keyed = found.find(([key]) => key.includes("token"));
  if (keyed) return keyed[1];
  return found.length === 1 ? found[0][1] : null;
}
