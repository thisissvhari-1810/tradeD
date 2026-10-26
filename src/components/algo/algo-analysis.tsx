"use client";

import { cx } from "@/components/ui";
import { STRATEGY_IDS, STRATEGY_LABEL, type MarketAnalysis, type PatternState } from "@/lib/algo/patterns";
import type { Confirmation, ConfirmationStatus } from "@/lib/algo/confirmations";

const ist = (seconds: number | null | undefined) => (seconds ? new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16) : "—");
const price = (value: number | null | undefined) => (value == null ? "—" : value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const TREND_TONE: Record<MarketAnalysis["trend"], string> = { BULLISH: "bg-profit-soft text-profit", BEARISH: "bg-loss-soft text-loss", SIDEWAYS: "bg-warning-soft text-warning", UNCONFIRMED: "bg-sunken text-muted" };

/** Status colours are a hint only: every status is also written out. */
export function statusTone(status: string) {
  if (/DISABLED|UNAVAILABLE|NO VALID/.test(status)) return "text-muted";
  if (/INVALIDATED|EXIT CONDITION|CONFLICTING|EXPIRED/.test(status)) return "text-loss";
  if (/CONFIRMED|STRENGTHENING|HOLDING/.test(status)) return "text-profit";
  return "text-warning";
}

const CONFIRM_TONE: Record<ConfirmationStatus, string> = {
  WAITING: "bg-sunken text-muted",
  CONFIRMED: "bg-profit-soft text-profit",
  STRENGTHENING: "bg-profit-soft text-profit",
  HOLDING: "bg-info-soft text-info",
  WEAKENING: "bg-warning-soft text-warning",
  "RETEST IN PROGRESS": "bg-warning-soft text-warning",
  "RETEST CONFIRMED": "bg-profit-soft text-profit",
  "CONFLICTING SIGNAL": "bg-loss-soft text-loss",
  "SETUP INVALIDATED": "bg-loss-soft text-loss",
  "EXIT CONDITION TRIGGERED": "bg-loss-soft text-loss",
  UNAVAILABLE: "bg-sunken text-muted",
};

function patternText(pattern: PatternState | null) {
  if (!pattern) return "None";
  const name = pattern.kind === "W" ? "W / double bottom" : "M / double top";
  const state = pattern.status === "FORMING" ? "forming" : pattern.status === "READY" ? "waiting for neckline" : pattern.status === "BROKEN" ? "neckline broken" : pattern.status === "RETEST" ? "retesting neckline" : pattern.status === "TRIGGERED" ? "triggered" : pattern.status.toLowerCase();
  return `${name} · ${state}`;
}

/** Why the algo is waiting when no position is open (from the real analysis and session state). */
export function waitingMessage(analysis: MarketAnalysis | null | undefined, entries: number, maxTrades: number) {
  if (entries >= maxTrades) return "TRADE LIMIT REACHED";
  if (!analysis) return "WAITING FOR THE FIRST COMPLETED CANDLE";
  if (!analysis.observationComplete) return `ANALYZING OPENING MARKET — entries from ${ist(analysis.observationEnd)} IST`;
  const active = STRATEGY_IDS.map((id) => analysis.strategies[id]).filter((item) => item?.enabled && item.status !== "DISABLED");
  if (!active.length) return "NO STRATEGY ENABLED";
  const forming = active.find((item) => /FORMING|RETEST|WAITING FOR NECKLINE|WAITING FOR RETEST/.test(item.status));
  return forming ? forming.status : "OBSERVATION COMPLETE — WAITING FOR SIGNAL";
}

/** Market analysis: session, opening range, trend, trendlines, W / M and the nearest levels. */
export function MarketAnalysisSection({ analysis, symbol, time }: { analysis: MarketAnalysis | null | undefined; symbol: string; time: number | null }) {
  return (
    <details open className="rounded-lg border border-border-soft" aria-label="Market analysis">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Market analysis</span>
        {analysis ? <span className={cx("rounded-pill px-2 py-0.5 text-xs font-semibold", TREND_TONE[analysis.trend])}>{analysis.trend}</span> : null}
        <span className="num ml-auto text-xs text-muted">{symbol} · 1m · {ist(time)} IST</span>
      </summary>
      <div className="border-t border-border-soft px-3 py-2 text-xs">
        {!analysis ? <p className="text-muted">Waiting for the first completed candle.</p> : (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <Row label="Session" value={analysis.observationComplete ? "Observation complete" : `Observing until ${ist(analysis.observationEnd)} IST`} tone={analysis.observationComplete ? "text-text" : "text-warning"} />
            <Row label="Last update" value={`${ist(analysis.asOf)} IST`} />
            {analysis.strategies.orb?.enabled ? (
              <>
                <Row label="Opening range high" value={analysis.openingRange ? price(analysis.openingRange.high) : `from ${ist(analysis.observationEnd)} IST`} />
                <Row label="Opening range low" value={analysis.openingRange ? price(analysis.openingRange.low) : `from ${ist(analysis.observationEnd)} IST`} />
              </>
            ) : null}
            {analysis.strategies.trendline?.enabled ? (
              <>
                <Row label="Resistance trendline" value={!analysis.observationComplete ? `Drawn at ${ist(analysis.observationEnd)} IST` : analysis.resistance ? price(analysis.resistance.now) : "No valid trendline"} />
                <Row label="Support trendline" value={!analysis.observationComplete ? `Drawn at ${ist(analysis.observationEnd)} IST` : analysis.support ? price(analysis.support.now) : "No valid trendline"} />
              </>
            ) : null}
            {analysis.strategies.w?.enabled ? (
              <>
                <Row label="W pattern" value={patternText(analysis.w)} />
                <Row label="W neckline" value={analysis.w ? price(analysis.w.neckline) : "—"} />
              </>
            ) : null}
            {analysis.strategies.m?.enabled ? (
              <>
                <Row label="M pattern" value={patternText(analysis.m)} />
                <Row label="M neckline" value={analysis.m ? price(analysis.m.neckline) : "—"} />
              </>
            ) : null}
            <Row label="Nearest level above" value={price(analysis.levels.above)} />
            <Row label="Nearest level below" value={price(analysis.levels.below)} />
          </dl>
        )}
      </div>
    </details>
  );
}

/** The four strategies: on / off, status, CALL / PUT and the trigger level. */
export function StrategyRows({ analysis, positionOpen = false }: { analysis: MarketAnalysis | null | undefined; positionOpen?: boolean }) {
  return (
    <section className="rounded-lg border border-border-soft" aria-label="Strategy status">
      <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-muted">Strategies</p>
      <ul className="divide-y divide-border-soft px-3 pb-1">
        {!analysis ? <li className="py-1.5 text-xs text-muted">Waiting for the first completed candle.</li> : null}
        {STRATEGY_IDS.filter((id) => analysis?.strategies[id]?.enabled).map((id) => {
          const item = analysis?.strategies[id];
          // With a position open the line is not "waiting" or "no signal": the trade is being managed.
          const status = positionOpen && item?.enabled ? "POSITION OPEN" : item ? (item.enabled ? item.status : "DISABLED") : "WAITING";
          return (
            <li key={id} className="flex items-center gap-2 py-1.5 text-xs">
              <span className={cx("h-2 w-2 shrink-0 rounded-full", !item?.enabled ? "bg-border" : item.direction === "CALL" ? "bg-profit" : item.direction === "PUT" ? "bg-loss" : "bg-warning")} aria-hidden />
              <span className="w-[6.5rem] shrink-0 font-medium">{STRATEGY_LABEL[id]}</span>
              <span className={cx("min-w-0 flex-1 truncate font-medium", statusTone(status))} title={status}>{status}</span>
              <span className="shrink-0 text-right">
                <span className={cx("block font-semibold", item?.direction === "CALL" ? "text-profit" : item?.direction === "PUT" ? "text-loss" : "text-muted")}>{positionOpen && item?.enabled ? "" : item?.direction ?? "NO SIGNAL"}</span>
                <span className="num block text-muted">{item?.trigger != null ? price(item.trigger) : ""}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The open trade's intratrade confirmations (status, value, time and why). */
export function ConfirmationList({ confirmations }: { confirmations: Confirmation[] | null | undefined }) {
  if (!confirmations?.length) return <p className="text-xs text-muted">Confirmations appear after the first completed candle in the trade.</p>;
  return (
    <ul className="space-y-1.5" aria-label="Intratrade confirmations">
      {confirmations.map((item) => (
        <li key={item.category} className="text-xs">
          <span className="flex items-center gap-2">
            <span className="w-[5.5rem] shrink-0 text-muted">{item.label}</span>
            <span className={cx("rounded-pill px-1.5 py-0.5 font-semibold", CONFIRM_TONE[item.status])}>{item.status}</span>
            <span className="num ml-auto text-muted">{item.value != null ? price(item.value) : ""}{item.time ? ` · ${ist(item.time)}` : ""}</span>
          </span>
          <span className="mt-0.5 block text-text-2">{item.why}</span>
        </li>
      ))}
    </ul>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className={cx("num truncate font-medium", tone ?? "text-text")} title={value}>{value}</dd>
    </div>
  );
}
