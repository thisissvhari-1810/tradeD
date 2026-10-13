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
    <main className="grid min-h-dvh place-items-center bg-background p-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-primary text-sm font-semibold text-white">T</span>
          <div>
            <h1 className="text-lg font-semibold">TradeD</h1>
            <p className="text-xs text-muted">Sign in with your TradeM account. Practice orders stay virtual.</p>
          </div>
        </div>
        {challenge ? (
          <label className="mt-5 block text-xs">Authentication code
            <input className="mt-1 w-full" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} autoFocus />
          </label>
        ) : (
          <>
            <label className="mt-5 block text-xs">Email
              <input className="mt-1 w-full" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
            </label>
            <label className="mt-3 block text-xs">Password
              <input className="mt-1 w-full" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            </label>
          </>
        )}
        {error ? <p className="mt-3 text-xs text-loss">{error}</p> : null}
        <button className="mt-4 w-full rounded-full bg-primary py-2.5 text-sm font-medium text-white" disabled={busy}>{busy ? "Signing in…" : challenge ? "Verify" : "Sign in"}</button>
      </form>
    </main>
  );
}
