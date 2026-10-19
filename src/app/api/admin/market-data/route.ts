import { z } from "zod";
import { mutation, query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { marketConnectionStatus, saveMarketConnection } from "@/server/settings";

const bodySchema = z.object({
  clientId: z.string().max(20).optional(),
  accessToken: z.string().max(4000).optional(),
  clearToken: z.boolean().optional(),
});

export const GET = query(async () => {
  await requireUser(["SUPER_ADMIN"]);
  return Response.json(await marketConnectionStatus());
});

export const POST = mutation(async (request) => {
  const user = await requireUser(["SUPER_ADMIN"]);
  const body = bodySchema.parse(await request.json().catch(() => null));
  return Response.json(await saveMarketConnection(user.id, body));
});
