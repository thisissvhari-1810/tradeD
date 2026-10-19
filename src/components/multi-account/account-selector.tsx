"use client";

import { Check } from "lucide-react";
import { Button, cx } from "@/components/ui";

export type SelectableAccount = { id: string; slot: number; nickname: string; disabled?: boolean; note?: string };

/** Reusable multi-account picker: individual toggles plus Select all / Clear. */
export function AccountSelector({ accounts, selected, onChange, label = "Accounts", disabled = false }: {
  accounts: SelectableAccount[];
  selected: string[];
  onChange: (next: string[]) => void;
  label?: string;
  disabled?: boolean;
}) {
  const pickable = accounts.filter((account) => !account.disabled);
  const chosen = new Set(selected);
  const toggle = (id: string) => onChange(chosen.has(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <div className="mb-1.5 flex items-center gap-2">
        <legend className="flex-1 text-data font-medium text-muted">{label} <span className="num text-text-2">{selected.length}/{accounts.length}</span></legend>
        <Button size="sm" variant="ghost" onClick={() => onChange(pickable.map((account) => account.id))} disabled={disabled || pickable.length === 0}>Select all</Button>
        <Button size="sm" variant="ghost" onClick={() => onChange([])} disabled={disabled || selected.length === 0}>Clear</Button>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {accounts.map((account) => {
          const on = chosen.has(account.id);
          return (
            <button
              key={account.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={disabled || account.disabled}
              title={account.note}
              onClick={() => toggle(account.id)}
              className={cx(
                "flex min-w-0 items-center gap-1.5 rounded-input border px-2 py-1.5 text-left text-data transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                on ? "border-primary/50 bg-primary-soft text-text" : "border-border-soft bg-sunken text-text-2 hover:bg-hover",
              )}
            >
              <span className={cx("grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border", on ? "border-primary bg-primary text-on-signal" : "border-border")} aria-hidden>
                {on ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
              </span>
              <span className="num shrink-0 text-muted">{account.slot}</span>
              <span className="truncate">{account.nickname}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
