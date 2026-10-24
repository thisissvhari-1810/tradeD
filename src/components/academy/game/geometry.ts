/**
 * Roadmap geometry: one model for the road, the lesson stops, the chapter regions and Tiko's walk, in
 * the world's own units (a fixed width, a height that grows with the chapters shown). The HTML stops
 * and cards are placed by percentage of the same box, so nothing can drift off the road at any size.
 */

export type MapLayout = "wide" | "tall";
export type Point = { x: number; y: number };

const METRICS = {
  // Desktop and tablet: the road snakes through the middle; chapter cards and landmarks sit either side.
  wide: { width: 1200, top: 70, header: 300, gap: 138, tail: 70, center: 600, amp: 230, gateY: 0.82, fogRow: 104, fogHead: 150, fogPerRow: 3, bottom: 60 },
  // Phones: a narrower snake; the chapter card spans the top of each region.
  tall: { width: 600, top: 70, header: 400, gap: 170, tail: 60, center: 300, amp: 150, gateY: 0.84, fogRow: 136, fogHead: 190, fogPerRow: 1, bottom: 80 },
} as const;

export type ChapterBox = {
  index: number;
  top: number;
  height: number;
  /** Which side the chapter's landmark stands on (its card is on the other side on wide maps). */
  side: "left" | "right";
  nodes: Point[];
};

export type World = {
  layout: MapLayout;
  width: number;
  height: number;
  chapters: ChapterBox[];
  /** The mist region for chapters not reached yet (null when every chapter is open). */
  fog: { top: number; height: number; count: number } | null;
  /** Every stop, in journey order. */
  nodes: Point[];
  /** The road's points (gates and stops) and where each stop sits in that list. */
  points: Point[];
  nodePoint: number[];
};

/** Lays out the reached chapters (with their stop counts) and the mist for the rest. */
export function buildWorld(layout: MapLayout, expanded: number[], hidden: number): World {
  const m = METRICS[layout];
  const chapters: ChapterBox[] = [];
  const points: Point[] = [];
  const nodePoint: number[] = [];
  const nodes: Point[] = [];
  let y: number = m.top;
  expanded.forEach((count, index) => {
    const side = index % 2 === 0 ? "right" : "left";
    const top = y;
    const height = m.header + count * m.gap + m.tail;
    // The road enters each chapter through a gate below its card, away from the landmark.
    const gateX = layout === "wide" ? m.center : side === "right" ? m.center - m.amp : m.center + m.amp;
    points.push({ x: gateX, y: top + m.header * m.gateY });
    const phase = layout === "wide" ? (side === "right" ? Math.PI : 0) : side === "right" ? -Math.PI / 2 : Math.PI / 2;
    const chapterNodes: Point[] = [];
    for (let i = 0; i < count; i += 1) {
      const point = { x: Math.round(m.center + m.amp * Math.sin(phase + (i + (layout === "wide" ? 0.6 : 0)) * 1.1)), y: Math.round(top + m.header + i * m.gap + m.gap / 2) };
      chapterNodes.push(point);
      nodes.push(point);
      nodePoint.push(points.length);
      points.push(point);
    }
    chapters.push({ index, top, height, side, nodes: chapterNodes });
    y += height;
  });
  let fog: World["fog"] = null;
  if (hidden > 0) {
    const height = m.fogHead + Math.ceil(hidden / m.fogPerRow) * m.fogRow + 40;
    fog = { top: y, height, count: hidden };
    // The road fades out into the mist.
    points.push({ x: m.center, y: y + 10 });
    y += height;
  } else if (nodes.length) {
    // Journey's end: a short stretch past the last stop to the summit flag.
    const last = nodes[nodes.length - 1];
    points.push({ x: m.center, y: last.y + m.gap * 0.9 });
    y = Math.max(y, last.y + m.gap * 1.3);
  }
  return { layout, width: m.width, height: y + m.bottom, chapters, fog, nodes, points, nodePoint };
}

/** A point of the world as a percentage of the map box (for HTML placed over the drawing). */
export function percent(world: World, point: Point) {
  return { left: (point.x / world.width) * 100, top: (point.y / world.height) * 100 };
}

type Segment = [Point, Point, Point, Point];

/** Cubic Bézier segments of a smooth curve through the points (Catmull-Rom). */
function segmentsOf(points: Point[]): Segment[] {
  const at = (index: number) => points[Math.max(0, Math.min(points.length - 1, index))];
  return points.slice(0, -1).map((_, index) => {
    const p0 = at(index - 1);
    const p1 = at(index);
    const p2 = at(index + 1);
    const p3 = at(index + 2);
    return [p1, { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }, { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }, p2];
  });
}

function toPath(segments: Segment[]) {
  if (!segments.length) return "";
  const n = (value: number) => Number(value.toFixed(1));
  return `M ${segments[0][0].x} ${segments[0][0].y}` + segments.map(([, c1, c2, end]) => ` C ${n(c1.x)} ${n(c1.y)}, ${n(c2.x)} ${n(c2.y)}, ${end.x} ${end.y}`).join("");
}

/** The whole road. */
export function roadPath(world: World) {
  return toPath(segmentsOf(world.points));
}

/** The road from the start to stop `upTo` (it lies exactly on the full road); empty before the first stop. */
export function travelledPath(world: World, upTo: number) {
  if (upTo < 0) return "";
  return toPath(segmentsOf(world.points).slice(0, world.nodePoint[upTo]));
}

/** The stretch from stop `from` to stop `to`, for the route highlight to the next lesson. */
export function stretchPath(world: World, from: number, to: number) {
  const start = from < 0 ? 0 : world.nodePoint[from];
  return toPath(segmentsOf(world.points).slice(start, world.nodePoint[to]));
}

/** The position `t` (0–1) of the way along the road from stop `from` to stop `to` (Tiko's walk). */
export function pointAlong(world: World, from: number, to: number, t: number): Point {
  const segments = segmentsOf(world.points).slice(from < 0 ? 0 : world.nodePoint[from], world.nodePoint[to]);
  if (!segments.length) return world.nodes[to];
  const scaled = Math.min(0.9999, Math.max(0, t)) * segments.length;
  const [p0, p1, p2, p3] = segments[Math.floor(scaled)];
  const u = scaled - Math.floor(scaled);
  const v = 1 - u;
  return {
    x: v * v * v * p0.x + 3 * v * v * u * p1.x + 3 * v * u * u * p2.x + u * u * u * p3.x,
    y: v * v * v * p0.y + 3 * v * v * u * p1.y + 3 * v * u * u * p2.y + u * u * u * p3.y,
  };
}

/** Stars earned on a lesson from its best score: 70% one, 85% two, 100% three. */
export function starsFor(score: number) {
  return score >= 100 ? 3 : score >= 85 ? 2 : score >= 70 ? 1 : 0;
}
