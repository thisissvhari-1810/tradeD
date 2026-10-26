"use client";

import { api } from "@/components/api";
import { algoReportCsv, algoReportName, algoTradeCsv, algoTradeName, type AlgoReportInput } from "@/lib/algo/report";
import { algoTrades } from "@/lib/algo/chart-replay";

/**
 * Downloads one replay session's full report (summary, trades and the complete flow) as a CSV. The data
 * is the session's stored record from the server, not what happens to be on screen.
 */
export async function downloadAlgoReport(runId: string) {
  const report = await api<AlgoReportInput>(`/api/algo?report=${encodeURIComponent(runId)}`);
  save(algoReportCsv(report), algoReportName(report));
}

/** One trade's full record (where and how it was bought, its exit, charges and P&L) as a CSV, from the stored session. */
export async function downloadAlgoTrade(runId: string, entryKey: string) {
  const report = await api<AlgoReportInput>(`/api/algo?report=${encodeURIComponent(runId)}`);
  const number = algoTrades(report.events, null).find((trade) => trade.entryKey === entryKey)?.number ?? 0;
  save(algoTradeCsv(report, entryKey), algoTradeName(report, number));
}

function save(csv: string, name: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
