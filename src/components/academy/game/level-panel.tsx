"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Clock, Play, Star, X, Zap } from "lucide-react";
import { styles } from "./academy-game-classes";
import { LevelArt } from "./level-node";
import type { LevelDef } from "./geometry";

export type PanelInfo = { minutes: number; xp: number; questions: number; stars: number; completed: boolean };

/**
 * The level card that opens from a platform: beside it on larger screens (with a pointer to the
 * platform), as a bottom sheet on phones. Escape, the close button or a tap outside dismisses it.
 */
export function LevelPanel({ level, info, sheet, anchor, onPlay, onClose }: {
  level: LevelDef;
  info: PanelInfo;
  sheet: boolean;
  /** Platform centre in % of the map box (desktop placement). */
  anchor: { left: number; top: number };
  onPlay: () => void;
  onClose: () => void;
}) {
  const playRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    playRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const body = (
    <>
      <button type="button" onClick={onClose} aria-label="Close" className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full text-[#0d1726]/60 hover:bg-black/5 hover:text-[#0d1726]"><X className="h-5 w-5" aria-hidden /></button>
      <div className="flex items-center gap-3">
        <span className={`${styles.done} grid h-16 w-16 shrink-0 place-items-center rounded-2xl`} style={{ background: level.theme === "market" ? "linear-gradient(160deg,#7bf5ae,#25b46c)" : level.theme === "candles" ? "linear-gradient(160deg,#c8b1ff,#8a5cf6)" : "linear-gradient(160deg,#ffc1a8,#ff7a6b)", boxShadow: "inset 0 -5px 0 rgba(0,0,0,.15)" }}>
          <LevelArt theme={level.theme} />
        </span>
        <span className="min-w-0">
          <span className="block text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#0d1726]/55">Level {String(level.number).padStart(2, "0")}</span>
          <span className="block text-[20px] font-black leading-tight">{level.title}</span>
        </span>
      </div>
      <p className="mt-3 text-[14px] leading-snug text-[#0d1726]/80">{level.description}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] font-bold">
        <span className="inline-flex items-center gap-1 rounded-full bg-[#0d1726]/[0.07] px-2.5 py-1"><Clock className="h-3.5 w-3.5" aria-hidden />{info.minutes} min</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-[#ffc83d]/30 px-2.5 py-1 text-[#8a5a00]"><Zap className="h-3.5 w-3.5" aria-hidden />{info.completed ? "XP earned" : `Up to ${info.xp} XP`}</span>
        <span className="inline-flex items-center gap-0.5 rounded-full bg-[#0d1726]/[0.07] px-2 py-1" aria-label={`${info.stars} of 3 stars`}>
          {[0, 1, 2].map((index) => <Star key={index} className="h-4 w-4" fill={index < info.stars ? "#ffc83d" : "transparent"} stroke={index < info.stars ? "#d18b00" : "#0d1726"} strokeOpacity={index < info.stars ? 1 : 0.35} aria-hidden />)}
        </span>
      </div>
      <p className="mt-2 text-[12px] text-[#0d1726]/60">{info.questions} questions · 3 stars for a perfect score</p>
      <button ref={playRef} type="button" className={`${styles.play} mt-4`} onClick={onPlay}>
        <Play className="h-5 w-5" fill="currentColor" aria-hidden />{info.completed ? "PLAY AGAIN" : "PLAY LEVEL"}
      </button>
    </>
  );

  if (sheet) {
    // Attached to the page itself, so it sits above the app's bottom bar (the map is its own layer).
    return createPortal(
      <>
        <button type="button" tabIndex={-1} aria-label="Close level" className="fixed inset-0 z-[79] bg-black/40" onClick={onClose} />
        <div role="dialog" aria-modal="true" aria-label={`Level ${level.number}: ${level.title}`} className={styles.sheet}>
          <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-[#0d1726]/20" aria-hidden />
          <div className="relative">{body}</div>
        </div>
      </>,
      document.body,
    );
  }
  // Beside the platform: on its right when there is room, otherwise on its left.
  const right = anchor.left < 62;
  return (
    <>
      <button type="button" tabIndex={-1} aria-label="Close level" className="absolute inset-0 z-[7] cursor-default bg-transparent" onClick={onClose} />
      <div
        role="dialog"
        aria-label={`Level ${level.number}: ${level.title}`}
        className={styles.panel}
        style={{
          top: `clamp(12px, calc(${anchor.top}% - 150px), calc(100% - 340px))`,
          ...(right ? { left: `calc(${anchor.left}% + 90px)` } : { right: `calc(${100 - anchor.left}% + 90px)` }),
          ["--origin" as string]: right ? "left center" : "right center",
        }}
      >
        <span className={styles.pointer} style={right ? { left: -8 } : { right: -8 }} aria-hidden />
        <div className="relative">{body}</div>
      </div>
    </>
  );
}
