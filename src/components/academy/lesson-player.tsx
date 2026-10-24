"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Award, BookOpen, Flame, RefreshCw, Vibrate, VibrateOff, Volume2, VolumeX, X, Zap } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { CandleSketch } from "@/components/academy/candle-sketch";
import { cue, setFeedbackPrefs, useFeedbackPrefs } from "@/components/academy/academy-sound";
import { FRESH_KEY } from "@/components/academy/game/academy-game-map";
import { starsFor } from "@/components/academy/game/geometry";
import { RewardCelebration } from "@/components/academy/game/reward-celebration";
import { Tiko } from "@/components/academy/game/tiko";
import { ExerciseView, hasVisual, inputOf, type Draft, type Feedback } from "@/components/academy/lesson/exercise-view";
import { AcademyFeedbackTray } from "@/components/academy/lesson/feedback-tray";
import type { TikoMood } from "@/lib/academy/missions";
import type { LessonCard, PublicQuestion } from "@/lib/academy/types";

export type { Feedback } from "@/components/academy/lesson/exercise-view";

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
};
type Completion = { score: number; firstTime: boolean; xp: number; xpTotal: number; newBadges: Array<{ name: string; description: string }>; streak: { current: number; todayDone: boolean }; level: { level: number; title: string } };
type Step = { kind: "tip"; index: number } | { kind: "question"; id: string };
type Phase = "play" | "saving" | "done" | "save-error";
type Reaction = { key: number; text: string; tone: "good" | "soft" | "info" };

/** Correct-in-a-row thresholds for this lesson (not the daily streak): a note, a cheer, a big moment. */
export const COMBO = { notice: 3, cheer: 5, milestone: 10 } as const;

const PRAISE = ["Nice work!", "Exactly right!", "Spot on!", "Great reading!", "You got it!"];
const TIKO_RIGHT = ["Nice!", "Yes, that's it!", "Sharp eye!", "Great thinking!", "Nailed it!"];
const TIKO_WRONG = ["Let's see why.", "Close. Look again.", "Good try. Here's the idea.", "Mistakes help it stick."];
const TIKO_START = ["Your turn!", "Let's try one.", "Take your time.", "What do you think?"];

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
 * A lesson as a sequence of focused screens: short tips with Tiko, then one exercise at a time, with
 * Tiko reacting to every state. Every answer is checked by the server (the tray shows its verdict);
 * XP and completion come only from the server's records.
 */
