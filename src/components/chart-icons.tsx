import type { ReactNode } from "react";

export type ChartIconName =
  | "cursor" | "crosshair" | "dot" | "eraser" | "zoomArea"
  | "trend" | "ray" | "infoline" | "extended" | "angle" | "hline" | "hray" | "vline" | "crossline" | "channel" | "regression"
  | "pitchfork" | "schiff" | "modschiff"
  | "fib" | "fibext" | "fibchannel" | "fibtime" | "fibfan" | "gannbox" | "gannsquare" | "gannfan"
  | "xabcd" | "headshoulders" | "elliott" | "elliottabc"
  | "long" | "short" | "forecast" | "bars" | "ghost" | "projection" | "avwap" | "vprofile" | "range" | "daterange" | "dprange"
  | "brush" | "highlighter" | "arrowmark" | "arrow" | "arrowup" | "arrowdown" | "arrowleft" | "arrowright"
  | "rect" | "rrect" | "path" | "polyline" | "circle" | "ellipse" | "triangle" | "arc" | "curve" | "dcurve"
  | "text" | "note" | "price" | "callout" | "marker"
  | "measure"
  | "magnet" | "magnetWeak" | "magnetStrong" | "stay" | "lock" | "unlock" | "eye" | "eyeOff" | "trash" | "objects"
  | "undo" | "redo" | "indicators" | "candle" | "line" | "bar" | "area" | "time"
  | "zoomIn" | "zoomOut" | "reset" | "maximize" | "minimize" | "refresh" | "options" | "volume" | "volumeOff";

type XY = readonly [number, number];

const R = 2;
const GAP = 2.5;

const n = (value: number) => Math.round(value * 100) / 100;

function seg(a: XY, b: XY, trimA = 0, trimB = 0) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / length;
  const uy = (b[1] - a[1]) / length;
  return `M${n(a[0] + ux * trimA)} ${n(a[1] + uy * trimA)}L${n(b[0] - ux * trimB)} ${n(b[1] - uy * trimB)}`;
}

function ring(at: XY, r = R) {
  return `M${n(at[0] + r)} ${n(at[1])}a${r} ${r} 0 1 0 ${-2 * r} 0a${r} ${r} 0 1 0 ${2 * r} 0`;
}

function chain(points: XY[], closed = false) {
  const pairs = points.slice(0, -1).map((point, index) => [point, points[index + 1]] as const);
  if (closed && points.length > 2) pairs.push([points[points.length - 1], points[0]]);
  return pairs.map(([a, b]) => seg(a, b, GAP, GAP)).join("") + points.map((point) => ring(point)).join("");
}

function head(tip: XY, from: XY, size = 4.5) {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const a: XY = [tip[0] - size * Math.cos(angle - 0.5), tip[1] - size * Math.sin(angle - 0.5)];
  const b: XY = [tip[0] - size * Math.cos(angle + 0.5), tip[1] - size * Math.sin(angle + 0.5)];
  return `M${n(a[0])} ${n(a[1])}L${tip[0]} ${tip[1]}L${n(b[0])} ${n(b[1])}`;
}

const DASH = "2 2";
const DOT = "1 2";

function forkGlyph(a: XY, b: XY, c: XY, origin: XY) {
  const mid: XY = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
  const dx = mid[0] - origin[0];
  const slope = dx ? (mid[1] - origin[1]) / dx : 0;
  const reach = (from: XY): XY => [24, n(from[1] + slope * (24 - from[0]))];
  const shifted = origin[0] !== a[0] || origin[1] !== a[1];
  return (
    <>
      <path d={seg(shifted ? origin : a, reach(mid), shifted ? 0 : GAP, 0) + seg(b, reach(b), GAP, 0) + seg(c, reach(c), GAP, 0) + ring(a) + ring(b) + ring(c)} />
      <path d={seg(b, c, GAP, GAP) + (shifted ? seg(a, origin, GAP, 0) : "")} strokeDasharray={DASH} />
    </>
  );
}

