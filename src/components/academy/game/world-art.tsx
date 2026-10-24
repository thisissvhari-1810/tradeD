import { Anchor, CandlestickChart, Landmark as Exchange, MountainSnow, Shield, Telescope, TreePine, type LucideIcon } from "lucide-react";
import type { ChapterTheme } from "@/lib/academy/world";

/**
 * The world's artwork: each chapter's palette, its landmark and the small props along the road.
 * Original SVG drawings in one style (ink outline, soft shading); decorative only (aria-hidden).
 */

export type ThemeStyle = {
  /** Terrain colours from the top of the region to the bottom. */
  ground: [string, string];
  patch: string;
  accent: string;
  /** Stop platform colours. */
  face: [string, string];
  rim: string;
  glyph: LucideIcon;
};

export const THEME: Record<ChapterTheme, ThemeStyle> = {
  city: { ground: ["#123a5c", "#1a6461"], patch: "#1f7a70", accent: "#38e1ff", face: ["#7bf5ae", "#25b46c"], rim: "#157246", glyph: Exchange },
  canyon: { ground: ["#6e2f22", "#ad5436"], patch: "#c56a44", accent: "#ffb35a", face: ["#ffc89a", "#ef7d3c"], rim: "#9a4418", glyph: CandlestickChart },
  forest: { ground: ["#0f3a2b", "#1c6843"], patch: "#2a8a52", accent: "#9be15d", face: ["#c2f58a", "#5bbf3a"], rim: "#2f7a1c", glyph: TreePine },
  observatory: { ground: ["#16123b", "#2b236e"], patch: "#3a2f8a", accent: "#b79bff", face: ["#dccbff", "#8a5cf6"], rim: "#4b2fa8", glyph: Telescope },
  fortress: { ground: ["#242e3d", "#45556a"], patch: "#56677e", accent: "#ffc83d", face: ["#a9d6ff", "#3d84d6"], rim: "#1f4f8f", glyph: Shield },
  harbor: { ground: ["#06304a", "#0c6587"], patch: "#1590b0", accent: "#4ff0e0", face: ["#8af8ee", "#1bb5a8"], rim: "#0b6e66", glyph: Anchor },
  summit: { ground: ["#34466e", "#8ea5cc"], patch: "#c9d6f0", accent: "#ffffff", face: ["#ffc1a8", "#ff7a6b"], rim: "#b2432f", glyph: MountainSnow },
};

const INK = "#0d1726";

