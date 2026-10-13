import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "@/server/auth";
import type { AppRole } from "@/lib/auth/permissions";

export async function requirePageUser(roles?: AppRole[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (roles && !roles.includes(user.role)) redirect(user.role === "STUDENT" ? "/dashboard" : "/admin");
  return user;
}
