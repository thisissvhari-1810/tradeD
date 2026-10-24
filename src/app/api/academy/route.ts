import { z } from "zod";
import { readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation, query } from "@/server/http";
import { academyIntroSeen, academyOverview, academySetTheme } from "@/server/academy";
import { ACADEMY_THEMES } from "@/lib/academy/themes";

/** The signed-in user's Academy: level, XP, streak, learning path, badges and whether the intro was seen. */
export const GET = query(async () => {
  const user = await requireUser();
  return Response.json(await academyOverview(user), { headers: { "Cache-Control": "no-store" } });
});

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("intro-seen") }).strict(),
  z.object({ action: z.literal("theme"), theme: z.enum(ACADEMY_THEMES) }).strict(),
]);

/** Marks the opening cinematic as seen (watched or skipped), or saves the chosen map world. */
export const POST = mutation(async (request) => {
  const user = await requireUser();
  const input = await readJson(request, body);
  if (input.action === "theme") {
    rateLimit(`academy:theme:${user.id}`, 20, 60_000);
    return Response.json(await academySetTheme(user, input.theme));
  }
  rateLimit(`academy:intro:${user.id}`, 10, 60_000);
  return Response.json(await academyIntroSeen(user));
});
