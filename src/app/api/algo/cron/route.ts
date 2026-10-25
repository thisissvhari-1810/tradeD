import { timingSafeEqual } from "crypto";
import { tickAllSessions } from "@/server/algo";

/**
 * Ticks every running paper algo session, for a server scheduler (e.g. Vercel Cron every minute). It needs
 * CRON_SECRET (sent as "Authorization: Bearer <secret>"); without the secret configured it refuses all calls.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const ok = secret.length >= 16 && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return Response.json({ error: "Not allowed." }, { status: 401 });
  return Response.json(await tickAllSessions(), { headers: { "Cache-Control": "no-store" } });
}
