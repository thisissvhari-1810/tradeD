import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "@/server/auth";
import type { AppRole } from "@/lib/auth/permissions";
import { hasFeature, type FeatureKey } from "@/lib/auth/features";

export async function requirePageUser(roles?: AppRole[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (roles && !roles.includes(user.role)) redirect("/");
  return user;
}

/** Server-side page gate for a feature permission; users without it land on Home. */
export async function requirePageFeature(feature: FeatureKey): Promise<SessionUser> {
  const user = await requirePageUser();
  if (!hasFeature(user, feature)) redirect("/");
  return user;
}
