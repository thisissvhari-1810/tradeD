import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { s1Checks, s1Levels, s1Reveal, translate, type S1Data } from "@/lib/trading/s1";
import { STRATEGY_PREFIX, strategyView } from "@/components/strategy-overlay";
import { STRATEGY_DEFAULTS, parseStrategySettings, setAllVisible } from "@/components/strategy-settings";

// 2026-10-22 09:15:00 IST = 03:45:00 UTC
const OPEN_0915 = Math.floor(Date.UTC(2026, 9, 22, 3, 45, 0) / 1000);
const CLOSE_1530 = Math.floor(Date.UTC(2026, 9, 22, 10, 0, 0) / 1000);
const previous = { date: "2026-10-21", open: 23493.2, high: 23656.8, low: 23346.6, close: 23581.15 };
const candle0915 = { time: OPEN_0915, open: 23610.4, high: 23640, low: 23590 };
const data: S1Data = { symbol: "NIFTY", date: "2026-10-22", sessionOpen: OPEN_0915, sessionClose: CLOSE_1530, status: "ready", message: "", previous, open: candle0915.open, firstMinute: candle0915 };

describe("strategy formulas", () => {
  const levels = s1Levels(previous, candle0915.open, candle0915)!;
  const range = previous.high - previous.low;
  const half = range / 2;

  it("box 1 = previous close +/- half range (not the candle's own midpoint)", () => {
    expect(levels.closeBox.top).toBeCloseTo(previous.close + half, 9);
    expect(levels.closeBox.bottom).toBeCloseTo(previous.close - half, 9);
    expect((levels.closeBox.top + levels.closeBox.bottom) / 2).toBeCloseTo(previous.close, 9);
    expect(levels.closeBox.top - levels.closeBox.bottom).toBeCloseTo(range, 9);
  });

  it("box 2 = the session open +/- half range, same height as box 1", () => {
    expect(levels.openBox!.top).toBeCloseTo(candle0915.open + half, 9);
    expect(levels.openBox!.bottom).toBeCloseTo(candle0915.open - half, 9);
    expect((levels.openBox!.top + levels.openBox!.bottom) / 2).toBeCloseTo(candle0915.open, 9);
    expect(levels.openBox!.top - levels.openBox!.bottom).toBeCloseTo(levels.closeBox.top - levels.closeBox.bottom, 9);
  });

  it("passes every validation check", () => {
    expect(s1Checks(levels, previous, candle0915.open, OPEN_0915)).toEqual([]);
  });

  it("rejects an opening candle that is not the 09:15 candle (e.g. 09:16)", () => {
    const at0916 = s1Levels(previous, candle0915.open, { ...candle0915, time: OPEN_0915 + 60 })!;
    expect(s1Checks(at0916, previous, candle0915.open, OPEN_0915)).toContain("The opening candle is not the 09:15 candle.");
    const view = strategyView({ ...data, firstMinute: { ...candle0915, time: OPEN_0915 + 60 } }, null, STRATEGY_DEFAULTS);
    expect(view.drawings).toEqual([]);
    expect(view.failures.length).toBeGreaterThan(0);
  });

  it("invents nothing before the open or the 09:15 candle exist", () => {
    const early = s1Levels(previous, null, null)!;
    expect(early.openBox).toBeNull();
    expect(early.openingRange).toBeNull();
  });
});

describe("replay shows only what was known", () => {
  const levels = s1Levels(previous, candle0915.open, candle0915)!;
  it("box 2 from 09:15, the 9:15 lines once that candle has closed at 09:16", () => {
    expect(s1Reveal(data, levels, OPEN_0915 - 1)).toEqual({ openBox: false, openingRange: false });
    expect(s1Reveal(data, levels, OPEN_0915 + 59)).toEqual({ openBox: true, openingRange: false });
    expect(s1Reveal(data, levels, OPEN_0915 + 60)).toEqual({ openBox: true, openingRange: true });
  });
});

