import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/market/demo";
import {
  advanceCursor,
  clockLabel,
  cursorFromClock,
  describeSession,
  previousSession,
  previousSessionFromMinutes,
  selectPreviousSession,
  previousWeekday,
  projectReplay,
  replayProgress,
  revealMinutes,
  replayFillPrice,
  simulatedBar,
  stepCursor,
} from "@/lib/trading/replay-engine";

function ist(day: number, hour: number, minute = 0): number {
  return Math.floor(Date.UTC(2026, 9, day, hour - 5, minute - 30) / 1000);
}

function bar(day: number, hour: number, minute: number, open: number, high: number, low: number, close: number): Candle {
  return { time: ist(day, hour, minute), open, high, low, close, volume: 100 };
}

const tape = [
  bar(15, 9, 15, 100, 110, 90, 105),
  bar(15, 9, 16, 105, 120, 100, 115),
  bar(15, 9, 20, 115, 130, 112, 125),
];

describe("historical replay", () => {
  it("rejects a weekend and does not treat it as another session", () => {
    const saturday = describeSession("2026-10-17", [], "2026-10-16");
    expect(saturday.ok).toBe(false);
    if (saturday.ok) return;
    expect(saturday.reason).toBe("weekend");
    expect(saturday.message).toMatch(/Saturday/);
    const holiday = describeSession("2026-10-15", ["2026-10-15"], "2026-10-16");
    expect(holiday.ok).toBe(false);
  });

  it("hides the rest of a minute and every later minute", () => {
    const open = revealMinutes(tape, ist(15, 9, 15));
    expect(open).toEqual([{ time: ist(15, 9, 15), open: 100, high: 100, low: 100, close: 100, volume: 0 }]);
    const next = revealMinutes(tape, ist(15, 9, 16));
    expect(next[0]).toMatchObject({ high: 110, low: 90, close: 105, volume: 100 });
    expect(next[1]).toMatchObject({ high: 105, low: 105, close: 105, volume: 0 });
    expect(next).toHaveLength(2);
    expect(JSON.stringify(next)).not.toContain("120");
  });

  it("keeps the same replay time when the timeframe changes and does not reveal a later high", () => {
    const cursor = ist(15, 9, 16);
    const one = projectReplay(tape, [], "1m", cursor, "2026-10-15");
    const five = projectReplay(tape, [], "5m", cursor, "2026-10-15");
    expect(one.map((item) => item.high)).toEqual([110, 105]);
    expect(five).toHaveLength(1);
    expect(five[0]?.high).toBe(110);
    expect(five[0]?.high).not.toBe(120);
    const hour = projectReplay(tape, [], "1h", cursor, "2026-10-15");
    expect(hour[0]?.high).toBe(110);
  });

  it("builds the daily candle from revealed minutes and keeps earlier days", () => {
    const prior = [bar(14, 15, 30, 80, 88, 79, 86)];
    const daily = projectReplay(tape, prior, "1d", ist(15, 9, 15), "2026-10-15");
    expect(daily).toHaveLength(2);
    expect(daily[1]).toMatchObject({ open: 100, high: 100, low: 100, close: 100, volume: 0 });
    const done = projectReplay(tape, prior, "1d", ist(15, 9, 17), "2026-10-15");
    expect(done[1]).toMatchObject({ open: 100, high: 120, low: 90, close: 115 });
    expect(done[1]?.volume).toBe(200);
  });

  it("plays, pauses by leaving the cursor, steps, and completes at the session end", () => {
    const open = ist(15, 9, 15);
    const close = ist(15, 15, 30);
    const played = advanceCursor(open, open, close, 1000, 1);
    expect(played.cursor).toBe(open + 60);
    expect(played.completed).toBe(false);
    const paused = played.cursor;
    const resumed = advanceCursor(paused, open, close, 500, 2);
    expect(resumed.cursor).toBe(paused + 60);
    expect(stepCursor(open, open, close, -1)).toBe(open);
    expect(stepCursor(close - 30, open, close, 1)).toBe(close);
    const finished = advanceCursor(close - 10, open, close, 1000, 10);
    expect(finished).toEqual({ cursor: close, completed: true });
    expect(replayProgress(open, open, close)).toBe(0);
    expect(replayProgress(close, open, close)).toBe(1);
  });

  it("jumps the replay clock to an IST time inside the session", () => {
    const session = describeSession("2026-10-16", [], "2026-10-16");
    if (!session.ok) throw new Error("session");
    expect(clockLabel(session.open)).toBe("09:15");
    expect(clockLabel(session.close)).toBe("15:30");
    expect(cursorFromClock("2026-10-16", "10:30", session.open, session.close)).toBe(session.open + 75 * 60);
    expect(cursorFromClock("2026-10-16", "08:00", session.open, session.close)).toBe(session.open);
    expect(cursorFromClock("2026-10-16", "18:00", session.open, session.close)).toBe(session.close);
  });

  it("chooses the previous weekday without moving the clock onto a weekend", () => {
    expect(previousWeekday(new Date(Date.UTC(2026, 9, 16, 6, 0, 0)))).toBe("2026-10-15");
    expect(previousWeekday(new Date(Date.UTC(2026, 9, 19, 6, 0, 0)))).toBe("2026-10-16");
  });

  it("uses the last traded session before a Monday or a holiday, not the calendar day before", () => {
    const sessions = [
      bar(15, 15, 30, 70, 74, 69, 73),
      bar(16, 15, 30, 80, 88, 79, 86),
      bar(19, 15, 30, 90, 96, 89, 94),
    ];
    expect(previousSession(sessions, "2026-10-19")).toEqual({ date: "2026-10-16", open: 80, high: 88, low: 79, close: 86 });
    expect(previousSession(sessions, "2026-10-21")).toEqual({ date: "2026-10-19", open: 90, high: 96, low: 89, close: 94 });
    expect(previousSession([], "2026-10-19")).toBeNull();
  });

  it("keeps earlier sessions on the chart and hides the selected session's future prices", () => {
    const context = [
      bar(14, 15, 20, 70, 75, 68, 72),
      bar(15, 9, 10, 50, 999, 40, 80),
    ];
    const cursor = ist(15, 9, 16);
    const one = projectReplay(tape, [], "1m", cursor, "2026-10-15", context);
    expect(one[0]).toMatchObject({ time: ist(14, 15, 20), open: 70, high: 75, close: 72 });
    expect(one.map((item) => item.time)).not.toContain(ist(15, 9, 10));
    expect(one.at(-1)).toMatchObject({ open: 105, high: 105, low: 105, close: 105, volume: 0 });
    expect(one.some((item) => item.high === 120 || item.high === 130 || item.high === 999)).toBe(false);
    const five = projectReplay(tape, [], "5m", cursor, "2026-10-15", context);
    expect(five[0]?.high).toBe(75);
    expect(five.at(-1)?.high).toBe(110);
    expect(five.at(-1)?.high).not.toBe(120);
    const daily = projectReplay(tape, [bar(14, 15, 30, 70, 75, 68, 72)], "1d", cursor, "2026-10-15", context);
    expect(daily[0]).toMatchObject({ open: 70, close: 72 });
    expect(daily.at(-1)).toMatchObject({ open: 100, high: 110, close: 105 });
    expect(simulatedBar(tape, cursor)?.close).toBe(105);
    expect(simulatedBar(tape, cursor)?.close).not.toBe(72);
  });

  it("shows 15 October on the daily chart when that session exists only in the minute history", () => {
    const oct16 = [bar(16, 9, 15, 200, 210, 190, 205)];
    const context = [bar(15, 9, 15, 100, 140, 90, 130), bar(15, 15, 29, 130, 150, 120, 145)];
    const prior = [bar(14, 15, 30, 80, 88, 79, 86)];
    const daily = projectReplay(oct16, prior, "1d", ist(16, 9, 15), "2026-10-16", context);
    expect(daily).toHaveLength(3);
    expect(daily[1]).toMatchObject({ time: ist(15, 9, 15), open: 100, high: 150, low: 90, close: 145 });
    expect(daily[2]).toMatchObject({ open: 200, high: 200, low: 200, close: 200, volume: 0 });
    expect(selectPreviousSession(prior, context, "2026-10-16")).toEqual({ date: "2026-10-15", open: 100, high: 150, low: 90, close: 145 });
  });

  it("prices a replay fill from revealed data only", () => {
    const forming = ist(15, 9, 15) + 30;
    expect(replayFillPrice(tape, forming)).toBe(100);
    expect(replayFillPrice(tape, ist(15, 9, 16))).toBe(105);
    expect(replayFillPrice(tape, ist(15, 9, 14))).toBeNull();
    expect(replayFillPrice(tape, ist(15, 9, 20) + 30)).not.toBe(125);
    expect(replayFillPrice(tape, ist(15, 9, 20) + 30)).toBe(115);
  });

  it("folds the previous session from completed minutes when no daily bar exists", () => {
    const context = [bar(16, 9, 15, 80, 81, 79, 80), bar(16, 15, 29, 85, 88, 84, 86)];
    expect(previousSessionFromMinutes(context, "2026-10-19")).toEqual({ date: "2026-10-16", open: 80, high: 88, low: 79, close: 86 });
  });
});