export function LessonPlayer({ slug }: { slug: string }) {
  const router = useRouter();
  const prefs = useFeedbackPrefs();
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
  const [combo, setCombo] = useState(0);
  const [mistakes, setMistakes] = useState(0);
  const [bump, setBump] = useState(0);
  const [xpEarned, setXpEarned] = useState(0);
  const [phase, setPhase] = useState<Phase>("play");
  const [leaving, setLeaving] = useState(false);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [saveError, setSaveError] = useState("");
  const [tipsOpen, setTipsOpen] = useState(false);
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [milestone, setMilestone] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const later = (ms: number, run: () => void) => { timers.current.push(window.setTimeout(run, ms)); };

  /** Tiko says something short above his head (from a real event), then it fades. */
  const say = useCallback((text: string, tone: Reaction["tone"]) => {
    setReaction((current) => ({ key: (current?.key ?? 0) + 1, text, tone }));
  }, []);

  const start = useCallback((data: LessonData) => {
    const steps = stepsFor(data);
    setLesson(data);
    setQueue(steps);
    setTotal(steps.length);
    setDone(0);
    setTurn((value) => value + 1);
    setFeedback(null);
    setCheckError(null);
    setCombo(0);
    setMistakes(0);
    setXpEarned(0);
    setPhase("play");
    setCompletion(null);
    setReaction(null);
    setBump(0);
  }, []);

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
  const locked = checking || Boolean(feedback) || leaving;

  /** The next screen: the current one slides out, the next slides in at the top of the page. */
  function advance(next: Step[], said?: string) {
    const go = () => {
      setLeaving(false);
      setQueue(next);
      setFeedback(null);
      setCheckError(null);
      setTurn((current) => current + 1);
      scroller.current?.scrollTo({ top: 0 });
      if (!next.length) { void finish(); return; }
      if (said) say(said, "info");
      else setReaction(null);
    };
    if (reducedMotion()) { go(); return; }
    setLeaving(true);
    later(170, go);
  }

  function nextTip() {
    if (leaving) return;
    setDone((value) => value + 1);
    setBump((value) => value + 1);
    const next = queue.slice(1);
    advance(next, next[0]?.kind === "question" ? TIKO_START[turn % TIKO_START.length] : undefined);
  }

  function skipTips() {
    if (leaving) return;
    const tips = queue.filter((item) => item.kind === "tip").length;
    setDone((value) => value + tips);
    setBump((value) => value + 1);
    advance(queue.filter((item) => item.kind !== "tip"), TIKO_START[0]);
  }

  function changeDraft(next: Draft) {
    setDraft({ turn, value: next });
    setNod((value) => value + 1);
  }

  async function check() {
    if (!question || !input || locked) return;
    cue("check");
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
        if (streak === COMBO.milestone || streak === COMBO.cheer || streak === COMBO.notice) {
          cue(streak >= COMBO.cheer ? "combo" : "correct");
          setMilestone((value) => (streak === COMBO.milestone ? value + 1 : value));
          say(streak === COMBO.milestone ? `${streak} in a row! Incredible!` : streak === COMBO.cheer ? `${streak} in a row! On fire!` : `${streak} in a row!`, "good");
        } else {
          cue("correct");
          say(TIKO_RIGHT[(turn + streak) % TIKO_RIGHT.length], "good");
        }
      } else {
        setCombo(0);
        setMistakes((value) => value + 1);
        cue("wrong");
        say(question.hint ? "Here's a hint." : TIKO_WRONG[turn % TIKO_WRONG.length], "soft");
      }
      // Bring the verdict on the exercise itself into view above the tray.
      requestAnimationFrame(() => scroller.current?.querySelector("[data-result], .ax-line-handle")?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" }));
    } catch (caught) {
      // Not graded: nothing is marked right or wrong, and the same answer can be sent again.
      setCheckError(caught instanceof Error ? caught.message : "The answer could not be checked.");
      say("Hmm, I couldn't reach the server.", "info");
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
      cue("complete");
      // The map animates the newly travelled road and Tiko once, on the way back.
      if (result.firstTime) {
        try { sessionStorage.setItem(FRESH_KEY, slug); } catch { /* storage unavailable */ }
      }
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "The lesson could not be completed.");
      setPhase("save-error");
    }
  }

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
      if (question.kind === "choice" && index < question.options.length) { cue("select"); changeDraft({ choice: index }); }
      if (question.kind === "truefalse" && index < 2) { cue("select"); changeDraft({ bool: index === 0 }); }
      if (question.kind === "tapcandle" && index < question.chart.length) { cue("select"); changeDraft({ candle: index }); }
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
  // Tiko follows the exercise's real state: choosing, checking, the verdict, a combo.
  const mood: TikoMood = checkError ? "surprised"
    : checking ? "thinking"
      : feedback ? (feedback.correct ? (combo >= COMBO.cheer && (combo === COMBO.cheer || combo === COMBO.milestone) ? "streak" : "celebrate") : question?.hint ? "hint" : "encourage")
        : input ? "listening"
          : question && hasVisual(question) ? "point" : "thinking";
  const hasTips = lesson.cards.length > 0;
  const perfect = phase === "done" && mistakes === 0 && total > 0;

  return (
    <div className="ax-shell">
      {/* Academy's own compact header: leave, lesson, progress, combo, XP, sound and vibration. */}
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
        {milestone ? <span key={milestone} className="ax-burst" aria-hidden>{Array.from({ length: 12 }, (_, index) => <i key={index} style={{ ["--a" as string]: `${index * 30}deg` }} />)}</span> : null}
        <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-extrabold tabular-nums text-gold" aria-label={`${xpEarned} XP earned in this lesson`}><Zap className="h-4 w-4" fill="currentColor" aria-hidden />{xpEarned}</span>
        <button type="button" className="ax-toggle" aria-pressed={prefs.sound} aria-label="Sound effects" title={prefs.sound ? "Sound on" : "Sound off"} onClick={() => setFeedbackPrefs({ sound: !prefs.sound })}>
          <span key={String(prefs.sound)} className="ax-pop inline-flex">{prefs.sound ? <Volume2 className="h-5 w-5" aria-hidden /> : <VolumeX className="h-5 w-5" aria-hidden />}</span>
        </button>
        {/* Vibration only matters on phones. */}
        <button type="button" className="ax-toggle sm:hidden" aria-pressed={prefs.haptics} aria-label="Vibration" title={prefs.haptics ? "Vibration on" : "Vibration off"} onClick={() => setFeedbackPrefs({ haptics: !prefs.haptics })}>
          <span key={String(prefs.haptics)} className="ax-pop inline-flex">{prefs.haptics ? <Vibrate className="h-5 w-5" aria-hidden /> : <VibrateOff className="h-5 w-5" aria-hidden />}</span>
        </button>
      </div>

      {/* The one scroll area of the lesson: everything between the header and the footer or tray. */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div key={`${turn}-${phase}`} className={`ax-screen mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-8 pt-2 sm:px-6 ${leaving ? "ax-screen-out" : ""}`}>
          {phase === "play" && step?.kind === "tip" ? <TipScreen lesson={lesson} index={step.index} reaction={reaction} /> : null}

          {phase === "play" && question ? (
            <>
              <Tutor mood={mood} nod={nod} reaction={reaction}>
                <p className="mb-0.5 text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted">{lesson.title}</p>
                <h1 className="text-[17px] font-bold leading-snug sm:text-[19px]">{question.prompt}</h1>
              </Tutor>
              <div className={feedback && !feedback.correct ? "ax-shake" : undefined}>
                <ExerciseView key={turn} question={question} draft={value} onDraft={changeDraft} locked={locked} feedback={feedback} onSubmit={() => void check()} showPrompt={false} />
              </div>
            </>
          ) : null}

          {phase === "saving" || phase === "save-error" ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Tiko mood={phase === "saving" ? "thinking" : "confused"} size={96} />
              <p className="text-[17px] font-bold">{phase === "saving" ? "Saving your progress…" : "Your lesson could not be saved"}</p>
              {phase === "save-error" ? <p className="max-w-sm text-[14px] text-muted" role="alert">{saveError} Your answers are stored; try again.</p> : null}
            </div>
          ) : null}

          {phase === "done" && completion ? (
            <div className="flex flex-col items-center gap-3">
              <span className="ax-tutor-in"><Tiko mood={perfect ? "streak" : "mission-complete"} size={110} /></span>
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

      {/* Footer: the action for this screen, or the verdict tray once the server has answered. */}
      {phase === "play" && question && (feedback || checkError) ? (
        <AcademyFeedbackTray feedback={feedback} error={checkError} praise={praiseFor(question.id)} combo={combo} hint={question.hint ?? null} onContinue={proceed} onRetry={() => void check()} retrying={checking} />
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
                {hasTips ? <button type="button" className="ax-btn-ghost max-sm:px-3" onClick={() => setTipsOpen(true)} aria-label="Review the lesson tips"><BookOpen className="h-5 w-5" aria-hidden /><span className="max-sm:hidden">Tips</span></button> : null}
                <button key={input ? "ready" : "idle"} type="button" className={`ax-btn ml-auto min-w-40 flex-1 sm:flex-none ${input && !checking ? "ax-ready" : ""}`} data-tone="success" disabled={!input || checking || leaving} onClick={() => void check()}>
                  {checking ? <><span className="ax-spin" aria-hidden />Checking</> : "Check"}
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

      {tipsOpen ? <TipsSheet lesson={lesson} onClose={() => setTipsOpen(false)} /> : null}
    </div>
  );
}

/**
 * The tutor area: Tiko beside the prompt bubble. A pick makes him nod; his short reactions (from real
 * events only) pop above his head. Compact on phones so the exercise keeps the room.
 */
function Tutor({ mood, nod, reaction, children }: { mood: TikoMood; nod: number; reaction: Reaction | null; children: React.ReactNode }) {
  return (
    <div className="mt-7 flex items-start gap-2 sm:gap-3">
      <div className="ax-tutor-in relative shrink-0">
        {reaction ? <span key={reaction.key} className="ax-react" data-tone={reaction.tone} role="status">{reaction.text}</span> : null}
        <span key={nod} className={nod ? "ax-nod inline-flex" : "inline-flex"}>
          <Tiko mood={mood} size={64} className="max-sm:!h-[60px] max-sm:!w-[52px]" />
        </span>
      </div>
      <div className="ax-bubble">{children}</div>
    </div>
  );
}

/** One tip: Tiko introduces it, the card carries the full text (nothing from the lesson is dropped). */
function TipScreen({ lesson, index, reaction }: { lesson: LessonData; index: number; reaction: Reaction | null }) {
  const card = lesson.cards[index];
  return (
    <>
      <Tutor mood={index === 0 ? "enter" : "explain"} nod={0} reaction={reaction}>
        <p className="mb-0.5 text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted">Unit {lesson.unit.number} · {index === 0 ? lesson.title : `Tip ${index + 1} of ${lesson.cards.length}`}</p>
        <h1 className="text-[18px] font-bold leading-snug">{card.title}</h1>
      </Tutor>
      <article className="ax-tip flex flex-col gap-3">
        <span className="ax-tip-label self-start">Tip {index + 1} of {lesson.cards.length}</span>
        {card.candles ? <div className="grid place-items-center"><CandleSketch candles={card.candles} /></div> : null}
        <Body text={card.body} />
      </article>
    </>
  );
}

/** All of the lesson's tips, to look back at during the exercises. */
function TipsSheet({ lesson, onClose }: { lesson: LessonData; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <>
      <button type="button" tabIndex={-1} aria-label="Close tips" className="fixed inset-0 z-[90]" style={{ background: "var(--scrim)" }} onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={`${lesson.title}: tips`} className="ax-tray fixed inset-x-0 bottom-0 z-[91] mx-auto flex max-h-[80dvh] max-w-2xl flex-col rounded-t-3xl bg-panel text-text shadow-[0_-10px_40px_rgba(0,0,0,.3)]">
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
