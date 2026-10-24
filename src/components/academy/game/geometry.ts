/**
 * Market Quest map geometry: one model for both the road and the level platforms, so they can
 * never drift apart. Coordinates are in the map's viewBox units; the HTML platforms are placed by
 * percentage of the same box, so they stay on the road at every screen size.
 */

export type MapLayout = "wide" | "tall";

export type LevelDef = {
  id: string;
  number: number;
  title: string;
  description: string;
  teaser: string;
  theme: "market" | "candles" | "summit";
  /** The Academy lesson this level plays (only Level 01 is playable in this release). */
  lessonSlug: string | null;
};

export const LEVELS: LevelDef[] = [
  { id: "l1", number: 1, title: "Market Explorer", description: "Learn what a stock is and how the stock market works.", teaser: "Discover how the stock market works.", theme: "market", lessonSlug: "m1-first-trading-day" },
  { id: "l2", number: 2, title: "Candlestick Canyon", description: "Read the story inside every candle: open, high, low and close.", teaser: "Candles, wicks and the patterns traders watch.", theme: "candles", lessonSlug: null },
  { id: "l3", number: 3, title: "Price Action Summit", description: "Climb through support, resistance and trend structure.", teaser: "Support, resistance and the shape of a trend.", theme: "summit", lessonSlug: null },
];

type Point = { x: number; y: number };

export const VIEWBOX: Record<MapLayout, { width: number; height: number }> = {
  wide: { width: 1600, height: 900 },
  tall: { width: 600, height: 1180 },
};

/** Platform centres, then the points where the road fades into the unexplored region. */
const ROUTE: Record<MapLayout, { nodes: Point[]; start: Point; beyond: Point[] }> = {
  // Bottom-left, up to the upper middle, then turning right towards the far zone.
  wide: { start: { x: 120, y: 860 }, nodes: [{ x: 360, y: 640 }, { x: 760, y: 470 }, { x: 1080, y: 250 }], beyond: [{ x: 1340, y: 300 }, { x: 1560, y: 160 }] },
  // Phones: bottom to top, swinging left and right.
  tall: { start: { x: 300, y: 1180 }, nodes: [{ x: 190, y: 960 }, { x: 420, y: 660 }, { x: 200, y: 370 }], beyond: [{ x: 380, y: 170 }, { x: 300, y: -20 }] },
};

export function routeOf(layout: MapLayout) {
  return ROUTE[layout];
}

/** A node's position as a percentage of the map box (for the HTML platform). */
export function nodePercent(layout: MapLayout, index: number) {
  const point = ROUTE[layout].nodes[index];
  const box = VIEWBOX[layout];
  return { left: (point.x / box.width) * 100, top: (point.y / box.height) * 100 };
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

function allPoints(layout: MapLayout) {
  const route = ROUTE[layout];
  return [route.start, ...route.nodes, ...route.beyond];
}

/** The whole road (start → every node → into the unexplored region). */
export function roadPath(layout: MapLayout) {
  return toPath(segmentsOf(allPoints(layout)));
}

/** The travelled part of the road, from the start through node `upTo`; it lies exactly on the full road. */
export function travelledPath(layout: MapLayout, upTo: number) {
  return toPath(segmentsOf(allPoints(layout)).slice(0, upTo + 1));
}

/** Checkpoint markers on the road, halfway along each stretch before a node. */
export function checkpoints(layout: MapLayout) {
  const count = ROUTE[layout].nodes.length;
  return segmentsOf(allPoints(layout)).slice(0, count).map(([p1, c1, c2, p2]) => ({ x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8 }));
}

/** Stars earned on a level from its best score: 70% one, 85% two, 100% three. */
export function starsFor(score: number) {
  return score >= 100 ? 3 : score >= 85 ? 2 : score >= 70 ? 1 : 0;
}
