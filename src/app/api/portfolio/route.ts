import { requireFeature } from "@/lib/auth/features";
import { practiceModeOf } from "@/server/practice-account";
import { PRACTICE_ROLES } from "@/lib/auth/permissions";
import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getStudentBundle } from "@/server/portfolio";

export const GET = query(async (request) => {
  const user = await requireUser(PRACTICE_ROLES);
  requireFeature(user, "portfolio");
  return Response.json({ ...(await getStudentBundle(user.id, practiceModeOf(request))), simulated: true });
});
