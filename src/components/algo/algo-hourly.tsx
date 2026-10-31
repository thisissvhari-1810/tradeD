"use client";

import { useState } from "react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";
import { Field, Info, NumberInput, type AlgoData } from "@/components/algo/algo-panel";
import { announceSaved } from "@/components/algo/algo-settings-sync";
import { HOURLY_SETTINGS_DEFAULTS, istClock, type HourlyPair, type HourlySettings, type HourlyTrade } from "@/lib/algo/hourly-zone";
import type { AlgoConfig, AlgoState } from "@/lib/algo/runner";

const inr = (value: number | null | undefined) => (value == null ? "—" : `${value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const points = (value: number) => value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const HOURLY_STATUS_TONE: Record<string, string> = {
  WAITING: "bg-info-soft text-info",
  CONFIRMED: "bg-primary-soft text-primary",
  SKIPPED: "bg-sunken text-muted",
  ENTERED: "bg-warning-soft text-warning",
  "TARGET HIT": "bg-profit-soft text-profit",
  "MIDPOINT EXIT": "bg-loss-soft text-loss",
  "EARLY EXIT": "bg-loss-soft text-loss",
  "GAIN PROTECTED": "bg-sunken text-text-2",
  "BOX STOP": "bg-loss-soft text-loss",
  "BOX TARGET": "bg-profit-soft text-profit",
  "SESSION CLOSED": "bg-sunken text-text-2",
  EXITED: "bg-sunken text-text-2",
};

/** A pair's status as shown: a confirmed pair with a trade shows the trade's status instead. */
export function pairLabel(pair: HourlyPair, trades: HourlyTrade[]) {
  const trade = trades.find((item) => item.decisionTime === pair.decisionTime) ?? null;
  return { trade, status: trade ? trade.status : pair.status };
}

/** The no-stop-loss warning, shown wherever the strategy can be started or is trading. */
export function NoStopWarning({ config }: { config: Pick<AlgoConfig, "target" | "squareOff"> }) {
  return (
    <p className="rounded-md border border-loss/40 bg-loss-soft px-2 py-1.5 text-micro leading-snug text-loss" role="note">
      <strong>No fixed stop-loss.</strong> No stop order is ever placed: an open trade is closed only by the +{config.target.value}% target, a completed hour closing on the wrong side of its midpoint, the {config.squareOff ?? "15:20"} square-off or you. A fast move inside an hour is not limited, so losses can be substantial.
    </p>
  );
}

type HourlyPosition = { entryKey: string; avg: number; quantity: number; target: number; unrealized?: number | null; lowest?: number; contract: { strike: number; right: string; expiry: string } };

/**
 * The strategy's session as it runs (the live panel beside the chart and the chart replay panel): the warning, the open
 * trade with its unrealized P&L and maximum adverse move, and today's hourly pairs with every check, skip reason,
 * trade and midpoint decision.
 */
export function HourlyToday({ state, position, config }: { state: Pick<AlgoState, "analysis" | "hourly"> | null | undefined; position: HourlyPosition | null; config: Pick<AlgoConfig, "target" | "squareOff"> }) {
  const today = state?.analysis?.hourly ?? null;
  const trades = state?.hourly?.trades ?? today?.trades ?? [];
  const open = position ? trades.find((item) => item.entryKey === position.entryKey) ?? null : null;
  const adverse = position && position.lowest != null ? Math.max(0, position.avg - position.lowest) : null;
  return (
    <div className="space-y-2">
      <NoStopWarning config={config} />
      {position ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft p-2" aria-label="Open hourly trade">
          <div className="col-span-2"><p className="eyebrow">Open trade</p></div>
          <Info label="Option" text={`${position.contract.strike} ${position.contract.right} · ${position.contract.expiry}`} />
          <Info label="Entry premium" text={inr(position.avg)} />
          <Info label="Target premium" text={inr(position.target)} tone="text-profit" />
          <Info label="NIFTY reference" text={open ? points(open.reference) : "—"} />
          <Info label="Unrealized P&L" text={inr(position.unrealized)} tone={(position.unrealized ?? 0) > 0 ? "text-profit" : (position.unrealized ?? 0) < 0 ? "text-loss" : undefined} />
          <Info label="Max adverse move" text={adverse != null ? `${inr(adverse)} / unit (${inr(adverse * position.quantity)})` : "—"} tone={adverse ? "text-loss" : undefined} />
        </dl>
      ) : null}
      <div className="rounded-md border border-border-soft p-2">
        <p className="eyebrow">Today&apos;s hourly pairs</p>
        <p className="mt-0.5 text-micro text-text-2" role="status">{today?.status ?? "Waiting for the session: the first pair is decided when the 10:15–11:15 candle closes."}</p>
        {today?.pairs.length ? (
          <ul className="mt-1 space-y-1.5">
            {today.pairs.map((pair) => {
              const { trade, status } = pairLabel(pair, trades);
              return (
                <li key={pair.decisionTime} className="text-micro leading-snug">
                  <span className="flex items-center gap-1.5">
                    <span className={cx("rounded-pill px-1.5 py-0.5 font-semibold", HOURLY_STATUS_TONE[status] ?? "bg-sunken text-muted")}>{status}</span>
                    <span className="font-medium text-text">{istClock(pair.first.start)} + {istClock(pair.first.end)} · {pair.direction ?? "doji"}{pair.side ? ` (ATM ${pair.side})` : ""} · ref {points(pair.reference)}</span>
                  </span>
                  {pair.reasons.length ? <span className="block text-muted">Skipped: {pair.reasons.join("; ")}.</span> : null}
                  {trade ? (
                    <span className="block text-text-2">
                      Entry {inr(trade.premium)} → target {inr(trade.target)}{trade.exitPremium != null ? `; exit ${inr(trade.exitPremium)} at ${istClock(trade.exitTime!)} (${inr(trade.pnl)})` : ""}{trade.shadow ? " · shadow" : ""}
                      {trade.midpoints.length ? `; midpoints ${trade.midpoints.map((item) => `${istClock(item.start)} ${item.keep ? "hold" : "exit"} (close ${points(item.close)} vs ${points(item.mid)})`).join(", ")}` : ""}
                    </span>
                  ) : null}
                  <details className="text-muted"><summary className="cursor-pointer">Checks</summary>{pair.checks.map((line) => <span key={line} className="block">{line}</span>)}</details>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Mathi Hourly Zone Strategy — 5% in the Strategy box: its rules, the no-stop-loss warning and its own settings (saved
 * separately from every other strategy). The session itself (pairs, trades) is shown in the panel beside the chart.
 */
export function HourlyRules({ data, onData }: { data: AlgoData; onData: (next: AlgoData) => void }) {
  const own = data.mathiHourly;
  const [draft, setDraft] = useState<AlgoConfig>(own.config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedFor, setSavedFor] = useState(own.config);
  if (savedFor !== own.config && JSON.stringify(savedFor) !== JSON.stringify(own.config)) {
    setSavedFor(own.config);
    if (JSON.stringify(draft) === JSON.stringify(savedFor)) setDraft(own.config);
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(own.config);
  const set = (patch: Partial<AlgoConfig>) => setDraft({ ...draft, ...patch });
  const settings: HourlySettings = { ...HOURLY_SETTINGS_DEFAULTS, ...draft.hourly };
  const hourly = (patch: Partial<HourlySettings>) => set({ hourly: { ...settings, ...patch } });
  async function save() {
    setBusy(true);
    setError("");
    try {
      const next = await api<AlgoData>("/api/algo", { action: "save", strategy: "MATHI_HOURLY", config: draft });
      onData(next);
      setDraft(next.mathiHourly.config);
      setSavedFor(next.mathiHourly.config);
      announceSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const config = own.config;
  const saved = { ...HOURLY_SETTINGS_DEFAULTS, ...config.hourly };

  return (
    <div className="space-y-3">
      <NoStopWarning config={config} />

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border-soft bg-sunken/50 p-2">
        <div className="col-span-2"><p className="eyebrow">Mathi Hourly Zone — rules</p></div>
        <Info label="Instrument" text="NIFTY 50 ATM CALL / PUT · nearest expiry" />
        <Info label="Timeframe" text="1-hour NIFTY candles (09:15 grid)" />
        <Info label="Red first candle" text="LONG → buy ATM CALL" tone="text-profit" />
        <Info label="Green first candle" text="SHORT → buy ATM PUT" tone="text-loss" />
        <Info label="Entry (mid)" text={saved.referencePrice === "bodyLow" ? "Bottom of the drawn candle's body (fixed)" : `Drawn candle's ${saved.referencePrice} (fixed)`} />
        <Info label="Earliest entry" text={`${config.entryStart} IST`} />
        <Info label="Target" text={`+${config.target.value}% of the option premium`} tone="text-profit" />
        <Info label="Exit" text="Hour closes past its midpoint the wrong way" />
        <Info label="Trades" text={`${config.maxTrades} per session`} />
        <Info label="Session-loss limit" text={saved.maxSessionLoss > 0 ? inr(saved.maxSessionLoss) : "Off"} />
        <p className="col-span-2 text-micro leading-snug text-muted">
          Zone: the 2nd candle must close {saved.zoneMinPoints > 0 ? `at least ${saved.zoneMinPoints} points` : ""} above the LONG reference / below the SHORT reference{saved.zoneMaxPoints > 0 ? ` (at most ${saved.zoneMaxPoints} points)` : ""}. Only the 2nd candle&apos;s close decides{saved.skipPart === "off" ? "" : `; also, the ${saved.skipCandle} candle's ${saved.skipPart} must not cross ${saved.skipSide === "against" ? "into the losing side of" : "above"} the reference`}. {saved.boxMode !== "off" ? `The 2nd candle's body and wick must stay inside the position box (${saved.boxMode === "range" ? `${saved.boxSize} × the 1st candle's range` : `${saved.boxSize} points`} each side). ` : ""}A skipped pair hands over to the {saved.pairStep === "next" ? "next two hours" : "next hour"}. Paper trading only — no real orders.
        </p>
      </dl>

      {error ? <p className="rounded-md border border-loss/30 bg-loss-soft px-2 py-1.5 text-micro text-loss" role="alert">{error}</p> : null}
      <details className="rounded-md border border-border-soft">
        <summary className="cursor-pointer px-2 py-1.5 font-medium text-text-2">Hourly Zone settings</summary>
        <div className="space-y-1.5 border-t border-border-soft p-2">
          <p className="eyebrow">Zone and skip rule</p>
          <Field label="Entry (mid) at">
            <select className="compact-field w-[9.5rem]" aria-label="Position entry" value={settings.referencePrice} onChange={(event) => hourly({ referencePrice: event.target.value === "close" ? "close" : event.target.value === "open" ? "open" : "bodyLow" })}>
              <option value="bodyLow">Bottom of the drawn candle&apos;s body</option>
              <option value="open">Drawn candle&apos;s open</option>
              <option value="close">Drawn candle&apos;s close</option>
            </select>
          </Field>
          <Field label="Zone: min points beyond ref"><NumberInput value={settings.zoneMinPoints} step={1} min={0} onChange={(zoneMinPoints) => hourly({ zoneMinPoints })} /></Field>
          <Field label="Zone: max points (0 = none)"><NumberInput value={settings.zoneMaxPoints} step={5} min={0} onChange={(zoneMaxPoints) => hourly({ zoneMaxPoints })} /></Field>
          <Field label="Doji tolerance (points)"><NumberInput value={settings.dojiTolerance} step={0.5} min={0} onChange={(dojiTolerance) => hourly({ dojiTolerance })} /></Field>
          <Field label="Skip rule reads">
            <select className="compact-field w-[9.5rem]" aria-label="Skip rule candle" value={settings.skipCandle} onChange={(event) => hourly({ skipCandle: event.target.value === "first" ? "first" : "second" })}>
              <option value="second">Second candle</option>
              <option value="first">First candle</option>
            </select>
          </Field>
          <Field label="Skip rule part">
            <select className="compact-field w-[9.5rem]" aria-label="Skip rule part" value={settings.skipPart} onChange={(event) => hourly({ skipPart: event.target.value === "body" ? "body" : event.target.value === "off" ? "off" : "wick" })}>
              <option value="off">Off (close decides)</option>
              <option value="wick">Wick (high / low)</option>
              <option value="body">Body (open / close)</option>
            </select>
          </Field>
          {settings.skipPart === "wick" && settings.skipSide === "against" ? <Field label="Wick limit for">
            <select className="compact-field w-[9.5rem]" aria-label="Wick limit for" value={settings.skipWickFor} onChange={(event) => hourly({ skipWickFor: event.target.value === "both" ? "both" : "short" })}>
              <option value="short">SHORT only</option>
              <option value="both">LONG and SHORT</option>
            </select>
          </Field> : null}
          {settings.skipPart === "wick" && settings.skipSide === "against" ? <Field label="Wick may cross up to (points)"><NumberInput value={settings.skipWickPoints} step={5} min={0} onChange={(skipWickPoints) => hourly({ skipWickPoints })} /></Field> : null}
          {settings.skipPart === "wick" && settings.skipSide === "against" && !(settings.skipWickPoints > 0) ? <Field label="Wick may cross up to (%)"><NumberInput value={settings.skipWickPercent} step={5} min={0} onChange={(skipWickPercent) => hourly({ skipWickPercent })} /></Field> : null}
          <Field label="Skip when it crosses">
            <select className="compact-field w-[9.5rem]" aria-label="Skip rule side" value={settings.skipSide} onChange={(event) => hourly({ skipSide: event.target.value === "above" ? "above" : "against" })}>
              <option value="against">Into the losing side</option>
              <option value="above">Above the reference</option>
            </select>
          </Field>
          <Field label="After a skipped pair">
            <select className="compact-field w-[9.5rem]" aria-label="Next pair" value={settings.pairStep} onChange={(event) => hourly({ pairStep: event.target.value === "next" ? "next" : "sliding" })}>
              <option value="sliding">Next hour</option>
              <option value="next">Next two hours</option>
            </select>
          </Field>
          <Field label="Position box edge">
            <select className="compact-field w-[9.5rem]" aria-label="Position box edge" value={settings.boxMode} onChange={(event) => hourly({ boxMode: event.target.value === "range" ? "range" : event.target.value === "points" ? "points" : event.target.value === "wick" ? "wick" : "off" })}>
              <option value="off">No edge</option>
              <option value="wick">Drawn candle&apos;s high / low</option>
              <option value="range">× 1st candle range</option>
              <option value="points">NIFTY points</option>
            </select>
          </Field>
          {settings.skipPart === "body" ? <Field label="Body may cross the mid by (points)"><NumberInput value={settings.bodyCrossPoints} step={0.5} min={0} onChange={(bodyCrossPoints) => hourly({ bodyCrossPoints })} /></Field> : null}
          {settings.boxMode !== "off" ? <Field label="LONG: low may break the box by (points)"><NumberInput value={settings.longLowBelowBoxPoints} step={5} min={0} onChange={(longLowBelowBoxPoints) => hourly({ longLowBelowBoxPoints })} /></Field> : null}
          <Field label="CALL or PUT from">
            <select className="compact-field w-[11rem]" aria-label="CALL or PUT from" value={settings.directionFrom} onChange={(event) => hourly({ directionFrom: event.target.value === "close" ? "close" : event.target.value === "position" ? "position" : "color" })}>
              <option value="position">Position tool + 2nd candle side</option>
              <option value="color">Drawn candle colour</option>
              <option value="close">2nd candle close vs the mid</option>
            </select>
          </Field>
          <Field label="Body edge nearest the mid at least (points, 0 = off)"><NumberInput value={settings.gapPoints} step={0.5} min={0} onChange={(gapPoints) => hourly({ gapPoints })} /></Field>
          <Field label="Red–red cross → CALL">
            <select className="compact-field w-[11rem]" aria-label="Red-red cross rule" value={settings.crossFlip} onChange={(event) => hourly({ crossFlip: event.target.value === "daily" ? "daily" : event.target.value === "all" ? "all" : "off" })}>
              <option value="off">Off</option>
              <option value="daily">Only for the daily trade</option>
              <option value="all">At any hour</option>
            </select>
          </Field>
          {settings.crossFlip !== "off" ? <Field label="Red–red: open above the mid up to (pts) is not a cross"><NumberInput value={settings.crossTolerance} step={0.5} min={0} onChange={(crossTolerance) => hourly({ crossTolerance })} /></Field> : null}
          {settings.dailyFallback ? <Field label="Daily red–red: open 0 to (pts) above the mid → CALL"><NumberInput value={settings.redRedDailyCall} step={0.5} min={0} onChange={(redRedDailyCall) => hourly({ redRedDailyCall })} /></Field> : null}
          {settings.dailyFallback ? <Field label="Daily red–green: open 0 to (pts) below the mid → PUT"><NumberInput value={settings.redGreenDailyPut} step={0.5} min={0} onChange={(redGreenDailyPut) => hourly({ redGreenDailyPut })} /></Field> : null}
          {settings.dailyFallback ? <Field label="Daily red flip: body over (%, 0 = off) → PUT"><NumberInput value={settings.redAgainstFlip} step={5} min={0} onChange={(redAgainstFlip) => hourly({ redAgainstFlip })} /></Field> : null}
          <Field label="Green–red: open up to (pts) above the mid is not a cross"><NumberInput value={settings.greenRedTolerance} step={0.25} min={0} onChange={(greenRedTolerance) => hourly({ greenRedTolerance })} /></Field>
          {settings.greenRedTolerance > 0 ? <Field label="…and it is a CALL even against the day's move">
            <select className="compact-field w-[11rem]" aria-label="Green-red CALL first" value={settings.greenRedTrendFree ? "on" : "off"} onChange={(event) => hourly({ greenRedTrendFree: event.target.value === "on" })}>
              <option value="off">No — day check applies</option>
              <option value="on">Yes — this rule first</option>
            </select>
          </Field> : null}
          <Field label="Green–red: open up to (pts) above the mid → PUT"><NumberInput value={settings.greenRedPut} step={0.5} min={0} onChange={(greenRedPut) => hourly({ greenRedPut })} /></Field>
          {settings.greenRedPut > 0 ? <Field label="Green–red PUT applies">
            <select className="compact-field w-[11rem]" aria-label="Green-red mode" value={settings.greenRedMode} onChange={(event) => hourly({ greenRedMode: event.target.value === "all" ? "all" : "daily" })}>
              <option value="daily">Only for the daily trade</option>
              <option value="all">At any hour</option>
            </select>
          </Field> : null}
          <Field label="Red–red PUT: skip a lower wick of (pts, 0 = off)"><NumberInput value={settings.redRedMaxLowerWick} step={5} min={0} onChange={(redRedMaxLowerWick) => hourly({ redRedMaxLowerWick })} /></Field>
          <Field label="Red–green wick CALL: wick below the mid at least (%, 0 = off)"><NumberInput value={settings.wickCall} step={10} min={0} onChange={(wickCall) => hourly({ wickCall })} /></Field>
          {settings.wickCall > 0 ? <Field label="Red–green wick CALL">
            <select className="compact-field w-[11rem]" aria-label="Wick CALL mode" value={settings.wickCallMode} onChange={(event) => hourly({ wickCallMode: event.target.value === "trend" ? "trend" : "override" })}>
              <option value="override">Always (skips the 10-point and day checks)</option>
              <option value="trend">Only with the day&apos;s move</option>
            </select>
          </Field> : null}
          {settings.wickCall > 0 && settings.wickCallMode === "trend" ? <Field label="…but any direction on (e.g. Mon,Tue)"><input className="compact-field w-[11rem]" aria-label="Wick CALL any-trend days" value={settings.wickCallAnyTrendDays} onChange={(event) => hourly({ wickCallAnyTrendDays: event.target.value })} /></Field> : null}
          {settings.trendFilter ? <Field label="Short + above → PUT: day check">
            <select className="compact-field w-[11rem]" aria-label="Short above day check" value={settings.shortAboveTrend} onChange={(event) => hourly({ shortAboveTrend: event.target.value === "first" ? "first" : event.target.value === "all" ? "all" : "check" })}>
              <option value="check">Applied</option>
              <option value="first">Not at 11:15 (first pair)</option>
              <option value="all">Never applied</option>
            </select>
          </Field> : null}
          <Field label="Red + green above: lower wick up to (pts) → PUT"><NumberInput value={settings.thinWickPut} step={0.25} min={0} onChange={(thinWickPut) => hourly({ thinWickPut })} /></Field>
          <Field label="Red + red below: lower wick under (pts) → CALL"><NumberInput value={settings.thinWickCall} step={0.25} min={0} onChange={(thinWickCall) => hourly({ thinWickCall })} /></Field>
          {settings.trendFilter ? <Field label="Day check allowance (points)"><NumberInput value={settings.trendTolerance} step={0.5} min={0} onChange={(trendTolerance) => hourly({ trendTolerance })} /></Field> : null}
          <Field label="With the day's move only">
            <select className="compact-field w-[11rem]" aria-label="Day trend filter" value={settings.trendFilter ? "on" : "off"} onChange={(event) => hourly({ trendFilter: event.target.value === "on" })}>
              <option value="off">Off</option>
              <option value="on">On — CALL above the 09:15 open, PUT below</option>
            </select>
          </Field>
          <Field label={`Daily trade (if none by ${settings.fallbackTime})`}>
            <select className="compact-field w-[11rem]" aria-label="Daily trade" value={settings.dailyFallback ? "on" : "off"} onChange={(event) => hourly({ dailyFallback: event.target.value === "on" })}>
              <option value="off">Off — only setups that pass</option>
              <option value="on">On — take the {settings.fallbackTime} setup&apos;s direction</option>
            </select>
          </Field>
          <Field label="When a pair fails">
            <select className="compact-field w-[11rem]" aria-label="When a pair fails" value={settings.oppositeOnFail} onChange={(event) => hourly({ oppositeOnFail: event.target.value === "wrongSide" ? "wrongSide" : event.target.value === "anyRule" ? "anyRule" : "off" })}>
              <option value="off">Move to the next pair</option>
              <option value="wrongSide">Opposite trade if closed on the wrong side</option>
              <option value="anyRule">Opposite trade on any failed rule</option>
            </select>
          </Field>
          <Field label="2nd candle body min (% of candle, 0 = off)"><NumberInput value={settings.minSecondBodyPercent} step={5} min={0} onChange={(minSecondBodyPercent) => hourly({ minSecondBodyPercent })} /></Field>
          <Field label="Loss-side wick max (% of candle, 0 = off)"><NumberInput value={settings.maxLossWickPercent} step={5} min={0} onChange={(maxLossWickPercent) => hourly({ maxLossWickPercent })} /></Field>
          <Field label="Rejection wick max (% of candle, 0 = off)"><NumberInput value={settings.maxRejectionWickPercent} step={5} min={0} onChange={(maxRejectionWickPercent) => hourly({ maxRejectionWickPercent })} /></Field>
          {settings.boxMode !== "off" ? <Field label="Must stay in the box">
            <select className="compact-field w-[9.5rem]" aria-label="Box check" value={settings.boxCheck} onChange={(event) => hourly({ boxCheck: event.target.value === "wick" ? "wick" : "body" })}>
              <option value="body">Body only</option>
              <option value="wick">Body and wicks</option>
            </select>
          </Field> : null}
          {settings.boxMode !== "off" && settings.boxCheck === "wick" ? <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">LONG: lower wick may go below the box</span><input type="checkbox" className="oc-check" aria-label="LONG lower wick may leave the box" checked={settings.boxLongLowFree} onChange={(event) => hourly({ boxLongLowFree: event.target.checked })} /></label> : null}
          {settings.boxMode === "wick" ? <Field label="Minimum box (points, 0 = off)"><NumberInput value={settings.boxMinPoints} step={5} min={0} onChange={(boxMinPoints) => hourly({ boxMinPoints })} /></Field> : null}
          {settings.boxMode === "range" || settings.boxMode === "points" ? <Field label={settings.boxMode === "range" ? "Box size (× range)" : "Box size (points)"}><NumberInput value={settings.boxSize} step={settings.boxMode === "range" ? 0.1 : 5} min={0} onChange={(boxSize) => hourly({ boxSize })} /></Field> : null}
          {settings.boxMode !== "off" ? <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Exit at the box&apos;s red edge (NIFTY stop)</span><input type="checkbox" className="oc-check" aria-label="Box stop" checked={settings.boxStop} onChange={(event) => hourly({ boxStop: event.target.checked })} /></label> : null}
          {settings.boxMode !== "off" ? <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Exit at the box&apos;s green edge (NIFTY target)</span><input type="checkbox" className="oc-check" aria-label="Box target" checked={settings.boxTarget} onChange={(event) => hourly({ boxTarget: event.target.checked })} /></label> : null}
          <label className="flex min-h-7 cursor-pointer items-center justify-between gap-2"><span className="text-muted">Hourly midpoint exit</span><input type="checkbox" className="oc-check" aria-label="Hourly midpoint exit" checked={settings.midpointExit} onChange={(event) => hourly({ midpointExit: event.target.checked })} /></label>
          <p className="text-micro text-muted">With an edge, the box spans that distance above and below the 1st candle&apos;s close; a 2nd candle whose body or wick goes beyond it is skipped. The optional box stop closes the trade once a 1-minute NIFTY candle closes beyond the red edge.</p>
          <p className="text-micro text-muted">&quot;Into the losing side&quot; skips a LONG whose candle traded below the reference and a SHORT whose candle traded above it. &quot;Above the reference&quot; is the rule as first written, for both directions.</p>

          <p className="eyebrow pt-2">Trades and risk</p>
          <Field label="Max trades / session"><NumberInput value={draft.maxTrades} step={1} min={1} onChange={(maxTrades) => set({ maxTrades })} /></Field>
          <Field label="Target (% of premium)"><NumberInput value={draft.target.value} step={0.5} min={0.5} onChange={(value) => set({ target: { mode: "percent", value } })} /></Field>
          <Field label="Max lots per trade"><NumberInput value={draft.lots} step={1} min={1} onChange={(lots) => set({ lots })} /></Field>
          <Field label="Session-loss limit (₹, 0 = off)"><NumberInput value={settings.maxSessionLoss} step={500} min={0} onChange={(maxSessionLoss) => hourly({ maxSessionLoss })} /></Field>
          <Field label="No new entries after"><input type="time" className="compact-field w-[9.5rem]" aria-label="Hourly entry cutoff" value={draft.entryCutoff} min="11:15" max="15:15" onChange={(event) => set({ entryCutoff: event.target.value || "15:00" })} /></Field>
          <Field label="Square-off (IST)"><input type="time" className="compact-field w-[9.5rem]" aria-label="Hourly square-off" value={draft.squareOff ?? "15:20"} min="11:30" max="15:29" onChange={(event) => set({ squareOff: event.target.value || "15:20" })} /></Field>
          <Field label="Paper slippage (ticks)"><NumberInput value={draft.slippageTicks} step={1} min={0} onChange={(slippageTicks) => set({ slippageTicks })} /></Field>
          <p className="text-micro text-muted">The target is on the executed option premium: +{draft.target.value}% on a ₹100 premium is ₹{Number.isFinite(draft.target.value) ? (100 * (1 + draft.target.value / 100)).toFixed(2) : "—"} — not a {draft.target.value}% move in NIFTY. The midpoint rule reads NIFTY&apos;s own hourly candles.</p>
          {dirty ? (
            <div className="flex gap-1.5 pt-1">
              <button type="button" className="h-8 flex-1 rounded-md bg-primary font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save Hourly Zone settings"}</button>
              <button type="button" className="h-8 rounded-md border border-border px-3 hover:bg-hover" onClick={() => setDraft(own.config)}>Undo</button>
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
