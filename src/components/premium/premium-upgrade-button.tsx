"use client";

import Link from "next/link";
import { Crown } from "lucide-react";
import { cx } from "@/components/ui";
import { usePremium } from "@/components/premium/use-premium";

/**
 * "Upgrade to Premium" in the header: full label on wide screens, a crown on tablets and phones.
 * Hidden for accounts that already have Premium.
 */
export function PremiumUpgradeButton({ className }: { className?: string }) {
  const { premium, known } = usePremium();
  if (!known || premium.status === "active") return null;
  return (
    <Link
      href="/premium"
      title="Upgrade to TradeD Premium"
      aria-label="Upgrade to Premium"
      className={cx(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill border border-gold/45 bg-gold-soft px-2 text-micro font-semibold text-gold transition-colors hover:border-gold hover:bg-gold hover:text-on-gold focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] active:brightness-95 xl:px-3",
        className,
      )}
    >
      <Crown className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
      <span className="hidden xl:inline">{premium.status === "expired" ? "Renew Premium" : "Upgrade to Premium"}</span>
    </Link>
  );
}
