import { describe, expect, it } from "vitest";
import { COLOR_FAMILIES, parseColor } from "../src/lib/color/palette";
import { appearanceKey, emptyAppearance, normalizeAppearance, presetAppearance, rememberColor, THEME_PRESETS } from "../src/lib/color/appearance";
import { levelColor, normalizeDrawing } from "../src/components/drawing-model";

describe("colour palette", () => {
  it("offers ten shades in every requested family", () => {
    expect(COLOR_FAMILIES.map((family) => family.name)).toEqual([
      "Red", "Orange", "Amber", "Yellow", "Lime", "Green", "Emerald", "Teal", "Cyan", "Sky blue",
      "Blue", "Indigo", "Violet", "Purple", "Magenta", "Pink", "Rose", "Brown", "Slate", "Gray", "Black", "White",
    ]);
    for (const family of COLOR_FAMILIES) {
      expect(family.shades).toHaveLength(10);
      for (const shade of family.shades) expect(parseColor(shade.hex).ok).toBe(true);
    }
  });

  it("accepts hex, rgb, and hsl, and rejects an invalid value", () => {
    expect(parseColor("#4C8DFF")).toEqual({ ok: true, hex: "#4C8DFF" });
    expect(parseColor("rgb(76, 141, 255)")).toEqual({ ok: true, hex: "#4C8DFF" });
    expect(parseColor("hsl(217, 100%, 65%)").ok).toBe(true);
    expect(parseColor("not-a-colour")).toMatchObject({ ok: false });
    expect(parseColor("rgb(300, 0, 0)")).toMatchObject({ ok: false });
  });
});

describe("appearance", () => {
  it("ships one dark and one light theme and moves old presets to dark", () => {
    expect(THEME_PRESETS.map((preset) => preset.mode).sort()).toEqual(["dark", "light"]);
    const migrated = normalizeAppearance({ presetId: "emerald", mode: "dark", tokens: { panel: "#171C19" } });
    expect(migrated.presetId).toBe("classic");
    expect(migrated.tokens.panel).toBe(THEME_PRESETS.find((preset) => preset.id === "classic")?.tokens.panel);
    const classic = THEME_PRESETS.find((preset) => preset.id === "classic");
    const light = THEME_PRESETS.find((preset) => preset.id === "light");
    expect(classic?.chart.bullBody).toBe("#2EBD85");
    expect(classic?.chart.bearBody).toBe("#F6465D");
    expect(light?.chart.background).toBe("#FFFFFF");
    expect(classic?.tokens.profit).not.toBe(classic?.tokens.loss);
  });

  it("saves a custom theme without changing market numbers", () => {
    const close = 2450.5;
    const base = presetAppearance("classic", emptyAppearance());
    const saved = rememberColor({ ...base, presetId: "custom", chart: { ...base.chart, bullBody: "#10B981" } }, "#4C8DFF");
    const restored = normalizeAppearance(JSON.parse(JSON.stringify(saved)));
    expect(restored.recent[0]).toBe("#4C8DFF");
    expect(restored.chart.bullBody).toBe("#10B981");
    expect(close).toBe(2450.5);
    expect(appearanceKey("student@example.com")).not.toBe(appearanceKey("admin@example.com"));
  });
});

describe("drawing colours", () => {
  it("keeps a saved drawing colour and lets one Fibonacci level differ", () => {
    const stored = { id: "d1", kind: "rect", points: [{ time: 1, price: 10 }], color: "#112233", fill: "#445566", fillOpacity: 0.25 };
    const drawing = normalizeDrawing(stored);
    expect(drawing?.color).toBe("#112233");
    expect(drawing?.fill).toBe("#445566");
    expect(drawing?.levelColors).toBeUndefined();
    expect(levelColor({ color: "#112233" }, 2)).toBe("#112233");
    expect(levelColor({ color: "#112233", levelColors: ["#AA0000", "#00AA00"] }, 1)).toBe("#00AA00");
  });
});
