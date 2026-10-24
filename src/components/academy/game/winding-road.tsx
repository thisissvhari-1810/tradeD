import { roadPath, stretchPath, travelledPath, type World } from "./geometry";

/**
 * The road: shadow, dark edge, sandy surface and dashed markings, drawn in when the map opens. The
 * travelled stretch (up to the last completed stop) is gold, and `fresh` animates it after a new
 * completion. The way to the next lesson carries a marching highlight and a travelling light. Built
 * from the same geometry as the stops.
 */
export function WindingRoad({ world, completedUpTo, current, fresh, motion }: { world: World; completedUpTo: number; current: number; fresh: boolean; motion: boolean }) {
  const { width, height } = world;
  const road = roadPath(world);
  const wide = world.layout === "wide";
  const edge = wide ? 54 : 50;
  const surface = wide ? 38 : 36;
  const route = current >= 0 ? stretchPath(world, completedUpTo, current) : "";
  const end = world.points[world.points.length - 1];
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <defs>
        {/* The road fades into the mist where the unexplored chapters begin. */}
        <linearGradient id="mq-road-fade-g" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={world.fog ? end.y - 240 : height} y2={world.fog ? end.y : height + 1}>
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="mq-road-fade" maskUnits="userSpaceOnUse" x={-width} y="0" width={width * 3} height={height}><rect x={-width} y="0" width={width * 3} height={height} fill="url(#mq-road-fade-g)" /></mask>
      </defs>
      <g mask="url(#mq-road-fade)">
        <path d={road} pathLength={1} className="mq-road-reveal" fill="none" stroke="rgba(0,0,0,.28)" strokeWidth={edge + 12} strokeLinecap="round" strokeLinejoin="round" transform="translate(0 9)" />
        <path d={road} pathLength={1} className="mq-road-reveal" fill="none" stroke="#3b2a1a" strokeWidth={edge} strokeLinecap="round" strokeLinejoin="round" />
        <path d={road} pathLength={1} className="mq-road-reveal" fill="none" stroke="#e8cf98" strokeWidth={surface} strokeLinecap="round" strokeLinejoin="round" />
        <path d={road} className="mq-road-marks" style={{ strokeDasharray: "10 16" }} fill="none" stroke="#fff6dc" strokeWidth="4" strokeLinecap="round" />
      </g>
      {completedUpTo >= 0 ? (
        <path d={travelledPath(world, completedUpTo)} pathLength={1} className={fresh ? "mq-road-done-fresh" : "mq-road-done"} fill="none" stroke="#ffd25a" strokeWidth={surface - 14} strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />
      ) : null}
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
