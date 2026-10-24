"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";
import { styles } from "./academy-game-classes";
import { AcademyHud } from "./academy-hud";
import { ChapterCard, RoadAhead } from "./chapter-card";
import { buildWorld, percent, pointAlong, starsFor, type MapLayout, type World } from "./geometry";
import { MapEnvironment } from "./map-environment";
import { StopNode } from "./stop-node";
import { StopPanel } from "./stop-panel";
import { Tiko } from "./tiko";
import { TutorDialogue } from "./tutor-dialogue";
import { WindingRoad } from "./winding-road";
import { THEME } from "./world-art";
import { api } from "@/components/api";
import { cue, useFeedbackPrefs } from "@/components/academy/academy-sound";
import { useAcademyFeel, usePresence } from "@/components/academy/academy-feel";
import { missionFor, type Line, type TikoMood } from "@/lib/academy/missions";
import { DAILY_GOAL_XP } from "@/lib/academy/rules";
import { journeyOf, type JourneyChapter, type JourneyStop, type JourneyUnit } from "@/lib/academy/world";

type Overview = {
  xp: { total: number; today: number; dailyGoal: number };
  streak: { current: number };
  units: JourneyUnit[];
  introSeen: boolean;
};

/** Where the map was scrolled, and a lesson just completed (set by the lesson), for the return trip. */
const SCROLL_KEY = "td-academy-scroll";
export const FRESH_KEY = "td-academy-fresh";

const MEDIA = "(max-width: 767px), (max-aspect-ratio: 4/5)";
function useLayout(): MapLayout {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(MEDIA);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => (window.matchMedia(MEDIA).matches ? "tall" : "wide"),
    () => "wide",
  );
}

