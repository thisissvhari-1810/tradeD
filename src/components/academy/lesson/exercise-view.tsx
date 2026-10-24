"use client";

import "./academy-lesson.css";
import { useState } from "react";
import { Check, Lightbulb, Minus, Plus, X } from "lucide-react";
import { CandleSketch } from "@/components/academy/candle-sketch";
import { EduChart } from "@/components/academy/game/edu-chart";
import { PriceLineChart } from "./price-line-chart";
import { cue } from "@/components/academy/academy-sound";
import type { AnswerInput, PublicQuestion } from "@/lib/academy/types";

/** The server's verdict on an answer (the browser never decides correctness). */
export type Feedback = { correct: boolean; explanation: string; mistake: string | null; answer: string; xp: number };

/** What the learner has picked or typed so far, for any exercise kind. */
export type Draft = {
  choice?: number;
  bool?: boolean;
  text?: string;
  pairs?: Record<string, string>;
  pending?: { side: "left" | "right"; value: string } | null;
  order?: string[];
  candle?: number;
  price?: number;
  /** The left item of the pair joined last (its tiles play the lock-in animation). */
  joined?: string;
};

const PAIR_COLOURS = ["#0ea5e9", "#8b5cf6", "#f59e0b", "#ec4899", "#10b981", "#ef4444", "#6366f1", "#14b8a6"];

/** The answer to send, or null while the exercise is incomplete. */
export function inputOf(question: PublicQuestion, draft: Draft): AnswerInput | null {
  switch (question.kind) {
    case "choice": return draft.choice == null ? null : { kind: "choice", index: draft.choice };
    case "truefalse": return draft.bool == null ? null : { kind: "truefalse", value: draft.bool };
    case "fill": return draft.text?.trim() ? { kind: "fill", text: draft.text.trim() } : null;
    case "numeric": {
      const text = draft.text?.trim() ?? "";
      return text && Number.isFinite(Number(text)) ? { kind: "numeric", value: Number(text) } : null;
    }
    case "match": {
      const pairs = draft.pairs ?? {};
      return question.left.every((left) => pairs[left]) ? { kind: "match", pairs: question.left.map((left) => [left, pairs[left]] as [string, string]) } : null;
    }
    case "tapcandle": return draft.candle == null ? null : { kind: "tapcandle", index: draft.candle };
    case "order": return (draft.order?.length ?? 0) === question.items.length ? { kind: "order", steps: draft.order! } : null;
    // The line must be moved at least once: its starting place is not an answer.
    case "pricezone": return draft.price == null ? null : { kind: "pricezone", price: draft.price };
  }
}

/** Whether the exercise has a picture to look at (Tiko points at it). */
export function hasVisual(question: PublicQuestion) {
  return question.kind === "tapcandle" || question.kind === "pricezone" || Boolean(question.candles?.length);
}

/**
 * One exercise, any kind. Controlled: the parent keeps the draft and checks it with the server; once
 * `feedback` arrives the tiles show the verdict (correct, wrong, and the right one where it is known).
 */
