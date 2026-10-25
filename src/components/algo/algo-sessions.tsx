"use client";

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";
import { Drawer } from "@/components/ui/drawer";
import { AlgoAccountFigures, type AlgoAccount } from "@/components/algo/algo-account";
import { money, rupeesOf, toneOf } from "@/components/algo/live-value";
import type { AlgoTrade, RunStats, SkippedSignal } from "@/lib/algo/chart-replay";

type ArchivedSession = {
  id: string;
  sessionId: string;
  underlying: string;
  date: string;
  status: string;
  endReason: string;
  startedAt: string;
  endedAt: string | null;
  startCapital: number;
  endCash: number | null;
  account: (AlgoAccount & { netPnl?: string }) | null;
  stats: RunStats;
  trades: AlgoTrade[];
  rejected: SkippedSignal[];
};

const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) : "—");
const ist = (seconds: number | null | undefined) => (seconds ? new Date((seconds + 19_800) * 1000).toISOString().slice(11, 16) : "—");
const inr = (value: number | null | undefined, signed = false) => (value == null || !Number.isFinite(value) ? "—" : money(value, signed));
const STATUS: Record<string, string> = { ARCHIVED: "Archived", ARCHIVED_UNRESOLVED: "Archived · open position unresolved", RUNNING: "In progress" };

/** The session's total P&L: from its archived account figures, else its realized trades. */
function totalOf(session: ArchivedSession) {
  return rupeesOf(session.account?.netPnl) ?? session.stats.realized;
}

/**
 * Home → Algo History: one row per Algo replay session (archived when the replay was exited). Opening one
 * shows its saved summary, trades and rejected signals. Read-only: nothing here touches the active replay.
 */
