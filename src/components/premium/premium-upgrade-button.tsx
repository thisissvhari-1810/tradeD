"use client";

import { usePathname, useRouter } from "next/navigation";
import { useRef } from "react";
import { Crown } from "lucide-react";
import { cx } from "@/components/ui";
import { usePremium } from "@/components/premium/use-premium";

/** Where the Premium page was opened from, so the crown (or Close) can return there. */
const ORIGIN_KEY = "td-premium-from";

/** Remembers the in-app page Premium is opened from (path and query, e.g. /chart?symbol=TCS). */
export function rememberPremiumOrigin() {
  try {
    const here = `${window.location.pathname}${window.location.search}`;
    if (!here.startsWith("/premium")) sessionStorage.setItem(ORIGIN_KEY, here);
  } catch {
    /* storage unavailable: closing falls back to Home */
  }
}

/** The page to return to when Premium closes: the remembered in-app page, else Home. Never an external URL. */
export function premiumOrigin(): string {
  try {
    const saved = sessionStorage.getItem(ORIGIN_KEY) ?? "";
    return saved.startsWith("/") && !saved.startsWith("//") && !saved.startsWith("/premium") ? saved : "/";
  } catch {
    return "/";
  }
}

/**
 * The crown in the header toggles the Premium page: it opens Premium from any page, and on the
 * Premium page it returns to where Premium was opened from. Its gold highlight means "the Premium
 * page is open", not "this account has Premium" (the label says that).
 */
export function PremiumUpgradeButton({ className }: { className?: string }) {
  const { premium, known } = usePremium();
  const path = usePathname();
  const router = useRouter();
  const busy = useRef(false);
  if (!known) return null;
  const open = path.startsWith("/premium");
  const active = premium.status === "active";
  const label = open ? "Close Premium" : active ? "Premium" : premium.status === "expired" ? "Renew Premium" : "Upgrade to Premium";

  function toggle() {
    if (busy.current) return;
    busy.current = true;
    window.setTimeout(() => { busy.current = false; }, 400);
    if (open) {
      router.push(premiumOrigin());
    } else {
      rememberPremiumOrigin();
      router.push("/premium");
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={open}
      aria-label={label}
      title={open ? "Close Premium and go back" : active ? "TradeD Premium is active on this account" : "Upgrade to TradeD Premium"}
      className={cx(
        "group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill border px-2 text-micro font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 xl:px-3",
        open ? "border-gold bg-gold text-on-gold shadow-e2" : "border-gold/45 bg-gold-soft text-gold hover:border-gold",
        className,
      )}
      // Inline colour: the global button reset (color: inherit) would otherwise win over the text-* class.
      style={{ color: open ? "var(--on-gold)" : "var(--gold)" }}
    >
      <Crown className="h-3.5 w-3.5 transition-transform duration-300 group-hover:-rotate-12 group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:transform-none" strokeWidth={2.2} aria-hidden />
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}
