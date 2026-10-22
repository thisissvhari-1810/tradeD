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
  /** none: box B keeps box A's horizontal coordinates (only moved vertically). session: also one session right. */
  cloneShift: "none" | "session";
  closeBox: StrategyBox;
  openBox: StrategyBox;
  high: StrategyLevel;
  low: StrategyLevel;
};

const KEY = "td-strategy";

export const STRATEGY_DEFAULTS: StrategySettings = {
  enabled: false,
  boxSpan: "candles",
  cloneShift: "none",
  closeBox: { border: "#7E22CE", fill: "#A855F7", width: 2, opacity: 0.15, dash: "solid", visible: true, mid: { color: "#7E22CE", width: 2, dash: "dashed", visible: true } },
  openBox: { border: "#C2410C", fill: "#F97316", width: 2, opacity: 0.12, dash: "solid", visible: true, mid: { color: "#C2410C", width: 2, dash: "dashed", visible: true } },
  high: { color: "#15803D", width: 2, dash: "solid", visible: true, label: true, extend: "right" },
  // Same solid dark green as the high line.
  low: { color: "#15803D", width: 2, dash: "solid", visible: true, label: true, extend: "right" },
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

function box(value: unknown, fallback: StrategyBox): StrategyBox {
  const row = (value && typeof value === "object" ? value : {}) as Partial<StrategyBox>;
  const opacity = typeof row.opacity === "number" && Number.isFinite(row.opacity) ? Math.min(0.5, Math.max(0, row.opacity)) : fallback.opacity;
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

/** Reads saved settings, filling anything missing or invalid from the defaults. */
export function parseStrategySettings(raw: string | null, legacyOn = false): StrategySettings {
  let row: Partial<StrategySettings> = {};
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    if (parsed && typeof parsed === "object") row = parsed as Partial<StrategySettings>;
  } catch {
    row = {};
  }
  return {
    enabled: flag(row.enabled, legacyOn),
    boxSpan: row.boxSpan === "session" ? "session" : "candles",
    cloneShift: row.cloneShift === "session" ? "session" : "none",
    closeBox: box(row.closeBox, STRATEGY_DEFAULTS.closeBox),
    openBox: box(row.openBox, STRATEGY_DEFAULTS.openBox),
    high: level(row.high, STRATEGY_DEFAULTS.high),
    // The low line's old default red becomes the new default green; a colour the user chose stays.
    low: level(row.low && typeof row.low === "object" && (row.low as Partial<StrategyLevel>).color?.toUpperCase() === "#B91C1C" ? { ...row.low, color: STRATEGY_DEFAULTS.low.color } : row.low, STRATEGY_DEFAULTS.low),
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
    localStorage.setItem(KEY, JSON.stringify(settings));
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
