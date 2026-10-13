import { connection } from "next/server";
import { prisma } from "@/lib/prisma";
import { configuredProvider, dhanTokenStatus } from "@/server/settings";

export async function GET() {
  await connection();
  let database: "ok" | "error" = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = "error";
  }
  const market = await prisma.marketDataStatus.findUnique({ where: { id: "primary" } }).catch(() => null);
  const token = await dhanTokenStatus().catch(() => null);
  return Response.json({
    ok: database === "ok",
    database,
    provider: configuredProvider(),
    marketMode: market?.mode ?? "UNAVAILABLE",
    marketMessage: market?.message ?? "No market status recorded yet.",
    lastSuccessAt: market?.lastSuccessAt ?? null,
    lastError: market?.lastError || null,
    token: token
      ? { source: token.source, expiresAt: token.expiresAt, expired: token.expired }
      : { source: "missing", expiresAt: null, expired: false },
  });
}
