"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api } from "@/components/api";
import { Badge, Drawer, Notice, PageHeader, Section, cx } from "@/components/ui";
import type { autoStrategyDetail, autoTradeDetail, AutoTradeView } from "@/server/auto/views";
import { clockOf, inr, money, STATUS_TONE, time, tone, useNow, usePoll } from "./shared";

type Detail = Awaited<ReturnType<typeof autoStrategyDetail>>;
type TradeDetail = Awaited<ReturnType<typeof autoTradeDetail>>;

/** One strategy: overview, live status, every trade (losses included) with its full details, signals and the log. */
export function AutoStrategyPage({ strategyKey }: { strategyKey: string }) {
  const { data, error } = usePoll<Detail>(`/api/auto/strategy?key=${encodeURIComponent(strategyKey)}`, 5_000);
  const [openId, setOpenId] = useState<string | null>(null);
  const now = useNow();
  const [trade, setTrade] = useState<TradeDetail | null>(null);
  const [tradeError, setTradeError] = useState("");
  const show = (id: string) => {
    setOpenId(id);
    setTrade(null);
    setTradeError("");
    api<TradeDetail>(`/api/auto/trade?id=${encodeURIComponent(id)}`).then(setTrade).catch((reason: unknown) => setTradeError(reason instanceof Error ? reason.message : "Could not load the trade."));
  };
  const t = data?.today;
  const o = data?.open;
  return (
    <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 px-4 py-4 sm:px-6">
      <Link href="/automated" className="inline-flex items-center gap-1 text-dense text-muted hover:text-text"><ArrowLeft className="h-4 w-4" aria-hidden />Automated Trading</Link>
      <PageHeader eyebrow="Paper strategy" title={data?.name ?? strategyKey} description={data ? `${data.def.days.join(" · ")} · ${data.def.window} · Exit: ${data.def.exit}` : ""}
        actions={data ? <Badge tone={!data.enabled ? "neutral" : data.paused ? "warning" : "profit"} dot>{!data.enabled ? "Inactive" : data.paused ? "Paused" : "Active"}</Badge> : null} />
      {error ? <Notice tone="loss">{error}</Notice> : null}
      {data?.lastError ? <Notice tone="warning">Last worker error: {data.lastError}</Notice> : null}

      <Section title="Overview" description="Today's wallet, and all live paper trades of this strategy so far.">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-dense sm:grid-cols-4 xl:grid-cols-7">
          <Item label="Today's initial capital" value={money(t?.opening ?? 20000)} />
          <Item label="Available capital" value={money(t?.available ?? 20000)} />
          <Item label="Invested today" value={money(t?.invested ?? 0)} />
          <Item label="Realized today" value={inr(t?.realized)} valueClass={tone(t?.realized)} />
          <Item label="Unrealized" value={inr(t?.unrealized)} valueClass={tone(t?.unrealized)} />
          <Item label="Current balance" value={money(t?.balance ?? 20000)} />
          <Item label="Status" value={<Badge tone={STATUS_TONE[t?.status ?? "WAITING"] ?? "neutral"}>{t?.status ?? "WAITING"}</Badge>} />
          <Item label="Total trades" value={data?.stats.trades ?? 0} />
          <Item label="Winning" value={data?.stats.wins ?? 0} valueClass="text-profit" />
          <Item label="Losing" value={data?.stats.losses ?? 0} valueClass="text-loss" />
          <Item label="Win rate" value={data?.stats.winRate != null ? `${data.stats.winRate}%` : "—"} />
          <Item label="Average per trade" value={inr(data?.stats.average)} valueClass={tone(data?.stats.average)} />
          <Item label="Best trade" value={inr(data?.stats.best)} valueClass={tone(data?.stats.best)} />
          <Item label="Worst trade" value={inr(data?.stats.worst)} valueClass={tone(data?.stats.worst)} />
        </dl>
        <p className="mt-3 text-micro text-muted">Backtest (5 years, not live): {data?.def.backtest.trades} trades, {data?.def.backtest.wins} / {data?.def.backtest.losses} · {data?.def.backtest.source}</p>
        {t?.note ? <p className="mt-1 text-dense text-text-2">{t.note}</p> : null}
      </Section>

      <Section title="Live trading status">
        {o ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-dense sm:grid-cols-4 xl:grid-cols-7">
            <Item label="Option" value={o.symbol} />
            <Item label="CE / PE" value={o.right} />
            <Item label="Entry price" value={money(o.entry)} />
            <Item label="Current price" value={money(o.last)} />
            <Item label="Quantity" value={`${o.quantity} (${o.lots} lot${o.lots > 1 ? "s" : ""})`} />
            <Item label="Investment" value={money(o.invested)} />
            <Item label="Current P&L" value={inr(o.unrealized)} valueClass={tone(o.unrealized)} />
            <Item label="Trail start / target" value={money(o.target)} />
            <Item label="Trailing stop" value={money(o.stop)} />
            <Item label="Entry time" value={time(o.entryAt)} />
            <Item label="Duration" value={`${Math.max(0, Math.round((now - new Date(o.entryAt).getTime()) / 60000))} min`} />
            <Item label="Signal → fill" value={`${(o.latencyMs / 1000).toFixed(1)} s`} />
            <Item label="Status" value={<Badge tone={STATUS_TONE[o.status] ?? "neutral"}>{o.status}</Badge>} />
          </dl>
        ) : <p className="text-dense text-muted">No open position. {t?.note ?? ""}</p>}
      </Section>

      <Section title="Trade history" description="Every paper trade, profit or loss. Select a row for its signal, candles, orders and price marks." flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[80rem] text-dense">
            <thead className="text-left text-micro uppercase tracking-wide text-muted"><tr className="border-b border-border">{["Trade", "Date", "Entry", "Exit", "Option", "Dir", "Entry ₹", "Exit ₹", "Qty", "Investment", "Exit value", "Points", "%", "Gross", "Charges", "Net", "Exit reason", "Result"].map((h) => <th key={h} className="whitespace-nowrap px-2.5 py-2 font-semibold">{h}</th>)}</tr></thead>
            <tbody>
              {(data?.trades ?? []).map((tr) => <TradeRow key={tr.id} tr={tr} onOpen={() => show(tr.id)} />)}
              {data && !data.trades.length ? <tr><td colSpan={18} className="px-3 py-4 text-muted">No paper trades yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Signals" description="Traded, skipped (with the reason) and shadow signals." flush>
          <ul className="max-h-[26rem] divide-y divide-border-soft overflow-y-auto">
            {(data?.signals ?? []).map((s) => (
              <li key={s.id} className="px-3 py-2 text-dense">
                <div className="flex items-center gap-2"><span className="num text-muted">{s.date}</span><Badge tone={s.status === "TRADED" ? "profit" : s.status === "SKIPPED" ? "warning" : "neutral"}>{s.status}</Badge><span className="font-semibold">T{s.tradeNo} {s.right} {s.strike}</span><span className="num text-muted">brk {clockOf(s.breakout)} · conf {clockOf(s.confirm)} · NIFTY {s.nifty}</span></div>
                {s.reason ? <p className="text-micro text-text-2">{s.reason}</p> : null}
              </li>
            ))}
            {data && !data.signals.length ? <li className="px-3 py-3 text-muted">No signals yet.</li> : null}
          </ul>
        </Section>
        <Section title="Execution log" flush>
          <ul className="max-h-[26rem] divide-y divide-border-soft overflow-y-auto">
            {(data?.events ?? []).map((e) => (
              <li key={e.id} className="px-3 py-1.5 text-micro"><span className="num text-muted">{e.date} {time(e.at)}</span> <Badge tone={e.level === "ERROR" ? "loss" : e.level === "WARN" ? "warning" : "neutral"}>{e.kind}</Badge> <span className="text-text-2">{e.message}</span></li>
            ))}
            {data && !data.events.length ? <li className="px-3 py-3 text-muted">Nothing logged yet.</li> : null}
          </ul>
        </Section>
      </div>

      <Drawer label="Trade details" open={openId != null} onClose={() => setOpenId(null)} title={trade ? `${trade.strategy} · trade ${trade.trade.tradeNo}` : "Trade"} subtitle={trade ? `${trade.trade.date} · ${trade.trade.symbol}` : undefined} width="w-[min(44rem,100vw)]">
        {tradeError ? <Notice tone="loss">{tradeError}</Notice> : !trade ? <p className="p-4 text-muted">Loading…</p> : <TradeBody d={trade} />}
      </Drawer>
    </div>
  );
}

