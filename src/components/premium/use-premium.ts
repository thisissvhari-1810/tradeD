"use client";

import { useDesk } from "@/components/shell";
import { canUse, FREE, type PremiumCapability } from "@/lib/premium/entitlements";

/**
 * The signed-in user's Premium, as the server reported it (/api/session). For showing the right
 * screen only: every Premium API checks again on the server.
 */
export function usePremium(capability?: PremiumCapability) {
  const desk = useDesk();
  const premium = desk.user?.premium ?? FREE;
  return { premium, known: desk.user != null, allowed: capability ? canUse(premium, capability) : premium.status === "active" };
}
