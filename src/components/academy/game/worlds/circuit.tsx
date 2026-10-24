import { Emblem } from "./emblems";
import { INK, rand, type RegionProps } from "./shared";

const BODY = "#1a2330";
const EDGE = "#2c3a4d";

/** A chip: rounded body, pins on every side and the chapter emblem printed on top. */
function Chip({ size, index, accent, on }: { size: number; index: number; accent: string; on: boolean }) {
  const half = size / 2;
  const pins = 6;
  return (
    <g>
      {Array.from({ length: pins }, (_, item) => {
        const offset = -half + ((item + 0.5) * size) / pins;
        return (
          <g key={item} fill="#9aa8bf">
            <rect x={offset - 4} y={-half - 14} width="8" height="14" rx="2" />
            <rect x={offset - 4} y={half} width="8" height="14" rx="2" />
            <rect x={-half - 14} y={offset - 4} width="14" height="8" rx="2" />
            <rect x={half} y={offset - 4} width="14" height="8" rx="2" />
          </g>
        );
      })}
      <rect x={-half} y={-half} width={size} height={size} rx="14" fill={BODY} stroke={on ? accent : EDGE} strokeWidth="3.5" />
      <rect x={-half + 12} y={-half + 12} width={size - 24} height={size - 24} rx="10" fill="#0e151f" stroke={EDGE} strokeWidth="2" />
      <g transform={`scale(${size / 90})`}><Emblem index={index} color={on ? "#e6f7ff" : "#7f8fa6"} accent={accent} /></g>
      <circle className={on ? "mq-glow" : undefined} cx={half - 14} cy={-half + 14} r="4" fill={on ? accent : "#3a4658"} />
    </g>
  );
}

function Screen({ w, h, accent, children }: { w: number; h: number; accent: string; children: React.ReactNode }) {
  return (
    <g>
      <rect x={-w / 2} y={-h} width={w} height={h} rx="10" fill={BODY} stroke={INK} strokeWidth="3" />
      <rect x={-w / 2 + 10} y={-h + 10} width={w - 20} height={h - 20} rx="6" fill="#06111b" stroke={accent} strokeWidth="1.5" strokeOpacity="0.6" />
      {children}
    </g>
  );
}

