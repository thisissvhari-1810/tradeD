import { requireUser } from "@/server/auth";
import { query } from "@/server/http";
import { academyOverview } from "@/server/academy";

/** The signed-in user's Academy: level, XP, streak, learning path and badges. */
export const GET = query(async () => {
  const user = await requireUser();
  return Response.json(await academyOverview(user), { headers: { "Cache-Control": "no-store" } });
});
