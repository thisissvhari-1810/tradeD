import { timingSafeEqual } from "crypto";
import { tickAllSessions } from "@/server/algo";

// One pass may call the market-data provider for each open position: allow it the platform's longest Hobby limit.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Checks every active paper algo session from the server (see docs/paper-monitoring.md for the scheduler). It needs
 * CRON_SECRET (sent as "Authorization: Bearer <secret>"); without the secret configured it refuses all calls. The answer
 * lists each session checked, whether it holds a position and any market-data problem, so the scheduler's log shows them.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const ok = secret.length >= 16 && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return Response.json({ error: "Not allowed." }, { status: 401 });
  const started = Date.now();
  const result = await tickAllSessions();
  return Response.json({ ...result, at: new Date(started).toISOString(), ms: Date.now() - started }, { headers: { "Cache-Control": "no-store" } });
}
