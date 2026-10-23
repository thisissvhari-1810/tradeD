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
  const dhan = readFileSync(join(process.cwd(), "src/server/dhan-market.ts"), "utf8");
  it("never asks for minutes after now, and falls back to the same-day range if the wider one is refused", () => {
    expect(dhan).toContain("const end = istStamp(to.getTime() > now.getTime() ? now : to);");
    expect(dhan).toContain('return intradayHistory(id, "1", new Date(open * 1000), to, segment, kind);');
  });
});
