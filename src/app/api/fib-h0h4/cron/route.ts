import { timingSafeEqual } from "crypto";
import { tickAllH0H4 } from "@/server/fib-h0h4";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Server-side monitor for the 5-Minute H0–H4 Fibonacci Breakout paper sessions (same CRON_SECRET bearer check as
 * /api/algo/cron). Add it to the scheduler beside /api/algo/cron (every minute, 09:15–15:35 IST).
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const ok = secret.length >= 16 && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return Response.json({ error: "Not allowed." }, { status: 401 });
  const started = Date.now();
  const result = await tickAllH0H4();
  return Response.json({ ...result, at: new Date(started).toISOString(), ms: Date.now() - started }, { headers: { "Cache-Control": "no-store" } });
}
