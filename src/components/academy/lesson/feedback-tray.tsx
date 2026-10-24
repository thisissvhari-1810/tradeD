"use client";

import { AlertTriangle, ArrowRight, Flame, Lightbulb, RefreshCw, X, Zap } from "lucide-react";
import type { Feedback } from "./exercise-view";

/**
 * The verdict after the server has checked an answer: slides up from the bottom (`dock`) or opens in
 * place (`inline`, inside a story scene). Colour, icon and words all carry the result; XP shows only
 * what the server paid. With `error` (the check itself failed) nothing is marked and Retry resends.
 */
export function AcademyFeedbackTray({ feedback, error, praise, combo = 0, hint, onContinue, onRetry, retrying = false, variant = "dock", continueLabel = "Continue" }: {
  feedback: Feedback | null;
  error?: string | null;
  praise: string;
  /** Correct answers in a row in this lesson (shown from 2). */
  combo?: number;
  /** Tiko's hint after a wrong answer (the question's own hint, when it has one). */
  hint?: string | null;
  onContinue?: () => void;
  onRetry?: () => void;
  retrying?: boolean;
  variant?: "dock" | "inline";
  continueLabel?: string;
}) {
  const tone = feedback ? (feedback.correct ? "correct" : "wrong") : "error";
  const colour = tone === "correct" ? "var(--profit)" : tone === "wrong" ? "var(--loss)" : "var(--warning)";
  const dock = variant === "dock";
  return (
    <div className={dock ? "ax-footer ax-tray px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4" : "ax-tray rounded-2xl p-3"} data-tone={tone} role="status" aria-live="assertive">
      <div className={dock ? "mx-auto flex max-w-2xl flex-col gap-3 sm:flex-row sm:items-end" : "flex flex-col gap-3"}>
        <div className="flex min-w-0 flex-1 gap-3">
          <span className="ax-tray-icon" style={{ color: colour }} aria-hidden>
            {tone === "correct" ? <svg viewBox="0 0 24 24" className="h-7 w-7"><path className="ax-check-draw" d="M5 12.5 L10 17.5 L19 7" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              : tone === "wrong" ? <X className="h-7 w-7" strokeWidth={3.5} /> : <AlertTriangle className="h-6 w-6" strokeWidth={2.5} />}
          </span>
          <div className="ax-tray-body min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-[19px] font-black" style={{ color: colour }}>
              {tone === "correct" ? praise : tone === "wrong" ? "Not quite" : "We couldn't check that answer"}
              {feedback?.correct && feedback.xp ? <span className="ax-xp inline-flex items-center gap-0.5 rounded-full bg-panel px-2 py-0.5 text-[13px] font-extrabold text-gold"><Zap className="h-3.5 w-3.5" fill="currentColor" aria-hidden />+{feedback.xp} XP</span> : null}
              {feedback?.correct && combo >= 2 ? <span className="inline-flex items-center gap-0.5 rounded-full bg-panel px-2 py-0.5 text-[13px] font-extrabold" style={{ color: "#e0621a" }}><Flame className="h-3.5 w-3.5" fill="currentColor" aria-hidden />{combo} in a row</span> : null}
            </p>
            {feedback && !feedback.correct && feedback.answer ? <p className="mt-1 text-[15px] font-bold text-text"><span style={{ color: colour }}>Correct answer:</span> {feedback.answer}</p> : null}
            {feedback ? <p className="mt-1 text-[14px] leading-snug text-text-2">{feedback.explanation}</p> : <p className="mt-1 text-[14px] text-text-2">{error} Nothing was marked; your answer is still selected.</p>}
            {feedback && !feedback.correct && hint ? <p className="mt-1.5 flex gap-1.5 text-[13px] font-semibold text-text-2"><Lightbulb className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--info)" }} aria-hidden />Tiko&apos;s hint: {hint}</p> : null}
            {feedback?.mistake ? <p className="mt-1 text-[13px] text-muted"><span className="font-bold">Common mistake:</span> {feedback.mistake}</p> : null}
            {feedback && !feedback.correct && dock ? <p className="mt-1 text-[12px] font-semibold text-muted">This one comes back at the end for another try.</p> : null}
          </div>
        </div>
        {feedback && onContinue
          ? <button type="button" className={dock ? "ax-btn w-full sm:w-auto sm:min-w-44" : "ax-btn w-full"} data-tone={feedback.correct ? "success" : "danger"} onClick={onContinue} autoFocus>{continueLabel}<ArrowRight className="ax-arrow h-5 w-5" aria-hidden /></button>
          : !feedback && onRetry ? <button type="button" className={dock ? "ax-btn w-full sm:w-auto sm:min-w-44" : "ax-btn w-full"} disabled={retrying} onClick={onRetry} autoFocus>{retrying ? <><span className="ax-spin" aria-hidden />Checking</> : <><RefreshCw className="h-4 w-4" aria-hidden />Try again</>}</button> : null}
      </div>
    </div>
  );
}

