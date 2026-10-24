"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, BookOpen, Check, Flame, RefreshCw, Vibrate, VibrateOff, Volume2, VolumeX, X, Zap } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { CandleSketch } from "@/components/academy/candle-sketch";
import { cue, setFeedbackPrefs, useFeedbackPrefs } from "@/components/academy/feedback";
import { FRESH_KEY } from "@/components/academy/game/academy-game-map";
import { starsFor } from "@/components/academy/game/geometry";
import { RewardCelebration } from "@/components/academy/game/reward-celebration";
import { Tiko } from "@/components/academy/game/tiko";
import { ExerciseView, hasVisual, inputOf, type Draft, type Feedback } from "@/components/academy/lesson/exercise-view";
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

const PRAISE = ["Nice work!", "Exactly right!", "Spot on!", "Great reading!", "You got it!"];
const COMBO_MILESTONES = new Set([3, 5, 10, 15, 20]);

/** Same praise for the same question (no randomness during render). */
function praiseFor(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PRAISE[hash % PRAISE.length];
}

/** The lesson's screens: its tips first (the questions build on them), then one exercise per screen. */
function stepsFor(data: LessonData): { steps: Step[]; resumed: boolean } {
  const open = data.questions.filter((question) => !data.answeredCorrectly.includes(question.id));
  const review = open.length === 0;
  const resumed = !review && open.length < data.questions.length;
  const questions: Step[] = (review ? data.questions : open).map((question) => ({ kind: "question", id: question.id }));
  // A learner returning to a half-finished lesson goes straight to the exercises (tips stay one tap away).
  const tips: Step[] = resumed ? [] : data.cards.map((_, index) => ({ kind: "tip", index }));
  return { steps: [...tips, ...questions], resumed };
}

