import { describe, expect, it } from "vitest";
import { supertrend } from "@/lib/market/indicators";

describe("supertrend", () => {
  it("stays empty until the ATR period is available", () => {
    const bars = Array.from({ length: 8 }, (_, index) => ({ high: 10 + index, low: 9 + index, close: 9.5 + index }));
    expect(supertrend(bars, 10, 3).every((value) => value == null)).toBe(true);
  });

  it("returns a finite trailing value from candle data", () => {
    const bars = Array.from({ length: 30 }, (_, index) => ({
      high: 100 + index + 1,
      low: 100 + index - 1,
      close: 100 + index,
    }));
    const line = supertrend(bars, 10, 3);
    const last = line.at(-1);
    expect(last).not.toBeNull();
    expect(Number.isFinite(last)).toBe(true);
    expect(line.slice(0, 9).every((value) => value == null)).toBe(true);
  });
});
