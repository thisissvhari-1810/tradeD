import { liveGate, type GateState, type LiveGate } from "@/lib/multi-account/compliance";
import { accountOwnerEmail, liveSwitchOn, staticIpReady } from "@/lib/security/flags";
import type { SessionUser } from "@/server/auth";
import { dhanTokenStatus, getDhanClientId } from "@/server/settings";

/**
 * Who may see and trade the server-configured Dhan account. With DHAN_ACCOUNT_OWNER_EMAIL set, only that
 * TradeD user; without it, the super admin may read it (as before) but nobody may trade it.
 */
export function ownsServerAccount(user: Pick<SessionUser, "email" | "role">, env: NodeJS.ProcessEnv = process.env) {
  const owner = accountOwnerEmail(env);
  if (owner) return user.email.trim().toLowerCase() === owner;
  return user.role === "SUPER_ADMIN";
}

export function tradesServerAccount(user: Pick<SessionUser, "email" | "status" | "tradingEnabled">, env: NodeJS.ProcessEnv = process.env) {
  const owner = accountOwnerEmail(env);
  return Boolean(owner && user.email.trim().toLowerCase() === owner && user.status === "ACTIVE" && user.tradingEnabled);
}

export async function gateStateFor(user: SessionUser, env: NodeJS.ProcessEnv = process.env): Promise<GateState> {
  const [token, clientId] = await Promise.all([dhanTokenStatus(), getDhanClientId()]);
  return {
    staticIp: staticIpReady(env),
    ownAccount: tradesServerAccount(user, env),
    authorized: token.source !== "missing" && !token.expired && Boolean(clientId),
    switchedOn: liveSwitchOn(env),
  };
}

export async function gateFor(user: SessionUser, env: NodeJS.ProcessEnv = process.env): Promise<LiveGate> {
  return liveGate(await gateStateFor(user, env));
}
