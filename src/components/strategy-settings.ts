import type { LineDash } from "@/components/drawing-model";

/** Style of one line: colour, thickness, pattern and visibility. */
export type StrategyLine = { color: string; width: 1 | 2 | 3 | 4; dash: LineDash; visible: boolean };
/** A strategy box and its midpoint line. */
export type StrategyBox = { border: string; fill: string; width: 1 | 2 | 3 | 4; opacity: number; dash: LineDash; visible: boolean; mid: StrategyLine };
/** A 9:15 high / low line. */
export type StrategyLevel = StrategyLine & { label: boolean; extend: "session" | "right" };

export type StrategySettings = {
  enabled: boolean;
  /** candles: box 1 from the session before the previous day to today, box 2 one session right (like the manual drawing). session: today 09:15-15:30. */
  boxSpan: "candles" | "session";
  /** none: box B keeps box A's horizontal coordinates (only moved vertically). session: also one session right, over today's candles. */
  cloneShift: "none" | "session";
  /**
   * Breadth of the previous-day box, in daily bars either side of the previous day's candle (1 = from the
   * session before it to today, as drawn by hand). Box B is a clone, so it always has the same breadth.
   */
  boxBreadth: 1 | 1.5 | 2;
  closeBox: StrategyBox;
  openBox: StrategyBox;
  high: StrategyLevel;
  low: StrategyLevel;
};

const KEY = "td-strategy";
/**
 * Saved-settings version, for one-time resets of saved values (later choices are kept):
 *   2: both boxes' fill became fully transparent (opacity 0).
 *   3: the 9:15 low line uses the same dark green as the high line (#15803D).
 *   4: every border and line is 1px (box borders, midlines, 9:15 high and low).
 *   5: the previous-day box is wider (1.5 bars either side) and its clone B sits over today's candles.
 */
const VERSION = 5;

