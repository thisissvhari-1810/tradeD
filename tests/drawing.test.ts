import { describe, expect, it } from "vitest";
import { barsBetween, fibLevels, fibTimes, measureAllowsChartWheel, measureGestureDown, measureGestureFinish, measureGestureMove, measureLines, measureStats, measureTone, normalizeDrawing, overRightPriceScale, parseStoredDrawings, placeMeasureCard, pointsNeeded, positionStats, screenAngle, shiftDrawing, zoomPriceRange, FIB_RATIOS, type Drawing } from "@/components/drawing-model";

describe("drawing calculations", () => {
  it("places fibonacci retracement prices from the two anchors", () => {
    const levels = fibLevels(100, 200);
    expect(levels.map((level) => level.ratio)).toEqual([...FIB_RATIOS]);
    expect(levels.find((level) => level.ratio === 0.5)?.price).toBe(150);
    expect(levels.find((level) => level.ratio === 0.618)?.price).toBeCloseTo(161.8);
  });

  it("spaces fibonacci time zones by the anchor span", () => {
    const zones = fibTimes(1_000, 2_000);
    expect(zones.find((zone) => zone.ratio === 2)?.time).toBe(3_000);
    expect(zones.find((zone) => zone.ratio === 5)?.time).toBe(6_000);
  });

  it("calculates long and short risk against reward from prices", () => {
    const stats = positionStats(100, 90, 130);
    expect(stats.risk).toBe(10);
    expect(stats.reward).toBe(30);
    expect(stats.ratio).toBe(3);
    expect(stats.riskPercent).toBe(10);
    expect(stats.rewardPercent).toBe(30);
  });

  it("measures a date and price range in points and percent", () => {
    const stats = measureStats({ time: 0, price: 22400 }, { time: 86_400, price: 22600 }, 2);
    expect(stats.change).toBeCloseTo(200);
    expect(stats.percent).toBeCloseTo(0.89, 1);
    expect(stats.up).toBe(true);
    expect(stats.bars).toBe(2);
  });

  it("measures price change, percent, bars, and direction", () => {
    const stats = measureStats({ time: 0, price: 100 }, { time: 3600, price: 110 }, 4);
    expect(stats.change).toBe(10);
    expect(stats.percent).toBe(10);
    expect(stats.bars).toBe(4);
    expect(stats.seconds).toBe(3600);
    expect(stats.up).toBe(true);
  });

  it("reads a screen angle from pixel movement", () => {
    expect(screenAngle(10, 0)).toBeCloseTo(0);
    expect(screenAngle(0, -10)).toBeCloseTo(90);
  });

  it("rejects a saved drawing that has no anchors", () => {
    expect(normalizeDrawing({ id: "a", kind: "trend", points: [] })).toBeNull();
    expect(normalizeDrawing({ id: "a", kind: "trend", points: [{ time: 1, price: 2 }], color: "#fff" })?.kind).toBe("trend");
  });

  it("asks for three clicks on a position and one click on a horizontal line", () => {
    expect(pointsNeeded("long")).toBe(3);
    expect(pointsNeeded("hline")).toBe(1);
    expect(pointsNeeded("trend")).toBe(2);
    expect(pointsNeeded("price")).toBe(1);
    expect(pointsNeeded("range")).toBe(2);
  });

  it("keeps a locked drawing where it is", () => {
    const drawing: Drawing = { id: "a", kind: "trend", points: [{ time: 1, price: 10 }], color: "#fff", locked: true };
    expect(shiftDrawing(drawing, 5, 5).points[0]).toEqual({ time: 1, price: 10 });
  });

  it("restores versioned drawings and drops malformed rows", () => {
    const raw = JSON.stringify({
      v: 1,
      drawings: [
        { id: "ok", kind: "hline", points: [{ time: 10, price: 50 }], color: "#D4AF37", locked: false },
        { id: "bad", kind: "trend", points: [] },
        { nope: true },
      ],
    });
    const loaded = parseStoredDrawings(raw);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].kind).toBe("hline");
    expect(loaded[0].points[0].price).toBe(50);
    expect(parseStoredDrawings("not json")).toEqual([]);
    expect(parseStoredDrawings(JSON.stringify([{ id: "old", kind: "trend", points: [{ time: 1, price: 2 }] }]))).toHaveLength(1);
  });

  it("widens the price scale on scroll down and narrows it on scroll up", () => {
    const wider = zoomPriceRange(100, 200, 100);
    const tighter = zoomPriceRange(100, 200, -100);
    expect(wider.to - wider.from).toBeGreaterThan(100);
    expect(tighter.to - tighter.from).toBeLessThan(100);
    expect((wider.from + wider.to) / 2).toBeCloseTo(150);
    expect(overRightPriceScale(950, 1000, 64)).toBe(true);
    expect(overRightPriceScale(800, 1000, 64)).toBe(false);
  });

  it("labels a bullish date and price range from the two prices", () => {
    const stats = measureStats({ time: 0, price: 22400 }, { time: 86_400, price: 22600 }, 1, 0.05);
    const lines = measureLines(stats);
    expect(lines).toContain("Start Price: 22,400");
    expect(lines).toContain("End Price: 22,600");
    expect(lines).toContain("Price Change: +200 points");
    expect(lines).toContain("Percentage Change: +0.89%");
    expect(lines).toContain("Ticks: +4000");
    expect(lines).toContain("Bars: 1");
    expect(lines).toContain("Time: 1d");
    expect(lines).toContain("Direction: Bullish");
    expect(measureTone(stats.up)).toBe("#089981");
  });

  it("labels a bearish range with a negative change", () => {
    const stats = measureStats({ time: 0, price: 100 }, { time: 3600, price: 90 }, 4);
    expect(stats.change).toBe(-10);
    expect(stats.percent).toBe(-10);
    expect(stats.direction).toBe("Bearish");
    expect(measureLines(stats)).toContain("Price Change: -10 points");
    expect(measureLines(stats)).toContain("Percentage Change: -10.00%");
    expect(measureTone(stats.up)).toBe("#F23645");
  });

  it("counts bars from candle timestamps and from the timeframe beyond the last candle", () => {
    const times = [0, 86_400, 172_800];
    expect(barsBetween(0, 172_800, 86_400, times)).toBe(2);
    expect(barsBetween(172_800, 172_800 + 86_400 * 3, 86_400, times)).toBe(3);
    expect(barsBetween(0, 0, 86_400, times)).toBe(0);
  });

  it("creates a measurement from a drag and ignores a click that does not move", () => {
    const start = { time: 10, price: 22400 };
    const idle = measureGestureDown(start);
    expect(measureGestureFinish(idle)).toBeNull();
    const dragged = measureGestureMove(idle, { time: 20, price: 22600 });
    expect(measureGestureFinish(dragged)).toEqual([start, { time: 20, price: 22600 }]);
    expect(measureGestureFinish(null)).toBeNull();
    expect(measureAllowsChartWheel(false)).toBe(true);
    expect(measureAllowsChartWheel(true)).toBe(false);
  });

  it("keeps the measurement label inside the chart", () => {
    const card = placeMeasureCard({ x: 900, y: 340, width: 80, height: 40 }, { width: 220, height: 110 }, { width: 1000, height: 400 });
    expect(card.x + card.width).toBeLessThanOrEqual(992);
    expect(card.y + card.height).toBeLessThanOrEqual(392);
    expect(card.x).toBeGreaterThanOrEqual(8);
    expect(card.y).toBeGreaterThanOrEqual(8);
  });

  it("moves and resizes a saved measurement without changing its kind", () => {
    const drawing: Drawing = { id: "m1", kind: "range", points: [{ time: 10, price: 22400 }, { time: 20, price: 22600 }], color: "#089981", locked: false };
    const moved = shiftDrawing(drawing, 5, 10);
    expect(moved.kind).toBe("range");
    expect(moved.points).toEqual([{ time: 15, price: 22410 }, { time: 25, price: 22610 }]);
    const resized = shiftDrawing(drawing, 0, -50, 1);
    expect(resized.points[0]).toEqual(drawing.points[0]);
    expect(resized.points[1].price).toBe(22550);
    const remaining = [drawing, { ...drawing, id: "t1", kind: "trend" as const }].filter((item) => item.id !== "m1");
    expect(remaining.map((item) => item.id)).toEqual(["t1"]);
  });
});
