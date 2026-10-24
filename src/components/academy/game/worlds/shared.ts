import type { Point } from "../geometry";
import type { Region } from "./config";

/** What a world draws for one chapter region (in the map's units). */
export type RegionProps = {
  index: number;
  box: { top: number; height: number; side: "left" | "right"; nodes: Point[] };
  width: number;
  wide: boolean;
  /** Where the chapter's landmark stands, and its size. */
  anchor: { x: number; y: number; scale: number };
  /** Share of the chapter's lessons completed (0–1): the scenery lights up with it. */
  progress: number;
  complete: boolean;
  region: Region;
};

/** Repeatable pseudo-random numbers (0–1) so scenery is the same on every render. */
export function rand(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

export const INK = "#0d1726";
