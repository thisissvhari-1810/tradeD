import { z } from "zod";
import { AppError, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation, query, type RouteContext } from "@/server/http";
import { academyAnswer, academyComplete, academyLesson } from "@/server/academy";

type Context = RouteContext<{ slug: string }>;

const slugParam = z.string().regex(/^[a-z0-9-]{3,80}$/);

const answer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), index: z.number().int().min(0).max(10) }).strict(),
  z.object({ kind: z.literal("truefalse"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("fill"), text: z.string().max(80) }).strict(),
  z.object({ kind: z.literal("numeric"), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal("match"), pairs: z.array(z.tuple([z.string().max(200), z.string().max(200)])).max(8) }).strict(),
  z.object({ kind: z.literal("tapcandle"), index: z.number().int().min(0).max(60) }).strict(),
  z.object({ kind: z.literal("order"), steps: z.array(z.string().max(200)).max(8) }).strict(),
  z.object({ kind: z.literal("pricezone"), price: z.number().finite() }).strict(),
]);

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("answer"), questionId: z.string().regex(/^[a-z0-9-]{3,100}$/), answer }).strict(),
  z.object({ action: z.literal("complete") }).strict(),
]);

async function slugFrom(context: Context) {
  const parsed = slugParam.safeParse((await context.params).slug);
  if (!parsed.success) throw new AppError("Lesson not found.", 404);
  return parsed.data;
}

/** A lesson's cards and questions (never the answers). */
export const GET = query<Context>(async (_request, context) => {
  const user = await requireUser();
  return Response.json(await academyLesson(user, await slugFrom(context)), { headers: { "Cache-Control": "no-store" } });
});

/** Answer a question (graded here) or complete the lesson. */
export const POST = mutation<Context>(async (request, context) => {
  const user = await requireUser();
  const slug = await slugFrom(context);
  const input = await readJson(request, body);
  if (input.action === "answer") {
    rateLimit(`academy:answer:${user.id}`, 90, 60_000);
    return Response.json(await academyAnswer(user, slug, input.questionId, input.answer));
  }
  rateLimit(`academy:complete:${user.id}`, 20, 60_000);
  return Response.json(await academyComplete(user, slug));
});
