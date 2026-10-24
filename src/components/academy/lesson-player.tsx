"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Lightbulb, RefreshCw, Trophy, X, Zap } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { CandleSketch } from "@/components/academy/candle-sketch";
import { styles } from "@/components/academy/game/academy-game-classes";
import { FRESH_KEY } from "@/components/academy/game/academy-game-map";
import { starsFor } from "@/components/academy/game/geometry";
import { RewardCelebration } from "@/components/academy/game/reward-celebration";
import { Button, cx, Skeleton } from "@/components/ui";
import type { AnswerInput, LessonCard, PublicQuestion } from "@/lib/academy/types";

type LessonData = {
  slug: string;
  title: string;
  summary: string;
  minutes: number;
  unit: { number: number; title: string };
  position: { index: number; of: number };
  cards: LessonCard[];
  questions: PublicQuestion[];
  answeredCorrectly: string[];
  passPercent: number;
};
export type Feedback = { correct: boolean; explanation: string; mistake: string | null; answer: string; xp: number };
type Completion = { score: number; firstTime: boolean; xp: number; xpTotal: number; newBadges: Array<{ name: string; description: string }>; streak: { current: number; todayDone: boolean }; level: { level: number; title: string } };

/** One lesson: read the cards, answer the questions (graded on the server), then complete it. */
export function LessonPlayer({ slug }: { slug: string }) {
  const router = useRouter();
  const [lesson, setLesson] = useState<LessonData | null>(null);
  const [error, setError] = useState<{ message: string; locked: boolean } | null>(null);
  const [stage, setStage] = useState<"cards" | "questions" | "done">("cards");
  const [card, setCard] = useState(0);
  const [queue, setQueue] = useState<string[]>([]);
  const [correct, setCorrect] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [completeError, setCompleteError] = useState("");
  const [xpEarned, setXpEarned] = useState(0);

  const load = useCallback(() => {
    api<LessonData>(`/api/academy/lessons/${encodeURIComponent(slug)}`)
      .then((data) => {
        setError(null);
        setLesson(data);
        setCorrect(new Set(data.answeredCorrectly));
        // Questions not yet answered correctly first; a finished lesson can be revised in full.
        const open = data.questions.filter((question) => !data.answeredCorrectly.includes(question.id)).map((question) => question.id);
        setQueue(open.length ? open : data.questions.map((question) => question.id));
      })
      .catch((caught: unknown) => setError({ message: caught instanceof Error ? caught.message : "The lesson could not be loaded.", locked: caught instanceof ApiError && caught.status === 403 }));
  }, [slug]);
  useEffect(() => { load(); }, [load]);

  const byId = useMemo(() => new Map((lesson?.questions ?? []).map((question) => [question.id, question])), [lesson]);
  const current = queue[0] ? byId.get(queue[0]) ?? null : null;
  const total = lesson?.questions.length ?? 0;
  const score = total ? Math.round(([...correct].filter((id) => byId.has(id)).length / total) * 100) : 100;

  async function submit(input: AnswerInput) {
    if (!current || busy) return;
    setBusy(true);
    try {
      const result = await api<Feedback>(`/api/academy/lessons/${encodeURIComponent(slug)}`, { action: "answer", questionId: current.id, answer: input });
      setFeedback(result);
      setXpEarned((value) => value + result.xp);
      if (result.correct) setCorrect((set) => new Set(set).add(current.id));
    } catch (caught) {
      setFeedback({ correct: false, explanation: caught instanceof Error ? caught.message : "The answer could not be checked.", mistake: null, answer: "", xp: 0 });
    } finally {
      setBusy(false);
    }
  }

  function next() {
    if (!current || !feedback) return;
    // A wrong answer comes back at the end of the queue to try again.
    setQueue((items) => (feedback.correct || !feedback.answer ? items.slice(1) : [...items.slice(1), items[0]]));
    setFeedback(null);
  }

  async function complete() {
    setBusy(true);
    setCompleteError("");
    try {
      const result = await api<Completion>(`/api/academy/lessons/${encodeURIComponent(slug)}`, { action: "complete" });
      setCompletion(result);
      setStage("done");
      // The map animates the newly travelled road and the XP once, on the way back.
      if (result.firstTime) {
        try { sessionStorage.setItem(FRESH_KEY, slug); } catch { /* storage unavailable */ }
      }
    } catch (caught) {
      setCompleteError(caught instanceof Error ? caught.message : "The lesson could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-sm">
          <p className="text-dense font-semibold">{error.locked ? "This lesson is locked" : "The lesson could not be loaded"}</p>
          <p className="mt-1 text-data text-muted">{error.message}</p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/academy" className="inline-flex h-10 items-center rounded-input border border-border px-4 text-data font-medium hover:bg-hover">Back to Academy</Link>
            {error.locked ? null : <Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => { setError(null); load(); }}>Retry</Button>}
          </div>
        </div>
      </div>
    );
  }
  if (!lesson) return <div className="mx-auto max-w-2xl space-y-3 p-4">{[0, 1, 2].map((item) => <Skeleton key={item} className="h-24 w-full rounded-card" />)}</div>;

  const steps = lesson.cards.length + total;
  const done = stage === "cards" ? card : stage === "questions" ? lesson.cards.length + (total - Math.max(0, queue.filter((id) => !correct.has(id)).length)) : steps;

  return (
    <div className={`${styles.lessonIn} flex h-full flex-col`}>
      <div className="flex items-center gap-3 border-b border-border-soft px-3 py-2 sm:px-5">
        <button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded-input text-muted hover:bg-hover hover:text-text" aria-label="Back to Academy" onClick={() => router.push("/academy")}><ArrowLeft className="h-5 w-5" aria-hidden /></button>
        <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={Math.round((done / steps) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Lesson progress">
          <span className="block h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${Math.min(100, (done / steps) * 100)}%` }} />
        </span>
        <span className="num inline-flex shrink-0 items-center gap-1 text-data font-semibold text-gold"><Zap className="h-4 w-4" aria-hidden />+{xpEarned}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4 sm:p-6">
          <p className="text-micro font-semibold uppercase tracking-wide text-muted">Unit {lesson.unit.number} · Lesson {lesson.position.index} of {lesson.position.of}</p>

          {stage === "cards" ? (
            <article className="surface flex flex-col gap-3 p-5" aria-live="polite">
              {card === 0 ? <h1 className="text-section font-semibold">{lesson.title}</h1> : null}
              <h2 className={cx("font-semibold", card === 0 ? "text-dense text-text-2" : "text-title")}>{lesson.cards[card].title}</h2>
              {lesson.cards[card].candles ? <CandleSketch candles={lesson.cards[card].candles!} /> : null}
              <Body text={lesson.cards[card].body} />
              <p className="text-micro text-muted">{card + 1} of {lesson.cards.length}</p>
            </article>
          ) : null}

          {stage === "questions" && current ? (
            <QuestionView key={`${current.id}-${queue.length}`} question={current} feedback={feedback} busy={busy} onSubmit={submit} />
          ) : null}

          {stage === "questions" && !current ? (
            <section className="surface flex flex-col items-center gap-2 p-6 text-center">
              <Trophy className="h-8 w-8 text-gold" aria-hidden />
              <p className="text-title font-semibold">All questions answered</p>
              <p className="num text-data text-muted">Score {score}% · {lesson.passPercent}% needed to complete</p>
              {completeError ? <p className="text-data text-loss" role="alert">{completeError}</p> : null}
            </section>
          ) : null}

          {stage === "done" && completion ? (
            <div className="surface overflow-hidden" style={{ background: "linear-gradient(180deg,#fffaf0,#fff1d6)", color: "#0d1726" }}>
              <RewardCelebration
                stars={starsFor(completion.score)}
                xpBefore={completion.xpTotal - xpEarned - completion.xp}
                xpAfter={completion.xpTotal}
                xpGained={xpEarned + completion.xp}
                badge={completion.newBadges[0]?.name ?? null}
                firstTime={completion.firstTime}
              >
                <p className="text-[13px] text-[#0d1726]/70">Score {completion.score}% · Level {completion.level.level} {completion.level.title} · {completion.streak.current}-day streak</p>
              </RewardCelebration>
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border-soft px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-2xl gap-2">
          {stage === "cards" ? (
            <>
              {card > 0 ? <Button className="h-12 flex-1" onClick={() => setCard((value) => value - 1)}>Back</Button> : null}
              <Button variant="primary" className="h-12 flex-[2]" onClick={() => (card + 1 < lesson.cards.length ? setCard((value) => value + 1) : setStage("questions"))}>
                {card + 1 < lesson.cards.length ? "Next" : `Start questions (${total})`}
              </Button>
            </>
          ) : null}
          {stage === "questions" && current && feedback ? <Button variant="primary" className="h-12 flex-1" onClick={next}>Continue</Button> : null}
          {stage === "questions" && !current ? (
            score >= lesson.passPercent
              ? <Button variant="primary" className="h-12 flex-1" disabled={busy} onClick={() => void complete()}>{busy ? "Saving…" : "Complete lesson"}</Button>
              : <Button variant="primary" className="h-12 flex-1" onClick={() => setQueue(lesson.questions.filter((question) => !correct.has(question.id)).map((question) => question.id))}>Try the missed questions</Button>
          ) : null}
          {stage === "done" ? (
            <>
              <button type="button" className={`${styles.play} flex-1`} onClick={() => router.push("/academy")}>BACK TO MAP</button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Body({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/);
  return (
    <div className="flex flex-col gap-2.5 text-body leading-relaxed text-text-2">
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

export function QuestionView({ question, feedback, busy, onSubmit }: { question: PublicQuestion; feedback: Feedback | null; busy: boolean; onSubmit: (input: AnswerInput) => void }) {
  const [choice, setChoice] = useState<number | null>(null);
  const [bool, setBool] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [pairs, setPairs] = useState<Record<string, string>>({});
  const [hint, setHint] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const locked = Boolean(feedback) || busy;

  const input: AnswerInput | null =
    question.kind === "choice" ? (choice == null ? null : { kind: "choice", index: choice })
      : question.kind === "truefalse" ? (bool == null ? null : { kind: "truefalse", value: bool })
        : question.kind === "fill" ? (text.trim() ? { kind: "fill", text: text.trim() } : null)
          : question.kind === "numeric" ? (text.trim() && Number.isFinite(Number(text)) ? { kind: "numeric", value: Number(text) } : null)
            : (question.left.every((left) => pairs[left]) ? { kind: "match", pairs: question.left.map((left) => [left, pairs[left]] as [string, string]) } : null);

  const option = (label: string, selected: boolean, onPick: () => void, key: string) => (
    <button key={key} type="button" disabled={locked} aria-pressed={selected} onClick={onPick} className={cx("flex min-h-12 w-full items-center gap-3 rounded-card border px-4 py-2.5 text-left text-dense transition-colors disabled:cursor-default", selected ? "border-primary bg-primary-soft text-text" : "border-border bg-panel hover:bg-hover")}>
      <span className={cx("grid h-5 w-5 shrink-0 place-items-center rounded-full border-2", selected ? "border-primary bg-primary" : "border-border-strong")} aria-hidden>{selected ? <span className="h-1.5 w-1.5 rounded-full bg-on-primary" /> : null}</span>
      {label}
    </button>
  );

  return (
    <section className="flex flex-col gap-3" aria-live="polite">
      <h1 className="text-title font-semibold leading-snug">{question.prompt}</h1>
      {question.candles ? <CandleSketch candles={question.candles} /> : null}
      {question.kind === "choice" ? <div className="flex flex-col gap-2">{question.options.map((label, index) => option(label, choice === index, () => setChoice(index), String(index)))}</div> : null}
      {question.kind === "truefalse" ? <div className="grid grid-cols-2 gap-2">{option("True", bool === true, () => setBool(true), "t")}{option("False", bool === false, () => setBool(false), "f")}</div> : null}
      {question.kind === "fill" || question.kind === "numeric" ? (
        <label className="flex items-center gap-2">
          <span className="sr-only">Your answer</span>
          <input ref={inputRef} disabled={locked} inputMode={question.kind === "numeric" ? "decimal" : "text"} className="h-12 min-w-0 flex-1 rounded-card border border-border bg-panel px-4 text-body" value={text} placeholder={question.kind === "numeric" ? "Type a number" : "Type your answer"} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && input && !locked) onSubmit(input); }} />
          {/* Phone number keypads often have no minus key: ± flips the sign. */}
          {question.kind === "numeric" ? <button type="button" disabled={locked} className="h-12 w-12 shrink-0 rounded-card border border-border text-title font-semibold hover:bg-hover" aria-label="Change sign" onClick={() => setText((value) => (value.startsWith("-") ? value.slice(1) : `-${value}`))}>±</button> : null}
          {question.kind === "numeric" && question.unit ? <span className="text-dense text-muted">{question.unit}</span> : null}
        </label>
      ) : null}
      {question.kind === "match" ? (
        <div className="flex flex-col gap-2">
          {question.left.map((left) => (
            <label key={left} className="flex flex-col gap-1 rounded-card border border-border bg-panel p-3 sm:flex-row sm:items-center">
              <span className="flex-1 text-dense font-medium">{left}</span>
              <select disabled={locked} className="h-11 rounded-input sm:w-60" value={pairs[left] ?? ""} onChange={(event) => setPairs((current) => ({ ...current, [left]: event.target.value }))}>
                <option value="">Choose…</option>
                {question.right.map((right) => <option key={right} value={right}>{right}</option>)}
              </select>
            </label>
          ))}
        </div>
      ) : null}

      {question.hint && !feedback ? (
        hint ? <p className="flex gap-2 rounded-card bg-info-soft p-3 text-data text-text-2"><Lightbulb className="h-4 w-4 shrink-0 text-info" aria-hidden />{question.hint}</p>
          : <button type="button" className="self-start text-data font-medium text-primary hover:underline" style={{ color: "var(--primary)" }} onClick={() => setHint(true)}>Show a hint</button>
      ) : null}

      {feedback ? (
        <div className={cx("rounded-card border p-4", feedback.correct ? `border-profit/40 bg-profit-soft ${styles.celebrate}` : "border-loss/40 bg-loss-soft")} role="status">
          <p className={cx("flex items-center gap-2 text-dense font-semibold", feedback.correct ? "text-profit" : "text-loss")}>
            {feedback.correct ? <Check className="h-5 w-5" aria-hidden /> : <X className="h-5 w-5" aria-hidden />}
            {feedback.correct ? `Correct${feedback.xp ? ` · +${feedback.xp} XP` : ""}` : "Not quite"}
          </p>
          {!feedback.correct && feedback.answer ? <p className="mt-1 text-data text-text"><span className="font-semibold">Answer:</span> {feedback.answer}</p> : null}
          <p className="mt-1 text-data text-text-2">{feedback.explanation}</p>
          {feedback.mistake ? <p className="mt-1 text-data text-muted"><span className="font-semibold">Common mistake:</span> {feedback.mistake}</p> : null}
          {!feedback.correct && feedback.answer ? <p className="mt-1 text-micro text-muted">This question comes back at the end for another try.</p> : null}
        </div>
      ) : (
        <Button variant="primary" className="h-12" disabled={!input || busy} onClick={() => input && onSubmit(input)}>{busy ? "Checking…" : "Check answer"}</Button>
      )}
    </section>
  );
}
