"use client";

import { useHydrated } from "@/components/use-hydrated";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Landmark, Lock, PieChart, Receipt, Wallet } from "lucide-react";
import { api, istStamp, istTime, money, type Instrument, type Quote } from "@/components/api";
import { parseOptionLedgerSymbol } from "@/lib/options/contract";
import { OptionChainBoard } from "@/components/option-chain";
import { useDesk } from "@/components/shell";
import { OrderStatus, StockLogo } from "@/components/stock-identity";
import { Badge, Button, EmptyState, Notice, PageHeader, Section, Skeleton, StatCard, Table, type Column } from "@/components/ui";
import { signOf } from "@/lib/format";

type Portfolio = {
  simulated?: boolean;
  startingCapital?: string;
  allocatedCapital?: string;
  netPnl?: string;
  performanceReturn?: string;
  completedTrades?: number;
  winningTrades?: number;
  losingTrades?: number;
  winRate?: string;
  averageWin?: string;
  averageLoss?: string;
  largestWin?: string;
  largestLoss?: string;
  maxDrawdown?: string;
  equityCurve?: Array<{ at: string; equity: string; realized: string; unrealized: string }>;
  cashAvailable: string;
  cashReserved: string;
  holdingsValue: string;
  equity: string;
  realized: string;
  unrealized: string;
  charges: string;
  valuationMessage: string;
  stale: boolean;
  positions: Array<{ symbol: string; name: string; quantity: number; lotSize?: number | null; lots?: number | null; contract?: { underlying: string; expiry: string; strike: number; right: "CE" | "PE" } | null; averageCost: string; mark: string | null; marketValue: string | null; unrealized: string | null; realized: string; mode?: string; status?: string; openedAt?: string | null; updatedAt?: string | null }>;
  allocation?: Array<{ label: string; percent: string }>;
};
type Activity = {
  orders: Array<{ id: string; symbol: string; side: string; type: string; quantity: number; filledQuantity: number; status: string; limit: string | null; stop?: string | null; avgFill: string | null; charges: string; reason: string | null; submittedAt: string }>;
  executions: Array<{ id: string; symbol: string; side: string; quantity: number; price: string; charges: string; realized: string; mode: string; source?: string; executedAt: string }>;
};
type Chain = { side: string; strike: number; expiry: string; ltp: number | null; bid: number | null; ask: number | null; volume: number | null; oi: number | null; iv: number | null };
type OptionsDesk = {
  simulated: boolean;
  message: string;
  indexSource: string;
  premiumSource: string;
  asOf: string;
  stale: boolean;
  spot: number;
  lotSize: number;
  lotSizeNote: string;
  chain: Chain[];
  cash: string;
  equity: string;
  position: { contractKey: string; right: string; strike: number; expiry: string; quantity: number; average: string; mark: string; simulated: boolean } | null;
  risk: { ok: boolean; reasons: string[] };
};

