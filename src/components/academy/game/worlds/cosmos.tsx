import { Emblem } from "./emblems";
import { INK, rand, type RegionProps } from "./shared";

const PLANETS: Array<[string, string]> = [["#5ad1ff", "#1f4fb8"], ["#c9a2ff", "#5b2fb8"], ["#6ff0b0", "#147a5c"], ["#8fd7ff", "#2a3f9a"], ["#ffd27a", "#b5651d"], ["#ff9ad1", "#7a2fa8"], ["#7ff7ec", "#16707a"]];

/** Small candlesticks orbiting a landmark (the ring turns slowly). */
function Orbiters({ radius, accent, count = 5 }: { radius: number; accent: string; count?: number }) {
  return (
    <g className="mq-orbit">
      <ellipse cx="0" cy="0" rx={radius} ry={radius * 0.32} fill="none" stroke={accent} strokeWidth="1.5" strokeDasharray="3 7" opacity="0.5" />
      {Array.from({ length: count }, (_, index) => {
        const angle = (index / count) * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius * 0.32;
        const up = index % 2 === 0;
        return (
          <g key={index} transform={`translate(${x} ${y})`}>
            <line x1="0" x2="0" y1="-9" y2="9" stroke="#e6ecff" strokeWidth="1.6" />
            <rect x="-3.5" y={up ? -6 : -3} width="7" height="9" rx="1.5" fill={up ? "#3fe08d" : "#ff6b7a"} />
          </g>
        );
      })}
    </g>
  );
}

function Planet({ index, r, ring, accent }: { index: number; r: number; ring: boolean; accent: string }) {
  const [light, dark] = PLANETS[index % PLANETS.length];
  const id = `cosmos-planet-${index}`;
  return (
    <g>
      <defs>
        <radialGradient id={id} cx="0.35" cy="0.3" r="0.85">
          <stop offset="0" stopColor={light} />
          <stop offset="1" stopColor={dark} />
        </radialGradient>
      </defs>
      {ring ? <ellipse cx="0" cy="0" rx={r * 1.65} ry={r * 0.42} fill="none" stroke={accent} strokeWidth="7" opacity="0.45" transform="rotate(-14)" /> : null}
      <circle cx="0" cy="0" r={r} fill={`url(#${id})`} stroke={INK} strokeWidth="3" />
      {[[-0.3, -0.2, 0.22], [0.25, 0.3, 0.14], [0.1, -0.45, 0.1]].map(([x, y, size], item) => <circle key={item} cx={x * r} cy={y * r} r={size * r} fill="#000" opacity="0.12" />)}
      {ring ? <path d={`M ${-r * 1.6} ${r * 0.18} A ${r * 1.65} ${r * 0.42} 0 0 0 ${r * 1.6} ${-r * 0.18}`} fill="none" stroke={accent} strokeWidth="7" opacity="0.75" transform="rotate(-14)" /> : null}
    </g>
  );
}

/** The chapter's landmark, centred on (0, -140); about 340 × 300 units. */
function Landmark({ index, accent, complete }: { index: number; accent: string; complete: boolean }) {
  const badge = (
    <g transform="translate(0 0)">
      <circle r="30" fill="#0b0d2b" stroke={complete ? "#ffc83d" : accent} strokeWidth="3" />
      <g transform="scale(0.95)"><Emblem index={index} accent={accent} /></g>
    </g>
  );
  switch (index % 7) {
    case 1: // Candle Nebula: a cloud of glowing candle crystals.
      return (
        <g transform="translate(0 -150)">
          <ellipse rx="170" ry="90" fill={accent} opacity="0.12" />
          <ellipse rx="110" ry="60" fill="#ff9ad1" opacity="0.12" />
          {[[-90, 10, 70, true], [-40, -30, 100, false], [10, 0, 80, true], [60, -40, 110, true], [110, 10, 60, false]].map(([x, y, h, up]) => (
            <g key={String(x)} className="mq-float" style={{ animationDelay: `${Number(x) * 10}ms` }} transform={`translate(${x} ${y})`}>
              <line x1="0" x2="0" y1={-Number(h) / 2 - 16} y2={Number(h) / 2 + 16} stroke="#e6ecff" strokeWidth="3" />
              <rect x="-13" y={-Number(h) / 2} width="26" height={Number(h)} rx="5" fill={up ? "#3fe08d" : "#ff6b7a"} stroke={INK} strokeWidth="2.5" />
            </g>
          ))}
          <g transform="translate(0 100)">{badge}</g>
        </g>
      );
    case 3: // Trend Observatory: a planet with a telescope dome.
      return (
        <g transform="translate(0 -130)">
          <Planet index={index} r={95} ring={false} accent={accent} />
          <path d="M -50 -84 A 50 44 0 0 1 50 -84 Z" fill="#dfe6ff" stroke={INK} strokeWidth="3" />
          <rect x="-4" y="-150" width="40" height="18" rx="6" fill="#8d82e6" stroke={INK} strokeWidth="2.5" transform="rotate(-35 0 -110)" />
          <polyline points="-150,-130 -110,-160 -70,-140 -30,-190" fill="none" stroke={accent} strokeWidth="2" strokeDasharray="4 6" />
          {[[-150, -130], [-110, -160], [-70, -140], [-30, -190]].map(([x, y]) => <circle key={x} className="mq-twinkle" cx={x} cy={y} r="4" fill="#fff" />)}
          <Orbiters radius={150} accent={accent} />
          <g transform="translate(0 20)">{badge}</g>
        </g>
      );
    case 4: // Risk Control Station: a ring station with modules and a shield.
      return (
        <g transform="translate(0 -140)">
          <g className="mq-orbit">
            <ellipse rx="140" ry="44" fill="none" stroke="#c9d6e6" strokeWidth="12" />
            <ellipse rx="140" ry="44" fill="none" stroke={INK} strokeWidth="2" />
            {[0, 1, 2, 3].map((item) => { const a = (item / 4) * Math.PI * 2; return <rect key={item} x={Math.cos(a) * 140 - 16} y={Math.sin(a) * 44 - 10} width="32" height="20" rx="5" fill="#2a3f9a" stroke={INK} strokeWidth="2.5" />; })}
          </g>
          <rect x="-26" y="-90" width="52" height="150" rx="14" fill="#dfe6ff" stroke={INK} strokeWidth="3" />
          <circle className="mq-glow" cx="0" cy="-96" r="8" fill={complete ? "#ffc83d" : accent} />
          {badge}
        </g>
      );
    case 5: // Options Galaxy: a spiral of stars around a core.
      return (
        <g transform="translate(0 -140)">
          <g className="mq-orbit-slow">
            {Array.from({ length: 36 }, (_, item) => { const a = item * 0.55; const d = 18 + item * 4.2; return <circle key={item} cx={Math.cos(a) * d} cy={Math.sin(a) * d * 0.55} r={2 + (item % 3)} fill={item % 2 ? accent : "#fff"} opacity={0.4 + (item % 4) * 0.15} />; })}
          </g>
          <circle r="34" fill={accent} opacity="0.25" />
          {badge}
        </g>
      );
    default: // A trading planet (rings on some), with its emblem badge and orbiting candles.
      return (
        <g transform="translate(0 -140)">
          <Planet index={index} r={index === 6 ? 80 : 100} ring={index % 2 === 0} accent={accent} />
          <Orbiters radius={index === 6 ? 130 : 160} accent={accent} count={index === 0 ? 6 : 4} />
          <g transform="translate(0 0)">{badge}</g>
          {index === 6 ? <g><line x1="0" x2="0" y1="-80" y2="-128" stroke="#e6ecff" strokeWidth="3" /><path className="mq-flag" d="M 0 -128 L 30 -120 L 0 -110 Z" fill={complete ? "#ffc83d" : "#ff7a6b"} stroke={INK} strokeWidth="2" /></g> : null}
        </g>
      );
  }
}

