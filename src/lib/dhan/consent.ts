import { AppError } from "@/lib/http";
import { redactString } from "@/lib/security/redact";
import { tokenExpiry } from "@/lib/dhan/client";

/**
 * DhanHQ v2 individual "API key & secret" consent flow (dhanhq.co/docs/v2/authentication):
 *   1. POST auth.dhan.co/app/generate-consent?client_id=…   headers app_id, app_secret → consentAppId
 *   2. The holder opens auth.dhan.co/login/consentApp-login?consentAppId=… and signs in with 2FA on Dhan.
 *   3. Dhan redirects to the API key's redirect URL with ?tokenId=….
 *   4. GET auth.dhan.co/app/consumeApp-consent?tokenId=…    headers app_id, app_secret → accessToken
 * TradeD never sees the holder's password or OTP.
 */

export const DHAN_AUTH = "https://auth.dhan.co";

export type AppCredentials = { appId: string; appSecret: string };

async function call(url: string, method: "GET" | "POST", app: AppCredentials, fetchImpl: typeof fetch) {
  let response: Response;
  try {
    response = await fetchImpl(url, { method, headers: { Accept: "application/json", app_id: app.appId, app_secret: app.appSecret }, signal: AbortSignal.timeout(12_000), cache: "no-store" });
  } catch {
    throw new AppError("Dhan's login service did not respond. Try again.", 504, "DHAN_AUTH_UNAVAILABLE");
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const text = [payload?.errorMessage, payload?.message, payload?.remarks].find((item): item is string => typeof item === "string" && item.length > 0);
    throw new AppError(`Dhan refused the request: ${redactString(text ?? `HTTP ${response.status}`).slice(0, 200)}. Check the API key, secret and client id.`, 502, "DHAN_AUTH_REFUSED");
  }
  return payload ?? {};
}

export async function generateConsent(app: AppCredentials, clientId: string, fetchImpl: typeof fetch = fetch) {
  const payload = await call(`${DHAN_AUTH}/app/generate-consent?client_id=${encodeURIComponent(clientId)}`, "POST", app, fetchImpl);
  const id = payload.consentAppId;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{8,80}$/.test(id)) throw new AppError("Dhan did not return a consent id.", 502, "DHAN_AUTH_REFUSED");
  return id;
}

export function consentLoginUrl(consentAppId: string) {
  return `${DHAN_AUTH}/login/consentApp-login?consentAppId=${encodeURIComponent(consentAppId)}`;
}

export async function consumeConsent(app: AppCredentials, tokenId: string, fetchImpl: typeof fetch = fetch) {
  const payload = await call(`${DHAN_AUTH}/app/consumeApp-consent?tokenId=${encodeURIComponent(tokenId)}`, "GET", app, fetchImpl);
  const accessToken = typeof payload.accessToken === "string" ? payload.accessToken : "";
  const clientId = payload.dhanClientId == null ? "" : String(payload.dhanClientId);
  if (!accessToken.includes(".") || !/^\d{4,20}$/.test(clientId)) throw new AppError("Dhan did not return a usable access token.", 502, "DHAN_AUTH_REFUSED");
  const fromJwt = tokenExpiry(accessToken);
  const fromField = typeof payload.expiryTime === "string" && !Number.isNaN(Date.parse(payload.expiryTime)) ? new Date(payload.expiryTime) : null;
  const clientName = typeof payload.dhanClientName === "string" ? payload.dhanClientName.trim().slice(0, 80) : "";
  return { accessToken, clientId, clientName, expiresAt: fromJwt ?? fromField ?? new Date(Date.now() + 23 * 60 * 60 * 1000) };
}