function Item({ label, value, valueClass }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return <div className="min-w-0"><dt className="truncate text-micro text-muted">{label}</dt><dd className={cx("num truncate font-semibold", valueClass)}>{value}</dd></div>;
}

function TradeRow({ tr, onOpen }: { tr: AutoTradeView; onOpen: () => void }) {
  return (
    <tr className="cursor-pointer border-b border-border-soft hover:bg-hover" onClick={onOpen}>
      <td className="num px-2.5 py-1.5 text-muted" title={tr.id}>{tr.id.slice(-8)}</td>
      <td className="num px-2.5 py-1.5">{tr.date}</td>
      <td className="num px-2.5 py-1.5">{time(tr.entryAt)}</td>
      <td className="num px-2.5 py-1.5">{time(tr.exitAt)}</td>
      <td className="whitespace-nowrap px-2.5 py-1.5">{tr.strike} {tr.right} · {tr.expiry}</td>
      <td className="px-2.5 py-1.5">{tr.right}</td>
      <td className="num px-2.5 py-1.5">{tr.entry}</td>
      <td className="num px-2.5 py-1.5">{tr.exit ?? "—"}</td>
      <td className="num px-2.5 py-1.5">{tr.quantity}</td>
      <td className="num px-2.5 py-1.5">{money(tr.invested)}</td>
      <td className="num px-2.5 py-1.5">{money(tr.exitValue)}</td>
      <td className={cx("num px-2.5 py-1.5", tone(tr.points))}>{tr.points ?? "—"}</td>
      <td className={cx("num px-2.5 py-1.5", tone(tr.percent))}>{tr.percent != null ? `${tr.percent}%` : "—"}</td>
      <td className={cx("num px-2.5 py-1.5", tone(tr.gross))}>{inr(tr.gross)}</td>
      <td className="num px-2.5 py-1.5">{money((tr.entryCharges ?? 0) + (tr.exitCharges ?? 0))}</td>
      <td className={cx("num px-2.5 py-1.5 font-semibold", tone(tr.net))}>{tr.status === "CLOSED" ? inr(tr.net) : `open ${inr(tr.unrealized)}`}</td>
      <td className="whitespace-nowrap px-2.5 py-1.5">{tr.exitReason?.replace("_", " ").toLowerCase() ?? tr.status}</td>
      <td className="px-2.5 py-1.5">{tr.result ? <Badge tone={tr.result === "PROFIT" ? "profit" : "loss"}>{tr.result}</Badge> : <Badge tone="primary">OPEN</Badge>}</td>
    </tr>
  );
}

