import { liveGate } from "@/lib/multi-account/compliance";

/**
 * Server feature switches. LIVE_ORDERS_ENABLED alone never unlocks live orders: every compliance
 * requirement and the execution service must also be in place, and today the gate is locked by design.
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

export function executionServiceConfigured(env: NodeJS.ProcessEnv = process.env) {
  const url = env.EXECUTION_SERVICE_URL?.trim() ?? "";
  const secret = env.EXECUTION_SERVICE_SECRET?.trim() ?? "";
  return url.startsWith("https://") && secret.length >= 32;
}

export type LiveOrdersStatus = { enabled: boolean; reasons: string[] };

export function liveOrdersStatus(env: NodeJS.ProcessEnv = process.env): LiveOrdersStatus {
  const reasons: string[] = [];
  if (!flag(env.LIVE_ORDERS_ENABLED, false)) reasons.push("LIVE_ORDERS_ENABLED is off.");
  if (!executionServiceConfigured(env)) reasons.push("No static-IP execution service is configured.");
  const gate = liveGate();
  for (const item of gate.requirements) if (!item.met) reasons.push(item.label);
  return { enabled: reasons.length === 0 && gate.enabled, reasons };
}