/** A chapter's landmark, standing on its baseline at (0, 0); about 340 × 260 units. */
export function LandmarkArt({ theme, complete }: { theme: ChapterTheme; complete: boolean }) {
  const flag = complete ? "#ffc83d" : "#e9eef6";
  switch (theme) {
    case "city":
      return (
        <g>
          <ellipse cx="0" cy="4" rx="190" ry="26" fill="rgba(0,0,0,.25)" />
          {/* Towers behind the exchange, a few windows lit. */}
          <rect x="-165" y="-236" width="64" height="236" rx="6" fill="#1d4a78" stroke={INK} strokeWidth="3" />
          <rect x="104" y="-262" width="60" height="262" rx="6" fill="#255d93" stroke={INK} strokeWidth="3" />
          <rect x="-92" y="-206" width="44" height="206" rx="5" fill="#2b6aa3" stroke={INK} strokeWidth="3" />
          {[[-152, -216], [-130, -216], [-152, -190], [-130, -164], [-152, -138], [116, -240], [140, -240], [116, -212], [140, -184], [116, -156], [-82, -186], [-64, -160]].map(([x, y], index) => (
            <rect key={index} className={index % 3 === 0 ? "mq-twinkle" : undefined} x={x} y={y} width="12" height="14" rx="2" fill={index % 2 ? "#ffe08a" : "#9fd8ff"} opacity={index % 4 === 1 ? 0.45 : 0.95} />
          ))}
          {/* The exchange: steps, columns, pediment and a ticker board. */}
          <rect x="-132" y="-24" width="264" height="24" rx="4" fill="#d9cfb8" stroke={INK} strokeWidth="3" />
          <rect x="-118" y="-36" width="236" height="14" rx="3" fill="#ece3cd" stroke={INK} strokeWidth="3" />
          {[-96, -58, -20, 18, 56, 94].map((x) => <rect key={x} x={x - 2} y="-124" width="16" height="88" rx="3" fill="#fffaf0" stroke={INK} strokeWidth="2.5" />)}
          <rect x="-128" y="-144" width="256" height="22" rx="4" fill="#f3ead6" stroke={INK} strokeWidth="3" />
          <path d="M -138 -144 L 0 -200 L 138 -144 Z" fill="#fffaf0" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <rect x="-56" y="-184" width="112" height="28" rx="5" fill={INK} />
          <polyline points="-46,-164 -30,-170 -16,-166 0,-178 16,-172 30,-178 46,-174" fill="none" stroke="#3fe08d" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="0" y1="-200" x2="0" y2="-236" stroke={INK} strokeWidth="3" />
          <path className="mq-flag" d="M 0 -236 L 30 -228 L 0 -218 Z" fill={flag} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        </g>
      );
    case "canyon":
      return (
        <g>
          <ellipse cx="0" cy="4" rx="190" ry="24" fill="rgba(0,0,0,.25)" />
          {/* Mesas */}
          <path d="M -180 0 L -160 -120 L -100 -132 L -80 0 Z" fill="#c4603b" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M -160 -120 L -100 -132 L -96 -110 L -158 -100 Z" fill="#e08458" />
          <path d="M 90 0 L 110 -150 L 170 -158 L 186 0 Z" fill="#b5543a" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M 110 -150 L 170 -158 L 172 -136 L 112 -130 Z" fill="#d97650" />
          {/* Giant candlesticks carved into the rock. */}
          <line x1="-40" y1="-232" x2="-40" y2="-40" stroke={INK} strokeWidth="5" strokeLinecap="round" />
          <rect x="-62" y="-196" width="44" height="120" rx="8" fill="#2fbf84" stroke={INK} strokeWidth="3" />
          <rect x="-56" y="-190" width="10" height="100" rx="5" fill="rgba(255,255,255,.3)" />
          <line x1="34" y1="-200" x2="34" y2="-30" stroke={INK} strokeWidth="5" strokeLinecap="round" />
          <rect x="12" y="-170" width="44" height="96" rx="8" fill="#ef5b52" stroke={INK} strokeWidth="3" />
          <rect x="18" y="-164" width="10" height="78" rx="5" fill="rgba(255,255,255,.3)" />
          {/* Rock plateau they stand on */}
          <path d="M -120 0 L -100 -44 L 100 -44 L 120 0 Z" fill="#d7774b" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M -100 -44 L 100 -44 L 94 -30 L -94 -30 Z" fill="#ee9a6c" />
          <line x1="150" y1="-158" x2="150" y2="-196" stroke={INK} strokeWidth="3" />
          <path className="mq-flag" d="M 150 -196 L 178 -188 L 150 -178 Z" fill={flag} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        </g>
      );
    case "forest":
      return (
        <g>
          <ellipse cx="0" cy="4" rx="190" ry="24" fill="rgba(0,0,0,.28)" />
          {[[-130, 0.8, "#1f7a44"], [130, 0.85, "#23824a"], [-62, 1.05, "#2a9a55"], [70, 1, "#2f9f5a"], [0, 1.3, "#38b062"]].map(([x, scale, colour]) => (
            <g key={String(x)} transform={`translate(${x} 0) scale(${scale})`}>
              <rect x="-7" y="-34" width="14" height="34" fill="#6b4226" stroke={INK} strokeWidth="2.5" />
              <path d="M 0 -170 L 52 -84 L 30 -84 L 62 -34 L -62 -34 L -30 -84 L -52 -84 Z" fill={String(colour)} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
              <path d="M 0 -170 L 18 -140 L -6 -120 Z" fill="rgba(255,255,255,.18)" />
            </g>
          ))}
          {/* A rising trendline strung through the trees. */}
          <polyline points="-170,-40 -100,-80 -30,-96 40,-140 110,-160 170,-210" fill="none" stroke="#9be15d" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          {[[-170, -40], [-100, -80], [-30, -96], [40, -140], [110, -160]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="7" fill="#e9ffd0" stroke={INK} strokeWidth="2.5" />)}
          <path d="M 170 -210 L 150 -206 L 164 -190 Z" fill="#9be15d" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
          <line x1="0" y1="-222" x2="0" y2="-254" stroke={INK} strokeWidth="3" />
          <path className="mq-flag" d="M 0 -254 L 28 -246 L 0 -236 Z" fill={flag} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        </g>
      );
    case "observatory":
      return (
        <g>
          {/* A constellation drawn like a price chart. */}
          <polyline points="-170,-170 -120,-220 -70,-190 -20,-246 40,-214" fill="none" stroke="#b79bff" strokeWidth="2" strokeDasharray="5 6" opacity="0.8" />
          {[[-170, -170], [-120, -220], [-70, -190], [-20, -246], [40, -214], [150, -250], [180, -200]].map(([x, y], index) => <circle key={index} className="mq-twinkle" cx={x} cy={y} r={index % 2 ? 4 : 5.5} fill="#fff" />)}
          <ellipse cx="0" cy="4" rx="180" ry="24" fill="rgba(0,0,0,.3)" />
          <path d="M -170 0 Q -100 -60 0 -62 Q 100 -60 170 0 Z" fill="#3d3593" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <rect x="-78" y="-150" width="156" height="96" rx="6" fill="#ece9ff" stroke={INK} strokeWidth="3" />
          <rect x="-16" y="-100" width="32" height="46" rx="14" fill="#5b4bc4" stroke={INK} strokeWidth="2.5" />
          {[-56, 40].map((x) => <rect key={x} x={x} y="-132" width="16" height="16" rx="4" fill="#ffe08a" stroke={INK} strokeWidth="2" />)}
          <path d="M -90 -150 A 90 86 0 0 1 90 -150 Z" fill="#c9c2ff" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M -6 -234 L 6 -234 L 10 -150 L -10 -150 Z" fill="#8d82e6" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
          <g transform="translate(18 -196) rotate(-38)">
            <rect x="-14" y="-70" width="28" height="92" rx="8" fill="#6b5bd6" stroke={INK} strokeWidth="3" />
            <rect x="-17" y="-78" width="34" height="14" rx="5" fill="#ffc83d" stroke={INK} strokeWidth="2.5" />
          </g>
          <line x1="-120" y1="-40" x2="-120" y2="-90" stroke={INK} strokeWidth="3" />
          <path className="mq-flag" d="M -120 -90 L -92 -82 L -120 -72 Z" fill={flag} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        </g>
      );
    case "fortress":
      return (
        <g>
          <ellipse cx="0" cy="4" rx="200" ry="24" fill="rgba(0,0,0,.3)" />
          {/* Wall with battlements */}
          <rect x="-130" y="-100" width="260" height="100" fill="#8d9ab0" stroke={INK} strokeWidth="3" />
          {[-122, -86, -50, -14, 22, 58, 94].map((x) => <rect key={x} x={x} y="-118" width="24" height="20" fill="#9ba8bd" stroke={INK} strokeWidth="2.5" />)}
          {[[-110, -70], [-60, -40], [40, -76], [90, -36]].map(([x, y]) => <rect key={x} x={x} y={y} width="30" height="12" rx="2" fill="rgba(13,23,38,.12)" />)}
          {/* Towers */}
          {[-150, 150].map((x) => (
            <g key={x}>
              <rect x={x - 38} y="-180" width="76" height="180" fill="#a3afc3" stroke={INK} strokeWidth="3" />
              <rect x={x - 12} y="-140" width="24" height="34" rx="12" fill={INK} opacity="0.75" />
              <path d={`M ${x - 46} -180 L ${x} -238 L ${x + 46} -180 Z`} fill="#c9473b" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
              <line x1={x} y1="-238" x2={x} y2="-266" stroke={INK} strokeWidth="3" />
              <path className="mq-flag" d={`M ${x} -266 L ${x + 26} -258 L ${x} -248 Z`} fill={flag} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
            </g>
          ))}
          {/* Gate and the shield of capital protection */}
          <path d="M -34 0 L -34 -46 A 34 34 0 0 1 34 -46 L 34 0 Z" fill="#3b2a1a" stroke={INK} strokeWidth="3" />
          <path d="M 0 -184 L 34 -172 L 34 -140 Q 34 -114 0 -100 Q -34 -114 -34 -140 L -34 -172 Z" fill="#3d84d6" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <polyline points="-14,-142 -3,-130 16,-156" fill="none" stroke="#ffc83d" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
    case "harbor":
      return (
        <g>
          <ellipse cx="0" cy="6" rx="210" ry="26" fill="rgba(0,0,0,.25)" />
          {/* Pier */}
          <rect x="-190" y="-26" width="210" height="14" rx="3" fill="#a8774a" stroke={INK} strokeWidth="3" />
          {[-176, -120, -64, -8].map((x) => <rect key={x} x={x} y="-14" width="10" height="26" fill="#7a5530" stroke={INK} strokeWidth="2" />)}
          {/* Lighthouse with its turning beam */}
          <path className="mq-beam" d="M 120 -208 L 300 -250 L 300 -166 Z" fill="#fff6c2" opacity="0.35" />
          <path d="M 96 -10 L 104 -190 L 136 -190 L 144 -10 Z" fill="#fffaf0" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          {[-150, -100, -50].map((y) => <path key={y} d={`M ${98 + (y + 190) * 0.0} ${y} L ${142} ${y} L ${143} ${y + 22} L ${97} ${y + 22} Z`} fill="#ef5b52" />)}
          <rect x="98" y="-224" width="44" height="34" rx="6" fill="#ffe08a" stroke={INK} strokeWidth="3" />
          <path d="M 92 -224 L 120 -250 L 148 -224 Z" fill="#c9473b" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <rect x="84" y="-14" width="72" height="14" rx="3" fill="#6b7a90" stroke={INK} strokeWidth="3" />
          {/* Sailboat */}
          <g className="mq-boat">
            <path d="M -150 -40 L -40 -40 L -60 -14 L -134 -14 Z" fill="#ffc83d" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
            <line x1="-96" y1="-40" x2="-96" y2="-150" stroke={INK} strokeWidth="3" />
            <path d="M -92 -146 L -40 -50 L -92 -50 Z" fill="#fffaf0" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
            <path d="M -100 -134 L -140 -50 L -100 -50 Z" fill="#8af8ee" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
            <path className="mq-flag" d="M -96 -150 L -72 -144 L -96 -136 Z" fill={flag} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
          </g>
          {[-160, -60, 40, 140].map((x) => <path key={x} className="mq-wave" d={`M ${x} 10 q 12 -8 24 0 t 24 0`} fill="none" stroke="#bff6ff" strokeWidth="3" strokeLinecap="round" opacity="0.7" />)}
        </g>
      );
    case "summit":
      return (
        <g>
          <ellipse cx="0" cy="4" rx="210" ry="26" fill="rgba(0,0,0,.2)" />
          <path d="M -200 0 L -110 -150 L -60 -96 L 0 -250 L 90 -110 L 120 -140 L 200 0 Z" fill="#5f75a8" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M 0 -250 L 90 -110 L 40 -130 L 12 -100 L -10 -140 L -40 -120 Z" fill="#4a5f92" />
          <path d="M 0 -250 L 34 -196 L 14 -184 L 0 -200 L -16 -180 L -30 -194 Z" fill="#ffffff" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M -110 -150 L -88 -126 L -100 -120 L -112 -132 L -126 -122 Z" fill="#ffffff" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
          {/* The switchback path to the top */}
          <polyline points="-40,0 30,-40 -30,-80 24,-130 -8,-176 0,-232" fill="none" stroke="#ffe7b3" strokeWidth="4" strokeDasharray="8 7" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="0" y1="-250" x2="0" y2="-292" stroke={INK} strokeWidth="3.5" />
          <path className="mq-flag" d={`M 0 -292 L 40 -282 L 0 -268 Z`} fill={complete ? "#ffc83d" : "#ff7a6b"} stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
        </g>
      );
  }
}

/** A small prop beside the road (variant 0 or 1), standing on its baseline at (0, 0). */
export function PropArt({ theme, variant }: { theme: ChapterTheme; variant: number }) {
  const v = variant % 2;
  switch (theme) {
    case "city":
      return v
        ? <g><line x1="0" y1="0" x2="0" y2="-62" stroke={INK} strokeWidth="4" /><circle className="mq-glow" cx="0" cy="-66" r="9" fill="#ffe08a" stroke={INK} strokeWidth="2.5" /></g>
        : <g><rect x="-4" y="-20" width="8" height="20" fill="#6b4226" stroke={INK} strokeWidth="2" /><circle cx="0" cy="-34" r="20" fill="#2f9f6a" stroke={INK} strokeWidth="2.5" /></g>;
    case "canyon":
      return v
        ? <g><path d="M -6 0 L -6 -50 Q 0 -60 6 -50 L 6 0 Z M -6 -30 L -18 -30 L -18 -42 M 6 -22 L 16 -22 L 16 -36" fill="#4f9a4a" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" /></g>
        : <g><path d="M -28 0 Q -24 -26 0 -30 Q 24 -26 28 0 Z" fill="#d97650" stroke={INK} strokeWidth="2.5" /></g>;
    case "forest":
      return v
        ? <g><rect x="-4" y="-16" width="8" height="16" fill="#6b4226" stroke={INK} strokeWidth="2" /><path d="M 0 -76 L 26 -36 L 12 -36 L 30 -14 L -30 -14 L -12 -36 L -26 -36 Z" fill="#2a8f4f" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" /></g>
        : <g><circle cx="-10" cy="-12" r="14" fill="#3aa860" stroke={INK} strokeWidth="2.5" /><circle cx="10" cy="-14" r="16" fill="#45b86a" stroke={INK} strokeWidth="2.5" /></g>;
    case "observatory":
      return v
        ? <g><path d="M 0 -48 L 14 -16 L 0 0 L -14 -16 Z" fill="#b79bff" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" /><path d="M 0 -48 L 4 -16 L 0 0 Z" fill="rgba(255,255,255,.4)" /></g>
        : <g><path d="M -26 0 Q -20 -22 0 -24 Q 22 -22 26 0 Z" fill="#4a3fa0" stroke={INK} strokeWidth="2.5" /></g>;
    case "fortress":
      return v
        ? <g><line x1="0" y1="0" x2="0" y2="-64" stroke={INK} strokeWidth="3.5" /><path className="mq-flag" d="M 0 -64 L 26 -56 L 0 -46 Z" fill="#3d84d6" stroke={INK} strokeWidth="2" /></g>
        : <g><rect x="-22" y="-14" width="20" height="14" rx="2" fill="#9ba8bd" stroke={INK} strokeWidth="2" /><rect x="0" y="-14" width="20" height="14" rx="2" fill="#8d9ab0" stroke={INK} strokeWidth="2" /><rect x="-11" y="-28" width="20" height="14" rx="2" fill="#a3afc3" stroke={INK} strokeWidth="2" /></g>;
    case "harbor":
      return v
        ? <g className="mq-bob"><path d="M -12 0 L -8 -26 L 8 -26 L 12 0 Z" fill="#ef5b52" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" /><rect x="-8" y="-18" width="16" height="6" fill="#fff" /><circle cx="0" cy="-30" r="4" fill="#ffe08a" stroke={INK} strokeWidth="2" /></g>
        : <g><path className="mq-wave" d="M -30 0 q 10 -8 20 0 t 20 0 t 20 0" fill="none" stroke="#bff6ff" strokeWidth="3" strokeLinecap="round" opacity="0.6" /></g>;
    case "summit":
      return v
        ? <g><rect x="-4" y="-14" width="8" height="14" fill="#6b4226" stroke={INK} strokeWidth="2" /><path d="M 0 -70 L 24 -34 L 10 -34 L 28 -12 L -28 -12 L -10 -34 L -24 -34 Z" fill="#3f7a6a" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" /><path d="M 0 -70 L 12 -52 L -12 -52 Z" fill="#fff" /></g>
        : <g><path d="M -26 0 Q -20 -24 0 -26 Q 22 -24 26 0 Z" fill="#8a9cc4" stroke={INK} strokeWidth="2.5" /><path d="M -14 -20 Q 0 -30 14 -20 Q 0 -16 -14 -20 Z" fill="#fff" /></g>;
  }
}
