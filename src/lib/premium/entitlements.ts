import type { PremiumPlanId } from "@/lib/premium/plans";

/**
 * What Premium unlocks. Features ask for a capability (requirePremium / usePremium), never for an
 * ad-hoc "isPremium" flag, so the list of Premium features lives here only.
 */
export const PREMIUM_CAPABILITIES = {
  analytics: { label: "Analytics & Prediction", detail: "The Prediction screen: forecasts and analytics for any stock or index." },
  strategy: { label: "Strategy overlay", detail: "Automatic previous-day and 9:15 opening-range boxes and lines on the chart." },
} as const;

export type PremiumCapability = keyof typeof PREMIUM_CAPABILITIES;

export type Premium = {
  /** free: never subscribed · active: access now · expired: had access, it ended. */
  status: "free" | "active" | "expired";
  plan: PremiumPlanId | null;
  /** ISO end of the current (or last) access window. */
  endsAt: string | null;
  /** Why access is granted: a subscription row, or the Super Admin role (always included). */
  via: "subscription" | "role" | null;
};

export const FREE: Premium = { status: "free", plan: null, endsAt: null, via: null };

type Row = { plan: PremiumPlanId; status: "ACTIVE" | "CANCELLED"; startsAt: Date; endsAt: Date };

/** Premium from the user's role and subscription rows (the authoritative record), at `now`. */
export function premiumFrom(role: string, rows: Row[], now: Date = new Date()): Premium {
  const live = rows.filter((row) => row.status === "ACTIVE");
  const current = live
    .filter((row) => row.startsAt.getTime() <= now.getTime() && row.endsAt.getTime() > now.getTime())
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];
  if (current) return { status: "active", plan: current.plan, endsAt: current.endsAt.toISOString(), via: "subscription" };
  if (role === "SUPER_ADMIN") return { status: "active", plan: null, endsAt: null, via: "role" };
  const last = live.filter((row) => row.endsAt.getTime() <= now.getTime()).sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];
  return last ? { status: "expired", plan: last.plan, endsAt: last.endsAt.toISOString(), via: null } : FREE;
}

/** Every capability is included in Premium today; the capability names what is being asked for. */
export function canUse(premium: Premium | null | undefined, capability: PremiumCapability): boolean {
  return capability in PREMIUM_CAPABILITIES && premium?.status === "active";
}

/** Server-side gate: throws 403 with an upgrade message when the user lacks Premium. */
export function premiumRequiredMessage(capability: PremiumCapability) {
  return `${PREMIUM_CAPABILITIES[capability].label} is part of TradeD Premium.`;
}
