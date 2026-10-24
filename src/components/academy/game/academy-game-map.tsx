"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";
import { styles } from "./academy-game-classes";
import { AcademyHud } from "./academy-hud";
import { LEVELS, VIEWBOX, nodePercent, starsFor, type MapLayout } from "./geometry";
import { LevelNode, type LevelStatus } from "./level-node";
import { LevelPanel } from "./level-panel";
import { MapEnvironment } from "./map-environment";
import { WindingRoad } from "./winding-road";
import { Tiko } from "./tiko";
import { TutorDialogue } from "./tutor-dialogue";
import type { Line, TikoMood } from "@/lib/academy/missions";
import { api } from "@/components/api";
import { DAILY_GOAL_XP, XP_RULES } from "@/lib/academy/rules";

type LessonInfo = { slug: string; minutes: number; questions: number; state: "locked" | "available" | "in-progress" | "completed" | "mastered"; score: number };
type Overview = {
  level: { xp: number };
  xp: { total: number; today: number; dailyGoal: number };
  streak: { current: number };
  units: Array<{ lessons: LessonInfo[] }>;
  introSeen: boolean;
};

/** Where the map was scrolled, and a level just completed (set by the lesson), for the return trip. */
const SCROLL_KEY = "td-academy-scroll";
export const FRESH_KEY = "td-academy-fresh";

function useLayout(): MapLayout {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia("(max-width: 767px), (max-aspect-ratio: 4/5)");
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => (window.matchMedia("(max-width: 767px), (max-aspect-ratio: 4/5)").matches ? "tall" : "wide"),
    () => "wide",
  );
}

