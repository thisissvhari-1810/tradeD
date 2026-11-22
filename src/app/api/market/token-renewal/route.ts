import { timingSafeEqual } from "crypto";
import { renewMarketTokenIfDue } from "@/server/market-token-renewal";

export const dynamic = "force-dynamic";

/**
 * Automatic renewal of the market-data (charts) Dhan token. The scheduler (exec-worker/install-token-renewal.sh)
 * calls this every 5 minutes, all day; it renews only when due (after 15:40 IST, a second time near 16:00, or
 * 07:30-09:00 as a second chance - see src/lib/dhan/token-renewal.ts) and never during market hours unless the token
 * would otherwise die before the close. Same CRON_SECRET bearer check as /api/algo/cron; without the secret
 * configured it refuses all calls. The answer never contains a token.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const ok = secret.length >= 16 && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return Response.json({ error: "Not allowed." }, { status: 401 });
  const outcome = await renewMarketTokenIfDue();
  return Response.json({ ...outcome, at: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
