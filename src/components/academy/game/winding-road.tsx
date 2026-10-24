import { styles } from "./academy-game-classes";
import { checkpoints, roadPath, travelledPath, VIEWBOX, type MapLayout } from "./geometry";

/**
 * The road: a dark edge, a sandy surface and dashed markings, drawn in when the map opens. The
 * travelled stretch (up to the last completed level) is gold; `fresh` animates it in after a new
 * completion. Built from the same geometry as the platforms.
 */
export function WindingRoad({ layout, completedUpTo, fresh }: { layout: MapLayout; completedUpTo: number; fresh: boolean }) {
  const { width, height } = VIEWBOX[layout];
  const road = roadPath(layout);
  const wide = layout === "wide";
  const edge = wide ? 58 : 50;
  const surface = wide ? 42 : 36;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <defs>
        <linearGradient id="mq-fade" x1="0" x2="1" y1="1" y2="0">
          <stop offset="0.72" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="mq-road-fade"><rect width={width} height={height} fill="url(#mq-fade)" /></mask>
      </defs>
      <g mask="url(#mq-road-fade)">
        <path d={road} pathLength={1} className={styles.roadReveal} fill="none" stroke="rgba(0,0,0,.25)" strokeWidth={edge + 10} strokeLinecap="round" strokeLinejoin="round" transform="translate(0 8)" />
        <path d={road} pathLength={1} className={styles.roadReveal} fill="none" stroke="#3b2a1a" strokeWidth={edge} strokeLinecap="round" strokeLinejoin="round" />
        <path d={road} pathLength={1} className={styles.roadReveal} fill="none" stroke="#e8cf98" strokeWidth={surface} strokeLinecap="round" strokeLinejoin="round" />
        <path d={road} pathLength={1} className={styles.roadMarks} style={{ strokeDasharray: "0.012 0.02" }} fill="none" stroke="#fff6dc" strokeWidth="4" strokeLinecap="round" />
      </g>
      {completedUpTo >= 0 ? (
        <path d={travelledPath(layout, completedUpTo)} pathLength={1} className={fresh ? styles.roadDoneFresh : styles.roadDone} fill="none" stroke="#ffd25a" strokeWidth={surface - 14} strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />
      ) : null}
      {checkpoints(layout).map((point, index) => (
        <g key={index} opacity="0.9">
          <circle cx={point.x} cy={point.y} r="9" fill="#3b2a1a" />
          <circle cx={point.x} cy={point.y} r="5" fill={index <= completedUpTo ? "#ffd25a" : "#fff6dc"} />
        </g>
      ))}
    </svg>
  );
}
