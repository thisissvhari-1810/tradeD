"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/components/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ ok?: boolean; mfaRequired?: boolean; challengeToken?: string }>(
        "/api/auth/login",
        challenge ? { challengeToken: challenge, code } : { email, password },
      );
      if (result.mfaRequired && result.challengeToken) {
        setChallenge(result.challengeToken);
        return;
      }
      router.replace("/terminal");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-background p-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,var(--hero-glow),transparent_70%)]" aria-hidden />
      <form onSubmit={submit} className="surface-modal anim-rise relative w-full max-w-sm rounded-xl p-7">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-[12px] bg-primary text-title font-bold text-on-primary shadow-e2">T</span>
          <div>
            <h1 className="text-section font-semibold">TradeD</h1>
            <p className="text-data text-muted">Indian markets practice terminal</p>
          </div>
        </div>
        <p className="mt-5 text-dense text-text-2">{challenge ? "Enter the code from your authenticator app." : "Sign in with your TradeD account. Practice orders stay virtual."}</p>
        {challenge ? (
          <label className="mt-4 flex flex-col gap-1.5 text-data font-medium text-text-2">Authentication code
            <input className="num h-10 text-body tracking-[0.3em] text-text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} autoFocus />
          </label>
        ) : (
          <>
            <label className="mt-4 flex flex-col gap-1.5 text-data font-medium text-text-2">Email
              <input className="h-10 text-body text-text" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
            </label>
            <label className="mt-3 flex flex-col gap-1.5 text-data font-medium text-text-2">Password
              <input className="h-10 text-body text-text" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            </label>
          </>
        )}
        {error ? <p className="mt-3 rounded-input border border-loss/30 bg-loss-soft px-3 py-2 text-data text-loss" role="alert">{error}</p> : null}
        <button className="mt-5 h-10 w-full rounded-md bg-primary text-body font-semibold text-on-primary shadow-e1 transition-colors hover:bg-primary-hover disabled:opacity-60" disabled={busy}>{busy ? "Signing in…" : challenge ? "Verify" : "Sign in"}</button>
      </form>
    </main>
  );
}
