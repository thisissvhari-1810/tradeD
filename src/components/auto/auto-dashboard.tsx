"use client";

import Link from "next/link";
import { useState } from "react";
import { Activity, FileText, Pause, Play, Power, RadioTower } from "lucide-react";
import { api } from "@/components/api";
import { Badge, Button, Notice, PageHeader, Section, cx } from "@/components/ui";
import type { autoOverview } from "@/server/auto/views";
import { inr, money, STATUS_TONE, time, tone, useNow, usePoll } from "./shared";

type Overview = Awaited<ReturnType<typeof autoOverview>>;
type Card = Overview["cards"][number];

/**
 * Automated Trading: the master control, one card per strategy (its own ₹20,000 day wallet), the day's table and the
 * live paper history. Live paper figures only; each card's backtest record is labelled as backtest.
 */
export function AutoDashboard() {
  const { data, error, setData } = usePoll<Overview>("/api/auto", 5_000);
  const [busy, setBusy] = useState(false);
  const now = useNow();
  const [fail, setFail] = useState("");
  const act = async (body: object) => {
    setBusy(true);
    setFail("");
    try {
      setData(await api<Overview>("/api/auto", body));
    } catch (reason) {
      setFail(reason instanceof Error ? reason.message : "The change was not saved.");
    } finally {
      setBusy(false);
    }
  };
  const tick = data?.engine.lastTick as { status?: string; dataAgeSec?: number | null; stale?: boolean; errors?: string[]; ms?: number } | null | undefined;
  const beatAge = data?.engine.heartbeatAt ? Math.max(0, Math.round((now - new Date(data.engine.heartbeatAt).getTime()) / 1000)) : null;
  const workerOk = beatAge != null && beatAge < 90;

  return (
    <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 px-4 py-4 sm:px-6">
      <PageHeader
        eyebrow="Paper trading · no broker orders"
        title="Automated Trading"
        description="8 strategies run on the server every 30 seconds with their own ₹20,000 wallet each day. Every fill is simulated on the live option quote."
        actions={<Link href="/automated/reports" className="inline-flex h-9 items-center gap-1.5 rounded-input border border-border px-3 text-dense font-semibold text-text-2 hover:bg-hover"><FileText className="h-4 w-4" aria-hidden />Daily reports</Link>}
      />
      {error || fail ? <Notice tone="loss">{fail || error}</Notice> : null}

      <Section title="Master control">
        <div className="grid gap-3 md:grid-cols-[auto_1fr]">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={data?.engine.enabled ? "danger" : "primary"} icon={<Power className="h-4 w-4" />} loading={busy} onClick={() => void act({ action: "master", enabled: !data?.engine.enabled })}>
              {data?.engine.enabled ? "Master engine ON — turn off" : "Master engine OFF — turn on"}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy || !data} onClick={() => void act({ action: "mode", mode: data?.engine.mode === "PAPER" ? "SHADOW" : "PAPER" })}>
              Mode: {data?.engine.mode ?? "—"}
            </Button>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-dense sm:grid-cols-4 xl:grid-cols-8">
            <Kpi label="Backend worker" value={<span className={workerOk ? "text-profit" : "text-loss"}>{workerOk ? "Running" : "No heartbeat"}</span>} hint={beatAge != null ? `${beatAge} s ago` : "never"} />
            <Kpi label="Market data" value={<span className={tick?.stale ? "text-warning" : "text-text"}>{tick?.stale ? "Stale" : tick?.status ?? "—"}</span>} hint={tick?.dataAgeSec != null ? `last candle ${tick.dataAgeSec} s` : ""} />
            <Kpi label="Last heartbeat" value={time(data?.engine.heartbeatAt)} hint={tick?.ms != null ? `pass ${tick.ms} ms` : ""} />
            <Kpi label="Active strategies" value={`${data?.totals.active ?? "—"} / 8`} />
            <Kpi label="Trades today" value={data?.totals.trades ?? "—"} />
            <Kpi label="Realized today" value={<span className={tone(data?.totals.realized)}>{inr(data?.totals.realized)}</span>} />
            <Kpi label="Unrealized" value={<span className={tone(data?.totals.unrealized)}>{inr(data?.totals.unrealized)}</span>} />
            <Kpi label="Virtual capital" value={money(data?.totals.capital)} hint={data?.totals.avgLatencyMs != null ? `avg signal→fill ${(data.totals.avgLatencyMs / 1000).toFixed(1)} s` : ""} />
          </dl>
        </div>
        {tick?.errors?.length ? <Notice tone="warning" className="mt-3">{tick.errors.join(" · ")}</Notice> : null}
      </Section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(data?.cards ?? []).map((card) => <StrategyCard key={card.key} card={card} busy={busy} act={act} />)}
      </div>

      <Section title={`Today · ${data?.date ?? ""}`} description="Live paper results of the current session. Capital resets to ₹20,000 per strategy every trading day." flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-dense">
            <thead className="text-left text-micro uppercase tracking-wide text-muted"><tr className="border-b border-border">{["Strategy", "Capital", "Trades", "Profit", "Loss", "Net P&L", "Unrealized", "Status"].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
            <tbody>
              {(data?.cards ?? []).map((c) => (
                <tr key={c.key} className="border-b border-border-soft">
                  <td className="px-3 py-2 font-semibold"><Link href={`/automated/${c.key}`} className="hover:underline">{c.name}</Link></td>
                  <td className="num px-3 py-2">{money(c.day?.opening)}</td>
                  <td className="num px-3 py-2">{c.day?.trades ?? 0}</td>
                  <td className="num px-3 py-2 text-profit">{c.day?.wins ?? 0}</td>
                  <td className="num px-3 py-2 text-loss">{c.day?.losses ?? 0}</td>
                  <td className={cx("num px-3 py-2 font-semibold", tone(c.day?.realized))}>{inr(c.day?.realized)}</td>
                  <td className={cx("num px-3 py-2", tone(c.day?.unrealized))}>{inr(c.day?.unrealized)}</td>
                  <td className="px-3 py-2"><Badge tone={STATUS_TONE[c.day?.status ?? "WAITING"] ?? "neutral"}>{c.day?.status ?? "WAITING"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Live paper history" description="Daily net P&L of all 8 strategies together (live paper only, not the backtest).">
        <History rows={data?.history ?? []} />
      </Section>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-micro text-muted">{label}</dt>
      <dd className="num truncate font-semibold">{value}</dd>
      {hint ? <dd className="truncate text-micro text-muted">{hint}</dd> : null}
    </div>
  );
}

function StrategyCard({ card, busy, act }: { card: Card; busy: boolean; act: (body: object) => Promise<void> }) {
  const status = card.open ? card.open.status : card.day?.status ?? "WAITING";
  const off = !card.enabled;
  const signal = card.lastSignal as { right?: string; strike?: number; confirmMinute?: number; status?: string; minute?: string } | null;
  return (
    <article className={cx("flex flex-col gap-3 rounded-card border border-border bg-panel p-3 shadow-e1", off && "opacity-70")}>
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link href={`/automated/${card.key}`} className="block truncate text-body font-semibold hover:underline">{card.name}</Link>
          <p className="truncate text-micro text-muted">{card.days.join(" · ")} · {card.window}</p>
        </div>
        <Badge tone={off ? "neutral" : card.paused ? "warning" : "profit"} dot>{off ? "Inactive" : card.paused ? "Paused" : "Active"}</Badge>
      </header>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status.replace("_", " ")}</Badge>
        <Badge tone={card.eligibleToday ? "info" : "neutral"}>{card.eligibleToday ? "Trades today" : "Not its day"}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-dense">
        <Kpi label="Initial capital" value={money(card.day?.opening ?? 20000)} />
        <Kpi label="Available" value={money(card.day?.available ?? 20000)} />
        <Kpi label="Realized" value={<span className={tone(card.day?.realized)}>{inr(card.day?.realized)}</span>} />
        <Kpi label="Unrealized" value={<span className={tone(card.day?.unrealized)}>{inr(card.day?.unrealized)}</span>} />
        <Kpi label="Total today" value={<span className={tone(card.day?.total)}>{inr(card.day?.total)}</span>} />
        <Kpi label="Trades today" value={`${card.day?.trades ?? 0} / ${card.maxTrades}`} />
        <Kpi label="Last entry" value={time(card.lastEntry)} />
        <Kpi label="Last exit" value={time(card.lastExit)} />
      </dl>
      {card.open ? (
        <p className="rounded-md bg-primary-soft px-2 py-1.5 text-micro text-primary">
          <RadioTower className="mr-1 inline h-3.5 w-3.5" aria-hidden />{card.open.symbol} · {card.open.quantity} qty @ ₹{card.open.entry} · now {card.open.last != null ? `₹${card.open.last}` : "—"}{card.open.stop != null ? ` · stop ₹${card.open.stop}` : ""}
        </p>
      ) : null}
      <p className="line-clamp-2 min-h-[2rem] text-micro text-text-2">{card.day?.note || "Waiting for the session."}</p>
      <p className="text-micro text-muted">
        Last signal: {signal?.right ? `${signal.right} ${signal.strike ?? ""} (${signal.status ?? "traded"})` : "none"} · Window: {card.window}
      </p>
      <p className="text-micro text-muted">Backtest (5 y): {card.backtest.trades} trades, {card.backtest.wins} / {card.backtest.losses}</p>
      <footer className="mt-auto flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act({ action: "strategy", key: card.key, op: card.enabled ? "disable" : "enable" })}>{card.enabled ? "Disable" : "Enable"}</Button>
        <Button size="sm" variant="secondary" disabled={busy || off} icon={card.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />} onClick={() => void act({ action: "strategy", key: card.key, op: card.paused ? "resume" : "pause" })}>{card.paused ? "Resume" : "Pause"}</Button>
        <Link href={`/automated/${card.key}`} className="ml-auto inline-flex h-8 items-center gap-1 rounded-input px-2 text-dense font-semibold text-primary hover:bg-hover"><Activity className="h-3.5 w-3.5" aria-hidden />Details</Link>
      </footer>
    </article>
  );
}

function History({ rows }: { rows: Overview["history"] }) {
  if (!rows.length) return <p className="text-dense text-muted">No live paper days yet. The first session starts at 09:15 IST on the next trading day.</p>;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  const running = rows.reduce<number[]>((acc, r) => [...acc, (acc.at(-1) ?? 0) + r.net], []);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-dense">
        <thead className="text-left text-micro uppercase tracking-wide text-muted"><tr className="border-b border-border">{["Date", "Trades", "Profit / Loss", "Net P&L", "", "Cumulative"].map((h, i) => <th key={i} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, index) => {
            const cumulative = running[index];
            return (
              <tr key={r.date} className="border-b border-border-soft">
                <td className="px-3 py-1.5"><Link className="hover:underline" href={`/automated/reports?date=${r.date}`}>{r.date}</Link></td>
                <td className="num px-3 py-1.5">{r.trades}</td>
                <td className="num px-3 py-1.5">{r.wins} / {r.losses}</td>
                <td className={cx("num px-3 py-1.5 font-semibold", tone(r.net))}>{inr(r.net)}</td>
                <td className="w-48 px-3 py-1.5"><span className={cx("block h-2 rounded-full", r.net >= 0 ? "bg-profit" : "bg-loss")} style={{ width: `${Math.max(2, (Math.abs(r.net) / max) * 100)}%` }} aria-hidden /></td>
                <td className={cx("num px-3 py-1.5", tone(cumulative))}>{inr(Math.round(cumulative * 100) / 100)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
