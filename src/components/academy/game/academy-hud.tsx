"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Flame, GraduationCap, Target, Zap } from "lucide-react";
import { styles } from "./academy-game-classes";

/** Counts from the previous value (or `initial`) to the new one, only when the value really changes. */
export function useCountUp(value: number, duration = 700, initial = value) {
  const [shown, setShown] = useState(initial);
  const from = useRef(initial);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const began = performance.now();
    const step = (now: number) => {
      const t = reduce ? 1 : Math.min(1, (now - began) / duration);
      setShown(Math.round(start + (value - start) * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(step);
      else from.current = value;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);
  return shown;
}

function Counter({ icon, tone, label, value, suffix, bump }: { icon: React.ReactNode; tone: string; label: string; value: number; suffix?: string; bump: boolean }) {
  const shown = useCountUp(value);
  return (
    <span className={`${styles.counter} ${bump ? styles.bump : ""}`} title={label} aria-label={`${label}: ${value}${suffix ?? ""}`}>
      <span className={styles.counterIcon} style={{ background: tone }} aria-hidden>{icon}</span>
      <span aria-hidden>{shown}{suffix}</span>
    </span>
  );
}

/** The game's top bar: back to the app, title, and the real XP, streak and daily goal. */
export function AcademyHud({ xp, streak, today, goal, bumpXp }: { xp: number; streak: number; today: number; goal: number; bumpXp: boolean }) {
  return (
    <div className={styles.hud}>
      <Link href="/" className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/20 bg-white/10 text-white hover:bg-white/20" aria-label="Back to TradeD"><ArrowLeft className="h-4 w-4" aria-hidden /></Link>
      <span className="flex min-w-0 items-center gap-2 font-black tracking-tight">
        <GraduationCap className="h-5 w-5 shrink-0 text-[#ffc83d]" aria-hidden />
        <span className="truncate text-[15px] max-[380px]:hidden">Market Quest</span>
      </span>
      <span className="flex-1" />
      <Counter icon={<Zap className="h-4 w-4 text-[#5a3b00]" fill="currentColor" />} tone="linear-gradient(180deg,#ffe07a,#ffb81f)" label="XP" value={xp} bump={bumpXp} />
      <Counter icon={<Flame className="h-4 w-4 text-white" fill="currentColor" />} tone="linear-gradient(180deg,#ff9a6b,#ff5a4a)" label="Day streak" value={streak} bump={false} />
      <span className="max-sm:hidden">
        <Counter icon={<Target className="h-4 w-4 text-white" />} tone="linear-gradient(180deg,#6fe3ff,#2a9df4)" label="Daily goal XP" value={Math.min(today, goal)} suffix={`/${goal}`} bump={false} />
      </span>
    </div>
  );
}
