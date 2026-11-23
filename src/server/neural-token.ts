import { createHash, createHmac, randomBytes } from "crypto";
import { tokenExpiry } from "@/lib/dhan/client";

/**
 * The market-data Dhan token, taken from Neural Core instead of being pasted into TradeD.
 *
 * Neural Core's copy engine already renews the account's token every evening, and Dhan allows only ONE system to
 * renew a token (a renewal expires the old one). So when NEURAL_TOKEN_URL + NEURAL_TOKEN_SECRET are set, TradeD
 * reads the current token from Neural Core's read-only endpoint (/integrations/traded/market-token) and never
 * renews it itself. The request is signed the way Neural Core signs its own backend calls:
 *   hex(HMAC-SHA256(secret, `${ts}\n${nonce}\nGET\n${pathAndQuery}\n${sha256hex("")}`)) in X-NC-* headers.
 * The answer is cached for a few minutes (and never past the token's expiry). Tokens are never logged.
 */

export type NeuralToken = { clientId: string; accessToken: string; expiresAt: string | null; account: string | null; fetchedAt: number };

const CACHE_MS = 5 * 60_000;
let cache: NeuralToken | null = null;
let lastError = "";
/** After a failed fetch, wait this long before asking Neural Core again (charts must never wait on it each request). */
const RETRY_MS = 60_000;
let failedAt = 0;

export function neuralTokenConfigured() {
  const url = process.env.NEURAL_TOKEN_URL?.trim() ?? "";
  const secret = process.env.NEURAL_TOKEN_SECRET ?? "";
  return /^https:\/\/[^\s]+$/.test(url) && secret.length >= 32;
}

export function neuralTokenError() {
  return lastError;
}

export function signNeuralRequest(secret: string, timestamp: string, nonce: string, target: string) {
  const digest = createHash("sha256").update("").digest("hex");
  return createHmac("sha256", secret).update(`${timestamp}\n${nonce}\nGET\n${target}\n${digest}`).digest("hex");
}

/** The current token from Neural Core (cached), or null when not configured or not available (lastError says why). */
export async function neuralToken(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<NeuralToken | null> {
  if (!neuralTokenConfigured()) return null;
  const expiresMs = cache?.expiresAt ? Date.parse(cache.expiresAt) : null;
  if (cache && now - cache.fetchedAt < CACHE_MS && (expiresMs == null || expiresMs - now > 60_000)) return cache;
  if (now - failedAt < RETRY_MS) return cache && expiresMs != null && expiresMs > now ? cache : null;
  const url = new URL(process.env.NEURAL_TOKEN_URL!.trim());
  const target = url.pathname + url.search;
  const timestamp = String(now);
  const nonce = randomBytes(18).toString("base64url");
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-NC-Timestamp": timestamp,
        "X-NC-Nonce": nonce,
        "X-NC-Signature": signNeuralRequest(process.env.NEURAL_TOKEN_SECRET!, timestamp, nonce, target),
      },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      lastError = `Neural Core: ${typeof payload.message === "string" ? payload.message.slice(0, 200) : `HTTP ${response.status}`}`;
      failedAt = now;
      return cache && expiresMs != null && expiresMs > now ? cache : null;
    }
    const clientId = typeof payload.clientId === "string" ? payload.clientId : "";
    const accessToken = typeof payload.accessToken === "string" ? payload.accessToken : "";
    if (!/^\d{4,20}$/.test(clientId) || accessToken.split(".").length !== 3) {
      lastError = "Neural Core's answer had no usable token.";
      failedAt = now;
      return null;
    }
    const expiry = tokenExpiry(accessToken);
    cache = {
      clientId,
      accessToken,
      expiresAt: expiry ? expiry.toISOString() : typeof payload.expiresAt === "string" ? payload.expiresAt : null,
      account: typeof payload.account === "string" ? payload.account : null,
      fetchedAt: now,
    };
    lastError = "";
    failedAt = 0;
    return cache;
  } catch {
    lastError = "Neural Core did not answer.";
    failedAt = now;
    return cache && expiresMs != null && expiresMs > now ? cache : null;
  }
}

/** Test helper: forget the cached token. */
export function resetNeuralTokenCache() {
  cache = null;
  lastError = "";
  failedAt = 0;
}
