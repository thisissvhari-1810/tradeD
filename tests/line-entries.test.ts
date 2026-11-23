import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/algo/lines";
import { bodyBreak, candidateSignal, entryAt, istClock, sessionEntry, strategyEntry } from "@/lib/chart/line-entries";
import type { S1Data } from "@/lib/trading/s1";

// Real-data checks (5 years of NIFTY 1-minute candles, 2026-11-23): trade 1 matched the research / app backtests on
// every traded day — Breakout 9:15 1,135 / 1,135, Second Hour 404 / 404, 13:15 Minute 193 / 193 (without VIX),
// Trend Channel 1,229 / 1,229. These unit tests pin the rules on small hand-made sessions.

const DATE = "2026-11-19"; // a Thursday
const OPEN = Date.UTC(2026, 10, 19, 3, 45) / 1000;
const at = (clock: string) => OPEN + ((Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))) - 555) * 60;
const data = (date = DATE, open = OPEN): S1Data => ({
  symbol: "NIFTY", date, sessionOpen: open, sessionClose: open + 375 * 60, status: "ready", message: "",
  previous: { date: "2026-11-18", open: 24000, high: 24050, low: 23950, close: 24000 } as S1Data["previous"], open: 24000, firstMinute: null,
});

/** A flat session at 24000 (range 10 pts a minute) with some minutes replaced. */
function session(over: Record<string, [number, number, number, number]>, open = OPEN): Candle[] {
  return Array.from({ length: 375 }, (_, i) => {
    const time = open + i * 60;
    const clock = istClock(time);
    const [o, h, l, c] = over[clock] ?? [24000, 24005, 23995, 24000];
    return { time, open: o, high: h, low: l, close: c };
  });
}

describe("rules", () => {
  it("needs 20% of the body beyond the line", () => {
    expect(bodyBreak({ time: 0, open: 100, high: 112, low: 99, close: 110 }, "CALL", 108)).toBe(2);
    expect(bodyBreak({ time: 0, open: 100, high: 112, low: 99, close: 110 }, "CALL", 109)).toBeNull(); // 1 of 10 = 10%
    expect(bodyBreak({ time: 0, open: 110, high: 111, low: 99, close: 100 }, "PUT", 102)).toBe(2);
  });

  it("confirms on the next close beyond, switches to the opposite break, cancels on a strong close back", () => {
    const bar = (minute: number, o: number, c: number): [number, Candle] => [minute, { time: minute, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c }];
    const lines = { CALL: 110, PUT: 90 };
    expect(candidateSignal(new Map([bar(1, 105, 115), bar(2, 115, 112)]), [1, 2], lines)).toMatchObject({ side: "CALL", conf: { time: 2 } });
    expect(candidateSignal(new Map([bar(1, 105, 115), bar(2, 95, 80), bar(3, 80, 78)]), [1, 2, 3], lines)).toMatchObject({ side: "PUT", brk: { time: 2 }, conf: { time: 3 } });
    expect(candidateSignal(new Map([bar(1, 105, 115), bar(2, 115, 100), bar(3, 100, 105)]), [1, 2, 3], lines)).toBeNull();
  });
});

describe("Mathi Breakout – 9:15", () => {
  it("buys on the first close beyond the 09:15 candle, 09:16–09:39", () => {
    const tape = session({ "09:15": [24000, 24010, 23990, 24005], "09:20": [24005, 24020, 24004, 24015] });
    const result = strategyEntry("breakout_0915", data(), tape);
    expect(result.entry).toMatchObject({ side: "CALL", option: "CE", time: at("09:20"), price: 24015 });
    const late = session({ "09:15": [24000, 24010, 23990, 24005], "09:40": [24005, 24020, 24004, 24015] });
    expect(strategyEntry("breakout_0915", data(), late)).toMatchObject({ entry: null, status: expect.stringContaining("09:39") });
  });
});

describe("Mathi Second Hour", () => {
  const hour2 = { "10:15": [24000, 24020, 23980, 24000] } as Record<string, [number, number, number, number]>;

  it("breaks the 10:15–11:15 high, confirms, and flips a tiny breakout", () => {
    const strong = strategyEntry("second_hour", data(), session({ ...hour2, "11:30": [24010, 24030, 24010, 24028], "11:31": [24028, 24035, 24025, 24030] }));
    expect(strong.entry).toMatchObject({ side: "CALL", option: "CE", flip: false, time: at("11:31"), level: 24020 });
    const tiny = strategyEntry("second_hour", data(), session({ ...hour2, "11:30": [24018, 24022, 24017, 24021], "11:31": [24021, 24025, 24020, 24024] }));
    expect(tiny.entry).toMatchObject({ side: "CALL", option: "PE", flip: true });
  });

  it("skips a day whose first hour is 108.8 points or more, and breakouts after 12:10", () => {
    const wide = strategyEntry("second_hour", data(), session({ ...hour2, "09:30": [24000, 24120, 24000, 24100], "11:30": [24010, 24030, 24010, 24028], "11:31": [24028, 24035, 24025, 24030] }));
    expect(wide.entry).toBeNull();
    expect(wide.status).toContain("108.8");
    const late = strategyEntry("second_hour", data(), session({ ...hour2, "12:20": [24010, 24030, 24010, 24028], "12:21": [24028, 24035, 24025, 24030] }));
    expect(late).toMatchObject({ entry: null, status: expect.stringContaining("12:10") });
  });
});

describe("Mathi 13:15 Minute", () => {
  const base = { "13:15": [24000, 24010, 23995, 24005], "13:20": [24008, 24030, 24008, 24025], "13:21": [24025, 24032, 24020, 24030] } as Record<string, [number, number, number, number]>;
  const vixAt = (value: number) => session({}).map((bar) => ({ ...bar, open: value, high: value, low: value, close: value }));

  it("trades in the day's direction with VIX above 12", () => {
    const tape = session(base);
    expect(strategyEntry("minute_1315", data(), tape, vixAt(14)).entry).toMatchObject({ side: "CALL", option: "CE", time: at("13:21") });
    expect(strategyEntry("minute_1315", data(), tape, vixAt(11.5))).toMatchObject({ entry: null, status: expect.stringContaining("VIX") });
    expect(strategyEntry("minute_1315", data(), tape, null).entry?.note).toContain("VIX not available");
  });

  it("refuses a breakout against the 09:15 open", () => {
    const tape = session({ ...base, "09:15": [24060, 24065, 24055, 24060] });
    expect(strategyEntry("minute_1315", data(), tape, vixAt(14))).toMatchObject({ entry: null, status: expect.stringContaining("day direction") });
  });
});

describe("timing and caching", () => {
  it("shows nothing before the buy (live or replay clock)", () => {
    const result = strategyEntry("breakout_0915", data(), session({ "09:15": [24000, 24010, 23990, 24005], "09:20": [24005, 24020, 24004, 24015] }));
    expect(entryAt(result, at("09:20")).entry).toBeNull();
    expect(entryAt(result, at("09:21")).entry).not.toBeNull();
    const none = strategyEntry("breakout_0915", data(), session({}));
    expect(entryAt(none, at("09:30")).status).toBe("");
    expect(entryAt(none, at("10:00")).status).toContain("No trade");
  });

  it("leaves Mathi Strategy's entries to the Algo, and computes a session once", () => {
    expect(strategyEntry("mathi", data(), session({})).entry).toBeNull();
    const day = { data: data(), tape: session({ "09:15": [24000, 24010, 23990, 24005], "09:20": [24005, 24020, 24004, 24015] }) };
    expect(sessionEntry("breakout_0915", day)).toBe(sessionEntry("breakout_0915", day));
  });
});