describe("strategy drawings and styles", () => {
  const view = strategyView(data, null, STRATEGY_DEFAULTS);

  it("draws two boxes and the 9:15 High / Low lines with stable, prefixed ids", () => {
    expect(view.drawings.map((drawing) => drawing.id)).toEqual([
      `${STRATEGY_PREFIX}NIFTY:2026-10-22:close-box`,
      `${STRATEGY_PREFIX}NIFTY:2026-10-22:open-box`,
      `${STRATEGY_PREFIX}NIFTY:2026-10-22:high`,
      `${STRATEGY_PREFIX}NIFTY:2026-10-22:low`,
    ]);
    expect(view.drawings.every((drawing) => drawing.locked)).toBe(true);
  });

  it("uses the dark default colours and 2px lines", () => {
    const [closeBox, openBox, high, low] = view.drawings;
    expect([closeBox.color, closeBox.fill, closeBox.fillOpacity, closeBox.width]).toEqual(["#7E22CE", "#A855F7", 0.15, 2]);
    expect([openBox.color, openBox.fill, openBox.fillOpacity]).toEqual(["#C2410C", "#F97316", 0.12]);
    expect(closeBox.center).toEqual({ color: "#7E22CE", width: 2, dash: "dashed", visible: true });
    expect([high.color, high.width, high.dash, high.kind]).toEqual(["#15803D", 2, "solid", "hray"]);
    expect([low.color, low.width, low.dash]).toEqual(["#15803D", 2, "solid"]);
    expect(high.text).toBe("9:15 High 23,640.00");
    expect(high.points[0].time).toBe(OPEN_0915);
  });

  it("style changes never change a price", () => {
    const styled = strategyView(data, null, {
      ...STRATEGY_DEFAULTS,
      closeBox: { ...STRATEGY_DEFAULTS.closeBox, border: "#000000", width: 4, opacity: 0.5, dash: "dotted" },
      high: { ...STRATEGY_DEFAULTS.high, color: "#123456", width: 3, dash: "dashed", extend: "session", label: false },
    });
    expect(styled.drawings.map((drawing) => drawing.points[0].price)).toEqual(view.drawings.map((drawing) => drawing.points[0].price));
    const high = styled.drawings[2];
    expect(high.kind).toBe("trend");
    expect(high.points.map((point) => point.time)).toEqual([OPEN_0915, CLOSE_1530]);
    expect(high.text).toBeUndefined();
  });

  it("hides individual drawings and everything with Hide all", () => {
    expect(strategyView(data, null, { ...STRATEGY_DEFAULTS, low: { ...STRATEGY_DEFAULTS.low, visible: false } }).drawings).toHaveLength(3);
    expect(strategyView(data, null, setAllVisible(STRATEGY_DEFAULTS, false)).drawings).toEqual([]);
  });

  it("keeps just the midline when the box is hidden but its midline is shown", () => {
    const onlyMid = strategyView(data, null, { ...STRATEGY_DEFAULTS, closeBox: { ...STRATEGY_DEFAULTS.closeBox, visible: false } }).drawings[0];
    expect([onlyMid.borderVisible, onlyMid.fillVisible, onlyMid.center?.visible, onlyMid.text]).toEqual([false, false, true, undefined]);
  });
});

describe("strategy settings persistence", () => {
  it("fills missing or invalid values from the defaults and clamps opacity to 50%", () => {
    const parsed = parseStrategySettings(JSON.stringify({ enabled: true, closeBox: { border: "red", opacity: 0.9, width: 7 }, high: { color: "#000000", extend: "session" } }));
    expect(parsed.enabled).toBe(true);
    expect(parsed.closeBox.border).toBe("#7E22CE");
    expect(parsed.closeBox.opacity).toBe(0.5);
    expect(parsed.closeBox.width).toBe(2);
    expect(parsed.high).toMatchObject({ color: "#000000", extend: "session", width: 2 });
  });

  it("carries over the old S1 on / off", () => {
    expect(parseStrategySettings(null, true).enabled).toBe(true);
    expect(parseStrategySettings(null).enabled).toBe(false);
  });
});

