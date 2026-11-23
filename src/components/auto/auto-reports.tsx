"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Download } from "lucide-react";
import { Badge, Notice, PageHeader, Section, cx } from "@/components/ui";
import type { autoReport } from "@/server/auto/views";
import type { buildReport } from "@/server/auto/engine";
import { inr, money, time, tone, usePoll } from "./shared";

type Data = Awaited<ReturnType<typeof autoReport>>;
type Report = Awaited<ReturnType<typeof buildReport>>;

/** The end-of-day report of any past session (live paper only), with a CSV export. */
export function AutoReports({ initialDate }: { initialDate: string }) {
  const [date, setDate] = useState(initialDate);
  const { data, error } = usePoll<Data>(`/api/auto/report?date=${date}`, 30_000);
  const report = data?.report as Report | undefined;
  const totals = report?.strategies.reduce((acc, s) => ({ trades: acc.trades + s.trades, wins: acc.wins + s.wins, losses: acc.losses + s.losses, skipped: acc.skipped + s.skipped, gross: acc.gross + s.grossPaise / 100, charges: acc.charges + s.chargesPaise / 100, net: acc.net + s.netPaise / 100 }), { trades: 0, wins: 0, losses: 0, skipped: 0, gross: 0, charges: 0, net: 0 });
  return (
    <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 px-4 py-4 sm:px-6">
      <Link href="/automated" className="inline-flex items-center gap-1 text-dense text-muted hover:text-text"><ArrowLeft className="h-4 w-4" aria-hidden />Automated Trading</Link>
      <PageHeader eyebrow="Paper trading" title="Daily reports" description="All 8 strategies for one session: trades, skipped signals, P&L after charges and any data or execution problem."
        actions={<div className="flex items-center gap-2">
          <select className="compact-field h-9" value={date} onChange={(event) => setDate(event.target.value)} aria-label="Report date">
            {[...new Set([date, ...(data?.dates ?? [])])].sort().reverse().map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <input type="date" className="compact-field h-9" value={date} onChange={(event) => event.target.value && setDate(event.target.value)} aria-label="Pick a date" />
          <a href={`/api/auto/report?date=${date}&format=csv`} className="inline-flex h-9 items-center gap-1.5 rounded-input border border-border px-3 text-dense font-semibold hover:bg-hover"><Download className="h-4 w-4" aria-hidden />CSV</a>
        </div>} />
      {error ? <Notice tone="loss">{error}</Notice> : null}
      {data && !data.final ? <Notice tone="info">This report is still live: it is frozen after 15:35 IST.</Notice> : null}
      {report ? (
        <>
          <Section title={`Summary · ${report.date}`} flush>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[60rem] text-dense">
                <thead className="text-left text-micro uppercase tracking-wide text-muted"><tr className="border-b border-border">{["Strategy", "Status", "Initial", "Trades", "Wins", "Losses", "Skipped", "Gross", "Charges", "Net", "Final balance", "Note"].map((h) => <th key={h} className="px-2.5 py-2 font-semibold">{h}</th>)}</tr></thead>
                <tbody>
                  {report.strategies.map((s) => (
                    <tr key={s.key} className="border-b border-border-soft">
                      <td className="px-2.5 py-1.5 font-semibold"><Link href={`/automated/${s.key}`} className="hover:underline">{s.name}</Link></td>
                      <td className="px-2.5 py-1.5"><Badge>{s.status}</Badge></td>
                      <td className="num px-2.5 py-1.5">{money(s.openingPaise / 100)}</td>
                      <td className="num px-2.5 py-1.5">{s.trades}</td>
                      <td className="num px-2.5 py-1.5 text-profit">{s.wins}</td>
                      <td className="num px-2.5 py-1.5 text-loss">{s.losses}</td>
                      <td className="num px-2.5 py-1.5">{s.skipped}</td>
                      <td className={cx("num px-2.5 py-1.5", tone(s.grossPaise))}>{inr(s.grossPaise / 100)}</td>
                      <td className="num px-2.5 py-1.5">{money(s.chargesPaise / 100)}</td>
                      <td className={cx("num px-2.5 py-1.5 font-semibold", tone(s.netPaise))}>{inr(s.netPaise / 100)}</td>
                      <td className="num px-2.5 py-1.5">{money(s.finalPaise / 100)}</td>
                      <td className="max-w-[22rem] truncate px-2.5 py-1.5 text-micro text-text-2" title={s.note}>{s.note}</td>
                    </tr>
                  ))}
                  {totals ? <tr className="font-semibold"><td className="px-2.5 py-2">All 8</td><td /><td className="num px-2.5">{money(report.strategies.length * 20000)}</td><td className="num px-2.5">{totals.trades}</td><td className="num px-2.5 text-profit">{totals.wins}</td><td className="num px-2.5 text-loss">{totals.losses}</td><td className="num px-2.5">{totals.skipped}</td><td className={cx("num px-2.5", tone(totals.gross))}>{inr(totals.gross)}</td><td className="num px-2.5">{money(totals.charges)}</td><td className={cx("num px-2.5", tone(totals.net))}>{inr(totals.net)}</td><td /><td /></tr> : null}
                </tbody>
              </table>
            </div>
          </Section>
          <Section title="Trades" flush>
            <ul className="divide-y divide-border-soft">{report.trades.map((t, i) => <li key={i} className="num px-3 py-1.5 text-dense">{t.strategy} T{t.tradeNo} · {t.symbol} · {t.quantity} · in {time(t.entryAt)} ₹{t.entry} · out {time(t.exitAt)} ₹{t.exit ?? "—"} · {t.reason ?? "open"} · <span className={tone(t.net)}>{inr(t.net)}</span></li>)}{!report.trades.length ? <li className="px-3 py-3 text-muted">No trades.</li> : null}</ul>
          </Section>
          <div className="grid gap-4 xl:grid-cols-2">
            <Section title="Skipped signals" flush><ul className="divide-y divide-border-soft">{report.skipped.map((s, i) => <li key={i} className="px-3 py-1.5 text-dense">{s.strategy} T{s.tradeNo} {s.option}: {s.reason}</li>)}{!report.skipped.length ? <li className="px-3 py-3 text-muted">None.</li> : null}</ul></Section>
            <Section title="Execution and data problems" flush><ul className="max-h-80 divide-y divide-border-soft overflow-y-auto">{report.problems.map((p, i) => <li key={i} className="px-3 py-1.5 text-micro"><span className="num text-muted">{time(p.at)}</span> {p.strategy ?? "engine"} · {p.kind}: {p.message}</li>)}{!report.problems.length ? <li className="px-3 py-3 text-muted">None.</li> : null}</ul></Section>
          </div>
        </>
      ) : null}
    </div>
  );
}
