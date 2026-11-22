/**
 * Line Strategy Draw: saved, named sets of horizontal price levels drawn on the chart.
 *
 * This module is pure (no React, no database): the config shape and its validation (shared by the API and the
 * panel), the level catalogue, and buildLineOverlays(), which turns the saved drawings plus one session's market
 * data into read-only chart drawings. It never changes how the Strategy (S1) computes anything: the previous-day
 * and opening-range values and the Strategy box levels come from the same S1Data / s1Levels the Strategy uses.
 *
 * Every chart object it makes has an id `lines:<drawingId>:<lineId>`, so:
 *  - the chart draws it read-only and never saves it with the user's own drawings (like `strategy:` overlays);
 *  - the same id is produced on every render, so enabling, disabling or editing one drawing changes only its own
 *    objects and nothing accumulates.
 */
import type { Drawing, DrawingTextStyle, LineDash } from "@/components/drawing-model";
import { CHART_SPANS, type ChartSpan } from "@/lib/market/spans";
import { s1Levels, s1Reveal, type S1Data } from "@/lib/trading/s1";

export const LINES_PREFIX = "lines:";
export const MAX_LINE_DRAWINGS = 50;
export const MAX_LINES_PER_DRAWING = 24;

export type LevelKind =
  | "pdh" | "pdl" | "pdc" | "pdm"
  | "open"
  | "or_high" | "or_low"
  | "boxA_top" | "boxA_mid" | "boxA_bottom"
  | "boxB_top" | "boxB_mid" | "boxB_bottom"
  | "custom";

export type LineExtend = "right" | "session" | "full";

export type LevelLine = {
  /** Stable id within its drawing (part of the chart object id). */
  id: string;
  kind: LevelKind;
  name: string;
  /** Only for kind "custom". */
  price?: number;
  visible: boolean;
  color: string;
  width: 1 | 2 | 3 | 4;
  dash: LineDash;
  /** Show the price in the line's label. */
  showPrice: boolean;
  /** Show the level's name in the line's label. */
  showName: boolean;
  extend: LineExtend;
};

export type LineDrawingConfig = { lines: LevelLine[] };

/** A saved drawing as the API returns it. `symbol` "*" = every symbol; `timeframe` "all" = every timeframe. */
export type LineDrawing = {
  id: string;
  name: string;
  symbol: string;
  timeframe: ChartSpan | "all";
  enabled: boolean;
  config: LineDrawingConfig;
  createdAt: string;
  updatedAt: string;
};

export const LEVELS: Record<LevelKind, { label: string; group: string; needs: "none" | "previous" | "open" | "opening" | "boxA" | "boxB" }> = {
  pdh: { label: "Previous day high", group: "Previous day", needs: "previous" },
  pdl: { label: "Previous day low", group: "Previous day", needs: "previous" },
  pdc: { label: "Previous day close", group: "Previous day", needs: "previous" },
  pdm: { label: "Previous day midpoint", group: "Previous day", needs: "previous" },
  open: { label: "Today's open", group: "Today", needs: "open" },
  or_high: { label: "09:15 candle high", group: "Today", needs: "opening" },
  or_low: { label: "09:15 candle low", group: "Today", needs: "opening" },
  boxA_top: { label: "Strategy box A top", group: "Strategy (S1)", needs: "boxA" },
  boxA_mid: { label: "Strategy box A mid (prev close)", group: "Strategy (S1)", needs: "boxA" },
  boxA_bottom: { label: "Strategy box A bottom", group: "Strategy (S1)", needs: "boxA" },
  boxB_top: { label: "Strategy box B top", group: "Strategy (S1)", needs: "boxB" },
  boxB_mid: { label: "Strategy box B mid (open)", group: "Strategy (S1)", needs: "boxB" },
  boxB_bottom: { label: "Strategy box B bottom", group: "Strategy (S1)", needs: "boxB" },
  custom: { label: "Custom price", group: "Custom", needs: "none" },
};
export const LEVEL_KINDS = Object.keys(LEVELS) as LevelKind[];

const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLORS: Record<LevelKind, string> = {
  pdh: "#089981", pdl: "#F23645", pdc: "#2962FF", pdm: "#787B86", open: "#F0B90B", or_high: "#15803D", or_low: "#15803D",
  boxA_top: "#7E22CE", boxA_mid: "#7E22CE", boxA_bottom: "#7E22CE", boxB_top: "#C2410C", boxB_mid: "#C2410C", boxB_bottom: "#C2410C", custom: "#D4AF37",
};
const SHORT_NAMES: Record<LevelKind, string> = {
  pdh: "PDH", pdl: "PDL", pdc: "PDC", pdm: "PD Mid", open: "Open", or_high: "9:15 High", or_low: "9:15 Low",
  boxA_top: "A Top", boxA_mid: "A Mid", boxA_bottom: "A Bottom", boxB_top: "B Top", boxB_mid: "B Mid", boxB_bottom: "B Bottom", custom: "Level",
};

