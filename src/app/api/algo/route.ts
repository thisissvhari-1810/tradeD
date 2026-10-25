import { z } from "zod";
import { readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation, query } from "@/server/http";
import { algoCommand, algoView } from "@/server/algo";

/** The Strategy Algo of the signed-in user: settings, state, position and signal log. */
export const GET = query(async (request: Request) => {
  const user = await requireUser();
  const session = new URL(request.url).searchParams.get("session");
  return Response.json(await algoView(user, session && SESSION.test(session) ? session : null), { headers: { "Cache-Control": "no-store" } });
});

/** A chart replay session id: the replay date and a random suffix. */
const SESSION = /^\d{4}-\d{2}-\d{2}\.[a-z0-9]{4,32}$/;
const session = z.string().regex(SESSION);
const cursor = z.number().int().positive();

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), config: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("entries"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("exit") }).strict(),
  z.object({ action: z.literal("emergency") }).strict(),
  z.object({ action: z.literal("acknowledge") }).strict(),
  z.object({ action: z.literal("tick") }).strict(),
  z.object({ action: z.literal("chartMode") }).strict(),
  z.object({ action: z.literal("replay"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z.object({ action: z.literal("chartArm"), session, cursor }).strict(),
  z.object({ action: z.literal("chartStep"), session, cursor }).strict(),
  z.object({ action: z.literal("chartExit"), session, cursor, emergency: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("chartDisarm"), session }).strict(),
  z.object({ action: z.literal("chartReset"), session }).strict(),
]);

/** Settings, session controls, a monitoring tick or a historical replay. Every check runs on the server. */
export const POST = mutation(async (request) => {
  const user = await requireUser();
  const input = await readJson(request, body);
  if (input.action === "tick") rateLimit(`algo:tick:${user.id}`, 20, 60_000);
  else if (input.action === "chartStep") rateLimit(`algo:step:${user.id}`, 240, 60_000);
  else if (input.action === "replay") rateLimit(`algo:replay:${user.id}`, 6, 60_000);
  else rateLimit(`algo:command:${user.id}`, 30, 60_000);
  return Response.json(await algoCommand(user, input));
});
