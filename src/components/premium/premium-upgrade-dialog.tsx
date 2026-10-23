"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Crown, X } from "lucide-react";
import { PREMIUM_CAPABILITIES, type PremiumCapability } from "@/lib/premium/entitlements";
import { rememberPremiumOrigin } from "@/components/premium/premium-upgrade-button";

/** Shown when a free account opens a Premium feature: what it is, and the way to Premium. */
export function PremiumUpgradeDialog({ capability, onClose }: { capability: PremiumCapability; onClose: () => void }) {
  const feature = PREMIUM_CAPABILITIES[capability];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[85] flex items-end justify-center sm:items-center sm:p-4">
      <button type="button" tabIndex={-1} className="anim-fade absolute inset-0 bg-[var(--scrim)]" aria-label="Close" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="td-premium-dialog-title" className="anim-sheet relative w-full max-w-md rounded-t-sheet border border-premium-border bg-premium p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-premium-text shadow-e4 sm:rounded-sheet">
        <button type="button" className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-input text-premium-muted hover:text-premium-text" aria-label="Not now" onClick={onClose}><X className="h-4 w-4" aria-hidden /></button>
        <span className="grid h-11 w-11 place-items-center rounded-card border border-premium-border bg-premium-raised text-gold-strong"><Crown className="h-5 w-5" aria-hidden /></span>
        <h2 id="td-premium-dialog-title" className="mt-3 text-section font-semibold">{feature.label} is a Premium feature</h2>
        <p className="mt-1.5 text-dense text-premium-muted">{feature.detail} It comes with TradeD Premium, from ₹83.25 a month on the yearly plan.</p>
        <div className="mt-5 flex gap-2">
          <button type="button" className="h-11 flex-1 rounded-input border border-premium-border text-dense font-medium text-premium-text hover:bg-premium-raised" onClick={onClose}>Not now</button>
          <Link href={`/premium?feature=${capability}`} className="grid h-11 flex-1 place-items-center rounded-input bg-gold-strong text-dense font-semibold text-on-gold hover:brightness-105" onClick={() => { rememberPremiumOrigin(); onClose(); }}>Explore Premium</Link>
        </div>
      </div>
    </div>
  );
}
