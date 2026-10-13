import { z } from "zod";
import { readJson } from "@/lib/http";
import { mutation, query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { optionsDesk, placeOptionPaper } from "@/server/options-paper";

const orderSchema = z.object({
  action: z.enum(["BUY", "CLOSE"]),
  idempotencyKey: z.string().min(8).max(80),
});

export const GET = query(async () => {
  const user = await requireUser(["STUDENT"]);
  return Response.json(await optionsDesk(user));
});

export const POST = mutation(async (request) => {
  const user = await requireUser(["STUDENT"]);
  const input = await readJson(request, orderSchema);
  const result = await placeOptionPaper(user, input);
  return Response.json({
    ...result,
    message: result.order.status === "FILLED"
      ? "Simulated options order filled. No broker received it."
      : result.order.reason,
  });
});
