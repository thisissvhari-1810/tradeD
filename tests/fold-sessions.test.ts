import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { foldSessions, istDateKey } from "@/lib/market/fold-sessions";

// IST midnight of a date, in UTC seconds (the provider's daily stamp when its offset is 0).
const midnight = (key: string) => Math.floor(Date.UTC(...(key.split("-").map(Number) as [number, number, number]).map((value, index) => (index === 1 ? value - 1 : value)) as [number, number, number]) / 1000) - 19_800;
const at = (key: string, hour: number, minute: number) => midnight(key) + hour * 3600 + minute * 60;
const bar = (time: number, open: number, high: number, low: number, close: number, volume = 10) => ({ time, open, high, low, close, volume });

describe("daily candles for sessions the daily history has not published", () => {
  const minutes = [
    bar(at("2026-10-21", 9, 15), 100, 101, 99, 100.5),
    bar(at("2026-10-22", 9, 15), 102, 104, 101, 103),
    bar(at("2026-10-22", 12, 0), 103, 108, 102, 107),
    bar(at("2026-10-22", 15, 25), 107, 107.5, 95, 96, 30),
  ];

  it("folds the missing day (Oct 22) into one daily bar: first open, max high, min low, last close, summed volume", () => {
    const folded = foldSessions(minutes, "2026-10-21", midnight("2026-10-21"));
    expect(folded).toEqual([{ time: midnight("2026-10-22"), open: 102, high: 108, low: 95, close: 96, volume: 50 }]);
    expect(istDateKey(folded[0].time)).toBe("2026-10-22");
  });

  it("never duplicates a day the daily history already has", () => {
    expect(foldSessions(minutes, "2026-10-22", midnight("2026-10-22"))).toEqual([]);
  });

  it("keeps the provider's daily stamp offset", () => {
    const shifted = foldSessions(minutes, "2026-10-21", midnight("2026-10-21") + 19_800);
    expect(shifted[0].time).toBe(midnight("2026-10-22") + 19_800);
  });

  it("is used for the daily chart and for the strategy / replay daily history", () => {
    const dhan = readFileSync(join(process.cwd(), "src/server/dhan-market.ts"), "utf8");
    expect(dhan).toContain("let candles = await withRecentSessions(await dailyHistory(id, from, tomorrow, segment, kind), id, segment, kind, now);");
    expect(dhan).toContain("return withRecentSessions(await dailyHistory(id, start, end, segment, kind), id, segment, kind, end);");
  });
});

describe("Dhan intraday requests stay valid", () => {
  it("before 09:15 steps back to the previous days' 15:30 close instead of ending in the pre-open gap", async () => {
    const { intradayEnds } = await import("@/lib/market/dhan-ranges");
    expect(intradayEnds("2026-10-23 09:13:20")).toEqual(["2026-10-23 09:13:20", "2026-10-22 15:30:00", "2026-10-21 15:30:00", "2026-10-20 15:30:00"]);
  });

  it("during the session tries now first, then today's close is skipped (it is later), then earlier closes", async () => {
    const { intradayEnds } = await import("@/lib/market/dhan-ranges");
    expect(intradayEnds("2026-10-23 14:34:06")[0]).toBe("2026-10-23 14:34:06");
    expect(intradayEnds("2026-10-23 14:34:06")[1]).toBe("2026-10-22 15:30:00");
  });

  it("short fallback ranges are five calendar days before the end", async () => {
    const { daysBefore } = await import("@/lib/market/dhan-ranges");
    expect(daysBefore("2026-10-22 15:30:00", 5)).toBe("2026-10-17");
  });

  it("logs a refused request without the token", () => {
    const dhan = readFileSync(join(process.cwd(), "src/server/dhan-market.ts"), "utf8");
    expect(dhan).toContain('console.error("[dhan] request refused"');
    expect(dhan).toContain("for (const end of intradayEnds(until)) {");
  });
});

describe("daily history request", () => {
  const dhan = readFileSync(join(process.cwd(), "src/server/dhan-market.ts"), "utf8");
  it("retries with today, then yesterday, as the end date when the provider refuses tomorrow", () => {
    expect(dhan).toContain("for (const candidate of [0, 1, 2, 3].map((days) => new Date(now.getTime() - days * 86_400_000))) {");
    expect(dhan).toContain("for (const end of dailyEndDates(to, new Date())) {");
    expect(dhan).toContain("if (!(error instanceof AppError)) throw error;");
  });
});
