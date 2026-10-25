"use client";

import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { api } from "@/components/api";
import { cx } from "@/components/ui";

/** The Algo wallet's figures, exactly as the ledger summary returns them (Portfolio uses the same). */
export type AlgoAccount = {
  startingCapital: string;
  cashAvailable: string;
  cashReserved: string;
  holdingsValue: string;
  unrealized: string;
  realized: string;
  realizedToday: string;
  equity: string;
};

const tone = (signed: string) => (signed.startsWith("+") && !/^\+₹0\.00$/.test(signed) ? "text-profit" : signed.startsWith("-") || signed.startsWith("−") ? "text-loss" : "text-text");

/**
 * Initial capital, available cash, reserved funds, open-position value, unrealized and realized P&L and
 * total equity (= available + reserved + open-position value) of the Algo wallet.
 */
export function AlgoAccountFigures({ account, extra, compact = false }: { account: AlgoAccount; extra?: Array<[string, string]>; compact?: boolean }) {
  const rows: Array<[string, string, string?]> = [
    ["Initial capital", account.startingCapital],
    ["Available cash", account.cashAvailable],
    ["Reserved funds", account.cashReserved],
    ["Open-position value", account.holdingsValue],
    ["Unrealized P&L", account.unrealized, tone(account.unrealized)],
    ["Realized today", account.realizedToday, tone(account.realizedToday)],
    ["Realized (all)", account.realized, tone(account.realized)],
    ["Total equity", account.equity],
    ...(extra ?? []).map(([label, value]) => [label, value] as [string, string]),
  ];
  return (
    <dl className={cx("grid gap-x-3 gap-y-1", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4")}>
      {rows.map(([label, value, color]) => (
        <div key={label} className="min-w-0">
          <dt className="text-micro text-muted">{label}</dt>
          <dd className={cx("num truncate text-data font-medium", color ?? "text-text", label === "Total equity" && "font-semibold")} title={value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Portfolio and Home: the Algo wallet beside the demo wallet (read-only; its orders come from the Algo). */
export function AlgoAccountCard({ className }: { className?: string }) {
  const [state, setState] = useState<{ exists: boolean; account: AlgoAccount | null; startingCapital: string } | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api<AlgoAccount & { exists: boolean }>("/api/portfolio?wallet=algo")
      .then((data) => { if (live) setState({ exists: data.exists, account: data.exists ? data : null, startingCapital: data.startingCapital }); })
      .catch(() => undefined);
    load();
    window.addEventListener("td-ledger", load);
    const timer = window.setInterval(load, 30_000);
    return () => { live = false; window.removeEventListener("td-ledger", load); window.clearInterval(timer); };
  }, []);
  if (!state) return null;
  return (
    <section className={cx("rounded-card border border-border bg-panel p-3", className)} aria-label="Algo account">
      <div className="mb-2 flex items-center gap-2">
        <Bot className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-dense font-semibold">Algo account</h2>
        <span className="rounded-pill bg-demo-soft px-2 py-0.5 text-micro font-medium text-demo">Simulated</span>
        <span className="ml-auto text-micro text-muted">Separate from your demo funds</span>
      </div>
      {state.account ? <AlgoAccountFigures account={state.account} /> : <p className="text-data text-muted">The Strategy Algo trades its own {state.startingCapital} practice account. It opens when you first use the Algo.</p>}
    </section>
  );
}
