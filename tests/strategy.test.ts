import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { s1Checks, s1Levels, s1Reveal, type S1Data } from "@/lib/trading/s1";
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
    expect([low.color, low.width]).toEqual(["#B91C1C", 2]);
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
    expect(dhan).toContain('return intradayHistory(id, "1", new Date((open - 3 * 86_400) * 1000), to, segment, kind);');
  });

  it("strategy drawings stay separate from manual drawings", () => {
    expect(desk).toContain("overlays={strategyOverlay}");
  });
});