let seq = 0;
export function newLineId() {
  seq = (seq + 1) % 1_000_000;
  return `l${Date.now().toString(36)}${seq.toString(36)}`;
}

/** A new line of a kind with that kind's default name, colour and style. */
export function newLine(kind: LevelKind, price?: number): LevelLine {
  return {
    id: newLineId(), kind, name: SHORT_NAMES[kind], ...(kind === "custom" ? { price: price ?? 0 } : {}), visible: true,
    color: DEFAULT_COLORS[kind], width: 1, dash: kind === "pdm" || kind.endsWith("_mid") ? "dashed" : "solid", showPrice: true, showName: true,
    extend: kind === "custom" ? "full" : "right",
  };
}

/** Starting points for a new drawing (configuration presets, not data). */
export const TEMPLATES: Array<{ id: string; name: string; kinds: LevelKind[] }> = [
  { id: "blank", name: "Custom Strategy Lines", kinds: [] },
  { id: "previous", name: "Previous Day Levels", kinds: ["pdh", "pdl", "pdc", "pdm"] },
  { id: "opening", name: "Opening Levels", kinds: ["open", "or_high", "or_low"] },
  { id: "mathi", name: "Mathi Strategy Lines", kinds: ["boxA_top", "boxA_mid", "boxA_bottom", "boxB_top", "boxB_mid", "boxB_bottom", "or_high", "or_low"] },
];

function cleanLine(value: unknown, index: number, seen: Set<string>): LevelLine | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<LevelLine>;
  const kind = LEVEL_KINDS.includes(row.kind as LevelKind) ? (row.kind as LevelKind) : null;
  if (!kind) return null;
  let id = typeof row.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(row.id) ? row.id : `l${index}`;
  while (seen.has(id)) id = `${id}_${index}`;
  seen.add(id);
  const price = kind === "custom" ? Number(row.price) : undefined;
  if (kind === "custom" && !(Number.isFinite(price) && (price as number) > 0 && (price as number) < 10_000_000)) return null;
  const name = typeof row.name === "string" ? row.name.trim().slice(0, 40) : "";
  return {
    id, kind, name: name || SHORT_NAMES[kind], ...(kind === "custom" ? { price: Math.round((price as number) * 100) / 100 } : {}),
    visible: row.visible !== false,
    color: typeof row.color === "string" && HEX.test(row.color) ? row.color : DEFAULT_COLORS[kind],
    width: row.width === 2 || row.width === 3 || row.width === 4 ? row.width : 1,
    dash: row.dash === "dashed" || row.dash === "dotted" ? row.dash : "solid",
    showPrice: row.showPrice !== false,
    showName: row.showName !== false,
    extend: row.extend === "session" || row.extend === "full" ? row.extend : "right",
  };
}

/** Validates a config from the client or the database; unknown kinds, bad colours or prices are dropped / defaulted. */
export function normalizeConfig(value: unknown): LineDrawingConfig {
  const rows = value && typeof value === "object" && Array.isArray((value as LineDrawingConfig).lines) ? (value as LineDrawingConfig).lines : [];
  const seen = new Set<string>();
  return { lines: rows.slice(0, MAX_LINES_PER_DRAWING).map((row, index) => cleanLine(row, index, seen)).filter((row): row is LevelLine => row != null) };
}

export function normalizeTimeframe(value: unknown): ChartSpan | "all" {
  return typeof value === "string" && (CHART_SPANS as readonly string[]).includes(value) ? (value as ChartSpan) : "all";
}

export function normalizeSymbol(value: unknown) {
  const symbol = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9&._-]{1,40}$/.test(symbol) ? symbol : "*";
}

/** Whether a drawing belongs on a chart of `symbol` at `span`. */
export function appliesTo(drawing: Pick<LineDrawing, "symbol" | "timeframe">, symbol: string, span: string) {
  return (drawing.symbol === "*" || drawing.symbol === symbol.toUpperCase()) && (drawing.timeframe === "all" || drawing.timeframe === span);
}

/** True when any line of these drawings needs the session's market data (anything but custom prices). */
export function needsMarketData(drawings: LineDrawing[]) {
  return drawings.some((drawing) => drawing.config.lines.some((line) => line.visible && line.kind !== "custom"));
}

