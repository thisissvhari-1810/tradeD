import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { DHAN_API, classifyBrokerResponse, tokenExpiry } from "@/lib/dhan/client";
import { renewDue, renewedToken } from "@/lib/dhan/token-renewal";
import { redactString } from "@/lib/security/redact";
import { getDhanClientId } from "@/server/settings";
import { neuralTokenConfigured } from "@/server/neural-token";

/**
 * Automatic renewal of the market-data (charts) Dhan token, the same way Neural Core's copy engine renews its
 * accounts. Called by the scheduler through GET /api/market/token-renewal (CRON_SECRET); renewDue() decides whether
 * anything happens, so the scheduler can simply call it every few minutes, all day.
 *
 * Safety:
 * - The renewed token replaces the saved one only if the saved token is still the one this renewal started from;
 *   a token pasted on the Admin page meanwhile always wins.
 * - At most one attempt per 10 minutes. An answer without a newer token is recorded and that token is never sent
 *   to Dhan again (a new token pasted on the Admin page starts afresh).
 * - Tokens are never logged or returned; the status keeps only times, reasons and redacted messages.
 */

const TOKEN_KEY = "market.dhanAccessToken";
export const RENEWAL_STATE_KEY = "market.dhanTokenRenewal";
const RETRY_MS = 10 * 60_000;

export type RenewalState = {
  lastCheckAt?: string;
  lastAttemptAt?: string;
  lastResult?: "renewed" | "failed" | "superseded";
  lastReason?: string;
  lastMessage?: string;
  renewedAt?: string;
  renewedUntil?: string;
  stoppedFor?: string; // fingerprint of a token whose renewal answer had no newer token: never retried
};

export type RenewalOutcome =
  | { status: "renewed"; reason: string; expiresAt: string }
  | { status: "not-due" | "waiting" | "stopped" | "superseded"; expiresAt: string | null; message?: string }
  | { status: "skipped"; message: string }
  | { status: "failed"; reason: string; message: string };

function fingerprint(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

async function readState(): Promise<RenewalState> {
  const row = await prisma.appSetting.findUnique({ where: { key: RENEWAL_STATE_KEY } });
  return row?.value && typeof row.value === "object" && !Array.isArray(row.value) ? (row.value as RenewalState) : {};
}

async function writeState(state: RenewalState) {
  await prisma.appSetting.upsert({
    where: { key: RENEWAL_STATE_KEY },
    create: { key: RENEWAL_STATE_KEY, value: state },
    update: { value: state },
  });
}

export async function getRenewalState() {
  return readState();
}

/** The token the charts use now and where it lives (saved on the Admin page, or the server environment). */
async function currentToken(): Promise<{ token: string; source: "saved" | "server" } | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: TOKEN_KEY } });
  const saved = typeof row?.value === "string" ? row.value.trim() : "";
  if (saved.includes(".")) return { token: saved, source: "saved" };
  const env = process.env.DHAN_ACCESS_TOKEN?.trim() ?? "";
  return env.includes(".") ? { token: env, source: "server" } : null;
}

export async function renewMarketTokenIfDue(now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<RenewalOutcome> {
  // Neural Core owns this token and renews it; a renewal here would expire Neural Core's copy, so never renew.
  if (neuralTokenConfigured()) return { status: "skipped", message: "The token comes from Neural Core, which renews it; TradeD never renews it." };
  const state = await readState();
  const current = await currentToken();
  if (!current) return { status: "skipped", message: "No market-data token is set." };
  const clientId = await getDhanClientId();
  if (!/^\d{4,20}$/.test(clientId)) return { status: "skipped", message: "The market-data client id is not set." };

  const expiry = tokenExpiry(current.token);
  const expiresAt = expiry ? expiry.toISOString() : null;
  const reason = renewDue(expiry ? expiry.getTime() : null, now.getTime());
  await writeState({ ...state, lastCheckAt: now.toISOString() });
  if (!reason) return { status: "not-due", expiresAt };
  if (state.stoppedFor && state.stoppedFor === fingerprint(current.token)) {
    return { status: "stopped", expiresAt, message: state.lastMessage };
  }
  if (state.lastAttemptAt && now.getTime() - Date.parse(state.lastAttemptAt) < RETRY_MS) return { status: "waiting", expiresAt };

  const attempt: RenewalState = { ...state, lastCheckAt: now.toISOString(), lastAttemptAt: now.toISOString(), lastReason: reason };
  await writeState(attempt);

  let response: Response;
  try {
    response = await fetchImpl(`${DHAN_API}/RenewToken`, {
      method: "GET",
      headers: { Accept: "application/json", "access-token": current.token, dhanClientId: clientId, "client-id": clientId },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
  } catch {
    const message = "Dhan did not answer the token renewal. It is tried again in 10 minutes.";
    await writeState({ ...attempt, lastResult: "failed", lastMessage: message });
    return { status: "failed", reason, message };
  }
  const text = await response.text().catch(() => "");
  let payload: unknown;
  try {
    payload = JSON.parse(text || "{}");
  } catch {
    payload = { _raw: text.trim() };
  }
  if (!response.ok) {
    const message = classifyBrokerResponse(response.status, payload).message;
    await writeState({ ...attempt, lastResult: "failed", lastMessage: redactString(message) });
    return { status: "failed", reason, message };
  }

  const token = renewedToken(payload);
  const newExpiry = token ? tokenExpiry(token) : null;
  if (!token || !newExpiry || (expiry && newExpiry.getTime() <= expiry.getTime())) {
    const fields = payload && typeof payload === "object" ? Object.keys(payload as object).sort().join(", ") : typeof payload;
    const message = `Dhan's answer had no newer token (fields: ${fields}). Paste a new token on the Admin page.`;
    await writeState({ ...attempt, lastResult: "failed", lastMessage: message, stoppedFor: fingerprint(current.token) });
    return { status: "failed", reason, message };
  }

  // Replace only the token this renewal started from: a token pasted meanwhile on the Admin page wins.
  let replaced: boolean;
  if (current.source === "saved") {
    const result = await prisma.appSetting.updateMany({ where: { key: TOKEN_KEY, value: { equals: current.token } }, data: { value: token, updatedById: null } });
    replaced = result.count === 1;
  } else {
    // The server-environment token was just expired by Dhan, so the renewed one is saved here and takes over.
    const existing = await prisma.appSetting.findUnique({ where: { key: TOKEN_KEY } });
    replaced = !existing;
    if (replaced) await prisma.appSetting.create({ data: { key: TOKEN_KEY, value: token, updatedById: null } });
  }
  if (!replaced) {
    await writeState({ ...attempt, lastResult: "superseded", lastMessage: "A new token was saved on the Admin page during the renewal; it was kept." });
    return { status: "superseded", expiresAt };
  }
  const until = newExpiry.toISOString();
  await writeState({ ...attempt, lastResult: "renewed", lastMessage: "", renewedAt: now.toISOString(), renewedUntil: until, stoppedFor: undefined });
  await prisma.auditLog.create({
    data: { action: "market.token_renewed", targetType: "AppSetting", targetId: TOKEN_KEY, reason: `Dhan market-data token renewed automatically (${reason}); valid until ${until}.` },
  }).catch(() => undefined);
  return { status: "renewed", reason, expiresAt: until };
}