export function ExerciseView({ question, draft, onDraft, locked, feedback, onSubmit, showPrompt = true }: {
  question: PublicQuestion;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  locked: boolean;
  feedback: Feedback | null;
  onSubmit: () => void;
  /** False when the prompt is already shown (in Tiko's bubble). */
  showPrompt?: boolean;
}) {
  const [hint, setHint] = useState(false);
  const pick = (next: Draft) => {
    if (locked) return;
    cue("select");
    onDraft(next);
  };
  const verdict = (selected: boolean, label: string): "correct" | "wrong" | "answer" | undefined => {
    if (!feedback) return undefined;
    if (selected) return feedback.correct ? "correct" : "wrong";
    return !feedback.correct && feedback.answer === label ? "answer" : undefined;
  };

  const tile = (key: string, label: React.ReactNode, keyLabel: string, selected: boolean, result: ReturnType<typeof verdict>, onPick: () => void, extra?: { ariaLabel?: string; pair?: string }) => (
    <button
      key={key}
      type="button"
      className="ax-option"
      disabled={locked}
      aria-pressed={selected}
      aria-label={extra?.ariaLabel}
      data-result={result}
      data-dim={feedback && !selected && !result ? "true" : undefined}
      data-pair={extra?.pair ? "" : undefined}
      style={extra?.pair ? ({ ["--pair" as string]: extra.pair }) : undefined}
      onClick={onPick}
    >
      <span className="ax-key" aria-hidden>{result === "correct" || result === "answer" ? <Check className="h-4 w-4" /> : result === "wrong" ? <X className="h-4 w-4" /> : keyLabel}</span>
      <span className="min-w-0 flex-1 text-[15px] leading-snug">{label}</span>
    </button>
  );

  let body: React.ReactNode = null;
  switch (question.kind) {
    case "choice":
      body = <div className="flex flex-col gap-2.5" role="group" aria-label="Answers">{question.options.map((label, index) => tile(String(index), label, String(index + 1), draft.choice === index, verdict(draft.choice === index, label), () => pick({ ...draft, choice: index })))}</div>;
      break;
    case "truefalse":
      body = (
        <div className="grid grid-cols-2 gap-2.5" role="group" aria-label="Answers">
          {tile("t", "True", "1", draft.bool === true, verdict(draft.bool === true, "True"), () => pick({ ...draft, bool: true }))}
          {tile("f", "False", "2", draft.bool === false, verdict(draft.bool === false, "False"), () => pick({ ...draft, bool: false }))}
        </div>
      );
      break;
    case "fill":
    case "numeric": {
      const result = feedback ? (feedback.correct ? "correct" : "wrong") : undefined;
      body = (
        <label className="flex items-center gap-2">
          <span className="sr-only">Your answer</span>
          <input
            className="ax-input"
            autoFocus
            disabled={locked}
            data-result={result}
            inputMode={question.kind === "numeric" ? "decimal" : "text"}
            autoComplete="off"
            value={draft.text ?? ""}
            placeholder={question.kind === "numeric" ? "Type a number" : "Type your answer"}
            onChange={(event) => onDraft({ ...draft, text: event.target.value })}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onSubmit(); } }}
          />
          {/* Phone number keypads often have no minus key: ± flips the sign. */}
          {question.kind === "numeric" ? <button type="button" disabled={locked} className="ax-btn-ghost w-14 shrink-0 px-0 text-[20px]" aria-label="Change sign" onClick={() => onDraft({ ...draft, text: (draft.text ?? "").startsWith("-") ? (draft.text ?? "").slice(1) : `-${draft.text ?? ""}` })}>±</button> : null}
          {question.kind === "numeric" && question.unit ? <span className="text-[15px] font-semibold text-muted">{question.unit}</span> : null}
        </label>
      );
      break;
    }
    case "match":
      body = <MatchBoard question={question} draft={draft} onDraft={pick} locked={locked} feedback={feedback} />;
      break;
    case "tapcandle": {
      const correct = feedback ? (feedback.correct ? draft.candle ?? null : Number(/(\d+)/.exec(feedback.answer)?.[1] ?? 0) - 1) : null;
      body = (
        <div className="flex flex-col gap-2.5">
          <EduChart candles={question.chart} height={230} numbered onSelect={locked ? undefined : (index) => pick({ ...draft, candle: index })} selected={draft.candle ?? null} result={{ correct: correct != null && correct >= 0 ? correct : null }} label="Educational example · made-up prices · tap a candle" />
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${question.chart.length}, minmax(0, 1fr))` }} role="group" aria-label="Candles">
            {question.chart.map((_, index) => {
              const selected = draft.candle === index;
              const result = feedback ? (selected ? (feedback.correct ? "correct" : "wrong") : index === correct ? "answer" : undefined) : undefined;
              return (
                <button key={index} type="button" className="ax-option justify-center px-1" style={{ minHeight: 44 }} disabled={locked} aria-pressed={selected} data-result={result} aria-label={`Candle ${index + 1}`} onClick={() => pick({ ...draft, candle: index })}>
                  <span className="text-[14px] font-extrabold">{index + 1}</span>
                </button>
              );
            })}
          </div>
        </div>
      );
      break;
    }
    case "order":
      body = <OrderBoard question={question} draft={draft} onDraft={pick} locked={locked} feedback={feedback} />;
      break;
    case "pricezone": {
      const price = draft.price ?? question.start;
      const tone = feedback ? (feedback.correct ? "correct" : "wrong") : "idle";
      // After a wrong answer the server's verdict names the accepted zone ("Between ₹192 and ₹194.5").
      const zone = feedback && !feedback.correct ? (feedback.answer.match(/[\d.]+/g)?.map(Number).slice(0, 2) as [number, number] | undefined) ?? null : null;
      const move = (next: number) => { if (!locked && next !== draft.price) onDraft({ ...draft, price: next }); };
      const nudge = (by: number) => move(Math.min(question.range[1], Math.max(question.range[0], Math.round((price + by) / question.step) * question.step)));
      body = (
        <div className="flex flex-col gap-2.5">
          <PriceLineChart candles={question.chart} price={price} step={question.step} range={question.range} onChange={locked ? undefined : move} tone={tone} zone={zone && zone.length === 2 ? zone : null} />
          <div className="flex items-center gap-2">
            <button type="button" className="ax-btn-ghost w-14 px-0" disabled={locked} aria-label={`Lower the line by ₹${question.step}`} onClick={() => nudge(-question.step)}><Minus className="h-5 w-5" aria-hidden /></button>
            <p className="flex-1 text-center text-[15px] font-bold tabular-nums" aria-live="polite">Stop-loss at ₹{price.toFixed(1)}{draft.price == null ? <span className="block text-[12px] font-semibold text-muted">Drag the line, tap the chart, or use − and +</span> : null}</p>
            <button type="button" className="ax-btn-ghost w-14 px-0" disabled={locked} aria-label={`Raise the line by ₹${question.step}`} onClick={() => nudge(question.step)}><Plus className="h-5 w-5" aria-hidden /></button>
          </div>
        </div>
      );
      break;
    }
  }

  return (
    <section className="flex flex-col gap-4">
      {showPrompt ? <h2 className="text-[18px] font-bold leading-snug">{question.prompt}</h2> : null}
      {question.candles?.length ? <div className="grid place-items-center rounded-2xl border-2 border-border bg-panel p-3"><CandleSketch candles={question.candles} /></div> : null}
      {body}
      {question.hint && !feedback ? (
        hint
          ? <p className="ax-hint-in flex gap-2 rounded-2xl bg-info-soft p-3 text-[14px] text-text-2" role="note"><Lightbulb className="h-5 w-5 shrink-0 text-info" aria-hidden />{question.hint}</p>
          : <button type="button" className="inline-flex items-center gap-1.5 self-start rounded-full px-1 text-[14px] font-bold" style={{ color: "var(--info)" }} onClick={() => setHint(true)}><Lightbulb className="h-4 w-4" aria-hidden />Show a hint</button>
      ) : null}
    </section>
  );
}

/** Tap an item on the left, then its partner on the right (either order). Pairs share a colour and number. */
function MatchBoard({ question, draft, onDraft, locked, feedback }: { question: Extract<PublicQuestion, { kind: "match" }>; draft: Draft; onDraft: (draft: Draft) => void; locked: boolean; feedback: Feedback | null }) {
  const pairs = draft.pairs ?? {};
  const pending = draft.pending ?? null;
  const leftOf = (right: string) => Object.keys(pairs).find((left) => pairs[left] === right);
  const join = (left: string, right: string) => {
    const next = { ...pairs };
    for (const key of Object.keys(next)) if (next[key] === right) delete next[key];
    next[left] = right;
    onDraft({ ...draft, pairs: next, pending: null, joined: left });
  };
  const tapLeft = (left: string) => {
    if (pending?.side === "right") return join(left, pending.value);
    if (pending?.side === "left" && pending.value === left) return onDraft({ ...draft, pending: null });
    const next = { ...pairs };
    delete next[left];
    onDraft({ ...draft, pairs: next, pending: { side: "left", value: left } });
  };
  const tapRight = (right: string) => {
    if (pending?.side === "left") return join(pending.value, right);
    if (pending?.side === "right" && pending.value === right) return onDraft({ ...draft, pending: null });
    const owner = leftOf(right);
    const next = { ...pairs };
    if (owner) delete next[owner];
    onDraft({ ...draft, pairs: next, pending: { side: "right", value: right } });
  };
  const tone = feedback ? (feedback.correct ? "correct" : "wrong") : undefined;
  const tileOf = (side: "left" | "right", value: string, number: number | null, onTap: () => void) => {
    const paired = number != null;
    const active = pending?.side === side && pending.value === value;
    const justJoined = draft.joined != null && pairs[draft.joined] != null && (side === "left" ? value === draft.joined : value === pairs[draft.joined]);
    return (
      <button
        key={`${side}-${value}-${justJoined ? draft.joined : ""}`}
        type="button"
        className={justJoined ? "ax-option ax-lock" : "ax-option"}
        disabled={locked}
        aria-pressed={active}
        data-result={tone}
        data-pair={paired && !tone ? "" : undefined}
        style={paired ? ({ ["--pair" as string]: PAIR_COLOURS[number % PAIR_COLOURS.length] }) : undefined}
        aria-label={`${value}${paired ? `, pair ${number + 1}` : ""}`}
        onClick={onTap}
      >
        <span className="ax-key" aria-hidden>{paired ? number + 1 : side === "left" ? "·" : "?"}</span>
        <span className="min-w-0 flex-1 text-[14px] leading-snug">{value}</span>
      </button>
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] font-semibold text-muted">Tap an item, then its match. Tap a pair again to undo it.</p>
      <div className="grid grid-cols-2 gap-2.5">
        <div className="flex flex-col gap-2.5">{question.left.map((left, index) => tileOf("left", left, pairs[left] ? index : null, () => tapLeft(left)))}</div>
        <div className="flex flex-col gap-2.5">{question.right.map((right) => {
          const owner = leftOf(right);
          return tileOf("right", right, owner ? question.left.indexOf(owner) : null, () => tapRight(right));
        })}</div>
      </div>
    </div>
  );
}

/** Tap the steps in order to build the answer line; tap a placed step to send it back. */
function OrderBoard({ question, draft, onDraft, locked, feedback }: { question: Extract<PublicQuestion, { kind: "order" }>; draft: Draft; onDraft: (draft: Draft) => void; locked: boolean; feedback: Feedback | null }) {
  const placed = draft.order ?? [];
  const bank = question.items.filter((item) => !placed.includes(item));
  const tone = feedback ? (feedback.correct ? "correct" : "wrong") : undefined;
  return (
    <div className="flex flex-col gap-3">
      <ol className="ax-slots" aria-label="Your order">
        {placed.length ? placed.map((item, index) => (
          <li key={item}>
            <button type="button" className="ax-option" disabled={locked} data-result={tone} aria-label={`Step ${index + 1}: ${item}. Tap to remove.`} onClick={() => onDraft({ ...draft, order: placed.filter((value) => value !== item) })}>
              <span className="ax-key" aria-hidden>{index + 1}</span>
              <span className="min-w-0 flex-1 text-[14px] leading-snug">{item}</span>
            </button>
          </li>
        )) : <li className="grid min-h-10 place-items-center text-[13px] font-semibold text-muted">Tap the steps below in order</li>}
      </ol>
      {bank.length ? (
        <div className="flex flex-col gap-2" role="group" aria-label="Steps to place">
          {bank.map((item) => (
            <button key={item} type="button" className="ax-option" disabled={locked} onClick={() => onDraft({ ...draft, order: [...placed, item] })}>
              <span className="ax-key" aria-hidden>+</span>
              <span className="min-w-0 flex-1 text-[14px] leading-snug">{item}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
