import { describe, expect, it } from "vitest";
import { aggregateCount, aggregateMinutes, applyLiveTick, mergeLiveHistory, sessionBucket } from "@/lib/market/spans";

const bar = { time: 1_700_000_040, open: 100, high: 102, low: 99, close: 101, volume: 10 };

describe("live candle updates", () => {
  it("moves the open minute up and down with the last price", () => {
    const up = applyLiveTick([bar], "1m", 104, bar.time + 20, true);
    expect(up[0]).toMatchObject({ open: 100, high: 104, low: 99, close: 104, time: bar.time });
    const down = applyLiveTick(up, "1m", 98, bar.time + 40, true);
    expect(down[0]).toMatchObject({ open: 100, high: 104, low: 98, close: 98 });
  });

  it("opens the next minute and leaves the closed minute unchanged", () => {
    const next = applyLiveTick([bar], "1m", 103, bar.time + 60, true);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(bar);
    expect(next[1]).toMatchObject({ time: bar.time + 60, open: 103, close: 103 });
  });

  it("builds a 2-hour bar from two 1-hour bars on the same day", () => {
    const hour = 3600;
    const first = { time: 1_700_000_000, open: 10, high: 12, low: 9, close: 11, volume: 3 };
    const second = { time: first.time + hour, open: 11, high: 15, low: 10, close: 14, volume: 4 };
    const third = { time: first.time + hour * 2, open: 14, high: 16, low: 13, close: 15, volume: 1 };
    const grouped = aggregateCount([first, second, third], 2);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ time: first.time, open: 10, high: 15, low: 9, close: 14, volume: 7 });
    expect(grouped[1]).toMatchObject({ time: third.time, open: 14, close: 15, volume: 1 });
  });

  it("keeps a 30-minute bar on the same grid as the loaded history", () => {
    const start = bar.time - (bar.time % 1800) + 900;
    const halfHour = { ...bar, time: start };
    const moved = applyLiveTick([halfHour], "30m", 107, start + 600, true);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ time: start, close: 107, high: 107 });
  });

  it("updates today's daily, weekly, and monthly bar and opens a new day", () => {
    const today = Math.floor(Date.parse("2026-10-14T04:06:00Z") / 1000);
    const yesterdayOpen = Math.floor(Date.parse("2026-10-13T03:45:00Z") / 1000);
    const daily = { time: yesterdayOpen, open: 80, high: 82, low: 79, close: 81, volume: 5 };
    const opened = applyLiveTick([daily], "1d", 84, today, true);
    expect(opened).toHaveLength(2);
    expect(opened[0]).toEqual(daily);
    expect(opened[1].close).toBe(84);
    const todayBar = { ...daily, time: opened[1].time, close: 84, high: 84, low: 84, open: 84 };
    const moved = applyLiveTick([todayBar], "1y", 86, today + 60, true);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ time: todayBar.time, close: 86, high: 86 });
    const week = applyLiveTick([todayBar], "1w", 87, today + 120, true);
    expect(week[0].close).toBe(87);
    const month = applyLiveTick([todayBar], "1mo", 88, today + 180, true);
    expect(month[0].close).toBe(88);
  });

  it("adds only the new traded quantity and ignores an older print for the close", () => {
    const priced = applyLiveTick([bar], "1m", 104, bar.time + 20, true, 25, 0);
    expect(priced[0]).toMatchObject({ open: 100, high: 104, close: 104, volume: 35 });
    const same = applyLiveTick(priced, "1m", 104, bar.time + 25, true, 0, bar.time + 20);
    expect(same[0].volume).toBe(35);
    const older = applyLiveTick(priced, "1m", 90, bar.time + 5, true, 40, bar.time + 20);
    expect(older[0]).toMatchObject({ close: 104, low: 90, volume: 35 });
    const previous = applyLiveTick(priced, "1m", 80, bar.time - 120, true, 10, bar.time + 20);
    expect(previous).toBe(priced);
  });

  it("builds 30-minute candles from the 09:15 session open", () => {
    const open = Math.floor(Date.parse("2026-10-16T03:45:00Z") / 1000);
    const barAt = (offset: number, close: number) => ({ time: open + offset, open: close, high: close, low: close, close, volume: 1 });
    expect(sessionBucket(open + 20 * 60, 1800)).toBe(open);
    expect(sessionBucket(open + 29 * 60, 1800)).toBe(open);
    expect(sessionBucket(open + 30 * 60, 1800)).toBe(open + 30 * 60);
    const grouped = aggregateMinutes([barAt(0, 10), barAt(15 * 60, 12), barAt(30 * 60, 11)], 30);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ time: open, open: 10, high: 12, low: 10, close: 12, volume: 2 });
    expect(grouped[1]).toMatchObject({ time: open + 30 * 60, open: 11, close: 11, volume: 1 });
    const three = aggregateMinutes([barAt(0, 1), barAt(60, 2), barAt(120, 3), barAt(180, 4)], 3);
    expect(three[0].time).toBe(open);
    expect(three[1].time).toBe(open + 180);
  });

  it("joins a history refresh to the forming candle without a duplicate timestamp", () => {
    const history = [bar, { time: bar.time + 60, open: 101, high: 103, low: 100, close: 102, volume: 4 }];
    const live = [bar, { time: bar.time + 60, open: 101, high: 106, low: 100, close: 105, volume: 7 }, { time: bar.time + 120, open: 105, high: 105, low: 105, close: 105, volume: 1 }];
    const merged = mergeLiveHistory(live, history);
    expect(merged.map((item) => item.time)).toEqual([bar.time, bar.time + 60, bar.time + 120]);
    expect(merged[1]).toMatchObject({ open: 101, high: 106, low: 100, close: 105, volume: 7 });
    const caughtUp = mergeLiveHistory(
      [{ ...history[1], close: 102 }],
      [{ ...history[1], close: 104, high: 104, volume: 8 }],
    );
    expect(caughtUp[0]).toMatchObject({ close: 104, high: 104, volume: 8 });
  });

  it("does not invent an evening candle after the session", () => {
    const evening = [bar];
    expect(applyLiveTick(evening, "1m", 110, bar.time + 7 * 3600, true)).toBe(evening);
    const closed = [bar];
    expect(applyLiveTick(closed, "1m", 110, bar.time + 10, false)).toBe(closed);
  });
});
