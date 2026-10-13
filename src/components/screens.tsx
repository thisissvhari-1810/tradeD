"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownToLine, Landmark, Lock, PieChart, Receipt, Shield, Wallet } from "lucide-react";
import { api, istTime, money, type Instrument, type Quote } from "@/components/api";
import { OptionChainBoard } from "@/components/option-chain";
import { useDesk } from "@/components/shell";
import { OrderStatus, StockLogo } from "@/components/stock-identity";

type Portfolio = {
  simulated?: boolean;
  cashAvailable: string;
  cashReserved: string;
  holdingsValue: string;
  equity: string;
  realized: string;
  unrealized: string;
  charges: string;
  valuationMessage: string;
  stale: boolean;
  positions: Array<{ symbol: string; name: string; quantity: number; averageCost: string; mark: string | null; marketValue: string | null; unrealized: string | null; realized: string; mode?: string }>;
  allocation?: Array<{ label: string; percent: string }>;
};
type Activity = {
  orders: Array<{ id: string; symbol: string; side: string; type: string; quantity: number; filledQuantity: number; status: string; limit: string | null; stop?: string | null; avgFill: string | null; charges: string; reason: string | null; submittedAt: string }>;
  executions: Array<{ id: string; symbol: string; side: string; quantity: number; price: string; charges: string; realized: string; mode: string; source?: string; executedAt: string }>;
};
type Broker = {
  liveTrading: boolean;
  liveOrders: string;
  reason: string;
  token: { source: string; expiresAt: string | null; expired: boolean };
  clientConfigured: boolean;
  funds: Record<string, unknown> | null;
  positions: unknown;
  holdings: unknown;
  orders: unknown;
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
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    setRecent(JSON.parse(localStorage.getItem("td-recent") || "[]") as string[]);
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
    <div className="h-full overflow-auto p-3">
      <h1 className="text-base font-semibold">Markets</h1>
      <p className="mt-1 max-w-3xl text-xs text-muted">NSE equities and indices.</p>
      {error ? <p className="mt-2 text-xs text-loss">{error}</p> : null}
      <h2 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Recently viewed</h2>
      <div className="mt-2 flex flex-wrap gap-1">
        {recent.length === 0 ? <span className="text-xs text-muted">None yet.</span> : recent.map((symbol) => <button key={symbol} className="border border-border px-2 py-1 text-xs" onClick={() => desk.chooseSymbol(symbol)}>{symbol}</button>)}
      </div>
      <div className="mt-4 flex flex-wrap gap-1">
        {sectors.map((item) => <button key={item} className={`px-2 py-1 text-xs ${sector === item ? "bg-primary text-on-primary" : "border border-border text-muted"}`} onClick={() => setSector(item)}>{item}</button>)}
      </div>
      <div className="mt-3 overflow-auto border border-border">
        <table className="text-xs">
          <thead><tr><th>Symbol</th><th>Name</th><th>Exchange</th><th>Sector</th><th>LTP</th><th></th></tr></thead>
          <tbody>
            {visible.slice(0, 80).map((row) => (
              <tr key={row.symbol}>
                <td className="font-medium"><span className="inline-flex items-center gap-2"><StockLogo symbol={row.symbol} name={row.name} size={24} />{row.symbol}</span></td>
                <td>{row.name}</td>
                <td>{row.exchange}</td>
                <td className="text-muted">{row.sector}</td>
                <td className="num">{quotes[row.symbol] ? money(quotes[row.symbol].last) : "—"}</td>
                <td><button className="text-primary" onClick={() => desk.chooseSymbol(row.symbol)}>Chart</button> <Link className="text-primary" href={`/options?symbol=${encodeURIComponent(row.symbol)}`}>Chain</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function OrdersScreen() {
  const desk = useDesk();
  const [book, setBook] = useState<Activity | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("ALL");
  const load = () => api<Activity>("/api/orders").then(setBook).catch((caught) => setError(caught instanceof Error ? caught.message : "Orders failed."));
  useEffect(() => { load(); const timer = window.setInterval(load, 8000); return () => window.clearInterval(timer); }, []);
  const orders = (book?.orders ?? []).filter((order) => filter === "ALL" || order.status === filter);
  return (
    <div className="h-full overflow-auto p-3">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-semibold">Orders</h1>
        <span className="text-[10px] text-muted">Practice ledger · not broker fills</span>
        <button className="ml-auto border border-border px-2 py-1 text-xs" onClick={() => load()}>Refresh</button>
      </div>
      <p className="mt-1 text-xs text-muted">Changing an order means cancelling it and placing a new one. The practice engine has no modify call. Basket orders are not supported.</p>
      {desk.mode === "live" ? <p className="mt-2 text-xs text-loss">Live mode does not list or change broker orders from this screen. Open Funds for the read-only broker snapshot.</p> : null}
      {error ? <p className="mt-2 text-xs text-loss">{error}</p> : null}
      <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
        {["ALL", "FILLED", "OPEN", "PARTIALLY_FILLED", "REJECTED", "CANCELLED"].map((item) => <button key={item} className={`px-2 py-1 ${filter === item ? "bg-elevated" : "text-muted"}`} onClick={() => setFilter(item)}>{item}</button>)}
      </div>
      <div className="mt-2 overflow-auto border border-border">
        <table className="text-xs">
          <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Filled</th><th>Status</th><th>Avg</th><th></th></tr></thead>
          <tbody>
            {book && orders.length === 0 ? <tr><td colSpan={9} className="text-muted">No orders in this view.</td></tr> : null}
            {!book && !error ? <tr><td colSpan={9} className="text-muted">Loading orders…</td></tr> : null}
            {orders.map((order) => (
              <tr key={order.id}>
                <td>{istTime(order.submittedAt)}</td>
                <td><button className="inline-flex items-center gap-2 text-primary" onClick={() => desk.chooseSymbol(order.symbol)}><StockLogo symbol={order.symbol} size={22} />{order.symbol}</button></td>
                <td className={order.side === "BUY" ? "up" : "down"}>{order.side}</td>
                <td>{order.type}</td>
                <td className="num">{order.quantity}</td>
                <td className="num">{order.filledQuantity}</td>
                <td title={order.reason ?? ""}><OrderStatus status={order.status} /></td>
                <td className="num">{order.avgFill ?? "—"}</td>
                <td>{order.status === "OPEN" ? <button className="text-loss" onClick={() => { if (window.confirm("Cancel this practice order?")) void api(`/api/orders/${order.id}/cancel`, {}).then(() => load()).catch((caught) => desk.toast(caught instanceof Error ? caught.message : "Cancel failed.")); }}>Cancel</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Trade book</h2>
      <div className="mt-2 overflow-auto border border-border">
        <table className="text-xs">
          <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Charges</th><th>Realized</th><th>Mode</th></tr></thead>
          <tbody>
            {(book?.executions.length ?? 0) === 0 ? <tr><td colSpan={8} className="text-muted">No practice fills.</td></tr> : book?.executions.map((fill) => (
              <tr key={fill.id}><td>{istTime(fill.executedAt)}</td><td>{fill.symbol}</td><td>{fill.side}</td><td className="num">{fill.quantity}</td><td className="num">{fill.price}</td><td className="num">{fill.charges}</td><td className="num">{fill.realized}</td><td>{fill.mode}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PositionsScreen() {
  const desk = useDesk();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Portfolio["positions"][number] | null>(null);
  const load = () => api<Portfolio>("/api/portfolio").then(setPortfolio).catch((caught) => setError(caught instanceof Error ? caught.message : "Positions failed."));
  useEffect(() => { load(); }, []);
  return (
    <div className="h-full overflow-auto p-3">
      <h1 className="text-base font-semibold">Positions</h1>
      <p className="mt-1 text-xs text-muted">These are long practice positions. The ledger does not separate an intraday product, and it does not allow a short reverse.</p>
      {error ? <p className="mt-2 text-xs text-loss">{error}</p> : null}
      <div className="mt-3 overflow-auto border border-border">
        <table className="text-xs">
          <thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>LTP</th><th>Value</th><th>Unrealized</th><th>Realized</th><th></th></tr></thead>
          <tbody>
            {portfolio && portfolio.positions.length === 0 ? <tr><td colSpan={8} className="text-muted">No open practice positions.</td></tr> : null}
            {portfolio?.positions.map((row) => (
              <tr key={row.symbol}>
                <td><button className="inline-flex items-center gap-2 text-left text-primary" onClick={() => desk.chooseSymbol(row.symbol)}><StockLogo symbol={row.symbol} name={row.name} size={24} /><span>{row.symbol}<span className="block text-[10px] font-normal text-muted">{row.name}</span></span></button></td>
                <td className="num">{row.quantity}</td>
                <td className="num">{row.averageCost}</td>
                <td className="num">{row.mark ?? "—"}</td>
                <td className="num">{row.marketValue ?? "—"}</td>
                <td className="num">{row.unrealized ?? "—"}</td>
                <td className="num">{row.realized}</td>
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
            <h2 className="font-semibold">Exit {pending.symbol}?</h2>
            <p className="mt-2 text-xs text-muted">Places a practice market sell for {pending.quantity} shares. A stop-loss is a separate order from the terminal. Reversing into a short is not available.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="border border-border px-3 py-1 text-xs" onClick={() => setPending(null)}>Back</button>
              <button className="bg-loss px-3 py-1 text-xs text-white" onClick={() => {
                void api<{ status?: string; message?: string }>("/api/orders", { symbol: pending.symbol, side: "SELL", type: "MARKET", quantity: pending.quantity, idempotencyKey: crypto.randomUUID().replace(/-/g, "").slice(0, 20) })
                  .then(async (result: { status?: string; message?: string }) => { desk.toast(`${pending.symbol} ${result.status ?? "sent"}. ${result.message ?? ""}`); setPending(null); await load(); })
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
  useEffect(() => { api<Portfolio>("/api/portfolio").then(setPortfolio).catch((caught) => setError(caught instanceof Error ? caught.message : "Holdings failed.")); }, []);
  return (
    <div className="h-full overflow-auto p-3">
      <h1 className="text-base font-semibold">Holdings</h1>
      <p className="mt-1 max-w-3xl text-xs text-muted">The practice ledger stores one long delivery-style position per symbol. It does not keep a separate demat holding book, so this page repeats those positions and their allocation. Historical performance beyond the stored snapshots is not invented.</p>
      {error ? <p className="mt-2 text-xs text-loss">{error}</p> : null}
      {portfolio ? <p className="mt-2 text-xs text-muted">{portfolio.valuationMessage} {portfolio.stale ? "Some marks are stale or missing." : ""}</p> : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Card label="Holdings value" value={portfolio?.holdingsValue ?? "—"} />
        <Card label="Unrealized" value={portfolio?.unrealized ?? "—"} />
        <Card label="Realized" value={portfolio?.realized ?? "—"} />
      </div>
      <div className="mt-3 overflow-auto border border-border">
        <table className="text-xs">
          <thead><tr><th>Symbol</th><th>Qty</th><th>Avg cost</th><th>Value</th><th>P&L</th></tr></thead>
          <tbody>
            {(portfolio?.positions.length ?? 0) === 0 ? <tr><td colSpan={5} className="text-muted">No practice holdings.</td></tr> : portfolio?.positions.map((row) => (
              <tr key={row.symbol}><td><span className="inline-flex items-center gap-2"><StockLogo symbol={row.symbol} name={row.name} size={24} /><span>{row.symbol}<span className="block text-[10px] text-muted">{row.name}</span></span></span></td><td className="num">{row.quantity}</td><td className="num">{row.averageCost}</td><td className="num">{row.marketValue ?? "—"}</td><td className={`num ${row.unrealized == null ? "" : String(row.unrealized).includes("-") ? "down" : "up"}`}>{row.unrealized ?? "—"}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Allocation</h2>
      <ul className="mt-2 space-y-1 text-xs">
        {(portfolio?.allocation ?? []).map((item) => <li key={item.label} className="flex justify-between border-b border-border py-1"><span>{item.label}</span><span className="num">{item.percent}</span></li>)}
      </ul>
    </div>
  );
}

export function FundsScreen() {
  const desk = useDesk();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [broker, setBroker] = useState<Broker | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Portfolio>("/api/portfolio").then(setPortfolio).catch((caught) => setError(caught instanceof Error ? caught.message : "Practice funds unavailable."));
    api<{ broker: Broker }>("/api/account").then((data) => setBroker(data.broker)).catch((caught) => setError(caught instanceof Error ? caught.message : "Broker status unavailable."));
  }, []);
  const funds = broker?.funds && typeof broker.funds === "object" ? broker.funds : null;
  return (
    <div className="h-full overflow-auto p-3">
      <h1 className="text-base font-semibold">Funds</h1>
      <p className="mt-1 text-xs text-muted">Current view: {desk.mode === "demo" ? "demo practice ledger" : "live account read"}.</p>
      {error ? <p className="mt-2 text-xs text-loss">{error}</p> : null}
      <section className="mt-3 border border-border bg-panel p-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Practice balance</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-4">
          <Card label="Available balance" value={portfolio?.cashAvailable ?? "—"} icon={<Wallet className="h-4 w-4 text-info" aria-hidden />} />
          <Card label="Reserved" value={portfolio?.cashReserved ?? "—"} icon={<Lock className="h-4 w-4 text-warning" aria-hidden />} />
          <Card label="Equity" value={portfolio?.equity ?? "—"} icon={<PieChart className="h-4 w-4 text-primary" aria-hidden />} />
          <Card label="Charges" value={portfolio?.charges ?? "—"} icon={<Receipt className="h-4 w-4 text-muted" aria-hidden />} />
        </div>
      </section>
      <section className="mt-3 border border-border bg-panel p-3 text-xs">
        <h2 className="font-semibold uppercase tracking-wide text-muted">Connected account</h2>
        <p className="mt-2">{broker?.reason || "Checking the saved token…"}</p>
        <p className="mt-1 text-muted">Token source: {broker?.token.source ?? "—"} · Expires: {broker?.token.expiresAt ? istTime(broker.token.expiresAt) : "unknown"} · {broker?.token.expired ? "Expired" : "Not marked expired"}</p>
        <p className="mt-1 text-muted">Client id configured: {broker?.clientConfigured ? "yes" : "no"}. Live order placement: {broker?.liveOrders ?? "unavailable"}.</p>
        <p className="mt-2 text-muted">Deposits, withdrawals, and payment apps are not connected here. This page only reads balances, so payment-provider marks are not shown.</p>
        {funds && "error" in funds ? <p className="mt-2 text-loss">{String(funds.error)}</p> : null}
        {funds && !("error" in funds) ? (
          <dl className="mt-3 grid gap-2 sm:grid-cols-3">
            {([
              ["availabelBalance", "Available balance", <Wallet key="a" className="h-4 w-4 text-info" aria-hidden />],
              ["availableBalance", "Available balance", <Wallet key="b" className="h-4 w-4 text-info" aria-hidden />],
              ["utilizedAmount", "Used margin", <Landmark key="u" className="h-4 w-4 text-warning" aria-hidden />],
              ["withdrawableBalance", "Withdrawable", <ArrowDownToLine key="w" className="h-4 w-4 text-profit" aria-hidden />],
              ["sodLimit", "Opening limit", <Receipt key="s" className="h-4 w-4 text-muted" aria-hidden />],
              ["collateralAmount", "Collateral", <Shield key="c" className="h-4 w-4 text-primary" aria-hidden />],
            ] as const).map(([field, label, icon]) => (
              funds[field] == null ? null : <Card key={field} label={label} value={String(funds[field])} icon={icon} />
            ))}
          </dl>
        ) : null}
      </section>
    </div>
  );
}

export function OptionsScreen() {
  const [deskData, setDeskData] = useState<OptionsDesk | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = () => api<OptionsDesk>("/api/options").then((data) => { setDeskData(data); setError(""); }).catch((caught) => setError(caught instanceof Error ? caught.message : "Options unavailable."));
  useEffect(() => { load(); }, []);
  return (
    <div className="h-full overflow-auto p-3">
      <OptionChainBoard />
      <section className="mt-4 border border-border bg-panel p-3">
        <h2 className="text-sm font-semibold">Practice signal</h2>
        <p className="mt-1 max-w-3xl text-xs text-muted">This stays on the simulated practice book. It is separate from the chain above, and it does not send a contract to the exchange.</p>
        {error ? <p className="mt-2 text-xs text-loss">{error}</p> : null}
        {deskData ? <p className="mt-2 text-xs text-muted">{deskData.message} Updated {istTime(deskData.asOf)}.</p> : null}
        {deskData?.position ? <p className="mt-3 text-xs">Open practice position: {deskData.position.right} {deskData.position.strike} {deskData.position.expiry} · qty {deskData.position.quantity} · avg {deskData.position.average} · mark {deskData.position.mark}</p> : <p className="mt-3 text-xs text-muted">No open practice option position.</p>}
        {message ? <p className="mt-2 text-xs">{message}</p> : null}
        <div className="mt-3 flex gap-2">
          <button className="bg-profit px-3 py-1 text-xs text-white" disabled={!deskData?.risk.ok} onClick={() => {
            if (!window.confirm("Place the practice signal buy? It is simulated.")) return;
            void api<{ message?: string }>("/api/options", { action: "BUY", idempotencyKey: crypto.randomUUID().replace(/-/g, "").slice(0, 20) }).then((result) => { setMessage(result.message ?? "Submitted."); load(); }).catch((caught) => setMessage(caught instanceof Error ? caught.message : "Order failed."));
          }}>Practice signal buy</button>
          <button className="border border-border px-3 py-1 text-xs" disabled={!deskData?.position} onClick={() => {
            if (!window.confirm("Close the practice option position?")) return;
            void api<{ message?: string }>("/api/options", { action: "CLOSE", idempotencyKey: crypto.randomUUID().replace(/-/g, "").slice(0, 20) }).then((result) => { setMessage(result.message ?? "Submitted."); load(); }).catch((caught) => setMessage(caught instanceof Error ? caught.message : "Close failed."));
          }}>Close practice position</button>
        </div>
        {deskData && !deskData.risk.ok ? <p className="mt-2 text-xs text-muted">{deskData.risk.reasons.join(" ")}</p> : null}
      </section>
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
    <div className="h-full overflow-auto p-3">
      <h1 className="text-base font-semibold">Alerts</h1>
      <p className="mt-1 text-xs text-muted">Price alerts are stored for the signed-in account. Scanners beyond the market catalogue are not available from this data source.</p>
      {error ? <p className="mt-2 text-xs text-loss">{error}</p> : null}
      <form className="mt-3 flex flex-wrap items-end gap-2 text-xs" onSubmit={(event) => { event.preventDefault(); void api("/api/alerts", { symbol, condition, targetRupees: target }).then(() => { setTarget(""); load(); }).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not save.")); }}>
        <label>Symbol<input className="mt-1 block" value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} /></label>
        <label>Condition<select className="mt-1 block" value={condition} onChange={(event) => setCondition(event.target.value as typeof condition)}><option value="PRICE_ABOVE">Price above</option><option value="PRICE_BELOW">Price below</option></select></label>
        <label>Target<input className="mt-1 block" value={target} onChange={(event) => setTarget(event.target.value)} /></label>
        <button className="bg-primary px-3 py-1.5 text-on-primary">Save alert</button>
      </form>
      <div className="mt-3 overflow-auto border border-border">
        <table className="text-xs">
          <thead><tr><th>Symbol</th><th>Condition</th><th>Target</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {alerts.length === 0 ? <tr><td colSpan={5} className="text-muted">No alerts.</td></tr> : alerts.map((alert) => (
              <tr key={alert.id}>
                <td>{alert.symbol}</td><td>{alert.condition}</td><td className="num">{alert.target}</td><td>{alert.status}</td>
                <td>{alert.status === "ACTIVE" ? <button className="text-loss" onClick={() => { if (window.confirm("Cancel this alert?")) void api("/api/alerts", { action: "alert-cancel", id: alert.id }).then(load); }}>Cancel</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs"><Link className="text-primary" href="/search">Search instruments</Link></p>
    </div>
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
    <div className="h-full overflow-auto p-3">
      <h1 className="text-base font-semibold">Search</h1>
      <input className="mt-3 w-full max-w-md" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Symbol or company" aria-label="Search instruments" />
      {error ? <p className="mt-2 text-xs text-loss">{error}</p> : null}
      <div className="mt-3 overflow-auto border border-border">
        <table className="text-xs">
          <thead><tr><th>Symbol</th><th>Name</th><th>Exchange</th><th>Type</th><th></th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.exchange}-${row.symbol}`}>
                <td className="font-medium"><span className="inline-flex items-center gap-2"><StockLogo symbol={row.symbol} name={row.name} size={24} />{row.symbol}</span></td>
                <td>{row.name}</td>
                <td>{row.exchange}</td>
                <td>{row.sector}</td>
                <td><button className="text-primary" onClick={() => desk.chooseSymbol(row.symbol)}>Open chart</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Card({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return <div className="border border-border bg-panel px-3 py-2"><div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">{icon}{label}</div><div className="num mt-1 text-sm">{value}</div></div>;
}
