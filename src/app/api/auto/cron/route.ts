import { timingSafeEqual } from "crypto";
import { autoTick } from "@/server/auto/engine";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * One pass of the automated PAPER trading engine (src/server/auto/engine.ts), called every 30 s by the scheduler
 * (exec-worker/install-auto-engine.sh). Needs AUTO_CRON_SECRET (16+ characters) as "Authorization: Bearer <secret>";
 * without it every call is refused. Its own secret, so it never enables the other cron routes.
 */
export async function GET(request: Request) {
  const secret = process.env.AUTO_CRON_SECRET ?? "";
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const ok = secret.length >= 16 && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return Response.json({ error: "Not allowed." }, { status: 401 });
  try {
    return Response.json(await autoTick(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ status: "ERROR", message: error instanceof Error ? error.message : "Engine error." }, { status: 500 });
  }
}
