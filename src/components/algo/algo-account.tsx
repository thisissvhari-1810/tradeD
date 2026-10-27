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
  /** CALL and PUT profit and loss (closed trades and open positions) from the same ledger. */
  sides?: { call: AlgoSide; put: AlgoSide };
};
type AlgoSide = { trades: number; wins: number; losses: number; realized: string; open: number; unrealized: string; openValue: string };

export const tone = (signed: string) => (signed.startsWith("+") && !/^\+₹0\.00$/.test(signed) ? "text-profit" : signed.startsWith("-") || signed.startsWith("−") ? "text-loss" : "text-text");

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
    // Replay trades carry their replayed date, so they count in "Realized (all)", not in today's figure.
    ["Realized (all)", account.realized, tone(account.realized)],
    ["Realized today (real date)", account.realizedToday, tone(account.realizedToday)],
    ["Total equity", account.equity],
    ...(extra ?? []).map(([label, value]) => [label, value] as [string, string]),
  ];
  return (
    <div className="space-y-2">
      <dl className={cx("grid gap-x-3 gap-y-1", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4")}>
        {rows.map(([label, value, color]) => (
          <div key={label} className="min-w-0">
            <dt className="text-micro text-muted">{label}</dt>
            <dd className={cx("num truncate text-data font-medium", color ?? "text-text", label === "Total equity" && "font-semibold")} title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      {account.sides ? <SideTable sides={account.sides} /> : null}
    </div>
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

/** CALL and PUT profit and loss: closed trades (net of charges) and what is open now. */
function SideTable({ sides }: { sides: { call: AlgoSide; put: AlgoSide } }) {
  return (
    <table className="w-full text-micro" aria-label="CALL and PUT profit and loss">
      <thead className="text-left text-muted">
        <tr><th className="py-0.5 font-medium">Side</th><th className="py-0.5 text-right font-medium">Trades (W/L)</th><th className="py-0.5 text-right font-medium">Realized</th><th className="py-0.5 text-right font-medium">Open · unrealized</th></tr>
      </thead>
      <tbody>
        {(["call", "put"] as const).map((key) => {
          const side = sides[key];
          return (
            <tr key={key} className="border-t border-border-soft">
              <td className={cx("py-0.5 font-semibold", key === "call" ? "text-profit" : "text-loss")}>{key === "call" ? "CALL" : "PUT"}</td>
              <td className="num py-0.5 text-right">{side.trades} ({side.wins}/{side.losses})</td>
              <td className={cx("num py-0.5 text-right font-medium", tone(side.realized))}>{side.realized}</td>
              <td className={cx("num py-0.5 text-right", side.open ? tone(side.unrealized) : "text-muted")}>{side.open ? `${side.open} · ${side.unrealized}` : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