export function MarketsScreen() {
  const desk = useDesk();
  const [rows, setRows] = useState<Instrument[]>([]);
  const [sector, setSector] = useState("All");
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [error, setError] = useState("");
  // Recently opened symbols live in this browser; read once the page has hydrated.
  const hydrated = useHydrated();
  const recent = useMemo(() => (hydrated ? readRecent() : []), [hydrated]);
  useEffect(() => {
    api<Instrument[]>("/api/instruments").then(setRows).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load instruments."));
  }, []);
  useEffect(() => {
    const symbols = rows.slice(0, 40).map((row) => row.symbol);
    if (!symbols.length) return;
    api<{ quotes: Array<Quote | { symbol: string; error: string }> }>(`/api/market/quotes?symbols=${symbols.join(",")}`)
      .then((data) => {
        const next: Record<string, Quote> = {};
        for (const row of data.quotes) if ("last" in row) next[row.symbol] = row;
        setQuotes(next);
      })
      .catch(() => undefined);
  }, [rows]);
  const sectors = ["All", ...new Set(rows.map((row) => row.sector))];
  const visible = rows.filter((row) => sector === "All" || row.sector === sector);
  return (
    <Page>
      <PageHeader eyebrow="NSE" title="Markets" description="NSE equities and indices. Prices load for the first 40 instruments in the catalogue." />
      {error ? <Notice tone="loss">{error}</Notice> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <span className="eyebrow shrink-0">Recently viewed</span>
        <div className="flex flex-wrap gap-1.5">
          {recent.length === 0 ? <span className="text-data text-muted">Open a chart and it appears here.</span> : recent.map((symbol) => (
            <button key={symbol} className="inline-flex h-8 items-center gap-2 rounded-pill border border-border-soft bg-panel pl-1 pr-3 text-data font-semibold text-text shadow-e1 transition-colors hover:border-border hover:bg-hover" onClick={() => desk.chooseSymbol(symbol)}>
              <StockLogo symbol={symbol} size={22} />{symbol}
            </button>
          ))}
        </div>
      </div>
      <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1" role="tablist" aria-label="Sector">
        {sectors.map((item) => <Chip key={item} active={sector === item} onClick={() => setSector(item)}>{item}</Chip>)}
      </div>
      <div className="data-table">
        <table>
          <thead><tr><th>Instrument</th><th className="hidden md:table-cell">Exchange</th><th className="hidden sm:table-cell">Sector</th><th className="num">LTP</th><th className="text-right"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {rows.length === 0 && !error ? [0, 1, 2, 3, 4].map((row) => <tr key={row}><td colSpan={5}><Skeleton className="h-6 w-full" /></td></tr>) : null}
            {visible.slice(0, 80).map((row) => (
              <tr key={row.symbol}>
                <td>
                  <span className="flex items-center gap-3">
                    <StockLogo symbol={row.symbol} name={row.name} size={28} />
                    <span className="min-w-0"><span className="block font-semibold text-text">{row.symbol}</span><span className="block truncate text-micro text-muted">{row.name}</span></span>
                  </span>
                </td>
                <td className="hidden text-text-2 md:table-cell">{row.exchange}</td>
                <td className="hidden text-muted sm:table-cell">{row.sector}</td>
                <td className="num font-medium text-text">{quotes[row.symbol] ? money(quotes[row.symbol].last) : "—"}</td>
                <td className="whitespace-nowrap text-right">
                  <span className="inline-flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => desk.chooseSymbol(row.symbol)}>Chart</Button>
                    <Link className="inline-flex h-7 items-center rounded-sm px-2.5 text-data font-semibold text-primary transition-colors hover:bg-primary-soft" href={`/options?symbol=${encodeURIComponent(row.symbol)}`}>Chain</Link>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-auto">
      <div className={`mx-auto flex flex-col gap-5 p-3 sm:p-4 lg:p-6 ${wide ? "max-w-[1600px]" : "max-w-6xl"}`}>{children}</div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`h-8 shrink-0 rounded-pill border px-3 text-data font-medium transition-colors ${active ? "border-primary/30 bg-primary-soft text-primary" : "border-border-soft bg-panel text-text-2 hover:border-border hover:text-text"}`}>
      {children}
    </button>
  );
}

type OrderRow = Activity["orders"][number];
type FillRow = Activity["executions"][number];
const ORDER_FILTERS = [
  { id: "ALL", label: "All" },
  { id: "FILLED", label: "Filled" },
  { id: "OPEN", label: "Open" },
  { id: "PARTIALLY_FILLED", label: "Partial" },
  { id: "REJECTED", label: "Rejected" },
  { id: "CANCELLED", label: "Cancelled" },
] as const;

function contractName(symbol: string) {
  const option = parseOptionLedgerSymbol(symbol);
  return option ? { title: `${option.underlying} ${option.strike} ${option.right}`, sub: option.expiry, logo: option.underlying } : { title: symbol, sub: "", logo: symbol };
}

function pnlTone(value: string | null | undefined) {
  if (!value || value === "—") return "text-muted";
  const number = Number(value.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(number) || number === 0) return "text-text";
  return value.trim().startsWith("-") || value.trim().startsWith("−") ? "text-loss" : "text-profit";
}

export function OrdersScreen() {
  const desk = useDesk();
  const [book, setBook] = useState<Activity | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<string>("ALL");
  const [refreshing, setRefreshing] = useState(false);
  const load = () => api<Activity>("/api/orders")
    .then((data) => { setBook(data); setError(""); })
    .catch((caught) => setError(caught instanceof Error ? caught.message : "Orders could not be loaded."));
  const refresh = () => { setRefreshing(true); void load().finally(() => setRefreshing(false)); };
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 8000); return () => window.clearInterval(timer); }, []);
  const orders = (book?.orders ?? []).filter((order) => filter === "ALL" || order.status === filter);
  const counts = (book?.orders ?? []).reduce<Record<string, number>>((all, order) => ({ ...all, [order.status]: (all[order.status] ?? 0) + 1 }), {});

  const symbolCell = (symbol: string) => {
    const name = contractName(symbol);
    return (
      <button type="button" className="inline-flex items-center gap-2 text-left font-medium text-text hover:text-primary" onClick={() => desk.chooseSymbol(symbol)}>
        <StockLogo symbol={name.logo} size={20} />
        <span>{name.title}{name.sub ? <span className="ml-1.5 text-[11px] font-normal text-muted">{name.sub}</span> : null}</span>
      </button>
    );
  };
  const side = (value: string) => <span className={value === "BUY" ? "font-semibold text-profit" : "font-semibold text-loss"}>{value}</span>;

  const orderColumns: Column<OrderRow>[] = [
    { key: "time", header: "Time", render: (row) => <span className="num text-text-2">{istTime(row.submittedAt)}</span> },
    { key: "symbol", header: "Instrument", render: (row) => symbolCell(row.symbol) },
    { key: "side", header: "Side", render: (row) => side(row.side) },
    { key: "type", header: "Type", render: (row) => <span className="text-text-2">{row.type}</span> },
    { key: "qty", header: "Qty", numeric: true, render: (row) => row.quantity.toLocaleString("en-IN") },
    { key: "filled", header: "Filled", numeric: true, render: (row) => row.filledQuantity.toLocaleString("en-IN") },
    { key: "avg", header: "Avg price", numeric: true, render: (row) => row.avgFill ?? "—" },
    { key: "charges", header: "Charges", numeric: true, render: (row) => <span className="text-text-2">{row.charges}</span> },
    { key: "status", header: "Status", align: "right", render: (row) => <span title={row.reason ?? undefined}><OrderStatus status={row.status} /></span> },
  ];
  const fillColumns: Column<FillRow>[] = [
    { key: "time", header: "Time", render: (row) => <span className="num text-text-2">{istTime(row.executedAt)}</span> },
    { key: "symbol", header: "Instrument", render: (row) => symbolCell(row.symbol) },
    { key: "side", header: "Side", render: (row) => side(row.side) },
    { key: "qty", header: "Qty", numeric: true, render: (row) => row.quantity.toLocaleString("en-IN") },
    { key: "price", header: "Price", numeric: true, render: (row) => row.price },
    { key: "charges", header: "Charges", numeric: true, render: (row) => <span className="text-text-2">{row.charges}</span> },
    { key: "realized", header: "Realized P&L", numeric: true, render: (row) => <span className={`font-semibold ${pnlTone(row.realized)}`}>{row.realized}</span> },
    { key: "mode", header: "Price source", align: "right", render: (row) => <span className="text-[11px] text-muted">{row.mode === "DELAYED" ? "Snapshot" : row.mode === "REALTIME" ? "Live" : row.mode}</span> },
  ];

  return (
    <Page>
        <PageHeader
          eyebrow={<><Badge tone="demo">Demo</Badge> Practice ledger</>}
          title="Orders"
          description="Nothing here is a broker order. Open orders refresh every 8 seconds."
          actions={<Button size="sm" loading={refreshing} onClick={refresh}>Refresh</Button>}
        />
        {desk.mode === "live" ? <Notice tone="warning">Live view does not list or change broker orders. Open Money for the read-only broker snapshot.</Notice> : null}
        {error ? <Notice tone="loss">{error}</Notice> : null}

        <section className="surface overflow-hidden">
          <div className="no-scrollbar flex items-center gap-1 overflow-x-auto border-b border-border-soft px-2" role="tablist" aria-label="Order status">
            {ORDER_FILTERS.map((item) => {
              const count = item.id === "ALL" ? book?.orders.length ?? 0 : counts[item.id] ?? 0;
              return (
                <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} className={`relative h-11 shrink-0 px-3 text-dense font-medium transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary after:transition-transform after:duration-200 ${filter === item.id ? "text-text after:scale-x-100" : "text-muted after:scale-x-0 hover:text-text"}`} onClick={() => setFilter(item.id)}>
                  {item.label}<span className={`num ml-1.5 rounded-sm px-1.5 text-micro ${filter === item.id ? "bg-primary-soft text-primary" : "bg-sunken text-muted"}`}>{count}</span>
                </button>
              );
            })}
          </div>
          {!book && !error ? (
            <div className="space-y-2 p-4" aria-label="Loading orders">{[0, 1, 2].map((row) => <Skeleton key={row} className="h-7 w-full" />)}</div>
          ) : (
            <Table
              label="Orders"
              columns={orderColumns}
              rows={orders}
              rowKey={(row) => row.id}
              className="max-h-[50vh]"
              rowActions={(row) => row.status === "OPEN" ? (
                <Button size="sm" variant="danger" onClick={() => { if (window.confirm("Cancel this practice order?")) void api(`/api/orders/${row.id}/cancel`, {}).then(() => load()).catch((caught) => desk.toast(caught instanceof Error ? caught.message : "Cancel failed.")); }}>Cancel</Button>
              ) : null}
              empty={<EmptyState icon={<Receipt className="h-5 w-5" />} title={filter === "ALL" ? "No orders yet" : "No orders in this view"} body="Buy an option from the chain and the order appears here with its fill price." />}
            />
          )}
        </section>

        <Section title="Trade book" description="Every fill with its charges and realized P&L." flush>
          <Table
            label="Trade book"
            columns={fillColumns}
            rows={book?.executions ?? []}
            rowKey={(row) => row.id}
            className="max-h-[50vh]"
            empty={<EmptyState icon={<Receipt className="h-5 w-5" />} title="No fills yet" body="Every fill, its charges and realized P&L are listed here." />}
          />
        </Section>
        <p className="text-micro text-muted">Changing an order means cancelling it and placing a new one. Basket orders are not supported.</p>
    </Page>
  );
}

