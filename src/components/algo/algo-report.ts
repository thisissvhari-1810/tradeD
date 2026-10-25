"use client";

import { api } from "@/components/api";
import { algoReportCsv, algoReportName, type AlgoReportInput } from "@/lib/algo/report";

/**
 * Downloads one replay session's full report (summary, trades and the complete flow) as a CSV. The data
 * is the session's stored record from the server, not what happens to be on screen.
 */
export async function downloadAlgoReport(runId: string) {
  const report = await api<AlgoReportInput>(`/api/algo?report=${encodeURIComponent(runId)}`);
  const blob = new Blob([algoReportCsv(report)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = algoReportName(report);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
