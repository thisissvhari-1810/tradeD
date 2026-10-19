import { z } from "zod";
import { mutation, query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { allocateDemoCapital, capitalHistory, listDemoAccounts, resetDemoAccount } from "@/server/demo-capital";

const allocateSchema = z.object({
  action: z.literal("allocate"),
  userId: z.string().min(1),
  amountRupees: z.string().min(1),
  direction: z.enum(["credit", "debit"]),
  reason: z.string().trim().min(3).max(300),
  idempotencyKey: z.string().min(8).max(80),
});

const resetSchema = z.object({
  action: z.literal("reset"),
  userId: z.string().min(1),
  reason: z.string().trim().min(3).max(300),
});

const historySchema = z.object({
  action: z.literal("history"),
  userId: z.string().min(1),
});

export const GET = query(async () => {
  const user = await requireUser(["SUPER_ADMIN"]);
  return Response.json({ students: await listDemoAccounts(user) });
});

export const POST = mutation(async (request) => {
  const user = await requireUser(["SUPER_ADMIN"]);
  const body = await request.json();
  if (body?.action === "history") {
    const input = historySchema.parse(body);
    return Response.json({ entries: await capitalHistory(user, input.userId) });
  }
  if (body?.action === "reset") {
    const input = resetSchema.parse(body);
    await resetDemoAccount(user, input.userId, input.reason, request.headers.get("x-forwarded-for") ?? undefined);
    return Response.json({ ok: true, message: "A new practice period was opened. Earlier trades and allocations remain in the ledger." });
  }
  const input = allocateSchema.parse(body);
  await allocateDemoCapital(user, input, request.headers.get("x-forwarded-for") ?? undefined);
  return Response.json({ ok: true, message: input.direction === "credit" ? "Demo capital was added." : "Demo capital was reduced." });
});
