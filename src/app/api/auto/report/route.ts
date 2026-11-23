import { query } from "@/server/http";
import { requireUser } from "@/server/auth";
import { autoReport, reportCsv } from "@/server/auto/views";
import type { buildReport } from "@/server/auto/engine";

export const GET = query(async (request) => {
  await requireUser(["SUPER_ADMIN"]);
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "";
  const data = await autoReport(date);
  if (url.searchParams.get("format") === "csv") {
    return new Response(reportCsv(data.report as Awaited<ReturnType<typeof buildReport>>), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="automated-paper-${date}.csv"`, "Cache-Control": "no-store" } });
  }
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
});
