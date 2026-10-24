"use client";

import { forwardRef, useState } from "react";
import { Lock, Star } from "lucide-react";
import { styles } from "./academy-game-classes";
import type { LevelDef } from "./geometry";

export type LevelStatus = "active" | "completed" | "locked";

/** Original artwork for each level platform. */
export function LevelArt({ theme }: { theme: LevelDef["theme"] }) {
  if (theme === "market") {
    return (
      <svg className={styles.art} viewBox="0 0 64 64" aria-hidden>
        <rect x="10" y="26" width="44" height="28" rx="4" fill="#fffaf0" stroke="#0d1726" strokeWidth="3" />
        <path d="M6 28 L32 10 L58 28 Z" fill="#ff7a6b" stroke="#0d1726" strokeWidth="3" strokeLinejoin="round" />
        <rect x="27" y="38" width="10" height="16" rx="2" fill="#0d1726" />
        <polyline points="16,46 21,40 25,43 30,34" fill="none" stroke="#1fae63" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points="40,34 45,40 49,36" fill="none" stroke="#1fae63" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (theme === "candles") {
    return (
      <svg className={styles.art} viewBox="0 0 64 64" aria-hidden>
        {[[14, 18, 46, 24, 38, "#3fe08d"], [26, 10, 40, 16, 32, "#ff6b7a"], [38, 14, 50, 20, 42, "#3fe08d"], [50, 6, 34, 12, 24, "#3fe08d"]].map(([x, top, bottom, bodyTop, bodyBottom, color]) => (
          <g key={String(x)}>
            <line x1={Number(x)} x2={Number(x)} y1={Number(top)} y2={Number(bottom)} stroke="#0d1726" strokeWidth="3" strokeLinecap="round" />
            <rect x={Number(x) - 5} y={Number(bodyTop)} width="10" height={Number(bodyBottom) - Number(bodyTop)} rx="2" fill={String(color)} stroke="#0d1726" strokeWidth="2.5" />
          </g>
        ))}
      </svg>
    );
  }
  return (
    <svg className={styles.art} viewBox="0 0 64 64" aria-hidden>
      <path d="M4 54 L24 20 L34 34 L42 24 L60 54 Z" fill="#fffaf0" stroke="#0d1726" strokeWidth="3" strokeLinejoin="round" />
      <path d="M24 20 L19 29 L24 27 L29 30 Z" fill="#c9d8ff" />
      <line x1="42" x2="42" y1="24" y2="8" stroke="#0d1726" strokeWidth="3" strokeLinecap="round" />
      <path d="M42 9 L54 13 L42 17 Z" fill="#ffc83d" stroke="#0d1726" strokeWidth="2" strokeLinejoin="round" />
      <line x1="6" x2="58" y1="44" y2="44" stroke="#38e1ff" strokeWidth="2.5" strokeDasharray="4 3" />
    </svg>
  );
}

/**
 * A level platform: a raised 3-D button on the map. Active levels glow and invite play; locked
 * ones wiggle and explain why; completed ones turn gold.
 */
export const LevelNode = forwardRef<HTMLButtonElement, {
  level: LevelDef;
  status: LevelStatus;
  stars: number;
  left: number;
  top: number;
  order: number;
  launching: boolean;
  /** Why a locked level cannot be played (shown when it is tapped). */
  lockedNote: string;
  onOpen: () => void;
}>(function LevelNode({ level, status, stars, left, top, order, launching, lockedNote, onOpen }, ref) {
  const [note, setNote] = useState(false);
  // Short-lived flags restart the wiggle / spring animations without remounting (focus stays put).
  const [wiggle, setWiggle] = useState(false);
  const [pressed, setPressed] = useState(false);
  const themeClass = status === "completed" ? styles.done : styles[level.theme];

  function click() {
    if (status === "locked") {
      setWiggle(true);
      window.setTimeout(() => setWiggle(false), 450);
      setNote(true);
      window.setTimeout(() => setNote(false), 2600);
      return;
    }
    setPressed(true);
    window.setTimeout(() => setPressed(false), 400);
    onOpen();
  }

  return (
    <div
      className={[styles.nodeWrap, status === "active" ? styles.activeWrap : "", launching ? styles.launchTarget : ""].join(" ")}
      style={{ left: `${left}%`, top: `${top}%`, animationDelay: status === "active" ? "900ms" : `${450 + order * 140}ms` }}
    >
      {status === "active" ? (
        <span className={styles.start} aria-hidden>
          START
          <svg width="16" height="12" viewBox="0 0 16 12"><path d="M2 2 L8 10 L14 2" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
      ) : null}
      <span className={styles.tooltip} role="presentation">
        <strong className="block text-[13px] text-white">Level {String(level.number).padStart(2, "0")} · {level.title}</strong>
        {status === "locked" ? "Locked. " : ""}{level.teaser}
      </span>
      <button
        ref={ref}
        type="button"
        className={[styles.node, themeClass, status === "active" ? styles.active : "", status === "locked" ? styles.locked : "", wiggle ? styles.wiggle : "", pressed ? styles.pressed : ""].join(" ")}
        aria-label={`Level ${level.number}: ${level.title}. ${status === "locked" ? "Locked." : status === "completed" ? `Completed, ${stars} of 3 stars.` : "Ready to play."}`}
        aria-haspopup={status === "locked" ? undefined : "dialog"}
        onClick={click}
      >
        <span className={styles.ring} aria-hidden />
        <span className={styles.face} aria-hidden><LevelArt theme={level.theme} /></span>
        <span className={styles.number} aria-hidden>{String(level.number).padStart(2, "0")}</span>
        {status === "active" ? <Star className={styles.floatingStar} width={22} height={22} fill="currentColor" aria-hidden /> : null}
        {status === "locked" ? <span className={styles.lockBadge} aria-hidden><Lock width={16} height={16} strokeWidth={2.6} /></span> : null}
      </button>
      <span className={styles.label}>
        {status === "completed" ? (
          <span className="mr-1.5 inline-flex gap-0.5 align-[-2px]" aria-hidden>
            {[0, 1, 2].map((index) => <Star key={index} width={12} height={12} fill={index < stars ? "#ffc83d" : "transparent"} stroke="#ffc83d" />)}
          </span>
        ) : null}
        {level.title}
      </span>
      {note ? <span className={styles.lockedNote} role="status">{lockedNote}</span> : null}
    </div>
  );
});
