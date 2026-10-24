/**
 * One emblem per chapter (exchange, candles, trend, indicator, shield, options, trophy), drawn around
 * (0, 0) in about 44 × 44 units. Every world builds its landmarks around these, so a chapter's idea
 * reads the same in any world.
 */
export function Emblem({ index, color = "#fff", accent = "#ffc83d" }: { index: number; color?: string; accent?: string }) {
  const stroke = { fill: "none", stroke: color, strokeWidth: 3.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (index % 7) {
    case 0:
      return (
        <g>
          <path d="M -18 -8 L 0 -18 L 18 -8 Z" {...stroke} />
          {[-12, -4, 4, 12].map((x) => <line key={x} x1={x} x2={x} y1="-6" y2="12" {...stroke} />)}
          <line x1="-19" x2="19" y1="15" y2="15" {...stroke} />
        </g>
      );
    case 1:
      return (
        <g>
          {[[-12, -16, 14, -8, 6, "#3fe08d"], [0, -18, 12, -12, 2, "#ff6b7a"], [12, -14, 16, -4, 10, "#3fe08d"]].map(([x, top, bottom, bodyTop, bodyBottom, fill]) => (
            <g key={String(x)}>
              <line x1={Number(x)} x2={Number(x)} y1={Number(top)} y2={Number(bottom)} stroke={color} strokeWidth="2.6" strokeLinecap="round" />
              <rect x={Number(x) - 4.5} y={Number(bodyTop)} width="9" height={Number(bodyBottom) - Number(bodyTop)} rx="2" fill={String(fill)} />
            </g>
          ))}
        </g>
      );
    case 2:
      return (
        <g>
          <polyline points="-18,14 -7,2 1,8 16,-12" {...stroke} />
          <path d="M 7 -13 L 17 -13 L 17 -3" {...stroke} />
        </g>
      );
    case 3:
      return (
        <g>
          <path d="M -19 4 C -13 -14, -7 -14, -2 2 S 9 18, 14 0" {...stroke} />
          <circle cx="16" cy="-6" r="3.4" fill={accent} />
          <line x1="-19" x2="19" y1="15" y2="15" {...stroke} strokeWidth={2} opacity="0.6" />
        </g>
      );
    case 4:
      return (
        <g>
          <path d="M 0 -18 L 15 -12 L 15 0 Q 15 12 0 18 Q -15 12 -15 0 L -15 -12 Z" {...stroke} />
          <polyline points="-6,1 -1,6 7,-5" {...stroke} stroke={accent} />
        </g>
      );
    case 5:
      return (
        <g>
          <path d="M -8 14 L -8 -10 M -15 -3 L -8 -11 L -1 -3" {...stroke} stroke="#3fe08d" />
          <path d="M 8 -14 L 8 10 M 1 3 L 8 11 L 15 3" {...stroke} stroke="#ff6b7a" />
        </g>
      );
    default:
      return (
        <g>
          <path d="M -11 -16 L 11 -16 L 10 -4 Q 0 6 -10 -4 Z" {...stroke} />
          <path d="M -11 -13 Q -19 -12 -14 -4 M 11 -13 Q 19 -12 14 -4" {...stroke} strokeWidth={2.4} />
          <line x1="0" x2="0" y1="3" y2="11" {...stroke} />
          <line x1="-8" x2="8" y1="13" y2="13" {...stroke} />
          <circle cx="0" cy="-10" r="2.6" fill={accent} />
        </g>
      );
  }
}
