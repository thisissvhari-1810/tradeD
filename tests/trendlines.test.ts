import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/algo/lines";
import { minuteTrendLines, priceOn } from "@/lib/chart/trendlines";

const OPEN = Date.UTC(2026, 10, 19, 3, 45) / 1000; // 19 Nov 2026 09:15 IST
const CLOSE = OPEN + 375 * 60;
const at = (minute: number) => OPEN + minute * 60; // minutes after 09:15

// Modelled on the user's 19 Nov 2026 drawing: 1st High at 09:17 (25,255), a falling market with lower highs and lows,
// and the breakout above the upper line at 09:35, then 09:36 above the 09:35 high.
const ROWS: Array<[number, number, number, number]> = [
  [25187, 25200, 25150, 25197], // 09:15 (long opening wick; its body is 25,187-25,197)
  [25197, 25235, 25190, 25232], // 09:16
  [25232, 25255, 25225, 25245], // 09:17  1st High
  [25245, 25248, 25215, 25220], // 09:18
  [25220, 25240, 25200, 25205], // 09:19
  [25205, 25210, 25165, 25170], // 09:20
  [25170, 25178, 25150, 25155], // 09:21
  [25155, 25160, 25140, 25148], // 09:22
  [25148, 25165, 25138, 25160], // 09:23  swing low
  [25160, 25172, 25150, 25168], // 09:24
  [25168, 25175, 25155, 25158], // 09:25  swing high
  [25158, 25162, 25140, 25145], // 09:26
  [25145, 25150, 25125, 25130], // 09:27
  [25130, 25135, 25110, 25115], // 09:28
  [25115, 25125, 25105, 25120], // 09:29  swing low
  [25120, 25138, 25112, 25135], // 09:30  (closes above the 09:17-09:25 line: drift, not above the 25,175 swing high)
  [25135, 25140, 25118, 25122], // 09:31  swing high
  [25122, 25130, 25110, 25125], // 09:32
  [25125, 25132, 25115, 25128], // 09:33
  [25128, 25134, 25120, 25131], // 09:34
  [25131, 25165, 25128, 25160], // 09:35  breakout
  [25160, 25185, 25155, 25180], // 09:36  entry
];
const tape: Candle[] = Array.from({ length: 375 }, (_, i) => {
  const [open, high, low, close] = ROWS[i] ?? [25180 + (i - 21) * 0.5, 25185 + (i - 21) * 0.5, 25175 + (i - 21) * 0.5, 25181 + (i - 21) * 0.5];
  return { time: at(i), open, high, low, close };
});

describe("1-minute trend lines", () => {
  it("anchors on the first 3 minutes (09:15 by its body) and hugs the swing highs and lows", () => {
    const state = minuteTrendLines(tape, OPEN, CLOSE, at(20)); // candles through 09:34
    expect(state.firstHigh).toEqual({ time: at(2), price: 25255 });
    expect(state.firstLow).toEqual({ time: at(0), price: 25187 }); // not the 25,150 opening wick
    // Upper: 09:17 high → 09:31 swing high (the flattest line still over every swing high in between).
    expect(state.upper).toMatchObject({ a: { time: at(2), price: 25255 }, b: { time: at(16), price: 25140 }, brokenAt: null });
    for (const minute of [10, 16]) expect(priceOn(state.upper!, at(minute))).toBeGreaterThanOrEqual(tape[minute].high - 1e-9);
    // Lower: 1st Low → the swing low that keeps every other swing low above it.
    expect(state.lower?.a).toEqual({ time: at(0), price: 25187 });
    for (const minute of [8, 14]) expect(priceOn(state.lower!, at(minute))).toBeLessThanOrEqual(tape[minute].low + 1e-9);
  });

  it("breaks at 09:35 (close above the line and the last swing high) and enters on 09:36", () => {
    const state = minuteTrendLines(tape, OPEN, CLOSE, CLOSE + 60);
    expect(state.upper?.brokenAt).toBe(at(20));
    expect(state.signal).toMatchObject({ side: "CALL", fallback: false, breakout: { time: at(20) }, entry: { time: at(21) } });
    // Nothing before it happened.
    expect(minuteTrendLines(tape, OPEN, CLOSE, at(21)).signal).toBeNull();
    expect(minuteTrendLines(tape, OPEN, CLOSE, at(2)).upper).toBeNull();
  });

  it("falls back to the day's direction at 11:00 when no line breaks", () => {
    const flat: Candle[] = Array.from({ length: 375 }, (_, i) => ({ time: at(i), open: 25000 - i * 0.1, high: 25002 - i * 0.1, low: 24998 - i * 0.1, close: 25000 - i * 0.1 }));
    const state = minuteTrendLines(flat, OPEN, CLOSE, CLOSE + 60);
    expect(state.signal).toMatchObject({ side: "PUT", fallback: true, entry: { time: at(104) } });
  });
});
