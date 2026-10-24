"use client";

import "@/components/academy/lesson/academy-lesson.css";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { BookOpen, BookOpenText, CheckCircle2, Clock, ListChecks, Play, Sparkles, Star, X, Zap } from "lucide-react";
import { XP_RULES } from "@/lib/academy/rules";
import type { ChapterTheme, JourneyStop } from "@/lib/academy/world";
import { THEME } from "./world-art";

/**
 * The lesson card that opens from a stop: beside it on larger screens (pointing at the stop), as a
 * bottom sheet on phones. Escape, the close button or a tap outside dismisses it. Rewards shown are
 * the Academy's real XP rules; nothing here grants anything.
 */
export function StopPanel({ stop, theme, chapter, position, stars, story, sheet, anchor, onPlay, onClose }: {
  stop: JourneyStop;
  theme: ChapterTheme;
  chapter: { number: number; name: string };
  position: { index: number; of: number };
  stars: number;
  story: boolean;
  sheet: boolean;
  /** Stop centre in % of the map box (desktop placement). */
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

  const style = THEME[theme];
  const Glyph = style.glyph;
  const completed = stop.stop === "completed";
  const started = stop.state === "in-progress";
  const maxXp = XP_RULES.lessonComplete + XP_RULES.quizComplete + stop.questions * XP_RULES.correctAnswer;

  const body = (
    <>
      <button type="button" onClick={onClose} aria-label="Close" className="absolute -right-1 -top-1 grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-hover hover:text-text"><X className="h-5 w-5" aria-hidden /></button>
      <div className="flex items-center gap-3 pr-8">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-white" style={{ background: `linear-gradient(165deg, ${completed ? "#ffe49a" : style.face[0]}, ${completed ? "#f0ac1c" : style.face[1]})`, boxShadow: `inset 0 -4px 0 rgba(0,0,0,.18), 0 3px 0 ${completed ? "#9a6a00" : style.rim}` }} aria-hidden>
          {completed ? <CheckCircle2 className="h-7 w-7" strokeWidth={2.6} /> : <Glyph className="h-7 w-7" strokeWidth={2.4} />}
        </span>
        <span className="min-w-0">
          <span className="block text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted">Chapter {chapter.number} · {chapter.name}</span>
          <span className="block text-[19px] font-black leading-tight">{stop.title}</span>
        </span>
      </div>
      {story ? <span className="mt-3 inline-flex items-center gap-1 rounded-full bg-gold-soft px-2.5 py-1 text-[12px] font-bold text-gold"><Sparkles className="h-3.5 w-3.5" aria-hidden />Story mission with Tiko</span> : null}
      <p className="mt-3 text-[14px] leading-snug text-text-2">{stop.summary}</p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px] font-bold">
        <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-1"><Clock className="h-3.5 w-3.5" aria-hidden />{stop.minutes} min</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-1"><ListChecks className="h-3.5 w-3.5" aria-hidden />{stop.questions} exercises</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-gold-soft px-2.5 py-1 text-gold"><Zap className="h-3.5 w-3.5" fill="currentColor" aria-hidden />{completed ? "XP earned" : `Up to ${maxXp} XP`}</span>
        {completed ? (
          <span className="inline-flex items-center gap-0.5 rounded-full bg-sunken px-2 py-1" aria-label={`${stars} of 3 stars`}>
            {[0, 1, 2].map((index) => <Star key={index} className="h-3.5 w-3.5" fill={index < stars ? "#ffc83d" : "transparent"} stroke={index < stars ? "#b77800" : "currentColor"} strokeOpacity={index < stars ? 1 : 0.35} aria-hidden />)}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-[12px] text-muted">
        Lesson {position.index} of {position.of} · {completed ? `Completed, best score ${stop.score}%.` : started ? "In progress: your correct answers are saved." : "Answer 70% correctly to complete it."}
      </p>
      <button ref={playRef} type="button" className="ax-btn mt-4 w-full" data-tone={completed ? undefined : "success"} onClick={onPlay}>
        {completed ? <><BookOpen className="h-5 w-5" aria-hidden />Review lesson</> : started ? <><Play className="h-5 w-5" fill="currentColor" aria-hidden />Continue</> : <><Play className="h-5 w-5" fill="currentColor" aria-hidden />Start lesson</>}
      </button>
      {completed ? <p className="mt-2 flex items-center justify-center gap-1 text-[12px] text-muted"><BookOpenText className="h-3.5 w-3.5" aria-hidden />XP for a lesson is paid once; reviews keep it fresh.</p> : null}
    </>
  );

  if (sheet) {
    // Attached to the page itself, so it sits above the app's bottom bar (the map is its own layer).
    return createPortal(
      <>
        <button type="button" tabIndex={-1} aria-label="Close lesson" className="fixed inset-0 z-[79]" style={{ background: "var(--scrim)" }} onClick={onClose} />
        <div role="dialog" aria-modal="true" aria-label={stop.title} className="mq-sheet">
          <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-border-strong" aria-hidden />
          <div className="relative mx-auto max-w-md">{body}</div>
        </div>
      </>,
      document.body,
    );
  }
  // Beside the stop: on its right when there is room, otherwise on its left.
  const right = anchor.left < 55;
  return (
    <>
      <button type="button" tabIndex={-1} aria-label="Close lesson" className="absolute inset-0 z-[7] cursor-default bg-transparent" onClick={onClose} />
      <div
        role="dialog"
        aria-label={stop.title}
        className="mq-panel"
        style={{
          top: `calc(${anchor.top}% - 150px)`,
          ...(right ? { left: `calc(${anchor.left}% + 64px)` } : { right: `calc(${100 - anchor.left}% + 64px)` }),
          ["--origin" as string]: right ? "left center" : "right center",
        }}
      >
        <span className="mq-pointer" style={right ? { left: -9, transform: "translateY(-50%) rotate(45deg)" } : { right: -9, transform: "translateY(-50%) rotate(225deg)" }} aria-hidden />
        <div className="relative">{body}</div>
      </div>
    </>
  );
}
