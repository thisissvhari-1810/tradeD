import { z } from "zod";
import { mutation, query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { listWatchlists, mutateWatchlist } from "@/server/watchlists";

const bodySchema = z.object({
  action: z.enum(["create", "rename", "delete", "add", "remove"]),
  id: z.string().optional(),
  name: z.string().optional(),
  symbol: z.string().optional(),
});

export const GET = query(async () => {
  const user = await requireUser();
  return Response.json({ lists: await listWatchlists(user.id) });
});

export const POST = mutation(async (request) => {
  const user = await requireUser();
  const body = bodySchema.parse(await request.json().catch(() => null));
  return Response.json(await mutateWatchlist(user.id, body));
});
