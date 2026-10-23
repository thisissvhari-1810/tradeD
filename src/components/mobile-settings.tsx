"use client";

import { useEffect, useState, type ReactNode } from "react";
import { RotateCcw, X } from "lucide-react";
import { ChartIcon } from "@/components/chart-icons";
import { toolEntry } from "@/components/drawing-tools";
import { MOBILE_DEFAULTS, QUICK_TOOL_CHOICES, resetMobilePrefs, updateMobilePrefs, useMobilePrefs } from "@/components/mobile-prefs";
import { cx } from "@/components/ui";

/** Settings → Mobile & compact mode. Changes apply at once and are kept in this browser. */
export function MobileSettingsPanel({ onClose }: { onClose: () => void }) {
  const prefs = useMobilePrefs();
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggleTool(key: string) {
    const on = prefs.quickTools.includes(key);
    if (!on && prefs.quickTools.length >= 8) return;
    updateMobilePrefs({ quickTools: on ? prefs.quickTools.filter((item) => item !== key) : [...prefs.quickTools, key] });
  }

  return (
    <div className="fixed inset-0 z-[80]">
      <button type="button" tabIndex={-1} className="anim-fade absolute inset-0 bg-[var(--scrim)]" aria-label="Close mobile settings" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Mobile and compact mode" className="surface-modal anim-sheet absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-sheet pb-[env(safe-area-inset-bottom)] sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-[calc(var(--topbar)+0.5rem)] sm:max-h-[calc(100dvh-var(--topbar)-1rem)] sm:w-[24rem] sm:rounded-card sm:pb-0">
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong sm:hidden" aria-hidden />
        <header className="flex items-center gap-2 border-b border-border-soft px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-title font-semibold">Mobile &amp; compact mode</h2>
            <p className="text-micro text-muted">Applies on phones and tablets. Saved in this browser.</p>
          </div>
          <button type="button" className="grid h-10 w-10 place-items-center rounded-input text-muted hover:bg-hover" aria-label="Close" onClick={onClose}><X className="h-5 w-5" aria-hidden /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-3">
          <Group title="Layout">
            <Row label="Density" hint="Compact gives the chart more room: a slimmer header and bottom bar.">
              <Segment value={prefs.density} options={[["compact", "Compact"], ["comfortable", "Comfortable"]]} onChange={(density) => updateMobilePrefs({ density })} />
            </Row>
            <Toggle label="Labels in the bottom bar" checked={prefs.navLabels} onChange={(navLabels) => updateMobilePrefs({ navLabels })} />
            <Toggle label="Market cards on Home" hint="Market pulse, movers and shortcuts. Your account and watchlist always show." checked={prefs.homeMarketCards} onChange={(homeMarketCards) => updateMobilePrefs({ homeMarketCards })} />
          </Group>
          <Group title="Chart">
            <Toggle label="Price readout box" hint="The date, open, high, low, close and volume box at the top of the chart." checked={prefs.chartLegend} onChange={(chartLegend) => updateMobilePrefs({ chartLegend })} />
            <Toggle label="Buy and Sell buttons on the chart" hint="They open the paper order ticket. Nothing is sent to a broker." checked={prefs.chartTradeButtons} onChange={(chartTradeButtons) => updateMobilePrefs({ chartTradeButtons })} />
          </Group>
          <Group title="Quick drawing toolbar">
            <p className="text-micro text-muted">Choose up to 8 tools shown after tapping Draw. Every tool stays under More.</p>
            <div className="grid grid-cols-4 gap-1.5">
              {QUICK_TOOL_CHOICES.map((key) => {
                const item = toolEntry(key);
                if (!item) return null;
                const on = prefs.quickTools.includes(key);
                return (
                  <button key={key} type="button" aria-pressed={on} className={cx("flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border px-1 py-1.5 text-center text-[0.625rem] font-medium leading-tight", on ? "border-primary/40 bg-primary-soft text-primary" : "border-border-soft text-text-2 hover:bg-hover")} onClick={() => toggleTool(key)}>
                    <ChartIcon name={item.icon} />
                    {item.label}
                  </button>
                );
              })}
            </div>
            <Toggle label="Names under the tool icons" checked={prefs.toolLabels} onChange={(toolLabels) => updateMobilePrefs({ toolLabels })} />
          </Group>
        </div>
        <footer className="flex items-center gap-2 border-t border-border-soft px-4 py-2.5">
          {confirmReset ? (
            <>
              <span className="flex-1 text-data text-text-2">Reset every mobile setting?</span>
              <button type="button" className="h-10 rounded-input px-3 text-data font-medium text-text-2 hover:bg-hover" onClick={() => setConfirmReset(false)}>Cancel</button>
              <button type="button" className="h-10 rounded-input bg-loss px-3 text-data font-semibold text-on-signal" onClick={() => { resetMobilePrefs(); setConfirmReset(false); }}>Reset</button>
            </>
          ) : (
            <button type="button" className="inline-flex h-10 items-center gap-1.5 rounded-input px-3 text-data font-medium text-text-2 hover:bg-hover disabled:opacity-40" disabled={JSON.stringify(prefs) === JSON.stringify(MOBILE_DEFAULTS)} onClick={() => setConfirmReset(true)}>
              <RotateCcw className="h-4 w-4" aria-hidden />Reset mobile settings
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-dense font-medium text-text">{label}</p>
      {children}
      {hint ? <p className="text-micro text-muted">{hint}</p> : null}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3">
      <span className="min-w-0 flex-1 pt-1">
        <span className="block text-dense text-text">{label}</span>
        {hint ? <span className="block text-micro text-muted">{hint}</span> : null}
      </span>
      <input type="checkbox" role="switch" className="mt-1.5 h-5 w-5 shrink-0" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function Segment<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return (
    <div className="flex gap-1 rounded-input bg-sunken p-1" role="radiogroup">
      {options.map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={cx("h-9 flex-1 rounded-sm text-data font-medium", value === id ? "bg-panel text-text shadow-e1" : "text-muted")} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}
