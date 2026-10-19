import { connection } from "next/server";
import { AppError, clientIp } from "@/lib/http";
import { logEvent } from "@/lib/audit/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { completeBrokerConsent } from "@/server/broker-accounts";

/** Dhan redirects the holder's browser here with ?tokenId=… after they sign in on Dhan's page. */
export async function handleConsentCallback(request: Request, accountHint: string | null) {
  await connection();
  const url = new URL(request.url);
  const back = new URL("/multi-account", url.origin);
  try {
    rateLimit(`consent-callback:${clientIp(request)}`, 20, 60_000);
    const tokenId = url.searchParams.get("tokenId") ?? url.searchParams.get("tokenid") ?? "";
    const hint = accountHint && /^c[a-z0-9]{20,32}$/.test(accountHint) ? accountHint : null;
    const result = await completeBrokerConsent(tokenId, hint, { ip: clientIp(request) });
    back.searchParams.set("connected", result.nickname);
    back.searchParams.set("state", result.connection);
  } catch (error) {
    logEvent("warn", "consent.callback_failed", { error });
    back.searchParams.set("connectError", error instanceof AppError ? error.message : "The connection could not be completed. Start it again from TradeD.");
  }
  return Response.redirect(back, 303);
}