function readSession(key: string) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function writeSession(key: string, value: string | null) {
  try { if (value == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Tiko rests beside a stop, on the side with more room. */
function besideStop(world: World, index: number) {
  const node = world.nodes[Math.max(0, Math.min(world.nodes.length - 1, index))];
  if (!node) return { left: 50, top: 10 };
  const offset = world.layout === "wide" ? 96 : 96;
  return percent(world, { x: node.x + (node.x > world.width / 2 ? -offset : offset), y: node.y - 6 });
}

type Guide = { at: number; mood: TikoMood; line: string | null };

/**
 * TradeD Academy as a journey: seven chapter regions along one road, every stop a real lesson. Progress
 * comes from /api/academy (the server's record); this component only draws it, guides with Tiko and
 * starts lessons.
 */
export function AcademyGameMap() {
  const router = useRouter();
  const layout = useLayout();
  const prefs = useFeedbackPrefs();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [walking, setWalking] = useState(false);
  // The stop that just opened (after a real completion): it bursts open when Tiko arrives.
  const [unlocked, setUnlocked] = useState<number | null>(null);
  const [hint, setHint] = useState<{ left: number; top: number; text: string; key: number } | null>(null);
  // Opening cinematic: road reveal, Tiko arrives, welcome, first mission. Null when not playing.
  const [intro, setIntro] = useState<null | "reveal" | "arrive" | "welcome" | "mission">(null);
  const [introMood, setIntroMood] = useState<TikoMood>("idle");
  const onIntroLine = useCallback((line: Line) => setIntroMood(line.mood), []);
  const worldRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<number, HTMLButtonElement | null>());
  const timers = useRef<number[]>([]);
  const frame = useRef(0);
  const hintSeq = useRef(0);

  useAcademyFeel(worldRef, Boolean(data));
  // The lesson panel animates out before it unmounts.
  const panel = usePresence(open, 200);
  const journey = useMemo(() => (data ? journeyOf(data.units) : null), [data]);
  const expanded = useMemo(() => journey?.chapters.filter((chapter) => chapter.expanded) ?? [], [journey]);
  const hidden = useMemo(() => journey?.chapters.filter((chapter) => !chapter.expanded) ?? [], [journey]);
  const world = useMemo(() => buildWorld(layout, expanded.map((chapter) => chapter.total), hidden.length), [layout, expanded, hidden]);
  const stops = useMemo(() => expanded.flatMap((chapter) => chapter.stops), [expanded]);
  const worldNow = useRef(world);
  useEffect(() => { worldNow.current = world; });

  const later = useCallback((ms: number, run: () => void) => { timers.current.push(window.setTimeout(run, ms)); }, []);
  useEffect(() => () => { timers.current.forEach((timer) => window.clearTimeout(timer)); cancelAnimationFrame(frame.current); }, []);

  /** Moves the map so a stop sits in the middle of the view. */
  const scrollToStop = useCallback((index: number, smooth: boolean) => {
    const box = worldRef.current;
    const node = nodeRefs.current.get(index);
    if (!box || !node) return;
    const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - box.clientHeight / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  }, []);

  /** Tiko flies along the road from one stop to another, then rests beside it. */
  const walk = useCallback((from: number, to: number, done: () => void) => {
    const element = guideRef.current;
    if (!element || reducedMotion()) { done(); return; }
    setWalking(true);
    const duration = 900 + Math.min(6, to - from) * 260;
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const at = percent(worldNow.current, pointAlong(worldNow.current, from, to, eased));
      element.style.left = `${at.left}%`;
      element.style.top = `${at.top}%`;
      if (t < 1) frame.current = requestAnimationFrame(step);
      else { setWalking(false); done(); }
    };
    frame.current = requestAnimationFrame(step);
  }, []);

  const load = useCallback(() => {
    api<Overview>("/api/academy")
      .then((next) => {
        setError("");
        // A lesson completed just now (and only once): animate its road, XP and Tiko on arrival.
        const justDone = readSession(FRESH_KEY);
        writeSession(FRESH_KEY, null);
        setFresh(justDone);
        setData(next);
        const plan = journeyOf(next.units);
        const visible = plan.chapters.filter((chapter) => chapter.expanded).flatMap((chapter) => chapter.stops);
        const current = visible.findIndex((stop) => stop.stop === "current");
        const target = current >= 0 ? current : visible.length - 1;
        const nextLine = current >= 0 ? `Next stop: ${visible[current].title}` : "You have finished every chapter. Review any stop to keep it fresh.";
        if (!next.introSeen) { setIntro("reveal"); return; }
        const doneAt = justDone ? visible.findIndex((stop) => stop.slug === justDone) : -1;
        if (doneAt >= 0 && current > doneAt) {
          // Celebrate where the lesson was, then fly to the next stop (and greet a new chapter).
          const newChapter = visible[current].chapter !== visible[doneAt].chapter ? plan.chapters[visible[current].chapter].def.name : null;
          setGuide({ at: doneAt, mood: "celebrate", line: "Lesson complete!" });
          later(1300, () => {
            setGuide({ at: doneAt, mood: "fly", line: null });
            scrollToStop(current, true);
            walk(doneAt, current, () => {
              setUnlocked(current);
              cue("unlock");
              setGuide({ at: current, mood: "point", line: newChapter ? `Welcome to ${newChapter}!` : nextLine });
              later(4200, () => setGuide({ at: current, mood: "idle", line: null }));
            });
          });
          return;
        }
        setGuide({ at: target, mood: doneAt >= 0 ? "celebrate" : "point", line: doneAt >= 0 ? "Every chapter complete!" : nextLine });
        later(3600, () => setGuide({ at: target, mood: "idle", line: null }));
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The Academy could not be loaded."));
  }, [later, scrollToStop, walk]);
  useEffect(() => { load(); }, [load]);

  // The cinematic's timed beats (each later step waits for the learner instead).
  useEffect(() => {
    if (intro !== "reveal" && intro !== "arrive") return;
    const timer = window.setTimeout(() => setIntro(intro === "reveal" ? "arrive" : "welcome"), reducedMotion() ? 0 : intro === "reveal" ? 1300 : 1000);
    return () => window.clearTimeout(timer);
  }, [intro]);

  // Arriving: back where the map was when a lesson started, otherwise at the stop that matters.
  const placed = useRef(false);
  useEffect(() => {
    if (!data || placed.current || !worldRef.current) return;
    placed.current = true;
    const saved = Number(readSession(SCROLL_KEY));
    writeSession(SCROLL_KEY, null);
    if (Number.isFinite(saved) && saved > 0) { worldRef.current.scrollTop = saved; return; }
    const plan = journeyOf(data.units);
    const visible = plan.chapters.filter((chapter) => chapter.expanded).flatMap((chapter) => chapter.stops);
    const doneAt = fresh ? visible.findIndex((stop) => stop.slug === fresh) : -1;
    const current = visible.findIndex((stop) => stop.stop === "current");
    const target = doneAt >= 0 ? doneAt : current >= 0 ? current : visible.length - 1;
    if (target > 0) requestAnimationFrame(() => scrollToStop(target, false));
  }, [data, fresh, scrollToStop]);

  // Background motion pauses while the tab is hidden.
  useEffect(() => {
    const box = worldRef.current;
    if (!box) return;
    const onVisibility = () => box.classList.toggle(styles.paused, document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [data]);

  if (error && !data) {
    return (
      <div className={`${styles.world} grid h-full place-items-center p-6 text-center`}>
        <div className="flex flex-col items-center">
          <Tiko mood="confused" size={88} />
          <p className="mt-2 text-[15px] font-bold">{error}</p>
          <button type="button" className="mt-3 inline-flex h-11 items-center gap-2 rounded-full bg-white/15 px-5 font-bold hover:bg-white/25" style={{ color: "#fff" }} onClick={load}><RefreshCw className="h-4 w-4" aria-hidden />Retry</button>
        </div>
      </div>
    );
  }
  if (!data || !journey) return <div className={`${styles.world} h-full`} aria-busy="true" aria-label="Loading the Academy" />;

  const motion = typeof window !== "undefined" && !reducedMotion() && prefs.motion;
  const lead = stops.findIndex((stop) => stop.stop !== "completed");
  const completedUpTo = lead < 0 ? stops.length - 1 : lead - 1;
  const current = stops.findIndex((stop) => stop.stop === "current");
  const currentChapter = current >= 0 ? journey.chapters[stops[current].chapter] : null;
  const freshStop = fresh ? stops.find((stop) => stop.slug === fresh) : undefined;
  const freshChapter = freshStop && currentChapter && currentChapter.index !== freshStop.chapter ? currentChapter.index : -1;
  const wide = layout === "wide";
  const positionOf = (stop: JourneyStop) => ({ index: journey.chapters[stop.chapter].stops.indexOf(stop) + 1, of: journey.chapters[stop.chapter].total });
  const openStop = panel.shown != null ? stops[panel.shown] ?? null : null;

  // One background for the whole journey: each region's colours, blended where regions meet.
  const stopsCss: string[] = [];
  world.chapters.forEach((box) => {
    const [from, to] = THEME[expanded[box.index].def.theme].ground;
    stopsCss.push(`${from} ${((box.top + 40) / world.height) * 100}%`, `${to} ${((box.top + box.height - 60) / world.height) * 100}%`);
  });
  if (world.fog) stopsCss.push(`#33476b ${((world.fog.top + 60) / world.height) * 100}%`, "#1c2740 100%");
  const background = `linear-gradient(180deg, ${stopsCss.join(", ")})`;

  /** The intro was watched or skipped: remember it on the account (best effort). */
  function endIntro() {
    setIntro(null);
    const target = current >= 0 ? current : 0;
    setGuide({ at: target, mood: "idle", line: null });
    if (!data?.introSeen) void api("/api/academy", { action: "intro-seen" }).catch(() => undefined);
  }

  function play(index: number) {
    const stop = stops[index];
    if (!stop || stop.stop === "locked" || launching) return;
    cue("start");
    writeSession(SCROLL_KEY, String(worldRef.current?.scrollTop ?? 0));
    setOpen(null);
    setLaunching(stop.slug);
    window.setTimeout(() => router.push(`/academy/lesson/${stop.slug}`), reducedMotion() ? 0 : 360);
  }
  const close = () => {
    const index = open;
    if (index != null) cue("close");
    setOpen(null);
    if (index != null) nodeRefs.current.get(index)?.focus();
  };
  function showHint(at: { left: number; top: number }, text: string) {
    const key = (hintSeq.current += 1);
    setHint({ left: Math.max(wide ? 22 : 36, Math.min(wide ? 78 : 64, at.left)), top: at.top, text, key });
    setGuide((value) => (value ? { ...value, mood: "explain" } : value));
    later(3400, () => setHint((value) => (value?.key === key ? null : value)));
  }
  function lockedStop(index: number) {
    cue("locked");
    const stop = stops[index];
    const before = stops[index - 1];
    const at = percent(world, world.nodes[index]);
    const chapter = journey!.chapters[stop.chapter];
    const previousChapter = journey!.chapters[stop.chapter - 1];
    const text = chapter.status === "locked" && previousChapter
      ? `${chapter.def.name} opens when you finish ${previousChapter.def.name}.`
      : `Finish “${before?.title ?? "the lesson before"}” first to unlock this stop.`;
    showHint({ left: at.left, top: at.top + (wide ? 9 : 5) }, text);
  }
  function aheadHint(chapter: JourneyChapter) {
    const previous = journey!.chapters[chapter.index - 1];
    const top = world.fog ? ((world.fog.top + 40) / world.height) * 100 : 50;
    showHint({ left: 50, top }, `${chapter.def.name} opens after ${previous?.def.name ?? "the chapter before"}. Keep going: it is on this road.`);
  }
  const jump = () => {
    const target = current >= 0 ? current : stops.length - 1;
    scrollToStop(target, true);
    setGuide({ at: target, mood: "point", line: current >= 0 ? `Next stop: ${stops[target].title}` : "You have finished every chapter!" });
    later(3200, () => setGuide({ at: target, mood: "idle", line: null }));
  };

  const guideAt = guide ? besideStop(world, guide.at) : null;
  const introAt = besideStop(world, 0);
  const width = wide ? "min(100%, 1180px)" : "min(100%, 560px)";

  return (
    <div ref={worldRef} data-motion={prefs.motion ? undefined : "off"} className={`${styles.world} ${wide ? "" : "mq-tall"} h-full overflow-y-auto overflow-x-hidden ${launching ? styles.launching : ""}`}>
      <AcademyHud
        xp={data.xp.total}
        streak={data.streak.current}
        today={data.xp.today}
        goal={data.xp.dailyGoal || DAILY_GOAL_XP}
        bumpXp={Boolean(fresh)}
        onReplayIntro={intro ? undefined : () => setIntro("reveal")}
        chapter={currentChapter ? { name: currentChapter.def.name, done: currentChapter.done, total: currentChapter.total } : null}
        onJump={stops.length ? jump : undefined}
      />
      <div className="relative -mt-14 w-full" style={{ background }}>
        <div className="relative mx-auto" style={{ width, aspectRatio: `${world.width} / ${world.height}` }}>
          <MapEnvironment world={world} chapters={expanded.map((chapter) => ({ theme: chapter.def.theme, complete: chapter.status === "complete" }))} />
          <WindingRoad world={world} completedUpTo={completedUpTo} current={current} fresh={Boolean(freshStop)} motion={motion} />

          {expanded.map((chapter, chapterIndex) => {
            const box = world.chapters[chapterIndex];
            const cardStyle: React.CSSProperties = wide
              ? { top: `${((box.top + 36) / world.height) * 100}%`, width: "36%", ...(box.side === "right" ? { left: "3%" } : { right: "3%" }) }
              : { top: `${((box.top + 18) / world.height) * 100}%`, left: "4%", width: "92%" };
            return (
              <section key={chapter.unit.id} aria-label={`Chapter ${chapter.unit.number}: ${chapter.def.name}`}>
                <ChapterCard chapter={chapter} previous={journey.chapters[chapterIndex - 1]?.def.name ?? null} style={cardStyle} fresh={chapterIndex === freshChapter} />
                {chapter.stops.map((stop) => {
                  const index = stops.indexOf(stop);
                  const at = percent(world, world.nodes[index]);
                  return (
                    <StopNode
                      key={stop.slug}
                      ref={(node) => { nodeRefs.current.set(index, node); }}
                      stop={stop}
                      theme={chapter.def.theme}
                      chapterName={chapter.def.name}
                      position={positionOf(stop)}
                      left={at.left}
                      top={at.top}
                      order={index}
                      stars={starsFor(stop.score)}
                      story={Boolean(missionFor(stop.slug))}
                      launching={launching === stop.slug}
                      unlocked={unlocked === index}
                      onOpen={() => { scrollToStop(index, false); cue("open"); setOpen(index); }}
                      onLocked={() => lockedStop(index)}
                    />
                  );
                })}
              </section>
            );
          })}

          {world.fog && currentChapter ? (
            <RoadAhead chapters={hidden} current={currentChapter.def.name} onHint={aheadHint} style={{ top: `${((world.fog.top + 30) / world.height) * 100}%`, left: "4%", width: "92%" }} />
          ) : null}

          {openStop && panel.shown != null ? (
            <StopPanel
              closing={panel.closing}
              stop={openStop}
              theme={journey.chapters[openStop.chapter].def.theme}
              chapter={{ number: journey.chapters[openStop.chapter].unit.number, name: journey.chapters[openStop.chapter].def.name }}
              position={positionOf(openStop)}
              stars={starsFor(openStop.score)}
              story={Boolean(missionFor(openStop.slug))}
              sheet={!wide}
              anchor={percent(world, world.nodes[panel.shown])}
              onPlay={() => play(panel.shown!)}
              onClose={close}
            />
          ) : null}

          {/* Tiko, the guide: beside the next stop, celebrating real completions, flying along the road. */}
          {guide && guideAt && !intro ? (
            <div ref={guideRef} className="mq-guide" data-walking={walking ? "true" : undefined} style={{ left: `${guideAt.left}%`, top: `${guideAt.top}%` }}>
              {guide.line && !walking ? <span className="mq-guide-bubble" data-away={world.nodes[guide.at] && world.nodes[guide.at].x > world.width / 2 ? "left" : "right"} role="status">{guide.line}</span> : null}
              <Tiko mood={walking ? "fly" : guide.mood} size={wide ? 78 : 62} facing={world.nodes[guide.at] && world.nodes[guide.at].x > world.width / 2 ? "right" : "left"} />
            </div>
          ) : null}
          {intro && intro !== "reveal" ? (
            <div className="pointer-events-none absolute z-[9]" style={{ left: `${introAt.left}%`, top: `${introAt.top}%`, transform: "translate(-50%, -62%)" }}>
              {intro === "arrive" ? <span className="mq-landing absolute left-1/2 top-[90%] block h-6 w-24 -translate-x-1/2 rounded-full border-4 border-[#38e1ff]/70" aria-hidden /> : null}
              <Tiko mood={intro === "arrive" ? "enter" : introMood} size={wide ? 96 : 76} facing={world.nodes[0] && world.nodes[0].x > world.width / 2 ? "right" : "left"} />
            </div>
          ) : null}
          {hint ? (
            <div key={hint.key} className="mq-hint" role="status" style={{ left: `${hint.left}%`, top: `${hint.top}%` }}>
              <Tiko mood="explain" size={40} />
              <span>{hint.text}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className={styles.veil} aria-hidden />

      {/* Attached to the page itself, so it sits above the app's bottom bar (the map is its own layer). */}
      {intro ? createPortal(
        <div className="fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-3 px-3 pb-[max(1rem,env(safe-area-inset-bottom))]" role="dialog" aria-label="Welcome to the TradeD Academy">
          <button type="button" className="self-end rounded-full bg-black/45 px-4 py-2 text-[13px] font-bold hover:bg-black/60" style={{ color: "#fff" }} onClick={endIntro}>Skip intro</button>
          {intro === "welcome" || intro === "mission" ? (
            <div className="w-full max-w-xl">
              {intro === "welcome" ? (
                <div className="mq-title-card mb-3 text-center">
                  <p className="text-[clamp(1.5rem,4vw,2.25rem)] font-black tracking-tight text-white drop-shadow-[0_3px_0_rgba(0,0,0,.35)]">Welcome to Market Quest</p>
                  <p className="text-[14px] font-semibold text-white/85">Seven regions. One road. Learn the market one stop at a time.</p>
                </div>
              ) : null}
              {intro === "welcome" ? (
                <TutorDialogue
                  lines={[
                    { mood: "enter", text: "Welcome to Market City! I’m Tiko, your market guide." },
                    { mood: "explain", text: "Every stop on this road is a lesson. Finish one and the road to the next opens." },
                    { mood: "point", text: "Seven regions lie ahead, from Candlestick Canyon to Strategy Summit." },
                  ]}
                  onDone={() => setIntro("mission")}
                  doneLabel="Show me"
                  onLine={onIntroLine}
                  avatar={false}
                />
              ) : (
                <div className="flex flex-col gap-2">
                  <TutorDialogue lines={[{ mood: "point", text: "Your first stop is a story mission in Market City: learn how prices move and make your first plan." }]} onLine={onIntroLine} avatar={false} />
                  <button type="button" className={styles.play} onClick={() => { endIntro(); play(0); }}>START YOUR FIRST MISSION</button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      , document.body) : null}
      <p className="sr-only" aria-live="polite">{current >= 0 ? `Next lesson: ${stops[current].title}, in ${currentChapter?.def.name}.` : "Every chapter is complete."}</p>
    </div>
  );
}
