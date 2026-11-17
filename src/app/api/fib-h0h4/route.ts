import { z } from "zod";
import { readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation, query } from "@/server/http";
import { h0h4Backtest, h0h4Backtests, h0h4Baseline, h0h4Command, h0h4Day, h0h4View } from "@/server/fib-h0h4";

/** 5-Minute H0–H4 Fibonacci Breakout (paper only): its own state, history and backtests. */
export const GET = query(async (request: Request) => {
  const user = await requireUser();
  const params = new URL(request.url).searchParams;
  const headers = { "Cache-Control": "no-store" };
  if (params.get("backtests") === "1") return Response.json(await h0h4Backtests(user), { headers });
  if (params.get("baseline") === "1") return Response.json(await h0h4Baseline(), { headers });
  const day = params.get("day");
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return Response.json({ error: "Invalid date.", code: "BAD_REQUEST" }, { status: 400 });
    return Response.json(await h0h4Day(user, day), { headers });
  }
  rateLimit(`h0h4:view:${user.id}`, 30, 60_000);
  return Response.json(await h0h4View(user), { headers });
});

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const request = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("tick") }),
  z.object({ action: z.literal("backtest"), from: DATE, to: DATE }),
]);

export const POST = mutation(async (req) => {
  const user = await requireUser();
  const input = await readJson(req, request);
  if (input.action === "backtest") {
    rateLimit(`h0h4:backtest:${user.id}`, 4, 60_000);
    return Response.json(await h0h4Backtest(user, input.from, input.to));
  }
  rateLimit(`h0h4:${input.action}:${user.id}`, 20, 60_000);
  return Response.json(await h0h4Command(user, input.action));
});
