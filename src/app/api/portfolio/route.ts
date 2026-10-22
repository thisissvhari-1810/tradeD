import { PRACTICE_ROLES } from "@/lib/auth/permissions";
import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getStudentBundle } from "@/server/portfolio";

export const GET = query(async () => {
  const user = await requireUser(PRACTICE_ROLES);
  return Response.json({ ...(await getStudentBundle(user.id)), simulated: true });
});
