import { z } from "zod";
import { mutation, query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { autoControl, autoOverview, monwedEventList, type AutoAction } from "@/server/auto/views";

// Automated paper trading dashboard (Super Admin only). Paper trading: nothing here reaches a broker.
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("master"), enabled: z.boolean() }),
  z.object({ action: z.literal("mode"), mode: z.enum(["PAPER", "SHADOW"]) }),
  z.object({ action: z.literal("strategy"), key: z.string().max(20), op: z.enum(["enable", "disable", "pause", "resume"]) }),
  z.object({ action: z.literal("events"), events: z.record(z.string(), z.array(z.string().max(10)).max(400)) }),
]);

export const GET = query(async (request) => {
  await requireUser(["SUPER_ADMIN"]);
  if (new URL(request.url).searchParams.get("events") === "1") return Response.json(await monwedEventList(), { headers: { "Cache-Control": "no-store" } });
  return Response.json(await autoOverview(), { headers: { "Cache-Control": "no-store" } });
});

export const POST = mutation(async (request) => {
  const user = await requireUser(["SUPER_ADMIN"]);
  const body = bodySchema.parse(await request.json().catch(() => null)) as AutoAction;
  return Response.json(await autoControl(body, user.id));
});
