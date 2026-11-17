"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/components/api";
import { useDesk } from "@/components/shell";
import { Badge, Button, Notice, PageHeader, Section, SegmentedControl, cx } from "@/components/ui";
import { H0H4Chart, LEVEL_COLOR } from "@/components/fib-h0h4/h0h4-chart";
import { clock, H0H4_NAME, REASON_TEXT, type Candle5, type H0H4Phase, type H0H4Report, type H0H4Row, type H0H4State, type ProgressTone } from "@/lib/algo/fib-h0h4";
import type { H0H4View } from "@/server/fib-h0h4";

const n2 = (value: number | null | undefined, digits = 2) => (value == null ? "—" : value.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const inr = (value: number | null | undefined) => (value == null ? "—" : `${value < 0 ? "−" : ""}₹${n2(Math.abs(value))}`);
const tone = (value: number | null | undefined) => (value == null ? "" : value > 0 ? "text-profit" : value < 0 ? "text-loss" : "");

const PHASE_LABEL: Record<H0H4Phase, string> = {
  WAITING_FOR_OPEN: "Waiting for the first candle", CHECKING_GREEN: "Checking opening candle", SELECTING_ATM: "Selecting ATM CE", WAITING_FOR_H0: "Waiting for H0",
  WAITING_FOR_H1: "Waiting for H1 (a high above H0)", WAITING_FOR_H2: "Waiting for H2 (a high above H1)", WAITING_FOR_H3: "Waiting for H3 (a high above H2)", CALCULATING_FIB: "Calculating Fibonacci",
  WAITING_FOR_H4: "Waiting for H4 (a high above H3)", VALIDATING_H4: "Validating H4", WAITING_FOR_H4_BREAK: "Waiting for H4 breakout", ENTRY_PENDING: "BUY signal — entry pending",
  POSITION_OPEN: "Position open", EXIT_PENDING: "Exit pending", TARGET_COMPLETED: "Target completed", SESSION_SKIPPED: "Session skipped", SESSION_COMPLETED: "Session completed",
};
const STEP_STYLE: Record<ProgressTone, string> = {
  done: "border-profit/40 bg-profit-soft text-profit",
  waiting: "border-warning/40 bg-warning-soft text-warning",
  failed: "border-loss/40 bg-loss-soft text-loss",
  idle: "border-border-soft bg-sunken text-muted",
};

function Info({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-muted">{label}</dt>
      <dd className={cx("truncate text-dense font-medium text-text", className)}>{value}</dd>
    </div>
  );
}

/** GREEN OPEN → … → TARGET with confirmed (green), waiting (yellow), failed (red); H4 purple, target gold. */
function Progress({ steps }: { steps: { step: string; tone: ProgressTone }[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Strategy progress">
      {steps.map(({ step, tone: t }, index) => {
        const accent = t === "done" && (step === "H4" || step === "BREAK H4") ? { borderColor: LEVEL_COLOR.H4, color: LEVEL_COLOR.H4 } : t === "done" && step === "TARGET" ? { borderColor: LEVEL_COLOR.F618, color: LEVEL_COLOR.F618 } : undefined;
        return (
          <li key={step} className="flex items-center gap-1">
            <span className={cx("rounded-pill border px-2 py-0.5 text-micro font-semibold", STEP_STYLE[t])} style={accent} aria-label={`${step}: ${t}`}>{step}</span>
            {index < steps.length - 1 ? <span className="text-micro text-muted" aria-hidden>→</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The level monitoring table: price, status and confirmation time of every level. */
export function LevelTable({ state }: { state: H0H4State | null }) {
  const lv = state?.levels;
  const status = (ok: boolean, waiting: boolean, done = "Confirmed") => (ok ? done : waiting ? "Waiting" : "—");
  const phase = state?.phase;
  const rows: { name: string; price: string; status: string; at: string; color: string }[] = [
    { name: "H0", price: n2(lv?.H0?.price), status: lv?.H0 ? "Established" : status(false, phase === "WAITING_FOR_H0"), at: lv?.H0 ? clock(lv.H0.confirmedAt) : "", color: LEVEL_COLOR.H0 },
    { name: "H1", price: n2(lv?.H1?.price), status: status(Boolean(lv?.H1), phase === "WAITING_FOR_H1"), at: lv?.H1 ? clock(lv.H1.confirmedAt) : "", color: LEVEL_COLOR.H1 },
    { name: "H2", price: n2(lv?.H2?.price), status: status(Boolean(lv?.H2), phase === "WAITING_FOR_H2"), at: lv?.H2 ? clock(lv.H2.confirmedAt) : "", color: LEVEL_COLOR.H2 },
    { name: "H3", price: n2(lv?.H3?.price), status: status(Boolean(lv?.H3), phase === "WAITING_FOR_H3"), at: lv?.H3 ? clock(lv.H3.confirmedAt) : "", color: LEVEL_COLOR.H3 },
    { name: "Fib 0.0 (Initial Low)", price: n2(state?.fib?.f0), status: state?.fib ? "Locked" : "—", at: state?.fib ? clock(state.fib.lockedAt) : "", color: LEVEL_COLOR.F0 },
    { name: "Fib 0.5 (= H3)", price: n2(state?.fib?.f05), status: state?.fib ? "Locked" : "—", at: state?.fib ? clock(state.fib.lockedAt) : "", color: LEVEL_COLOR.F05 },
    { name: "Fib 0.618 (target)", price: state?.fib ? `${state.fib.f0618.toFixed(3)} → sell ${n2(state.fib.targetOrder)}` : "—", status: state?.fib ? "Target" : "—", at: state?.fib ? clock(state.fib.lockedAt) : "", color: LEVEL_COLOR.F618 },
    { name: "H4", price: n2(lv?.H4?.price), status: lv?.H4 ? (state?.h4Valid ? "Established · valid (< 0.618)" : "Invalid (≥ 0.618)") : status(false, phase === "WAITING_FOR_H4"), at: lv?.H4 ? clock(lv.H4.confirmedAt) : "", color: LEVEL_COLOR.H4 },
    { name: "H4 Breakout", price: state?.breakout ? `close ${n2(state.breakout.close)}` : "—", status: state?.breakout ? "Confirmed" : phase === "WAITING_FOR_H4_BREAK" ? "Waiting" : "—", at: state?.breakout ? clock(state.breakout.signalAt) : "", color: LEVEL_COLOR.H4 },
  ];
  return (
    <table className="w-full text-dense" aria-label="Level monitoring">
      <thead><tr className="text-left text-micro text-muted"><th className="py-1 font-medium">Level</th><th className="py-1 text-right font-medium">Price</th><th className="py-1 pl-3 font-medium">Status</th><th className="py-1 text-right font-medium">Time</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name} className="border-t border-border-soft">
            <td className="py-1.5"><span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: row.color }} aria-hidden />{row.name}</td>
            <td className="py-1.5 text-right font-medium tabular-nums">{row.price}</td>
            <td className={cx("py-1.5 pl-3", row.status.startsWith("Invalid") ? "text-loss" : row.status === "Waiting" ? "text-warning" : row.status === "—" ? "text-muted" : "text-profit")}>{row.status}</td>
            <td className="py-1.5 text-right tabular-nums text-muted">{row.at}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TradePanel({ view }: { view: Pick<H0H4View, "state" | "trade" | "ltp" | "unrealized"> }) {
  const { state, trade } = view;
  const d = trade?.chargesDetail;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      <Info label="Entry price" value={inr(state?.entry?.price)} />
      <Info label="Entry time" value={state?.entry ? clock(state.entry.time) : "—"} />
      <Info label="Quantity" value={state?.entry ? `${state.entry.quantity} (${state.entry.lots} lot)` : "—"} />
      <Info label="Target price" value={inr(state?.fib?.targetOrder)} />
      <Info label="Current option LTP" value={inr(view.ltp)} />
      <Info label="Unrealized P&L" value={inr(view.unrealized)} className={tone(view.unrealized)} />
      <Info label="Exit price" value={state?.exit ? `${inr(state.exit.price)} · ${state.exit.reason === "TARGET" ? "target" : "square-off"} ${clock(state.exit.time)}` : "—"} />
      <Info label="Realized P&L (gross)" value={inr(trade?.gross)} className={tone(trade?.gross)} />
      <Info label="Brokerage & charges" value={d ? `${inr(d.total)} (brok ${n2(d.brokerage)} · STT ${n2(d.stt)} · exch ${n2(d.exchange)} · GST ${n2(d.gst)})` : "—"} />
      <Info label="Net P&L" value={inr(trade?.net)} className={cx("text-title", tone(trade?.net))} />
    </dl>
  );
}

/* ---------------- report ---------------- */

export function ReportView({ report }: { report: H0H4Report }) {
  const o = report.overall;
  const funnel: [string, number][] = [["Total sessions", o.sessions], ["Green opening", o.greenOpen], ["H0 established", o.h0], ["H1 confirmed", o.h1], ["H2 confirmed", o.h2], ["H3 confirmed", o.h3], ["H4 established", o.h4], ["Valid H4", o.validH4], ["H4 breakout", o.h4Breakout], ["Trades", o.trades]];
  const a = report.analysis;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <table className="w-full text-dense" aria-label="Session funnel">
          <tbody>{funnel.map(([k, v]) => <tr key={k} className="border-t border-border-soft"><td className="py-1">{k}</td><td className="py-1 text-right font-medium tabular-nums">{v}</td></tr>)}</tbody>
        </table>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 self-start">
          <Info label="Trades · profit / loss" value={`${o.trades} · ${o.wins} / ${o.losses}`} />
          <Info label="Win rate" value={`${o.winRate}%`} />
          <Info label="Target hits · non-target exits" value={`${o.targetHits} · ${o.nonTargetExits}`} />
          <Info label="No-entry sessions" value={o.noEntrySessions} />
          <Info label="Gross P&L" value={inr(o.grossProfit)} className={tone(o.grossProfit)} />
          <Info label="Total charges" value={inr(o.charges)} />
          <Info label="Net P&L" value={inr(o.netProfit)} className={tone(o.netProfit)} />
          <Info label="Average per trade" value={inr(o.avgPerTrade)} className={tone(o.avgPerTrade)} />
          <Info label="Max drawdown" value={inr(o.maxDrawdown)} />
          <Info label="Max consecutive wins / losses" value={`${o.maxConsecutiveWins} / ${o.maxConsecutiveLosses}`} />
        </dl>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <PeriodTable title="Year-wise" rows={report.years} />
        <PeriodTable title="Month-wise" rows={report.months} compact />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Info label="Avg H0 → H1" value={a.avgH0toH1 == null ? "—" : `${a.avgH0toH1} min`} />
        <Info label="Avg H1 → H2" value={a.avgH1toH2 == null ? "—" : `${a.avgH1toH2} min`} />
        <Info label="Avg H2 → H3" value={a.avgH2toH3 == null ? "—" : `${a.avgH2toH3} min`} />
        <Info label="Avg H3 → H4" value={a.avgH3toH4 == null ? "—" : `${a.avgH3toH4} min`} />
        <Info label="Avg H4 → entry" value={a.avgH4toEntry == null ? "—" : `${a.avgH4toEntry} min`} />
        <Info label="Avg entry → target" value={a.avgEntryToTarget == null ? "—" : `${a.avgEntryToTarget} min`} />
        <Info label="H4 never broke" value={a.h4NeverBroke} />
        <Info label="Target before entry" value={a.targetBeforeEntry} />
        <Info label="Invalid H4 setups" value={a.invalidH4} />
        <Info label="Ambiguous trades" value={o.ambiguousTrades} />
      </dl>
      <p className="text-micro text-muted">Session end reasons: {Object.entries(a.reasons).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${REASON_TEXT[k as keyof typeof REASON_TEXT] ?? k} ${v}`).join(" · ")}</p>
    </div>
  );
}

function PeriodTable({ title, rows, compact = false }: { title: string; rows: H0H4Report["years"]; compact?: boolean }) {
  return (
    <div className={cx("overflow-auto", compact && "max-h-72")}>
      <table className="w-full text-dense" aria-label={title}>
        <thead className="sticky top-0 bg-panel"><tr className="text-left text-micro text-muted"><th className="py-1 font-medium">{title}</th><th className="py-1 text-right font-medium">Trades</th><th className="py-1 text-right font-medium">Wins</th><th className="py-1 text-right font-medium">Losses</th><th className="py-1 text-right font-medium">Win %</th>{compact ? null : <th className="py-1 text-right font-medium">Gross</th>}<th className="py-1 text-right font-medium">Net</th></tr></thead>
        <tbody>
          {rows.length ? rows.map((row) => (
            <tr key={row.period} className="border-t border-border-soft tabular-nums">
              <td className="py-1">{row.period}</td><td className="py-1 text-right">{row.trades}</td><td className="py-1 text-right">{row.wins}</td><td className="py-1 text-right">{row.losses}</td><td className="py-1 text-right">{row.winRate}%</td>
              {compact ? null : <td className={cx("py-1 text-right", tone(row.gross))}>{inr(row.gross)}</td>}<td className={cx("py-1 text-right", tone(row.net))}>{inr(row.net)}</td>
            </tr>
          )) : <tr><td className="py-2 text-muted" colSpan={7}>No trades.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function SessionTable({ rows, onOpen }: { rows: H0H4Row[]; onOpen?: (date: string) => void }) {
  return (
    <div className="max-h-[28rem] overflow-auto">
      <table className="w-full whitespace-nowrap text-dense" aria-label="Sessions">
        <thead className="sticky top-0 bg-panel"><tr className="text-left text-micro text-muted">{["Date", "Open", "ATM CE", "H0", "H1", "H2", "H3", "Fib 0.618", "H4", "Entry", "Exit", "Net", "Status"].map((h) => <th key={h} className="px-1.5 py-1 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.date} className={cx("border-t border-border-soft tabular-nums", onOpen && "cursor-pointer hover:bg-hover")} onClick={onOpen ? () => onOpen(row.date) : undefined}>
              <td className="px-1.5 py-1">{row.date}</td>
              <td className={cx("px-1.5 py-1", row.openColour === "GREEN" ? "text-profit" : row.openColour === "RED" ? "text-loss" : "text-muted")}>{row.openColour ?? "—"}</td>
              <td className="px-1.5 py-1">{row.atmStrike ?? "—"}</td>
              <td className="px-1.5 py-1">{n2(row.h0)}</td><td className="px-1.5 py-1">{n2(row.h1)}</td><td className="px-1.5 py-1">{n2(row.h2)}</td><td className="px-1.5 py-1">{n2(row.h3)}</td>
              <td className="px-1.5 py-1">{row.fib0618 == null ? "—" : row.fib0618.toFixed(3)}</td><td className="px-1.5 py-1">{n2(row.h4)}</td>
              <td className="px-1.5 py-1">{row.entryPrice == null ? "—" : `${n2(row.entryPrice)} @${row.entryTime}`}</td>
              <td className="px-1.5 py-1">{row.exitPrice == null ? "—" : `${n2(row.exitPrice)} @${row.exitTime}`}</td>
              <td className={cx("px-1.5 py-1", tone(row.net))}>{inr(row.net)}</td>
              <td className="px-1.5 py-1 text-muted">{row.reasonText ?? (row.exitReason === "TARGET" ? "Target" : row.exitReason === "SQUARE_OFF" ? "Square-off" : row.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- desk ---------------- */

type BacktestRun = { id: string; from: string; to: string; createdAt: string; report: H0H4Report; sessions: H0H4Row[]; notes: string[]; assumptions: string[] };
type Baseline = { report: { from: string; to: string; report: H0H4Report; variant?: { name: string; overall: H0H4Report["overall"] } } | null; reason: string | null };
type DayDetail = { state: H0H4State; candles: Candle5[] };

const yesterday = () => new Date(Date.now() + 19_800_000 - 86_400_000).toISOString().slice(0, 10);
const monthBack = () => new Date(Date.now() + 19_800_000 - 30 * 86_400_000).toISOString().slice(0, 10);

export function H0H4Desk() {
  const desk = useDesk();
  const [tab, setTab] = useState<"paper" | "backtest" | "history">("paper");
  const [view, setView] = useState<H0H4View | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [runs, setRuns] = useState<BacktestRun[]>([]);
  const [run, setRun] = useState<BacktestRun | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [range, setRange] = useState({ from: monthBack(), to: yesterday() });
  const [day, setDay] = useState<DayDetail | null>(null);

  const load = useCallback(async () => {
    try { setView(await api<H0H4View>("/api/fib-h0h4")); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : "The strategy could not be loaded."); }
  }, []);
  useEffect(() => {
    api<H0H4View>("/api/fib-h0h4").then(setView).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The strategy could not be loaded."));
  }, []);
  // While the paper session runs, check every 15 seconds (the server scheduler, /api/fib-h0h4/cron, is the main monitor).
  useEffect(() => {
    if (!view?.enabled) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [view?.enabled, load]);
  useEffect(() => {
    if (tab !== "backtest") return;
    api<BacktestRun[]>("/api/fib-h0h4?backtests=1").then((list) => { setRuns(list); setRun((current) => current ?? list[0] ?? null); }).catch(() => undefined);
    api<Baseline>("/api/fib-h0h4?baseline=1").then(setBaseline).catch(() => undefined);
  }, [tab]);

  const send = async (op: "start" | "stop") => {
    setBusy(op); setError("");
    try { setView(await api<H0H4View>("/api/fib-h0h4", { action: op })); } catch (caught) { setError(caught instanceof Error ? caught.message : "The request failed."); } finally { setBusy(""); }
  };
  const backtest = async () => {
    setBusy("backtest"); setError("");
    try { const result = await api<BacktestRun>("/api/fib-h0h4", { action: "backtest", ...range }); setRun(result); setRuns((list) => [result, ...list].slice(0, 10)); } catch (caught) { setError(caught instanceof Error ? caught.message : "The backtest failed."); } finally { setBusy(""); }
  };
  const openDay = async (date: string) => {
    try { setDay(await api<DayDetail>(`/api/fib-h0h4?day=${date}`)); } catch (caught) { setError(caught instanceof Error ? caught.message : "That session could not be opened."); }
  };

  const state = view?.state ?? null;
  const c = state?.contract;
  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 p-4 max-sm:px-4">
      <PageHeader
        eyebrow={<><span>NIFTY 50 · ATM CE · CALL BUY only · {view?.settings.candleMinutes ?? 1}-minute candles</span><Badge tone="demo">Paper</Badge></>}
        title={H0H4_NAME}
        description="First green 09:15 NIFTY candle → ATM CE → H0 = first CE candle high; H1…H4 = the high of the next candle whose high goes above the previous level → Fib 0.0 = first CE low, 0.5 = H3, 0.618 = target → H4 must be below the target → BUY the moment the price trades above H4 → SELL at Fib 0.618. One trade per session."
        actions={tab === "paper" ? (
          view?.enabled
            ? <Button variant="secondary" loading={busy === "stop"} onClick={() => void send("stop")}>Stop paper session</Button>
            : <Button variant="primary" loading={busy === "start"} onClick={() => void send("start")}>Start paper session</Button>
        ) : null}
      >
        <SegmentedControl label="View" value={tab} onChange={setTab} options={[{ id: "paper", label: "Paper trading" }, { id: "backtest", label: "Backtest" }, { id: "history", label: "Session history" }]} />
      </PageHeader>
      <Notice tone="neutral">Live order execution is disabled for this strategy. BUY and SELL are paper records only; nothing is sent to a broker. Independent of Mathi v18 and every other strategy.</Notice>
      {error ? <Notice tone="loss">{error}</Notice> : null}
      {view?.problems.length ? <Notice tone="warning">{view.problems.join(" ")}</Notice> : null}

      {tab === "paper" ? (
        <>
          <Section title="Today" description={state ? `${state.date} · ${PHASE_LABEL[state.phase]}` : view?.enabled ? "No trading session today." : "Paper session stopped — start it to track today's setup."}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <Info label="Strategy status" value={view?.enabled ? "Running" : "Stopped"} className={view?.enabled ? "text-profit" : "text-muted"} />
              <Info label="Trading mode" value="Paper" />
              <Info label="NIFTY spot" value={n2(view?.spotLast)} />
              <Info label="Opening candle" value={state?.open ? `${state.color} · O ${n2(state.open.open)} C ${n2(state.open.close)}` : "—"} className={state?.color === "GREEN" ? "text-profit" : state?.color ? "text-loss" : ""} />
              <Info label="ATM strike" value={state?.strike ?? "—"} />
              <Info label="CE contract · expiry" value={c ? `${c.symbol} · lot ${c.lotSize}` : "—"} />
              <Info label="Current candle" value={view?.candleTime != null ? `${clock(view.candleTime)}–${clock(view.candleTime + (view.settings.candleMinutes ?? 1))}` : "—"} />
              <Info label="Strategy state" value={state?.phase ?? "—"} className={state?.outcome === "SKIPPED" ? "text-loss" : ""} />
            </dl>
            {state ? <div className="mt-3"><Progress steps={view!.progress} /></div> : null}
          </Section>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Section title={`ATM CE · ${view?.settings.candleMinutes ?? 1}-minute chart`} description="Real candles of the selected contract; each line starts at the candle that set it.">
              <H0H4Chart state={state} candles={view?.candles ?? []} scheme={desk.theme} candleMinutes={view?.settings.candleMinutes ?? 1} />
            </Section>
            <Section title="Level monitoring"><LevelTable state={state} /></Section>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Trade"><TradePanel view={view ?? { state: null, trade: null, ltp: null, unrealized: null }} /></Section>
            <Section title="Session status">
              <ol className="max-h-72 space-y-1 overflow-auto text-dense" aria-live="polite">
                {state?.events.length ? [...state.events].reverse().map((event, index) => (
                  <li key={`${event.at}-${index}`} className="flex gap-2"><span className="w-12 shrink-0 tabular-nums text-muted">{clock(event.at)}</span><span className={cx(event.phase === "SESSION_SKIPPED" ? "text-loss" : event.phase === "TARGET_COMPLETED" ? "text-profit" : "text-text")}>{event.message}</span></li>
                )) : <li className="text-muted">{view?.enabled ? "Waiting for the first candle." : "Not running."}</li>}
                {state?.dataWarnings.map((line) => <li key={line} className="text-micro text-warning">{line}</li>)}
              </ol>
            </Section>
          </div>
        </>
      ) : null}

      {tab === "backtest" ? (
        <>
          <Section title="5-year baseline (real premiums)" description="scripts/backtest-fib-h0h4.ts on the 5-year master dataset; same engine, no optimisation.">
            {baseline?.report ? <><p className="mb-3 text-dense text-muted">{baseline.report.from} → {baseline.report.to}</p><ReportView report={baseline.report.report} /></> : <p className="text-dense text-muted">{baseline?.reason ?? "Loading…"}</p>}
          </Section>
          <Section title="Run a backtest" description="Up to 31 days per run on Dhan's expired weekly option history (ATM ± 10, regrouped per strike). Saved for this strategy only.">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-micro text-muted">From<input type="date" className="mt-1 block rounded-input border border-border-soft bg-sunken px-2 py-1.5 text-dense text-text" value={range.from} max={range.to} onChange={(event) => setRange((r) => ({ ...r, from: event.target.value }))} /></label>
              <label className="text-micro text-muted">To<input type="date" className="mt-1 block rounded-input border border-border-soft bg-sunken px-2 py-1.5 text-dense text-text" value={range.to} max={yesterday()} onChange={(event) => setRange((r) => ({ ...r, to: event.target.value }))} /></label>
              <Button variant="primary" loading={busy === "backtest"} onClick={() => void backtest()}>Run backtest</Button>
              {runs.length > 1 ? (
                <select aria-label="Saved runs" className="rounded-input border border-border-soft bg-sunken px-2 py-1.5 text-dense text-text" value={run?.id ?? ""} onChange={(event) => setRun(runs.find((item) => item.id === event.target.value) ?? null)}>
                  {runs.map((item) => <option key={item.id} value={item.id}>{item.from} → {item.to}</option>)}
                </select>
              ) : null}
            </div>
            {run ? (
              <div className="mt-4 space-y-4">
                <ReportView report={run.report} />
                {run.notes.length ? <Notice tone="warning">{run.notes.join(" ")}</Notice> : null}
                <SessionTable rows={run.sessions} />
                <ul className="list-disc pl-5 text-micro text-muted">{run.assumptions.map((line) => <li key={line}>{line}</li>)}</ul>
              </div>
            ) : null}
          </Section>
        </>
      ) : null}

      {tab === "history" ? (
        <Section title="Paper session history" description="Every session this strategy tracked, including skipped ones and why. Select a recent one to see its chart.">
          {view?.history.length ? <SessionTable rows={view.history} onOpen={(date) => void openDay(date)} /> : <p className="text-dense text-muted">No completed paper sessions yet.</p>}
          {day ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <H0H4Chart state={day.state} candles={day.candles} scheme={desk.theme} candleMinutes={view?.settings.candleMinutes ?? 1} />
              <div className="space-y-3"><p className="text-dense font-medium">{day.state.date} · {day.state.note}</p><LevelTable state={day.state} /></div>
            </div>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
