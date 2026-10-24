import { Emblem } from "./emblems";
import { INK, rand, type RegionProps } from "./shared";

/** Lit and dark window colours; lit windows grow with the chapter's progress. */
const LIT = ["#ffe08a", "#9fe9ff", "#ffd27a"];

function Windows({ x, y, w, h, seed, lit, cols = 3 }: { x: number; y: number; w: number; h: number; seed: number; lit: number; cols?: number }) {
  const out = [];
  const gapX = w / cols;
  const rows = Math.max(1, Math.floor(h / 22));
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const on = rand(seed + row * 7 + col * 13) < lit;
      out.push(<rect key={`${row}-${col}`} className={on && (row + col) % 5 === 0 ? "mq-twinkle" : undefined} x={x + col * gapX + gapX * 0.22} y={y + 8 + row * 22} width={gapX * 0.56} height="11" rx="2" fill={on ? LIT[(row + col) % 3] : "#1c2b45"} opacity={on ? 0.95 : 0.8} />);
    }
  }
  return <>{out}</>;
}

/** A ticker board whose bars scroll: green and red market data on a dark screen. */
function Ticker({ x, y, w, accent }: { x: number; y: number; w: number; accent: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height="26" rx="5" fill="#06101f" stroke={INK} strokeWidth="2.5" />
      <svg x={x + 4} y={y + 3} width={w - 8} height="20" overflow="hidden">
        <g className="mq-ticker-scroll">
          {Array.from({ length: 14 }, (_, index) => {
            const up = index % 3 !== 1;
            const height = 5 + ((index * 37) % 11);
            return <rect key={index} x={index * 16} y={up ? 14 - height : 6} width="9" height={height} rx="1.5" fill={up ? "#3fe08d" : "#ff6b7a"} />;
          })}
        </g>
      </svg>
      <rect x={x} y={y} width={w} height="26" rx="5" fill="none" stroke={accent} strokeWidth="1.5" opacity="0.6" />
    </g>
  );
}

