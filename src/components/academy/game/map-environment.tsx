import { styles } from "./academy-game-classes";
import { VIEWBOX, type MapLayout } from "./geometry";

/**
 * The illustrated world behind the road: sky glow, distant locked zone in mist, hills, a small market
 * town with candlestick towers, and gently moving coins, stars and clouds. Decorative only.
 */
export function MapEnvironment({ layout }: { layout: MapLayout }) {
  const { width, height } = VIEWBOX[layout];
  const wide = layout === "wide";
  // Scenery placed as fractions of the box, so one drawing serves both layouts.
  const X = (fraction: number) => fraction * width;
  const Y = (fraction: number) => fraction * height;
  const towers = wide
    ? [[0.08, 0.6, 70], [0.13, 0.64, 46], [0.55, 0.78, 58], [0.6, 0.8, 38], [0.86, 0.66, 64]]
    : [[0.08, 0.66, 60], [0.82, 0.88, 50], [0.86, 0.5, 44], [0.1, 0.36, 40]];
  const coins = wide
    ? [[0.22, 0.42], [0.47, 0.3], [0.63, 0.55], [0.3, 0.86], [0.9, 0.42]]
    : [[0.72, 0.72], [0.18, 0.55], [0.66, 0.25], [0.86, 0.95]];
  const stars = wide
    ? [[0.05, 0.1], [0.18, 0.06], [0.35, 0.14], [0.52, 0.05], [0.7, 0.12], [0.93, 0.08], [0.62, 0.22]]
    : [[0.1, 0.04], [0.4, 0.02], [0.75, 0.06], [0.9, 0.16], [0.2, 0.12]];
  return (
    // overflow: visible lets the sky and hills run past the map's edges, so there is no visible box.
    <svg className={styles.scene} viewBox={`0 0 ${width} ${height}`} overflow="visible" style={{ overflow: "visible" }} aria-hidden>
      <defs>
        <radialGradient id="mq-glow" cx="0.7" cy="0.15" r="0.6">
          <stop offset="0" stopColor="#ffd98a" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffd98a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="mq-hill-far" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2c7a8c" /><stop offset="1" stopColor="#1c5a6a" /></linearGradient>
        <linearGradient id="mq-hill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#4fcf8a" /><stop offset="1" stopColor="#1f8a56" /></linearGradient>
        <linearGradient id="mq-mist" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#c9d8ff" stopOpacity="0.55" /><stop offset="1" stopColor="#c9d8ff" stopOpacity="0" /></linearGradient>
        <radialGradient id="mq-coin" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stopColor="#fff2b0" /><stop offset="0.6" stopColor="#ffc83d" /><stop offset="1" stopColor="#c98a00" /></radialGradient>
      </defs>

      <rect x={-width} y={-height} width={width * 3} height={height * 3} fill="url(#mq-glow)" />
      {stars.map(([x, y], index) => <circle key={index} className={styles.twinkle} cx={X(x)} cy={Y(y)} r={wide ? 3.2 : 2.6} fill="#fff" />)}

      {/* The far, locked region (where the road disappears). */}
      <g className={styles.parallaxFar}>
        {wide
          ? <path d={`M ${X(0.62)} ${Y(0.3)} Q ${X(0.72)} ${Y(0.05)} ${X(0.8)} ${Y(0.22)} T ${X(0.98)} ${Y(0.12)} L ${X(1.6)} ${Y(0.2)} L ${X(1.6)} ${Y(0.75)} L ${X(0.5)} ${Y(0.75)} Z`} fill="#3d5c9a" opacity="0.55" />
          : <path d={`M 0 ${Y(0.16)} Q ${X(0.3)} ${Y(-0.02)} ${X(0.55)} ${Y(0.1)} T ${X(1)} ${Y(0.06)} L ${X(1.6)} ${Y(0.06)} L ${X(1.6)} ${Y(0.6)} L ${X(-0.6)} ${Y(0.6)} L ${X(-0.6)} ${Y(0.16)} Z`} fill="#3d5c9a" opacity="0.55" />}
        <g className={styles.cloudSlow} opacity="0.7">
          <ellipse cx={X(wide ? 0.82 : 0.5)} cy={Y(wide ? 0.2 : 0.08)} rx={wide ? 190 : 170} ry={wide ? 46 : 40} fill="url(#mq-mist)" />
        </g>
        <path d={`M ${X(-0.6)} ${Y(0.5)} Q ${X(-0.2)} ${Y(0.62)} 0 ${Y(0.58)} Q ${X(0.25)} ${Y(0.4)} ${X(0.5)} ${Y(0.5)} T ${X(1)} ${Y(0.44)} T ${X(1.6)} ${Y(0.5)} L ${X(1.6)} ${Y(1.6)} L ${X(-0.6)} ${Y(1.6)} Z`} fill="url(#mq-hill-far)" opacity="0.85" />
        <g className={styles.cloud} opacity="0.85">
          <ellipse cx={X(0.2)} cy={Y(wide ? 0.18 : 0.3)} rx="70" ry="18" fill="#ffffff" opacity="0.5" />
          <ellipse cx={X(0.24)} cy={Y(wide ? 0.16 : 0.29)} rx="40" ry="16" fill="#ffffff" opacity="0.6" />
        </g>
      </g>

      {/* The beginner valley: green hills with a small market town. */}
      <g className={styles.parallaxNear}>
        <path d={`M ${X(-0.6)} ${Y(0.7)} Q ${X(-0.3)} ${Y(0.62)} 0 ${Y(0.74)} Q ${X(0.2)} ${Y(0.6)} ${X(0.42)} ${Y(0.7)} T ${X(0.85)} ${Y(0.62)} T ${X(1.2)} ${Y(0.66)} T ${X(1.6)} ${Y(0.62)} L ${X(1.6)} ${Y(1.6)} L ${X(-0.6)} ${Y(1.6)} Z`} fill="url(#mq-hill)" />
        <path d={`M ${X(-0.6)} ${Y(0.88)} Q ${X(-0.2)} ${Y(0.82)} 0 ${Y(0.9)} Q ${X(0.3)} ${Y(0.8)} ${X(0.6)} ${Y(0.9)} T ${X(1)} ${Y(0.86)} T ${X(1.6)} ${Y(0.88)} L ${X(1.6)} ${Y(1.6)} L ${X(-0.6)} ${Y(1.6)} Z`} fill="#26a364" opacity="0.9" />
        {towers.map(([x, y, h], index) => {
          const up = index % 2 === 0;
          const cx = X(x);
          const base = Y(y);
          return (
            <g key={index} className={styles.sway}>
              <line x1={cx} x2={cx} y1={base - h - 16} y2={base} stroke={up ? "#0f6b44" : "#9b2c3a"} strokeWidth="4" strokeLinecap="round" />
              <rect x={cx - 11} y={base - h} width="22" height={h * 0.75} rx="4" fill={up ? "#3fe08d" : "#ff6b7a"} stroke="rgba(0,0,0,.2)" strokeWidth="2" />
            </g>
          );
        })}
        {/* Market house with a chart on its roof sign. */}
        <g transform={`translate(${X(wide ? 0.5 : 0.7)} ${Y(wide ? 0.9 : 0.86)})`}>
          <rect x="-46" y="-40" width="92" height="44" rx="6" fill="#fff4dc" stroke="#7a5a2a" strokeWidth="3" />
          <path d="M -54 -40 L 0 -76 L 54 -40 Z" fill="#ff7a6b" stroke="#7a3a2a" strokeWidth="3" strokeLinejoin="round" />
          <rect x="-12" y="-22" width="24" height="26" rx="3" fill="#7a5a2a" />
          <rect x="-36" y="-30" width="16" height="14" rx="2" fill="#38e1ff" opacity="0.8" />
          <rect x="20" y="-30" width="16" height="14" rx="2" fill="#38e1ff" opacity="0.8" />
          <polyline points="-20,-52 -8,-60 4,-54 18,-66" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        {coins.map(([x, y], index) => (
          <g key={index} className={styles.coin}>
            <circle cx={X(x)} cy={Y(y)} r="13" fill="url(#mq-coin)" stroke="#a86b00" strokeWidth="2" />
            <text x={X(x)} y={Y(y) + 5} textAnchor="middle" fontSize="14" fontWeight="900" fill="#a86b00">₹</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