/**
 * A lesson as a sequence of focused screens: short tips with Tiko, then one exercise at a time.
 * Every answer is checked by the server (the tray shows its verdict); XP and completion come only
 * from the server's records.
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
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [combo, setCombo] = useState(0);
  const [bump, setBump] = useState(0);
  const [xpEarned, setXpEarned] = useState(0);
  const [phase, setPhase] = useState<Phase>("play");
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [saveError, setSaveError] = useState("");
  const [tipsOpen, setTipsOpen] = useState(false);

  const start = useCallback((data: LessonData) => {
    const { steps } = stepsFor(data);
    setLesson(data);
    setQueue(steps);
    setTotal(steps.length);
    setDone(0);
    setTurn((value) => value + 1);
    setFeedback(null);
    setCheckError(null);
    setCombo(0);
    setXpEarned(0);
    setPhase("play");
    setCompletion(null);
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
  const locked = checking || Boolean(feedback);

  function advance(next: Step[]) {
    setQueue(next);
    setFeedback(null);
    setCheckError(null);
    setTurn((current) => current + 1);
    if (!next.length) void finish();
  }

  function nextTip() {
    setDone((value) => value + 1);
    setBump((value) => value + 1);
    advance(queue.slice(1));
  }

  function skipTips() {
    const tips = queue.filter((item) => item.kind === "tip").length;
    setDone((value) => value + tips);
    setBump((value) => value + 1);
    advance(queue.filter((item) => item.kind !== "tip"));
  }

  async function check() {
    if (!question || !input || locked) return;
    setChecking(true);
    setCheckError(null);
    try {
      const result = await api<Feedback>(`/api/academy/lessons/${encodeURIComponent(slug)}`, { action: "answer", questionId: question.id, answer: input });
      setFeedback(result);
      setXpEarned((value) => value + result.xp);
      if (result.correct) {
        setCombo((value) => value + 1);
        setDone((value) => value + 1);
        setBump((value) => value + 1);
        cue("correct");
      } else {
        setCombo(0);
        cue("wrong");
      }
    } catch (caught) {
      // Not graded: nothing is marked right or wrong, and the same answer can be sent again.
      setCheckError(caught instanceof Error ? caught.message : "The answer could not be checked.");
    } finally {
      setChecking(false);
    }
  }

  function proceed() {
    if (!feedback) return;
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
        if (target && /^(BUTTON|A)$/.test(target.tagName)) return;
        event.preventDefault();
        if (step?.kind === "tip") nextTip();
        else if (feedback) proceed();
        else void check();
        return;
      }
      const number = Number(event.key);
      if (!question || locked || !Number.isInteger(number) || number < 1) return;
      const index = number - 1;
      if (question.kind === "choice" && index < question.options.length) { cue("select"); setDraft({ turn, value: { choice: index } }); }
      if (question.kind === "truefalse" && index < 2) { cue("select"); setDraft({ turn, value: { bool: index === 0 } }); }
      if (question.kind === "tapcandle" && index < question.chart.length) { cue("select"); setDraft({ turn, value: { candle: index } }); }
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
  const mood: TikoMood = checking ? "thinking" : feedback ? (feedback.correct ? "celebrate" : "encourage") : question && hasVisual(question) ? "point" : "thinking";
  const hasTips = lesson.cards.length > 0;

  return (
    <div className="ax-shell">
      {/* Top bar: leave, progress, combo, XP, sound and vibration. */}
      <div className="flex items-center gap-2 px-3 pb-2 pt-3 sm:gap-3 sm:px-5">
        <button type="button" className="ax-toggle" aria-label="Leave the lesson (your answers are saved)" title="Back to map" onClick={() => router.push("/academy")}><X className="h-5 w-5" aria-hidden /></button>
        <span className="ax-progress" role="progressbar" aria-label="Lesson progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
          <span key={bump} className="ax-progress-fill block" data-bump={bump > 0 ? "true" : undefined} style={{ width: `${progress}%` }} />
        </span>
        {combo >= 2 && phase === "play" ? (
          <span key={combo} className="ax-combo" data-milestone={COMBO_MILESTONES.has(combo) ? "true" : undefined} role="status" aria-label={`${combo} correct in a row in this lesson`}>
            <Flame className="h-3.5 w-3.5" fill="currentColor" aria-hidden />{combo} in a row
          </span>
        ) : null}
        <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-extrabold tabular-nums text-gold" aria-label={`${xpEarned} XP earned in this lesson`}><Zap className="h-4 w-4" fill="currentColor" aria-hidden />{xpEarned}</span>
        <button type="button" className="ax-toggle" aria-pressed={prefs.sound} aria-label="Sound effects" title={prefs.sound ? "Sound on" : "Sound off"} onClick={() => setFeedbackPrefs({ sound: !prefs.sound })}>{prefs.sound ? <Volume2 className="h-5 w-5" aria-hidden /> : <VolumeX className="h-5 w-5" aria-hidden />}</button>
        {/* Vibration only matters on phones. */}
        <button type="button" className="ax-toggle sm:hidden" aria-pressed={prefs.haptics} aria-label="Vibration" title={prefs.haptics ? "Vibration on" : "Vibration off"} onClick={() => setFeedbackPrefs({ haptics: !prefs.haptics })}>{prefs.haptics ? <Vibrate className="h-5 w-5" aria-hidden /> : <VibrateOff className="h-5 w-5" aria-hidden />}</button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div key={`${turn}-${phase}`} className="ax-screen mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-6 pt-2 sm:px-6">
          {phase === "play" && step?.kind === "tip" ? <TipScreen lesson={lesson} index={step.index} /> : null}

          {phase === "play" && question ? (
            <>
              <p className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted">{lesson.title}</p>
              {/* Tiko asks the question; his mood follows the answer. */}
              <div className="flex items-start gap-2 sm:gap-3">
                <Tiko mood={mood} size={64} className="max-sm:!w-[52px] max-sm:!h-[60px]" />
                <div className="ax-bubble"><h1 className="text-[17px] font-bold leading-snug sm:text-[19px]">{question.prompt}</h1></div>
              </div>
              <div className={feedback && !feedback.correct ? "ax-shake" : undefined}>
                <ExerciseView key={turn} question={question} draft={value} onDraft={(next) => setDraft({ turn, value: next })} locked={locked} feedback={feedback} onSubmit={() => void check()} showPrompt={false} />
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
              <Tiko mood="mission-complete" size={110} />
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

      {/* Footer: the action for this screen, or the feedback tray once the server has answered. */}
      {phase === "play" && question && (feedback || checkError) ? (
        <Tray feedback={feedback} error={checkError} praise={praiseFor(question.id)} onContinue={proceed} onRetry={() => void check()} retrying={checking} />
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
                <button type="button" className="ax-btn ml-auto min-w-40 flex-1 sm:flex-none" data-tone="success" disabled={!input || checking} onClick={() => void check()}>
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

/** One tip: Tiko introduces it, the card carries the full text (nothing from the lesson is dropped). */
function TipScreen({ lesson, index }: { lesson: LessonData; index: number }) {
  const card = lesson.cards[index];
  return (
    <>
      <p className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-muted">Unit {lesson.unit.number} · {lesson.unit.title}</p>
      <div className="flex items-center gap-2 sm:gap-3">
        <Tiko mood="explain" size={64} className="max-sm:!w-[52px] max-sm:!h-[60px]" />
        <div className="ax-bubble">
          <p className="text-[13px] font-bold text-muted">{index === 0 ? lesson.title : `Tip ${index + 1} of ${lesson.cards.length}`}</p>
          <h1 className="text-[18px] font-bold leading-snug">{card.title}</h1>
        </div>
      </div>
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
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
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

/** The verdict tray: slides up after the server's answer; colour, icon and words all carry the result. */
function Tray({ feedback, error, praise, onContinue, onRetry, retrying }: { feedback: Feedback | null; error: string | null; praise: string; onContinue: () => void; onRetry: () => void; retrying: boolean }) {
  const tone = feedback ? (feedback.correct ? "correct" : "wrong") : "error";
  const colour = tone === "correct" ? "var(--profit)" : tone === "wrong" ? "var(--loss)" : "var(--warning)";
  return (
    <div className="ax-footer ax-tray px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4" data-tone={tone} role="status" aria-live="assertive">
      <div className="mx-auto flex max-w-2xl flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 gap-3">
          <span className="ax-tray-icon" style={{ color: colour }} aria-hidden>
            {tone === "correct" ? <Check className="h-7 w-7" strokeWidth={3.5} /> : tone === "wrong" ? <X className="h-7 w-7" strokeWidth={3.5} /> : <AlertTriangle className="h-6 w-6" strokeWidth={2.5} />}
          </span>
          <div className="ax-tray-body min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-[19px] font-black" style={{ color: colour }}>
              {tone === "correct" ? praise : tone === "wrong" ? "Not quite" : "We couldn't check that answer"}
              {feedback?.correct && feedback.xp ? <span className="inline-flex items-center gap-0.5 rounded-full bg-panel px-2 py-0.5 text-[13px] font-extrabold text-gold"><Zap className="h-3.5 w-3.5" fill="currentColor" aria-hidden />+{feedback.xp} XP</span> : null}
            </p>
            {feedback && !feedback.correct && feedback.answer ? <p className="mt-1 text-[15px] font-bold text-text"><span style={{ color: colour }}>Correct answer:</span> {feedback.answer}</p> : null}
            {feedback ? <p className="mt-1 text-[14px] leading-snug text-text-2">{feedback.explanation}</p> : <p className="mt-1 text-[14px] text-text-2">{error} Nothing was marked; your answer is still selected.</p>}
            {feedback?.mistake ? <p className="mt-1 text-[13px] text-muted"><span className="font-bold">Common mistake:</span> {feedback.mistake}</p> : null}
            {feedback && !feedback.correct ? <p className="mt-1 text-[12px] font-semibold text-muted">This one comes back at the end for another try.</p> : null}
          </div>
        </div>
        {feedback
          ? <button type="button" className="ax-btn w-full sm:w-auto sm:min-w-44" data-tone={feedback.correct ? "success" : "danger"} onClick={onContinue} autoFocus>Continue</button>
          : <button type="button" className="ax-btn w-full sm:w-auto sm:min-w-44" disabled={retrying} onClick={onRetry} autoFocus>{retrying ? <><span className="ax-spin" aria-hidden />Checking</> : <><RefreshCw className="h-4 w-4" aria-hidden />Try again</>}</button>}
      </div>
    </div>
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
