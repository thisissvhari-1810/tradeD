import type { ChartIconName } from "@/components/chart-icons";
import type { CursorStyle, Drawing, DrawTool } from "@/components/drawing-model";

export type ToolEntry = {
  key: string;
  tool: DrawTool;
  cursor?: CursorStyle;
  label: string;
  icon: ChartIconName;
  hint?: string;
  section?: string;
};

export type ToolGroup = { id: string; label: string; entries: ToolEntry[] };

const entry = (tool: DrawTool, label: string, icon: ChartIconName, extra: Partial<ToolEntry> = {}): ToolEntry => ({ key: tool, tool, label, icon, ...extra });

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: "cursors",
    label: "Cursors",
    entries: [
      { key: "cursor:cross", tool: "cursor", cursor: "cross", label: "Cross", icon: "crosshair" },
      { key: "cursor:dot", tool: "cursor", cursor: "dot", label: "Dot", icon: "dot" },
      { key: "cursor:arrow", tool: "cursor", cursor: "arrow", label: "Arrow", icon: "cursor" },
      entry("eraser", "Eraser", "eraser", { hint: "Click a drawing to remove it" }),
    ],
  },
  {
    id: "lines",
    label: "Trend line tools",
    entries: [
      entry("trend", "Trend line", "trend", { section: "Lines" }),
      entry("ray", "Ray", "ray", { section: "Lines" }),
      entry("infoline", "Info line", "infoline", { section: "Lines" }),
      entry("extended", "Extended line", "extended", { section: "Lines" }),
      entry("angle", "Trend angle", "angle", { section: "Lines" }),
      entry("hline", "Horizontal line", "hline", { section: "Lines" }),
      entry("hray", "Horizontal ray", "hray", { section: "Lines" }),
      entry("vline", "Vertical line", "vline", { section: "Lines" }),
      entry("crossline", "Cross line", "crossline", { section: "Lines" }),
      entry("channel", "Parallel channel", "channel", { section: "Channels", hint: "Three clicks" }),
      entry("regression", "Regression trend", "regression", { section: "Channels" }),
    ],
  },
  {
    id: "pitchforks",
    label: "Pitchforks",
    entries: [
      entry("pitchfork", "Pitchfork", "pitchfork", { hint: "Three clicks" }),
      entry("schiff", "Schiff pitchfork", "schiff", { hint: "Three clicks" }),
      entry("modschiff", "Modified Schiff pitchfork", "modschiff", { hint: "Three clicks" }),
    ],
  },
  {
    id: "fib",
    label: "Gann and Fibonacci tools",
    entries: [
      entry("fib", "Fib retracement", "fib", { section: "Fibonacci" }),
      entry("fibext", "Trend-based fib extension", "fibext", { section: "Fibonacci" }),
      entry("fibchannel", "Fib channel", "fibchannel", { section: "Fibonacci", hint: "Three clicks" }),
      entry("fibtime", "Fib time zone", "fibtime", { section: "Fibonacci" }),
      entry("fibfan", "Fib speed resistance fan", "fibfan", { section: "Fibonacci" }),
      entry("gannbox", "Gann box", "gannbox", { section: "Gann" }),
      entry("gannsquare", "Gann square", "gannsquare", { section: "Gann" }),
      entry("gannfan", "Gann fan", "gannfan", { section: "Gann" }),
    ],
  },
  {
    id: "patterns",
    label: "Patterns",
    entries: [
      entry("xabcd", "XABCD pattern", "xabcd", { section: "Chart patterns", hint: "Five clicks" }),
      entry("headshoulders", "Head and shoulders", "headshoulders", { section: "Chart patterns", hint: "Five clicks" }),
      entry("elliott", "Elliott impulse wave (12345)", "elliott", { section: "Elliott waves", hint: "Five clicks" }),
      entry("elliottabc", "Elliott correction wave (ABC)", "elliottabc", { section: "Elliott waves", hint: "Three clicks" }),
    ],
  },
  {
    id: "forecasting",
    label: "Forecasting and measurement tools",
    entries: [
      entry("long", "Long position", "long", { section: "Forecasting", hint: "Three clicks" }),
      entry("short", "Short position", "short", { section: "Forecasting", hint: "Three clicks" }),
      entry("forecast", "Forecast", "forecast", { section: "Forecasting" }),
      entry("bars", "Bars pattern", "bars", { section: "Forecasting" }),
      entry("ghost", "Ghost feed", "ghost", { section: "Forecasting" }),
      entry("projection", "Projection", "projection", { section: "Forecasting" }),
      entry("avwap", "Anchored VWAP", "avwap", { section: "Volume-based" }),
      entry("vprofile", "Fixed range volume profile", "vprofile", { section: "Volume-based" }),
      entry("range", "Price range", "range", { section: "Measurers", hint: "Drag across the bars" }),
      entry("daterange", "Date range", "daterange", { section: "Measurers" }),
      entry("dprange", "Date and price range", "dprange", { section: "Measurers" }),
    ],
  },
  {
    id: "shapes",
    label: "Geometric shapes",
    entries: [
      entry("brush", "Brush", "brush", { section: "Brushes" }),
      entry("highlighter", "Highlighter", "highlighter", { section: "Brushes" }),
      entry("arrowmark", "Arrow marker", "arrowmark", { section: "Arrows" }),
      entry("arrow", "Arrow", "arrow", { section: "Arrows" }),
      entry("arrowup", "Arrow mark up", "arrowup", { section: "Arrows" }),
      entry("arrowdown", "Arrow mark down", "arrowdown", { section: "Arrows" }),
      entry("arrowleft", "Arrow mark left", "arrowleft", { section: "Arrows" }),
      entry("arrowright", "Arrow mark right", "arrowright", { section: "Arrows" }),
      entry("rect", "Rectangle", "rect", { section: "Shapes", hint: "Drag to draw" }),
      entry("rrect", "Rotated rectangle", "rrect", { section: "Shapes", hint: "Three clicks" }),
      entry("path", "Path", "path", { section: "Shapes", hint: "Double-click to finish" }),
      entry("circle", "Circle", "circle", { section: "Shapes" }),
      entry("ellipse", "Ellipse", "ellipse", { section: "Shapes", hint: "Drag to draw" }),
      entry("polyline", "Polyline", "polyline", { section: "Shapes", hint: "Double-click to finish" }),
      entry("triangle", "Triangle", "triangle", { section: "Shapes", hint: "Three clicks" }),
      entry("arc", "Arc", "arc", { section: "Shapes", hint: "Three clicks" }),
      entry("curve", "Curve", "curve", { section: "Shapes", hint: "Three clicks" }),
      entry("dcurve", "Double curve", "dcurve", { section: "Shapes", hint: "Four clicks" }),
    ],
  },
  {
    id: "annotation",
    label: "Annotation tools",
    entries: [
      entry("text", "Text", "text"),
      entry("note", "Note", "note"),
      entry("price", "Price label", "price"),
      entry("callout", "Callout", "callout"),
      entry("marker", "Marker", "marker"),
    ],
  },
];

export const SINGLE_TOOLS: ToolEntry[] = [
  entry("measure", "Measure", "measure"),
  entry("zoom", "Zoom in", "zoomArea", { hint: "Drag across the bars" }),
];

export const ALL_TOOLS: ToolEntry[] = [...TOOL_GROUPS.flatMap((group) => group.entries), ...SINGLE_TOOLS];

const BY_KEY = new Map(ALL_TOOLS.map((item) => [item.key, item]));

export function toolEntry(key: string) {
  return BY_KEY.get(key) ?? null;
}

export function entryFor(tool: DrawTool, cursor: CursorStyle) {
  if (tool === "cursor") return BY_KEY.get(`cursor:${cursor}`) ?? null;
  return BY_KEY.get(tool) ?? null;
}

export function isActiveEntry(item: ToolEntry, tool: DrawTool, cursor: CursorStyle) {
  return item.tool === tool && (item.tool !== "cursor" || item.cursor === cursor);
}

export function toolLabel(kind: Drawing["kind"]) {
  return BY_KEY.get(kind)?.label ?? kind;
}