export const STRATEGY_DEFAULTS: StrategySettings = {
  enabled: false,
  boxSpan: "candles",
  // The clone (box B) is placed over today's candles, one session right of box A.
  cloneShift: "session",
  boxBreadth: 1.5,
  // Transparent boxes: only the borders, midlines and labels show; candles stay fully visible inside.
  closeBox: { border: "#7E22CE", fill: "#A855F7", width: 1, opacity: 0, dash: "solid", visible: true, mid: { color: "#7E22CE", width: 1, dash: "dashed", visible: true } },
  openBox: { border: "#C2410C", fill: "#F97316", width: 1, opacity: 0, dash: "solid", visible: true, mid: { color: "#C2410C", width: 1, dash: "dashed", visible: true } },
  high: { color: "#15803D", width: 1, dash: "solid", visible: true, label: true, extend: "right" },
  // Same solid dark green as the high line.
  low: { color: "#15803D", width: 1, dash: "solid", visible: true, label: true, extend: "right" },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

function color(value: unknown, fallback: string) {
  return typeof value === "string" && HEX.test(value) ? value : fallback;
}
function width(value: unknown, fallback: StrategyLine["width"]): StrategyLine["width"] {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : fallback;
}
function dash(value: unknown, fallback: LineDash): LineDash {
  return value === "solid" || value === "dashed" || value === "dotted" ? value : fallback;
}
function flag(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function line(value: unknown, fallback: StrategyLine): StrategyLine {
  const row = (value && typeof value === "object" ? value : {}) as Partial<StrategyLine>;
  return { color: color(row.color, fallback.color), width: width(row.width, fallback.width), dash: dash(row.dash, fallback.dash), visible: flag(row.visible, fallback.visible) };
}

function box(value: unknown, fallback: StrategyBox, current: boolean): StrategyBox {
  const row = (value && typeof value === "object" ? value : {}) as Partial<StrategyBox>;
  // Settings from before version 2 lose their fill (the boxes became transparent); later ones keep it.
  const opacity = current && typeof row.opacity === "number" && Number.isFinite(row.opacity) ? Math.min(0.5, Math.max(0, row.opacity)) : fallback.opacity;
  return {
    border: color(row.border, fallback.border),
    fill: color(row.fill, fallback.fill),
    width: width(row.width, fallback.width),
    opacity,
    dash: dash(row.dash, fallback.dash),
    visible: flag(row.visible, fallback.visible),
    mid: line(row.mid, fallback.mid),
  };
}

function level(value: unknown, fallback: StrategyLevel): StrategyLevel {
  const row = (value && typeof value === "object" ? value : {}) as Partial<StrategyLevel>;
  return { ...line(row, fallback), label: flag(row.label, fallback.label), extend: row.extend === "session" || row.extend === "right" ? row.extend : fallback.extend };
}

/** With `thin`, sets a box's border and midline (or a line) to 1px. */
function slim<T extends StrategyLine | StrategyBox>(value: T, thin: boolean): T {
  if (!thin) return value;
  return "mid" in value ? { ...value, width: 1, mid: { ...value.mid, width: 1 } } : { ...value, width: 1 };
}

/** Reads saved settings, filling anything missing or invalid from the defaults. */
export function parseStrategySettings(raw: string | null, legacyOn = false): StrategySettings {
  let row: Partial<StrategySettings> & { version?: unknown } = {};
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    if (parsed && typeof parsed === "object") row = parsed as Partial<StrategySettings> & { version?: unknown };
  } catch {
    row = {};
  }
  const version = typeof row.version === "number" ? row.version : 1;
  const current = version >= 2;
  // Before version 4 widths were saved at 2px: every border and line becomes 1px once.
  const thin = version < 4;
  // Before version 3 the low line could be saved in another colour: it becomes the high line's green.
  const low = version < 3 && row.low && typeof row.low === "object" ? { ...row.low, color: STRATEGY_DEFAULTS.low.color } : row.low;
  return {
    enabled: flag(row.enabled, legacyOn),
    boxSpan: row.boxSpan === "session" ? "session" : "candles",
    // Before version 5, box B sat over the previous day with box A; it moves to today once.
    cloneShift: version < 5 ? "session" : row.cloneShift === "none" ? "none" : "session",
    boxBreadth: version < 5 ? STRATEGY_DEFAULTS.boxBreadth : row.boxBreadth === 1 || row.boxBreadth === 1.5 || row.boxBreadth === 2 ? row.boxBreadth : STRATEGY_DEFAULTS.boxBreadth,
    closeBox: slim(box(row.closeBox, STRATEGY_DEFAULTS.closeBox, current), thin),
    openBox: slim(box(row.openBox, STRATEGY_DEFAULTS.openBox, current), thin),
    high: slim(level(row.high, STRATEGY_DEFAULTS.high), thin),
    // The low line's old default red becomes the new default green; a colour the user chose stays.
    low: slim(level(low, STRATEGY_DEFAULTS.low), thin),
  };
}

export function loadStrategySettings(): StrategySettings {
  try {
    // The earlier S1 button stored only on / off.
    return parseStrategySettings(localStorage.getItem(KEY), localStorage.getItem("td-s1") === "1");
  } catch {
    return STRATEGY_DEFAULTS;
  }
}

export function saveStrategySettings(settings: StrategySettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...settings, version: VERSION }));
  } catch {
    // Storage unavailable: settings last for this page only.
  }
}

/** Shows or hides every strategy drawing (boxes, midlines and both lines) without touching styles. */
export function setAllVisible(settings: StrategySettings, visible: boolean): StrategySettings {
  return {
    ...settings,
    closeBox: { ...settings.closeBox, visible, mid: { ...settings.closeBox.mid, visible } },
    openBox: { ...settings.openBox, visible, mid: { ...settings.openBox.mid, visible } },
    high: { ...settings.high, visible },
    low: { ...settings.low, visible },
  };
}