/** The chapter's landmark building, standing on its baseline at (0, 0); about 320 × 300 units. */
function Landmark({ index, accent, lit, complete }: { index: number; accent: string; lit: number; complete: boolean }) {
  const glass = "#173a63";
  const beacon = <circle className="mq-glow" cx="0" cy="0" r="6" fill={complete ? "#ffc83d" : accent} />;
  const sign = (y: number) => (
    <g transform={`translate(0 ${y})`}>
      <rect x="-38" y="-30" width="76" height="60" rx="12" fill="#081426" stroke={accent} strokeWidth="3" />
      <g transform="scale(1.05)"><Emblem index={index} accent={accent} /></g>
    </g>
  );
  switch (index % 7) {
    case 0: // Stock Market Square: the exchange, its ticker and two towers.
      return (
        <g>
          <rect x="-160" y="-250" width="64" height="250" rx="5" fill={glass} stroke={INK} strokeWidth="3" />
          <Windows x={-160} y={-246} w={64} h={230} seed={11} lit={lit} />
          <rect x="98" y="-276" width="62" height="276" rx="5" fill="#1d4673" stroke={INK} strokeWidth="3" />
          <Windows x={98} y={-272} w={62} h={256} seed={23} lit={lit} />
          <rect x="-128" y="-26" width="256" height="26" rx="4" fill="#d9cfb8" stroke={INK} strokeWidth="3" />
          {[-96, -58, -20, 18, 56, 94].map((x) => <rect key={x} x={x - 2} y="-128" width="16" height="102" rx="3" fill="#fffaf0" stroke={INK} strokeWidth="2.5" />)}
          <path d="M -136 -128 L 0 -186 L 136 -128 Z" fill="#fffaf0" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <Ticker x={-100} y={-160} w={200} accent={accent} />
          <g transform="translate(0 -200)">{beacon}</g>
        </g>
      );
    case 1: // Candlestick Plaza: three glass towers shaped like candles.
      return (
        <g>
          {[[-90, -230, -40, "#1fae63"], [0, -270, -70, "#e8574f"], [90, -210, -30, "#1fae63"]].map(([x, top, bodyTop, colour]) => (
            <g key={String(x)}>
              <rect x={Number(x) - 5} y={Number(top)} width="10" height={-Number(top)} fill="#c9d6e6" stroke={INK} strokeWidth="2.5" />
              <rect x={Number(x) - 34} y={Number(top) + 40} width="68" height={-Number(top) - 40 + Number(bodyTop)} rx="8" fill={String(colour)} stroke={INK} strokeWidth="3" />
              <Windows x={Number(x) - 30} y={Number(top) + 44} w={60} h={-Number(top) - 70 + Number(bodyTop)} seed={Number(x) + 40} lit={lit} cols={2} />
            </g>
          ))}
          <rect x="-150" y="-20" width="300" height="20" rx="4" fill="#2a3a55" stroke={INK} strokeWidth="3" />
          <g transform="translate(0 -290)">{beacon}</g>
        </g>
      );
    case 2: // Trend Avenue: a stepped tower rising to the right, with a neon trend line.
      return (
        <g>
          <path d="M -150 0 L -150 -110 L -80 -110 L -80 -170 L -10 -170 L -10 -230 L 60 -230 L 60 -290 L 140 -290 L 140 0 Z" fill={glass} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <Windows x={-146} y={-106} w={66} h={96} seed={51} lit={lit} />
          <Windows x={-76} y={-166} w={66} h={156} seed={52} lit={lit} />
          <Windows x={-6} y={-226} w={66} h={216} seed={53} lit={lit} />
          <Windows x={64} y={-286} w={72} h={276} seed={54} lit={lit} />
          <polyline className="mq-neon" points="-140,-130 -70,-190 0,-170 70,-250 130,-310" fill="none" stroke={accent} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          <g transform="translate(130 -310)">{beacon}</g>
        </g>
      );
    case 3: // Indicator Heights: a slim tower with a dish and a signal screen.
      return (
        <g>
          <rect x="-46" y="-260" width="92" height="260" rx="6" fill="#1d4673" stroke={INK} strokeWidth="3" />
          <Windows x={-42} y={-200} w={84} h={190} seed={61} lit={lit} cols={4} />
          <ellipse cx="0" cy="-268" rx="60" ry="16" fill="#c9d6e6" stroke={INK} strokeWidth="3" />
          <line x1="0" x2="0" y1="-268" y2="-300" stroke={INK} strokeWidth="3" />
          <g transform="translate(0 -300)">{beacon}</g>
          <rect x="-150" y="-150" width="90" height="70" rx="8" fill="#081426" stroke={accent} strokeWidth="3" />
          <path className="mq-neon" d="M -142 -112 C -128 -150, -112 -150, -104 -114 S -80 -80, -68 -112" fill="none" stroke={accent} strokeWidth="3.5" strokeLinecap="round" />
          <rect x="70" y="-120" width="90" height="120" rx="5" fill={glass} stroke={INK} strokeWidth="3" />
          <Windows x={74} y={-116} w={82} h={110} seed={62} lit={lit} />
        </g>
      );
    case 4: // Risk Vault District: a bank vault with a round door and a shield.
      return (
        <g>
          <rect x="-150" y="-140" width="300" height="140" rx="8" fill="#2c3d5a" stroke={INK} strokeWidth="3" />
          <path d="M -165 -140 L 0 -200 L 165 -140 Z" fill="#3a4f72" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <circle cx="0" cy="-70" r="52" fill="#9aa8bf" stroke={INK} strokeWidth="3" />
          <circle cx="0" cy="-70" r="38" fill="#c9d6e6" stroke={INK} strokeWidth="2.5" />
          <g className="mq-vault-wheel" style={{ transformOrigin: "0px -70px" }}>
            {[0, 60, 120].map((angle) => <line key={angle} x1="-26" x2="26" y1="-70" y2="-70" stroke={INK} strokeWidth="4" strokeLinecap="round" transform={`rotate(${angle} 0 -70)`} />)}
          </g>
          {sign(-250)}
          <Windows x={-140} y={-130} w={70} h={110} seed={71} lit={lit} cols={2} />
          <Windows x={72} y={-130} w={70} h={110} seed={72} lit={lit} cols={2} />
        </g>
      );
    case 5: // Options Exchange Tower: twin towers joined by a sky bridge, calls up and puts down.
      return (
        <g>
          <rect x="-130" y="-290" width="90" height="290" rx="6" fill={glass} stroke={INK} strokeWidth="3" />
          <rect x="40" y="-250" width="90" height="250" rx="6" fill="#1d4673" stroke={INK} strokeWidth="3" />
          <Windows x={-126} y={-286} w={82} h={276} seed={81} lit={lit} />
          <Windows x={44} y={-246} w={82} h={236} seed={82} lit={lit} />
          <rect x="-40" y="-190" width="80" height="26" rx="6" fill="#2a5a8a" stroke={INK} strokeWidth="3" />
          <path className="mq-neon" d="M -85 -320 L -85 -350 M -97 -338 L -85 -352 L -73 -338" fill="none" stroke="#3fe08d" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          <path className="mq-neon" d="M 85 -282 L 85 -262 M 73 -274 L 85 -260 L 97 -274" fill="none" stroke="#ff6b7a" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          <g transform="translate(-85 -300)">{beacon}</g>
        </g>
      );
    default: // Trading Champions Arena: a stadium with light masts and a trophy.
      return (
        <g>
          <ellipse cx="0" cy="-40" rx="170" ry="54" fill="#2a3a5c" stroke={INK} strokeWidth="3" />
          <ellipse cx="0" cy="-52" rx="140" ry="36" fill="#1fae63" stroke={INK} strokeWidth="3" />
          <ellipse cx="0" cy="-52" rx="70" ry="16" fill="none" stroke="#fff" strokeWidth="2" opacity="0.6" />
          {[-150, 150].map((x) => (
            <g key={x}>
              <line x1={x} x2={x} y1="-40" y2="-200" stroke="#c9d6e6" strokeWidth="5" />
              <rect x={x - 22} y="-214" width="44" height="18" rx="4" fill="#fffaf0" stroke={INK} strokeWidth="2.5" />
              <path className="mq-beam-soft" d={`M ${x} -200 L ${x > 0 ? x - 120 : x + 120} -60 L ${x > 0 ? x - 40 : x + 40} -60 Z`} fill="#fff6c2" opacity="0.18" />
            </g>
          ))}
          {sign(-150)}
          <g transform="translate(0 -196)">{beacon}</g>
        </g>
      );
  }
}

