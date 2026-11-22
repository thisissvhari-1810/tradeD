import { z } from "zod";
import { mutation, query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { listLineDrawings, mutateLineDrawings, type LineDrawingAction } from "@/server/chart-lines";

// Line Strategy Draw: the signed-in user's saved chart line drawings. The config is validated in depth by
// normalizeConfig (src/lib/chart/line-drawings.ts); this schema only bounds the request.
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: z.string().max(200), symbol: z.string().max(40).optional(), timeframe: z.string().max(10).optional(), enabled: z.boolean().optional(), config: z.unknown().optional() }),
  z.object({ action: z.literal("update"), id: z.string().max(40), name: z.string().max(200).optional(), symbol: z.string().max(40).optional(), timeframe: z.string().max(10).optional(), enabled: z.boolean().optional(), config: z.unknown().optional() }),
  z.object({ action: z.literal("duplicate"), id: z.string().max(40) }),
  z.object({ action: z.literal("delete"), id: z.string().max(40) }),
  z.object({ action: z.literal("set-all"), enabled: z.boolean(), symbol: z.string().max(40).optional() }),
]);

export const GET = query(async () => {
  const user = await requireUser();
  return Response.json({ drawings: await listLineDrawings(user.id) }, { headers: { "Cache-Control": "no-store" } });
});

export const POST = mutation(async (request) => {
  const user = await requireUser();
  const body = bodySchema.parse(await request.json().catch(() => null)) as LineDrawingAction;
  return Response.json(await mutateLineDrawings(user.id, body));
});
