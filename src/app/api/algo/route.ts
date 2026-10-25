import { readJson } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireUser } from "@/server/auth";
import { mutation, query } from "@/server/http";
import { algoCommand, algoHistory, algoReport, algoView, backtestDay, marketPlan } from "@/server/algo";
import { ALGO_SESSION_ID, algoRequest } from "@/lib/algo/request";

/** The Strategy Algo of the signed-in user: settings, state, position and signal log. */
export const GET = query(async (request: Request) => {
  const user = await requireUser();
  const params = new URL(request.url).searchParams;
  // Home → Algo History: archived replay sessions only (read-only; never touches the active session).
  if (params.get("history") === "1") return Response.json(await algoHistory(user), { headers: { "Cache-Control": "no-store" } });
  // One session's full record, for its downloadable report (only the user's own sessions).
  const report = params.get("report");
  if (report) {
    if (!/^[a-z0-9]{8,40}$/.test(report)) return Response.json({ error: "Invalid session.", code: "BAD_REQUEST" }, { status: 400 });
    return Response.json(await algoReport(user, report), { headers: { "Cache-Control": "no-store" } });
  }
  // The provisional pre-market plan for a date (read-only).
  const plan = params.get("plan");
  if (plan) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(plan)) return Response.json({ error: "Invalid date.", code: "BAD_REQUEST" }, { status: 400 });
    rateLimit(`algo:plan:${user.id}`, 30, 60_000);
    return Response.json(await marketPlan(user, plan), { headers: { "Cache-Control": "no-store" } });
  }
  const session = params.get("session");
  return Response.json(await algoView(user, session && ALGO_SESSION_ID.test(session) ? session : null), { headers: { "Cache-Control": "no-store" } });
});

/** Settings, session controls, a monitoring tick or a historical replay. Every check runs on the server. */
export const POST = mutation(async (request) => {
  const user = await requireUser();
  const input = await readJson(request, algoRequest);
  if (input.action === "tick") rateLimit(`algo:tick:${user.id}`, 20, 60_000);
  else if (input.action === "chartStep") rateLimit(`algo:step:${user.id}`, 240, 60_000);
  else if (input.action === "backtestDay") {
    rateLimit(`algo:backtest:${user.id}`, 90, 60_000);
    return Response.json(await backtestDay(user, input.date, input.variant, input.strategy));
  }
  else if (input.action === "replay") rateLimit(`algo:replay:${user.id}`, 6, 60_000);
  else rateLimit(`algo:command:${user.id}`, 30, 60_000);
  return Response.json(await algoCommand(user, input));
});
