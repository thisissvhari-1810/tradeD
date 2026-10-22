import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { centreOn, s1Levels, s1Reveal, type S1Data } from "@/lib/trading/s1";
import { S1_PREFIX, s1Drawings } from "@/components/s1-overlay";
import { positionGeometry } from "@/components/drawing-model";

// Previous session: H 23656.80 L 23346.60 C 23581.15. Today: open 23610.40, first minute H 23640 L 23590.
const previous = { date: "2026-10-21", open: 23493.2, high: 23656.8, low: 23346.6, close: 23581.15 };
const firstMinute = { time: 1_792_640_700, open: 23610.4, high: 23640, low: 23590 };
const data: S1Data = {
  symbol: "NIFTY",
  date: "2026-10-22",
  sessionOpen: 1_792_640_700,
  sessionClose: 1_792_663_200,
  status: "ready",
  message: "",
  previous,
  open: firstMinute.open,
  firstMinute,
};

describe("S1 calculations", () => {
  const levels = s1Levels(previous, firstMinute.open, firstMinute)!;

  it("step 1: the box is the previous session's full range", () => {
    expect(levels.rawBox).toEqual({ top: 23656.8, bottom: 23346.6, mid: (23656.8 + 23346.6) / 2 });
    expect(levels.range).toBeCloseTo(310.2, 6);
  });

  it("step 2: moved so its midpoint is the previous close, height unchanged", () => {
    expect(levels.closeBox.mid).toBe(23581.15);
    expect((levels.closeBox.top + levels.closeBox.bottom) / 2).toBeCloseTo(23581.15, 6);
    expect(levels.closeBox.top - levels.closeBox.bottom).toBeCloseTo(levels.range, 6);
  });

  it("step 3: the clone's midpoint is the open, same height", () => {
    expect(levels.openBox!.mid).toBe(23610.4);
    expect((levels.openBox!.top + levels.openBox!.bottom) / 2).toBeCloseTo(23610.4, 6);
    expect(levels.openBox!.top - levels.openBox!.bottom).toBeCloseTo(levels.range, 6);
  });

  it("step 4: opening-range lines are the first minute's high and low", () => {
    expect(levels.openingRange).toEqual({ time: firstMinute.time, high: 23640, low: 23590 });
  });

  it("does not invent the open or first minute when they are not known", () => {
    const early = s1Levels(previous, null, null)!;
    expect(early.closeBox.mid).toBe(23581.15);
    expect(early.openBox).toBeNull();
    expect(early.openingRange).toBeNull();
  });

  it("draws nothing without a valid previous session", () => {
    expect(s1Levels(null, 1, null)).toBeNull();
    expect(s1Levels({ ...previous, high: 1, low: 5 }, null, null)).toBeNull();
  });

  it("centreOn keeps the height", () => {
    expect(centreOn({ top: 110, bottom: 90, mid: 100 }, 50)).toEqual({ top: 60, bottom: 40, mid: 50 });
  });
});

describe("S1 in replay: nothing before it could be known", () => {
  const levels = s1Levels(previous, firstMinute.open, firstMinute)!;

  it("before 09:15 only the previous-close box shows", () => {
    expect(s1Reveal(data, levels, data.sessionOpen - 1)).toEqual({ openBox: false, openingRange: false });
  });

  it("from 09:15 the open box shows; the lines wait until the first minute has finished", () => {
    expect(s1Reveal(data, levels, data.sessionOpen)).toEqual({ openBox: true, openingRange: false });
    expect(s1Reveal(data, levels, firstMinute.time + 60)).toEqual({ openBox: true, openingRange: true });
  });

  it("live (no cursor) shows everything that exists", () => {
    expect(s1Reveal(data, levels, null)).toEqual({ openBox: true, openingRange: true });
  });
});

describe("S1 drawings", () => {
  const drawings = s1Drawings(data, null);

  it("creates two boxes and two lines, all locked, with s1 ids for this symbol and session", () => {
    expect(drawings.map((drawing) => drawing.kind)).toEqual(["rect", "rect", "hray", "hray"]);
    expect(drawings.every((drawing) => drawing.locked && drawing.id.startsWith(`${S1_PREFIX}NIFTY:2026-10-22:`))).toBe(true);
    expect(new Set(drawings.map((drawing) => drawing.id)).size).toBe(4);
  });

  it("boxes span the session and their midlines sit on the close / open", () => {
    const [closeBox, openBox] = drawings;
    expect(closeBox.points.map((point) => point.time)).toEqual([data.sessionOpen, data.sessionClose]);
    expect((closeBox.points[0].price + closeBox.points[1].price) / 2).toBeCloseTo(23581.15, 6);
    expect((openBox.points[0].price + openBox.points[1].price) / 2).toBeCloseTo(23610.4, 6);
    expect(closeBox.center?.visible).toBe(true);
  });

  it("lines start at the first minute and run right", () => {
    const [, , high, low] = drawings;
    expect(high.points).toEqual([{ time: firstMinute.time, price: 23640 }]);
    expect(low.points).toEqual([{ time: firstMinute.time, price: 23590 }]);
  });

  it("is the same set every time (toggling cannot duplicate)", () => {
    expect(s1Drawings(data, null).map((drawing) => drawing.id)).toEqual(drawings.map((drawing) => drawing.id));
  });

  it("is unrelated to position drawings", () => {
    expect(positionGeometry({ kind: "rect", points: [] })).toBeNull();
  });
});

describe("S1 wiring", () => {
  const desk = readFileSync(join(process.cwd(), "src/components/chart-desk.tsx"), "utf8");
  const layer = readFileSync(join(process.cwd(), "src/components/drawing-layer.tsx"), "utf8");
  const server = readFileSync(join(process.cwd(), "src/server/market.ts"), "utf8");

  it("has the S1 toggle with its tooltip, remembered on / off", () => {
    expect(desk).toContain("S1 — Automatic Previous-Day and Opening-Range Strategy");
    expect(desk).toContain('localStorage.setItem("td-s1", next ? "1" : "0")');
  });

  it("passes S1 as read-only overlays, separate from saved manual drawings", () => {
    expect(desk).toContain("overlays={s1Overlay}");
    expect(layer).toContain("const show = [...drawingsRef.current, ...overlaysRef.current];");
    expect(layer).toContain("const passive = mark.id.startsWith(S1_PREFIX);");
  });

  it("uses the replay clock in replay and the live session otherwise", () => {
    expect(desk).toContain("replay.active ? (replay.cursor ?? 0) : null");
    expect(desk).toContain('session === "live" ? "" : `&date=${encodeURIComponent(session)}`');
  });

  it("server uses the previous completed session and only a finished first minute", () => {
    expect(server).toContain("normalizeTape(daily.filter((bar) => istDay(bar.time) < day))");
    expect(server).toContain("if (tape[0] && tape[0].time + 60 <= now) first = tape[0];");
  });
});
