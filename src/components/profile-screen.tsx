"use client";

import Link from "next/link";
import { Check, Crown, Minus } from "lucide-react";
import { initials, premiumLabel } from "@/components/account-panel";
import { rememberPremiumOrigin } from "@/components/premium/premium-upgrade-button";
import { useDesk } from "@/components/shell";
import { cx } from "@/components/ui";
import { FEATURES } from "@/lib/auth/features";
import { planById } from "@/lib/premium/plans";

const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: "Super Admin", STUDENT: "Standard user", INSTRUCTOR: "Instructor" };
const istDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" });

/**
 * The signed-in user's own profile, read-only: everything shown comes from the session (/api/session).
 * Name, email, role and permissions are managed by the Super Admin, so nothing here can change them.
 */
export function ProfileScreen() {
  const desk = useDesk();
  const user = desk.user;
  if (!user) return <div className="grid h-full place-items-center text-data text-muted">Loading your profile…</div>;
  const premium = user.premium;
  const plan = premium?.plan ? planById(premium.plan)?.label : null;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-3 sm:p-6">
        <section className="surface flex flex-col items-center gap-3 p-6 text-center sm:flex-row sm:text-left">
          <span className="grid h-20 w-20 shrink-0 place-items-center rounded-full bg-primary-soft text-[1.75rem] font-semibold text-primary ring-1 ring-primary/25" aria-hidden>{initials(user.name)}</span>
          <div className="min-w-0">
            <h1 className="truncate text-section font-semibold">{user.name || "Your profile"}</h1>
            <p className="truncate text-dense text-muted">{user.email}</p>
            <p className="mt-2 flex flex-wrap justify-center gap-1.5 sm:justify-start">
              <span className="rounded-pill bg-sunken px-2.5 py-0.5 text-data font-medium text-text-2">{ROLE_LABEL[user.role] ?? user.role}</span>
              <span className={cx("rounded-pill px-2.5 py-0.5 text-data font-medium", user.status === "ACTIVE" ? "bg-profit-soft text-profit" : "bg-warning-soft text-warning")}>{user.status === "ACTIVE" ? "Active" : user.status.toLowerCase()}</span>
            </p>
          </div>
        </section>

        <section className="surface p-4 sm:p-5" aria-labelledby="td-profile-account">
          <h2 id="td-profile-account" className="text-title font-semibold">Account</h2>
          <dl className="mt-3 grid gap-x-6 gap-y-3 text-dense sm:grid-cols-2">
            <Field label="Name" value={user.name || "—"} />
            <Field label="Email" value={user.email || "—"} />
            <Field label="Role" value={ROLE_LABEL[user.role] ?? user.role} />
            <Field label="Member since" value={user.memberSince ? istDate(user.memberSince) : "—"} />
          </dl>
          <p className="mt-4 text-data text-muted">Your name, email, role and access are managed by your TradeD administrator. Ask them to change anything here.</p>
        </section>

        <section className="surface p-4 sm:p-5" aria-labelledby="td-profile-premium">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="td-profile-premium" className="flex-1 text-title font-semibold">Subscription</h2>
            <Link href="/premium" onClick={rememberPremiumOrigin} className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-gold/45 bg-gold-soft px-3 text-data font-semibold text-gold hover:border-gold">
              <Crown className="h-4 w-4" aria-hidden />{premium?.status === "active" ? "View Premium" : "Go Premium"}
            </Link>
          </div>
          <dl className="mt-3 grid gap-x-6 gap-y-3 text-dense sm:grid-cols-2">
            <Field label="Plan" value={premiumLabel(premium)} />
            <Field label={premium?.status === "expired" ? "Ended on" : "Valid until"} value={premium?.via === "role" ? "Always (Super Admin)" : premium?.endsAt ? `${istDate(premium.endsAt)}${plan ? ` · ${plan}` : ""}` : "—"} />
          </dl>
        </section>

        <section className="surface p-4 sm:p-5" aria-labelledby="td-profile-access">
          <h2 id="td-profile-access" className="text-title font-semibold">Access</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {FEATURES.map((feature) => {
              const on = user.features ? user.features[feature.key] : false;
              return (
                <li key={feature.key} className="flex items-start gap-2 text-data">
                  {on ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-profit" aria-label="On" /> : <Minus className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-label="Off" />}
                  <span><span className={cx("block font-medium", on ? "text-text" : "text-muted")}>{feature.label}</span><span className="block text-micro text-muted">{feature.detail}</span></span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro text-muted">{label}</dt>
      <dd className="truncate font-medium text-text">{value}</dd>
    </div>
  );
}
