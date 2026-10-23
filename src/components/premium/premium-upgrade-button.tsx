"use client";

import Link from "next/link";
import { Crown } from "lucide-react";
import { cx } from "@/components/ui";
import { usePremium } from "@/components/premium/use-premium";

/**
 * Premium in the header: "Upgrade to Premium" (or "Renew") for free and expired accounts, "Premium"
 * for accounts that have it (the page then shows their status). Full label on wide screens, a crown
 * on tablets.
 */
export function PremiumUpgradeButton({ className }: { className?: string }) {
  const { premium, known } = usePremium();
  if (!known) return null;
  const active = premium.status === "active";
  return (
    <Link
      href="/premium"
      title={active ? "TradeD Premium is active" : "Upgrade to TradeD Premium"}
      aria-label={active ? "Premium" : "Upgrade to Premium"}
      className={cx(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill border border-gold/45 bg-gold-soft px-2 text-micro font-semibold text-gold transition-colors hover:border-gold hover:bg-gold hover:text-on-gold focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] active:brightness-95 xl:px-3",
        className,
      )}
    >
      <Crown className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
      <span className="hidden xl:inline">{active ? "Premium" : premium.status === "expired" ? "Renew Premium" : "Upgrade to Premium"}</span>
    </Link>
  );
}
