import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  entryNotice,
  holdingLabel,
  missingPriceReason,
  parsePercentBps,
  parseRupees,
  positionStatus,
  replayChipLabel,
} from "@/lib/trading/position-view";

const OPEN = Date.parse("2026-10-16T03:45:00Z") / 1000; // 09:15 IST

describe("replay position lifecycle", () => {
  it("names each lifecycle state in plain words", () => {
    expect(positionStatus({ quantity: 650, beforeEntry: true })).toBe("Waiting for entry time");
    expect(positionStatus({ quantity: 650 })).toBe("Open");
    expect(positionStatus({ quantity: 0 })).toBe("Closed");
  });

  it("tells the user when the position opens, using the actual entry time", () => {
    expect(entryNotice("2026-10-16T04:12:00.000Z")).toBe("Opens at 09:42 IST — move replay forward");
    expect(entryNotice(null)).toMatch(/move replay forward/);
  });

  it("explains a missing price from the real replay state", () => {
    expect(missingPriceReason({ cursor: null, sessionOpen: OPEN, loading: false })).toBe("Waiting for the first replay candle.");
    expect(missingPriceReason({ cursor: OPEN, sessionOpen: OPEN, loading: false })).toBe("No trade at 09:15 — price becomes available after the first candle.");
    expect(missingPriceReason({ cursor: OPEN + 600, sessionOpen: OPEN, loading: true })).toBe("Loading the replay premium…");
    expect(missingPriceReason({ cursor: OPEN + 600, sessionOpen: OPEN, loading: false, message: "The last trade was 12 minutes ago." })).toBe("The last trade was 12 minutes ago.");
    expect(missingPriceReason({ cursor: OPEN + 600, sessionOpen: OPEN, loading: false })).toBe("Price unavailable for this contract at the selected replay time.");
  });

  it("formats the header replay chip from the real date and clock", () => {
    expect(replayChipLabel("2026-10-16", OPEN)).toBe("Replay 16 Oct · 09:15");
    expect(replayChipLabel("2026-10-16", OPEN + 27 * 60)).toBe("Replay 16 Oct · 09:42");
    expect(replayChipLabel("2026-10-16", null)).toBe("Replay 16 Oct");
  });

  it("parses ledger money text without inventing values", () => {
    expect(parseRupees("97.61")).toBe(9_761n);
    expect(parseRupees("-12.30")).toBe(-1_230n);
    expect(parseRupees("+₹1,36,900.40")).toBe(13_690_040n);
    expect(parseRupees("−₹45.00")).toBe(-4_500n);
    expect(parseRupees("—")).toBeNull();
    expect(parseRupees(null)).toBeNull();
    expect(parsePercentBps("+11.80%")).toBe(1_180);
    expect(parsePercentBps("—")).toBeNull();
    expect(holdingLabel(33 * 60)).toBe("33m");
    expect(holdingLabel(65 * 60)).toBe("1h 05m");
  });
});

describe("replay UI wiring", () => {
  const book = readFileSync("src/components/option-book.tsx", "utf8");
  const desk = readFileSync("src/components/chart-desk.tsx", "utf8");
  const header = readFileSync("src/components/chart-header-tools.tsx", "utf8");

  it("hides the Exit action while waiting for the entry time instead of showing a disabled button", () => {
    expect(book).toMatch(/\{waiting \? null : \(\s*<div className="mt-2 flex flex-wrap items-center gap-2">/);
    expect(book).not.toMatch(/NOT YET OPEN/);
    expect(book).not.toMatch(/disabled=\{exitReason != null\}/);
  });

  it("uses the shared session summary for the hero, the realized metric and trade results", () => {
    expect(book).toMatch(/realizedMetric\(\{ replay: true, summary \}\)/);
    expect(book).toMatch(/summary\?\.trades/);
    expect(book).toMatch(/Replay session P&L/);
    expect(book).toMatch(/OUTCOME_LABEL\[row\.outcome\]/);
  });

  it("announces each closed trade once from the ledger summary", () => {
    expect(desk).toMatch(/newlyClosed\(seen, summary\)/);
    expect(desk).toMatch(/Trade closed: \$\{formatPnl\(trade\.netPaise\)\}/);
    const toast = readFileSync("src/components/ui/toast.tsx", "utf8");
    expect(toast).toMatch(/aria-live="polite"/);
  });

  it("routes Exit replay through the summary and reuses the existing restart path", () => {
    expect(desk).toMatch(/replay\.active \? requestExitReplay\(\)/);
    expect(desk).toMatch(/onRestart=\{\(\) => \{ closeSummary\(\); returnToStart\(\); \}\}/);
    expect(desk).toMatch(/onBackToLive=\{\(\) => \{ closeSummary\(\); leaveReplay\(\); \}\}/);
    expect(desk).toMatch(/onClick=\{\(\) => \{ returnToStart\(\); setRestart\(false\); \}\}>Return to start/);
  });

  it("places Replay and Option chain right after Undo/Redo, before the spacer", () => {
    const redo = header.indexOf('label="Redo"');
    const slot = header.indexOf("{children ?");
    const spacer = header.indexOf('className="min-w-2 flex-1"');
    const volume = header.indexOf("Hide volume");
    expect(redo).toBeGreaterThan(0);
    expect(slot).toBeGreaterThan(redo);
    expect(spacer).toBeGreaterThan(slot);
    expect(volume).toBeGreaterThan(spacer);
    const replayButton = desk.indexOf('{replay.active ? "Exit replay" : "Replay"}');
    const chip = desk.indexOf("replayChipLabel(replay.date, replay.cursor)");
    const chain = desk.indexOf(">Option chain</button>");
    expect(replayButton).toBeGreaterThan(0);
    expect(chip).toBeGreaterThan(replayButton);
    expect(chain).toBeGreaterThan(chip);
  });
});
