import type { World } from "./geometry";
import type { WorldDef } from "./worlds/config";
import { CircuitRegion } from "./worlds/circuit";
import { CosmosRegion } from "./worlds/cosmos";
import { ExpeditionRegion } from "./worlds/expedition";
import { MetropolisRegion } from "./worlds/metropolis";
import type { RegionProps } from "./worlds/shared";

/** Where a chapter's landmark stands (world units) and how large it is drawn. */
export function landmarkAnchor(world: World, index: number) {
  const box = world.chapters[index];
  if (world.layout === "wide") return { x: box.side === "right" ? 935 : 265, y: box.top + 262, scale: 1 };
  return { x: box.side === "right" ? 418 : 182, y: box.top + 392, scale: 0.74 };
}

const REGIONS: Record<WorldDef["id"], (props: RegionProps) => React.ReactNode> = {
  metropolis: MetropolisRegion,
  cosmos: CosmosRegion,
  circuit: CircuitRegion,
  expedition: ExpeditionRegion,
};

/**
 * The scenery under the road, in the chosen world: each chapter's region (lit up with its real
 * progress), and the mist over the chapters not reached yet. One SVG in the map's units; decorative.
 */
export function MapEnvironment({ world, theme, chapters }: { world: World; theme: WorldDef; chapters: Array<{ complete: boolean; progress: number }> }) {
  const wide = world.layout === "wide";
  const { width, height } = world;
  const Region = REGIONS[theme.id];
  return (
    // overflow: visible lets the scenery run past the map's edges on wide screens.
    <svg className="mq-scene" viewBox={`0 0 ${width} ${height}`} overflow="visible" style={{ overflow: "visible" }} aria-hidden>
      {world.chapters.map((box) => (
        <Region
          key={box.index}
          index={box.index}
          box={box}
          width={width}
          wide={wide}
          anchor={landmarkAnchor(world, box.index)}
          progress={chapters[box.index]?.progress ?? 0}
          complete={chapters[box.index]?.complete ?? false}
          region={theme.region(box.index)}
        />
      ))}
      {world.fog ? (
        <g>
          <defs>
            <linearGradient id="mq-mist" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#c9d8ff" stopOpacity="0" />
              <stop offset="0.25" stopColor="#c9d8ff" stopOpacity="0.2" />
              <stop offset="1" stopColor="#c9d8ff" stopOpacity="0.28" />
            </linearGradient>
          </defs>
          {/* Distant shapes of the regions ahead, half hidden. */}
          <path
            d={`M ${-width} ${world.fog.top + 220} L ${width * 0.08} ${world.fog.top + 90} L ${width * 0.22} ${world.fog.top + 170} L ${width * 0.4} ${world.fog.top + 60} L ${width * 0.58} ${world.fog.top + 160} L ${width * 0.76} ${world.fog.top + 80} L ${width * 0.92} ${world.fog.top + 150} L ${width * 2} ${world.fog.top + 120} L ${width * 2} ${height + 200} L ${-width} ${height + 200} Z`}
            fill={theme.fog[0]}
            opacity="0.55"
          />
          <rect x={-width} y={world.fog.top - 60} width={width * 3} height={world.fog.height + 260} fill="url(#mq-mist)" />
        </g>
      ) : null}
    </svg>
  );
}
