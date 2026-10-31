import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IndexBacktestReport } from "@/lib/algo/index-backtest";

/**
 * The latest index-comparison backtest (Mathi Strategy +3% on FINNIFTY, MIDCPNIFTY, NIFTY NEXT 50), as written by
 * `npm run backtest:indices`. Read-only; the file lives beside the app (or at INDEX_BACKTEST_RESULTS) and is absent on a
 * deployment that has not run the script, which is said instead of showing anything.
 */
export async function indexBacktestReport(): Promise<{ report: IndexBacktestReport | null; reason: string | null }> {
  const file = process.env.INDEX_BACKTEST_RESULTS || path.join(process.cwd(), ".backtests", "index-comparison", "latest.json");
  try {
    return { report: JSON.parse(await readFile(file, "utf8")) as IndexBacktestReport, reason: null };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { report: null, reason: missing ? "No index backtest has been run here yet. Run `npm run backtest:indices` with DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN set." : "The stored backtest results could not be read." };
  }
}