const GLYPHS: Record<ChartIconName, () => ReactNode> = {
  cursor: () => <path d="M9.5 5.5v15.2l3.9-3.7 2.6 5.6 2.3-1-2.6-5.6h5.4z" strokeLinejoin="round" />,
  crosshair: () => <path d="M14.5 4.5v7M14.5 17.5v7M4.5 14.5h7M17.5 14.5h7" />,
  dot: () => (<><circle cx="14.5" cy="14.5" r="1.75" fill="currentColor" stroke="none" /><circle cx="14.5" cy="14.5" r="5.5" opacity={0.55} /></>),
  eraser: () => <path d="M5.5 17.5 14 9l6.5 6.5-7 7h-3zM9.75 13.25l6.5 6.5M13.5 22.5h10" strokeLinejoin="round" />,
  zoomArea: () => (<><path d="M5.5 5.5h11v9h-11z" strokeDasharray={DASH} /><path d={ring([18.5, 18.5], 3.5)} /><path d="M21 21l3 3" strokeLinecap="round" /></>),

  trend: () => <path d={chain([[7, 21], [21, 7]])} />,
  ray: () => <path d={chain([[7, 21], [14, 14]]) + seg([14, 14], [24, 4], GAP, 0)} />,
  infoline: () => (<><path d={chain([[6, 19], [20, 9]])} /><path d="M14.5 17.5h9v6h-9zM16.5 20.5h5" /></>),
  extended: () => <path d={seg([3, 25], [10, 18], 0, GAP) + chain([[10, 18], [18, 10]]) + seg([18, 10], [25, 3], GAP, 0)} />,
  angle: () => (<><path d={chain([[6, 20], [21, 9]]) + "M13 20A7 7 0 0 0 11.65 15.86"} /><path d={seg([6, 20], [23, 20], GAP, 0)} strokeDasharray={DASH} /></>),
  hline: () => <path d={seg([4, 14.5], [14.5, 14.5], 0, GAP) + seg([14.5, 14.5], [25, 14.5], GAP, 0) + ring([14.5, 14.5])} />,
  hray: () => <path d={seg([7, 14.5], [25, 14.5], GAP, 0) + ring([7, 14.5])} />,
  vline: () => <path d={seg([14.5, 4], [14.5, 14.5], 0, GAP) + seg([14.5, 14.5], [14.5, 25], GAP, 0) + ring([14.5, 14.5])} />,
  crossline: () => <path d={seg([4, 14.5], [14.5, 14.5], 0, GAP) + seg([14.5, 14.5], [25, 14.5], GAP, 0) + seg([14.5, 4], [14.5, 14.5], 0, GAP) + seg([14.5, 14.5], [14.5, 25], GAP, 0) + ring([14.5, 14.5])} />,
  channel: () => <path d={chain([[5, 15], [19, 6]]) + seg([9, 22], [16, 17.5], 0, GAP) + seg([16, 17.5], [23, 13], GAP, 0) + ring([16, 17.5])} />,
  regression: () => (<><path d={chain([[5, 19], [23, 9]])} strokeWidth={1.5} /><path d="M5 14 23 4M5 24 23 14" strokeDasharray={DASH} /></>),

  pitchfork: () => forkGlyph([5, 15], [13, 8], [13, 21], [5, 15]),
  schiff: () => forkGlyph([5, 21], [12, 8], [16, 19], [5, 14.5]),
  modschiff: () => forkGlyph([5, 21], [12, 8], [16, 19], [8.5, 14.5]),

  fib: () => (<><path d={"M9 6.5h15M4 11.5h20M4 16.5h20M4 21.5h15" + ring([6.5, 6.5]) + ring([21.5, 21.5])} /><path d={seg([6.5, 6.5], [21.5, 21.5], GAP, GAP)} strokeDasharray={DOT} /></>),
  fibext: () => (<><path d={chain([[5, 22], [11, 14], [16, 19]]) + "M14 5.5h10M14 9.5h10"} /><path d="M15 13.5h9" strokeDasharray={DASH} /></>),
  fibchannel: () => (<><path d={chain([[5, 13], [19, 5]]) + seg([9, 24], [23, 16], GAP, 0) + ring([9, 24])} /><path d="M6.6 17.4 20.6 9.4M7.8 20.7 21.8 12.7" strokeDasharray={DASH} /></>),
  fibtime: () => <path d="M5.5 5v18M8.5 5v18M12.5 5v18M18.5 5v18" />,
  fibfan: () => (<><path d={seg([5, 23], [23, 5], GAP, 0) + seg([5, 23], [23, 11], GAP, 0) + seg([5, 23], [23, 16], GAP, 0) + ring([5, 23])} /><path d="M23.5 5v18" strokeDasharray={DOT} /></>),
  gannbox: () => (<><path d="M5.5 5.5h17v17h-17zM5.5 22.5l17-17" /><path d="M11.5 5.5v17M16.5 5.5v17M5.5 11.5h17M5.5 16.5h17" strokeDasharray={DOT} opacity={0.75} /></>),
  gannsquare: () => (<><path d="M5.5 5.5h17v17h-17zM5.5 5.5l17 17M22.5 5.5l-17 17" /><path d="M14 5.5v17M5.5 14h17" strokeDasharray={DOT} opacity={0.75} /></>),
  gannfan: () => <path d={seg([5, 23], [24, 4], GAP, 0) + seg([5, 23], [24, 10], GAP, 0) + seg([5, 23], [24, 16], GAP, 0) + seg([5, 23], [18, 4], GAP, 0) + seg([5, 23], [12, 4], GAP, 0) + ring([5, 23])} />,

  xabcd: () => (<><path d={chain([[4, 19], [9, 8], [14, 16], [19, 6], [24, 20]])} /><path d={seg([4, 19], [14, 16], GAP, GAP)} strokeDasharray={DOT} /></>),
  headshoulders: () => (<><path d="M3.5 21.5 7 14l3 4 4.5-11 4.5 11 3-4 3.5 7.5" strokeLinejoin="round" /><path d="M4 18.5h20" strokeDasharray={DASH} /></>),
  elliott: () => <path d={chain([[4, 22], [9, 14], [12, 18], [19, 7], [23, 12]])} />,
  elliottabc: () => (<><path d={chain([[6, 7], [13, 20], [18, 12]])} /><path d={seg([18, 12], [23, 22], GAP, 0)} strokeDasharray={DASH} /></>),

  long: () => (<><rect x="5.5" y="5.5" width="17" height="9" fill="currentColor" fillOpacity={0.16} stroke="none" /><path d="M5.5 5.5h17v17h-17zM5.5 14.5h17M14.5 12.5v-5M12.5 9.5l2-2 2 2" /></>),
  short: () => (<><rect x="5.5" y="14.5" width="17" height="8" fill="currentColor" fillOpacity={0.16} stroke="none" /><path d="M5.5 5.5h17v17h-17zM5.5 14.5h17M14.5 16.5v5M12.5 19.5l2 2 2-2" /></>),
  forecast: () => (<><path d={chain([[5, 20], [12, 12]]) + head([23, 6], [12, 12])} /><path d={seg([12, 12], [23, 6], GAP, 0)} strokeDasharray={DASH} /></>),
  bars: () => <path d={"M6.5 9v9M4.5 11.5h2M6.5 15.5h2M10.5 6v9M8.5 8.5h2M10.5 12.5h2M14.5 8v8M12.5 13.5h2M14.5 10.5h2M17 21.5h6.5" + head([23.5, 21.5], [17, 21.5], 3.5)} />,
  ghost: () => (<><path d="M5.5 10.5h3v7h-3zM7 8v2.5M7 17.5V20M11.5 8.5h3v6h-3zM13 6v2.5M13 14.5V17" opacity={0.6} /><path d="M16.5 13 24 7" strokeDasharray={DOT} /></>),
  projection: () => (<><path d={chain([[5, 20], [11, 12]])} /><path d="M15 17 21 9" strokeDasharray={DASH} /><path d={seg([11, 12], [15, 17], GAP, 0)} strokeDasharray={DOT} /></>),
  avwap: () => (<><path d="M7.5 4.5v12" strokeDasharray={DASH} /><path d={ring([7.5, 19]) + "M9.4 18.3C13 17 15 11 23.5 9"} strokeLinecap="round" /></>),
  vprofile: () => <path d="M5.5 4.5v19M7.5 6.5h9v2h-9zM7.5 10.5h14v2h-14zM7.5 14.5h16v2h-16zM7.5 18.5h11v2h-11zM7.5 22.5h6v1h-6z" />,
  range: () => <path d={"M9.5 6.5h10M9.5 21.5h10M14.5 8.5v11" + head([14.5, 8.5], [14.5, 19.5], 3.5) + head([14.5, 19.5], [14.5, 8.5], 3.5)} />,
  daterange: () => <path d={"M6.5 5.5v17M21.5 5.5v17M8.5 14.5h11" + head([8.5, 14.5], [19.5, 14.5], 3.5) + head([19.5, 14.5], [8.5, 14.5], 3.5)} />,
  dprange: () => (<><path d="M5.5 5.5h17v17h-17z" strokeDasharray={DASH} /><path d={"M8.5 14.5h11M14.5 8.5v11" + head([19.5, 14.5], [8.5, 14.5], 3) + head([14.5, 8.5], [14.5, 19.5], 3)} /></>),

  brush: () => <path d="M5 22c2.5 0 3-3.5 5.5-5.5s4.5.5 6.5-2 1-5 2.5-6.5S23 6 23.5 5.5" strokeLinecap="round" strokeLinejoin="round" />,
  highlighter: () => (<><path d="M5.5 20.5C10 18 14 12 22.5 8.5" strokeWidth={5} strokeOpacity={0.28} strokeLinecap="round" /><path d="M5.5 20.5C10 18 14 12 22.5 8.5" strokeLinecap="round" /></>),
  arrowmark: () => (<><path d={ring([8, 20]) + seg([8, 20], [16.5, 11.5], GAP, 0)} /><path d="M14.5 8.5 20.5 7.5l-1 6z" fill="currentColor" strokeLinejoin="round" /></>),
  arrow: () => <path d={seg([6, 22], [21, 7], GAP, 0) + ring([6, 22]) + head([21, 7], [6, 22], 5)} />,
  arrowup: () => <path d="M14.5 5.5l7 7.5h-4.25v9.5h-5.5V13H7.5z" strokeLinejoin="round" />,
  arrowdown: () => <path d="M14.5 22.5l7-7.5h-4.25V5.5h-5.5V15H7.5z" strokeLinejoin="round" />,
  arrowleft: () => <path d="M5.5 14.5l7.5-7v4.25h9.5v5.5H13v4.25z" strokeLinejoin="round" />,
  arrowright: () => <path d="M22.5 14.5l-7.5-7v4.25H5.5v5.5H15v4.25z" strokeLinejoin="round" />,
  rect: () => <path d={chain([[5.5, 7.5], [22.5, 7.5], [22.5, 20.5], [5.5, 20.5]], true)} />,
  rrect: () => <path d={chain([[9, 5], [23, 10], [19, 23], [5, 18]], true)} />,
  path: () => <path d={chain([[5, 20], [10, 10], [17, 17], [23, 7]])} />,
  polyline: () => (<><path d={"M5 19 11 9l6 9" + seg([17, 18], [23, 8], 0, GAP)} /><path d="M3.5 17.5h3v3h-3zM9.5 7.5h3v3h-3zM15.5 16.5h3v3h-3z" fill="currentColor" stroke="none" /><path d="M21.5 6.5h3v3h-3z" /></>),
  circle: () => <path d={ring([14, 14], 8.5) + chain([[14, 14], [22.5, 14]])} />,
  ellipse: () => (<><ellipse cx="14" cy="14" rx="9.5" ry="6" /><path d="M4.5 14h19M14 8v12" strokeDasharray={DOT} opacity={0.6} /></>),
  triangle: () => <path d={chain([[14, 5], [23, 21], [5, 21]], true)} />,
  arc: () => (<><path d="M5.5 20.5A9 9 0 0 1 22.5 20.5" strokeLinecap="round" /><path d={ring([5.5, 20.5]) + ring([22.5, 20.5])} /><circle cx="14" cy="20.5" r="0.9" fill="currentColor" stroke="none" /></>),
  curve: () => (<><path d="M7 19.6Q14 4 21 15.8" strokeLinecap="round" /><path d={ring([5, 21]) + ring([23, 17])} /><circle cx="14" cy="6" r="1" fill="currentColor" stroke="none" /></>),
  dcurve: () => (<><path d="M5 18C8 6 12 6 13.3 12.2M15.7 15.8C17 22 21 21 23 10" strokeLinecap="round" /><path d={ring([4.5, 20]) + ring([14.5, 14]) + ring([23.5, 8])} /></>),

  text: () => <path d="M8.5 7.5h11M14 7.5v14M12 21.5h4" />,
  note: () => <path d="M6.5 5.5h11l4 4v13h-15zM17.5 5.5v4h4M9.5 13.5h9M9.5 17.5h6" strokeLinejoin="round" />,
  price: () => <path d={"M4.5 10.5H17l5 4-5 4H4.5zM22 14.5h3" + ring([8, 14.5], 1.2)} strokeLinejoin="round" />,
  callout: () => <path d="M5.5 5.5h17v11h-8l-5 5v-5h-4z" strokeLinejoin="round" />,
  marker: () => (<><circle cx="14.5" cy="14.5" r="7" /><circle cx="14.5" cy="14.5" r="1.75" fill="currentColor" stroke="none" /></>),

  measure: () => <path d="M4.5 18.5 18.5 4.5l5 5-14 14zM7 16l1.5 1.5M9.5 13.5l2.5 2.5M12 11l1.5 1.5M14.5 8.5l2.5 2.5M17 6l1.5 1.5" strokeLinejoin="round" />,

  magnet: () => <path d="M7.5 5.5v9a7 7 0 0 0 14 0v-9h-4v9a3 3 0 0 1-6 0v-9zM7.5 9.5h4M17.5 9.5h4" strokeLinejoin="round" />,
  magnetWeak: () => (<><path d="M7.5 5.5h4v4h-4zM17.5 5.5h4v4h-4z" fill="currentColor" fillOpacity={0.4} stroke="none" /><path d="M7.5 5.5v9a7 7 0 0 0 14 0v-9h-4v9a3 3 0 0 1-6 0v-9zM7.5 9.5h4M17.5 9.5h4" strokeLinejoin="round" /></>),
  magnetStrong: () => (<><path d="M7.5 5.5h4v4h-4zM17.5 5.5h4v4h-4z" fill="currentColor" stroke="none" /><path d="M7.5 5.5v9a7 7 0 0 0 14 0v-9h-4v9a3 3 0 0 1-6 0v-9zM7.5 9.5h4M17.5 9.5h4" strokeLinejoin="round" /></>),
  stay: () => <path d="M5.5 18.5 16 8l3 3L8.5 21.5h-3zM14 10l3 3M17 24.2A3.6 3.6 0 1 0 15.2 20M14.2 17.8l1 2.4 2.4-.9" strokeLinejoin="round" strokeLinecap="round" />,
  lock: () => <path d="M8.5 13.5h12v9h-12zM11.5 13.5v-3a3 3 0 0 1 6 0v3M14.5 17v2" />,
  unlock: () => <path d="M8.5 13.5h12v9h-12zM11.5 13.5v-3a3 3 0 0 1 5.8-1.1M14.5 17v2" />,
  eye: () => <path d={"M4.5 14.5S8 8.5 14.5 8.5s10 6 10 6-3.5 6-10 6-10-6-10-6z" + ring([14.5, 14.5], 2.5)} />,
  eyeOff: () => <path d={"M4.5 14.5S8 8.5 14.5 8.5s10 6 10 6-3.5 6-10 6-10-6-10-6z" + ring([14.5, 14.5], 2.5) + "M6 6l17 17"} />,
  trash: () => <path d="M7.5 8.5h14M11.5 8.5v-2h6v2M9.5 8.5l1 14h8l1-14M13 12v7M16 12v7" />,
  objects: () => <path d="M6.5 5.5h5v5h-5zM9 10.5v10M9 14.5h6.5M9 20.5h6.5M15.5 12.5h7v4h-7zM15.5 18.5h7v4h-7z" />,

  undo: () => <path d="M10.5 11.5h7a5 5 0 0 1 0 10h-5M13.5 8 10 11.5l3.5 3.5" />,
  redo: () => <path d="M18.5 11.5h-7a5 5 0 0 0 0 10h5M15.5 8l3.5 3.5-3.5 3.5" />,
  indicators: () => <path d="M4.5 18.5c3 0 4-9 7-9s4 7 6.5 7 3.5-6 6-6M7.5 24.5v-2M12.5 24.5v-3M17.5 24.5V23M22.5 24.5v-3" strokeLinecap="round" />,
  candle: () => (<><path d="M9.5 5.5v17M18.5 6.5v16M7.5 9.5h4v8h-4z" /><rect x="16.5" y="10.5" width="4" height="6" fill="currentColor" stroke="none" /></>),
  line: () => <path d="M4.5 19.5l6-6 4 3 9-9" strokeLinejoin="round" />,
  bar: () => <path d="M9.5 6.5v16M6.5 10.5h3M9.5 18.5h3M18.5 5.5v16M15.5 15.5h3M18.5 9.5h3" />,
  area: () => <path d="M4.5 19.5l6-6 4 3 9-9v15h-19z" fill="currentColor" fillOpacity={0.14} strokeLinejoin="round" />,
  time: () => <path d={ring([14.5, 14.5], 9) + "M14.5 9.5v5l3.5 2"} />,
  zoomIn: () => <path d={ring([12.5, 12.5], 6.5) + "M17.5 17.5l5.5 5.5M12.5 9.5v6M9.5 12.5h6"} />,
  zoomOut: () => <path d={ring([12.5, 12.5], 6.5) + "M17.5 17.5l5.5 5.5M9.5 12.5h6"} />,
  reset: () => <path d="M5.5 10.5v-5h5M23.5 10.5v-5h-5M5.5 18.5v5h5M23.5 18.5v5h-5M10 14.5h9M12 12.5l-2 2 2 2M17 12.5l2 2-2 2" />,
  maximize: () => <path d="M5.5 11.5v-6h6M23.5 11.5v-6h-6M5.5 17.5v6h6M23.5 17.5v6h-6" />,
  minimize: () => <path d="M11.5 5.5v6h-6M17.5 5.5v6h6M11.5 23.5v-6h-6M17.5 23.5v-6h6" />,
  refresh: () => <path d="M21.5 11A7.5 7.5 0 0 0 7.8 10M7.5 6v4.5H12M7.5 18a7.5 7.5 0 0 0 13.7 1M21.5 23v-4.5H17" />,
  options: () => <path d="M12 17l5-5M10.5 13.5l-2 2a3.5 3.5 0 0 0 5 5l2-2M18.5 15.5l2-2a3.5 3.5 0 0 0-5-5l-2 2" strokeLinecap="round" />,
  volume: () => <path d="M6 23v-5M10 23v-9M14 23v-7M18 23v-11M22 23v-4M4.5 24.5h20" strokeWidth={2} />,
  volumeOff: () => (<><path d="M6 23v-5M10 23v-9M14 23v-7M18 23v-11M22 23v-4" strokeWidth={2} opacity={0.45} /><path d="M4.5 24.5h20M5 5l18 18" /></>),
};

export function ChartIcon({ name, size = 28, className }: { name: ChartIconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden focusable="false" className={className}>
      <g fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="butt" strokeLinejoin="miter">{GLYPHS[name]()}</g>
    </svg>
  );
}
