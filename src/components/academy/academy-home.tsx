"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Award, BookOpen, Check, ChevronRight, Flame, GraduationCap, Lock, Medal, Play, RefreshCw, Star, Target, Trophy, Zap } from "lucide-react";
import { api } from "@/components/api";
import { Button, cx, Skeleton } from "@/components/ui";

type LessonState = "locked" | "available" | "in-progress" | "completed" | "mastered";
type LessonCard = { slug: string; title: string; summary: string; minutes: number; questions: number; state: LessonState; unit: number };
type Overview = {
  name: string;
  level: { level: number; title: string; floor: number; next: number | null; progress: number; xp: number };
  xp: { total: number; week: number; today: number; dailyGoal: number };
  streak: { current: number; longest: number; activeDays: number; todayDone: boolean; week: Array<{ day: string; done: boolean; today: boolean }> };
  next: LessonCard | null;
  units: Array<{ id: string; number: number; title: string; description: string; done: number; total: number; lessons: LessonCard[] }>;
  completed: number;
  total: number;
  badges: Array<{ slug: string; name: string; description: string; icon: string; category: string; earnedAt: string | null }>;
};

const BADGE_ICON = { book: BookOpen, flame: Flame, trophy: Trophy, target: Target, medal: Medal } as const;

/** TradeD Academy home: level, streak, daily goal, the learning path and badges, from /api/academy. */
export function AcademyHome() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<Overview>("/api/academy").then((next) => { setData(next); setError(""); }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The Academy could not be loaded."));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error && !data) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="text-dense font-semibold text-loss">{error}</p>
          <Button className="mt-3" icon={<RefreshCw className="h-4 w-4" />} onClick={load}>Retry</Button>
        </div>
      </div>
    );
  }
  if (!data) return <div className="mx-auto max-w-5xl space-y-3 p-4">{[0, 1, 2, 3].map((item) => <Skeleton key={item} className="h-28 w-full rounded-card" />)}</div>;

  const goal = Math.min(100, Math.round((data.xp.today / data.xp.dailyGoal) * 100));
  const earned = data.badges.filter((badge) => badge.earnedAt).sort((a, b) => (b.earnedAt ?? "").localeCompare(a.earnedAt ?? ""));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-3 sm:p-5 lg:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow flex items-center gap-1.5"><GraduationCap className="h-3.5 w-3.5" aria-hidden />TradeD Academy</p>
            <h1 className="mt-1 text-[clamp(1.375rem,3vw,1.75rem)] font-semibold tracking-[-0.02em]">Welcome back, {data.name}</h1>
            <p className="text-data text-muted">{data.completed} of {data.total} lessons completed</p>
          </div>
          {data.next ? (
            <Link href={`/academy/lesson/${data.next.slug}`} className="inline-flex h-11 items-center gap-2 rounded-input bg-primary px-5 text-dense font-semibold text-on-primary shadow-e2 hover:bg-primary-hover">
              <Play className="h-4 w-4" aria-hidden />{data.next.state === "in-progress" ? "Continue learning" : "Start next lesson"}
            </Link>
          ) : null}
        </header>

        <div className="grid gap-3 sm:grid-cols-3">
          <section className="surface flex flex-col gap-2 p-4" aria-label="Level">
            <span className="flex items-center gap-2 text-data text-muted"><Star className="h-4 w-4 text-gold" aria-hidden />Level {data.level.level}</span>
            <span className="text-title font-semibold">{data.level.title}</span>
            <span className="h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={data.level.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Progress to next level">
              <span className="block h-full rounded-full bg-gold transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${data.level.progress}%` }} />
            </span>
            <span className="num text-micro text-muted">{data.level.xp} XP{data.level.next != null ? ` · ${data.level.next - data.level.xp} to level ${data.level.level + 1}` : " · top level"}</span>
          </section>

          <section className="surface flex flex-col gap-2 p-4" aria-label="Streak">
            <span className="flex items-center gap-2 text-data text-muted"><Flame className={cx("h-4 w-4", data.streak.current ? "text-warning" : "text-muted")} aria-hidden />Daily streak</span>
            <span className="text-title font-semibold"><span className="num">{data.streak.current}</span> day{data.streak.current === 1 ? "" : "s"}</span>
            <ol className="flex justify-between gap-1" aria-label="This week">
              {data.streak.week.map((day) => (
                <li key={day.day} className="flex flex-col items-center gap-1">
                  <span className={cx("grid h-7 w-7 place-items-center rounded-full text-micro font-semibold", day.done ? "bg-warning text-on-gold" : "bg-sunken text-muted", day.today && !day.done && "ring-2 ring-warning/50")} title={day.day}>
                    {day.done ? <Check className="h-3.5 w-3.5" aria-label="Learned" /> : <span aria-label="No lesson">·</span>}
                  </span>
                  <span className="text-[0.625rem] text-muted">{new Date(`${day.day}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "narrow", timeZone: "UTC" })}</span>
                </li>
              ))}
            </ol>
            <span className="text-micro text-muted">{data.streak.todayDone ? "Today counts. " : "Complete a lesson today to keep it going. "}Longest {data.streak.longest}.</span>
          </section>

          <section className="surface flex items-center gap-4 p-4" aria-label="Daily goal">
            <span className="relative grid h-16 w-16 shrink-0 place-items-center" role="progressbar" aria-valuenow={goal} aria-valuemin={0} aria-valuemax={100} aria-label="Daily XP goal">
              <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden>
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--sunken)" strokeWidth="4" />
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--primary)" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${(goal / 100) * 97.4} 97.4`} />
              </svg>
              <Zap className="h-5 w-5 text-primary" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-data text-muted">Daily goal</span>
              <span className="num block text-title font-semibold">{data.xp.today} / {data.xp.dailyGoal} XP</span>
              <span className="num block text-micro text-muted">{data.xp.week} XP this week</span>
            </span>
          </section>
        </div>

        <section aria-labelledby="td-path" className="flex flex-col gap-3">
          <h2 id="td-path" className="text-title font-semibold">Learning path</h2>
          {data.units.map((unit) => <UnitPath key={unit.id} unit={unit} />)}
        </section>

        <section aria-labelledby="td-badges" className="surface p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="td-badges" className="flex items-center gap-2 text-title font-semibold"><Award className="h-4 w-4 text-gold" aria-hidden />Badges</h2>
            <span className="num text-data text-muted">{earned.length} of {data.badges.length}</span>
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {data.badges.map((badge) => {
              const Icon = BADGE_ICON[badge.icon as keyof typeof BADGE_ICON] ?? Award;
              return (
                <li key={badge.slug} className={cx("flex items-center gap-2.5 rounded-card border p-2.5", badge.earnedAt ? "border-gold/40 bg-gold-soft" : "border-border-soft opacity-60")}>
                  <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-full", badge.earnedAt ? "bg-gold text-on-gold" : "bg-sunken text-muted")}>{badge.earnedAt ? <Icon className="h-4 w-4" aria-hidden /> : <Lock className="h-4 w-4" aria-hidden />}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-data font-semibold">{badge.name}</span>
                    <span className="block text-micro text-muted">{badge.earnedAt ? `Earned ${new Date(badge.earnedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : badge.description}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}

function UnitPath({ unit }: { unit: Overview["units"][number] }) {
  const locked = unit.lessons.every((lesson) => lesson.state === "locked");
  return (
    <section className={cx("surface overflow-hidden", locked && "opacity-75")} aria-label={`Unit ${unit.number}: ${unit.title}`}>
      <div className="flex items-center gap-3 border-b border-border-soft px-4 py-3">
        <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-input text-dense font-bold", unit.done === unit.total ? "bg-profit-soft text-profit" : locked ? "bg-sunken text-muted" : "bg-primary-soft text-primary")}>{unit.number}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-dense font-semibold">{unit.title}</span>
          <span className="block truncate text-micro text-muted">{unit.description}</span>
        </span>
        <span className="num shrink-0 text-data text-muted">{unit.done}/{unit.total}</span>
      </div>
      <ol className="relative px-4 py-3">
        <span aria-hidden className="absolute bottom-6 left-[2.15rem] top-6 w-0.5 bg-border" />
        {unit.lessons.map((lesson) => <LessonNode key={lesson.slug} lesson={lesson} />)}
      </ol>
    </section>
  );
}

const NODE_STYLE: Record<LessonState, { ring: string; icon: typeof Lock; label: string }> = {
  locked: { ring: "bg-sunken text-muted border-border", icon: Lock, label: "Locked" },
  available: { ring: "bg-primary text-on-primary border-primary shadow-e2", icon: Play, label: "Start" },
  "in-progress": { ring: "bg-primary-soft text-primary border-primary", icon: Play, label: "In progress" },
  completed: { ring: "bg-profit text-on-signal border-profit", icon: Check, label: "Completed" },
  mastered: { ring: "bg-gold text-on-gold border-gold", icon: Star, label: "Mastered" },
};

function LessonNode({ lesson }: { lesson: LessonCard }) {
  const style = NODE_STYLE[lesson.state];
  const Icon = style.icon;
  const content = (
    <>
      <span className={cx("relative z-[1] grid h-9 w-9 shrink-0 place-items-center rounded-full border-2", style.ring)}><Icon className="h-4 w-4" aria-hidden /></span>
      <span className="min-w-0 flex-1">
        <span className={cx("block text-dense font-medium", lesson.state === "locked" ? "text-muted" : "text-text")}>{lesson.title}</span>
        <span className="block text-micro text-muted">{style.label} · {lesson.minutes} min · {lesson.questions} questions</span>
      </span>
      {lesson.state === "locked" ? null : <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
    </>
  );
  return (
    <li className="py-1">
      {lesson.state === "locked"
        ? <div className="flex items-center gap-3 rounded-input px-1 py-1.5" aria-disabled="true">{content}</div>
        : <Link href={`/academy/lesson/${lesson.slug}`} className="flex items-center gap-3 rounded-input px-1 py-1.5 transition-colors hover:bg-hover">{content}</Link>}
    </li>
  );
}
