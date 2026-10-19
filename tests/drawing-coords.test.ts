import { describe, expect, it } from "vitest";
import { logicalToTime, screenXToTime, timeToLogical, timeToScreenX, type TimeBar } from "@/components/chart-coords";
import { centerPrice, centerSegment, resizeBox, shiftDrawing, type Drawing } from "@/components/drawing-model";

const DAYS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];

function session(day: string, step: number): TimeBar[] {
  const open = Math.floor(Date.parse(`${day}T03:45:00Z`) / 1000);
  const bars: TimeBar[] = [];
  for (let offset = 0; offset <= (6 * 60 + 15) * 60; offset += step) bars.push({ time: open + offset });
  return bars;
}

function series(step: number) {
  return DAYS.flatMap((day) => session(day, step));
}

const daily = DAYS.map((day) => ({ time: Math.floor(Date.parse(`${day}T03:45:00Z`) / 1000) }));
const minute = series(60);
const five = series(300);
const fifteen = series(900);
const hour = series(3600);
const frames = [minute, five, fifteen, hour, daily];

const rectanglePoints = [
  { time: daily[1].time, price: 25450.5 },
  { time: daily[3].time, price: 24800 },
];
const linePrices = [25450.5, 25000, 24800.25];

function rectangle(): Drawing {
  return {
    id: "rect-1",
    kind: "rect",
    points: rectanglePoints.map((point) => ({ ...point })),
    color: "#F48FB1",
    locked: false,
    center: { color: "#F23645", width: 1, dash: "dashed", visible: true },
  };
}

describe("drawing coordinates across timeframes", () => {
  it("keeps a 1D rectangle's timestamps and prices through every timeframe and back", () => {
    const drawing = rectangle();
    const original = drawing.points.map((point) => ({ ...point }));
    for (const bars of [minute, five, fifteen, hour, daily]) {
      for (const point of drawing.points) {
        const logical = timeToLogical(bars, point.time);
        expect(logical).not.toBeNull();
        expect(logicalToTime(bars, logical as number)).toBe(point.time);
        timeToScreenX((index) => index * 8, bars, point.time);
      }
    }
    expect(drawing.points).toEqual(original);
  });

  it("keeps every horizontal line on its original price", () => {
    const lines = linePrices.map((price, index) => ({ time: daily[index].time, price }));
    const saved = lines.map((point) => ({ ...point }));
    for (const bars of frames) {
      for (const line of lines) {
        const logical = timeToLogical(bars, line.time);
        expect(logicalToTime(bars, logical as number)).toBe(line.time);
        expect(line.price).toBe(saved.find((item) => item.time === line.time)?.price);
      }
    }
    expect(lines).toEqual(saved);
  });

  it("does not drift when 1D and 1m are switched 20 times", () => {
    const drawing = rectangle();
    const original = JSON.stringify(drawing.points);
    for (let turn = 0; turn < 20; turn += 1) {
      const bars = turn % 2 === 0 ? minute : daily;
      for (const point of drawing.points) {
        const logical = timeToLogical(bars, point.time);
        expect(logicalToTime(bars, logical as number)).toBe(point.time);
      }
    }
    expect(JSON.stringify(drawing.points)).toBe(original);
  });

  it("saves an intentional move or resize and then keeps that update", () => {
    const moved = shiftDrawing(rectangle(), 86_400, 12.5);
    expect(moved.points[0]).toEqual({ time: rectanglePoints[0].time + 86_400, price: rectanglePoints[0].price + 12.5 });
    expect(moved.points[1]).toEqual({ time: rectanglePoints[1].time + 86_400, price: rectanglePoints[1].price + 12.5 });
    const resized = resizeBox(moved, "ne", { time: daily[4].time, price: 26000 });
    expect(resized.points).toEqual([
      { time: moved.points[0].time, price: 26000 },
      { time: daily[4].time, price: moved.points[1].price },
    ]);
    for (const bars of [minute, daily]) {
      for (const point of resized.points) expect(logicalToTime(bars, timeToLogical(bars, point.time) as number)).toBe(point.time);
    }
    expect(centerPrice(resized.points[0].price, resized.points[1].price)).toBe((26000 + moved.points[1].price) / 2);
    expect(centerSegment(resized.points)?.[0].price).toBe(centerPrice(resized.points[0].price, resized.points[1].price));
  });

  it("keeps anchors when the candle series is replaced", () => {
    const drawing = rectangle();
    const before = drawing.points.map((point) => ({ ...point }));
    const refreshed = series(60);
    for (const point of drawing.points) expect(logicalToTime(refreshed, timeToLogical(refreshed, point.time) as number)).toBe(point.time);
    expect(drawing.points).toEqual(before);
  });

  it("follows zoom, scroll, and resize on screen without changing the saved time", () => {
    const time = daily[2].time;
    const resting = timeToScreenX((index) => index * 10, daily, time);
    const zoomed = timeToScreenX((index) => index * 4 + 80, daily, time);
    expect(resting).toBe(20);
    expect(zoomed).toBe(88);
    expect(zoomed).not.toBe(resting);
    expect(logicalToTime(daily, timeToLogical(daily, time) as number)).toBe(time);
    const between = daily[2].time + 45 * 60;
    const logical = timeToLogical(hour, between);
    expect(logical).not.toBeNull();
    expect(logical as number).not.toBe(Math.round(logical as number));
    expect(logicalToTime(hour, logical as number)).toBe(between);
    const pixel = timeToScreenX((index) => index * 12, hour, between) as number;
    expect(screenXToTime((x) => x / 12, hour, pixel)).toBe(between);
  });

  it("does not move an existing anchor when a live candle is appended", () => {
    const anchor = minute[120].time;
    const before = timeToLogical(minute, anchor);
    const live = [...minute, { time: minute[minute.length - 1].time + 60 }];
    expect(timeToLogical(live, anchor)).toBe(before);
    expect(logicalToTime(live, before as number)).toBe(anchor);
  });
});