function TradeBody({ d }: { d: TradeDetail }) {
  const t = d.trade;
  const detail = (d.signal?.detail ?? {}) as { candles?: Array<{ minute: string; o?: number; h?: number; l?: number; c?: number }>; note?: string; ask?: number; bid?: number; quoteAsOf?: string };
  const model = t.exitModel as { minute?: number; price?: number; reason?: string } | null;
  return (
    <div className="flex flex-col gap-4 p-4 text-dense">
      <section>
        <h3 className="eyebrow mb-1">Why it entered</h3>
        <p>{d.signal ? `${d.signal.side === "CALL" ? "Breakout above" : "Breakout below"} ${d.signal.level} (breakout candle ${clockOf(d.signal.breakoutMinute)}, confirmed ${clockOf(d.signal.confirmMinute)}); NIFTY ${d.signal.nifty}${d.signal.vix != null ? `, VIX ${d.signal.vix}` : ""}. ${detail.note ?? ""}` : "—"}</p>
        {detail.candles?.length ? (
          <table className="mt-2 w-full text-micro"><thead className="text-muted"><tr><th className="text-left">NIFTY candle</th><th>Open</th><th>High</th><th>Low</th><th>Close</th></tr></thead>
            <tbody>{detail.candles.map((c) => <tr key={c.minute} className="num"><td>{c.minute}</td><td className="text-right">{c.o ?? "—"}</td><td className="text-right">{c.h ?? "—"}</td><td className="text-right">{c.l ?? "—"}</td><td className="text-right">{c.c ?? "—"}</td></tr>)}</tbody></table>
        ) : null}
      </section>
      <section>
        <h3 className="eyebrow mb-1">Execution</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
          <Item label="Signal ready" value={time(t.signalAt)} />
          <Item label="Entry fill" value={time(t.entryAt)} />
          <Item label="Signal → fill" value={`${(t.latencyMs / 1000).toFixed(1)} s`} />
          <Item label="Entry (ask + slippage)" value={`₹${t.entry} (bid ${t.entryBid ?? "—"} / ask ${t.entryAsk ?? "—"})`} />
          <Item label="Quantity" value={`${t.quantity} = ${t.lots} × ${t.lotSize}`} />
          <Item label="Investment" value={money(t.invested)} />
          <Item label="Exit decision" value={model?.minute != null ? `${clockOf(model.minute)} model ₹${model.price} (${model.reason})` : "—"} />
          <Item label="Exit fill (bid − slippage)" value={t.exit != null ? `₹${t.exit} (bid ${t.exitBid ?? "—"})` : "—"} />
          <Item label="Exit time" value={time(t.exitAt)} />
          <Item label="Gross" value={inr(t.gross)} valueClass={tone(t.gross)} />
          <Item label="Charges" value={money((t.entryCharges ?? 0) + (t.exitCharges ?? 0))} />
          <Item label="Net" value={inr(t.net)} valueClass={tone(t.net)} />
        </dl>
        {t.notes ? <p className="mt-2 text-micro text-text-2">{t.notes}</p> : null}
      </section>
      <section>
        <h3 className="eyebrow mb-1">Orders</h3>
        <ul className="text-micro">{d.orders.map((o) => <li key={o.id} className="num">{time(o.filledAt ?? o.requestedAt)} · {o.side} {o.quantity} @ ₹{o.price ?? "—"} · bid {o.bid ?? "—"} / ask {o.ask ?? "—"} · charges ₹{o.charges ?? "—"} · {o.status}{o.reason ? ` · ${o.reason}` : ""}</li>)}</ul>
      </section>
      <section>
        <h3 className="eyebrow mb-1">Price marks ({d.snapshots.length})</h3>
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full text-micro"><thead className="text-muted"><tr><th className="text-left">Time</th><th>Bid</th><th>Ask</th><th>Mark</th><th>Stop</th><th>Unrealized</th></tr></thead>
            <tbody>{d.snapshots.slice(-200).map((s, i) => <tr key={i} className="num"><td>{time(s.at)}</td><td className="text-right">{s.bid ?? "—"}</td><td className="text-right">{s.ask ?? "—"}</td><td className="text-right">{s.last ?? "—"}</td><td className="text-right">{s.stop ?? "—"}</td><td className={cx("text-right", tone(s.unrealized))}>{inr(s.unrealized)}</td></tr>)}</tbody></table>
        </div>
      </section>
    </div>
  );
}
