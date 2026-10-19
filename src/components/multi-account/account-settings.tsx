"use client";

import { useState, type ReactNode } from "react";
import { simId } from "@/components/multi-account/accounts";
import { FIELD, inr, LABEL, toPaise } from "@/components/multi-account/format";
import { Button, cx, Drawer } from "@/components/ui";
import type { DemoAccount, Side } from "@/lib/multi-account/engine";

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-b border-border-soft pb-4 last:border-b-0 last:pb-0">
      <div>
        <h3 className="text-data font-semibold uppercase tracking-[0.05em] text-text-2">{title}</h3>
        {hint ? <p className="mt-0.5 text-micro text-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function AccountSettings({ account, busy, onClose, onSave, onReset }: { account: DemoAccount; busy: string | null; onClose: () => void; onSave: (patch: Partial<DemoAccount>) => void; onReset: (startingPaise: number) => void }) {
  const [nickname, setNickname] = useState(account.nickname);
  const [enabled, setEnabled] = useState(account.tradingEnabled);
  const [maxLots, setMaxLots] = useState(String(account.risk.maxLots));
  const [maxCapital, setMaxCapital] = useState(String(account.risk.maxCapitalPaise / 100));
  const [maxLoss, setMaxLoss] = useState(String(account.risk.maxDailyLossPaise / 100));
  const [maxOpen, setMaxOpen] = useState(String(account.risk.maxOpenPositions));
  const [underlyings, setUnderlyings] = useState(account.risk.underlyings.join(", "));
  const [sides, setSides] = useState<Side[]>(account.risk.sides);
  const [capital, setCapital] = useState(String(account.startingPaise / 100));
  const [confirmReset, setConfirmReset] = useState(false);
  const capPaise = toPaise(maxCapital);
  const lossPaise = toPaise(maxLoss);
  const startPaise = toPaise(capital);
  const lots = Number(maxLots);
  const open = Number(maxOpen);
  const errors = {
    lots: !Number.isInteger(lots) || lots < 1 ? "Whole number, at least 1." : "",
    open: !Number.isInteger(open) || open < 1 ? "Whole number, at least 1." : "",
    capital: !capPaise ? "Rupee amount above zero." : "",
    loss: !lossPaise ? "Rupee amount above zero." : "",
    sides: sides.length === 0 ? "Allow at least one side." : "",
  };
  const invalid = Object.values(errors).some(Boolean);
  const toggleSide = (side: Side) => setSides(sides.includes(side) ? sides.filter((item) => item !== side) : [...sides, side]);
  const err = (text: string) => (text ? <span className="text-micro font-normal text-loss">{text}</span> : null);

  return (
    <Drawer open onClose={onClose} modal width="w-[440px]" label={`Settings for ${account.nickname}`} title={account.nickname} subtitle={`${simId(account)} · demo account`} footer={
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button className="flex-1" variant="primary" disabled={invalid} onClick={() => onSave({ nickname, tradingEnabled: enabled, lots: Math.min(account.lots, lots), risk: { maxLots: lots, maxCapitalPaise: capPaise ?? 0, maxDailyLossPaise: lossPaise ?? 0, maxOpenPositions: open, underlyings: underlyings.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean), sides } })}>Save settings</Button>
      </div>
    }>
      <div className="flex flex-col gap-4">
        <Group title="Account">
          <label className={LABEL}>Nickname<input className={FIELD} maxLength={40} value={nickname} onChange={(event) => setNickname(event.target.value)} /></label>
          <label className={cx("flex items-start gap-2.5 rounded-input border p-2.5 text-dense", enabled ? "border-profit/30 bg-profit-soft/40" : "border-border-soft bg-sunken")}>
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--primary)]" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <span><span className="block font-semibold text-text">Trading enabled</span><span className="text-micro text-muted">When off, this account is skipped for new orders. Closing positions still works.</span></span>
          </label>
        </Group>

        <Group title="Risk limits" hint="Checked on the server right before each leg fills. Never pooled across accounts.">
          <div className="grid grid-cols-2 gap-2.5">
            <label className={LABEL}><span className="flex justify-between gap-1">Max lots / order{err(errors.lots)}</span><input className={cx(FIELD, errors.lots && "border-loss")} inputMode="numeric" value={maxLots} onChange={(event) => setMaxLots(event.target.value)} /></label>
            <label className={LABEL}><span className="flex justify-between gap-1">Max open positions{err(errors.open)}</span><input className={cx(FIELD, errors.open && "border-loss")} inputMode="numeric" value={maxOpen} onChange={(event) => setMaxOpen(event.target.value)} /></label>
            <label className={LABEL}><span className="flex justify-between gap-1">Max capital (₹){err(errors.capital)}</span><input className={cx(FIELD, errors.capital && "border-loss")} inputMode="decimal" value={maxCapital} onChange={(event) => setMaxCapital(event.target.value)} /></label>
            <label className={LABEL}><span className="flex justify-between gap-1">Max daily loss (₹){err(errors.loss)}</span><input className={cx(FIELD, errors.loss && "border-loss")} inputMode="decimal" value={maxLoss} onChange={(event) => setMaxLoss(event.target.value)} /></label>
          </div>
        </Group>

        <Group title="Allowed instruments" hint="Leave underlyings blank to allow all.">
          <label className={LABEL}>Underlyings (comma separated)<input className={FIELD} value={underlyings} onChange={(event) => setUnderlyings(event.target.value)} placeholder="NIFTY, BANKNIFTY" /></label>
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="mb-1.5 flex w-full justify-between text-data font-medium text-muted">Allowed sides{err(errors.sides)}</legend>
            {(["BUY", "SELL"] as const).map((side) => (
              <label key={side} className={cx("flex h-8 cursor-pointer items-center gap-1.5 rounded-input border px-3 text-dense", sides.includes(side) ? "border-primary/40 bg-primary-soft text-text" : "border-border-soft text-text-2")}>
                <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={sides.includes(side)} onChange={() => toggleSide(side)} />{side === "BUY" ? "Buy" : "Sell"}
              </label>
            ))}
          </fieldset>
        </Group>

        <Group title="Virtual capital" hint={`Current starting balance ${inr(account.startingPaise)}. Resetting sets cash to the new amount and clears realised P&L. It needs no open positions or pending orders.`}>
          <label className={LABEL}>New starting balance (₹)<input className={FIELD} inputMode="decimal" value={capital} onChange={(event) => { setCapital(event.target.value); setConfirmReset(false); }} /></label>
          <Button variant="danger" disabled={!startPaise || startPaise < 1_000_00} loading={busy === "reset"} onClick={() => (confirmReset && startPaise ? onReset(startPaise) : setConfirmReset(true))}>{confirmReset ? `Confirm reset to ${inr(startPaise)}` : "Reset demo account"}</Button>
        </Group>
      </div>
    </Drawer>
  );
}
