"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, RefreshCw } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { useDesk } from "@/components/shell";
import { cue } from "@/components/academy/feedback";
import { ExerciseView, inputOf, type Draft, type Feedback } from "@/components/academy/lesson/exercise-view";
import type { DecisionChoice, Line, Mission, Scene, TikoMood } from "@/lib/academy/missions";
import type { AnswerInput, PublicQuestion } from "@/lib/academy/types";
import { styles } from "./academy-game-classes";
import { FRESH_KEY } from "./academy-game-map";
import { EduChart } from "./edu-chart";
import { starsFor } from "./geometry";
import { RewardCelebration } from "./reward-celebration";
import { Tiko } from "./tiko";
import { TutorDialogue } from "./tutor-dialogue";

type LessonData = { questions: PublicQuestion[]; answeredCorrectly: string[]; passPercent: number };
type Completion = { score: number; firstTime: boolean; xp: number; xpTotal: number; newBadges: Array<{ name: string }>; level: { level: number; title: string } };

/**
 * A story mission (Tiko's scenes) on top of a real lesson: every question is graded by the server
 * and completion goes through the same once-only XP path as any lesson.
 */
export function MissionPlayer({ mission }: { mission: Mission }) {
  const router = useRouter();
  const [lesson, setLesson] = useState<LessonData | null>(null);
  const [error, setError] = useState<{ message: string; locked: boolean } | null>(null);
  const [scene, setScene] = useState(0);
  const [xpEarned, setXpEarned] = useState(0);
  const [completion, setCompletion] = useState<Completion | null>(null);

  const load = useCallback(() => {
    api<LessonData>(`/api/academy/lessons/${mission.slug}`)
      .then((data) => { setError(null); setLesson(data); })
      .catch((caught: unknown) => setError({ message: caught instanceof Error ? caught.message : "The mission could not be loaded.", locked: caught instanceof ApiError && caught.status === 403 }));
  }, [mission.slug]);
  useEffect(() => { load(); }, [load]);

  const questions = useMemo(() => new Map((lesson?.questions ?? []).map((question) => [question.id, question])), [lesson]);
  const current = mission.scenes[scene];

  if (error) {
    return (
      <div className={`${styles.world} grid h-full place-items-center p-6 text-center`}>
        <div className="max-w-sm">
          <Tiko mood="confused" size={90} />
          <p className="mt-2 text-[16px] font-bold">{error.locked ? "This mission is locked" : "The mission could not be loaded"}</p>
          <p className="mt-1 text-[14px] text-white/75">{error.message}</p>
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" className="h-11 rounded-full bg-white/15 px-5 font-bold hover:bg-white/25" onClick={() => router.push("/academy")}>Back to map</button>
            {error.locked ? null : <button type="button" className="inline-flex h-11 items-center gap-2 rounded-full bg-white/15 px-5 font-bold hover:bg-white/25" onClick={() => { setError(null); load(); }}><RefreshCw className="h-4 w-4" aria-hidden />Retry</button>}
          </div>
        </div>
      </div>
    );
  }
  if (!lesson) return <div className={`${styles.world} h-full`} aria-busy="true" aria-label="Loading the mission" />;

  /** The server's verdict, or null when it could not be reached (nothing is marked then). */
  async function answer(questionId: string, input: AnswerInput): Promise<Feedback | null> {
    try {
      const result = await api<Feedback>(`/api/academy/lessons/${mission.slug}`, { action: "answer", questionId, answer: input });
      setXpEarned((value) => value + result.xp);
      return result;
    } catch {
      return null;
    }
  }

  async function complete() {
    const result = await api<Completion>(`/api/academy/lessons/${mission.slug}`, { action: "complete" });
    if (result.firstTime) {
      try { sessionStorage.setItem(FRESH_KEY, mission.slug); } catch { /* storage unavailable */ }
    }
    setCompletion(result);
  }

  return (
    <div className={`${styles.world} ${styles.lessonIn} h-full overflow-y-auto`}>
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-[#0b1f3a] to-transparent px-3 py-2.5 sm:px-5">
        <button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/20 bg-white/10 hover:bg-white/20" aria-label="Back to map" onClick={() => router.push("/academy")}><ArrowLeft className="h-5 w-5" aria-hidden /></button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#ffc83d]">{mission.chapter} · Mission 1</p>
          <p className="truncate text-[16px] font-black">{mission.title}</p>
        </div>
        <ol className="flex gap-1.5" aria-label="Mission progress">
          {mission.scenes.map((item, index) => (
            <li key={item.id} className={`h-2.5 rounded-full transition-all ${index < scene ? "w-2.5 bg-[#3fe08d]" : index === scene ? "w-6 bg-[#ffc83d]" : "w-2.5 bg-white/25"}`} aria-label={`${item.title}${index < scene ? ", done" : index === scene ? ", current" : ""}`} />
          ))}
        </ol>
      </div>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-3 pb-10 pt-2 sm:px-5">
        <h1 className="text-[22px] font-black">{current.title}</h1>
        <SceneView
          key={`${current.id}-${completion ? "done" : ""}`}
          mission={mission}
          scene={current}
          questions={questions}
          answer={answer}
          onNext={() => setScene((value) => Math.min(value + 1, mission.scenes.length - 1))}
          completion={completion}
          complete={complete}
          xpEarned={xpEarned}
          onReview={() => { setCompletion(null); setScene(0); }}
          onMap={() => router.push("/academy")}
        />
      </div>
    </div>
  );
}

function SceneView({ mission, scene, questions, answer, onNext, completion, complete, xpEarned, onReview, onMap }: {
  mission: Mission;
  scene: Scene;
  questions: Map<string, PublicQuestion>;
  answer: (questionId: string, input: AnswerInput) => Promise<Feedback | null>;
  onNext: () => void;
  completion: Completion | null;
  complete: () => Promise<void>;
  xpEarned: number;
  onReview: () => void;
  onMap: () => void;
}) {
  const desk = useDesk();
  // Steps inside a scene: Tiko's lines, then the scene's question(s) or decision.
  const [step, setStep] = useState<"talk" | "plan" | "decide" | "reveal" | "risk" | "ask" | "finishing">("talk");
  const [highlight, setHighlight] = useState<Line["highlight"]>();
  const [choice, setChoice] = useState<DecisionChoice | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [failed, setFailed] = useState("");
  const onLine = useCallback((line: Line) => setHighlight(line.highlight), []);

  // Reveals "what happened next" one candle at a time after a decision.
  useEffect(() => {
    if (scene.kind !== "decision" || step !== "reveal") return;
    const total = scene.after.length;
    const timer = window.setInterval(() => setRevealed((value) => (value >= total ? value : value + 1)), 450);
    return () => window.clearInterval(timer);
  }, [scene, step]);

  if (scene.kind === "review") {
    if (!completion) {
      return (
        <div className="flex flex-col gap-4">
          <TutorDialogue lines={[{ mood: "thinking", text: "Let's lock in what you learned and save your progress." }]} doneLabel={step === "finishing" ? "Saving…" : "Complete mission"} onDone={() => {
            if (step === "finishing") return;
            setStep("finishing");
            setFailed("");
            complete().catch((caught: unknown) => { setStep("talk"); setFailed(caught instanceof Error ? caught.message : "The mission could not be completed."); });
          }} />
          {failed ? <p className="rounded-2xl bg-[#ff6b7a]/20 p-3 text-[14px] font-semibold" role="alert">{failed}</p> : null}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <div className="flex justify-center"><Tiko mood="mission-complete" size={120} /></div>
        <div className="overflow-hidden rounded-3xl" style={{ background: "linear-gradient(180deg,#fffaf0,#fff1d6)", color: "#0d1726" }}>
          <RewardCelebration stars={starsFor(completion.score)} xpBefore={completion.xpTotal - xpEarned - completion.xp} xpAfter={completion.xpTotal} xpGained={xpEarned + completion.xp} badge={completion.newBadges[0]?.name ?? null} firstTime={completion.firstTime}>
            <div className="w-full max-w-md text-left">
              <p className="text-[12px] font-extrabold uppercase tracking-[0.14em] text-[#0d1726]/55">You practised</p>
              <ul className="mt-1.5 space-y-1">{mission.skills.map((skill) => <li key={skill} className="flex gap-2 text-[14px]"><Check className="mt-0.5 h-4 w-4 shrink-0 text-[#1fae63]" aria-hidden />{skill}</li>)}</ul>
              {completion.score < 100 ? <p className="mt-2 text-[13px] text-[#0d1726]/65">Score {completion.score}%: replay the mission to practise the questions you missed.</p> : null}
            </div>
          </RewardCelebration>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button type="button" className={`${styles.play} sm:flex-[2]`} onClick={onMap}>CONTINUE JOURNEY</button>
          <button type="button" className="h-[54px] rounded-2xl border border-white/25 bg-white/10 font-extrabold tracking-wide hover:bg-white/20 sm:flex-1" onClick={onReview}>REVIEW LESSON</button>
        </div>
      </div>
    );
  }

  const decision = scene.kind === "decision" ? scene : null;
  const visual = scene.kind === "ticker" ? <TickerBoard indices={desk.indices} note={desk.indexNote} />
    : scene.kind === "candle" ? <EduChart candles={[...scene.context, scene.candle]} highlight={step === "talk" ? highlight : undefined} height={230} />
      : decision ? <EduChart candles={step === "reveal" || step === "risk" ? [...decision.history, ...decision.after.slice(0, step === "risk" ? decision.after.length : revealed)] : decision.history} height={240} label={step === "reveal" || step === "risk" ? "Educational example · made-up prices · what happened next in this example" : "Educational example · made-up prices"} />
        : null;

  return (
    <div className="flex flex-col gap-4">
      {visual}
      {step === "talk" ? (
        <TutorDialogue lines={scene.lines} onLine={onLine} onDone={() => setStep(decision ? "plan" : "ask")} doneLabel="Let's go" />
      ) : null}
      {step === "ask" && (scene.kind === "ticker" || scene.kind === "candle") ? (
        <GradedQuestion question={questions.get(scene.questionId)} mission={mission} answer={answer} onCorrect={onNext} />
      ) : null}
      {decision && step === "plan" ? (
        <GradedQuestion question={questions.get(decision.planQuestionId)} mission={mission} answer={answer} onCorrect={() => setStep("decide")} />
      ) : null}
      {decision && step === "decide" ? (
        <div className="flex flex-col gap-3">
          <TutorDialogue lines={[{ mood: "point", text: "Good plan. Now, in this example, what would you do?" }]} />
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Your decision">
            {decision.choices.map((item) => (
              <button key={item.id} type="button" className={`h-14 rounded-2xl text-[16px] font-black shadow-[0_5px_0_rgba(0,0,0,.25)] active:translate-y-1 active:shadow-none ${item.id === "buy" ? "bg-[#1fae63]" : item.id === "sell" ? "bg-[#e5484d]" : "bg-[#3b5b8c]"}`} style={{ color: "#fff" }} onClick={() => { setChoice(item); setRevealed(0); setStep("reveal"); }}>{item.label}</button>
            ))}
          </div>
          <p className="text-[12px] text-white/65">There is no single right trade here. This is a practice decision on made-up prices; nothing is bought or sold.</p>
        </div>
      ) : null}
      {decision && step === "reveal" && choice ? (
        <TutorDialogue
          key={choice.id}
          lines={[
            { mood: choice.mood as TikoMood, text: choice.feedback },
            { mood: "explain", text: "In this example the price was pushed back from the ceiling. Another time it might have broken through: patterns raise or lower the odds, they never guarantee the next move." },
          ]}
          onDone={() => setStep("risk")}
          doneLabel="One more check"
        />
      ) : null}
      {decision && step === "risk" ? (
        <GradedQuestion question={questions.get(decision.riskQuestionId)} mission={mission} answer={answer} onCorrect={onNext} />
      ) : null}
    </div>
  );
}

/** A server-graded question with Tiko reacting; a wrong answer can be retried. */
function GradedQuestion({ question, mission, answer, onCorrect }: { question: PublicQuestion | undefined; mission: Mission; answer: (questionId: string, input: AnswerInput) => Promise<Feedback | null>; onCorrect: () => void }) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<{ attempt: number; value: Draft }>({ attempt: 0, value: {} });
  if (!question) return <p className="text-[14px] text-white/75">This question is not available.</p>;
  const value = draft.attempt === attempt ? draft.value : {};
  const input = inputOf(question, value);
  const mood: TikoMood = busy ? "thinking" : !feedback ? "thinking" : feedback.correct ? "celebrate" : "encourage";
  async function check() {
    if (!question || !input || busy || feedback) return;
    setBusy(true);
    setFailed(false);
    const result = await answer(question.id, input);
    setBusy(false);
    if (!result) { setFailed(true); return; }
    setFeedback(result);
    cue(result.correct ? "correct" : "wrong");
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Tiko mood={mood} size={64} />
        <p className="text-[14px] font-semibold text-white/85" aria-live="polite">{busy ? "Checking…" : !feedback ? "Take your time." : feedback.correct ? mission.correct.text : mission.wrong.text}</p>
      </div>
      <div className={`rounded-3xl bg-panel p-4 text-text shadow-[0_6px_0_rgba(0,0,0,.25)] ${feedback && !feedback.correct ? "ax-shake" : ""}`}>
        <ExerciseView key={attempt} question={question} draft={value} onDraft={(next) => setDraft({ attempt, value: next })} locked={busy || Boolean(feedback)} feedback={feedback} onSubmit={() => void check()} />
        {feedback ? (
          <div className="ax-tray mt-4 rounded-2xl p-3" data-tone={feedback.correct ? "correct" : "wrong"} role="status">
            <p className="flex items-center gap-2 text-[16px] font-black" style={{ color: feedback.correct ? "var(--profit)" : "var(--loss)" }}>
              {feedback.correct ? <Check className="h-5 w-5" strokeWidth={3} aria-hidden /> : null}
              {feedback.correct ? `Correct${feedback.xp ? ` · +${feedback.xp} XP` : ""}` : "Not quite"}
            </p>
            {!feedback.correct && feedback.answer ? <p className="mt-1 text-[14px] font-bold">Correct answer: {feedback.answer}</p> : null}
            <p className="mt-1 text-[14px] text-text-2">{feedback.explanation}</p>
          </div>
        ) : null}
        {failed ? <p className="mt-3 text-[14px] font-semibold" style={{ color: "var(--loss)" }} role="alert">The answer could not be checked. Nothing was marked; try again.</p> : null}
      </div>
      {!feedback ? (
        <button type="button" className="ax-btn" data-tone="success" disabled={!input || busy} onClick={() => void check()}>{busy ? <><span className="ax-spin" aria-hidden />Checking</> : "Check"}</button>
      ) : feedback.correct
        ? <button type="button" className={styles.play} onClick={onCorrect} autoFocus>CONTINUE</button>
        : <button type="button" className="h-[54px] rounded-2xl border border-white/25 bg-white/10 font-extrabold tracking-wide hover:bg-white/20" onClick={() => { setFeedback(null); setAttempt((value) => value + 1); }} autoFocus>TRY AGAIN</button>}
    </div>
  );
}

/** Index prices from TradeD's market feed (the same source as the header); a clear note when unavailable. */
function TickerBoard({ indices, note }: { indices: Array<{ name: string; last: number; previous: number | null }>; note: string }) {
  if (!indices.length) {
    return <div className="rounded-2xl border border-white/15 bg-[#0b1f3a]/70 p-4 text-[14px] text-white/75">Index prices are not available right now{note ? ` (${note})` : ""}. Prices still move whenever buyers and sellers trade.</div>;
  }
  const items = indices.map((item) => {
    const pct = item.previous ? ((item.last - item.previous) / item.previous) * 100 : null;
    return (
      <span key={item.name} className="inline-flex items-baseline gap-2">
        <span className="text-[12px] font-extrabold tracking-wide text-white/70">{item.name.toUpperCase()}</span>
        <span className="text-[16px] font-black tabular-nums">{item.last.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        {pct != null ? <span className={`text-[13px] font-bold tabular-nums ${pct >= 0 ? "text-[#3fe08d]" : "text-[#ff6b7a]"}`}>{pct >= 0 ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%</span> : null}
      </span>
    );
  });
  return (
    <div className="overflow-hidden rounded-2xl border border-white/15 bg-[#071526] px-4 py-3">
      <p className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#38e1ff]">Market board · TradeD market feed</p>
      <div className="mq-ticker-board" aria-label="Index prices"><div className="mq-ticker-track">{items}{items.map((item) => <span key={`${item.key}-dup`} aria-hidden>{item}</span>)}</div></div>
    </div>
  );
}
