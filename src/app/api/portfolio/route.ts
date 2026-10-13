import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { getStudentBundle } from "@/server/portfolio";

export const GET = query(async () => {
  const user = await requireUser(["STUDENT"]);
  return Response.json({ ...(await getStudentBundle(user.id)), simulated: true });
});
