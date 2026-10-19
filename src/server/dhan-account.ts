import { AppError } from "@/lib/http";
import { createDhanClient } from "@/lib/dhan/client";
import { dhanTokenStatus, getDhanAccessToken, getDhanClientId } from "@/server/settings";

async function dhanGet(path: string) {
  const clientId = await getDhanClientId();
  if (!clientId) throw new AppError("The account client id is not set, so account data cannot be read.", 503);
  return createDhanClient({ clientId, accessToken: await getDhanAccessToken() }).get(path);
}

export async function brokerAccountView() {
  const token = await dhanTokenStatus();
  const clientConfigured = Boolean(await getDhanClientId());
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