/** The chapter's landmark, standing on its baseline at (0, 0); about 320 × 300 units. */
function Landmark({ index, accent, on }: { index: number; accent: string; on: boolean }) {
  switch (index % 7) {
    case 1: // Candle Analysis Lab: a monitor with a live candle chart.
      return (
        <g>
          <rect x="-12" y="-40" width="24" height="40" fill={EDGE} />
          <g transform="translate(0 -40)">
            <Screen w={280} h={200} accent={accent}>
              {[[-110, 50, 30, true], [-75, 30, 40, false], [-40, 40, 50, true], [-5, 10, 36, true], [30, 30, 30, false], [65, 0, 50, true], [100, -20, 46, true]].map(([x, y, h, up]) => (
                <g key={String(x)}>
                  <line x1={Number(x)} x2={Number(x)} y1={-100 + Number(y) - 12} y2={-100 + Number(y) + Number(h) + 12} stroke="#9fe9ff" strokeWidth="2" opacity="0.7" />
                  <rect x={Number(x) - 8} y={-100 + Number(y)} width="16" height={Number(h)} rx="2" fill={up ? "#3fe08d" : "#ff6b7a"} />
                </g>
              ))}
              <line className="mq-scan" x1="-128" x2="128" y1="-180" y2="-180" stroke={accent} strokeWidth="2" opacity="0.7" />
            </Screen>
          </g>
          <g transform="translate(118 -250) scale(.5)"><Chip size={90} index={index} accent={accent} on={on} /></g>
        </g>
      );
    case 2: // Trend Engine: a turning gear driving a rising signal.
      return (
        <g transform="translate(0 -140)">
          <g className="mq-gear" style={{ transformOrigin: "-60px 0px" }}>
            {Array.from({ length: 10 }, (_, item) => <rect key={item} x="-72" y="-96" width="24" height="30" rx="5" fill={EDGE} transform={`rotate(${item * 36} -60 0)`} />)}
            <circle cx="-60" cy="0" r="74" fill={BODY} stroke={on ? accent : EDGE} strokeWidth="4" />
            <circle cx="-60" cy="0" r="22" fill="#0e151f" stroke={EDGE} strokeWidth="3" />
          </g>
          <g transform="translate(-60 0) scale(.9)"><Emblem index={index} color="#e6f7ff" accent={accent} /></g>
          <polyline className="mq-neon" points="20,60 60,30 90,44 140,-30 170,-70" fill="none" stroke={accent} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="0" y="60" width="190" height="20" rx="6" fill={BODY} stroke={EDGE} strokeWidth="3" />
        </g>
      );
    case 3: // Signal Processor: an oscilloscope with a moving wave.
      return (
        <g>
          <Screen w={290} h={190} accent={accent}>
            <path className="mq-wave-run" d="M -130 -95 C -110 -150, -90 -150, -70 -95 S -30 -40, -10 -95 S 30 -150, 50 -95 S 90 -40, 110 -95 S 150 -150, 170 -95" fill="none" stroke={accent} strokeWidth="3.5" />
            {[-60, 0, 60].map((x) => <line key={x} x1={x} x2={x} y1="-180" y2="-10" stroke="#9fe9ff" strokeWidth="1" opacity="0.15" />)}
          </Screen>
          <g transform="translate(-112 -214) scale(.42)"><Chip size={90} index={index} accent={accent} on={on} /></g>
        </g>
      );
    case 4: // Risk Management Core: a reactor ring around a shield.
      return (
        <g transform="translate(0 -140)">
          <circle r="120" fill="none" stroke={EDGE} strokeWidth="14" />
          <circle className="mq-gear-slow" r="120" fill="none" stroke={on ? accent : "#3a4658"} strokeWidth="4" strokeDasharray="22 14" />
          <circle r="86" fill={BODY} stroke={INK} strokeWidth="3" />
          <circle className="mq-glow" r="60" fill={accent} opacity={on ? 0.22 : 0.08} />
          <g transform="scale(1.6)"><Emblem index={index} color="#e6f7ff" accent={accent} /></g>
        </g>
      );
    case 5: // Options Terminal: an order book (bids and asks) on a trading terminal.
      return (
        <g>
          <Screen w={300} h={210} accent={accent}>
            {Array.from({ length: 6 }, (_, row) => (
              <g key={row}>
                <rect x={-8 - (20 + rand(row + 3) * 100)} y={-190 + row * 28} width={20 + rand(row + 3) * 100} height="18" rx="3" fill="#3fe08d" opacity="0.75" />
                <rect x="8" y={-190 + row * 28} width={20 + rand(row + 9) * 100} height="18" rx="3" fill="#ff6b7a" opacity="0.75" />
              </g>
            ))}
            <line x1="0" x2="0" y1="-196" y2="-14" stroke="#e6f7ff" strokeWidth="2" opacity="0.4" />
          </Screen>
          <g transform="translate(130 -226) scale(.45)"><Chip size={90} index={index} accent={accent} on={on} /></g>
        </g>
      );
    case 6: // Strategy Mainframe: server racks with blinking lights.
      return (
        <g>
          {[-110, 0, 110].map((x, rack) => (
            <g key={x} transform={`translate(${x} 0)`}>
              <rect x="-46" y="-240" width="92" height="240" rx="8" fill={BODY} stroke={INK} strokeWidth="3" />
              {Array.from({ length: 8 }, (_, row) => (
                <g key={row}>
                  <rect x="-38" y={-230 + row * 28} width="76" height="20" rx="3" fill="#0e151f" stroke={EDGE} strokeWidth="1.5" />
                  <circle className={rand(rack * 11 + row) < 0.5 ? "mq-blink" : undefined} style={{ animationDelay: `${row * 170 + rack * 90}ms` }} cx="26" cy={-220 + row * 28} r="3.5" fill={rand(rack + row * 3) < (on ? 0.8 : 0.35) ? accent : "#3a4658"} />
                </g>
              ))}
            </g>
          ))}
          <g transform="translate(0 -290) scale(.6)"><Chip size={90} index={index} accent={accent} on={on} /></g>
        </g>
      );
    default: // Market Network: a large processor chip at the centre of the network.
      return (
        <g transform="translate(0 -140)">
          <Chip size={180} index={index} accent={accent} on={on} />
        </g>
      );
  }
}

