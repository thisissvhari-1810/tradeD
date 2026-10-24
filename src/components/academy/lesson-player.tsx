"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Award, BookOpen, Flame, Lightbulb, RefreshCw, X, Zap } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { CandleSketch } from "@/components/academy/candle-sketch";
import { cue, useFeedbackPrefs } from "@/components/academy/academy-sound";
import { AcademyAudioSettings } from "@/components/academy/audio-settings";
import { useAcademyFeel, usePresence } from "@/components/academy/academy-feel";
import { FRESH_KEY } from "@/components/academy/game/academy-game-map";
import { starsFor } from "@/components/academy/game/geometry";
import { RewardCelebration } from "@/components/academy/game/reward-celebration";
import { Tiko } from "@/components/academy/game/tiko";
import { COMBO, useLessonDirector } from "@/components/academy/lesson/director";
import { ExerciseView, inputOf, type Draft, type Feedback } from "@/components/academy/lesson/exercise-view";
import { AcademyFeedbackTray } from "@/components/academy/lesson/feedback-tray";
import { TutorStage } from "@/components/academy/lesson/tutor-stage";
import { AcademyTransition, SWAP, TRANSITION_MS, type TransitionRun } from "@/components/academy/transition";
import { worldOf } from "@/components/academy/game/worlds/config";
import { hasVisual } from "@/components/academy/lesson/exercise-view";
import type { AcademyTheme } from "@/lib/academy/themes";
import type { LessonCard, PublicQuestion } from "@/lib/academy/types";

export type { Feedback } from "@/components/academy/lesson/exercise-view";
export { COMBO } from "@/components/academy/lesson/director";

type LessonData = {
  slug: string;
  title: string;
  summary: string;
  minutes: number;
  unit: { number: number; title: string };
  position: { index: number; of: number };
  state: string;
  cards: LessonCard[];
  questions: PublicQuestion[];
  answeredCorrectly: string[];
  passPercent: number;
  /** The learner's map world: the transitions take its weather. */
  theme: AcademyTheme | null;
};

const WIDE = "(min-width: 1024px)";
/** Wide screens show a chart beside the question (as a trading mission), phones stack them. */
function useWide() {
  return useSyncExternalStore(
    (notify) => { const query = window.matchMedia(WIDE); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify); },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}
type Completion = { score: number; firstTime: boolean; xp: number; xpTotal: number; newBadges: Array<{ name: string; description: string }>; streak: { current: number; todayDone: boolean }; level: { level: number; title: string } };
type Step = { kind: "tip"; index: number } | { kind: "question"; id: string };
type Phase = "play" | "saving" | "done" | "save-error";

const PRAISE = ["Nice work!", "Exactly right!", "Spot on!", "Great reading!", "You got it!"];

/** Same praise for the same question (no randomness during render). */
function praiseFor(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PRAISE[hash % PRAISE.length];
}
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The lesson's screens: its tips first (the questions build on them), then one exercise per screen. */
function stepsFor(data: LessonData): Step[] {
  const open = data.questions.filter((question) => !data.answeredCorrectly.includes(question.id));
  const review = open.length === 0;
  const resumed = !review && open.length < data.questions.length;
  const questions: Step[] = (review ? data.questions : open).map((question) => ({ kind: "question", id: question.id }));
  // A learner returning to a half-finished lesson goes straight to the exercises (tips stay one tap away).
  const tips: Step[] = resumed ? [] : data.cards.map((_, index) => ({ kind: "tip", index }));
  return [...tips, ...questions];
}

/**
 * A lesson as a sequence of focused screens: short tips, then one exercise at a time. Every learner
 * action is one event for the lesson director (Tiko's pose and bubble, one sound, glow); every answer
 * is checked by the server and XP and completion come only from the server's records.
 */
