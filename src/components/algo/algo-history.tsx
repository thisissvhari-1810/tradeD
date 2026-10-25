"use client";

import { useMemo, useState } from "react";
import { cx } from "@/components/ui";
import { Drawer } from "@/components/ui/drawer";
import type { AlgoEvent } from "@/lib/algo/runner";
import type { AlgoData } from "@/components/algo/algo-panel";
import { EXIT_LABEL } from "@/lib/algo/chart-replay";

type Source = "chart" | "sessions" | "paper" | "replay";

const time = (seconds: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(seconds * 1000));
const price = (value: number | null | undefined) => (value == null ? "—" : value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const KIND_TONE: Record<AlgoEvent["kind"], string> = {
  EVALUATION: "text-muted",
  ENTRY: "text-profit",
  EXIT: "text-info",
  REJECTED: "text-loss",
  ERROR: "text-loss",
  INFO: "text-text-2",
};

/**
 * The strategy's learning log: every evaluated candle (lines, prices, OHLC, decision and why), and every
 * order, rejection and exit. The chart replay run, past replay sessions, paper trading and the quick
 * backtest are kept apart.
 */
export function AlgoHistory({ data, onClose, initial }: { data: AlgoData; onClose: () => void; initial?: Source }) {
  const [source, setSource] = useState<Source>(initial ?? (data.chart ? "chart" : data.config.mode === "REPLAY" && data.runs.length ? "sessions" : data.config.mode === "REPLAY" && data.replay ? "replay" : "paper"));
  const [filter, setFilter] = useState<"signals" | "all">("signals");
  const [selected, setSelected] = useState<AlgoEvent | null>(null);
  const events = useMemo(() => {
    const list = source === "replay" ? [...(data.replay?.events ?? [])].reverse() : source === "chart" ? [...(data.chart?.events ?? [])].reverse() : data.events;
    return filter === "all" ? list : list.filter((event) => event.kind !== "EVALUATION" || (event.evaluation && event.evaluation.decision !== "NO_SIGNAL" && event.evaluation.decision !== "FORMING" && event.evaluation.decision !== "NO_PREVIOUS") || (event.evaluation?.notes.length ?? 0) > 0);
  }, [data, source, filter]);
  const trades = useMemo(() => tradesOf(source === "replay" ? data.replay?.events ?? [] : source === "chart" ? data.chart?.events ?? [] : [...data.events].reverse()), [data, source]);

  return (
    <Drawer open modal onClose={onClose} label="Algo signal history" title="Strategy signal history" subtitle={`${data.config.underlying} · 1-minute body crossings · simulated orders only`} width="w-[44rem]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Segment value={source} options={[["chart", "This replay"], ["sessions", "Replay sessions"], ["paper", "Paper"], ["replay", "Backtest"]]} onChange={setSource} disabled={{ chart: !data.chart, replay: !data.replay }} />
        {source !== "sessions" ? <Segment value={filter} options={[["signals", "Signals & orders"], ["all", "Every candle"]]} onChange={setFilter} /> : null}
      </div>
      {source === "chart" || source === "sessions" ? <p className="mb-2 rounded-md bg-demo-soft px-2 py-1.5 text-micro text-demo">Historical replay on the demo wallet: simulated fills from historical 1-minute option premiums. No broker orders.</p> : null}
      {source === "sessions" ? <Sessions runs={data.runs} /> : null}

      {source !== "sessions" && trades.length ? (
        <section aria-label="Trades" className="mb-3">
          <p className="eyebrow mb-1">Trades</p>
          <div className="overflow-x-auto rounded-md border border-border-soft">
            <table className="w-full min-w-[36rem] text-data">
              <thead className="bg-sunken text-left text-micro text-muted">
                <tr><th className="px-2 py-1">Entry</th><th className="px-2 py-1">Contract</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">Entry ₹</th><th className="px-2 py-1 text-right">Exit ₹</th><th className="px-2 py-1">Exit reason</th><th className="px-2 py-1 text-right">Net P&amp;L</th></tr>
              </thead>
              <tbody>
                {trades.map((trade) => (
                  <tr key={trade.entry.key} className="cursor-pointer border-t border-border-soft hover:bg-hover" onClick={() => setSelected(trade.entry)}>
                    <td className="px-2 py-1">{time(trade.entry.time)}</td>
                    <td className="px-2 py-1">{trade.entry.contract ? `${trade.entry.contract.strike} ${trade.entry.side} · ${trade.entry.contract.expiry}` : "—"}</td>
                    <td className="num px-2 py-1 text-right">{trade.entry.order?.quantity ?? "—"}</td>
                    <td className="num px-2 py-1 text-right">{price(trade.entry.order?.price)}</td>
                    <td className="num px-2 py-1 text-right">{price(trade.exit?.order?.price)}</td>
                    <td className="px-2 py-1">{trade.exit ? trade.exit.message : "Open"}</td>
                    <td className={cx("num px-2 py-1 text-right", (trade.exit?.pnl ?? 0) > 0 ? "text-profit" : (trade.exit?.pnl ?? 0) < 0 ? "text-loss" : "")}>{trade.exit?.pnl == null ? "—" : price(trade.exit.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {source === "sessions" ? null : <p className="eyebrow mb-1">Log</p>}
      {source === "sessions" ? null : events.length ? (
        <ol className="space-y-1">
          {events.map((event) => (
            <li key={event.key}>
              <button type="button" className={cx("w-full rounded-md border px-2 py-1.5 text-left hover:bg-hover", selected?.key === event.key ? "border-primary" : "border-border-soft")} onClick={() => setSelected(selected?.key === event.key ? null : event)}>
                <span className="flex items-baseline gap-2">
                  <span className="num shrink-0 text-micro text-muted">{time(event.time)}</span>
                  <span className={cx("shrink-0 text-micro font-semibold", KIND_TONE[event.kind])}>{event.evaluation?.decision ?? event.kind}</span>
                  <span className="min-w-0 flex-1 text-data text-text-2">{event.message}</span>
                </span>
              </button>
              {selected?.key === event.key ? <Detail event={event} lines={data.lines} /> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-data text-muted">{source === "replay" ? "No backtest has been run yet." : source === "chart" ? "Nothing logged for this replay yet. Enable the Algo and press Play." : "Nothing logged yet. Start a paper session to see each completed candle evaluated here."}</p>
      )}
      {selected && !events.some((event) => event.key === selected.key) ? <div className="mt-2"><Detail event={selected} lines={data.lines} /></div> : null}
    </Drawer>
  );
}

function Detail({ event, lines }: { event: AlgoEvent; lines: AlgoData["lines"] }) {
  const evaluation = event.evaluation;
  return (
    <div className="mt-1 space-y-1.5 rounded-md bg-sunken/60 px-2 py-2 text-data">
      {evaluation ? (
        <>
          <p className="text-text-2">{evaluation.explanation}</p>
          <dl className="grid grid-cols-5 gap-2">
            <Pair label="Prev close" value={price(evaluation.previousClose)} />
            <Pair label="Open" value={price(evaluation.candle.open)} />
            <Pair label="High" value={price(evaluation.candle.high)} />
            <Pair label="Low" value={price(evaluation.candle.low)} />
            <Pair label="Close" value={price(evaluation.candle.close)} />
          </dl>
          {evaluation.events.length ? (
            <ul className="list-disc pl-4 text-text-2">{evaluation.events.map((cross) => <li key={cross.lineId}>Crossed {cross.direction === "DOWN" ? "down through" : "up through"} {cross.label} at {price(cross.price)}</li>)}</ul>
          ) : null}
          {evaluation.notes.length ? (
            <ul className="list-disc pl-4 text-muted">{evaluation.notes.map((note) => <li key={note.lineId}>{note.label} ({price(note.price)}): {note.detail}</li>)}</ul>
          ) : null}
          {!evaluation.events.length && !evaluation.notes.length && lines.length ? <p className="text-micro text-muted">Lines compared: {lines.filter((line) => line.enabled).map((line) => `${line.label} ${price(line.price)}`).join(" · ")}</p> : null}
        </>
      ) : null}
      {event.contract ? <p>Contract: ATM {event.side ?? event.contract.right} {event.contract.strike} · {event.contract.expiry} · lot {event.contract.lotSize}{event.contract.bid != null ? ` · bid ${price(event.contract.bid)} / ask ${price(event.contract.ask)}` : ""}</p> : null}
      {event.order ? <p>Order {event.order.status}{event.order.quantity ? ` · ${event.order.quantity} qty` : ""}{event.order.price != null ? ` @ ₹${price(event.order.price)}` : ""}{event.order.charges != null ? ` · charges ₹${price(event.order.charges)}` : ""} <span className="text-micro text-muted">(simulated; key …{event.order.key.slice(-12)})</span></p> : null}
      {event.stop != null || event.target != null ? <p>Stop-loss ₹{price(event.stop)} · target ₹{price(event.target)}</p> : null}
      {event.pnl != null ? <p className={event.pnl >= 0 ? "text-profit" : "text-loss"}>Net P&amp;L ₹{price(event.pnl)} (after charges)</p> : null}
      {event.reasons?.length ? <ul className="list-disc pl-4 text-loss">{event.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
    </div>
  );
}

function tradesOf(chronological: AlgoEvent[]) {
  const trades: { entry: AlgoEvent; exit: AlgoEvent | null }[] = [];
  for (const event of chronological) {
    if (event.kind === "ENTRY") trades.push({ entry: event, exit: null });
    else if (event.kind === "EXIT" && event.order && event.pnl != null) {
      // Partial exits add up: the trade shows the latest exit and the total P&L.
      const trade = [...trades].reverse().find((item) => item.entry.order && event.order?.key.startsWith(`${item.entry.order.key}:exit`));
      if (trade) trade.exit = trade.exit ? { ...event, pnl: Math.round(((trade.exit.pnl ?? 0) + (event.pnl ?? 0)) * 100) / 100 } : event;
    }
  }
  return trades.reverse();
}

function Pair({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-micro text-muted">{label}</dt><dd className="num">{value}</dd></div>;
}

function Segment<T extends string>({ value, options, onChange, disabled }: { value: T; options: [T, string][]; onChange: (value: T) => void; disabled?: Partial<Record<T, boolean>> }) {
  return (
    <div className="inline-flex rounded-md border border-border-soft p-0.5" role="group">
      {options.map(([key, label]) => (
        <button key={key} type="button" aria-pressed={value === key} disabled={disabled?.[key]} className={cx("h-7 rounded px-2.5 text-data disabled:opacity-40", value === key ? "bg-primary-soft font-semibold text-primary" : "text-muted hover:bg-hover")} onClick={() => onChange(key)}>{label}</button>
      ))}
    </div>
  );
}

const clock = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) : "—");
const END_REASON: Record<string, string> = { SESSION_END: "Session close", RESET: "Reset by user", "": "Running" };

/** Past algo runs in chart replay: one row per replay session, with its trades on demand. */
function Sessions({ runs }: { runs: AlgoData["runs"] }) {
  const [open, setOpen] = useState<string | null>(runs[0]?.id ?? null);
  if (!runs.length) return <p className="text-data text-muted">No algo replay sessions yet.</p>;
  return (
    <ol className="space-y-2">
      {runs.map((run) => {
        const trades = tradesOf(run.trades);
        const expanded = open === run.id;
        return (
          <li key={run.id} className="rounded-md border border-border-soft">
            <button type="button" aria-expanded={expanded} className="w-full px-2 py-2 text-left hover:bg-hover" onClick={() => setOpen(expanded ? null : run.id)}>
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-semibold">{run.underlying} · replay {run.date}</span>
                <span className="text-micro text-muted">Session {run.replaySession.slice(11)} · {run.status === "ACTIVE" ? "Running" : END_REASON[run.endReason] ?? run.endReason}</span>
                <span className={cx("num ml-auto font-semibold", run.stats.realized > 0 ? "text-profit" : run.stats.realized < 0 ? "text-loss" : "")}>{run.stats.realized >= 0 ? "+" : "−"}₹{price(Math.abs(run.stats.realized))}</span>
              </span>
            </button>
            {expanded ? (
              <div className="space-y-2 border-t border-border-soft px-2 py-2 text-data">
                <dl className="grid grid-cols-4 gap-2 max-sm:grid-cols-2">
                  <Pair label="Started" value={clock(run.startedAt)} />
                  <Pair label="Ended" value={clock(run.endedAt)} />
                  <Pair label="Start cash" value={`₹${price(run.startCash)}`} />
                  <Pair label="End cash" value={run.endCash == null ? "—" : `₹${price(run.endCash)}`} />
                  <Pair label="Signals" value={String(run.stats.signals)} />
                  <Pair label="Accepted / rejected" value={`${run.stats.accepted} / ${run.stats.rejected}`} />
                  <Pair label="Trades (W / L)" value={`${run.stats.trades} (${run.stats.wins} / ${run.stats.losses})`} />
                  <Pair label="Max drawdown" value={`₹${price(run.stats.maxDrawdown)}`} />
                  <Pair label="Stop-loss exits" value={String(run.stats.exits.STOP ?? 0)} />
                  <Pair label="Target exits" value={String(run.stats.exits.TARGET ?? 0)} />
                  <Pair label="Manual exits" value={String((run.stats.exits.MANUAL ?? 0) + (run.stats.exits.EMERGENCY ?? 0))} />
                  <Pair label="Session-end exits" value={String(run.stats.exits.SESSION_END ?? 0)} />
                </dl>
                <p className="text-micro text-muted">Settings: {run.config.lots} lot(s) · stop {run.config.stop.value}{run.config.stop.mode === "percent" ? "%" : " ₹"} · target {run.config.target.value}{run.config.target.mode === "percent" ? "%" : " ₹"} · max loss ₹{price(run.config.maxDailyLoss)} · max {run.config.maxTrades} trades · cooldown {run.config.cooldownMinutes} min · {run.config.opposingPolicy === "exit-first" ? "exit on opposite signal" : "ignore opposite signals"}</p>
                {trades.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[34rem] text-data">
                      <thead className="text-left text-micro text-muted"><tr><th className="py-1 pr-2">Entry</th><th className="py-1 pr-2">Contract</th><th className="py-1 pr-2 text-right">Qty</th><th className="py-1 pr-2 text-right">Entry ₹</th><th className="py-1 pr-2 text-right">Exit ₹</th><th className="py-1 pr-2">Reason</th><th className="py-1 text-right">Net P&amp;L</th></tr></thead>
                      <tbody>
                        {trades.map((trade) => (
                          <tr key={trade.entry.key} className="border-t border-border-soft">
                            <td className="py-1 pr-2">{time(trade.entry.key.startsWith("entry:") ? trade.entry.time + 60 : trade.entry.time)}</td>
                            <td className="py-1 pr-2">{trade.entry.side} {trade.entry.contract?.strike} {trade.entry.contract?.right}</td>
                            <td className="num py-1 pr-2 text-right">{trade.entry.order?.quantity ?? "—"}</td>
                            <td className="num py-1 pr-2 text-right">{price(trade.entry.order?.price)}</td>
                            <td className="num py-1 pr-2 text-right">{price(trade.exit?.order?.price)}</td>
                            <td className="py-1 pr-2">{trade.exit ? EXIT_LABEL[/^Exit \(([A-Z_]+)\)/.exec(trade.exit.message)?.[1] ?? ""] ?? "Exit" : "Open"}</td>
                            <td className={cx("num py-1 text-right", (trade.exit?.pnl ?? 0) > 0 ? "text-profit" : (trade.exit?.pnl ?? 0) < 0 ? "text-loss" : "")}>{trade.exit?.pnl == null ? "—" : price(trade.exit.pnl)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="text-micro text-muted">No trades in this session.</p>}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
