import { roadPath, stretchPath, travelledPath, type World } from "./geometry";
import type { RoadStyle } from "./worlds/config";

type Stroke = { stroke: string; width: number; opacity?: number; dash?: string; className?: string; shift?: number };

/** How each world draws the same road: a sandy road, a city transit line, an orbit trajectory or a circuit trace. */
export function roadLayers(style: RoadStyle, wide: boolean): { base: Stroke[]; travelled: Stroke[] } {
  const w = wide ? 1 : 0.94;
  switch (style) {
    case "transit":
      return {
        base: [
          { stroke: "rgba(0,0,0,.35)", width: 66 * w, shift: 9 },
          { stroke: "#38e1ff", width: 56 * w, opacity: 0.55 },
          { stroke: "#121e33", width: 48 * w },
          { stroke: "#ffd25a", width: 3, dash: "14 14", opacity: 0.7, className: "mq-road-marks" },
        ],
        travelled: [{ stroke: "#ffd25a", width: 10, opacity: 0.9 }, { stroke: "#fff6c2", width: 3, opacity: 0.9 }],
      };
    case "orbit":
      return {
        base: [
          { stroke: "#7f8cff", width: 46 * w, opacity: 0.1 },
          { stroke: "#b8c4ff", width: 18 * w, opacity: 0.12 },
          { stroke: "#e6ecff", width: 3, opacity: 0.55 },
          { stroke: "#ffffff", width: 6, dash: "1 22", opacity: 0.85, className: "mq-orbit-dots" },
        ],
        travelled: [{ stroke: "#ffd25a", width: 16, opacity: 0.25 }, { stroke: "#ffe7a3", width: 5, opacity: 0.95 }],
      };
    case "trace":
      return {
        base: [
          { stroke: "#2c3a4d", width: 34 * w },
          { stroke: "#151d28", width: 26 * w },
          { stroke: "#38e1ff", width: 3, opacity: 0.35 },
        ],
        travelled: [{ stroke: "#3fe08d", width: 10, opacity: 0.85 }, { stroke: "#ffffff", width: 4, dash: "18 46", opacity: 0.9, className: "mq-pulse" }],
      };
    default:
      return {
        base: [
          { stroke: "rgba(0,0,0,.28)", width: 66 * w, shift: 9 },
          { stroke: "#3b2a1a", width: 54 * w },
          { stroke: "#e8cf98", width: 38 * w },
          { stroke: "#fff6dc", width: 4, dash: "10 16", className: "mq-road-marks" },
        ],
        travelled: [{ stroke: "#ffd25a", width: 24 * w, opacity: 0.95 }],
      };
  }
}

/**
 * The road in the chosen world's style, drawn in when the map opens. The travelled stretch (up to the
 * last completed stop) lights up, and `fresh` animates it after a new completion. The way to the next
 * lesson carries a marching highlight and a travelling light. Built from the same geometry as the stops.
 */
export function WindingRoad({ world, style, completedUpTo, current, fresh, motion }: { world: World; style: RoadStyle; completedUpTo: number; current: number; fresh: boolean; motion: boolean }) {
  const { width, height } = world;
  const road = roadPath(world);
  const wide = world.layout === "wide";
  const { base, travelled } = roadLayers(style, wide);
  const route = current >= 0 ? stretchPath(world, completedUpTo, current) : "";
  const done = completedUpTo >= 0 ? travelledPath(world, completedUpTo) : "";
  const end = world.points[world.points.length - 1];
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} aria-hidden data-road={style}>
      <defs>
        {/* The road fades into the mist where the unexplored chapters begin. */}
        <linearGradient id="mq-road-fade-g" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={world.fog ? end.y - 240 : height} y2={world.fog ? end.y : height + 1}>
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="mq-road-fade" maskUnits="userSpaceOnUse" x={-width} y="0" width={width * 3} height={height}><rect x={-width} y="0" width={width * 3} height={height} fill="url(#mq-road-fade-g)" /></mask>
      </defs>
      <g mask="url(#mq-road-fade)">
        {base.map((layer, index) => (
          <path
            key={index}
            d={road}
            pathLength={layer.dash ? undefined : 1}
            className={layer.className ?? "mq-road-reveal"}
            style={layer.dash ? { strokeDasharray: layer.dash } : undefined}
            fill="none"
            stroke={layer.stroke}
            strokeWidth={layer.width}
            opacity={layer.opacity}
            strokeLinecap="round"
            strokeLinejoin="round"
            transform={layer.shift ? `translate(0 ${layer.shift})` : undefined}
          />
        ))}
      </g>
      {done ? travelled.map((layer, index) => (
        <path
          key={index}
          d={done}
          pathLength={layer.dash ? undefined : 1}
          className={layer.className ?? (fresh ? "mq-road-done-fresh" : "mq-road-done")}
          style={layer.dash ? { strokeDasharray: layer.dash } : undefined}
          fill="none"
          stroke={layer.stroke}
          strokeWidth={layer.width}
          opacity={layer.opacity}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )) : null}
      {route ? (
        <>
          <path d={route} className="mq-route" fill="none" stroke="#fffbe8" strokeWidth={6} strokeLinecap="round" opacity="0.85" />
          {motion ? (
            <circle r={wide ? 9 : 10} fill="#fff7c2" opacity="0.95" style={{ filter: "drop-shadow(0 0 6px #ffe27a)" }}>
              <animateMotion dur={`${2.2 + (current - completedUpTo) * 0.3}s`} repeatCount="indefinite" path={route} />
            </circle>
          ) : null}
        </>
      ) : null}
    </svg>
  );
}
