import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { duplicateDrawing, fibLevelSet, normalizeDrawing, normalizeLevels, shiftDrawing, FIB_RATIOS, type Drawing } from "@/components/drawing-model";
import { DEFAULT_PREFS, parsePrefs } from "@/components/drawing-prefs";

const layer = readFileSync(join(process.cwd(), "src/components/drawing-layer.tsx"), "utf8");
const desk = readFileSync(join(process.cwd(), "src/components/chart-desk.tsx"), "utf8");

const fib: Drawing = { id: "f1", kind: "fib", points: [{ time: 100, price: 100 }, { time: 200, price: 200 }], color: "#D4AF37", locked: false };

describe("stay in drawing mode", () => {
  it("is off by default, so the cursor returns after each drawing", () => {
    expect(DEFAULT_PREFS.stay).toBe(false);
    expect(parsePrefs(null).stay).toBe(false);
  });

  it("ignores stay: true written by the old default", () => {
    expect(parsePrefs(JSON.stringify({ stay: true, magnet: "weak" })).stay).toBe(false);
    expect(parsePrefs(JSON.stringify({ stay: true, magnet: "weak" })).magnet).toBe("weak");
  });

  it("keeps stay on when the user chose it", () => {
    expect(parsePrefs(JSON.stringify({ stay: true, stayVersion: 2 })).stay).toBe(true);
    expect(parsePrefs(JSON.stringify({ stay: false, stayVersion: 2 })).stay).toBe(false);
  });
});

describe("existing drawings take priority over new ones", () => {
  it("keeps drawings hit-testable while a drawing tool is active", () => {
    expect(layer).toContain("const interactive = enabled;");
  });

  it("grabs an existing drawing (select + move) instead of starting a new one", () => {
    expect(layer).toContain("grabbed.current = true;");
    expect(layer).toContain('onToolRef.current("cursor");');
    expect(layer).toMatch(/if \(grabbed\.current\) \{\s+grabbed\.current = false;\s+return;\s+\}/);
  });

  it("lets a press through when a new drawing is half finished", () => {
    expect(layer).toContain("if (drawingTool && (draftRef.current.length > 0 || shapeDrag.current || brushing.current || measureDrag.current)) return;");
  });
});

describe("editable fibonacci levels", () => {
  it("defaults include 0.786 and every level is visible", () => {
    expect([...FIB_RATIOS]).toContain(0.786);
    expect(fibLevelSet(fib).every((level) => level.visible)).toBe(true);
    expect(fibLevelSet({ ...fib, kind: "fibext" }).map((level) => level.ratio)).toContain(1.618);
  });

  it("uses the drawing's own levels when set", () => {
    const levels = [{ ratio: 0.5, visible: true }, { ratio: 0.65, visible: false }];
    expect(fibLevelSet({ ...fib, levels })).toEqual(levels);
  });

  it("cleans stored levels and keeps them through save and load", () => {
    expect(normalizeLevels([{ ratio: 99, visible: true }, { ratio: "x" }, { ratio: 0.5 }])).toEqual([{ ratio: 10, visible: true }, { ratio: 0.5, visible: true }]);
    expect(normalizeLevels([])).toBeUndefined();
    const restored = normalizeDrawing(JSON.parse(JSON.stringify({ ...fib, levels: [{ ratio: 0.382, visible: false }] })));
    expect(restored?.levels).toEqual([{ ratio: 0.382, visible: false }]);
  });
});

describe("keyboard editing", () => {
  it("duplicates into a new, unlocked drawing with a new id", () => {
    const copy = duplicateDrawing({ ...fib, locked: true }, "f2");
    expect(copy.id).toBe("f2");
    expect(copy.locked).toBe(false);
    expect(copy.points).toHaveLength(2);
  });

  it("nudges a drawing by whole anchors in time and price", () => {
    const moved = shiftDrawing(fib, 60, 5);
    expect(moved.points.map((point) => point.time)).toEqual([160, 260]);
    expect(moved.points.map((point) => point.price)).toEqual([105, 205]);
  });

  it("wires duplicate, lock, nudge, undo and redo, and skips text fields", () => {
    expect(layer).toContain('event.key.toLowerCase() === "d"');
    expect(layer).toContain('event.key.toLowerCase() === "l"');
    expect(layer).toContain('event.key.startsWith("Arrow")');
    expect(layer).toContain("target.isContentEditable");
    expect(desk).toContain("historyKeys.current.undo()");
    expect(desk).toContain("historyKeys.current.redo()");
  });
});

