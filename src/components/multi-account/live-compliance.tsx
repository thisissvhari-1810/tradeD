"use client";

import { CircleCheck, CircleX, ShieldAlert } from "lucide-react";
import { Button, cx } from "@/components/ui";
import type { LiveGate } from "@/lib/multi-account/compliance";

export function LiveLockedBanner({ onBack }: { onBack?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-loss/40 bg-loss-soft px-4 py-3" role="status">
      <ShieldAlert className="h-5 w-5 shrink-0 text-loss" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-dense font-bold uppercase tracking-[0.04em] text-loss">Live trading locked</p>
        <p className="text-data text-text-2">No live order can be placed from this page until every requirement below is met.</p>
      </div>
      {onBack ? <Button size="sm" variant="secondary" onClick={onBack}>Back to demo</Button> : null}
    </div>
  );
}

export function ComplianceChecklist({ gate }: { gate: LiveGate }) {
  const met = gate.requirements.filter((item) => item.met).length;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-dense font-semibold text-text">Requirements</h3>
        <span className="num text-data text-muted">{met} of {gate.requirements.length} met</span>
      </div>
      <p className="text-data text-text-2">{gate.message}</p>
      <ol className="flex flex-col gap-2">
        {gate.requirements.map((item, index) => (
          <li key={item.id} className={cx("flex gap-3 rounded-input border p-3", item.met ? "border-profit/25 bg-profit-soft/40" : "border-border-soft bg-sunken")}>
            <span className="num grid h-6 w-6 shrink-0 place-items-center rounded-pill border border-border-soft bg-panel text-micro font-semibold text-text-2" aria-hidden>{index + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-dense font-semibold text-text">
                {item.label}
                {item.met
                  ? <span className="inline-flex items-center gap-1 text-micro font-semibold text-profit"><CircleCheck className="h-3.5 w-3.5" aria-hidden />Met</span>
                  : <span className="inline-flex items-center gap-1 text-micro font-semibold text-loss"><CircleX className="h-3.5 w-3.5" aria-hidden />Not met</span>}
              </p>
              <p className="mt-0.5 text-data text-text-2">{item.detail}</p>
              <p className="mt-1 text-micro text-muted">Source: {item.source}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="text-micro text-muted">Rules last reviewed {gate.checkedOn}. Each holder can trade in their own broker app directly; TradeD never asks for anyone&apos;s password, OTP or access token.</p>
    </div>
  );
}
