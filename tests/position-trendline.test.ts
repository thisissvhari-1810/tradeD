import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editPosition, positionGeometry, positionMetrics, positionPoints, setAnchor, shiftDrawing, type Drawing } from "@/components/drawing-model";

const layer = readFileSync(join(process.cwd(), "src/components/drawing-layer.tsx"), "utf8");

// entry 100 @ t=1000, stop 95, target 110, right edge t=2000
const long: Drawing = { id: "L", kind: "long", points: positionPoints({ left: 1000, right: 2000, entry: 100, stop: 95, target: 110 }), color: "#fff", locked: false };
const short: Drawing = { ...long, id: "S", kind: "short", points: positionPoints({ left: 1000, right: 2000, entry: 100, stop: 105, target: 90 }) };

describe("long position geometry", () => {
  it("stores entry and stop at the left edge and target at the right edge", () => {
    expect(long.points).toEqual([{ time: 1000, price: 100 }, { time: 1000, price: 95 }, { time: 2000, price: 110 }]);
    expect(positionGeometry(long)).toEqual({ left: 1000, right: 2000, entry: 100, stop: 95, target: 110 });
  });

  it("reads older drawings clicked in any order with target above and stop below", () => {
    const legacy = { kind: "long", points: [{ time: 1, price: 100 }, { time: 2, price: 110 }, { time: 3, price: 95 }] };
    expect(positionGeometry(legacy)).toMatchObject({ entry: 100, stop: 95, target: 110, left: 1, right: 3 });
  });

  it("computes reward, risk and R:R from entry", () => {
    const stats = positionMetrics("long", positionGeometry(long)!);
    expect(stats.reward).toBe(10);
    expect(stats.risk).toBe(5);
    expect(stats.ratio).toBe(2);
    expect(stats.rewardPercent).toBeCloseTo(10);
  });

  it("shows no R:R when risk is not positive", () => {
    expect(positionMetrics("long", { left: 0, right: 1, entry: 100, stop: 100, target: 110 }).ratio).toBeNull();
  });
});

describe("long position handles", () => {
  it("target handle changes only the target and cannot cross entry", () => {
    expect(positionGeometry(editPosition(long, "target", { time: 5000, price: 120 }))).toEqual({ left: 1000, right: 2000, entry: 100, stop: 95, target: 120 });
    expect(positionGeometry(editPosition(long, "target", { time: 0, price: 80 }))!.target).toBeGreaterThan(100);
  });

  it("stop handle changes only the stop and stays below entry", () => {
    expect(positionGeometry(editPosition(long, "stop", { time: 0, price: 92 }))).toEqual({ left: 1000, right: 2000, entry: 100, stop: 92, target: 110 });
    expect(positionGeometry(editPosition(long, "stop", { time: 0, price: 130 }))!.stop).toBeLessThan(100);
  });

  it("entry handle moves entry and the left edge, kept between stop and target", () => {
    const moved = positionGeometry(editPosition(long, "entry", { time: 800, price: 102 }))!;
    expect(moved).toMatchObject({ left: 800, entry: 102, stop: 95, target: 110, right: 2000 });
    const clamped = positionGeometry(editPosition(long, "entry", { time: 800, price: 200 }))!;
    expect(clamped.entry).toBeLessThan(110);
  });

  it("right handle changes only the width and never passes the left edge", () => {
    expect(positionGeometry(editPosition(long, "right", { time: 3000, price: 1 }))).toEqual({ left: 1000, right: 3000, entry: 100, stop: 95, target: 110 });
    expect(positionGeometry(editPosition(long, "right", { time: 10, price: 1 }))!.right).toBeGreaterThan(1000);
  });

  it("moving the body keeps every level and the width", () => {
    const moved = positionGeometry(shiftDrawing(long, 500, 3))!;
    expect(moved).toEqual({ left: 1500, right: 2500, entry: 103, stop: 98, target: 113 });
  });

  it("does nothing to a locked drawing", () => {
    expect(editPosition({ ...long, locked: true }, "target", { time: 0, price: 150 })).toEqual({ ...long, locked: true });
  });
});

describe("short position", () => {
  it("has target below entry and stop above, with mirrored metrics", () => {
    expect(positionGeometry(short)).toMatchObject({ entry: 100, stop: 105, target: 90 });
    expect(positionMetrics("short", positionGeometry(short)!)).toMatchObject({ reward: 10, risk: 5, ratio: 2 });
  });

  it("keeps the target below and the stop above entry while editing", () => {
    expect(positionGeometry(editPosition(short, "target", { time: 0, price: 130 }))!.target).toBeLessThan(100);
    expect(positionGeometry(editPosition(short, "stop", { time: 0, price: 50 }))!.stop).toBeGreaterThan(100);
  });
});

describe("trend line endpoints", () => {
  const trend: Drawing = { id: "T", kind: "trend", points: [{ time: 100, price: 10 }, { time: 200, price: 20 }], color: "#fff", locked: false };

  it("dragging the first endpoint moves only that endpoint, to the cursor", () => {
    expect(setAnchor(trend, 0, { time: 150, price: 12 }).points).toEqual([{ time: 150, price: 12 }, { time: 200, price: 20 }]);
  });

  it("dragging the second endpoint moves only that endpoint", () => {
    expect(setAnchor(trend, 1, { time: 260, price: 25 }).points).toEqual([{ time: 100, price: 10 }, { time: 260, price: 25 }]);
  });

  it("dragging the body moves both, keeping slope and length", () => {
    expect(shiftDrawing(trend, 30, 2).points).toEqual([{ time: 130, price: 12 }, { time: 230, price: 22 }]);
  });

  it("horizontal / vertical line handles stay on their axis", () => {
    expect(setAnchor({ ...trend, kind: "hline", points: [{ time: 1, price: 5 }] }, 0, { time: 9, price: 7 }).points[0]).toEqual({ time: 1, price: 7 });
    expect(setAnchor({ ...trend, kind: "vline", points: [{ time: 1, price: 5 }] }, 0, { time: 9, price: 7 }).points[0]).toEqual({ time: 9, price: 5 });
  });

  it("locked lines do not change", () => {
    expect(setAnchor({ ...trend, locked: true }, 0, { time: 1, price: 1 }).points).toEqual(trend.points);
  });
});

describe("wiring in the drawing layer", () => {
  it("routes position handles to editPosition and anchor handles to setAnchor", () => {
    expect(layer).toContain("? editPosition(base, positionHandle, now)");
    expect(layer).toContain("? setAnchor(base, pointIndex as number, now)");
  });

  it("gives handles a larger invisible hit area above the line", () => {
    expect(layer).toContain('<circle cx={mark.x} cy={mark.y} r="10" fill="transparent" style={{ pointerEvents: "auto" }} />');
  });

  it("draws target, entry and stop handles and a width handle for positions", () => {
    expect(layer).toContain('["target", { time: geometry.left, price: geometry.target }]');
    expect(layer).toContain('["right", { time: geometry.right, price: geometry.entry }]');
  });
});

describe("trend line default colour", () => {
  it("creates new trend lines in red unless a default style was saved", () => {
    expect(layer).toContain('export const TREND_COLOR = "#F23645";');
    expect(layer).toContain('color: style?.color ?? (shape ? SHAPE_COLOR : kind === "trend" ? TREND_COLOR : "#D4AF37")');
  });
});
