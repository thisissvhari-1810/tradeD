/**
 * Server feature switches. LIVE_ORDERS_ENABLED alone never unlocks live orders: the execution service,
 * the registered static IP and the per-user account checks in server/live-gate must all pass as well.
 */

function flag(value: string | undefined, fallback: boolean) {
  const raw = value?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}

export function marketDataEnabled(env: NodeJS.ProcessEnv = process.env) {
  return flag(env.MARKET_DATA_ENABLED, true);
}

export function liveSwitchOn(env: NodeJS.ProcessEnv = process.env) {
  return flag(env.LIVE_ORDERS_ENABLED, false);
}

export function executionServiceConfigured(env: NodeJS.ProcessEnv = process.env) {
  const url = env.EXECUTION_SERVICE_URL?.trim() ?? "";
  const secret = env.EXECUTION_SERVICE_SECRET?.trim() ?? "";
  return url.startsWith("https://") && secret.length >= 32;
}

/** The IPv4 address registered with Dhan as the execution server's static IP, if declared. */
export function registeredStaticIp(env: NodeJS.ProcessEnv = process.env) {
  const ip = env.DHAN_STATIC_IP?.trim() ?? "";
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip) && ip.split(".").every((part) => Number(part) <= 255) ? ip : null;
}

export function staticIpReady(env: NodeJS.ProcessEnv = process.env) {
  return executionServiceConfigured(env) && registeredStaticIp(env) !== null;
}

/** Email of the TradeD user who holds the server-configured Dhan account. */
export function accountOwnerEmail(env: NodeJS.ProcessEnv = process.env) {
  return env.DHAN_ACCOUNT_OWNER_EMAIL?.trim().toLowerCase() || null;
}

export type LiveOrdersStatus = { enabled: boolean; reasons: string[] };

/** Deployment-wide prerequisites. Account-level checks are added by server/live-gate. */
export function liveOrdersStatus(env: NodeJS.ProcessEnv = process.env): LiveOrdersStatus {
  const reasons: string[] = [];
  if (!liveSwitchOn(env)) reasons.push("LIVE_ORDERS_ENABLED is off.");
  if (!executionServiceConfigured(env)) reasons.push("No static-IP execution service is configured.");
  if (!registeredStaticIp(env)) reasons.push("DHAN_STATIC_IP is not set to the IP registered with Dhan.");
  if (!accountOwnerEmail(env)) reasons.push("DHAN_ACCOUNT_OWNER_EMAIL does not name the account holder.");
  return { enabled: reasons.length === 0, reasons };
}
