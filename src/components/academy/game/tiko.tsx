import type { TikoMood } from "@/lib/academy/missions";

/**
 * Tiko, the Market Quest guide: an original SVG robot with separate head, eyes, antenna, arms and
 * thrusters, animated per mood by CSS (academy-game.css, `.mq-tiko[data-mood=…]`). One mood plays
 * at a time; reduced-motion users see the still pose.
 */
/** `talking` animates the mouth on top of any mood (while a speech bubble is opening). */
export function Tiko({ mood = "idle", size = 120, className, facing = "right", talking = false }: { mood?: TikoMood; size?: number; className?: string; facing?: "left" | "right"; talking?: boolean }) {
  const happy = mood === "celebrate" || mood === "mission-complete" || mood === "encourage" || mood === "streak";
  const wide = mood === "surprised";
  const puzzled = mood === "confused" || mood === "thinking";
  return (
    <span className={`mq-tiko ${className ?? ""}`} data-mood={mood} data-talking={talking ? "true" : undefined} style={{ width: size, height: size * 1.15, transform: facing === "left" ? "scaleX(-1)" : undefined }} role="img" aria-label={`Tiko, your market guide (${mood.replace("-", " ")})`}>
      <svg viewBox="0 0 120 138" width="100%" height="100%" aria-hidden>
        <defs>
          <linearGradient id="tiko-shell" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#f6fbff" /><stop offset="1" stopColor="#c7dbe8" /></linearGradient>
          <linearGradient id="tiko-visor" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#0f2d45" /><stop offset="1" stopColor="#07192a" /></linearGradient>
          <linearGradient id="tiko-teal" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#4ff0e0" /><stop offset="1" stopColor="#13a7a0" /></linearGradient>
          <radialGradient id="tiko-flame" cx="0.5" cy="0.2" r="0.8"><stop offset="0" stopColor="#fff6c2" /><stop offset="0.5" stopColor="#ffc83d" /><stop offset="1" stopColor="#ff7a3d" stopOpacity="0" /></radialGradient>
        </defs>
        {/* Shadow on the ground (shrinks when Tiko lifts off). */}
        <ellipse className="mq-tiko-shadow" cx="60" cy="132" rx="30" ry="5" fill="rgba(0,0,0,.25)" />
        <g className="mq-tiko-body">
          {/* Thrusters */}
          <g className="mq-tiko-flame">
            <ellipse cx="46" cy="118" rx="6" ry="12" fill="url(#tiko-flame)" />
            <ellipse cx="74" cy="118" rx="6" ry="12" fill="url(#tiko-flame)" />
          </g>
          {/* Torso */}
          <rect x="34" y="70" width="52" height="42" rx="18" fill="url(#tiko-shell)" stroke="#0d1726" strokeWidth="3" />
          <rect x="46" y="82" width="28" height="16" rx="5" fill="url(#tiko-visor)" />
          <polyline className="mq-tiko-chart" points="49,94 55,89 60,92 66,85 71,87" fill="none" stroke="#3fe08d" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          {/* Arms */}
          <g className="mq-tiko-arm-l"><path d="M36 82 Q 22 88 20 100" fill="none" stroke="#0d1726" strokeWidth="7" strokeLinecap="round" /><path d="M36 82 Q 22 88 20 100" fill="none" stroke="url(#tiko-teal)" strokeWidth="4" strokeLinecap="round" /><circle cx="20" cy="101" r="5" fill="#ffc83d" stroke="#0d1726" strokeWidth="2.5" /></g>
          <g className="mq-tiko-arm-r"><path d="M84 82 Q 98 88 100 100" fill="none" stroke="#0d1726" strokeWidth="7" strokeLinecap="round" /><path d="M84 82 Q 98 88 100 100" fill="none" stroke="url(#tiko-teal)" strokeWidth="4" strokeLinecap="round" /><circle cx="100" cy="101" r="5" fill="#ffc83d" stroke="#0d1726" strokeWidth="2.5" /></g>
          {/* Head */}
          <g className="mq-tiko-head">
            <g className="mq-tiko-antenna">
              <line x1="60" y1="22" x2="60" y2="8" stroke="#0d1726" strokeWidth="3" strokeLinecap="round" />
              <circle cx="60" cy="7" r="5" fill="#ffc83d" stroke="#0d1726" strokeWidth="2.5" />
            </g>
            <rect x="22" y="20" width="76" height="54" rx="24" fill="url(#tiko-shell)" stroke="#0d1726" strokeWidth="3" />
            <rect x="18" y="38" width="8" height="18" rx="4" fill="url(#tiko-teal)" stroke="#0d1726" strokeWidth="2.5" />
            <rect x="94" y="38" width="8" height="18" rx="4" fill="url(#tiko-teal)" stroke="#0d1726" strokeWidth="2.5" />
            <rect x="31" y="29" width="58" height="36" rx="16" fill="url(#tiko-visor)" />
            <path d="M36 34 Q 48 30 58 31" fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="3" strokeLinecap="round" />
            {/* Eyes */}
            <g className="mq-tiko-eyes">
              {happy ? (
                <>
                  <path d="M42 50 Q 48 42 54 50" fill="none" stroke="#4ff0e0" strokeWidth="4" strokeLinecap="round" />
                  <path d="M66 50 Q 72 42 78 50" fill="none" stroke="#4ff0e0" strokeWidth="4" strokeLinecap="round" />
                </>
              ) : (
                <>
                  <ellipse cx="48" cy={puzzled ? 46 : 47} rx={wide ? 7.5 : 6} ry={puzzled ? 5 : wide ? 9 : 7} fill="#4ff0e0" />
                  <ellipse cx="72" cy="47" rx={wide ? 7.5 : 6} ry={wide ? 9 : 7} fill="#4ff0e0" />
                  <circle cx="50" cy="44" r="2" fill="#fff" />
                  <circle cx="74" cy="44" r="2" fill="#fff" />
                </>
              )}
            </g>
            {puzzled ? <path d="M40 38 L 54 41" stroke="#4ff0e0" strokeWidth="2.5" strokeLinecap="round" /> : null}
            {wide ? <ellipse className="mq-tiko-mouth" cx="60" cy="60" rx="4" ry="3.5" fill="#4ff0e0" /> : <path className="mq-tiko-mouth" d={happy ? "M52 58 Q 60 64 68 58" : puzzled ? "M54 60 Q 60 58 66 60" : "M54 59 Q 60 62 66 59"} fill="none" stroke="#4ff0e0" strokeWidth="2.5" strokeLinecap="round" />}
          </g>
        </g>
      </svg>
    </span>
  );
}