function Prop({ variant, accent, on }: { variant: number; accent: string; on: boolean }) {
  switch (variant % 3) {
    case 0:
      return <g transform="translate(0 -20) scale(.36)"><Chip size={90} index={variant} accent={accent} on={on} /></g>;
    case 1:
      return <g><rect x="-10" y="-40" width="20" height="40" rx="6" fill="#2a5a8a" stroke={INK} strokeWidth="2" /><rect x="-10" y="-40" width="20" height="8" rx="4" fill="#9aa8bf" /></g>;
    default:
      return <g><rect x="-14" y="-14" width="28" height="14" rx="3" fill={BODY} stroke={EDGE} strokeWidth="2" /><circle className="mq-blink" cx="0" cy="-22" r="6" fill={on ? accent : "#3a4658"} /></g>;
  }
}

/** Trading Circuit: one chapter's board (grid, traces with data pulses, landmark and components). */
export function CircuitRegion({ index, box, width, wide, anchor, progress, complete, region }: RegionProps) {
  const on = progress > 0 || complete;
  const traces = wide ? 12 : 7;
  return (
    <g>
      <g stroke="#9fe9ff" strokeWidth="1" opacity="0.06">
        {Array.from({ length: Math.ceil(box.height / 40) }, (_, row) => <line key={`h${row}`} x1={-width} x2={width * 2} y1={box.top + row * 40} y2={box.top + row * 40} />)}
        {Array.from({ length: Math.ceil((width * 3) / 40) }, (_, col) => <line key={`v${col}`} x1={-width + col * 40} x2={-width + col * 40} y1={box.top} y2={box.top + box.height} />)}
      </g>
      {/* Circuit traces: they switch on (with travelling pulses) as the chapter is completed. */}
      {Array.from({ length: traces }, (_, item) => {
        const x = -width * 0.3 + rand(index * 41 + item) * width * 1.6;
        const y = box.top + 60 + rand(index * 29 + item * 5) * (box.height - 120);
        const run = 80 + rand(item * 3 + index) * 200;
        const turn = rand(item + index * 2) > 0.5 ? 1 : -1;
        const points = `${x},${y} ${x + run},${y} ${x + run + 40},${y + turn * 40} ${x + run + 40 + run * 0.6},${y + turn * 40}`;
        const live = rand(item * 13 + index) < progress;
        return (
          <g key={item}>
            <polyline points={points} fill="none" stroke={live ? region.accent : "#2c3a4d"} strokeWidth="3" opacity={live ? 0.55 : 0.6} strokeLinejoin="round" />
            {live ? <polyline className="mq-pulse" points={points} fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity="0.85" /> : null}
            <circle cx={x} cy={y} r="5" fill={live ? region.accent : "#2c3a4d"} />
          </g>
        );
      })}
      <g transform={`translate(${anchor.x} ${anchor.y}) scale(${anchor.scale})`}>
        <ellipse cx="0" cy="6" rx="190" ry="24" fill="#000" opacity="0.35" />
        <ellipse cx="0" cy="-120" rx="200" ry="150" fill={region.accent} opacity={on ? 0.06 + progress * 0.08 : 0.02} />
        <Landmark index={index} accent={region.accent} on={on} />
      </g>
      {box.nodes.map((node, item) => {
        const away = wide ? (node.x > width / 2 ? -300 : 300) : node.x > width / 2 ? -205 : 205;
        const x = Math.max(46, Math.min(width - 46, node.x + away + (rand(index * 5 + item) - 0.5) * 50));
        return (
          <g key={item}>
            <g transform={`translate(${x} ${node.y + 30}) scale(${wide ? 1 : 0.85})`}><Prop variant={item + index} accent={region.accent} on={on} /></g>
            {wide ? <g transform={`translate(${item % 2 ? -80 : width + 80} ${node.y + 24})`}><Prop variant={item + 1} accent={region.accent} on={on} /></g> : null}
          </g>
        );
      })}
    </g>
  );
}
