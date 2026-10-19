/**
 * Live multi-account execution gate. TradeD has no code that submits broker orders, so this gate
 * only explains why live mode stays locked. Every requirement must be met before any live adapter exists.
 */

export type LiveRequirement = { id: string; label: string; detail: string; met: boolean; source: string };

export const COMPLIANCE_CHECKED_ON = "2026-10-18";

export function liveRequirements(): LiveRequirement[] {
  return [
    {
      id: "static-ip",
      label: "Static IP registered per account holder",
      detail: "Orders placed through broker APIs must come from a static IP whitelisted for that client. One IP can be shared only within a family (self, spouse, dependent children, dependent parents). TradeD runs on Vercel, which has no fixed outbound IP.",
      met: false,
      source: "SEBI circular on safer participation of retail investors in algorithmic trading (4 Feb 2025); NSE retail algo implementation standards; broker static IP requirement",
    },
    {
      id: "family-only",
      label: "Accounts belong to you or your family",
      detail: "A retail client's own or registered algo may be used for the client and family only. Placing orders for friends' accounts makes the operator an algo provider, which needs broker empanelment and exchange registration.",
      met: false,
      source: "SEBI retail algo framework; NSE implementation standards for retail algorithmic trading",
    },
    {
      id: "own-authorization",
      label: "Each holder authorizes their own account",
      detail: "Every holder must sign in to their broker, complete 2FA and create their own API access. Access tokens expire within 24 hours. TradeD will never ask for another person's password, OTP or token.",
      met: false,
      source: "Broker API terms; SEBI requirement for OAuth and 2FA on API access",
    },
    {
      id: "broker-adapter",
      label: "Reviewed order adapter with per-account server-side credentials",
      detail: "TradeD reads broker market data only. No order adapter, credential vault or per-client consent flow exists in this application.",
      met: false,
      source: "TradeD architecture",
    },
  ];
}

export type LiveGate = { enabled: false; checkedOn: string; requirements: LiveRequirement[]; message: string };

export function liveGate(): LiveGate {
  return {
    enabled: false,
    checkedOn: COMPLIANCE_CHECKED_ON,
    requirements: liveRequirements(),
    message: "Live multi-account trading is locked. Current SEBI and exchange rules do not permit one person to place API orders across friends' accounts from a shared server. Demo mode is fully available.",
  };
}