/** Small props along the road: a street lamp, a mini tower or a ticker board. */
function Prop({ variant, accent, lit }: { variant: number; accent: string; lit: number }) {
  switch (variant % 3) {
    case 0:
      return <g><line x1="0" x2="0" y1="0" y2="-58" stroke="#c9d6e6" strokeWidth="4" /><path d="M 0 -58 L 14 -58" stroke="#c9d6e6" strokeWidth="4" strokeLinecap="round" /><circle className="mq-glow" cx="16" cy="-56" r="7" fill="#ffe08a" /></g>;
    case 1:
      return <g><rect x="-22" y="-80" width="44" height="80" rx="4" fill="#1a3a5e" stroke={INK} strokeWidth="2.5" /><Windows x={-20} y={-78} w={40} h={70} seed={variant * 9} lit={lit} cols={2} /></g>;
    default:
      return <g><line x1="-20" x2="-20" y1="0" y2="-30" stroke="#c9d6e6" strokeWidth="3" /><line x1="20" x2="20" y1="0" y2="-30" stroke="#c9d6e6" strokeWidth="3" /><Ticker x={-34} y={-58} w={68} accent={accent} /></g>;
  }
}

/** Market Metropolis: one chapter district (skyline, streets, landmark and props). */
export function MetropolisRegion({ index, box, width, wide, anchor, progress, complete, region }: RegionProps) {
  const lit = 0.18 + progress * 0.72;
  const skylineY = box.top + (wide ? 150 : 175);
  return (
    <g>
      {/* Distant skyline across the whole width (and past it on wide screens). */}
      <g opacity="0.55">
        {Array.from({ length: wide ? 30 : 14 }, (_, item) => {
          const w = 50 + rand(index * 31 + item) * 50;
          const h = 70 + rand(index * 17 + item * 3) * 140;
          const x = -width * 0.6 + item * (width * 2.2 / (wide ? 30 : 14));
          return (
            <g key={item}>
              <rect x={x} y={skylineY - h} width={w} height={h} fill="#132544" />
              {Array.from({ length: Math.floor(h / 26) }, (_, row) => rand(item * 5 + row + index) < lit ? <rect key={row} x={x + w * 0.3} y={skylineY - h + 10 + row * 26} width={w * 0.4} height="8" fill="#ffe08a" opacity="0.5" /> : null)}
            </g>
          );
        })}
      </g>
      {/* City blocks: streets on a grid below the skyline. */}
      <g stroke="#9fe9ff" strokeWidth="2" opacity="0.07">
        {Array.from({ length: Math.ceil(box.height / 120) }, (_, row) => <line key={`h${row}`} x1={-width} x2={width * 2} y1={skylineY + 40 + row * 120} y2={skylineY + 40 + row * 120} />)}
        {Array.from({ length: wide ? 14 : 7 }, (_, col) => <line key={`v${col}`} x1={col * 120 - 60} x2={col * 120 - 60} y1={skylineY} y2={box.top + box.height} />)}
      </g>
      <g transform={`translate(${anchor.x} ${anchor.y}) scale(${anchor.scale})`}>
        <ellipse cx="0" cy="4" rx="200" ry="26" fill="#000" opacity="0.3" />
        <ellipse cx="0" cy="-10" rx="190" ry="120" fill={region.accent} opacity={0.05 + progress * 0.1} />
        <Landmark index={index} accent={region.accent} lit={lit} complete={complete} />
      </g>
      {box.nodes.map((node, item) => {
        const away = wide ? (node.x > width / 2 ? -300 : 300) : node.x > width / 2 ? -205 : 205;
        const x = Math.max(50, Math.min(width - 50, node.x + away + (rand(index * 7 + item) - 0.5) * (wide ? 60 : 30)));
        return (
          <g key={item}>
            <g transform={`translate(${x} ${node.y + 36}) scale(${wide ? 1 : 0.85})`}><Prop variant={item + index} accent={region.accent} lit={lit} /></g>
            {wide ? <g transform={`translate(${item % 2 ? -80 : width + 80} ${node.y + 30})`}><Prop variant={item + 1} accent={region.accent} lit={lit} /></g> : null}
          </g>
        );
      })}
    </g>
  );
}