export function formatLevel(value: number) {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type Resolved = { value: number; start: number | null };

/** The price of one level from the session's data (same S1Data / s1Levels the Strategy uses); null when unknown or not yet revealed. */
export function levelValue(line: LevelLine, data: S1Data | null, cursor: number | null): Resolved | null {
  if (line.kind === "custom") return line.price && line.price > 0 ? { value: line.price, start: data?.sessionOpen ?? null } : null;
  if (!data || !data.previous) return null;
  const levels = s1Levels(data.previous, data.open, data.firstMinute);
  if (!levels) return null;
  const show = s1Reveal(data, levels, cursor);
  const prevStart = data.anchors?.previous ?? data.sessionOpen;
  const p = data.previous;
  switch (line.kind) {
    case "pdh": return { value: p.high, start: prevStart };
    case "pdl": return { value: p.low, start: prevStart };
    case "pdc": return { value: p.close, start: prevStart };
    case "pdm": return { value: (p.high + p.low) / 2, start: prevStart };
    case "open": return data.open != null && show.openBox ? { value: data.open, start: data.sessionOpen } : null;
    case "or_high": return levels.openingRange && show.openingRange ? { value: levels.openingRange.high, start: levels.openingRange.time } : null;
    case "or_low": return levels.openingRange && show.openingRange ? { value: levels.openingRange.low, start: levels.openingRange.time } : null;
    case "boxA_top": return { value: levels.closeBox.top, start: prevStart };
    case "boxA_mid": return { value: levels.closeBox.mid, start: prevStart };
    case "boxA_bottom": return { value: levels.closeBox.bottom, start: prevStart };
    case "boxB_top": return levels.openBox && show.openBox ? { value: levels.openBox.top, start: data.sessionOpen } : null;
    case "boxB_mid": return levels.openBox && show.openBox ? { value: levels.openBox.mid, start: data.sessionOpen } : null;
    case "boxB_bottom": return levels.openBox && show.openBox ? { value: levels.openBox.bottom, start: data.sessionOpen } : null;
    default: return null;
  }
}

function caption(color: string): DrawingTextStyle {
  return { size: 11, bold: true, italic: false, color, align: "left", valign: "top", visible: true };
}

/**
 * The chart objects for every enabled drawing that applies to this chart. Lines with the same price (to the paisa)
 * and the same style become one object whose label lists every level's name, so nothing is drawn twice; each line
 * keeps its own settings in its drawing. A level whose data is missing (or not yet reached in replay) is skipped.
 */
export function buildLineOverlays(drawings: LineDrawing[], ctx: { symbol: string; span: string; data: S1Data | null; cursor: number | null }): Drawing[] {
  type Item = { id: string; line: LevelLine; value: number; start: number | null; label: string };
  const items: Item[] = [];
  const data = ctx.data && ctx.data.symbol.toUpperCase() === ctx.symbol.toUpperCase() ? ctx.data : null;
  for (const drawing of drawings) {
    if (!drawing.enabled || !appliesTo(drawing, ctx.symbol, ctx.span)) continue;
    for (const line of drawing.config.lines) {
      if (!line.visible) continue;
      const resolved = levelValue(line, data, ctx.cursor);
      if (!resolved || !Number.isFinite(resolved.value) || resolved.value <= 0) continue;
      const label = [line.showName ? line.name : "", line.showPrice ? formatLevel(resolved.value) : ""].filter(Boolean).join(" ");
      items.push({ id: `${LINES_PREFIX}${drawing.id}:${line.id}`, line, value: resolved.value, start: resolved.start, label });
    }
  }
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = `${Math.round(item.value * 100)}|${item.line.color}|${item.line.width}|${item.line.dash}|${item.line.extend}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const out: Drawing[] = [];
  for (const group of groups.values()) {
    const head = group[0];
    const labels = [...new Set(group.map((item) => item.label).filter(Boolean))];
    const text = labels.join(" · ") || undefined;
    const base = { id: head.id, color: head.line.color, width: head.line.width, dash: head.line.dash, text, textStyle: caption(head.line.color), locked: true } as const;
    if (head.line.extend === "full" || head.start == null) {
      out.push({ ...base, kind: "hline", points: [{ time: head.start ?? data?.sessionOpen ?? 0, price: head.value }] });
    } else if (head.line.extend === "session" && data) {
      out.push({ ...base, kind: "trend", points: [{ time: Math.max(head.start, data.sessionOpen), price: head.value }, { time: data.sessionClose, price: head.value }] });
    } else {
      out.push({ ...base, kind: "hray", points: [{ time: head.start, price: head.value }] });
    }
  }
  return out;
}
