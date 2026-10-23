"use client";

import { useMemo, useState } from "react";
import { ClipboardList, Layers } from "lucide-react";
import { istStamp } from "@/components/api";
import { contractLabel, expiryLabel, FIELD, inr, LABEL, LEG_LABEL, OVERALL_TONE, pnl, pnlTone } from "@/components/multi-account/format";
import { LegChip, OVERALL_SHORT } from "@/components/multi-account/status";
import { Button, cx, Drawer, EmptyState, Notice, Table, TONE_TEXT, type Column } from "@/components/ui";
import { kolkataParts } from "@/lib/market/clock";
import type { DemoDoc, DemoPosition, Leg, LegStatus, OrderRequest } from "@/lib/multi-account/engine";

type OrderRow = { request: OrderRequest; leg: Leg };

export function OrdersTable({ doc, busy, onReconcile, onCancel }: { doc: DemoDoc; busy: string | null; onReconcile: (requestId: string) => void; onCancel: (requestId: string) => void }) {
  const [account, setAccount] = useState("");
  const [date, setDate] = useState("");
  const [instrument, setInstrument] = useState("");
  const [side, setSide] = useState("");
  const [status, setStatus] = useState("");
  const rows = useMemo(() => doc.requests.flatMap((request) => request.legs.map((leg) => ({ request, leg }))), [doc.requests]);
  const open = (row: OrderRow) => row.leg.status === "PENDING" || row.leg.status === "UNKNOWN";
  const instruments = useMemo(() => [...new Set(doc.requests.map((request) => request.contract.underlying))].sort(), [doc.requests]);
  const shown = rows.filter(({ request, leg }) =>
    (!account || leg.accountId === account)
    && (!date || kolkataParts(new Date(request.createdAt)).dateKey === date)
    && (!instrument || request.contract.underlying === instrument)
    && (!side || request.side === side)
    && (!status || leg.status === status));
  const columns: Column<OrderRow>[] = [
    { key: "time", header: "Time", render: ({ request }) => <span className="whitespace-nowrap text-muted">{istStamp(request.createdAt)}</span> },
    { key: "account", header: "Account", render: ({ leg }) => <span className="whitespace-nowrap">{leg.nickname}</span> },
    { key: "instrument", header: "Instrument", render: ({ request }) => <span className="whitespace-nowrap font-medium">{request.contract.underlying}{request.closing ? <span className="ml-1 text-muted">· close</span> : null}</span> },
    { key: "contract", header: "Expiry / strike", render: ({ request }) => <span className="num whitespace-nowrap">{expiryLabel(request.contract.expiry)} · {request.contract.strike}</span> },
    { key: "right", header: "CE/PE", render: ({ request }) => request.contract.right },
    { key: "side", header: "Side", render: ({ request }) => <span className={request.side === "BUY" ? "text-profit" : "text-loss"}>{request.side}</span> },
    { key: "qty", header: "Req qty", numeric: true, render: ({ leg }) => leg.quantity },
    { key: "filled", header: "Filled", numeric: true, render: ({ leg }) => leg.filledQuantity },
    { key: "avg", header: "Avg price", numeric: true, render: ({ leg }) => inr(leg.avgPaise) },
    { key: "status", header: "Status", render: ({ request, leg }) => <span className="flex flex-col items-start gap-1"><LegChip status={leg.status} /><span className="text-micro text-muted">Request: <span className={TONE_TEXT[OVERALL_TONE[request.status]]}>{OVERALL_SHORT[request.status]}</span></span></span> },
    { key: "reason", header: "Reason", render: ({ leg }) => <span className="block max-w-[16.25rem] text-data text-muted">{leg.reason}</span> },
    { key: "ref", header: "Reference", render: ({ leg }) => <span className="num whitespace-nowrap text-muted">{leg.ref}</span> },
    { key: "pnl", header: "Realised P&L", numeric: true, render: ({ leg }) => <span className={TONE_TEXT[pnlTone(leg.realizedPaise)]}>{leg.realizedPaise == null ? "—" : pnl(leg.realizedPaise)}</span> },
    { key: "actions", header: <span className="sr-only">Actions</span>, align: "right", render: (row) => open(row) ? (
      <span className="flex justify-end gap-1">
        <Button size="sm" variant="secondary" loading={busy === `reconcile:${row.request.id}`} onClick={() => onReconcile(row.request.id)} aria-label={`Reconcile ${row.leg.nickname} order`}>Reconcile</Button>
        {row.leg.status === "PENDING" ? <Button size="sm" variant="ghost" loading={busy === `cancel:${row.request.id}`} onClick={() => onCancel(row.request.id)} aria-label={`Cancel pending order for ${row.leg.nickname}`}>Cancel</Button> : null}
      </span>
    ) : null },
  ];
  const statusCounts = rows.reduce<Partial<Record<LegStatus, number>>>((counts, { leg }) => ({ ...counts, [leg.status]: (counts[leg.status] ?? 0) + 1 }), {});
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick status filter">
        <button type="button" aria-pressed={status === ""} onClick={() => setStatus("")} className={cx("h-7 rounded-pill border px-3 text-data font-medium transition-colors", status === "" ? "border-primary/40 bg-primary-soft text-primary" : "border-border-soft text-text-2 hover:bg-hover")}>All <span className="num">{rows.length}</span></button>
        {(Object.keys(LEG_LABEL) as LegStatus[]).filter((item) => statusCounts[item]).map((item) => (
          <button key={item} type="button" aria-pressed={status === item} onClick={() => setStatus(status === item ? "" : item)} className={cx("h-7 rounded-pill border px-3 text-data font-medium transition-colors", status === item ? "border-primary/40 bg-primary-soft text-primary" : "border-border-soft text-text-2 hover:bg-hover")}>
            {LEG_LABEL[item]} <span className="num">{statusCounts[item]}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <label className={LABEL}>Account
          <select className={FIELD} value={account} onChange={(event) => setAccount(event.target.value)}>
            <option value="">All accounts</option>
            {doc.accounts.map((item) => <option key={item.id} value={item.id}>{item.nickname}</option>)}
          </select>
        </label>
        <label className={LABEL}>Date
          <input type="date" className={FIELD} value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        <label className={LABEL}>Instrument
          <select className={FIELD} value={instrument} onChange={(event) => setInstrument(event.target.value)}>
            <option value="">All</option>
            {instruments.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className={LABEL}>Side
          <select className={FIELD} value={side} onChange={(event) => setSide(event.target.value)}>
            <option value="">Both</option><option value="BUY">Buy</option><option value="SELL">Sell</option>
          </select>
        </label>
        <label className={LABEL}>Status
          <select className={FIELD} value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All</option>
            {(Object.keys(LEG_LABEL) as LegStatus[]).map((item) => <option key={item} value={item}>{LEG_LABEL[item]}</option>)}
          </select>
        </label>
      </div>
      <Table
        label="Multi-account orders"
        dense
        className="max-h-[35rem] rounded-md border border-border-soft"
        columns={columns}
        rows={shown}
        rowKey={({ leg }) => leg.id}
        empty={<EmptyState icon={<ClipboardList />} title={rows.length === 0 ? "No demo orders yet" : "No orders match these filters"} body={rows.length === 0 ? "Requests placed from the order panel appear here with one row per account." : "Clear a filter to see more."} />}
      />
    </div>
  );
}

type PositionRow = DemoPosition & { nickname: string; mark: number | null; unrealized: number | null };

export function PositionsView({ doc, marks, busy, onClose }: { doc: DemoDoc; marks: Record<string, number | null>; busy: boolean; onClose: (picks: Array<{ accountId: string; symbol: string }>) => Promise<boolean> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const rows: PositionRow[] = doc.positions.filter((position) => position.quantity > 0).map((position) => {
    const mark = marks[position.symbol] ?? null;
    return { ...position, nickname: doc.accounts.find((account) => account.id === position.accountId)?.nickname ?? position.accountId, mark, unrealized: mark == null ? null : (mark - position.avgCostPaise) * position.quantity };
  });
  const rowId = (row: Pick<DemoPosition, "accountId" | "symbol">) => `${row.accountId}|${row.symbol}`;
  const live = picked.filter((id) => rows.some((row) => rowId(row) === id));
  const chosen = rows.filter((row) => live.includes(rowId(row)));
  const toggle = (id: string) => setPicked(live.includes(id) ? live.filter((item) => item !== id) : [...live, id]);
  const combined = [...rows.reduce((map, row) => {
    const entry = map.get(row.symbol) ?? { symbol: row.symbol, contract: row.contract, quantity: 0, cost: 0, accounts: 0, mark: row.mark, unrealized: 0 as number | null };
    entry.quantity += row.quantity;
    entry.cost += row.avgCostPaise * row.quantity;
    entry.accounts += 1;
    entry.unrealized = entry.unrealized == null || row.unrealized == null ? null : entry.unrealized + row.unrealized;
    map.set(row.symbol, entry);
    return map;
  }, new Map<string, { symbol: string; contract: DemoPosition["contract"]; quantity: number; cost: number; accounts: number; mark: number | null; unrealized: number | null }>()).values()];

  if (rows.length === 0) return <EmptyState icon={<Layers />} title="No open demo positions" body="Filled demo buys appear here per account, with a combined view across accounts." />;

  const perAccount: Column<PositionRow>[] = [
    { key: "pick", header: <span className="sr-only">Select</span>, width: "32px", render: (row) => <input type="checkbox" aria-label={`Select ${row.nickname} ${contractLabel(row.contract)}`} checked={live.includes(rowId(row))} onChange={() => toggle(rowId(row))} /> },
    { key: "account", header: "Account", render: (row) => row.nickname },
    { key: "contract", header: "Contract", render: (row) => <span className="whitespace-nowrap font-medium">{contractLabel(row.contract)}</span> },
    { key: "expiry", header: "Expiry", render: (row) => <span className="whitespace-nowrap">{expiryLabel(row.contract.expiry)}</span> },
    { key: "qty", header: "Qty", numeric: true, render: (row) => row.quantity },
    { key: "lots", header: "Lots", numeric: true, render: (row) => Math.round(row.quantity / row.lotSize) },
    { key: "avg", header: "Avg cost", numeric: true, render: (row) => inr(row.avgCostPaise) },
    { key: "mark", header: "Current", numeric: true, render: (row) => (row.mark == null ? <span className="text-muted">Unavailable</span> : inr(row.mark)) },
    { key: "pnl", header: "Unrealised", numeric: true, render: (row) => <span className={TONE_TEXT[pnlTone(row.unrealized)]}>{pnl(row.unrealized)}</span> },
  ];
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className={cx("flex flex-wrap items-center gap-2 rounded-input border px-3 py-1.5 transition-colors", chosen.length ? "border-loss/30 bg-loss-soft/40" : "border-border-soft bg-sunken")} role="status" aria-live="polite">
        <p className="flex-1 text-data text-text-2">
          {chosen.length ? <><span className="num font-semibold text-text">{chosen.length}</span> selected · </> : null}
          {rows.length} open {rows.length === 1 ? "position" : "positions"} across {new Set(rows.map((row) => row.accountId)).size} {new Set(rows.map((row) => row.accountId)).size === 1 ? "account" : "accounts"}
        </p>
        <Button size="sm" variant="ghost" onClick={() => setPicked(rows.map(rowId))} disabled={chosen.length === rows.length}>Select all</Button>
        {chosen.length ? <Button size="sm" variant="ghost" onClick={() => setPicked([])}>Clear</Button> : null}
        <Button size="sm" variant="danger" disabled={chosen.length === 0} onClick={() => setConfirming(true)}>Close selected ({chosen.length})</Button>
      </div>
      <h3 className="text-dense font-semibold text-text">Per account</h3>
      <Table label="Positions per account" dense className="max-h-[27.5rem] rounded-md border border-border-soft" columns={perAccount} rows={rows} rowKey={rowId} />
      <div>
        <h3 className="mb-2 text-dense font-semibold text-text">Combined across accounts <span className="font-normal text-muted">· same contract only, read-only</span></h3>
        <Table
          label="Combined positions"
          dense
          className="rounded-md border border-border-soft"
          rows={combined}
          rowKey={(row) => row.symbol}
          columns={[
            { key: "contract", header: "Contract", render: (row) => <span className="font-medium">{contractLabel(row.contract)} · {expiryLabel(row.contract.expiry)}</span> },
            { key: "accounts", header: "Accounts", numeric: true, render: (row) => row.accounts },
            { key: "qty", header: "Total qty", numeric: true, render: (row) => row.quantity },
            { key: "avg", header: "Avg cost", numeric: true, render: (row) => inr(Math.round(row.cost / row.quantity)) },
            { key: "mark", header: "Current", numeric: true, render: (row) => (row.mark == null ? <span className="text-muted">Unavailable</span> : inr(row.mark)) },
            { key: "pnl", header: "Unrealised", numeric: true, render: (row) => <span className={TONE_TEXT[pnlTone(row.unrealized)]}>{pnl(row.unrealized)}</span> },
          ]}
        />
      </div>
      <Drawer
        open={confirming}
        onClose={() => { if (!busy) setConfirming(false); }}
        modal
        label="Confirm closing positions"
        title="Close demo positions"
        subtitle={`${chosen.length} ${chosen.length === 1 ? "position" : "positions"} · market sell at the current premium`}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>Keep open</Button>
            <Button className="flex-1" variant="sell" loading={busy} onClick={() => void onClose(chosen.map((row) => ({ accountId: row.accountId, symbol: row.symbol }))).then((done) => { if (done) { setConfirming(false); setPicked([]); } })}>Close {chosen.length} {chosen.length === 1 ? "position" : "positions"}</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Notice tone="warning">Each position is sold in full for its own account. Closing is allowed even while the emergency stop is on. Positions without a current price are not closed.</Notice>
          <ul className="flex flex-col gap-1 text-data">
            {chosen.map((row) => (
              <li key={rowId(row)} className="flex gap-2 border-b border-border-soft py-1.5">
                <span className="flex-1">{row.nickname} · {contractLabel(row.contract)}</span>
                <span className="num">{row.quantity}</span>
                <span className={cx("num w-24 text-right", TONE_TEXT[pnlTone(row.unrealized)])}>{pnl(row.unrealized)}</span>
              </li>
            ))}
          </ul>
        </div>
      </Drawer>
    </div>
  );
}
