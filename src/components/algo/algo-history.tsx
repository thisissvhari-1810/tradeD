"use client";

import { useMemo, useState } from "react";
import { cx } from "@/components/ui";
import { Drawer } from "@/components/ui/drawer";
import type { AlgoEvent } from "@/lib/algo/runner";
import type { AlgoData } from "@/components/algo/algo-panel";

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
 * order, rejection and exit. Paper trading and the latest historical replay are kept apart.
 */
export function AlgoHistory({ data, onClose }: { data: AlgoData; onClose: () => void }) {
  const [source, setSource] = useState<"paper" | "replay">(data.config.mode === "REPLAY" && data.replay ? "replay" : "paper");
  const [filter, setFilter] = useState<"signals" | "all">("signals");
  const [selected, setSelected] = useState<AlgoEvent | null>(null);
  const events = useMemo(() => {
    const list = source === "replay" ? [...(data.replay?.events ?? [])].reverse() : data.events;
    return filter === "all" ? list : list.filter((event) => event.kind !== "EVALUATION" || (event.evaluation && event.evaluation.decision !== "NO_SIGNAL" && event.evaluation.decision !== "FORMING" && event.evaluation.decision !== "NO_PREVIOUS") || (event.evaluation?.notes.length ?? 0) > 0);
  }, [data, source, filter]);
  const trades = useMemo(() => tradesOf(source === "replay" ? data.replay?.events ?? [] : [...data.events].reverse()), [data, source]);

  return (
    <Drawer open modal onClose={onClose} label="Algo signal history" title="Strategy signal history" subtitle={`${data.config.underlying} · 1-minute body crossings · simulated orders only`} width="w-[44rem]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Segment value={source} options={[["paper", "Paper"], ["replay", "Latest replay"]]} onChange={setSource} disabled={{ replay: !data.replay }} />
        <Segment value={filter} options={[["signals", "Signals & orders"], ["all", "Every candle"]]} onChange={setFilter} />
      </div>

      {trades.length ? (
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

      <p className="eyebrow mb-1">Log</p>
      {events.length ? (
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
        <p className="text-data text-muted">{source === "replay" ? "No replay has been run yet." : "Nothing logged yet. Start a paper session to see each completed candle evaluated here."}</p>
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
