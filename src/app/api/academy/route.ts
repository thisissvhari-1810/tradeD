import { z } from "zod";
import { readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation, query } from "@/server/http";
import { academyIntroSeen, academyOverview } from "@/server/academy";

/** The signed-in user's Academy: level, XP, streak, learning path, badges and whether the intro was seen. */
export const GET = query(async () => {
  const user = await requireUser();
  return Response.json(await academyOverview(user), { headers: { "Cache-Control": "no-store" } });
});

const body = z.object({ action: z.literal("intro-seen") }).strict();

/** Marks the opening cinematic as seen (watched or skipped). */
export const POST = mutation(async (request) => {
  const user = await requireUser();
  await readJson(request, body);
  rateLimit(`academy:intro:${user.id}`, 10, 60_000);
  return Response.json(await academyIntroSeen(user));
});
