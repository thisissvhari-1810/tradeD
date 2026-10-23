import { AppError } from "@/lib/http";
import { canUse, premiumRequiredMessage, type PremiumCapability } from "@/lib/premium/entitlements";
import type { SessionUser } from "@/server/auth";

/** Every Premium API checks here; hiding a button is never the only gate. */
export function requirePremium(user: SessionUser, capability: PremiumCapability) {
  if (!canUse(user.premium, capability)) throw new AppError(premiumRequiredMessage(capability), 403, "PREMIUM_REQUIRED", { details: { capability } });
}