export function LessonPlayer({ slug }: { slug: string }) {
  const router = useRouter();
  const prefs = useFeedbackPrefs();
  const { stage, dispatch } = useLessonDirector();
  const [lesson, setLesson] = useState<LessonData | null>(null);
  const [error, setError] = useState<{ message: string; locked: boolean } | null>(null);
  const [queue, setQueue] = useState<Step[]>([]);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  // Each screen shown gets a new turn number: it keys the screen's animation and its draft answer.
  const [turn, setTurn] = useState(0);
  const [draft, setDraft] = useState<{ turn: number; value: Draft }>({ turn: 0, value: {} });
  const [nod, setNod] = useState(0);
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [hintFor, setHintFor] = useState<number | null>(null);
  const [combo, setCombo] = useState(0);
  const [mistakes, setMistakes] = useState(0);
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const [bump, setBump] = useState(0);
  const [xpEarned, setXpEarned] = useState(0);
  const [phase, setPhase] = useState<Phase>("play");
  const [leaving, setLeaving] = useState(false);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [saveError, setSaveError] = useState("");
  const [tipsOpen, setTipsOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const wide = useWide();
  // The cinematic between screens; while it plays nothing in the lesson can be pressed.
  const [transition, setTransition] = useState<TransitionRun | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const later = (ms: number, run: () => void) => { timers.current.push(window.setTimeout(run, ms)); };
  const motion = prefs.motion && !reducedMotion();
  useAcademyFeel(shell, Boolean(lesson), 0.72);
  const tipsSheet = usePresence(tipsOpen ? true : null, 220);
  const openTips = () => { cue("open"); setTipsOpen(true); };
  const closeTips = useCallback(() => { cue("close"); setTipsOpen(false); }, []);

  const byIdOf = (data: LessonData) => new Map(data.questions.map((question) => [question.id, question]));

  /** Tells the director what the screen now showing is. */
  const enter = useCallback((step: Step | undefined, data: LessonData, context: { afterTips: boolean; retry: boolean; index: number; first: boolean }) => {
    if (!step) return;
    if (step.kind === "tip") dispatch({ type: "TIP_ENTER", index: step.index, first: context.first });
    else {
      const question = byIdOf(data).get(step.id);
      if (question) dispatch({ type: "QUESTION_ENTER", question, index: context.index, afterTips: context.afterTips, retry: context.retry });
    }
  }, [dispatch]);

  const start = useCallback((data: LessonData) => {
    const steps = stepsFor(data);
    setLesson(data);
    setQueue(steps);
    setTotal(steps.length);
    setDone(0);
    setTurn((value) => value + 1);
    setFeedback(null);
    setCheckError(null);
    setHintFor(null);
    setCombo(0);
    setMistakes(0);
    setAsked(new Set(steps[0]?.kind === "question" ? [steps[0].id] : []));
    setXpEarned(0);
    setPhase("play");
    setCompletion(null);
    setBump(0);
    enter(steps[0], data, { afterTips: true, retry: false, index: 0, first: true });
  }, [enter]);

  const load = useCallback(() => {
    api<LessonData>(`/api/academy/lessons/${encodeURIComponent(slug)}`)
      .then((data) => { setError(null); start(data); })
      .catch((caught: unknown) => setError({ message: caught instanceof Error ? caught.message : "The lesson could not be loaded.", locked: caught instanceof ApiError && caught.status === 403 }));
  }, [slug, start]);
  useEffect(() => { load(); }, [load]);

  const byId = useMemo(() => new Map((lesson?.questions ?? []).map((question) => [question.id, question])), [lesson]);
  const step = queue[0] ?? null;
  const question = step?.kind === "question" ? byId.get(step.id) ?? null : null;
  const value = draft.turn === turn ? draft.value : {};
  const input = question ? inputOf(question, value) : null;
  const locked = checking || Boolean(feedback) || leaving || transition != null;
  const hintOpen = hintFor === turn;

  /** Continue: the bubble closes into Tiko, the screen slides out, the next one comes in and Tiko speaks. */
  function advance(next: Step[], strength: TransitionRun["intensity"] = "soft") {
    if (!lesson || leaving || transition) return;
    const data = lesson;
    const wasTip = step?.kind === "tip";
    dispatch({ type: "CONTINUE_PRESSED" });
    const go = () => {
      setLeaving(false);
      setQueue(next);
      setFeedback(null);
      setCheckError(null);
      setTurn((current) => current + 1);
      scroller.current?.scrollTo({ top: 0 });
      if (!next.length) { void finish(); return; }
      const upcoming = next[0];
      const retry = upcoming.kind === "question" && asked.has(upcoming.id);
      if (upcoming.kind === "question") setAsked((current) => new Set(current).add(upcoming.id));
      enter(upcoming, data, { afterTips: wasTip, retry, index: turn + 1, first: false });
    };
    if (!motion) { go(); requestAnimationFrame(() => heading.current?.focus({ preventScroll: true })); return; }
    // The world's weather sweeps in, the screens swap behind it, then it parts on the next one. Timers
    // (not animation events) drive each step, so a failed animation can never hold the lesson up.
    const intensity = next.length ? strength : "grand";
    const duration = TRANSITION_MS[intensity];
    setLeaving(true);
    setTransition({ key: turn + 1, style: worldOf(data.theme).transition, intensity });
    later(duration * SWAP, go);
    later(duration, () => {
      setTransition(null);
      if (next.length) cue("reveal");
      // Focus once the content is interactive again (it stays inert until this update has rendered).
      requestAnimationFrame(() => requestAnimationFrame(() => heading.current?.focus({ preventScroll: true })));
    });
  }

  function nextTip() {
    if (leaving) return;
    setDone((value) => value + 1);
    setBump((value) => value + 1);
    const next = queue.slice(1);
    advance(next, next[0]?.kind === "question" ? "full" : "soft");
  }

  function skipTips() {
    if (leaving) return;
    const tips = queue.filter((item) => item.kind === "tip").length;
    setDone((value) => value + tips);
    setBump((value) => value + 1);
    advance(queue.filter((item) => item.kind !== "tip"), "full");
  }

  /** A tap that picks or places an answer: Tiko listens and nods (no words, no interruption). */
  function picked() {
    setNod((value) => value + 1);
    dispatch({ type: "ANSWER_SELECTED" });
  }

  function toggleHint() {
    if (!question?.hint) return;
    if (hintOpen) { setHintFor(null); dispatch({ type: "HINT_CLOSED" }); }
    else { setHintFor(turn); dispatch({ type: "HINT_OPENED", hint: question.hint }); }
  }

  async function check() {
    if (!question || !input || locked) return;
    dispatch({ type: "CHECK_STARTED" });
    setHintFor(null);
    setChecking(true);
    setCheckError(null);
    try {
      const result = await api<Feedback>(`/api/academy/lessons/${encodeURIComponent(slug)}`, { action: "answer", questionId: question.id, answer: input });
      setFeedback(result);
      setXpEarned((value) => value + result.xp);
      if (result.correct) {
        const streak = combo + 1;
        setCombo(streak);
        setDone((value) => value + 1);
        setBump((value) => value + 1);
        dispatch({ type: "ANSWER_CORRECT", combo: streak, index: turn });
      } else {
        setCombo(0);
        setMistakes((value) => value + 1);
        dispatch({ type: "ANSWER_INCORRECT", hint: question.hint ?? null, index: turn });
      }
      // Bring the verdict on the exercise itself into view above the tray.
      requestAnimationFrame(() => scroller.current?.querySelector("[data-result], .ax-line-handle")?.scrollIntoView({ block: "nearest", behavior: motion ? "smooth" : "auto" }));
    } catch (caught) {
      // Not graded: nothing is marked right or wrong, and the same answer can be sent again.
      setCheckError(caught instanceof Error ? caught.message : "The answer could not be checked.");
      dispatch({ type: "CHECK_FAILED" });
    } finally {
      setChecking(false);
    }
  }

  function proceed() {
    if (!feedback || leaving) return;
    // A wrong answer comes back at the end of the lesson for another try.
    advance(feedback.correct ? queue.slice(1) : [...queue.slice(1), queue[0]]);
  }

  async function finish() {
    setPhase("saving");
    setSaveError("");
    try {
      const result = await api<Completion>(`/api/academy/lessons/${encodeURIComponent(slug)}`, { action: "complete" });
      setCompletion(result);
      setPhase("done");
      dispatch({ type: "LESSON_COMPLETED", perfect: mistakes === 0 && total > 0, firstTime: result.firstTime });
      // The map animates the newly travelled road and Tiko once, on the way back.
      if (result.firstTime) {
        try { sessionStorage.setItem(FRESH_KEY, slug); } catch { /* storage unavailable */ }
      }
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "The lesson could not be completed.");
      setPhase("save-error");
    }
  }

  // A long pause on a question with nothing picked: Tiko gets curious and offers help (once per screen).
  const idleKey = phase === "play" && question && !feedback && !checking && !input && !transition ? `${turn}` : null;
  const nudged = useRef<string | null>(null);
  useEffect(() => {
    if (!idleKey || nudged.current === idleKey) return;
    const timer = window.setTimeout(() => { nudged.current = idleKey; dispatch({ type: "IDLE_NUDGE", hasHint: Boolean(question?.hint) }); }, 14_000);
    return () => window.clearTimeout(timer);
  }, [idleKey, nod, dispatch, question?.hint]);

  // Keyboard: number keys pick an answer, Enter checks or continues (buttons and inputs handle their own keys).
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keys.current = (event) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || tipsOpen || phase !== "play") return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "Enter") {
        if (target && (/^(BUTTON|A)$/.test(target.tagName) || target.getAttribute("role") === "slider")) return;
        event.preventDefault();
        if (step?.kind === "tip") nextTip();
        else if (feedback) proceed();
        else void check();
        return;
      }
      const number = Number(event.key);
      if (!question || locked || !Number.isInteger(number) || number < 1) return;
      const index = number - 1;
      const pickWith = (next: Draft) => { picked(); setDraft({ turn, value: next }); };
      if (question.kind === "choice" && index < question.options.length) pickWith({ choice: index });
      if (question.kind === "truefalse" && index < 2) pickWith({ bool: index === 0 });
      if (question.kind === "tapcandle" && index < question.chart.length) pickWith({ candle: index });
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error) {
    return (
      <div className="ax-shell grid place-items-center p-6 text-center">
        <div className="flex max-w-sm flex-col items-center gap-2">
          <Tiko mood="confused" size={88} />
          <p className="text-[17px] font-bold">{error.locked ? "This lesson is locked" : "The lesson could not be loaded"}</p>
          <p className="text-[14px] text-muted">{error.message}</p>
          <div className="mt-3 flex justify-center gap-2">
            <button type="button" className="ax-btn-ghost" onClick={() => router.push("/academy")}>Back to map</button>
            {error.locked ? null : <button type="button" className="ax-btn" onClick={() => { setError(null); load(); }}><RefreshCw className="h-4 w-4" aria-hidden />Retry</button>}
          </div>
        </div>
      </div>
    );
  }
  if (!lesson) {
    return (
      <div className="ax-shell grid place-items-center" aria-busy="true" aria-label="Loading the lesson">
        <Tiko mood="idle" size={80} />
      </div>
    );
  }

  const progress = total ? Math.min(100, (done / total) * 100) : 100;
  const hasTips = lesson.cards.length > 0;
  const perfect = phase === "done" && mistakes === 0 && total > 0;
  const tip = step?.kind === "tip" ? lesson.cards[step.index] : null;
  const split = wide && phase === "play" && question != null && hasVisual(question);

  return (
    <div ref={shell} className="ax-shell" data-motion={prefs.motion ? undefined : "off"}>
      {/* Academy's own compact header: leave, lesson progress, combo, XP and the sound / settings controls. */}
      <div className="relative flex items-center gap-2 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] sm:gap-3 sm:px-5">
        <button type="button" className="ax-toggle" aria-label="Leave the lesson (your answers are saved)" title="Back to map" onClick={() => router.push("/academy")}><X className="h-5 w-5" aria-hidden /></button>
        <span className="ax-progress" role="progressbar" aria-label={`${lesson.title}: lesson progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
          <span className="ax-progress-fill block" style={{ width: `${progress}%` }}>
            {bump ? <span key={bump} className="ax-progress-shine" aria-hidden /> : null}
          </span>
        </span>
        {combo >= 2 && phase === "play" ? (
          <span key={combo} className="ax-combo" data-milestone={combo === COMBO.notice || combo === COMBO.cheer || combo === COMBO.milestone ? "true" : undefined} role="status" aria-label={`${combo} correct in a row in this lesson`}>
            <Flame className="h-3.5 w-3.5" fill="currentColor" aria-hidden />{combo}<span className="max-sm:hidden">&nbsp;in a row</span>
          </span>
        ) : null}
        <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-extrabold tabular-nums text-gold" aria-label={`${xpEarned} XP earned in this lesson`}><Zap className="h-4 w-4" fill="currentColor" aria-hidden />{xpEarned}</span>
        <AcademyAudioSettings />
      </div>

      {/* The one scroll area of the lesson (between the header and the footer or tray); the cinematic
          covers it between screens, and while it plays the content cannot be pressed (inert). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" inert={transition != null}>
        <div className={`mx-auto flex ${split ? "max-w-6xl" : wide ? "max-w-3xl" : "max-w-2xl"} flex-col gap-3 px-4 pb-8 pt-1 sm:px-6`}>
          {/* Tiko stays for the whole lesson: only his pose and bubble change between screens. */}
          {phase !== "save-error" ? <TutorStage stage={stage} nod={nod} onDismiss={hintOpen ? toggleHint : undefined} size={phase === "done" ? 96 : 76} /> : null}

          <div key={`${turn}-${phase}`} className={`ax-screen flex flex-col gap-4 ${leaving ? "ax-screen-out" : ""}`}>
            {phase === "play" && tip && step?.kind === "tip" ? (
              <article className="ax-tip flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="ax-tip-label">Tip {step.index + 1} of {lesson.cards.length}</span>
                  <span className="text-[12px] font-bold text-muted">Unit {lesson.unit.number} · {lesson.title}</span>
                </div>
                <h1 ref={heading} tabIndex={-1} className="text-[19px] font-bold leading-snug outline-none">{tip.title}</h1>
                {tip.candles ? <div className="grid place-items-center"><CandleSketch candles={tip.candles} /></div> : null}
                <Body text={tip.body} />
              </article>
            ) : null}

            {phase === "play" && question ? (() => {
              const card = (
                <section className="ax-question">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="mb-1 text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted">{lesson.title}</p>
                      <h1 ref={heading} tabIndex={-1} className="text-[17px] font-bold leading-snug outline-none sm:text-[19px]">{question.prompt}</h1>
                    </div>
                    {question.hint && !feedback ? (
                      <button type="button" className="ax-hint-btn" aria-expanded={hintOpen} onClick={toggleHint}>
                        <Lightbulb className="h-4 w-4" aria-hidden />{hintOpen ? "Hide hint" : "Hint"}
                      </button>
                    ) : null}
                  </div>
                </section>
              );
              const props = { question, draft: value, onDraft: (next: Draft) => setDraft({ turn, value: next }), onPick: picked, locked, feedback, onSubmit: () => void check(), showPrompt: false, hideHint: true } as const;
              const shake = feedback && !feedback.correct ? "ax-shake" : undefined;
              // A trading mission on wide screens: a large chart on the left, the question and answers on the right.
              return split ? (
                <div className="ax-mission">
                  <div className={shake}><ExerciseView key={`v${turn}`} {...props} part="visual" chartHeight={380} /></div>
                  <div className="flex min-w-0 flex-col gap-4">
                    {card}
                    <div className={shake}><ExerciseView key={turn} {...props} part="controls" /></div>
                  </div>
                </div>
              ) : (
                <>
                  {card}
                  <div className={shake}><ExerciseView key={turn} {...props} chartHeight={wide ? 320 : 240} /></div>
                </>
              );
            })() : null}

            {phase === "saving" ? <p className="py-6 text-center text-[16px] font-bold text-muted">Saving your progress…</p> : null}
            {phase === "save-error" ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <Tiko mood="confused" size={96} />
                <p className="text-[17px] font-bold">Your lesson could not be saved</p>
                <p className="max-w-sm text-[14px] text-muted" role="alert">{saveError} Your answers are stored; try again.</p>
              </div>
            ) : null}

            {phase === "done" && completion ? (
              <div className="flex flex-col items-center gap-3">
                {perfect ? <span className="ax-perfect" role="status"><Award className="h-4 w-4" aria-hidden />Perfect lesson: no mistakes</span> : null}
                <div className="w-full overflow-hidden rounded-3xl" style={{ background: "linear-gradient(180deg,#fffaf0,#fff1d6)", color: "#0d1726", boxShadow: "0 6px 0 #d8b46a" }}>
                  <RewardCelebration
                    stars={starsFor(completion.score)}
                    xpBefore={completion.xpTotal - xpEarned - completion.xp}
                    xpAfter={completion.xpTotal}
                    xpGained={xpEarned + completion.xp}
                    badge={completion.newBadges[0]?.name ?? null}
                    firstTime={completion.firstTime}
                  >
                    <p className="text-[13px] text-[#0d1726]/70">{lesson.title} · Score {completion.score}% · Level {completion.level.level} {completion.level.title} · {completion.streak.current}-day streak</p>
                  </RewardCelebration>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <AcademyTransition run={transition} />
      </div>

      {/* Footer: the action for this screen, or the verdict tray once the server has answered. */}
      {phase === "play" && question && (feedback || checkError) ? (
        <AcademyFeedbackTray feedback={feedback} error={checkError} praise={praiseFor(question.id)} combo={combo} onContinue={proceed} onRetry={() => void check()} retrying={checking} closing={leaving} />
      ) : (
        <div className="ax-footer px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-2xl items-center gap-2">
            {phase === "play" && step?.kind === "tip" ? (
              <>
                {queue.some((item) => item.kind === "question") ? <button type="button" className="ax-btn-ghost" onClick={skipTips}>Skip tips</button> : null}
                <button type="button" className="ax-btn ml-auto min-w-40 flex-1 sm:flex-none" onClick={nextTip} autoFocus>Got it</button>
              </>
            ) : null}
            {phase === "play" && question ? (
              <>
                {hasTips ? <button type="button" className="ax-btn-ghost max-sm:px-3" onClick={openTips} aria-label="Review the lesson tips"><BookOpen className="h-5 w-5" aria-hidden /><span className="max-sm:hidden">Tips</span></button> : null}
                <button type="button" className={`ax-btn ax-check ml-auto min-w-40 flex-1 sm:flex-none ${input && !checking ? "ax-ready" : ""}`} data-tone="success" disabled={!input || checking || leaving || transition != null} onClick={() => void check()}>
                  <span className="ax-check-label" data-busy={checking ? "true" : undefined}><span className="ax-spin" aria-hidden /><span>{checking ? "Checking" : "Check"}</span></span>
                </button>
              </>
            ) : null}
            {phase === "save-error" ? (
              <>
                <button type="button" className="ax-btn-ghost" onClick={() => router.push("/academy")}>Back to map</button>
                <button type="button" className="ax-btn ml-auto flex-1 sm:flex-none" onClick={() => void finish()}><RefreshCw className="h-4 w-4" aria-hidden />Try again</button>
              </>
            ) : null}
            {phase === "done" ? (
              <>
                <button type="button" className="ax-btn-ghost" onClick={load}>Review lesson</button>
                <button type="button" className="ax-btn ml-auto flex-1 sm:flex-none sm:min-w-56" data-tone="success" onClick={() => router.push("/academy")} autoFocus>Continue journey</button>
              </>
            ) : null}
          </div>
        </div>
      )}

      {tipsSheet.shown ? <TipsSheet lesson={lesson} closing={tipsSheet.closing} onClose={closeTips} /> : null}
    </div>
  );
}

/** All of the lesson's tips, to look back at during the exercises. */
function TipsSheet({ lesson, closing, onClose }: { lesson: LessonData; closing: boolean; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <>
      <button type="button" tabIndex={-1} aria-label="Close tips" className="ax-scrim fixed inset-0 z-[90]" data-closing={closing ? "true" : undefined} style={{ background: "var(--scrim)" }} onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={`${lesson.title}: tips`} data-closing={closing ? "true" : undefined} className="ax-sheet ax-tray fixed inset-x-0 bottom-0 z-[91] mx-auto flex max-h-[80dvh] max-w-2xl flex-col rounded-t-3xl bg-panel text-text shadow-[0_-10px_40px_rgba(0,0,0,.3)]">
        <div className="flex items-center gap-2 border-b border-border-soft px-5 py-3">
          <BookOpen className="h-5 w-5 text-info" aria-hidden />
          <p className="flex-1 text-[16px] font-bold">Lesson tips</p>
          <button ref={close} type="button" className="ax-toggle" aria-label="Close" onClick={onClose}><X className="h-5 w-5" aria-hidden /></button>
        </div>
        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {lesson.cards.map((card, index) => (
            <section key={index} className="flex flex-col gap-2">
              <h2 className="text-[15px] font-bold">{card.title}</h2>
              {card.candles ? <CandleSketch candles={card.candles} /> : null}
              <Body text={card.body} />
            </section>
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}

function Body({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/);
  return (
    <div className="flex flex-col gap-2.5 text-[15px] leading-relaxed text-text-2">
      {blocks.map((block, index) => {
        const lines = block.split("\n");
        if (lines.every((line) => line.trim().startsWith("- "))) {
          return <ul key={index} className="list-disc space-y-1 pl-5">{lines.map((line) => <li key={line}>{line.trim().slice(2)}</li>)}</ul>;
        }
        return <p key={index}>{block}</p>;
      })}
    </div>
  );
}
