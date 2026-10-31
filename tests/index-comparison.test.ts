import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IndexComparisonView } from "../src/components/algo/index-comparison";
import { DEFINITIONS, INDEX_SPECS, summarize, type AuditTrade, type IndexBacktestReport, type IndexResult } from "../src/lib/algo/index-backtest";

/* The index-comparison dashboard renders a stored report: results where they exist, NOT BACKTESTED where they do not. */

const trade = (id: number, net: number, right: "CE" | "PE"): AuditTrade => ({
  id: `FINNIFTY:2026-10-0${id}:1`, date: `2026-10-0${id}`, index: "FINNIFTY", optionSymbol: `FINNIFTY 2026-10-27 24050 ${right}`, right, side: right === "CE" ? "CALL" : "PUT", expiry: "2026-10-27", strike: 24_050, lotSize: 60, lots: 16, quantity: 960, lines: ["Previous-day high"], shadow: false,
  signalTime: 1_000 * id, entryTime: 1_000 * id + 180, entryPremium: 100.05, targetPremium: 103.05, exitTime: 1_000 * id + 300, exitPremium: net > 0 ? 103 : 95, exitReason: net > 0 ? "Target" : "Time limit", targetHit: net > 0,
  gross: net + 270, charges: 270, net, deployed: 96_170, returnPercent: Math.round((net / 96_048) * 10_000) / 100, mfe: 3.25, mae: 0.55, mfePercent: 3.25, maePercent: 0.55, holdingMinutes: 2, flags: net > 0 ? [] : ["MISSING_OPTION_MINUTES"], slippage: 96, netConservative: net,
  evidence: { signalCandle: null, targetCandle: null, heldMinutes: 2, missingMinutes: 0, entryVolume: null }, timeline: [{ time: 1_000 * id + 180, text: "BUY order FILLED (simulated)" }],
});

const quality = { duplicates: 0, outsideSession: 0, invalid: 0, incompleteSessions: [], offsetsWithData: ["ATM"], requestFailures: [], verification: { checked: 2, problems: [] } };
const session = (date: string) => ({ date, status: "SIMULATED" as const, indexCandles: 375, missingMinutes: [], optionStrikes: 42, expiry: { expiry: "2026-10-27", source: "data" as const, calendar: "2026-10-27", mismatch: false }, spotChecked: 10, spotMismatched: 0, signals: { detected: 2, confirmed: 1, falseBreakouts: 0, expired: 1, rejected: 0, entered: 1, shadow: 0 }, rejections: [] });

function report(indices: IndexResult[], limitations: string[] = []): IndexBacktestReport {
  return { generatedAt: "2026-10-28T04:00:00Z", window: { from: "2026-09-28", to: "2026-10-27", weekdays: 22, holidays: ["2026-10-02", "2026-10-20"] }, provider: "Dhan HQ v2", capital: 100_000, strategy: { name: "Mathi Strategy (+3%)", version: 18, rules: ["+3% on the entry premium"], config: {} }, definitions: DEFINITIONS, limitations, indices };
}

const notBacktested = (symbol: keyof typeof INDEX_SPECS, reason: string): IndexResult => ({ symbol, name: INDEX_SPECS[symbol].name, status: "NOT_BACKTESTED", reason, premiumSource: "none", spec: INDEX_SPECS[symbol], sessions: [], trades: [], shadowTrades: [], summary: null, sensitivity: null, dataQuality: { ...quality, offsetsWithData: [], verification: { checked: 0, problems: [] } } });

describe("index comparison dashboard", () => {
  it("shows each index's figures, the comparison columns and every trade; an index without premiums is NOT BACKTESTED with its reason", () => {
    const trades = [trade(1, 2_500, "CE"), trade(2, -4_800, "PE")];
    const finnifty: IndexResult = { symbol: "FINNIFTY", name: INDEX_SPECS.FINNIFTY.name, status: "BACKTESTED", reason: null, premiumSource: "Actual historical premiums", spec: INDEX_SPECS.FINNIFTY, sessions: [session("2026-10-01"), session("2026-10-02")], trades, shadowTrades: [], summary: summarize(trades, ["2026-10-01", "2026-10-02"], 100_000), sensitivity: { statutoryCharges: 500, netAtStatutoryCharges: -2_260, stressSlippageTicks: 5, netAtStressSlippage: -3_100 }, dataQuality: quality };
    const html = renderToStaticMarkup(createElement(IndexComparisonView, { report: report([finnifty, notBacktested("MIDCPNIFTY", "Dhan returned no option history."), notBacktested("NIFTYNXT50", "No eligible contracts traded.")]), reason: null }));
    for (const text of ["Data availability", "Trading sessions", "Total trades", "CE trades", "PE trades", "Target-hit count", "Charges (est.)", "Net return %", "Maximum drawdown", "Backtested", "NOT BACKTESTED", "Dhan returned no option history.", "No eligible contracts traded.", "2026-10-02, 2026-10-20", "−₹2,300.00", "Daily net P&amp;L", "Cumulative net P&amp;L", "1 flag"]) expect(html).toContain(text);
    expect(html.match(/<tr tabindex="0"/g)).toHaveLength(2);
    expect(html).not.toContain("NaN");
  });

  it("says plainly that nothing was run, and shows no figures, when the data could not be downloaded", () => {
    const reason = "No Dhan credentials: set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN.";
    const html = renderToStaticMarkup(createElement(IndexComparisonView, { report: report((["FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"] as const).map((symbol) => notBacktested(symbol, reason)), [`NOT RUN: ${reason}`]), reason: null }));
    expect(html.match(/NOT BACKTESTED/g)!.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("NOT RUN: No Dhan credentials");
    expect(html).toContain("No simulated trades");
    expect(html).not.toMatch(/[+−]₹\d/);
  });

  it("without any stored report, gives the reason", () => {
    expect(renderToStaticMarkup(createElement(IndexComparisonView, { report: null, reason: "No index backtest has been run here yet." }))).toContain("No index backtest has been run here yet.");
  });
});