function readSession(key: string) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function writeSession(key: string, value: string | null) {
  try { if (value == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

/**
 * TradeD Academy as a game: the Market Quest level map. Progress comes from /api/academy (the
 * server's record); this component only draws it and starts levels.
 */
export function AcademyGameMap() {
  const router = useRouter();
  const layout = useLayout();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  // Opening cinematic: road reveal, Tiko arrives, welcome, first mission. Null when not playing.
  const [intro, setIntro] = useState<null | "reveal" | "arrive" | "welcome" | "mission">(null);
  // The map's Tiko acts out the line he is saying in the intro.
  const [introMood, setIntroMood] = useState<TikoMood>("idle");
  const onIntroLine = useCallback((line: Line) => setIntroMood(line.mood), []);
  const worldRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement | null>());

  const load = useCallback(() => {
    api<Overview>("/api/academy")
      .then((next) => {
        setError("");
        // A level completed just now (and only once): animate its road and XP on arrival.
        const justDone = readSession(FRESH_KEY);
        writeSession(FRESH_KEY, null);
        setFresh(justDone);
        if (!next.introSeen) setIntro("reveal");
        setData(next);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The Academy could not be loaded."));
  }, []);
  useEffect(() => { load(); }, [load]);

  // The cinematic's timed beats (each later step waits for the learner instead).
  useEffect(() => {
    if (intro !== "reveal" && intro !== "arrive") return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => setIntro(intro === "reveal" ? "arrive" : "welcome"), reduce ? 0 : intro === "reveal" ? 1300 : 1000);
    return () => window.clearTimeout(timer);
  }, [intro]);

  // Coming back from a level: the map scrolls to where it was.
  useEffect(() => {
    if (!data || !worldRef.current) return;
    const saved = Number(readSession(SCROLL_KEY));
    if (Number.isFinite(saved) && saved > 0) worldRef.current.scrollTop = saved;
  }, [data]);

  // Background motion pauses while the tab is hidden; desktop pointers get a little parallax.
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const onVisibility = () => world.classList.toggle(styles.paused, document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      if (!fine) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = world.getBoundingClientRect();
        world.style.setProperty("--px", (((event.clientX - box.left) / box.width) * 2 - 1).toFixed(3));
        world.style.setProperty("--py", (((event.clientY - box.top) / box.height) * 2 - 1).toFixed(3));
      });
    };
    world.addEventListener("pointermove", onMove);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      world.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [data]);

  if (error && !data) {
    return (
      <div className={`${styles.world} grid h-full place-items-center p-6 text-center`}>
        <div>
          <p className="text-[15px] font-bold">{error}</p>
          <button type="button" className="mt-3 inline-flex h-11 items-center gap-2 rounded-full bg-white/15 px-5 font-bold hover:bg-white/25" onClick={load}><RefreshCw className="h-4 w-4" aria-hidden />Retry</button>
        </div>
      </div>
    );
  }
  if (!data) return <div className={`${styles.world} h-full`} aria-busy="true" aria-label="Loading the Academy" />;

  const lessons = new Map(data.units.flatMap((unit) => unit.lessons).map((lesson) => [lesson.slug, lesson]));
  const first = lessons.get(LEVELS[0].lessonSlug ?? "");
  const firstDone = first?.state === "completed" || first?.state === "mastered";
  const statusOf = (index: number): LevelStatus => {
    const slug = LEVELS[index].lessonSlug;
    if (!slug) return "locked";
    const lesson = lessons.get(slug);
    return lesson?.state === "completed" || lesson?.state === "mastered" ? "completed" : lesson?.state === "locked" ? "locked" : "active";
  };
  const lockedNote = (index: number) => (index === 1 && !firstDone) || index > 1 && !firstDone
    ? `Complete Level ${String(index).padStart(2, "0")} to unlock the next level.`
    : `${LEVELS[index].title} opens in the next release.`;
  const completedUpTo = LEVELS.reduce((last, _, index) => (statusOf(index) === "completed" ? index : last), -1);
  const box = VIEWBOX[layout];
  const openLevel = LEVELS.find((level) => level.id === open) ?? null;
  const openIndex = openLevel ? LEVELS.indexOf(openLevel) : -1;
  const openLesson = openLevel?.lessonSlug ? lessons.get(openLevel.lessonSlug) : undefined;

  /** The intro was watched or skipped: remember it on the account (best effort). */
  function endIntro() {
    setIntro(null);
    if (!data?.introSeen) void api("/api/academy", { action: "intro-seen" }).catch(() => undefined);
  }

  function play(level = openLevel) {
    if (!level?.lessonSlug || launching) return;
    writeSession(SCROLL_KEY, String(worldRef.current?.scrollTop ?? 0));
    const target = level.lessonSlug;
    setOpen(null);
    setLaunching(level.id);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => router.push(`/academy/lesson/${target}`), reduce ? 0 : 360);
  }
  const close = () => {
    const id = open;
    setOpen(null);
    if (id) nodeRefs.current.get(id)?.focus();
  };

  return (
    <div ref={worldRef} className={`${styles.world} h-full overflow-y-auto overflow-x-hidden ${launching ? styles.launching : ""}`}>
      <AcademyHud xp={data.xp.total} streak={data.streak.current} today={data.xp.today} goal={data.xp.dailyGoal || DAILY_GOAL_XP} bumpXp={Boolean(fresh)} onReplayIntro={intro ? undefined : () => setIntro("reveal")} />
      <div
        className="relative mx-auto"
        style={layout === "wide"
          ? { width: "min(100%, calc((100dvh - var(--topbar) - 64px) * 16 / 9))", aspectRatio: `${box.width} / ${box.height}`, marginTop: -8 }
          : { width: "100%", aspectRatio: `${box.width} / ${box.height}` }}
      >
        <MapEnvironment layout={layout} />
        <WindingRoad layout={layout} completedUpTo={completedUpTo} fresh={Boolean(fresh)} />
        {LEVELS.map((level, index) => {
          const at = nodePercent(layout, index);
          const lesson = level.lessonSlug ? lessons.get(level.lessonSlug) : undefined;
          return (
            <LevelNode
              key={level.id}
              ref={(node) => { nodeRefs.current.set(level.id, node); }}
              level={level}
              status={statusOf(index)}
              stars={starsFor(lesson?.score ?? 0)}
              left={at.left}
              top={at.top}
              order={index}
              launching={launching === level.id}
              lockedNote={lockedNote(index)}
              onOpen={() => setOpen(level.id)}
            />
          );
        })}
        {openLevel && openLesson ? (
          <LevelPanel
            level={openLevel}
            sheet={layout === "tall"}
            anchor={nodePercent(layout, openIndex)}
            info={{
              minutes: openLesson.minutes,
              questions: openLesson.questions,
              xp: XP_RULES.lessonComplete + XP_RULES.quizComplete + openLesson.questions * XP_RULES.correctAnswer,
              stars: starsFor(openLesson.score),
              completed: openLesson.state === "completed" || openLesson.state === "mastered",
            }}
            onPlay={() => play()}
            onClose={close}
          />
        ) : null}
        {/* Tiko waits beside the next level (outside the cinematic, which places him itself). */}
        {!intro && !launching ? (() => {
          const target = LEVELS.findIndex((_, index) => statusOf(index) === "active");
          const at = nodePercent(layout, target >= 0 ? target : Math.max(0, completedUpTo));
          return (
            <div className="pointer-events-none absolute z-[3]" style={{ left: `${at.left + (layout === "wide" ? 7 : 16)}%`, top: `${at.top - (layout === "wide" ? 4 : 2)}%`, transform: "translate(-50%, -50%)" }}>
              <Tiko mood={fresh ? "celebrate" : "idle"} size={layout === "wide" ? 76 : 64} facing="left" />
            </div>
          );
        })() : null}
        {intro && intro !== "reveal" ? (() => {
          const at = nodePercent(layout, 0);
          return (
            <div className="pointer-events-none absolute z-[9]" style={{ left: `${at.left + (layout === "wide" ? 7 : 16)}%`, top: `${at.top - (layout === "wide" ? 4 : 2)}%`, transform: "translate(-50%, -50%)" }}>
              {intro === "arrive" ? <span className="mq-landing absolute left-1/2 top-[90%] block h-6 w-24 -translate-x-1/2 rounded-full border-4 border-[#38e1ff]/70" aria-hidden /> : null}
              <Tiko mood={intro === "arrive" ? "enter" : introMood} size={layout === "wide" ? 96 : 76} facing="left" />
            </div>
          );
        })() : null}
        <div className={styles.veil} aria-hidden />
      </div>
      {/* Attached to the page itself, so it sits above the app's bottom bar (the map is its own layer). */}
      {intro ? createPortal(
        <div className="fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-3 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] lg:left-[var(--rail)]" role="dialog" aria-label="Welcome to Market Quest">
          <button type="button" className="self-end rounded-full bg-black/45 px-4 py-2 text-[13px] font-bold hover:bg-black/60" style={{ color: "#fff" }} onClick={endIntro}>Skip intro</button>
          {intro === "welcome" || intro === "mission" ? (
            <div className="w-full max-w-xl">
              {intro === "welcome" ? (
                <div className="mq-title-card mb-3 text-center">
                  <p className="text-[clamp(1.5rem,4vw,2.25rem)] font-black tracking-tight text-white drop-shadow-[0_3px_0_rgba(0,0,0,.35)]">Welcome to Market Quest</p>
                  <p className="text-[14px] font-semibold text-white/85">Learn the market. Practise your decisions. Build your skills.</p>
                </div>
              ) : null}
              {intro === "welcome" ? (
                <TutorDialogue
                  lines={[
                    { mood: "enter", text: "Welcome to Market City! I\u2019m Tiko, your market guide." },
                    { mood: "explain", text: "Each platform is a mission. Finish one to open the road to the next." },
                  ]}
                  onDone={() => setIntro("mission")}
                  doneLabel="Show me"
                  onLine={onIntroLine}
                  avatar={false}
                />
              ) : (
                <div className="flex flex-col gap-2">
                  <TutorDialogue lines={[{ mood: "point", text: "Your first mission is in Market City: learn how prices move and make your first plan." }]} onLine={onIntroLine} avatar={false} />
                  <button type="button" className={styles.play} onClick={() => { endIntro(); play(LEVELS[0]); }}>START YOUR FIRST MISSION</button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      , document.body) : null}
      <p className="sr-only" aria-live="polite">{firstDone ? "Level 1 completed. Levels 2 and 3 open in a later release." : "Level 1, Market Explorer, is ready to play."}</p>
    </div>
  );
}
