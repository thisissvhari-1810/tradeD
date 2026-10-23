"use client";

import { FormEvent, Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/components/api";

function SetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== confirm) return setError("The two passwords do not match.");
    setBusy(true);
    try {
      const result = await api<{ email: string }>("/api/auth/set-password", { token, password });
      setDone(result.email);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The password could not be set.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-background p-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,var(--hero-glow),transparent_70%)]" aria-hidden />
      <form onSubmit={submit} className="surface-modal anim-rise relative w-full max-w-sm rounded-xl p-7">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-[0.75rem] bg-primary text-title font-bold text-on-primary shadow-e2">T</span>
          <div>
            <h1 className="text-section font-semibold">Set your password</h1>
            <p className="text-data text-muted">TradeD account setup</p>
          </div>
        </div>
        {done ? (
          <>
            <p className="mt-5 rounded-input border border-profit/30 bg-profit-soft px-3 py-2 text-dense text-profit" role="status">Password set for {done}.</p>
            <Link href="/login" className="mt-5 grid h-10 w-full place-items-center rounded-md bg-primary text-body font-semibold text-on-primary shadow-e1 hover:bg-primary-hover">Sign in</Link>
          </>
        ) : !token ? (
          <p className="mt-5 text-dense text-loss">This link is incomplete. Ask your administrator for a new one.</p>
        ) : (
          <>
            <p className="mt-5 text-dense text-text-2">Choose a password of at least 10 characters with a letter and a number. The link works once.</p>
            <label className="mt-4 flex flex-col gap-1.5 text-data font-medium text-text-2">New password
              <input className="h-10 text-body text-text" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={10} required autoFocus />
            </label>
            <label className="mt-3 flex flex-col gap-1.5 text-data font-medium text-text-2">Confirm password
              <input className="h-10 text-body text-text" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" minLength={10} required />
            </label>
            {error ? <p className="mt-3 rounded-input border border-loss/30 bg-loss-soft px-3 py-2 text-data text-loss" role="alert">{error}</p> : null}
            <button className="mt-5 h-10 w-full rounded-md bg-primary text-body font-semibold text-on-primary shadow-e1 transition-colors hover:bg-primary-hover disabled:opacity-60" disabled={busy}>{busy ? "Saving…" : "Set password"}</button>
          </>
        )}
      </form>
    </main>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <SetPasswordForm />
    </Suspense>
  );
}