function Prop({ variant, accent }: { variant: number; accent: string }) {
  switch (variant % 3) {
    case 0: {
      const [light, dark] = PLANETS[(variant + 2) % PLANETS.length];
      return <g className="mq-float"><circle r="16" fill={dark} stroke={INK} strokeWidth="2" /><circle cx="-5" cy="-5" r="7" fill={light} opacity="0.55" /></g>;
    }
    case 1:
      return <g className="mq-float" style={{ animationDelay: "-1.2s" }}><line x1="0" x2="0" y1="-20" y2="20" stroke="#e6ecff" strokeWidth="2" /><rect x="-6" y="-12" width="12" height="20" rx="2" fill={variant % 2 ? "#ff6b7a" : "#3fe08d"} stroke={INK} strokeWidth="2" /></g>;
    default:
      return <g className="mq-comet"><line x1="-40" y1="14" x2="0" y2="0" stroke={accent} strokeWidth="3" strokeLinecap="round" opacity="0.6" /><circle r="5" fill="#fff" /></g>;
  }
}

/** Candlestick Cosmos: one chapter's sector of space (stars, nebula, landmark and drifting props). */
export function CosmosRegion({ index, box, width, wide, anchor, progress, complete, region }: RegionProps) {
  const glow = 0.3 + progress * 0.7;
  return (
    <g>
      <defs>
        <radialGradient id={`nebula-${index}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={region.accent} stopOpacity="0.32" />
          <stop offset="1" stopColor={region.accent} stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx={width * (box.side === "right" ? 0.25 : 0.75)} cy={box.top + box.height * 0.55} rx={wide ? 420 : 260} ry={wide ? 220 : 180} fill={`url(#nebula-${index})`} opacity={glow} />
      <ellipse cx={width * (box.side === "right" ? 0.85 : 0.15)} cy={box.top + box.height * 0.2} rx={wide ? 300 : 200} ry={150} fill={`url(#nebula-${index})`} opacity={0.6 * glow} />
      {Array.from({ length: wide ? 70 : 34 }, (_, item) => (
        <circle key={item} className={item % 6 === 0 ? "mq-twinkle" : undefined} cx={-width * 0.4 + rand(index * 101 + item) * width * 1.8} cy={box.top + rand(index * 53 + item * 7) * box.height} r={item % 9 === 0 ? 2.6 : 1.3} fill="#fff" opacity={0.35 + rand(item) * 0.5 * glow} />
      ))}
      <g transform={`translate(${anchor.x} ${anchor.y}) scale(${anchor.scale})`}>
        <Landmark index={index} accent={region.accent} complete={complete} />
      </g>
      {box.nodes.map((node, item) => {
        const away = wide ? (node.x > width / 2 ? -290 : 290) : node.x > width / 2 ? -200 : 200;
        const x = Math.max(40, Math.min(width - 40, node.x + away + (rand(index * 3 + item) - 0.5) * 60));
        return (
          <g key={item}>
            <g transform={`translate(${x} ${node.y + 10})`}><Prop variant={item + index} accent={region.accent} /></g>
            {wide ? <g transform={`translate(${item % 2 ? -90 : width + 90} ${node.y})`}><Prop variant={item + 2} accent={region.accent} /></g> : null}
          </g>
        );
      })}
    </g>
  );
}