describe("drawing settings dialog", () => {
  const editor = readFileSync(join(process.cwd(), "src/components/drawing-editor.tsx"), "utf8");

  it("takes clicks even though the drawing overlay ignores the pointer", () => {
    expect(layer).toContain('style={{ pointerEvents: capturing ? "auto" : "none"');
    expect(editor).toMatch(/fixed inset-0 z-50[^>]*style=\{\{ pointerEvents: "auto" \}\}/);
  });

  it("creates TradingView-like shapes: purple, 80% transparent fill, dashed middle line", () => {
    expect(layer).toContain('export const SHAPE_COLOR = "#9C27B0";');
    expect(layer).toContain("export const SHAPE_FILL_OPACITY = 0.2;");
    expect(layer).toContain("{ ...RECTANGLE_CENTER, color: SHAPE_COLOR, visible: true }");
  });
});

describe("colour panels open beside the drawing", () => {
  const bar = readFileSync(join(process.cwd(), "src/components/drawing-edit-bar.tsx"), "utf8");

  it("passes the drawing's outline to the style bar", () => {
    expect(layer).toContain("box={shapeBox(handles)}");
  });

  it("opens right of the shape, else left, else under the bar", () => {
    expect(bar).toContain("host.clientWidth - box.right >= room ? box.right + PANEL_GAP : box.left >= room ? box.left - PANEL_GAP - PANEL_WIDTH : null");
    expect(bar).toContain('<Pop flip={flip} beside={beside}>');
  });
});

describe("engine fixes from the tool audit", () => {
  it("lets a horizontal ray move in time, but keeps a horizontal line price-only", async () => {
    const { shiftDrawing } = await import("@/components/drawing-model");
    const base = { id: "h", points: [{ time: 100, price: 50 }], color: "#fff", locked: false };
    expect(shiftDrawing({ ...base, kind: "hray" }, 60, 5).points[0]).toEqual({ time: 160, price: 55 });
    expect(shiftDrawing({ ...base, kind: "hline" }, 60, 5).points[0]).toEqual({ time: 100, price: 55 });
  });

  it("measures a fib extension from the third anchor by the first leg", async () => {
    const { fibExtensionPrice, pointsNeeded } = await import("@/components/drawing-model");
    expect(pointsNeeded("fibext")).toBe(3);
    const points = [{ time: 1, price: 100 }, { time: 2, price: 150 }, { time: 3, price: 120 }];
    expect(fibExtensionPrice(points, 1)).toBe(170);
    expect(fibExtensionPrice(points, 0.618)).toBeCloseTo(150.9);
    expect(fibExtensionPrice(points.slice(0, 2), 1)).toBe(150);
  });

  it("puts long / short stop and target on the right side whatever the click order", async () => {
    const { positionLevels } = await import("@/components/drawing-model");
    expect(positionLevels("long", 100, 110, 95)).toEqual({ stop: 95, target: 110 });
    expect(positionLevels("short", 100, 95, 110)).toEqual({ stop: 110, target: 95 });
  });

  it("drops the duplicate vertex a double-click adds", async () => {
    const { dedupePoints } = await import("@/components/drawing-model");
    expect(dedupePoints([{ time: 1, price: 1 }, { time: 2, price: 2 }, { time: 2, price: 2 }])).toHaveLength(2);
  });

  it("draws brush strokes live, extends rays to the edge, and does not let full-width lines steal a press", () => {
    expect(layer).toContain('if ((active === "brush" || active === "highlighter") && draft.length > 1)');
    expect(layer).toContain("function toEdge(");
    expect(layer).toContain("FULL_SPAN_KINDS.has(drawing.kind) && hash < 0");
    expect(layer).toContain("stay = false,");
  });

  it("keeps locked drawings when clearing, and in the settings dialog", () => {
    expect(layer).toContain("onDrawingsRef.current(current.filter((drawing) => drawing.locked), true);");
    expect(layer).toContain("isLocked(item) && next.locked === item.locked && next.hidden === item.hidden");
  });

  it("stores option-contract drawings under the contract and batches saves", () => {
    expect(desk).toContain("const drawingStore = optionView ?");
    expect(desk).toContain("saveTimer.current = window.setTimeout(flushDrawings, 300);");
    expect(desk).not.toContain("saveDrawings(symbol,");
  });
});