export function PositionsScreen() {
  const desk = useDesk();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Portfolio["positions"][number] | null>(null);
  const load = () => api<Portfolio>("/api/portfolio").then(setPortfolio).catch((caught) => setError(caught instanceof Error ? caught.message : "Positions failed."));
  useEffect(() => {
    load();
    const refresh = () => load();
    window.addEventListener("td-ledger", refresh);
    return () => window.removeEventListener("td-ledger", refresh);
  }, []);
  return (
    <div className="h-full overflow-auto p-3">
      <h1 className="text-base font-semibold">Positions</h1>
      <p className="mt-1 text-xs text-muted">These are long practice positions. The ledger does not separate an intraday product, and it does not allow a short reverse.</p>
      {error ? <p className="mt-2 text-xs text-loss">{error}</p> : null}
      <div className="mt-3 overflow-auto border border-border">
        <table className="text-xs">
          <thead><tr><th>Symbol</th><th>Type</th><th>Strike</th><th>Expiry</th><th>Lots</th><th>Qty</th><th>Avg</th><th>LTP</th><th>Value</th><th>Unrealized</th><th>Realized</th><th>Opened</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            {portfolio && portfolio.positions.length === 0 ? <tr><td colSpan={14} className="text-muted">No open practice positions.</td></tr> : null}
            {portfolio?.positions.map((row) => (
              <tr key={row.symbol}>
                <td><button className="inline-flex items-center gap-2 text-left text-primary" onClick={() => desk.chooseSymbol(row.symbol)}><StockLogo symbol={row.symbol} name={row.name} size={24} /><span>{row.contract ? `${row.contract.underlying} ${row.contract.strike.toLocaleString("en-IN")} ${row.contract.right}` : row.symbol}<span className="block text-[10px] font-normal text-muted">{row.name}</span></span></button></td>
                <td>{row.contract?.right ?? "—"}</td>
                <td className="num">{row.contract ? row.contract.strike.toLocaleString("en-IN") : "—"}</td>
                <td>{row.contract?.expiry ?? "—"}</td>
                <td className="num">{row.lots ?? "—"}</td>
                <td className="num">{row.quantity}</td>
                <td className="num">{row.averageCost}</td>
                <td className="num">{row.mark ?? "—"}</td>
                <td className="num">{row.marketValue ?? "—"}</td>
                <td className="num">{row.unrealized ?? "—"}</td>
                <td className="num">{row.realized}</td>
                <td>{istStamp(row.openedAt)}</td>
                <td>{istStamp(row.updatedAt)}</td>
                <td className="space-x-2 whitespace-nowrap">
                  <Link className="text-primary" href={`/terminal?symbol=${row.symbol}&side=BUY`}>Add</Link>
                  <Link className="text-primary" href={`/terminal?symbol=${row.symbol}&side=SELL&type=STOP`}>Stop</Link>
                  <button className="text-loss" onClick={() => setPending(row)}>Exit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pending ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-sm border border-border bg-panel p-4 text-sm">
            <h2 className="font-semibold">Exit {pending.contract ? `${pending.contract.underlying} ${pending.contract.strike} ${pending.contract.right}` : pending.symbol}?</h2>
            <p className="mt-2 text-xs text-muted">{pending.contract ? `Sells ${pending.lots ?? "—"} lot${pending.lots === 1 ? "" : "s"} to close this option. Short options are not available. The fill uses the current chain snapshot.` : `Places a practice market sell for ${pending.quantity} shares. A stop-loss is a separate order from the terminal. Reversing into a short is not available.`}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="border border-border px-3 py-1 text-xs" onClick={() => setPending(null)}>Back</button>
              <button className="bg-loss px-3 py-1 text-xs text-on-signal" disabled={Boolean(pending.contract && !pending.lots)} onClick={() => {
                const option = pending.contract ?? parseOptionLedgerSymbol(pending.symbol);
                const request = option && pending.lots
                  ? api<{ status?: string; message?: string }>("/api/demo/option", { symbol: option.underlying, expiry: option.expiry, strike: option.strike, right: option.right, action: "SELL", lots: pending.lots, idempotencyKey: crypto.randomUUID() })
                  : api<{ status?: string; message?: string }>("/api/orders", { symbol: pending.symbol, side: "SELL", type: "MARKET", quantity: pending.quantity, idempotencyKey: crypto.randomUUID().replace(/-/g, "").slice(0, 20) });
                void request
                  .then(async (result: { status?: string; message?: string }) => { desk.toast(`${pending.name} ${result.status ?? "sent"}. ${result.message ?? ""}`); setPending(null); await load(); window.dispatchEvent(new Event("td-ledger")); })
                  .catch((caught) => desk.toast(caught instanceof Error ? caught.message : "Exit failed."));
              }}>Sell practice position</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function HoldingsScreen() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const load = () => api<Portfolio>("/api/portfolio").then(setPortfolio).catch((caught) => setError(caught instanceof Error ? caught.message : "Holdings failed."));
    load();
    window.addEventListener("td-ledger", load);
    return () => window.removeEventListener("td-ledger", load);
  }, []);
  const loading = !portfolio && !error;
  const stats: Array<[string, string | number | undefined]> = [
    ["Return", portfolio?.performanceReturn], ["Closed trades", portfolio?.completedTrades], ["Wins", portfolio?.winningTrades], ["Losses", portfolio?.losingTrades],
    ["Win rate", portfolio?.winRate], ["Average win", portfolio?.averageWin], ["Average loss", portfolio?.averageLoss], ["Largest win", portfolio?.largestWin],
    ["Largest loss", portfolio?.largestLoss], ["Max drawdown", portfolio?.maxDrawdown],
  ];
  return (
    <Page wide>
      <PageHeader
        eyebrow={<><Badge tone="demo">Demo</Badge> Practice ledger</>}
        title="Portfolio"
        description="One long delivery-style position per symbol. The ledger keeps no separate demat book, so this page shows those positions with their allocation. Performance beyond stored snapshots is not invented."
      />
      {error ? <Notice tone="loss">{error}</Notice> : null}
      {portfolio?.stale ? <Notice tone="warning">{portfolio.valuationMessage} Some marks are stale or missing.</Notice> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
        <StatCard label="Equity" value={portfolio?.equity ?? "—"} loading={loading} delta={portfolio ? `Net ${portfolio.netPnl}` : undefined} deltaTone={signOf(portfolio?.netPnl)} className="sm:col-span-2 lg:col-span-1" />
        <StatCard size="sm" label="Allocated capital" value={portfolio?.allocatedCapital ?? portfolio?.startingCapital ?? "—"} loading={loading} />
        <StatCard size="sm" label="Available cash" value={portfolio?.cashAvailable ?? "—"} loading={loading} />
        <StatCard size="sm" label="Realized P&L" value={portfolio?.realized ?? "—"} tone={signOf(portfolio?.realized)} loading={loading} />
        <StatCard size="sm" label="Unrealized P&L" value={portfolio?.unrealized ?? "—"} tone={signOf(portfolio?.unrealized)} loading={loading} />
      </div>

      <Section title="Performance" description="Capital is separate from profit and loss. Drawdown uses saved equity snapshots and stays blank until two exist.">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-data text-muted">{label}</dt>
              <dd className="num mt-1 truncate text-dense font-semibold text-text">{value ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Section title="Holdings" description={portfolio?.valuationMessage} flush>
          <div className="overflow-auto">
            <table className="text-dense">
              <thead><tr><th>Instrument</th><th>Type</th><th className="num">Strike</th><th>Expiry</th><th className="num">Lots</th><th className="num">Qty</th><th className="num">Avg</th><th className="num">Mark</th><th className="num">Value</th><th className="num">Unrealized</th><th className="num">Realized</th><th>Status</th><th>Opened</th><th>Updated</th></tr></thead>
              <tbody>
                {loading ? [0, 1, 2].map((row) => <tr key={row}><td colSpan={14}><Skeleton className="h-6 w-full" /></td></tr>) : null}
                {!loading && (portfolio?.positions.length ?? 0) === 0 ? <tr><td colSpan={14}><EmptyState icon={<PieChart className="h-5 w-5" />} title="No practice holdings" body="Buy from the terminal or the option chain and the position appears here." /></td></tr> : portfolio?.positions.map((row) => (
                  <tr key={row.symbol}>
                    <td><span className="inline-flex items-center gap-2.5"><StockLogo symbol={row.contract?.underlying ?? row.symbol} name={row.name} size={28} /><span><span className="block font-semibold text-text">{row.contract ? `${row.contract.underlying} ${row.contract.strike.toLocaleString("en-IN")} ${row.contract.right}` : row.symbol}</span><span className="block text-micro text-muted">{row.name}</span></span></span></td>
                    <td className="text-text-2">{row.contract?.right ?? "—"}</td>
                    <td className="num">{row.contract ? row.contract.strike.toLocaleString("en-IN") : "—"}</td>
                    <td className="whitespace-nowrap text-text-2">{row.contract?.expiry ?? "—"}</td>
                    <td className="num">{row.lots ?? "—"}</td>
                    <td className="num">{row.quantity}</td>
                    <td className="num">{row.averageCost}</td>
                    <td className="num">{row.mark ?? "—"}</td>
                    <td className="num font-medium text-text">{row.marketValue ?? "—"}</td>
                    <td className={`num font-semibold ${pnlTone(row.unrealized)}`}>{row.unrealized ?? "—"}</td>
                    <td className={`num ${pnlTone(row.realized)}`}>{row.realized}</td>
                    <td><Badge tone={(row.status ?? "OPEN") === "OPEN" ? "primary" : "neutral"}>{row.status ?? "OPEN"}</Badge></td>
                    <td className="whitespace-nowrap text-data text-muted">{istStamp(row.openedAt)}</td>
                    <td className="whitespace-nowrap text-data text-muted">{istStamp(row.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Allocation" description="Share of equity, including cash.">
          {(portfolio?.allocation ?? []).length === 0 ? <p className="text-data text-muted">{loading ? "Loading…" : "No allocation yet."}</p> : (
            <ul className="space-y-3">
              {(portfolio?.allocation ?? []).map((item) => {
                const share = Math.max(0, Math.min(100, Number.parseFloat(item.percent) || 0));
                return (
                  <li key={item.label}>
                    <div className="flex items-baseline justify-between gap-2 text-dense">
                      <span className="truncate font-medium text-text">{item.label}</span>
                      <span className="num text-text-2">{item.percent}</span>
                    </div>
                    <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
                      <span className={`block h-full rounded-full ${item.label === "Cash" ? "bg-muted/60" : "bg-primary/80"}`} style={{ width: `${share}%` }} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Equity snapshots" description="Stored when the account is opened, at most once every 15 minutes." flush>
        {(portfolio?.equityCurve?.length ?? 0) > 0 ? (
          <div className="max-h-56 overflow-auto">
            <table className="text-dense">
              <thead><tr><th>Captured</th><th className="num">Equity</th><th className="num">Realized</th><th className="num">Unrealized</th></tr></thead>
              <tbody>
                {[...(portfolio?.equityCurve ?? [])].reverse().map((point) => (
                  <tr key={point.at}>
                    <td className="whitespace-nowrap text-text-2">{istTime(point.at)}</td>
                    <td className="num font-medium text-text">{point.equity}</td>
                    <td className={`num ${pnlTone(point.realized)}`}>{point.realized}</td>
                    <td className={`num ${pnlTone(point.unrealized)}`}>{point.unrealized}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="px-4 py-6 text-data text-muted">No equity snapshots yet.</p>}
      </Section>

      <div id="trade-history" className="scroll-mt-4"><ClosedTrades /></div>
    </Page>
  );
}

function readRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("td-recent") || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function optionTradeLabel(symbol: string) {
  const parsed = parseOptionLedgerSymbol(symbol);
  return parsed ? `${parsed.underlying} ${parsed.strike.toLocaleString("en-IN")} ${parsed.right} · ${parsed.expiry}` : symbol;
}

function ClosedTrades() {
  const [rows, setRows] = useState<Array<{ id: string; symbol: string; direction: string; quantity: number; entryAt: string; exitAt: string; averageEntry: string; averageExit: string; gross: string; charges: string; net: string; ret: string; profitable: boolean; loss: boolean; holdingSeconds: number; note: string }>>([]);
  const [error, setError] = useState("");
  const [symbol, setSymbol] = useState("all");
  const [result, setResult] = useState<"all" | "win" | "loss">("all");
  useEffect(() => {
    const load = () => api<{ trades: typeof rows }>("/api/trades").then((data) => setRows(data.trades)).catch((caught) => setError(caught instanceof Error ? caught.message : "Closed trades are unavailable."));
    load();
    window.addEventListener("td-ledger", load);
    return () => window.removeEventListener("td-ledger", load);
  }, []);
  const symbols = ["all", ...new Set(rows.map((row) => row.symbol))];
  const shown = rows.filter((row) => (symbol === "all" || row.symbol === symbol) && (result === "all" || (result === "win" ? row.profitable : row.loss)));
  return (
    <Section
      title="Completed trades"
      flush
      actions={
        <>
          <select className="h-8 py-0 text-data" value={symbol} onChange={(event) => setSymbol(event.target.value)} aria-label="Filter by instrument">{symbols.map((item) => <option key={item} value={item}>{item === "all" ? "All instruments" : item}</option>)}</select>
          <select className="h-8 py-0 text-data" value={result} onChange={(event) => setResult(event.target.value as "all" | "win" | "loss")} aria-label="Filter by result"><option value="all">All results</option><option value="win">Profitable</option><option value="loss">Losing</option></select>
        </>
      }
    >
      {error ? <Notice tone="loss" className="m-4">{error}</Notice> : null}
      <div className="max-h-[50vh] overflow-auto">
        <table className="text-dense">
          <thead><tr><th>Instrument</th><th>Entry</th><th>Exit</th><th className="num">Qty</th><th className="num">Gross</th><th className="num">Fees</th><th className="num">Net</th><th className="num">Return</th><th>Duration</th></tr></thead>
          <tbody>
            {shown.length === 0 ? <tr><td colSpan={9}><EmptyState title="No completed trades in this view" body="Closed round trips appear here with fees and net P&L." /></td></tr> : shown.map((row) => (
              <tr key={row.id}>
                <td><span className="font-semibold text-text">{optionTradeLabel(row.symbol)}</span> <span className="text-micro text-muted">{row.direction}</span></td>
                <td className="whitespace-nowrap"><span className="block text-data text-muted">{istStamp(row.entryAt)}</span><span className="num">{row.averageEntry}</span></td>
                <td className="whitespace-nowrap"><span className="block text-data text-muted">{istStamp(row.exitAt)}</span><span className="num">{row.averageExit}</span></td>
                <td className="num">{row.quantity}</td>
                <td className={`num ${pnlTone(row.gross)}`}>{row.gross}</td>
                <td className="num text-text-2">{row.charges}</td>
                <td className={`num font-semibold ${pnlTone(row.net)}`}>{row.net}</td>
                <td className={`num ${pnlTone(row.ret)}`}>{row.ret}</td>
                <td className="text-data text-text-2">{row.holdingSeconds}s{row.note ? ` · ${row.note}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export function FundsScreen() {
  const desk = useDesk();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Portfolio>("/api/portfolio").then(setPortfolio).catch((caught) => setError(caught instanceof Error ? caught.message : "Practice funds unavailable."));
  }, []);
  const loading = !portfolio && !error;
  return (
    <Page>
      <PageHeader
        eyebrow={desk.mode === "demo" ? <><Badge tone="demo">Demo</Badge> Practice wallet</> : <><Badge tone="warning">Live view</Badge> Paper wallet · live prices</>}
        title="Money"
        description="Demo and Live view each have their own simulated wallet. Real Dhan funds are shown only in Accounts."
      />
      {error ? <Notice tone="loss">{error}</Notice> : null}
      <section aria-label="Practice balance" className="flex flex-col gap-3">
        <div className="flex items-center gap-2"><h2 className="text-title font-semibold">Practice balance</h2><Badge tone="demo">Simulated</Badge></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.3fr_repeat(4,1fr)]">
          <StatCard label="Available cash" value={portfolio?.cashAvailable ?? "—"} icon={<Wallet className="text-info" />} loading={loading} className="sm:col-span-2 lg:col-span-1" />
          <StatCard size="sm" label="Allocated capital" value={portfolio?.allocatedCapital ?? "—"} icon={<Landmark className="text-info" />} loading={loading} />
          <StatCard size="sm" label="Reserved" value={portfolio?.cashReserved ?? "—"} icon={<Lock className="text-warning" />} loading={loading} />
          <StatCard size="sm" label="Equity" value={portfolio?.equity ?? "—"} icon={<PieChart className="text-primary" />} loading={loading} />
          <StatCard size="sm" label="Charges" value={portfolio?.charges ?? "—"} icon={<Receipt className="text-muted" />} loading={loading} />
        </div>
      </section>
    </Page>
  );
}

export function OptionsScreen() {
  const [deskData, setDeskData] = useState<OptionsDesk | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = () => api<OptionsDesk>("/api/options").then((data) => { setDeskData(data); setError(""); }).catch((caught) => setError(caught instanceof Error ? caught.message : "Options unavailable."));
  useEffect(() => { load(); }, []);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1"><OptionChainBoard /></div>
      <details className="group shrink-0 border-t border-border-soft bg-panel px-4 py-2.5">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-dense font-semibold text-text-2 hover:text-text">
          <span className="transition-transform group-open:rotate-90" aria-hidden>›</span>
          Practice signal
          <Badge tone="demo">Simulated</Badge>
        </summary>
        <p className="mt-2 max-w-3xl text-data text-muted">This stays on the simulated practice book. It is separate from the chain above, and it does not send a contract to the exchange.</p>
        {error ? <Notice tone="loss" className="mt-2">{error}</Notice> : null}
        {deskData ? <p className="mt-2 text-data text-muted">{deskData.message} Updated {istTime(deskData.asOf)}.</p> : null}
        {deskData?.position ? <p className="num mt-3 text-data text-text">Open practice position: {deskData.position.right} {deskData.position.strike} {deskData.position.expiry} · qty {deskData.position.quantity} · avg {deskData.position.average} · mark {deskData.position.mark}</p> : <p className="mt-3 text-data text-muted">No open practice option position.</p>}
        {message ? <p className="mt-2 text-data text-text">{message}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="buy" disabled={!deskData?.risk.ok} onClick={() => {
            if (!window.confirm("Place the practice signal buy? It is simulated.")) return;
            void api<{ message?: string }>("/api/options", { action: "BUY", idempotencyKey: crypto.randomUUID().replace(/-/g, "").slice(0, 20) }).then((result) => { setMessage(result.message ?? "Submitted."); load(); }).catch((caught) => setMessage(caught instanceof Error ? caught.message : "Order failed."));
          }}>Practice signal buy</Button>
          <Button size="sm" disabled={!deskData?.position} onClick={() => {
            if (!window.confirm("Close the practice option position?")) return;
            void api<{ message?: string }>("/api/options", { action: "CLOSE", idempotencyKey: crypto.randomUUID().replace(/-/g, "").slice(0, 20) }).then((result) => { setMessage(result.message ?? "Submitted."); load(); }).catch((caught) => setMessage(caught instanceof Error ? caught.message : "Close failed."));
          }}>Close practice position</Button>
        </div>
        {deskData && !deskData.risk.ok ? <p className="mt-2 text-data text-muted">{deskData.risk.reasons.join(" ")}</p> : null}
      </details>
    </div>
  );
}

export function AlertsScreen() {
  const desk = useDesk();
  const [alerts, setAlerts] = useState<Array<{ id: string; symbol: string; condition: string; target: string; status: string; note: string }>>([]);
  const [symbol, setSymbol] = useState(desk.symbol);
  const [condition, setCondition] = useState<"PRICE_ABOVE" | "PRICE_BELOW">("PRICE_ABOVE");
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const load = () => api<{ alerts: typeof alerts }>("/api/alerts").then((data) => setAlerts(data.alerts)).catch((caught) => setError(caught instanceof Error ? caught.message : "Alerts failed."));
  useEffect(() => { load(); }, []);
  return (
    <Page>
      <PageHeader title="Alerts" description="Price alerts are stored for the signed-in account. Scanners beyond the market catalogue are not available from this data source." actions={<Link className="inline-flex h-7 items-center rounded-sm px-2.5 text-data font-semibold text-primary transition-colors hover:bg-primary-soft" href="/search">Search instruments</Link>} />
      {error ? <Notice tone="loss">{error}</Notice> : null}
      <Section title="New price alert">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void api("/api/alerts", { symbol, condition, targetRupees: target }).then(() => { setTarget(""); load(); }).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not save.")); }}>
          <label className="flex min-w-[140px] flex-1 flex-col gap-1.5 text-data font-medium text-text-2">Symbol<input className="h-[34px] font-semibold uppercase text-text" value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} /></label>
          <label className="flex min-w-[140px] flex-1 flex-col gap-1.5 text-data font-medium text-text-2">Condition<select className="h-[34px] py-0 text-text" value={condition} onChange={(event) => setCondition(event.target.value as typeof condition)}><option value="PRICE_ABOVE">Price above</option><option value="PRICE_BELOW">Price below</option></select></label>
          <label className="flex min-w-[140px] flex-1 flex-col gap-1.5 text-data font-medium text-text-2">Target (₹)<input className="num h-[34px] text-text" inputMode="decimal" value={target} onChange={(event) => setTarget(event.target.value)} /></label>
          <Button type="submit" variant="primary">Save alert</Button>
        </form>
      </Section>
      <Section title="Your alerts" flush>
        <div className="overflow-auto">
          <table className="text-dense">
            <thead><tr><th>Instrument</th><th>Condition</th><th className="num">Target</th><th>Status</th><th className="text-right"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {alerts.length === 0 ? <tr><td colSpan={5}><EmptyState title="No alerts yet" body="Create one above and you are notified when the price crosses the target." /></td></tr> : alerts.map((alert) => (
                <tr key={alert.id}>
                  <td><span className="inline-flex items-center gap-2.5"><StockLogo symbol={alert.symbol} size={24} /><span className="font-semibold text-text">{alert.symbol}</span></span></td>
                  <td className="text-text-2">{alert.condition === "PRICE_ABOVE" ? "Price above" : alert.condition === "PRICE_BELOW" ? "Price below" : alert.condition}</td>
                  <td className="num font-medium text-text">{alert.target}</td>
                  <td><Badge tone={alert.status === "ACTIVE" ? "primary" : alert.status === "TRIGGERED" ? "profit" : "neutral"} dot>{alert.status}</Badge></td>
                  <td className="text-right">{alert.status === "ACTIVE" ? <Button size="sm" variant="danger" onClick={() => { if (window.confirm("Cancel this alert?")) void api("/api/alerts", { action: "alert-cancel", id: alert.id }).then(load); }}>Cancel</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </Page>
  );
}

export function SearchScreen() {
  const desk = useDesk();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Instrument[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const handle = window.setTimeout(() => {
      api<Instrument[]>(`/api/instruments?q=${encodeURIComponent(query)}`).then(setRows).catch((caught) => setError(caught instanceof Error ? caught.message : "Search failed."));
    }, 150);
    return () => window.clearTimeout(handle);
  }, [query]);
  return (
    <Page>
      <PageHeader title="Search" description="Find NSE equities and indices by symbol or company name." />
      <input className="h-11 w-full max-w-xl text-body" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Symbol or company" aria-label="Search instruments" />
      {error ? <Notice tone="loss">{error}</Notice> : null}
      <div className="data-table">
        <table>
          <thead><tr><th>Instrument</th><th className="hidden sm:table-cell">Exchange</th><th className="hidden sm:table-cell">Type</th><th className="text-right"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={4}><EmptyState title={query ? "No instruments match" : "Start typing to search"} body={query ? `Nothing matches “${query}”. Try a symbol like NIFTY or RELIANCE.` : undefined} /></td></tr> : null}
            {rows.map((row) => (
              <tr key={`${row.exchange}-${row.symbol}`}>
                <td>
                  <span className="flex items-center gap-3">
                    <StockLogo symbol={row.symbol} name={row.name} size={28} />
                    <span className="min-w-0"><span className="block font-semibold text-text">{row.symbol}</span><span className="block truncate text-micro text-muted">{row.name}</span></span>
                  </span>
                </td>
                <td className="hidden text-text-2 sm:table-cell">{row.exchange}</td>
                <td className="hidden text-muted sm:table-cell">{row.sector}</td>
                <td className="text-right"><Button size="sm" variant="tertiary" onClick={() => desk.chooseSymbol(row.symbol)}>Open chart</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