describe("wiring", () => {
  const desk = readFileSync(join(process.cwd(), "src/components/chart-desk.tsx"), "utf8");
  const server = readFileSync(join(process.cwd(), "src/server/market.ts"), "utf8");
  const dhan = readFileSync(join(process.cwd(), "src/server/dhan-market.ts"), "utf8");

  it("the button is Strategy (not S1) with the tooltip, and opens the panel", () => {
    expect(desk).toContain('title="Automatic Trading Strategy"');
    expect(desk).toMatch(/>\s*Strategy\s*\{strategyOn/);
    expect(desk).not.toMatch(/>\s*S1\s*\{/);
    expect(desk).toContain("<StrategyPanel");
  });

  it("selects the candle stamped exactly 09:15 and never substitutes another", () => {
    expect(server).toContain("const opening = tape.find((bar) => bar.time === session.open) ?? null;");
    expect(server).toContain("no other candle is substituted");
  });

  it("requests the minutes from before the session so 09:15 is not the range edge", () => {
    expect(dhan).toContain('return await intradayHistory(id, "1", new Date((open - 3 * 86_400) * 1000), to, segment, kind);');
  });

  it("strategy drawings stay separate from manual drawings", () => {
    expect(desk).toContain("overlays={strategyOverlay}");
  });
});

describe("choosing the previous and current day", () => {
  const desk = readFileSync(join(process.cwd(), "src/components/chart-desk.tsx"), "utf8");
  const panel = readFileSync(join(process.cwd(), "src/components/strategy-panel.tsx"), "utf8");
  const server = readFileSync(join(process.cwd(), "src/server/market.ts"), "utf8");
  const route = readFileSync(join(process.cwd(), "src/app/api/market/s1/route.ts"), "utf8");

  it("the panel has Current day and Previous day pickers, each with Auto", () => {
    expect(panel).toContain('label="Current day"');
    expect(panel).toContain('label="Previous day"');
    expect(panel).toMatch(/>\s*Auto\s*<\/button>/);
    expect(panel).toContain('onClick={() => onChange("")}');
  });

  it("the chosen days are sent to the server and keyed so data never mixes", () => {
    expect(desk).toContain("previous ? `&previous=${encodeURIComponent(previous)}` : \"\"");
    expect(desk).toContain('`${symbol}|${s1Session}|${strategyDates.previous || "auto"}`');
    expect(route).toContain('url.searchParams.get("previous")');
  });

  it("a chosen previous day must be before the current day and must have traded", () => {
    expect(server).toContain("if (previousDate != null && previousDate >= day)");
    expect(server).toContain("(bar: Candle) => istDay(bar.time) === previousDate");
    expect(server).toContain("weekend, holiday or not returned");
  });

  it("the replay clock only limits the replayed session", () => {
    expect(desk).toContain("replay.active && s1Current.data.date === replay.date ? (replay.cursor ?? 0) : null");
  });
});

describe("the manual-drawing workflow (illustrative numbers)", () => {
  // Previous H 22,900 L 22,800 C 22,870; today open 22,910.
  const prev = { date: "2026-10-21", open: 22850, high: 22900, low: 22800, close: 22870 };
  const levels = s1Levels(prev, 22910, null)!;

  it("step 1: the original box is the previous candle, high to low", () => {
    expect(levels.rawBox).toEqual({ top: 22900, bottom: 22800, mid: 22850 });
    expect(levels.range).toBe(100);
  });

  it("step 2: moved +20 so its midpoint is the close, height 100", () => {
    expect(levels.shift1).toBe(20);
    expect(levels.closeBox).toEqual({ top: 22920, bottom: 22820, mid: 22870 });
  });

  it("step 3: the moved box is cloned and moved +40 so its midpoint is the open, height 100", () => {
    expect(levels.shift2).toBe(40);
    expect(levels.openBox).toEqual({ top: 22960, bottom: 22860, mid: 22910 });
  });

  it("translate keeps the height", () => {
    expect(translate({ top: 10, bottom: 4, mid: 7 }, -3)).toEqual({ top: 7, bottom: 1, mid: 4 });
  });
});

describe("box placement matches the manual drawing", () => {
  const DAY = 86_400;
  const anchors = { before: 1_792_454_400, previous: 1_792_454_400 + DAY, day: 1_792_454_400 + 2 * DAY, after: 1_792_454_400 + 3 * DAY };
  const withAnchors: S1Data = { ...data, anchors };

  it("box A spans the session before the previous day to today; clone B keeps the same horizontal coordinates", () => {
    const [closeBox, openBox] = strategyView(withAnchors, null, STRATEGY_DEFAULTS).drawings;
    expect(closeBox.points.map((point) => point.time)).toEqual([anchors.before, anchors.day]);
    expect(openBox.points.map((point) => point.time)).toEqual([anchors.before, anchors.day]);
  });

  it("optionally moves clone B one session right as well", () => {
    const [, openBox] = strategyView(withAnchors, null, { ...STRATEGY_DEFAULTS, cloneShift: "session" }).drawings;
    expect(openBox.points.map((point) => point.time)).toEqual([anchors.previous, anchors.after]);
  });

  it("can instead span today's session only", () => {
    const [closeBox] = strategyView(withAnchors, null, { ...STRATEGY_DEFAULTS, boxSpan: "session" }).drawings;
    expect(closeBox.points.map((point) => point.time)).toEqual([OPEN_0915, CLOSE_1530]);
  });

  it("the drawn boxes carry the translated prices exactly", () => {
    const [closeBox, openBox] = strategyView(withAnchors, null, STRATEGY_DEFAULTS).drawings;
    const levels = s1Levels(previous, candle0915.open, candle0915)!;
    expect(closeBox.points[0].price).toBeCloseTo(levels.closeBox.top, 6);
    expect(closeBox.points[1].price).toBeCloseTo(levels.closeBox.bottom, 6);
    expect(openBox.points[0].price).toBeCloseTo(levels.openBox!.top, 6);
    expect(openBox.points[1].price).toBeCloseTo(levels.openBox!.bottom, 6);
  });

  it("the server anchors boxes on the provider's daily-bar stamps", () => {
    const server = readFileSync(join(process.cwd(), "src/server/market.ts"), "utf8");
    expect(server).toContain("const offset = previousBar ? previousBar.time - midnight(previous.date) : 0;");
    expect(server).toContain("before: beforeBar ? beforeBar.time : previousTime - (dayTime - previousTime),");
  });
});

describe("boxes made with the drawing tool's own move and clone", () => {
  const prev = { date: "2026-10-21", open: 22850, high: 22900, low: 22800, close: 22870 };
  const example: S1Data = { ...data, previous: prev, open: 22910, firstMinute: { ...candle0915, open: 22910 } };
  const view = strategyView(example, null, STRATEGY_DEFAULTS);

  it("traces every step: original 22,800-22,900, +20 to box A, clone at 22,870, +40 to box B", () => {
    const trace = view.trace!;
    expect(trace.original).toMatchObject({ top: 22900, bottom: 22800, mid: 22850, height: 100 });
    expect(trace.shiftA).toBe(20);
    expect(trace.boxA).toMatchObject({ top: 22920, bottom: 22820, mid: 22870, height: 100 });
    expect(trace.cloneMidBefore).toBe(22870);
    expect(trace.shiftB).toBe(40);
    expect(trace.boxB).toMatchObject({ top: 22960, bottom: 22860, mid: 22910, height: 100 });
  });

  it("draws exactly two strategy rectangles (never the unmoved original) with stable ids", () => {
    expect(view.trace!.rectangles).toBe(2);
    expect(view.drawings.filter((drawing) => drawing.kind === "rect").map((drawing) => drawing.id)).toEqual([
      `${STRATEGY_PREFIX}NIFTY:2026-10-22:close-box`,
      `${STRATEGY_PREFIX}NIFTY:2026-10-22:open-box`,
    ]);
    // Re-rendering gives the same two, not more.
    expect(strategyView(example, null, STRATEGY_DEFAULTS).drawings.map((drawing) => drawing.id)).toEqual(view.drawings.map((drawing) => drawing.id));
  });

  it("uses shiftDrawing (the drag-to-move operation) for both moves", () => {
    const overlay = readFileSync(join(process.cwd(), "src/components/strategy-overlay.ts"), "utf8");
    expect(overlay).toContain("const movedA = shiftDrawing(original, 0, shiftA);");
    expect(overlay).toContain("{ ...movedA, id: `${tag}:open-box` }");
    expect(overlay).toContain("shiftDrawing(clone, cloneDt, shiftB)");
  });
});

describe("open from the daily candle, lifecycle log, manual rectangles", () => {
  const server = readFileSync(join(process.cwd(), "src/server/market.ts"), "utf8");
  const desk = readFileSync(join(process.cwd(), "src/components/chart-desk.tsx"), "utf8");
  const panel = readFileSync(join(process.cwd(), "src/components/strategy-panel.tsx"), "utf8");

  it("takes today's open from the day's daily candle when published, else the 09:15 candle", () => {
    expect(server).toContain("dhanPriorDaily(name, stored, dayOpen + 86_400)");
    expect(server).toContain("const openPrice = session.ok && dayBar ? dayBar.open : first ? first.open : null;");
  });

  it("logs the reconciliation (created / updated / retained / removed) under one prefix", () => {
    expect(desk).toContain("[TradeD Strategy] Rectangle A");
    expect(desk).toContain("[TradeD Strategy] Rectangle B");
    expect(desk).toContain("[TradeD Strategy] lifecycle");
    expect(desk).toContain('before.get(id) === after.get(id) ? "retained" : "updated"');
  });

  it("tells the user when the chart also has their own rectangles", () => {
    expect(desk).toContain('manualRectangles={drawings.filter((drawing) => drawing.kind === "rect" || drawing.kind === "rrect").length}');
    expect(panel).toContain("not part of the Strategy (which draws only boxes A and B)");
  });
});

describe("latest session before the open; matching 9:15 colours", () => {
  const server = readFileSync(join(process.cwd(), "src/server/market.ts"), "utf8");

  it("before today's open (or with no session today) the automatic day is the latest traded session", () => {
    expect(server).toContain("if (date == null && previous && (!session.ok || now < session.open + 60)");
    expect(server).toContain("const latest = await getS1Data(symbol, previous.date, previousDate);");
  });

  it("the low line defaults to the high line's solid green, and the old saved red is upgraded", () => {
    expect(STRATEGY_DEFAULTS.low.color).toBe(STRATEGY_DEFAULTS.high.color);
    expect(STRATEGY_DEFAULTS.low.dash).toBe("solid");
    expect(parseStrategySettings(JSON.stringify({ low: { color: "#B91C1C", width: 3 } })).low).toMatchObject({ color: "#15803D", width: 3 });
    expect(parseStrategySettings(JSON.stringify({ low: { color: "#123456" } })).low.color).toBe("#123456");
  });
});

describe("chart side panel", () => {
  const desk = readFileSync(join(process.cwd(), "src/components/chart-desk.tsx"), "utf8");
  it("starts closed on the chart (open on the Positions page) and a Watchlist button toggles it", () => {
    expect(desk).toContain('const [railCollapsed, setRailCollapsed] = useState(variant !== "positions");');
    expect(desk).toContain('aria-label="Watchlist"');
    expect(desk).toContain('${railCollapsed ? "hidden" : sideRail === "positions"');
  });
});