export function AlgoSessionsCard({ className }: { className?: string }) {
  const [sessions, setSessions] = useState<ArchivedSession[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<ArchivedSession | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api<{ sessions: ArchivedSession[] }>("/api/algo?history=1")
      .then((data) => { if (live) { setSessions(data.sessions); setError(""); } })
      .catch((caught: unknown) => { if (live) setError(caught instanceof Error ? caught.message : "Algo history is unavailable."); });
    load();
    window.addEventListener("td-ledger", load);
    return () => { live = false; window.removeEventListener("td-ledger", load); };
  }, []);
  if (!sessions && !error) return null;
  const list = sessions ?? [];
  return (
    <section className={cx("rounded-card border border-border bg-panel p-3", className)} aria-label="Algo History">
      <div className="mb-2 flex items-center gap-2">
        <History className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-dense font-semibold">Algo History</h2>
        <span className="ml-auto text-micro text-muted">Replay sessions · simulated</span>
      </div>
      {error ? <p className="text-data text-loss">{error}</p> : null}
      {!error && !list.length ? <p className="text-data text-muted">No Algo replay sessions yet. They are saved here when you exit a replay.</p> : null}
      {list.length ? (
        <ol className="divide-y divide-border-soft">
          {list.slice(0, 12).map((session) => {
            const total = totalOf(session);
            const trades = session.trades.length;
            return (
              <li key={session.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-data">
                <span className="min-w-0">
                  <span className="block font-semibold">{session.underlying} · replay {session.date}</span>
                  <span className="block text-micro text-muted">{when(session.startedAt)} → {when(session.endedAt)} · {STATUS[session.status] ?? session.status}</span>
                </span>
                <span className="ml-auto text-right">
                  <span className={cx("num block text-base font-semibold", toneOf(total))}>{inr(total, true)}</span>
                  <span className="block text-micro text-muted">{trades} trade{trades === 1 ? "" : "s"} · W {session.stats.wins} / L {session.stats.losses}</span>
                </span>
                <button type="button" className="h-8 rounded-md border border-border px-2.5 text-data font-medium hover:bg-hover" onClick={() => setOpen(session)}>View details</button>
              </li>
            );
          })}
        </ol>
      ) : null}
      {open ? <SessionDetail session={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function SessionDetail({ session, onClose }: { session: ArchivedSession; onClose: () => void }) {
  const total = totalOf(session);
  return (
    <Drawer open modal onClose={onClose} label="Algo session details" title={`${session.underlying} · replay ${session.date}`} subtitle={`${when(session.startedAt)} → ${when(session.endedAt)} · ${STATUS[session.status] ?? session.status} · read-only`} width="w-[40rem]">
      <div className="space-y-4">
        <section className="rounded-xl bg-elevated p-4">
          <p className="text-micro font-medium uppercase tracking-wide text-muted">Session P&amp;L</p>
          <p className={cx("num text-[2rem] font-semibold leading-tight", toneOf(total))}>{inr(total, true)}</p>
          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Pair label="Starting capital" value={inr(session.startCapital)} />
            <Pair label="Realized" value={inr(session.stats.realized, true)} />
            <Pair label="Trades (W/L)" value={`${session.trades.length} (${session.stats.wins}/${session.stats.losses})`} />
            <Pair label="Max drawdown" value={inr(session.stats.maxDrawdown)} />
            <Pair label="Signals" value={String(session.stats.signals)} />
            <Pair label="Rejected / skipped" value={String(session.rejected.length)} />
            <Pair label="End cash" value={inr(session.endCash)} />
            <Pair label="Session id" value={session.sessionId.slice(11)} />
          </dl>
        </section>
        {session.account ? (
          <section>
            <p className="eyebrow mb-1">Account at the end of the session</p>
            <AlgoAccountFigures account={session.account} />
          </section>
        ) : null}
        <section>
          <p className="eyebrow mb-1">Trades</p>
          {session.trades.length ? (
            <div className="overflow-x-auto rounded-md border border-border-soft">
              <table className="w-full min-w-[36rem] text-data">
                <thead className="bg-sunken text-left text-micro text-muted"><tr><th className="px-2 py-1">#</th><th className="px-2 py-1">Side</th><th className="px-2 py-1">Option</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">Entry</th><th className="px-2 py-1 text-right">Exit</th><th className="px-2 py-1">Reason</th><th className="px-2 py-1 text-right">P&amp;L</th></tr></thead>
                <tbody>
                  {session.trades.map((trade) => (
                    <tr key={trade.entryKey} className="border-t border-border-soft">
                      <td className="px-2 py-1">{trade.number}</td>
                      <td className={cx("px-2 py-1 font-semibold", trade.side === "CALL" ? "text-profit" : "text-loss")}>{trade.side}</td>
                      <td className="px-2 py-1">{trade.underlying} {trade.strike} {trade.right} · {trade.expiry}</td>
                      <td className="num px-2 py-1 text-right">{trade.quantity}</td>
                      <td className="num px-2 py-1 text-right">{ist(trade.entryTime)} {inr(trade.entryPremium)}</td>
                      <td className="num px-2 py-1 text-right">{trade.exitTime ? `${ist(trade.exitTime)} ${inr(trade.exitPremium)}` : "Open"}</td>
                      <td className="px-2 py-1">{trade.exitReason ?? (trade.status === "COMPLETED" ? "—" : "Unresolved")}</td>
                      <td className={cx("num px-2 py-1 text-right font-semibold", toneOf(trade.realized))}>{inr(trade.realized, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-data text-muted">No trades in this session.</p>}
        </section>
        {session.rejected.length ? (
          <section>
            <p className="eyebrow mb-1">Rejected / skipped signals</p>
            <ol className="space-y-1">
              {session.rejected.slice(0, 30).map((row) => (
                <li key={row.id} className="text-data"><span className="num text-muted">{ist(row.time)}</span> <span className="font-semibold">{row.side ? `BUY ${row.side}` : "No entry"}</span> <span className="text-loss">{row.reason}</span></li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    </Drawer>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-micro text-muted">{label}</dt><dd className="num truncate font-medium">{value}</dd></div>;
}
