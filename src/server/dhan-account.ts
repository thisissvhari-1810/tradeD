import { AppError } from "@/lib/http";
import { dhanTokenStatus, getDhanAccessToken } from "@/server/settings";

async function dhanGet(path: string) {
  const clientId = process.env.DHAN_CLIENT_ID?.trim();
  if (!clientId) throw new AppError("DHAN_CLIENT_ID is not configured, so account data cannot be read.", 503);
  const response = await fetch(`https://api.dhan.co/v2${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "access-token": await getDhanAccessToken(),
      "client-id": clientId,
    },
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as { errorMessage?: string; remarks?: string } | null;
  if (!response.ok) throw new AppError(payload?.errorMessage || payload?.remarks || `Dhan returned ${response.status}.`, 502);
  return payload;
}

export async function brokerAccountView() {
  const token = await dhanTokenStatus();
  const clientConfigured = Boolean(process.env.DHAN_CLIENT_ID?.trim());
  const safeToken = {
    source: token.source,
    expiresAt: token.expiresAt,
    expired: token.expired,
    updatedAt: token.updatedAt,
  };
  if (token.source === "missing" || token.expired || !clientConfigured) {
    return {
      liveTrading: false,
      liveOrders: "unavailable" as const,
      reason:
        token.source === "missing"
          ? "No market-account token is saved. Live reads stay off until one is configured on the server."
          : token.expired
            ? "The market-account token has expired. Replace it on the server."
            : "The account client id is not set, so live account reads are disabled.",
      token: safeToken,
      clientConfigured,
      funds: null,
      positions: null,
      holdings: null,
      orders: null,
    };
  }
  const read = async (path: string) => {
    try {
      return await dhanGet(path);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Account request failed." };
    }
  };
  const [funds, positions, holdings, orders] = await Promise.all([
    read("/fundlimit"),
    read("/positions"),
    read("/holdings"),
    read("/orders"),
  ]);
  return {
    liveTrading: false,
    liveOrders: "unavailable" as const,
    reason: "Read-only connected account. TradeD does not submit broker orders. Practice orders stay on the virtual ledger.",
    token: safeToken,
    clientConfigured,
    funds,
    positions,
    holdings,
    orders,
  };
}
