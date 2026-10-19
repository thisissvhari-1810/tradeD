/**
 * Live execution gate. Each requirement is computed on the server from real configuration; the browser
 * only receives the result. Live orders stay locked until every requirement is met.
 */

export type LiveRequirement = { id: string; label: string; detail: string; met: boolean; source: string };

export const COMPLIANCE_CHECKED_ON = "2026-10-19";

/** What the server has verified. Every field defaults to false, which keeps the gate locked. */
export type GateState = {
  /** EXECUTION_SERVICE_URL and secret are set and DHAN_STATIC_IP names the IP registered with Dhan. */
  staticIp: boolean;
  /** The account being traded belongs to the viewer (DHAN_ACCOUNT_OWNER_EMAIL), i.e. the holder trades their own account. */
  ownAccount: boolean;
  /** A broker token is configured and not expired. */
  authorized: boolean;
  /** LIVE_ORDERS_ENABLED is on. */
  switchedOn: boolean;
};

export const LOCKED: GateState = { staticIp: false, ownAccount: false, authorized: false, switchedOn: false };

export function liveRequirements(state: GateState = LOCKED): LiveRequirement[] {
  return [
    {
      id: "static-ip",
      label: "Orders leave from a static IP registered with Dhan",
      detail: "Orders are sent by TradeD's execution server, whose fixed IP is registered as this account's primary IP in Dhan. Vercel itself has no fixed outbound IP and never sends orders.",
      met: state.staticIp,
      source: "SEBI circular on safer participation of retail investors in algorithmic trading (4 Feb 2025); NSE retail algo implementation standards; Dhan static IP requirement",
    },
    {
      id: "family-only",
      label: "Only your own account can trade",
      detail: "A retail client's own API orders are limited to self and family. TradeD trades only the account of the TradeD user named as its holder; it never trades friends' accounts.",
      met: state.ownAccount,
      source: "SEBI retail algo framework; NSE implementation standards for retail algorithmic trading",
    },
    {
      id: "own-authorization",
      label: "The holder's own access token is valid",
      detail: "The holder generates their own Dhan access token (valid 24 hours). TradeD never asks for a password or OTP.",
      met: state.authorized,
      source: "Dhan API authentication; SEBI requirement for 2FA on API access",
    },
    {
      id: "switch",
      label: "Live orders switched on by the operator",
      detail: "LIVE_ORDERS_ENABLED is set on the server, and the execution server has orders enabled.",
      met: state.switchedOn,
      source: "TradeD configuration",
    },
  ];
}

export type LiveGate = { enabled: boolean; checkedOn: string; requirements: LiveRequirement[]; message: string };

export function liveGate(state: GateState = LOCKED): LiveGate {
  const requirements = liveRequirements(state);
  const enabled = requirements.every((item) => item.met);
  return {
    enabled,
    checkedOn: COMPLIANCE_CHECKED_ON,
    requirements,
    message: enabled
      ? "Live orders are enabled for your own account. Every order is reviewed and confirmed before it is sent, and each result comes from Dhan."
      : "Live trading is locked until every requirement below is met. Demo mode is fully available.",
  };
}
