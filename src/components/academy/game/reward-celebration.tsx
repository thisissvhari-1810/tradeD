"use client";

import { Award, Star, Zap } from "lucide-react";
import { styles } from "./academy-game-classes";
import { useCountUp } from "./academy-hud";

const CONFETTI = ["#ffc83d", "#3fe08d", "#38e1ff", "#a77bff", "#ff7a6b"];

/**
 * The reward scene after a level is completed: staggered stars, a short confetti burst, XP
 * counting up from the old total, and the earned badge glowing. Plays only for a real completion.
 */
export function RewardCelebration({ stars, xpBefore, xpAfter, xpGained, badge, firstTime, children }: {
  stars: number;
  xpBefore: number;
  xpAfter: number;
  xpGained: number;
  badge: string | null;
  firstTime: boolean;
  children?: React.ReactNode;
}) {
  const total = useCountUp(xpAfter, 900, xpBefore);
  return (
    <section className="relative flex flex-col items-center gap-4 overflow-hidden px-4 py-6 text-center" aria-live="polite">
      {firstTime ? CONFETTI.flatMap((color, index) => Array.from({ length: 5 }, (_, piece) => {
        const angle = ((index * 5 + piece) / 25) * Math.PI * 2;
        const distance = 140 + ((index + piece) % 3) * 40;
        return (
          <span
            key={`${index}-${piece}`}
            className={styles.confetti}
            aria-hidden
            style={{ background: color, animationDelay: `${300 + piece * 40}ms`, ["--dx" as string]: `${Math.cos(angle) * distance}px`, ["--dy" as string]: `${Math.sin(angle) * distance}px`, ["--rot" as string]: `${(index + 1) * 140}deg` }}
          />
        );
      })) : null}
      <div className="flex items-end gap-2" aria-label={`${stars} of 3 stars`}>
        {[0, 1, 2].map((index) => (
          <Star
            key={index}
            className={styles.rewardStar}
            style={{ width: index === 1 ? 64 : 48, height: index === 1 ? 64 : 48, animationDelay: `${200 + index * 180}ms` }}
            fill={index < stars ? "#ffc83d" : "rgba(13,23,38,.12)"}
            stroke={index < stars ? "#d18b00" : "rgba(13,23,38,.25)"}
            strokeWidth={1.5}
            aria-hidden
          />
        ))}
      </div>
      <h2 className="text-[26px] font-black leading-tight">{firstTime ? "Level complete!" : "Level replayed"}</h2>
      <div className="flex flex-wrap justify-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#ffc83d]/25 px-3 py-1.5 text-[15px] font-black text-[#8a5a00]">
          <Zap className="h-4 w-4" fill="currentColor" aria-hidden />{xpGained > 0 ? `+${xpGained} XP` : "No new XP"}
        </span>
        <span className="num inline-flex items-center gap-1.5 rounded-full bg-[#0d1726]/[0.07] px-3 py-1.5 text-[15px] font-bold">Total {total} XP</span>
      </div>
      {badge ? (
        <span className={`${styles.badgeGlow} inline-flex items-center gap-2 rounded-2xl bg-gradient-to-b from-[#fff2c2] to-[#ffd96b] px-4 py-2 text-[14px] font-bold text-[#5a3b00]`}>
          <Award className="h-5 w-5" aria-hidden />New badge: {badge}
        </span>
      ) : null}
      {!firstTime ? <p className="max-w-xs text-[13px] text-[#0d1726]/60">XP for a level is paid once. Replaying keeps your knowledge fresh.</p> : null}
      {children}
    </section>
  );
}
